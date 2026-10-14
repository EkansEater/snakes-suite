"""Checking every game by machine, and keeping the list of where each stands.

Playing 32 games by hand after every change is hours of work. The "check"
command does what a machine can do of it: it builds each game, lets it run
by itself for a minute with no window, pressing buttons from a script, and
then judges the run four ways:

  runs     did it get to the end, or stop, freeze or crash (and where)
  picture  was the screen ever blank or stuck (from the run's log), and
           pictures of the run laid side by side on one sheet per game
  sound    does the amount of sound made agree with what the game asked
           for, were any sound commands not understood, and is the
           recording silent, distorted or mostly noise
  pace     how many pictures a second the game made

The results are kept in checks/results.json. Every check compares itself
with the one before and says which games got better or worse, which is how
a fix to shared code is caught breaking another game.

What a machine cannot judge (is the text readable? is the tune right?) is
written down by whoever looked or listened, in checks/notes.txt.

From the two, STATUS.md is written afresh every time: one row per game.
That file is never edited by hand.

Nothing here touches your real saves: each run starts from nothing, in the
check's own folder under build/.
"""

import argparse
import glob
import json
import os
import re
import subprocess
import time
import traceback
import wave
from concurrent.futures import ThreadPoolExecutor

from . import diagnose
from .profiles import TRIED, game_options
from .rom import Rom
from .survey import PRESSES, ROM_ENDINGS

FOLDER = "checks"  # what is kept (and shared): results, notes, button scripts
if not os.path.isdir(FOLDER):  # (an installed copy runs from a folder of your own; these came with the program)
    FOLDER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "checks")
RESULTS = os.path.join(FOLDER, "results.json")
NOTES = os.path.join(FOLDER, "notes.txt")
KEYS = os.path.join(FOLDER, "keys")
WORK = os.path.join("build", "check")  # pictures, recordings and logs of the last check
STATUS = "STATUS.md"
SHOTS = 12  # pictures taken of each run

NOTES_HEADER = """\
# What people (and Claude, looking at pictures) have found that a machine cannot.
# One line each:   game code   played|seen   good|bad   date   what was found
#   played: someone played it.      seen: someone looked at pictures of a check.
# The newest line of each kind for a game is what STATUS.md shows.
"""


# ---- One game --------------------------------------------------------------------


def button_script(code: str) -> tuple[str, bool]:
    """The buttons to press during the run, and whether they were written for this game.

    A file checks/keys/<game code>.txt holds presses that take that game
    from its title screen into real play, written as the game program's
    --keys option wants them: frame:buttons:how long, with commas between
    (lines starting with # are notes). Without one, Start and A are
    pressed in turn, which gets past most title screens and no further.
    """
    path = os.path.join(KEYS, code[:3] + ".txt")
    if not os.path.exists(path):
        return PRESSES, False
    lines = [line.strip() for line in open(path) if line.strip() and not line.startswith("#")]
    return ",".join(lines).replace(",,", ","), True


def listen(path: str, rate: int) -> dict:
    """Measure a recording of the run's sound. Needs numpy; without it, says nothing.

    Four things can be told without ears:
      quiet    the part of the recording with no sound at all
      clipped  the part pinned at the loudest possible value (distortion)
      noise    how much the sound resembles hiss rather than notes, from 0
               (pure tones) to 1 (pure hiss). Music and speech have a few
               strong pitches; a sound list carried out wrongly gives
               energy smeared over every pitch.
      ripple   whether one sample in every eight stands apart from the
               rest: how many times bigger the jumps to and from it are.
               The console works on sound eight samples at a time, so a
               sum gone wrong in one of the eight places gives a harsh,
               robotic buzz over sound that is otherwise right. Real sound
               has no reason to favour any place: about 1.
    """
    try:
        import numpy as np

        with wave.open(path) as recording:
            samples = np.frombuffer(recording.readframes(recording.getnframes()), dtype="<i2").astype(np.float64)
    except (ImportError, OSError, EOFError, wave.Error):
        return {}
    left = samples[::2]  # one of the two channels is enough (but not for ripple: it can be in either)
    if len(left) < 4096:
        return {"seconds": 0, "quiet": 1.0, "clipped": 0.0, "noise": 0.0, "ripple": 1.0}
    ripple = 1.0
    for channel in (left, samples[1::2]):
        jumps = np.abs(np.diff(channel))
        by_place = jumps[: len(jumps) // 8 * 8].reshape(-1, 8).mean(axis=0)
        if np.median(by_place) > 1:
            ripple = max(ripple, float(by_place.max() / np.median(by_place)))
    flatness = []
    for start in range(0, len(left) - 2048, 2048):
        piece = left[start : start + 2048]
        if np.abs(piece).mean() < 100:
            continue  # near silence has no pitch to speak of
        power = np.abs(np.fft.rfft(piece * np.hanning(2048))[8:]) ** 2 + 1e-9
        # (the usual measure, "spectral flatness": the two kinds of average
        # agree for hiss and are far apart for a few strong pitches)
        flatness.append(float(np.exp(np.log(power).mean()) / power.mean()))
    return {
        "seconds": round(len(left) / (rate or 32000), 1),
        "quiet": round(float((np.abs(left) < 8).mean()), 3),
        "clipped": round(float((np.abs(left) >= 32700).mean()), 4),
        "noise": round(float(np.median(flatness)), 3) if flatness else 0.0,
        "ripple": round(ripple, 2),
    }


def contact_sheet(shots: list[str], path: str, title: str) -> None:
    """Lay the run's pictures side by side in one image, each marked with its time. Needs Pillow."""
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return
    across = 4
    sheet = Image.new("RGB", (320 * across, 254 * ((len(shots) + across - 1) // across) + 14), (30, 30, 30))
    draw = ImageDraw.Draw(sheet)
    draw.text((2, 1), title, fill=(255, 255, 255))
    for i, shot in enumerate(shots):
        x, y = 320 * (i % across), 254 * (i // across) + 14
        sheet.paste(Image.open(shot).convert("RGB").resize((320, 240)), (x, y + 14))
        frame = int(re.search(r"(\d+)\.ppm$", shot)[1])
        draw.text((x + 2, y + 1), diagnose.clock(frame), fill=(255, 255, 0))
    sheet.save(path)


def look(shots: list[str]) -> dict:
    """What can be told from the pictures alone: how many differ, and whether the last ones are all the same."""
    contents = [open(shot, "rb").read() for shot in shots]
    same_at_end = 0
    for content in reversed(contents):
        if content != contents[-1]:
            break
        same_at_end += 1
    # A picture with anything in it has more than one value among its bytes
    # (after the few bytes at the top that give its size).
    lit = sum(1 for content in contents if len(set(content[20:])) > 1)
    return {"shots": len(shots), "different": len(set(contents)), "same at end": same_at_end, "lit": lit}


def judge(result: dict, session: diagnose.Session, findings: list) -> None:
    """Turn the measurements of one run into the four verdicts, each a short line. "ok" means no fault found."""
    frames = session.frames
    health = session.health

    stops = [f for f in findings if f.what.startswith(("The game stopped", "The game program was killed"))]
    froze = [f for f in findings if f.what.startswith("The game froze")]
    if result.get("hung"):
        result["runs"] = "hung: had to be stopped"
    elif stops:
        result["runs"] = f"stops at {diagnose.clock(frames)}: " + stops[0].what.split(":", 1)[-1].strip()[:90]
    elif froze:
        # (it may have come back to life later; a wait that long is still a fault)
        result["runs"] = f"froze at {diagnose.clock(froze[0].frame)}: no new picture for five seconds or more"
    else:
        result["runs"] = "ok"

    blank = [f for f in findings if "blank" in f.what]
    seen = result.get("seen", {})
    if seen.get("lit", 0) > seen.get("shots", 0) / 2:
        # Most of the pictures taken had something in them, so the log's
        # "never showed anything" is the log missing small text on black.
        blank = [f for f in blank if "never showed" not in f.what]
    lit = sum(1 for h in health if h.get("colours", 0) > 1)
    # (The log judges the screen from a few points on it, and can miss small
    # text on black; the pictures taken of the run settle it.)
    if (not health or lit == 0) and not result.get("seen", {}).get("lit"):
        result["picture"] = "black: never showed anything"
    elif blank:
        result["picture"] = blank[0].what[:90]
    elif unknown := [f for f in findings if "chip program" in f.what or "drawing commands" in f.what and f.serious]:
        result["picture"] = unknown[0].what[:90]
    elif seen.get("shots", 0) >= 6 and seen["same at end"] > seen["shots"] / 2:
        # Not always a fault (a menu waiting for a button looks like this
        # too), but with buttons being pressed all the while it usually is.
        result["picture"] = f"stuck: the last {seen['same at end']} of {seen['shots']} pictures taken are identical"
    else:
        result["picture"] = "ok"

    # Pace: the usual number of pictures in a second, among seconds that had any.
    counts = sorted(h["pictures"] for h in health[2:] if h["pictures"])
    result["pace"] = counts[len(counts) // 2] if counts else 0
    # The screen is redrawn 60 times a second, so no game can show more
    # pictures than that; one that makes more is running ahead of itself.
    # (A game that makes none at all is the picture verdict's business.)
    result["pace verdict"] = "too fast" if result["pace"] > 62 else "ok"

    faults = []
    heard = result.get("heard", {})
    if "SILENT" in result.get("summary", ""):
        faults.append("silent: sound program not understood")
    elif session.sound:
        wants, made, sent, refused, unknown_commands = session.sound
        result["sound numbers"] = {"wants": wants, "made": made, "sent": sent, "refused": refused, "unknown": unknown_commands}
        if unknown_commands:
            faults.append(f"{unknown_commands} commands not understood")
        if made == 0:
            # Sound lists were carried out and nothing came of them: they
            # are in a dialect whose commands mean something else to us.
            faults.append("its sound lists produce nothing" if sent else "makes no sound")
        if sent and abs(sent - wants) > wants * 0.03:
            faults.append(f"sends {sent} a second, wants {wants} ({(sent - wants) * 100 // wants:+d}%)")
        if refused > 3:
            faults.append(f"{refused} blocks thrown away")
    if heard:
        if heard["quiet"] > 0.98:
            faults.append("recording is silent")
        elif heard["noise"] > 0.3:
            faults.append(f"recording is mostly noise ({heard['noise']:.2f})")
        if heard.get("ripple", 1) > 2:
            faults.append(f"buzz: one sample in every eight stands out ({heard['ripple']:.0f} times the rest)")
        if heard["clipped"] > 0.005:
            faults.append(f"distorted: {heard['clipped']:.1%} at full loudness")
    result["sound"] = "; ".join(faults) or "ok"


def check_one(path: str, frames: int, prepare) -> dict:
    """Build one game, run it by itself, and return what was measured."""
    stem = os.path.splitext(os.path.basename(path))[0]
    result = {"file": os.path.basename(path), "code": "?", "title": stem, "frames": 0, "checked": time.strftime("%Y-%m-%d")}
    try:
        rom = Rom.from_file(path)
        code = result["code"] = rom.header.game_code
        result["title"] = TRIED.get(code[:3], (re.sub(r"\s*[\(\[].*", "", stem).strip() or stem,))[0]
        # The same build the game is played from, so what is checked is what you get.
        out_dir = os.path.join("build", stem)
        args = argparse.Namespace(rom=path, symbols=None, own_cheats=os.path.join("cheats", stem + ".txt"))
        game, plain_rom = prepare(rom, args, out_dir, quiet=True)
    except subprocess.CalledProcessError:
        result.update(runs="does not build: the C compiler refused it", picture="-", sound="-", pace=0)
        return result
    except Exception as problem:  # anything at all: one bad ROM must not stop the check
        where = traceback.extract_tb(problem.__traceback__)[-1]
        result.update(runs=f"does not build: {type(problem).__name__}: {problem} ({where.name})"[:120], picture="-", sound="-", pace=0)
        return result

    work = os.path.join(WORK, stem)
    shots_dir = os.path.join(work, "shots")
    os.makedirs(shots_dir, exist_ok=True)
    for old in glob.glob(os.path.join(glob.escape(work), "*.*")) + glob.glob(os.path.join(glob.escape(shots_dir), "*")):
        os.remove(old)  # (the scratch save goes too: every check starts from nothing)
    keys, own_script = button_script(code)
    result["script"] = own_script
    recording, log_path = os.path.join(work, "sound.wav"), os.path.join(work, "log.txt")
    command = [game, plain_rom, *game_options(code), "--headless", "--log", "--frames", str(frames),
               "--save", os.path.join(work, "scratch.eep"), "--screenshots", shots_dir, "--every", str(max(frames // SHOTS, 1)),
               "--wav", recording, "--keys", keys]  # fmt: skip
    with open(log_path, "w") as log:
        log.write(f"# game: {result['title']}\n# code: {code}\n# rom: {path}\n# command: {json.dumps(command)}\n")
        log.flush()
        try:
            done = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, timeout=120 + frames / 6)
            log.write(f"# ended: {done.returncode}\n")
        except subprocess.TimeoutExpired:
            result["hung"] = True

    session = diagnose.read_log(log_path)
    findings = diagnose.find_problems(session)
    result["frames"] = session.frames
    result["summary"] = "\n".join(line for line in open(log_path, errors="replace") if line.startswith("  ") and "thread" not in line)
    result["findings"] = [f.what for f in findings if f.serious]
    result["heard"] = listen(recording, session.sound[0] if session.sound else 0)
    shots = sorted(glob.glob(os.path.join(glob.escape(shots_dir), "*.ppm")))
    result["seen"] = look(shots)
    if shots:
        result["sheet"] = os.path.join(work, "sheet.png")
        contact_sheet(shots, result["sheet"], f"{result['title']} [{code}]")
    judge(result, session, findings)
    del result["summary"]
    return result


# ---- All of them, and what changed -------------------------------------------------


def rom_list(paths: list[str], only: list[str]) -> list[str]:
    files = []
    for path in paths:
        if os.path.isdir(path):
            files += sorted(f for f in glob.glob(os.path.join(glob.escape(path), "*")) if f.lower().endswith(ROM_ENDINGS))
        else:
            files.append(path)
    return [f for f in files if not only or any(word.lower() in f.lower() for word in only)]


def load_results() -> dict:
    """The last check of every game, by game code."""
    if not os.path.exists(RESULTS):
        return {}
    with open(RESULTS) as kept:
        return json.load(kept)


VERDICTS = ("runs", "picture", "sound", "pace verdict")


def faults(result: dict) -> int:
    return sum(1 for key in VERDICTS if result.get(key, "ok") != "ok")


def changes(before: dict, after: dict) -> list[str]:
    """What is different about one game since its last check, in words."""
    lines = []
    for key in VERDICTS:
        was, now = before.get(key, "ok"), after.get(key, "ok")
        if was == now:
            continue
        name = key.split()[0]
        if now == "ok":
            lines.append(f"BETTER  {name}: was \"{was}\", now ok")
        elif was == "ok":
            lines.append(f"WORSE   {name}: was ok, now \"{now}\"")
        else:
            lines.append(f"changed {name}: was \"{was}\", now \"{now}\"")
    if before.get("pace") and after.get("pace") and abs(before["pace"] - after["pace"]) > 2 and before.get("pace verdict") == after.get("pace verdict"):
        lines.append(f"changed pace: {before['pace']} pictures a second, now {after['pace']}")
    if after.get("frames", 0) < before.get("frames", 0) * 0.9:
        lines.append(f"WORSE   ran {after['frames']} frames, where it ran {before['frames']} before")
    return lines


def one_line(result: dict) -> str:
    marks = "".join("." if result.get(key, "ok") == "ok" else letter for key, letter in zip(VERDICTS, "RPSF"))
    worst = next((f"{key.split()[0]}: {result[key]}" for key in VERDICTS if result.get(key, "ok") != "ok"), "no fault found by machine")
    return f"{result['title'][:30]:<30} {result['code']}  {marks}  {result.get('pace', 0):3}/s  {worst[:80]}"


def check(paths: list[str], frames: int, jobs: int, only: list[str], prepare) -> None:
    files = rom_list(paths, only)
    if not files:
        raise SystemExit("no ROMs found to check")
    os.makedirs(FOLDER, exist_ok=True)
    kept = load_results()
    print(f"Checking {len(files)} games, {frames} frames each ({frames // 60} seconds of game time), {jobs} at once.")
    print("Marks: R stops or crashes, P picture, S sound, F too fast; a dot is no fault found.\n", flush=True)
    different = []
    with ThreadPoolExecutor(jobs) as pool:
        for result in pool.map(lambda f: check_one(f, frames, prepare), files):
            print(one_line(result), flush=True)
            before = kept.get(result["code"])
            # A shorter run than the one on record cannot be compared with it fairly.
            if before and before.get("asked") == frames:
                different += [f"{result['title']}: {line}" for line in changes(before, result)]
            result["asked"] = frames
            if result["code"] != "?":
                kept[result["code"]] = result
    with open(RESULTS, "w") as out:
        json.dump(kept, out, indent=1, sort_keys=True)

    print()
    if different:
        print("Since the last check:")
        for line in sorted(different, key=lambda text: "WORSE" not in text):
            print(f"  {line}")
    else:
        print("Nothing changed since the last check (of games checked before for the same length).")
    write_status(kept)
    print(f"\n{STATUS} is up to date. Pictures of each run: {WORK}/<game>/sheet.png")


# ---- The living list ----------------------------------------------------------------


def read_notes() -> dict:
    """The newest "played" and "seen" note for each game: {code: {"played": (verdict, date, text), ...}}."""
    notes: dict = {}
    if not os.path.exists(NOTES):
        return notes
    for line in open(NOTES):
        found = re.match(r"(\w{3,4})\s+(played|seen)\s+(good|bad)\s+(\S+)\s+(.*)", line.strip())
        if found:
            notes.setdefault(found[1][:3], {})[found[2]] = (found[3], found[4], found[5])
    return notes


def add_note(code: str, kind: str, verdict: str, text: str) -> None:
    os.makedirs(FOLDER, exist_ok=True)
    if not os.path.exists(NOTES):
        with open(NOTES, "w") as out:
            out.write(NOTES_HEADER)
    with open(NOTES, "a") as out:
        out.write(f"{code[:3].upper()} {kind} {verdict} {time.strftime('%Y-%m-%d')} {text}\n")
    write_status(load_results())


def has_names(result: dict) -> bool:
    """Whether a decompilation project's list of names is in symbols/ for this game."""
    stem = os.path.splitext(result.get("file", ""))[0]
    return any(os.path.exists(os.path.join("symbols", name + ending)) for name in (stem, result["code"]) for ending in (".map", ".txt"))


# The states a game can be in, best first, and what each means.
STATES = (
    ("Ready", "Playable 100%: a person has played it and found it good, and the machine finds no fault."),
    ("In Progress", "Still being tested, somewhat playable: it runs, but has faults listed in its row or has not been played yet."),
    ("Untested", "Not tested: the machine finds no fault, but nobody has looked at it or played it."),
    ("Broken", "Tested, unplayable: it stops, freezes, crashes or shows nothing."),
)
# The number the game list (launcher/launcher.c) sorts by: 0 is best.
RANKS = {name: number for number, (name, _) in enumerate(STATES)}


def state_of(result: dict, notes: dict) -> str:
    played, seen = notes.get("played"), notes.get("seen")
    if result.get("runs", "ok") != "ok":
        return "Broken"
    if result.get("picture", "ok").startswith(("black", "The screen never")):
        return "Broken"
    if not played and not seen and not faults(result):
        return "Untested"
    # (Someone playing it counts for more than someone looking at pictures of it.)
    if played and played[0] == "good" and not faults(result):
        return "Ready"
    return "In Progress"


def launcher_line(code: str) -> tuple[int, str] | None:
    """For the game list: how a game sorts (0 best) and a line about it, from its last check."""
    result = load_results().get(code)
    if result is None:
        return None
    notes = read_notes().get(code[:3], {})
    state = state_of(result, notes)
    rank = RANKS[state]
    wrong = [f"{key.split()[0]}: {result[key]}" for key in VERDICTS if result.get(key, "ok") != "ok"]
    wrong += [text for verdict, _, text in notes.values() if verdict == "bad"]
    if not wrong:
        wrong = [notes[kind][2] for kind in ("played", "seen") if kind in notes][:1] or ["No fault found by machine; not played yet."]
    return rank, "; ".join(wrong)[:110].replace("\t", " ")


def write_status(results: dict) -> None:
    notes = read_notes()
    order = [name for name, _ in STATES]
    rows = sorted(results.values(), key=lambda r: (order.index(state_of(r, notes.get(r["code"][:3], {}))), r["title"]))
    counts = {name: sum(1 for r in rows if state_of(r, notes.get(r["code"][:3], {})) == name) for name in order}

    def cell(result: dict, key: str) -> str:
        text = result.get(key, "ok")
        return "ok" if text == "ok" else f"**{text}**".replace("|", "/")

    out = ["# Where each game stands", "",
           "Written by `python3 -m snakerecomp check`; do not edit by hand (it is written afresh each time).",
           "What people find by playing or looking goes in `checks/notes.txt`, or:", "",
           "```bash", 'python3 -m snakerecomp note NSM played good "Played to the first star, all fine"', "```", "",
           f"Last written {time.strftime('%Y-%m-%d %H:%M')}. " + ", ".join(f"{counts[name]} {name}" for name in order if counts[name]) + ".", "",
           "| State | Meaning |", "|---|---|"]  # fmt: skip
    out += [f"| {name} | {meaning} |" for name, meaning in STATES if counts[name]]
    out += ["",
            "The machine's columns come from running each game by itself for a while with no window. **Runs**: did it",
            "reach the end. **Picture**: was the screen blank or were drawing commands not understood (it cannot see",
            "wrong colours or garbled text; that is what \"Looked at\" is for). **Sound**: does the amount of sound",
            "agree with what the game asked for, and is the recording silent, distorted or noise. **Pace**: pictures",
            "a second. **Script**: \"own\" if the run pressed buttons written for that game to reach real play;",
            "otherwise it only pressed Start and A, and may not have got past the menus. **Names**: whether a",
            "decompilation project's list of function names is in `symbols/`.", "",
            "| Game | State | Runs | Picture | Sound | Pace | Script | Names | Looked at | Played | Checked |",
            "|---|---|---|---|---|---|---|---|---|---|---|"]  # fmt: skip
    for r in rows:
        mine = notes.get(r["code"][:3], {})
        said = {kind: f"{mine[kind][0]}, {mine[kind][1]}: {mine[kind][2]}".replace("|", "/") if kind in mine else "" for kind in ("seen", "played")}
        pace = f"{r.get('pace', 0)}" + (" **too fast**" if r.get("pace verdict") == "too fast" else "")
        out.append(f"| {r['title']} | {state_of(r, mine)} | {cell(r, 'runs')} | {cell(r, 'picture')} | {cell(r, 'sound')} | {pace} | "
                   f"{'own' if r.get('script') else ''} | {'yes' if has_names(r) else ''} | {said['seen']} | {said['played']} | {r.get('checked', '')} |")  # fmt: skip
    with open(STATUS, "w") as status:
        status.write("\n".join(out) + "\n")
