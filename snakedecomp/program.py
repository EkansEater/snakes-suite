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
from collections import Counter
from dataclasses import dataclass

from .functions import RETURN, Function, FunctionFinder
from .mips import Instruction, disassemble
from .rom import Rom, Segment
from .symbols import Symbols

ISLAND_MAX_GAP = 0x1000  # returns further apart than this are separate islands
ISLAND_MIN_RETURNS = 8
RAM_START = 0x80000000
RAM_END = 0x80800000  # 8 MB, the most memory an N64 can have


@dataclass
class Program:
    rom: Rom
    segments: list[Segment]
    functions: dict[int, Function]  # by start address
    unresolved_calls: set[int]  # call targets we found no function for
    symbols: Symbols | None = None

    def segment_for(self, address: int) -> Segment | None:
        for segment in self.segments:
            if segment.contains(address):
                return segment
        return None

    def decode(self, address: int) -> Instruction:
        segment = self.segment_for(address)
        if segment is None:
            raise ValueError(f"0x{address:08X} is not in any known segment")
        return disassemble(self.rom.word(segment.to_rom(address)), address)

    def describe(self, address: int) -> str:
        """Disassemble one instruction, naming the function it calls if known."""
        ins = self.decode(address)
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
    for _, _, returns in _find_islands(words, search_from):
        load_offset = _vote_load_offset(words, returns)
        if load_offset is not None:
            merged.setdefault(load_offset, []).extend(returns)

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
        segments.append(Segment(name, start, start + load_offset, end - start))
    return segments


def analyse(rom: Rom, symbols: Symbols | None = None) -> Program:
    main = rom.main_segment
    functions = FunctionFinder(rom, main, has_entry_stub=True).find()
    main_code_end = main.to_rom(functions[-1].end)
    call_targets = {t for f in functions for t in f.calls}

    segments = [main] + _find_extra_segments(rom, main_code_end, call_targets)
    # Segments call each other, so look again with every call target known.
    for _ in range(2):
        functions = []
        for segment in segments:
            finder = FunctionFinder(rom, segment, has_entry_stub=segment is main)
            sweep_to = 0 if segment is main else segment.vram_end - 8
            functions += finder.find(call_targets, sweep_to)
        call_targets = {t for f in functions for t in f.calls}

    by_start = {f.start: f for f in functions}
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
    return Program(rom, segments, by_start, unresolved, symbols)
