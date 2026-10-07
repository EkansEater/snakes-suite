"""Recognising library functions in a game we have no names for.

Every N64 game contains a copy of Nintendo's OS library, compiled from the
same source. So the function osRecvMesg in one game is, instruction for
instruction, nearly the same as osRecvMesg in another. "Nearly" because
each game places its code and variables at different addresses, and those
addresses are written into the instructions.

A function's fingerprint is therefore its instructions with every embedded
address blanked out. If we know the names in one game (from a linker map),
we can find the same fingerprints in another game and carry the names over.
"""

import difflib

from .functions import Function
from .program import Program

MIN_INSTRUCTIONS = 3  # shorter functions look too alike to tell apart
CLOSE_ENOUGH = 0.8  # for the second, looser pass

# name of a function -> the function it is the only library caller of
CALLERS_OF = {"osEepromLongRead": "osEepromRead", "osEepromLongWrite": "osEepromWrite"}

LOADS_AND_STORES = set(range(32, 48)) | {49, 53, 55, 57, 61, 63}


def fingerprint(program: Program, f: Function) -> tuple[int, ...]:
    words = []
    address_registers: set[int] = set()  # registers holding the top half of an address
    for address in range(f.start, f.end, 4):
        word = program.rom.word(f.segment.to_rom(address))
        op, rs, rt = word >> 26, (word >> 21) & 0x1F, (word >> 16) & 0x1F
        if op in (2, 3):  # j, jal: blank out where it goes
            word &= 0xFC000000
        elif op == 15 and 0x8000 <= word & 0xFFFF < 0xA000:  # lui: top half of a RAM address
            word &= 0xFFFF0000
            address_registers.add(rt)
        elif op == 15:  # lui of anything else is a constant (such as a hardware address): keep
            address_registers.discard(rt)
        elif op in (8, 9, 13) and rs in address_registers:  # addiu/ori: the bottom half
            word &= 0xFFFF0000
            address_registers.discard(rs)
        elif op in LOADS_AND_STORES and rs in address_registers:  # bottom half as an offset
            word &= 0xFFFF0000
        words.append(word)
    return tuple(words)


def learn(program: Program) -> dict[tuple[int, ...], str]:
    """Fingerprints of the named library functions in a game."""
    known: dict[tuple[int, ...], str | None] = {}
    for f in program.functions.values():
        if f.symbol and f.size >= MIN_INSTRUCTIONS and program.symbols.is_library(f.start):
            print_ = fingerprint(program, f)
            # Two different functions with one fingerprint: useless, forget it.
            known[print_] = f.symbol if known.get(print_, f.symbol) == f.symbol else None
    return {print_: name for print_, name in known.items() if name}


def recognise(program: Program, known: dict[tuple[int, ...], str]) -> dict[int, str]:
    """Find known library functions in another game: address -> name."""
    prints = {f.start: fingerprint(program, f) for f in program.functions.values()}
    found: dict[str, list[int]] = {}
    for start, print_ in prints.items():
        name = known.get(print_)
        if name:
            found.setdefault(name, []).append(start)
    # A name matching in two places cannot be trusted.
    names = {starts[0]: name for name, starts in found.items() if len(starts) == 1}
    if not names:
        return names

    # Second pass. The library changed a little between versions, so some
    # functions differ by a few instructions. The library sits in one block,
    # so look only between the functions already recognised, and accept the
    # most similar candidate if it is similar enough and clearly the best.
    low, high = min(names), max(names)
    candidates = [s for s in prints if low <= s <= high and s not in names]
    for print_, name in known.items():
        if name in names.values() or len(print_) < 8:
            continue
        scores = sorted(
            (
                (difflib.SequenceMatcher(None, print_, prints[s], autojunk=False).ratio(), s)
                for s in candidates
                if 0.7 < len(prints[s]) / len(print_) < 1.4
            ),
            reverse=True,
        )
        if scores and scores[0][0] >= CLOSE_ENOUGH and (len(scores) == 1 or scores[1][0] < scores[0][0] - 0.1):
            names[scores[0][1]] = name
            candidates.remove(scores[0][1])

    # Third pass: a few functions are recognisable by what they call. The
    # "long" save-data functions, for instance, are just loops around the
    # short ones.
    by_name = {name: start for start, name in names.items()}
    for name, callee in CALLERS_OF.items():
        if name in by_name or callee not in by_name:
            continue
        callers = [s for s in candidates if by_name[callee] in program.functions[s].calls]
        if len(callers) == 1:
            names[callers[0]] = name
            candidates.remove(callers[0])
    return names
