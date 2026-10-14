"""Check the recompiler against the interpreter.

The recompiled C and the Python interpreter were written separately, so if
they agree on what a function does, both are very likely right. For every
function we invent a starting state (register values and memory), run the
function both ways, and compare everything afterwards: all registers and
every byte of memory that changed.

A function given invented inputs often does something invalid, such as
following a garbage pointer. That still counts as agreement if both sides
stop ("trap") rather than carrying on.
"""

import os
import random
import struct
import subprocess
from dataclasses import dataclass

from .build import build
from .cpu import RAM_SIZE, Cpu, Trap, s32
from .program import Program

MAX_STEPS = 20000  # give up on a test if the function runs longer than this
SCRATCH_START, SCRATCH_SIZE = 0x80400000, 0x80000
STACK_POINTER = 0x807FF000
RETURN_ADDRESS = s32(0x8FFFFFF0)  # not a real address; marks "function returned"
EXTRA_SEGMENT_DATA = 0x20000  # how much data to load after an extra segment's code


def build_ram(program: Program, rng: random.Random) -> bytes:
    """Lay memory out roughly as it would be with the game loaded."""
    ram = bytearray(RAM_SIZE)
    rom = program.rom.data
    # Each extra segment's data follows its code. Lay the data down first and
    # all the code afterwards, so that one segment's data can never land on
    # top of another segment's code.
    for with_data in (True, False):
        for segment in program.segments:
            extra = EXTRA_SEGMENT_DATA if with_data and segment is not program.segments[0] else 0
            data = rom[segment.rom_start : segment.rom_start + segment.size + extra]
            start = segment.vram_start & 0x1FFFFFFF
            ram[start : start + len(data)] = data
    # An area of plausible-looking data for invented pointers to point at:
    # more pointers into the same area, small numbers, and floats.
    words = []
    for _ in range(SCRATCH_SIZE // 4):
        kind = rng.random()
        if kind < 0.5:
            words.append(struct.pack(">I", SCRATCH_START + rng.randrange(0, SCRATCH_SIZE - 256, 4)))
        elif kind < 0.75:
            words.append(struct.pack(">I", rng.randrange(256)))
        else:
            words.append(struct.pack(">f", rng.uniform(-100, 100)))
    start = SCRATCH_START & 0x1FFFFFFF
    ram[start : start + SCRATCH_SIZE] = b"".join(words)
    return bytes(ram)


def invent_state(rng: random.Random) -> tuple[list[int], list[int]]:
    registers = [s32(rng.getrandbits(32)) for _ in range(32)]
    registers[0] = 0
    for n in (4, 5, 6, 7):  # the four argument registers
        kind = rng.random()
        if kind < 0.5:
            registers[n] = s32(SCRATCH_START + rng.randrange(0, SCRATCH_SIZE - 256, 8))
        elif kind < 0.8:
            registers[n] = rng.randrange(16)
    registers[29] = s32(STACK_POINTER)
    registers[31] = RETURN_ADDRESS
    floats = [struct.unpack(">I", struct.pack(">f", rng.uniform(-100, 100)))[0] for _ in range(32)]
    return registers, floats


def both_nan(a: int, b: int) -> bool:
    """Are both 32-bit patterns a float "not a number"?

    There are millions of NaN patterns, and which one a calculation produces
    varies between CPUs (and Python), so any NaN is accepted for any other.
    """
    return all(v & 0x7F800000 == 0x7F800000 and v & 0x007FFFFF for v in (a, b))


@dataclass
class Report:
    identical: int = 0  # ran to the end, same result both ways
    trapped: int = 0  # both stopped at the same invalid operation, in the same state
    skipped: int = 0  # ran too long to test
    untranslated: int = 0  # reached a function the recompiler could not translate
    mismatches: list[str] = None


def verify(
    program: Program,
    source_dir: str,
    tests_per_function: int = 2,
    seed: int = 1,
    exclude: set[int] = frozenset(),
) -> Report:
    rng = random.Random(seed)
    ram = build_ram(program, rng)
    starts = set(program.functions)
    report = Report(mismatches=[])

    # Run everything in the interpreter first, remembering what happened.
    expected = []
    tests_path = os.path.join(source_dir, "tests.bin")
    with open(tests_path, "wb") as tests:
        for address in sorted(starts):
            for _ in range(tests_per_function):
                registers, floats = invent_state(rng)
                if address in exclude:
                    continue
                cpu = Cpu(ram, starts)
                cpu.r, cpu.fw = list(registers), list(floats)
                try:
                    if not cpu.call(address, MAX_STEPS):
                        report.skipped += 1
                        continue
                    trapped = False
                except Trap:
                    trapped = True
                expected.append((address, trapped, cpu))
                tests.write(struct.pack("<I32Q32I", address, *registers, *floats))

    ram_path = os.path.join(source_dir, "ram.bin")
    with open(ram_path, "wb") as out:
        out.write(ram)
    results_path = os.path.join(source_dir, "results.bin")
    harness = build(source_dir, ["harness.c"], "harness")
    subprocess.run([harness, ram_path, tests_path, results_path], check=True)

    with open(results_path, "rb") as results:
        for address, trapped, cpu in expected:
            status, *values = struct.unpack("<B34Q34I", results.read(1 + 34 * 8 + 34 * 4))
            registers, hi, lo = values[:32], values[32], values[33]
            floats, fcr31, count = values[34:66], values[66], values[67]
            changes = dict(struct.iter_unpack("<IB", results.read(count * 5)))
            name = f"func_{address:08X}"
            if status == 2:
                report.untranslated += 1
                continue
            if trapped != bool(status):
                who = "interpreter" if trapped else "recompiled code"
                report.mismatches.append(f"{name}: only the {who} trapped")
                continue
            # Compare everything, even after a trap: both sides should have
            # got exactly as far before stopping.
            problems = [
                f"${n} = {registers[n]:X}, expected {cpu.r[n]:X}"
                for n in range(32)
                if registers[n] != cpu.r[n] and not both_nan(registers[n], cpu.r[n])
            ]
            if (hi, lo) != (cpu.hi, cpu.lo):
                problems.append("HI/LO differ")
            problems += [
                f"$f{n} = {floats[n]:08X}, expected {cpu.fw[n]:08X}"
                for n in range(32)
                if floats[n] != cpu.fw[n] and not both_nan(floats[n], cpu.fw[n])
            ]
            if fcr31 != cpu.fcr31:
                problems.append(f"FCR31 = {fcr31:X}, expected {cpu.fcr31:X}")

            def word_at(memory: dict[int, int], a: int) -> int:
                return int.from_bytes(bytes(memory.get(i, ram[i]) for i in range(a, a + 4)), "big")

            wanted = {a: v for a, v in cpu.writes.items() if ram[a] != v}
            differing = sorted(
                a
                for a in changes.keys() | wanted.keys()
                if changes.get(a) != wanted.get(a)
                and not both_nan(word_at(changes, a & ~3), word_at(wanted, a & ~3))
            )
            if differing:
                detail = ", ".join(
                    f"0x{a:06X}: {changes.get(a, ram[a]):02X} expected {wanted.get(a, ram[a]):02X}"
                    for a in differing[:8]
                )
                problems.append(f"{len(differing)} bytes of memory differ ({detail})")
            if problems:
                report.mismatches.append(f"{name}: " + "; ".join(problems[:3]))
            elif trapped:
                report.trapped += 1
            else:
                report.identical += 1
    return report
