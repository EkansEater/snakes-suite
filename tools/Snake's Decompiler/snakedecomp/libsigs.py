"""Recognising library functions with a ready-made signature list.

signatures.py learns fingerprints from one game we have names for. That
only knows the version of Nintendo's library that game was built with, and
the library changed many times over the console's life.

This file reads a much larger list, made by the n64sym project from the
library files of many SDK releases (data/n64sym.sig.gz; MIT licence, see
data/n64sym-LICENSE.md). Like ours it holds no code, only checksums.

One entry looks like this:

    osViGetCurrentFramebuffer 0x0038 0xEA83D997 0x58B55088
     .targ26 __osDisableInt 0x008
     .hi16   __osViCurr 0x010
     .lo16   __osViCurr 0x014

"A function 0x38 bytes long; the checksum of its first 8 bytes; the
checksum of all of it." The indented lines are relocations: places inside
the function that hold an address, which is different in every game. Those
bits are blanked out before the checksum is taken:

    .targ26   a call ("jal"): the low 26 bits are the function called
    .hi16     the top half of an address (a "lui")
    .lo16     the bottom half

The relocations are a gift twice over. When a function matches, each one
also tells us the name of whatever sits at the address we blanked out: the
functions it calls, and the variables it uses.
"""

import gzip
import os
import struct
import zlib
from collections import Counter, defaultdict
from dataclasses import dataclass

from .program import Program

DATABASE = os.path.join(os.path.dirname(__file__), "data", "n64sym.sig.gz")

MASKS = {".targ26": 0xFC000000, ".hi16": 0xFFFF0000, ".lo16": 0xFFFF0000}
# Functions shorter than this (in bytes) are too alike to trust on their own;
# they are only accepted when a bigger function says "I call that one".
SMALLEST_TRUSTED = 0x28

LIBRARY_GAP = 0x4000  # matches further apart than this are not in the same block

# Pairs of functions that are instruction for instruction the same and
# differ only in which variable they read. The signature list can only keep
# one name for them. The variables sit next to each other in memory, in a
# known order, which tells the two apart: first name = lower address.
TWINS = {"osViGetCurrentFramebuffer": "osViGetNextFramebuffer"}

# Some functions have two names in the library. We use the plain one.
ALIASES = {"_bzero": "bzero", "_bcopy": "bcopy", "_bcmp": "bcmp", "__cosf": "cosf", "__sinf": "sinf",
           "_memcpy": "memcpy", "_nsqrtf": "sqrtf"}  # fmt: skip


@dataclass(frozen=True)
class Signature:
    name: str
    size: int
    first: int  # checksum of the first 8 bytes
    whole: int  # checksum of everything
    relocations: tuple[tuple[int, str, str], ...]  # (offset, kind, name), in order


def load_signatures(path: str = DATABASE) -> list[Signature]:
    signatures = []
    if not os.path.exists(path):
        return signatures
    name, numbers, relocations = None, (), []

    def finish():
        if name is not None:
            signatures.append(Signature(name, *numbers, tuple(sorted(relocations))))

    with gzip.open(path, "rt") as lines:
        for line in lines:
            parts = line.split()
            if not parts or parts[0].startswith("#"):
                continue
            if line[0] == " ":  # a relocation of the entry we are in
                target = ALIASES.get(parts[1], parts[1])
                relocations += [(int(offset, 16), parts[0], target) for offset in parts[2:]]
            else:
                finish()
                name = ALIASES.get(parts[0], parts[0])
                numbers, relocations = tuple(int(p, 16) for p in parts[1:4]), []
    finish()
    return signatures


def _is_local(name: str) -> bool:
    """Names n64sym made up for unnamed places inside one source file."""
    return any(part in name for part in ("_text_", "_rodata_", "_data_", "_bss_", "_sdata_", "_sbss_"))


class Matcher:
    def __init__(self, program: Program, signatures: list[Signature]):
        self.program = program
        self.by_first: dict[int, list[Signature]] = defaultdict(list)
        for signature in signatures:
            if signature.size >= 12:
                self.by_first[signature.first].append(signature)

    def _candidates(self) -> dict[int, list[Signature]]:
        """Every place in the code where some signature fits: address -> signatures."""
        found: dict[int, list[Signature]] = defaultdict(list)
        crc32, by_first = zlib.crc32, self.by_first
        functions = sorted(self.program.functions.values(), key=lambda f: f.start)
        for segment in self.program.segments:
            mine = [f for f in functions if f.segment is segment]
            if not mine:
                continue
            # Only the part of the segment that holds code.
            start, end = segment.to_rom(mine[0].start), segment.to_rom(mine[-1].end)
            data = self.program.rom.data[start:end]
            words = struct.unpack(f">{len(data) // 4}I", data)
            for i in range(len(words) - 1):
                # The first 8 bytes may themselves contain relocations, and
                # we do not know yet which signature we are looking at, so
                # try each way of blanking the two words.
                tried = set()
                for a in _blankings(words[i]):
                    for b in _blankings(words[i + 1]):
                        first = crc32(struct.pack(">II", a, b))
                        if first in tried or first not in by_first:
                            continue
                        tried.add(first)
                        for signature in by_first[first]:
                            if i * 4 + signature.size <= len(data) and _fits(data, i * 4, signature):
                                found[segment.to_vram(start + i * 4)].append(signature)
        return found

    def _implied(self, address: int, signature: Signature) -> dict[str, int]:
        """What a match tells us about its surroundings: name -> address."""
        segment = self.program.segment_for(address)
        halves: dict[str, list[int | None]] = defaultdict(lambda: [None, None])
        implied = {}
        for offset, kind, name in signature.relocations:
            word = self.program.rom.word(segment.to_rom(address + offset))
            if kind == ".targ26":
                implied[name] = 0x80000000 | (word & 0x03FFFFFF) << 2
            elif kind == ".hi16" and halves[name][0] is None:
                halves[name][0] = (word & 0xFFFF) << 16
            elif kind == ".lo16" and halves[name][1] is None:
                low = word & 0xFFFF
                halves[name][1] = low - 0x10000 if low & 0x8000 else low
        for name, (high, low) in halves.items():
            if high is not None and low is not None:
                implied[name] = (high + low) & 0xFFFFFFFF
        return implied

    def _contradicts(self, address: int, signature: Signature, accepted: dict[int, Signature]) -> bool:
        for offset, kind, name in signature.relocations:
            if kind == ".targ26" and not _is_local(name):
                word = self.program.rom.word(self.program.segment_for(address).to_rom(address + offset))
                called = accepted.get(0x80000000 | (word & 0x03FFFFFF) << 2)
                if called is not None and called.name != name:
                    return True
        return False

    def match(self) -> tuple[dict[int, str], dict[str, int]]:
        """Returns (function address -> name, every name -> address)."""
        candidates = self._candidates()
        places: dict[str, set[int]] = defaultdict(set)  # name -> where it fits
        for address, signatures in candidates.items():
            for signature in signatures:
                places[signature.name].add(address)

        # First the sure ones: big enough, fits in one place only, and
        # nothing else fits there.
        accepted: dict[int, Signature] = {}
        for address, signatures in candidates.items():
            names = {s.name for s in signatures}
            signature = signatures[0]
            if len(names) == 1 and len(places[signature.name]) == 1 and signature.size >= SMALLEST_TRUSTED:
                accepted[address] = signature

        # The library is linked into the game as a block. A lone match far
        # from any other is the game's own code that happens to look alike.
        ordered = sorted(accepted)
        groups: list[list[int]] = []
        for address in ordered:
            if groups and address - groups[-1][-1] <= LIBRARY_GAP:
                groups[-1].append(address)
            else:
                groups.append([address])
        for group in groups:
            if len(group) < 4:
                for address in group:
                    del accepted[address]

        # Some library functions do nothing but call another one. With the
        # call blanked out they all look the same, so the list may know
        # them under the wrong name. The function they call gives it away:
        # if that one is accepted under a different name, drop the caller.
        for address in [a for a, s in accepted.items() if self._contradicts(a, s, accepted)]:
            del accepted[address]

        # Then let the accepted ones vouch for the rest, and repeat, since
        # each newly accepted function vouches for others in turn.
        names: dict[int, str] = {}
        addresses: dict[str, int] = {}
        while True:
            votes: dict[str, Counter] = defaultdict(Counter)
            for address, signature in accepted.items():
                for name, where in self._implied(address, signature).items():
                    if not _is_local(name):
                        votes[name][where] += 1
            addresses = {name: tally.most_common(1)[0][0] for name, tally in votes.items()}
            added = False
            for address, signatures in candidates.items():
                if address in accepted:
                    continue
                for signature in signatures:
                    if addresses.get(signature.name) == address and not self._contradicts(
                        address, signature, accepted
                    ):
                        accepted[address] = signature
                        added = True
                        break
            if not added:
                break

        taken = set()
        for address, signature in accepted.items():
            names[address] = signature.name
            taken.add(signature.name)
        # Functions nobody matched, but which an accepted function calls by name.
        for name, where in addresses.items():
            if where in self.program.functions and where not in names and name not in taken:
                names[where] = name
                taken.add(name)
        # What is left fits somewhere but nothing vouches for it. Take it if
        # it is a reasonable size, there is no doubt about name or place,
        # and it sits among the library functions we are sure of (the
        # library is one block; a lookalike elsewhere is the game's own).
        low, high = min(accepted, default=0), max(accepted, default=0)
        for address, signatures in candidates.items():
            options = {s.name for s in signatures} - taken
            if address in names or len(options) != 1 or not low <= address <= high:
                continue
            signature = next(s for s in signatures if s.name in options)
            if self._contradicts(address, signature, accepted):
                continue
            if len(places[signature.name]) == 1 and signature.size >= 0x18:
                names[address] = signature.name
                taken.add(signature.name)

        self._separate_twins(candidates, names, addresses)
        for address, name in names.items():
            addresses[name] = address
        return names, addresses

    def _separate_twins(self, candidates, names: dict[int, str], addresses: dict[str, int]) -> None:
        for first, second in TWINS.items():
            fits = sorted(
                (min(self._implied(a, s).values(), default=0), a)
                for a, signatures in candidates.items()
                for s in signatures
                if s.name in (first, second)
            )
            # (Two places, each reading a different variable.)
            fits = sorted({a: variable for variable, a in fits}.items(), key=lambda item: item[1])
            if len(fits) == 2 and fits[0][1] != fits[1][1]:
                names[fits[0][0]], names[fits[1][0]] = first, second


def _blankings(word: int) -> tuple[int, ...]:
    if word >> 26 in (2, 3):  # j, jal
        return (word, word & 0xFC000000)
    return (word, word & 0xFFFF0000)


def _fits(data: bytes, offset: int, signature: Signature) -> bool:
    piece = bytearray(data[offset : offset + signature.size])
    for where, kind, _ in signature.relocations:
        if where + 4 <= len(piece):
            mask = MASKS[kind]
            piece[where] &= mask >> 24
            piece[where + 1] &= (mask >> 16) & 0xFF
            piece[where + 2] = piece[where + 3] = 0
    return zlib.crc32(bytes(piece)) == signature.whole


def recognise_library(program: Program) -> tuple[dict[int, str], dict[str, int]]:
    """Find library functions in a game: (address -> name, name -> address)."""
    return Matcher(program, load_signatures()).match()
