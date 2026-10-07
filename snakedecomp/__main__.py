"""Command-line entry point: python -m snakedecomp <command> <rom>"""

import argparse
import os
import re
import subprocess

from .build import build, game_source, host_addresses, host_replacements, sdl_flags
from .program import Program, analyse
from .recomp import Recompiler
from .rom import Rom
from .signatures import learn, recognise
from .symbols import load_map
from .verify import verify


def load_program(rom: Rom, args: argparse.Namespace) -> Program:
    """Analyse the ROM and name as many functions as we can.

    With a linker map for this ROM (by default symbols/<rom name>.map) every
    function gets its real name. Without one, the OS library functions are
    recognised by comparing against any other ROM we do have a map for.
    """
    path = args.symbols
    if path is None:
        name = os.path.splitext(os.path.basename(args.rom))[0]
        path = os.path.join("symbols", name + ".map")
    if os.path.exists(path):
        return analyse(rom, load_map(path))

    program = analyse(rom)
    folder = os.path.dirname(args.rom)
    for other in sorted(os.listdir(folder)):
        other_map = os.path.join("symbols", os.path.splitext(other)[0] + ".map")
        if other.endswith(".z64") and os.path.exists(other_map):
            teacher = analyse(Rom.from_file(os.path.join(folder, other)), load_map(other_map))
            for start, symbol in recognise(program, learn(teacher)).items():
                program.functions[start].symbol = symbol
    return program


def cmd_info(rom: Rom, args: argparse.Namespace) -> None:
    h = rom.header
    crc1, crc2 = rom.compute_checksum()
    ok = (crc1, crc2) == (h.crc1, h.crc2)
    print(f"Name:         {h.name}")
    print(f"Game code:    {h.game_code} ({h.region}), version 1.{h.version}")
    print(f"Size:         {len(rom.data) // (1024 * 1024)} MB")
    print(f"Entry point:  0x{h.entry_point:08X}")
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
    if program.symbols:
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


def cmd_run(rom: Rom, args: argparse.Namespace, extra: list[str]) -> None:
    program = load_program(rom, args)
    if not any(f.symbol for f in program.functions.values()):
        raise SystemExit("running needs function names: a linker map for this ROM or another")
    flags, libraries = ["-O2", "-DHOST_RUNTIME"], []
    sdl = sdl_flags()
    if sdl:
        flags += ["-DUSE_SDL", *sdl[0]]
        libraries = [*sdl[1], "-lGL"]
    else:
        print("SDL2 not found: building without a window.")

    # Rebuild if the game has never been built, or our own code is newer.
    game = os.path.join(args.output, "game")
    package = os.path.dirname(__file__)
    ours = [os.path.join(folder, name) for folder, _, names in os.walk(package) for name in names]
    stale = not os.path.exists(game) or os.path.getmtime(game) < max(
        os.path.getmtime(path) for path in ours if "__pycache__" not in path
    )
    if args.rebuild or stale:
        code = rom.header.game_code
        recompiler = Recompiler(program, host_replacements(code), host_addresses(code))
        recompiler.write(args.output)
        for problem in recompiler.problems:
            print(f"note: {problem}")
        print("Compiling (a minute or two the first time)...")
        sources = ["host.c", "gfx.c", "audio.c", game_source(code)]
        if sdl:
            sources.append("gfx_gl.c")  # drawing on the graphics card needs the window
        game = build(args.output, sources, "game", tuple(flags), tuple(libraries))

    os.makedirs("saves", exist_ok=True)
    save = os.path.join("saves", os.path.splitext(os.path.basename(args.rom))[0] + ".eep")
    # Smooth motion draws twice as many pictures, so start it at a lower resolution.
    scale = args.scale or (2 if "--smooth" in extra else 3)
    subprocess.run([game, args.rom, "--save", save, "--scale", str(scale), *extra])


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
        "Enter = Start, arrow keys = C buttons, E = R, Esc = quit. Gamepads work too. "
        "Extras: --wide for a 16:9 picture, --smooth for 60 frames per second, and "
        "free look with the mouse (hold the right button and move; wheel zooms; "
        "middle button resets). While playing: F1 (Select on a controller) opens a "
        "settings menu, F3 shows live statistics (or start with --stats).",
    )
    run.add_argument("rom")
    run.add_argument("-o", "--output", default="build/game", help="output directory")
    run.add_argument(
        "--scale", type=parse_int, help="resolution multiplier (default 3, or 2 with --smooth)"
    )
    run.add_argument("--rebuild", action="store_true", help="recompile even if already built")
    run.set_defaults(func=cmd_run)

    for command in (disasm, functions, recompile, run):
        command.add_argument("-s", "--symbols", help="linker map with function names")

    # Options we do not recognise are handed on to the game itself.
    args, extra = parser.parse_known_args()
    if args.func is cmd_run:
        cmd_run(Rom.from_file(args.rom), args, extra)
    elif extra:
        parser.error(f"unrecognised arguments: {' '.join(extra)}")
    else:
        args.func(Rom.from_file(args.rom), args)


if __name__ == "__main__":
    main()
