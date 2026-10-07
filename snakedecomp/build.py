"""Compiling the recompiled C into a program with gcc."""

import glob
import os
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor

RUNTIME_DIR = os.path.join(os.path.dirname(__file__), "runtime")


def game_source(game_code: str) -> str | None:
    """The file of changes made specially for one game, if we have one.

    It is named after the four-letter code in the ROM header.
    """
    path = os.path.join(RUNTIME_DIR, "games", game_code + ".c")
    return path if os.path.exists(path) else None


def _host_sources(game_code: str) -> str:
    text = open(os.path.join(RUNTIME_DIR, "host.c")).read()
    special = game_source(game_code)
    return text + (open(special).read() if special else "")


def host_replacements(game_code: str) -> set[str]:
    """Names of the game functions the host program implements (its hle_ functions)."""
    return set(re.findall(r"^void hle_(\w+)\(Context", _host_sources(game_code), re.MULTILINE))


def host_addresses(game_code: str) -> set[str]:
    """Names of game variables the host wants the addresses of (ADDR_<name>)."""
    return set(re.findall(r"\bADDR_(\w+)", _host_sources(game_code)))


def sdl_flags() -> tuple[list[str], list[str]] | None:
    """Compiler and linker options for the SDL2 library, if it is installed.

    SDL2 gives us a window, keyboard and gamepad input on any system.
    """
    try:
        cflags = subprocess.run(
            ["pkg-config", "--cflags", "sdl2"], capture_output=True, text=True, check=True
        )
        libs = subprocess.run(
            ["pkg-config", "--libs", "sdl2"], capture_output=True, text=True, check=True
        )
    except (OSError, subprocess.CalledProcessError):
        return None
    return cflags.stdout.split(), libs.stdout.split()


def build(
    source_dir: str,
    runtime_sources: list[str],
    name: str,
    flags: tuple[str, ...] = ("-O1",),
    libraries: tuple[str, ...] = (),
) -> str:
    """Compile every C file in source_dir plus the named files from runtime/.

    Returns the path of the finished program.
    """
    sources = sorted(glob.glob(os.path.join(source_dir, "*.c")))
    sources += [os.path.join(RUNTIME_DIR, source) for source in runtime_sources if source]

    def compile_one(source: str) -> str:
        obj = os.path.join(source_dir, os.path.basename(source)[:-2] + ".o")
        command = ["gcc", *flags, "-w", "-ffp-contract=off", "-I", source_dir]
        if os.path.basename(source) in ("gfx.c", "gfx_gl.c", "audio.c"):
            # Drawing and sound are where the time goes: optimise for this CPU.
            command += ["-O3", "-march=native"]
        subprocess.run([*command, "-c", source, "-o", obj], check=True)
        return obj

    # Compile the files side by side, one per CPU core, then join them up.
    with ThreadPoolExecutor(os.cpu_count()) as pool:
        objects = list(pool.map(compile_one, sources))
    program = os.path.join(source_dir, name)
    subprocess.run(["gcc", *objects, "-lm", *libraries, "-o", program], check=True)
    return program
