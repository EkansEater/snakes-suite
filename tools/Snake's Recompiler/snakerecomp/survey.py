"""Trying a whole folder of games at once, to see how far each one gets.

For each ROM this builds the game and lets it run by itself for a while
with no window, pressing Start now and then, and notes what happened: did
it draw anything, did it stop, and why. It is how we find out which games
work and what the others are missing.

Nothing here touches your real saves: each game gets a blank scratch save
inside the survey's own folder.
"""

import argparse
import glob
import os
import re
import subprocess
import traceback
from concurrent.futures import ThreadPoolExecutor

from .profiles import game_options
from .rom import Rom

ROM_ENDINGS = (".z64", ".n64", ".v64", ".zip")
# Start, then A, over and over: enough to get past most title screens.
PRESSES = ",".join(f"{frame}:{'0x1000' if i % 3 == 0 else '0x8000'}:6" for i, frame in enumerate(range(300, 4000, 90)))


def survey_one(path: str, out_root: str, frames: int, prepare) -> dict:
    result = {"file": os.path.basename(path), "code": "?", "frames": 0, "pictures": 0, "triangles": 0, "note": ""}
    try:
        rom = Rom.from_file(path)
        result["code"] = rom.header.game_code
        out_dir = os.path.join(out_root, rom.header.game_code + f"-{rom.header.version}")
        os.makedirs(out_dir, exist_ok=True)
        # (symbols="": no list of names, so every game is recognised the
        # same way, from fingerprints alone)
        args = argparse.Namespace(rom=path, symbols="", output=out_dir)
        game, plain_rom = prepare(rom, args, out_dir, quiet=True)
    except subprocess.CalledProcessError:
        result["note"] = "did not compile"
        return result
    except Exception as problem:  # anything at all: one bad ROM must not stop the survey
        where = traceback.extract_tb(problem.__traceback__)[-1]
        result["note"] = f"analysis failed: {type(problem).__name__}: {problem} ({where.name})"
        return result

    save = os.path.join(out_dir, "scratch.sav")
    with open(save, "wb") as blank:
        blank.write(b"\xff" * 2048)
    shots = os.path.join(out_dir, "shots")
    os.makedirs(shots, exist_ok=True)
    for old in glob.glob(os.path.join(shots, "*.ppm")):
        os.remove(old)
    command = [game, plain_rom, *game_options(rom.header.game_code), "--headless", "--frames", str(frames), "--save", save,
               "--screenshots", shots, "--every", str(max(frames // 8, 1)), "--keys", PRESSES]  # fmt: skip
    try:
        done = subprocess.run(command, capture_output=True, text=True, errors="replace", timeout=90 + frames / 10)
        output = done.stdout + done.stderr
        if done.returncode < 0:
            result["note"] = f"crashed (signal {-done.returncode})"
    except subprocess.TimeoutExpired as late:
        output = (late.stdout or b"").decode(errors="replace") + (late.stderr or b"").decode(errors="replace")
        result["note"] = "hung"
    with open(os.path.join(out_dir, "survey-output.txt"), "w") as log:
        log.write(output)

    for key, pattern in (("frames", r"ran (\d+) frames"), ("pictures", r"pictures drawn:\s+(\d+)"),
                         ("triangles", r"pictures drawn:\s+\d+ \((\d+) triangles")):  # fmt: skip
        found = re.search(pattern, output)
        if found:
            result[key] = int(found[1])
    stopped = re.search(r"game stopped: (.*)|host: (.*)", output)
    if stopped:
        result["note"] = (stopped[1] or stopped[2]).strip()
    return result


def survey(paths: list[str], out_root: str, frames: int, jobs: int, prepare) -> list[dict]:
    files = []
    for path in paths:
        if os.path.isdir(path):
            files += sorted(f for f in glob.glob(os.path.join(path, "*")) if f.lower().endswith(ROM_ENDINGS))
        else:
            files.append(path)
    # A game present both zipped and unzipped only needs trying once.
    stems = {os.path.splitext(f)[0] for f in files if not f.lower().endswith(".zip")}
    files = [f for f in files if not (f.lower().endswith(".zip") and os.path.splitext(f)[0] in stems)]

    results = []
    with ThreadPoolExecutor(jobs) as pool:
        for result in pool.map(lambda f: survey_one(f, out_root, frames, prepare), files):
            results.append(result)
            print(describe(result), flush=True)
    return results


def describe(result: dict) -> str:
    if result["note"].startswith(("analysis failed", "did not compile")):
        state = "NOT BUILT"
    elif result["triangles"] > 0 and not result["note"]:
        state = "runs, 3D"
    elif result["pictures"] > 0 and not result["note"]:
        state = "runs, 2D only"
    elif result["pictures"] > 0:
        state = "draws, then stops"
    else:
        state = "no picture"
    return (f"{result['file'][:34]:<34} {result['code']}  {state:<18} "
            f"{result['frames']:5} frames {result['triangles']:8} triangles  {result['note'][:70]}")  # fmt: skip
