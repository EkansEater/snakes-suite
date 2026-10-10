"""Finding where each function starts and ends.

Machine code has no markers between functions; it is one long run of
instructions. We recover the boundaries from three clues:

  1. "jal X" means "call the function at X", so every jal target is the
     start of a function.
  2. "jr $ra" means "return to whoever called me", so it usually ends one.
  3. Functions are packed back to back, so whatever follows the end of one
     function (after any zero padding) is the start of the next. This finds
     functions that are never called directly, only through pointers.

A function can contain several returns, so a "jr $ra" only counts as the end
if no earlier branch in the same function jumps past it.
"""

from dataclasses import dataclass, field

from .mips import Instruction, disassemble
from .rom import Rom, Segment

RETURN = 0x03E00008  # jr $ra


@dataclass
class Function:
    start: int
    end: int  # address just past the last instruction
    segment: Segment
    calls: set[int] = field(default_factory=set)  # functions this one calls
    # "switch" statements: address of the "jr" -> the addresses it can jump to
    jump_tables: dict[int, list[int]] = field(default_factory=dict)
    callers: int = 0  # how many functions call this one
    symbol: str | None = None  # its real name, if we have a list of names
    # Set when another segment has a function at this same address (see
    # "Overlays" in program.py): something to tell the two apart by.
    variant: str = ""

    @property
    def name(self) -> str:
        return f"func_{self.start:08X}{self.variant}"

    @property
    def label(self) -> str:
        """The best name we have for showing to a person."""
        return self.symbol or self.name

    @property
    def size(self) -> int:
        """Number of instructions."""
        return (self.end - self.start) // 4


class FunctionFinder:
    """Finds the functions in one segment."""

    def __init__(self, rom: Rom, segment: Segment, has_entry_stub: bool = False):
        self.rom = rom
        self.segment = segment
        self.has_entry_stub = has_entry_stub

    def decode(self, address: int) -> Instruction:
        return disassemble(self.rom.word(self.segment.to_rom(address)), address)

    def find(self, known_starts: set[int] = frozenset(), sweep_to: int = 0) -> list[Function]:
        """Find the segment's functions.

        known_starts are addresses already known to begin a function (for
        example, call targets seen in other segments). sweep_to is an address
        up to which we are confident the segment contains code.
        """
        # Only call targets are trusted as function starts. Each sweep can
        # reach more code and so discover more of them, which can split what
        # we thought was one function into two, so repeat until none are new.
        starts = {self.segment.vram_start} | {s for s in known_starts if self.segment.contains(s)}
        while True:
            functions = self._sweep(starts, sweep_to)
            found = set(starts)
            for f in functions:
                found |= {t for t in f.calls if self.segment.contains(t)}
            if found == starts:
                return functions
            starts = found

    def _sweep(self, starts: set[int], sweep_to: int) -> list[Function]:
        """Walk the code from the start, one function after another."""
        functions = []
        address = self.segment.vram_start
        last_known = max(starts | {sweep_to})
        if self.has_entry_stub:
            stub, main = self._walk_entry_stub()
            functions.append(stub)
            address = stub.end
            last_known = max(last_known, main)
        while address <= last_known:
            while self.decode(address).word == 0:
                address += 4  # skip zero padding between functions
            function = self._walk_function(address, starts)
            if function is None:
                # Ran into something that is not code: data in between two
                # blocks of code. Carry on at the next place somebody calls.
                later = [s for s in starts if s > address]
                if not later:
                    break
                address = min(later)
                continue
            functions.append(function)
            last_known = max([last_known, *filter(self.segment.contains, function.calls)])
            address = function.end
        return functions

    def _walk_entry_stub(self) -> tuple[Function, int]:
        """Walk the hand-written startup code; return it and where it jumps.

        The stub does not return. It ends with "jr <register>", jumping to
        the game's main function. MIPS cannot load a 32-bit address in one
        instruction, so the address is built in two halves: "lui" sets the
        top 16 bits and "addiu"/"ori" fills in the bottom 16. We follow those
        to learn what is in the register at the jump.
        """
        registers: dict[int, int] = {}
        start = address = self.segment.vram_start
        # Some games do more here first (clear memory, set up the CPU), and
        # some end with a plain "jal main" or "j main" instead.
        for _ in range(512):
            word = self.decode(address).word
            opcode, rs, rt, imm = word >> 26, (word >> 21) & 0x1F, (word >> 16) & 0x1F, word & 0xFFFF
            if opcode == 15:  # lui
                registers[rt] = imm << 16
            elif opcode in (8, 9) and rs in registers:  # addi, addiu (signed)
                signed = imm - 0x10000 if imm & 0x8000 else imm
                registers[rt] = (registers[rs] + signed) & 0xFFFFFFFF
            elif opcode == 13 and rs in registers:  # ori
                registers[rt] = registers[rs] | imm
            elif opcode in (8, 9, 13):
                registers.pop(rt, None)
            elif opcode == 0 and word & 0x3F == 8 and rs in registers:  # jr
                main = registers[rs]
                return Function(start, address + 8, self.segment, calls={main}), main
            elif opcode in (2, 3):  # j, jal
                main = (address & 0xF0000000) | (word & 0x03FFFFFF) << 2
                return Function(start, address + 8, self.segment, calls={main}), main
            address += 4
        raise ValueError("could not follow this game's start-up code")

    def _read_jump_table(self, jr_address: int) -> list[int] | None:
        """Read the list of destinations for a "switch" statement.

        A switch compiles to a table of addresses stored with the game's
        constants, plus code that picks one by index and jumps to it:

            sltiu $at, $t3, 5          is the index below 5 (the case count)?
            beq   $at, $zero, default
            sll   $t3, $t3, 2          index * 4 (each address is 4 bytes)
            lui   $at, 0x8033          $at = address of the table...
            addu  $at, $at, $t3        ...plus the offset of our entry
            lw    $t3, 0x5B60($at)     load the destination
            jr    $t3                  jump to it
        """
        table = count = None
        for back in range(1, 16):
            word = self.decode(jr_address - back * 4).word
            opcode, rt, imm = word >> 26, (word >> 16) & 0x1F, word & 0xFFFF
            signed = imm - 0x10000 if imm & 0x8000 else imm
            if opcode == 35 and table is None:  # lw: low half of the table address
                table = signed
            elif opcode == 15 and rt == 1 and table is not None and table < 0x10000:  # lui $at
                table = ((imm << 16) + table) & 0xFFFFFFFF
            elif opcode == 11 and rt == 1:  # sltiu $at: the number of cases
                count = imm
                break
        if count is None or table is None:
            return None
        # The table sits in the segment's data, which comes after its code.
        offset = self.segment.to_rom(table)
        if table < self.segment.vram_start or offset + count * 4 > len(self.rom.data):
            return None
        targets = [self.rom.word(offset + i * 4) for i in range(count)]
        if not all(self.segment.contains(t) and t % 4 == 0 for t in targets):
            return None  # not a table of code addresses after all
        return targets

    def _walk_function(self, start: int, starts: set[int]) -> Function | None:
        calls = set()
        jump_tables = {}
        furthest_branch = start  # the latest address this function jumps to
        has_frame = False  # does it reserve stack space ("addiu $sp, $sp, -N")?
        address = start
        while self.segment.contains(address):
            ins = self.decode(address)
            if ins.mnemonic == ".word":
                return None
            if ins.word >> 16 == 0x27BD and ins.word & 0x8000:
                has_frame = True
            if ins.mnemonic == "jal":
                calls.add(ins.target)
            elif ins.target is not None and ins.mnemonic != "j":
                furthest_branch = max(furthest_branch, ins.target)
            elif ins.mnemonic == "jr" and ins.word != RETURN:
                targets = self._read_jump_table(address)
                if targets:
                    jump_tables[address] = targets
                    furthest_branch = max(furthest_branch, *targets)

            if ins.word == RETURN and address >= furthest_branch:
                # +8 rather than +4: the instruction after a jump (its "delay
                # slot") still runs, so it belongs to this function.
                end = address + 8
                # Compiler quirk: without optimisation, the N64's compiler
                # ends a function that has no stack frame with extra
                # "jr $ra; nop" pairs that can never run: one, or two if the
                # real return carries a value in its delay slot. They are
                # leftovers of this function, not new functions. (Checked
                # against the names in a real linker map.)
                extra = 0 if has_frame else 1 if self.decode(address + 4).word == 0 else 2
                while (
                    extra
                    and end not in starts
                    and self.decode(end).word == RETURN
                    and self.decode(end + 4).word == 0
                ):
                    end += 8
                    extra -= 1
                return Function(start, end, self.segment, calls, jump_tables)
            if address + 4 in starts:
                return Function(start, address + 4, self.segment, calls, jump_tables)
            address += 4
        return None
