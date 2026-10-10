"""Command-line entry point: python -m snakedecomp <command> <rom>"""

import argparse
import os
import re
import subprocess
import zipfile

from .cheats import find_cheats, read_cheat_file, write_cheat_file
from .build import build, game_names, game_source, host_addresses, host_replacements, sdl_flags
from .profiles import TRIED, UNTRIED, game_options
from .program import Program, analyse
from .recomp import Recompiler
from .rom import Rom
from .libsigs import recognise_library
from .signatures import learn, load_database, recognise, save_database
from .survey import describe, survey
from .symbols import Symbols, load_map
from .verify import verify


def load_program(rom: Rom, args: argparse.Namespace) -> Program:
    """Analyse the ROM and name as many functions as we can.

    With a linker map for this ROM (by default symbols/<rom name>.map) every
    function gets its real name. Without one, the OS library functions are
    recognised from the fingerprints that come with this tool, and a few
    game-specific names come from the game's file in runtime/games/.
    """
    path = args.symbols
    if path is None:
        name = os.path.splitext(os.path.basename(args.rom))[0]
        path = os.path.join("symbols", name + ".map")
    if os.path.exists(path):
        return analyse(rom, load_map(path))

    program = analyse(rom)
    # Two ways of recognising the library: fingerprints we learned ourselves
    # from one game, which also catch near matches, and a big ready-made
    # list covering many versions of the library, which wins where both
    # have an opinion.
    names = recognise(program, load_database())
    library_names, library_addresses = recognise_library(program)
    taken = set(library_names.values())
    names = {a: n for a, n in names.items() if n not in taken} | library_names
    for start, symbol in names.items():
        if start in program.functions:
            program.functions[start].symbol = symbol
    program.symbols = Symbols(addresses=library_addresses | game_names(rom.header.game_code))
    for symbol, start in program.symbols.addresses.items():
        if start in program.functions:
            program.functions[start].symbol = symbol
    return program


def cmd_learn(rom: Rom, args: argparse.Namespace) -> None:
    """Rebuild the fingerprint file from a ROM we have a linker map for."""
    program = load_program(rom, args)
    if program.symbols is None or not program.symbols.code_blocks:
        raise SystemExit("learning needs a linker map for this ROM (see --symbols)")
    entries = learn(program)
    save_database(entries)
    print(f"Saved fingerprints of {len(entries)} library functions.")


def cmd_info(rom: Rom, args: argparse.Namespace) -> None:
    h = rom.header
    crc1, crc2 = rom.compute_checksum()
    ok = (crc1, crc2) == (h.crc1, h.crc2)
    print(f"Name:         {h.name}")
    print(f"Game code:    {h.game_code} ({h.region}), version 1.{h.version}")
    print(f"Size:         {len(rom.data) // (1024 * 1024)} MB")
    print(f"Entry point:  0x{h.entry_point:08X}")
    print(f"Boot chip:    {h.boot_chip}")
    print(f"libultra:     revision {h.libultra_version}")
    print(f"Checksum:     {h.crc1:08X} {h.crc2:08X} ({'valid' if ok else 'MISMATCH'})")


def cmd_disasm(rom: Rom, args: argparse.Namespace) -> None:
    program = load_program(rom, args)
    address = args.address if args.address is not None else rom.header.entry_point
    count = args.count
    if args.function:
        function = program.function_containing(address)
        if function is None:
            raise SystemExit(f"no function found containing 0x{address:08X}")
        address, count = function.start, function.size
        print(f"{function.label}:")
    for _ in range(count):
        word = program.decode(address).word
        print(f"{address:08X}  {word:08X}  {program.describe(address)}")
        address += 4


def cmd_functions(rom: Rom, args: argparse.Namespace) -> None:
    program = load_program(rom, args)
    functions = sorted(program.functions.values(), key=lambda f: f.start)
    if args.list:
        print("address   instrs  callers  segment        name")
        for f in functions:
            print(f"{f.start:08X}  {f.size:6}  {f.callers:7}  {f.segment.name:<13}  {f.symbol or ''}")
        return
    print("Segments (where code is in the ROM, and where it is loaded in memory):")
    for segment in program.segments:
        mine = [f for f in functions if f.segment is segment]
        print(
            f"  {segment.name:<14} ROM 0x{segment.rom_start:06X} -> memory 0x{mine[0].start:08X}"
            f" - 0x{mine[-1].end:08X}  {len(mine):5} functions"
        )
    print(f"Functions:      {len(functions)}")
    print(f"Instructions:   {sum(f.size for f in functions)}")
    print(f"Switch tables:  {sum(len(f.jump_tables) for f in functions)}")
    print(f"Never called directly:  {sum(1 for f in functions if not f.callers)}")
    print(f"Calls to unknown addresses:  {len(program.unresolved_calls)}")
    if program.symbols and program.symbols.functions:
        # Leave out labels inside hand-written assembly, which are not functions.
        named = {
            a for a, n in program.symbols.functions.items()
            if program.segment_for(a) and not re.match(r"L(_U)?_?[0-9A-F]{8}$|rsp", n)
        }
        found = len(named & program.functions.keys())
        print(f"Checked against the name list:  found {found} of its {len(named)} functions")
    print("Most called:")
    for f in sorted(functions, key=lambda f: f.callers, reverse=True)[:5]:
        print(f"  {f.label}  called from {f.callers} functions")


def cmd_recompile(rom: Rom, args: argparse.Namespace) -> None:
    program = load_program(rom, args)
    recompiler = Recompiler(program)
    count = recompiler.write(args.output)
    print(f"Wrote {count} functions as C to {args.output}/")
    if recompiler.problems:
        print(f"{len(recompiler.problems)} could not be translated and will stop if called:")
        for problem in recompiler.problems:
            print(f"  {problem}")
    if args.verify:
        print("Compiling and comparing against the interpreter (takes a few minutes)...")
        report = verify(program, args.output, args.tests, exclude=recompiler.not_recompiled)
        print(f"  identical results:               {report.identical}")
        print(f"  stopped at the same point:       {report.trapped}")
        print(f"  skipped (ran too long to test):  {report.skipped}")
        print(f"  skipped (hit untranslated code): {report.untranslated}")
        print(f"  MISMATCHES:                      {len(report.mismatches)}")
        for mismatch in report.mismatches:
            print(f"    {mismatch}")


def prepare_game(rom: Rom, args: argparse.Namespace, out_dir: str, quiet: bool = False) -> tuple[str, str]:
    """Recompile and build a game if that is needed.

    Returns the paths of the finished program and of the ROM for it to read.
    """
    os.makedirs(out_dir, exist_ok=True)
    program = load_program(rom, args)
    # -fno-pie / -no-pie: put the program's code and variables at the same
    # addresses on every run, and -fno-stack-protector: leave out a check
    # that uses a number chosen afresh on every run. Save states need both
    # (see "Save states" in runtime/host.c).
    flags, libraries = ["-O2", "-DHOST_RUNTIME", "-fno-pie", "-fno-stack-protector"], ["-no-pie"]
    sdl = sdl_flags()
    if sdl:
        flags += ["-DUSE_SDL", *sdl[0]]
        libraries += [*sdl[1], "-lGL"]
    elif not quiet:
        print("SDL2 not found: building without a window.")

    # Rebuild if the game has never been built, or our own code is newer.
    game = os.path.join(out_dir, "game")
    package = os.path.dirname(__file__)
    ours = [os.path.join(folder, name) for folder, _, names in os.walk(package) for name in names]
    own_cheats = getattr(args, "own_cheats", "")
    if os.path.exists(own_cheats):
        ours.append(own_cheats)  # (cheats you add yourself can call for a rebuild too)
    stale = not os.path.exists(game) or os.path.getmtime(game) < max(
        # (the game list's own program is no part of a game)
        os.path.getmtime(path) for path in ours if "__pycache__" not in path and os.sep + "launcher" + os.sep not in path
    )
    if getattr(args, "rebuild", False) or stale:
        code = rom.header.game_code
        # The ready-made cheats for this exact ROM, for the game program to
        # read when it starts. A few cheats work by rewriting the game's
        # instructions rather than its numbers; the recompiler has to know
        # where, because translated code does not look at the instructions
        # in memory any more (see Recompiler).
        cheats = find_cheats(rom)
        write_cheat_file(cheats, os.path.join(out_dir, "cheats.txt"))
        cheats += read_cheat_file(own_cheats)
        rewritten = set().union(*(cheat.addresses() for cheat in cheats)) if cheats else set()
        recompiler = Recompiler(program, host_replacements(code), host_addresses(code), rewritten)
        recompiler.write(out_dir)
        if recompiler.problems and not quiet:
            print(f"{len(recompiler.problems)} functions will be interpreted rather than translated.")
        if getattr(args, "notes", False):
            for problem in recompiler.problems:
                print(f"note: {problem}")
        if not quiet:
            print("Compiling (a minute or two the first time)...")
        sources = ["host.c", "interp.c", "cheats.c", "gfx.c", "audio.c", game_source(code) or "games/none.c"]
        if sdl:
            sources.append("gfx_gl.c")  # drawing on the graphics card needs the window
        game = build(out_dir, sources, "game", tuple(flags), tuple(libraries))

    # The game program reads the ROM too. Give it a copy in the usual byte
    # order, since the file we were given may be zipped or in another order.
    plain_rom = os.path.join(out_dir, "rom.z64")
    if not os.path.exists(plain_rom) or os.path.getsize(plain_rom) != len(rom.data):
        with open(plain_rom, "wb") as out:
            out.write(rom.data)
    return game, plain_rom


def cmd_run(rom: Rom, args: argparse.Namespace, extra: list[str]) -> None:
    # Each ROM gets its own build folder, so several games can sit side by side.
    rom_name = os.path.splitext(os.path.basename(args.rom))[0]
    args.output = args.output or os.path.join("build", rom_name)
    # Cheats of your own for this game go in cheats/<rom name>.txt.
    args.own_cheats = os.path.join("cheats", rom_name + ".txt")
    game, plain_rom = prepare_game(rom, args, args.output)

    os.makedirs("saves", exist_ok=True)
    save = os.path.join("saves", rom_name + ".eep")
    # What the player chooses in the F1 menu is remembered here, per game.
    os.makedirs("settings", exist_ok=True)
    settings = os.path.join("settings", rom_name + ".txt")
    # Save states, several per game.
    os.makedirs("states", exist_ok=True)
    options = ["--save", save, "--settings", settings, "--states", os.path.join("states", rom_name)]
    # The screenshot shortcut (F12) saves here.
    os.makedirs("screenshots", exist_ok=True)
    options += ["--pictures", os.path.join("screenshots", rom_name)]
    options += game_options(rom.header.game_code)
    options += ["--cheats", os.path.join(args.output, "cheats.txt")]
    if os.path.exists(args.own_cheats):
        options += ["--cheats", args.own_cheats]
    if args.scale:
        options += ["--scale", str(args.scale)]
    elif "--smooth" in extra and not os.path.exists(settings):
        # Smooth motion draws twice as many pictures, so unless the player
        # has chosen a resolution, start it at a lower one.
        options += ["--scale", "2"]
    subprocess.run([game, plain_rom, *options, *extra])


def rom_files(folder: str) -> list[str]:
    names = sorted(os.listdir(folder)) if os.path.isdir(folder) else []
    return [os.path.join(folder, n) for n in names if n.lower().endswith((".z64", ".n64", ".v64", ".zip"))]


def cmd_list(args: argparse.Namespace) -> None:
    """One line per ROM in a folder, for the game list (launcher/launcher.c) to read.

    The parts are separated by tabs: file, title, how well it sorts, what we
    know about it, how many ready-made cheats it has, whether it is built.
    """
    for path in rom_files(args.folder):
        try:
            rom = Rom.from_file(path)
        except (OSError, ValueError, zipfile.BadZipFile):
            continue  # not a ROM we can read: leave it off the list
        stem = os.path.splitext(os.path.basename(path))[0]
        # A file name like "Star Fox 64 (U) (V1.1) [!]" without the brackets.
        plain = re.sub(r"\s*[\(\[].*", "", stem).strip() or stem
        title, rank, note = TRIED.get(rom.header.game_code[:3], (plain, *UNTRIED))
        built = os.path.exists(os.path.join("build", stem, "game"))
        print(f"{path}\t{title}\t{rank}\t{note}\t{len(find_cheats(rom))}\t{int(built)}")


def cmd_build(args: argparse.Namespace) -> None:
    """Build games without starting them, so that starting them later is quick."""
    for path in [p for given in args.roms for p in (rom_files(given) if os.path.isdir(given) else [given])]:
        stem = os.path.splitext(os.path.basename(path))[0]
        print(f"Building {stem}...", flush=True)
        try:
            build_args = argparse.Namespace(rom=path, symbols=None, own_cheats=os.path.join("cheats", stem + ".txt"))
            prepare_game(Rom.from_file(path), build_args, os.path.join("build", stem), quiet=True)
        except (OSError, ValueError, subprocess.CalledProcessError) as problem:
            print(f"  could not build it: {problem}")
            if len(args.roms) == 1 and not os.path.isdir(args.roms[0]):
                raise SystemExit(1)


def cmd_survey(args: argparse.Namespace) -> None:
    results = survey(args.roms, args.output, args.frames, args.jobs, prepare_game)
    report = os.path.join(args.output, "report.txt")
    with open(report, "w") as out:
        out.writelines(describe(r) + "\n" for r in results)
    working = sum(1 for r in results if r["pictures"] and not r["note"])
    print(f"\n{working} of {len(results)} ran to the end and drew pictures. Report saved to {report}")
    print("Each game's last screenshots and full output are in its folder there.")


def parse_int(text: str) -> int:
    return int(text, 0)  # accepts both 123 and 0x7B


def main() -> None:
    parser = argparse.ArgumentParser(prog="snakedecomp")
    commands = parser.add_subparsers(dest="command", required=True)

    info = commands.add_parser("info", help="show the ROM header")
    info.add_argument("rom")
    info.set_defaults(func=cmd_info)

    disasm = commands.add_parser("disasm", help="disassemble MIPS code")
    disasm.add_argument("rom")
    disasm.add_argument(
        "-a", "--address", type=parse_int, help="memory address to start at (default: entry point)"
    )
    disasm.add_argument(
        "-n", "--count", type=parse_int, default=16, help="number of instructions (default: 16)"
    )
    disasm.add_argument(
        "-f", "--function", action="store_true", help="show the whole function at the address"
    )
    disasm.set_defaults(func=cmd_disasm)

    functions = commands.add_parser("functions", help="find code segments and functions")
    functions.add_argument("rom")
    functions.add_argument("-l", "--list", action="store_true", help="list every function")
    functions.set_defaults(func=cmd_functions)

    recompile = commands.add_parser("recompile", help="translate the game's code to C")
    recompile.add_argument("rom")
    recompile.add_argument("-o", "--output", default="build/recomp", help="output directory")
    recompile.add_argument(
        "--verify", action="store_true", help="also test the C against the interpreter"
    )
    recompile.add_argument(
        "--tests", type=parse_int, default=2, help="tests per function with --verify (default: 2)"
    )
    recompile.set_defaults(func=cmd_recompile)

    run = commands.add_parser(
        "run",
        help="recompile, build and play the game",
        description="Controls: WASD move, J or Space = A, K = B, L or Left Shift = Z, "
        "Enter = Start, arrow keys = C buttons, E = R, Esc = menu (settings, reset, quit). Gamepads work too. "
        "Extras: --wide for a 16:9 picture, --smooth for 60 frames per second, and "
        "free look with the mouse (hold the right button and move; wheel zooms; "
        "middle button resets). While playing: F1 (Select on a controller) opens a "
        "settings menu, F3 shows live statistics (or start with --stats).",
    )
    run.add_argument("rom")
    run.add_argument("-o", "--output", help="output directory (default: build/<rom name>)")
    run.add_argument(
        "--scale", type=parse_int, help="resolution multiplier (default: as last chosen, else 3)"
    )
    run.add_argument("--rebuild", action="store_true", help="recompile even if already built")
    run.add_argument("--notes", action="store_true", help="list what could not be translated, and why")
    run.set_defaults(func=cmd_run)

    learn_command = commands.add_parser(
        "learn", help="rebuild the library fingerprints from a ROM with a linker map"
    )
    learn_command.add_argument("rom")
    learn_command.set_defaults(func=cmd_learn)

    survey_command = commands.add_parser(
        "survey", help="try every ROM in a folder with no window, and report how far each gets"
    )
    survey_command.add_argument("roms", nargs="+", help="ROM files, or folders of them")
    survey_command.add_argument("-o", "--output", default="build/survey", help="where to build and report")
    survey_command.add_argument("--frames", type=parse_int, default=1500, help="how long to run each (default: 1500)")
    survey_command.add_argument("--jobs", type=parse_int, default=2, help="games to work on at once (default: 2)")

    list_command = commands.add_parser("list", help="list the ROMs in a folder and what is known of each")
    list_command.add_argument("folder")
    build_command = commands.add_parser("build", help="build games without starting them")
    build_command.add_argument("roms", nargs="+", help="ROM files, or folders of them")

    for command in (disasm, functions, recompile, run, learn_command):
        command.add_argument("-s", "--symbols", help="linker map with function names")

    # Options we do not recognise are handed on to the game itself.
    args, extra = parser.parse_known_args()
    if args.command in ("survey", "list", "build"):
        if extra:
            parser.error(f"unrecognised arguments: {' '.join(extra)}")
        {"survey": cmd_survey, "list": cmd_list, "build": cmd_build}[args.command](args)
    elif args.func is cmd_run:
        cmd_run(Rom.from_file(args.rom), args, extra)
    elif extra:
        parser.error(f"unrecognised arguments: {' '.join(extra)}")
    else:
        args.func(Rom.from_file(args.rom), args)


if __name__ == "__main__":
    main()
