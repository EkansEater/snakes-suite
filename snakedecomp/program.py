"""Putting the whole game together: every segment and every function.

Only the main segment is loaded by the console's boot code. Games load
further code themselves, from wherever they like in the ROM to wherever
they like in memory, and nothing in the header says where. We find it with
two observations:

  * Code is full of "jr $ra" (return) instructions; compressed graphics and
    sound data almost never contain that exact 32-bit value. So a stretch of
    ROM with many returns close together is an "island" of code.

  * Calls use absolute memory addresses. If an island contains "jal X" and
    X is one of its own functions, then (X - that function's ROM offset) is
    the difference between memory addresses and ROM offsets for the whole
    island. We don't know which function each call refers to, so we try
    every pairing and let them vote; the right difference wins by a mile.
"""

import struct
from collections import Counter, defaultdict
from dataclasses import dataclass, field

from .functions import RETURN, Function, FunctionFinder
from .mips import Instruction, disassemble
from .rom import Rom, Segment
from .symbols import Symbols

ISLAND_MAX_GAP = 0x1000  # returns further apart than this are separate islands
ISLAND_MIN_RETURNS = 8
RAM_START = 0x80000000
RAM_END = 0x80800000  # 8 MB, the most memory an N64 can have

# Overlays
# --------
# An N64 has little memory, so many games keep only part of their code
# loaded: the menu's code while in the menu, a level's code while in that
# level. The pieces ("overlays") take turns at the same memory addresses.
# For us that means one address can be the start of two different
# functions, depending on which piece is loaded just then.
#
# Program.functions keeps one function per address, which is all most of
# the tools need. Program.alternatives lists every function for the
# addresses that have more than one, and the recompiler uses it: a call
# from inside an overlay goes to that overlay's own function, and any other
# call to such an address is decided while the game runs, by looking at
# which code is actually in memory (see LOOKUP_FUNCTION in recomp.py).


@dataclass
class Program:
    rom: Rom
    segments: list[Segment]
    functions: dict[int, Function]  # by start address
    unresolved_calls: set[int]  # call targets we found no function for
    symbols: Symbols | None = None
    alternatives: dict[int, list[Function]] = field(default_factory=dict)
    all_functions: list[Function] = field(default_factory=list)

    def segment_for(self, address: int) -> Segment | None:
        for segment in self.segments:
            if segment.contains(address):
                return segment
        return None

    def decode(self, address: int, segment: Segment | None = None) -> Instruction:
        segment = segment or self.segment_for(address)
        if segment is None:
            raise ValueError(f"0x{address:08X} is not in any known segment")
        return disassemble(self.rom.word(segment.to_rom(address)), address)

    def describe(self, address: int, segment: Segment | None = None) -> str:
        """Disassemble one instruction, naming the function it calls if known."""
        ins = self.decode(address, segment)
        target = self.functions.get(ins.target)
        if target is not None and target.symbol:
            return f"{ins}  <{target.symbol}>"
        return str(ins)

    def function_containing(self, address: int) -> Function | None:
        for f in self.functions.values():
            if f.start <= address < f.end:
                return f
        return None


def _find_islands(words: tuple[int, ...], search_from: int) -> list[tuple[int, int, list[int]]]:
    """Find runs of ROM with many returns: (first return, last return, returns)."""
    returns = [i * 4 for i, w in enumerate(words) if w == RETURN and i * 4 >= search_from]
    islands, current = [], returns[:1]
    for offset in returns[1:]:
        if offset - current[-1] > ISLAND_MAX_GAP:
            islands.append(current)
            current = []
        current.append(offset)
    islands.append(current)
    return [(i[0], i[-1], i) for i in islands if len(i) >= ISLAND_MIN_RETURNS]


def _vote_load_offset(words: tuple[int, ...], returns: list[int]) -> int | None:
    """Work out (memory address - ROM offset) for an island of code."""
    first, last = returns[0], returns[-1]
    # Whatever follows a return (and its delay slot, and padding) is probably
    # the start of a function.
    function_starts = []
    for offset in returns[:-1]:
        start = offset + 8
        while words[start // 4] == 0:
            start += 4
        function_starts.append(start)
    call_targets = {
        RAM_START | ((w & 0x03FFFFFF) << 2) for w in words[first // 4 : last // 4] if w >> 26 == 3
    }
    votes = Counter(t - s for t in call_targets for s in function_starts)
    if not votes:
        return None
    load_offset, count = votes.most_common(1)[0]
    # Demand a clear result, and one that puts the code in real memory. (The
    # graphics chip's microcode also looks like MIPS, but lives elsewhere.)
    if count < ISLAND_MIN_RETURNS or not RAM_START <= first + load_offset < RAM_END:
        return None
    return load_offset


def _find_extra_segments(rom: Rom, search_from: int, call_targets: set[int]) -> list[Segment]:
    words = struct.unpack(f">{len(rom.data) // 4}I", rom.data)
    # Neighbouring islands with the same load offset are one segment.
    merged: dict[int, list[int]] = {}
    undecided = []
    for _, _, returns in _find_islands(words, search_from):
        load_offset = _vote_load_offset(words, returns)
        if load_offset is not None:
            merged.setdefault(load_offset, []).extend(returns)
        else:
            undecided.append(returns)
    # An island too small to vote convincingly is often a further piece of a
    # segment we did place, loaded along with it. Test that: with the same
    # load offset, do calls made elsewhere land in this island?
    targets = set(call_targets)
    for returns in merged.values():
        targets |= {
            RAM_START | ((w & 0x03FFFFFF) << 2)
            for w in words[returns[0] // 4 : returns[-1] // 4]
            if w >> 26 == 3
        }
    for returns in undecided:
        landing = Counter()
        for load_offset in merged:
            low, high = returns[0] - ISLAND_MAX_GAP + load_offset, returns[-1] + load_offset
            landing[load_offset] = sum(1 for t in targets if low <= t <= high)
        if landing and landing.most_common(1)[0][1] >= 2:
            load_offset = landing.most_common(1)[0][0]
            merged[load_offset] = sorted(merged[load_offset] + returns)

    segments = []
    for load_offset, returns in merged.items():
        # Functions are found from their returns, so we still need the start
        # of the first one. It is either the nearest "addiu $sp, $sp, -N"
        # (make room on the stack) before the first return, or the lowest
        # nearby address that somebody calls, whichever comes first.
        first, end = returns[0], returns[-1] + 8
        nearby = range(max(search_from, first - ISLAND_MAX_GAP), first, 4)
        candidates = [
            o for o in nearby if words[o // 4] >> 16 == 0x27BD and words[o // 4] & 0x8000
        ][-1:]
        # (Callers can be anywhere: the main segment, or this island itself.)
        own_targets = {
            RAM_START | ((w & 0x03FFFFFF) << 2)
            for w in words[first // 4 : end // 4]
            if w >> 26 == 3
        }
        candidates += [
            t - load_offset for t in call_targets | own_targets if t - load_offset in nearby
        ]
        start = min(candidates, default=first)
        name = f"seg_{start + load_offset:08X}"
        if any(s.name == name for s in segments):  # two overlays loaded at one address
            name += f"_rom{start:X}"
        segments.append(Segment(name, start, start + load_offset, end - start))
    return segments


def analyse(rom: Rom, symbols: Symbols | None = None) -> Program:
    main = rom.main_segment
    functions = FunctionFinder(rom, main, has_entry_stub=True).find()
    main_code_end = main.to_rom(functions[-1].end)
    call_targets = {t for f in functions for t in f.calls}

    segments = [main] + _find_extra_segments(rom, main_code_end, call_targets)
    # Segments call each other, so look again with every call target known.
    # (Except between overlays that share addresses: a call made inside one
    # says nothing about where functions start in the other.)
    def overlap(a: Segment, b: Segment) -> bool:
        return a is not b and a.vram_start < b.vram_end and b.vram_start < a.vram_end

    for _ in range(2):
        found = []
        for segment in segments:
            starts = {t for f in functions if not overlap(f.segment, segment) for t in f.calls}
            finder = FunctionFinder(rom, segment, has_entry_stub=segment is main)
            sweep_to = 0 if segment is main else segment.vram_end - 8
            found += finder.find(starts, sweep_to)
        functions = found

    groups: dict[int, list[Function]] = defaultdict(list)
    for f in functions:
        groups[f.start].append(f)
    by_start = {start: group[0] for start, group in groups.items()}
    alternatives = {start: group for start, group in groups.items() if len(group) > 1}
    for group in alternatives.values():
        for f in group:
            f.variant = "_" + f.segment.name
    unresolved = set()
    for f in functions:
        for target in f.calls:
            if target in by_start:
                by_start[target].callers += 1
            else:
                unresolved.add(target)
    if symbols is not None:
        for f in functions:
            f.symbol = symbols.functions.get(f.start)
    return Program(rom, segments, by_start, unresolved, symbols, alternatives, functions)
