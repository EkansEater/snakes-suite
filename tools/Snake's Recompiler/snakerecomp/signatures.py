"""Recognising library functions in a game we have no names for.

Every N64 game contains a copy of Nintendo's OS library, compiled from the
same source. So the function osRecvMesg in one game is, instruction for
instruction, nearly the same as osRecvMesg in another. "Nearly" because
each game places its code and variables at different addresses, and those
addresses are written into the instructions.

A function's fingerprint is therefore its instructions with every embedded
address blanked out. If we know the names in one game (from a linker map),
we can find the same fingerprints in another game and carry the names over.

What we keep on file is not the instructions themselves, which are
Nintendo's, but one-way hashes of them: a number computed from the
instructions that identifies them without letting anyone get them back.
Each function is stored as one hash of the whole thing, for exact matches,
plus hashes of every run of three instructions, for near matches (two
versions of a function share most of their three-instruction runs).
"""

import hashlib
import json
import os

from .functions import Function
from .program import Program

MIN_INSTRUCTIONS = 3  # shorter functions look too alike to tell apart
CLOSE_ENOUGH = 0.4  # share of three-instruction runs in common, for the looser pass
DATABASE = os.path.join(os.path.dirname(__file__), "data", "libultra.json")

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


def _hash(words: tuple[int, ...]) -> str:
    return hashlib.blake2b(b"".join(w.to_bytes(4, "big") for w in words), digest_size=6).hexdigest()


def _runs(print_: tuple[int, ...]) -> set[str]:
    """Hashes of every run of three consecutive instructions."""
    return {_hash(print_[i : i + 3]) for i in range(len(print_) - 2)}


def learn(program: Program) -> list[dict]:
    """Describe the named library functions in a game, as hashes."""
    seen: dict[str, dict | None] = {}
    for f in program.functions.values():
        if f.symbol and f.size >= MIN_INSTRUCTIONS and program.symbols.is_library(f.start):
            print_ = fingerprint(program, f)
            whole = _hash(print_)
            # Two different functions with one fingerprint: useless, forget it.
            if whole in seen and (seen[whole] is None or seen[whole]["name"] != f.symbol):
                seen[whole] = None
            else:
                seen[whole] = {"name": f.symbol, "length": len(print_), "whole": whole,
                               "runs": sorted(_runs(print_))}  # fmt: skip
    return sorted((e for e in seen.values() if e), key=lambda e: e["name"])


def save_database(entries: list[dict], path: str = DATABASE) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as out:
        json.dump(entries, out, separators=(",", ":"))


def load_database(path: str = DATABASE) -> list[dict]:
    if not os.path.exists(path):
        return []
    with open(path) as source:
        return json.load(source)


def recognise(program: Program, known: list[dict]) -> dict[int, str]:
    """Find known library functions in a game: address -> name."""
    prints = {f.start: fingerprint(program, f) for f in program.functions.values()}
    by_whole = {e["whole"]: e["name"] for e in known}
    found: dict[str, list[int]] = {}
    for start, print_ in prints.items():
        name = by_whole.get(_hash(print_))
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
    candidates = {s: _runs(prints[s]) for s in prints if low <= s <= high and s not in names}
    for entry in known:
        if entry["name"] in names.values() or entry["length"] < 8:
            continue
        runs = set(entry["runs"])
        scores = sorted(
            (
                (len(runs & other) / len(runs | other), s)
                for s, other in candidates.items()
                if other and 0.7 < len(prints[s]) / entry["length"] < 1.4
            ),
            reverse=True,
        )
        if scores and scores[0][0] >= CLOSE_ENOUGH and (len(scores) == 1 or scores[1][0] < scores[0][0] / 2):
            names[scores[0][1]] = entry["name"]
            del candidates[scores[0][1]]

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
            del candidates[callers[0]]
    return names
