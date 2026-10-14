"""Disassembler for the N64's CPU, the NEC VR4300 (MIPS III).

Every MIPS instruction is exactly 32 bits. The top 6 bits (the "opcode")
say what kind of instruction it is, and the rest are split into fields in
one of three layouts:

    R-type:  opcode(6) rs(5) rt(5) rd(5) shamt(5) funct(6)   register maths
    I-type:  opcode(6) rs(5) rt(5) immediate(16)             constants, memory, branches
    J-type:  opcode(6) target(26)                            jumps and calls

rs, rt and rd are register numbers (0-31). Disassembling is just pulling
those fields out and printing them with the right name.
"""

from dataclasses import dataclass

# Conventional names for the 32 general-purpose registers.
GPR = [
    "zero", "at", "v0", "v1", "a0", "a1", "a2", "a3",
    "t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7",
    "s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7",
    "t8", "t9", "k0", "k1", "gp", "sp", "fp", "ra",
]  # fmt: skip

# Coprocessor 0 registers: system control (interrupts, TLB, timers).
COP0 = [
    "Index", "Random", "EntryLo0", "EntryLo1", "Context", "PageMask", "Wired", "7",
    "BadVAddr", "Count", "EntryHi", "Compare", "Status", "Cause", "EPC", "PRId",
    "Config", "LLAddr", "WatchLo", "WatchHi", "XContext", "21", "22", "23",
    "24", "25", "PErr", "CacheErr", "TagLo", "TagHi", "ErrorEPC", "31",
]  # fmt: skip

# opcode -> mnemonic, grouped by how the operands are laid out.
ARITH_IMM = {8: "addi", 9: "addiu", 10: "slti", 11: "sltiu", 24: "daddi", 25: "daddiu"}
LOGIC_IMM = {12: "andi", 13: "ori", 14: "xori"}
BRANCH_RS_RT = {4: "beq", 5: "bne", 20: "beql", 21: "bnel"}
BRANCH_RS = {6: "blez", 7: "bgtz", 22: "blezl", 23: "bgtzl"}
LOAD_STORE = {
    26: "ldl", 27: "ldr", 32: "lb", 33: "lh", 34: "lwl", 35: "lw", 36: "lbu",
    37: "lhu", 38: "lwr", 39: "lwu", 40: "sb", 41: "sh", 42: "swl", 43: "sw",
    44: "sdl", 45: "sdr", 46: "swr", 48: "ll", 52: "lld", 55: "ld", 56: "sc",
    60: "scd", 63: "sd",
}  # fmt: skip
LOAD_STORE_FPU = {49: "lwc1", 53: "ldc1", 57: "swc1", 61: "sdc1"}

# When opcode is 0 ("SPECIAL"), the bottom 6 bits (funct) pick the instruction.
SPECIAL_RD_RS_RT = {
    32: "add", 33: "addu", 34: "sub", 35: "subu", 36: "and", 37: "or", 38: "xor",
    39: "nor", 42: "slt", 43: "sltu", 44: "dadd", 45: "daddu", 46: "dsub", 47: "dsubu",
}  # fmt: skip
SPECIAL_SHIFT = {
    0: "sll", 2: "srl", 3: "sra", 56: "dsll", 58: "dsrl", 59: "dsra",
    60: "dsll32", 62: "dsrl32", 63: "dsra32",
}  # fmt: skip
SPECIAL_SHIFT_VAR = {4: "sllv", 6: "srlv", 7: "srav", 20: "dsllv", 22: "dsrlv", 23: "dsrav"}
SPECIAL_MULDIV = {
    24: "mult", 25: "multu", 26: "div", 27: "divu",
    28: "dmult", 29: "dmultu", 30: "ddiv", 31: "ddivu",
}  # fmt: skip
SPECIAL_HILO_READ = {16: "mfhi", 18: "mflo"}
SPECIAL_HILO_WRITE = {17: "mthi", 19: "mtlo"}
SPECIAL_TRAP = {48: "tge", 49: "tgeu", 50: "tlt", 51: "tltu", 52: "teq", 54: "tne"}

# When opcode is 1 ("REGIMM"), the rt field picks the instruction.
REGIMM = {
    0: "bltz", 1: "bgez", 2: "bltzl", 3: "bgezl",
    16: "bltzal", 17: "bgezal", 18: "bltzall", 19: "bgezall",
}  # fmt: skip

COP0_MOVE = {0: "mfc0", 1: "dmfc0", 4: "mtc0", 5: "dmtc0"}
COP0_FUNCT = {1: "tlbr", 2: "tlbwi", 6: "tlbwr", 8: "tlbp", 24: "eret"}

# Coprocessor 1 is the floating-point unit.
COP1_MOVE = {0: "mfc1", 1: "dmfc1", 2: "cfc1", 4: "mtc1", 5: "dmtc1", 6: "ctc1"}
COP1_BRANCH = {0: "bc1f", 1: "bc1t", 2: "bc1fl", 3: "bc1tl"}
COP1_FORMAT = {16: "s", 17: "d", 20: "w", 21: "l"}  # single, double, int32, int64
COP1_THREE_REG = {0: "add", 1: "sub", 2: "mul", 3: "div"}
COP1_TWO_REG = {
    4: "sqrt", 5: "abs", 6: "mov", 7: "neg", 8: "round.l", 9: "trunc.l",
    10: "ceil.l", 11: "floor.l", 12: "round.w", 13: "trunc.w", 14: "ceil.w",
    15: "floor.w", 32: "cvt.s", 33: "cvt.d", 36: "cvt.w", 37: "cvt.l",
}  # fmt: skip
COP1_COMPARE = [
    "f", "un", "eq", "ueq", "olt", "ult", "ole", "ule",
    "sf", "ngle", "seq", "ngl", "lt", "nge", "le", "ngt",
]  # fmt: skip


@dataclass
class Instruction:
    address: int
    word: int
    mnemonic: str
    operands: str = ""
    target: int | None = None  # where a branch, jump or call goes, if known

    def __str__(self) -> str:
        return f"{self.mnemonic:<8}{self.operands}".rstrip()


def _signed16(value: int) -> int:
    """Interpret a 16-bit field as a signed number (-32768..32767)."""
    return value - 0x10000 if value & 0x8000 else value


def _hex(value: int) -> str:
    return f"-0x{-value:X}" if value < 0 else f"0x{value:X}"


def disassemble(word: int, address: int) -> Instruction:
    """Decode one 32-bit instruction located at the given memory address."""
    opcode = word >> 26
    rs = (word >> 21) & 0x1F
    rt = (word >> 16) & 0x1F
    rd = (word >> 11) & 0x1F
    shamt = (word >> 6) & 0x1F
    funct = word & 0x3F
    imm = word & 0xFFFF
    simm = _signed16(imm)
    # Branches are relative to the *next* instruction, counted in instructions.
    branch_target = (address + 4 + simm * 4) & 0xFFFFFFFF

    def make(mnemonic: str, operands: str = "", target: int | None = None) -> Instruction:
        return Instruction(address, word, mnemonic, operands, target)

    def unknown() -> Instruction:
        return make(".word", f"0x{word:08X}")

    if word == 0:
        return make("nop")  # really "sll zero, zero, 0", which does nothing

    if opcode == 0:  # SPECIAL
        if funct in SPECIAL_RD_RS_RT:
            return make(SPECIAL_RD_RS_RT[funct], f"${GPR[rd]}, ${GPR[rs]}, ${GPR[rt]}")
        if funct in SPECIAL_SHIFT:
            return make(SPECIAL_SHIFT[funct], f"${GPR[rd]}, ${GPR[rt]}, {shamt}")
        if funct in SPECIAL_SHIFT_VAR:
            return make(SPECIAL_SHIFT_VAR[funct], f"${GPR[rd]}, ${GPR[rt]}, ${GPR[rs]}")
        if funct in SPECIAL_MULDIV:
            return make(SPECIAL_MULDIV[funct], f"${GPR[rs]}, ${GPR[rt]}")
        if funct in SPECIAL_HILO_READ:
            return make(SPECIAL_HILO_READ[funct], f"${GPR[rd]}")
        if funct in SPECIAL_HILO_WRITE:
            return make(SPECIAL_HILO_WRITE[funct], f"${GPR[rs]}")
        if funct in SPECIAL_TRAP:
            return make(SPECIAL_TRAP[funct], f"${GPR[rs]}, ${GPR[rt]}")
        if funct == 8:
            return make("jr", f"${GPR[rs]}")
        if funct == 9:
            return make("jalr", f"${GPR[rd]}, ${GPR[rs]}")
        if funct == 12:
            return make("syscall")
        if funct == 13:
            return make("break", _hex((word >> 16) & 0x3FF))
        if funct == 15:
            return make("sync")
        return unknown()

    if opcode == 1:  # REGIMM
        if rt in REGIMM:
            return make(REGIMM[rt], f"${GPR[rs]}, 0x{branch_target:08X}", branch_target)
        return unknown()

    if opcode in (2, 3):  # j / jal: target replaces the low 28 bits of the address
        target = (address & 0xF0000000) | ((word & 0x03FFFFFF) << 2)
        return make("j" if opcode == 2 else "jal", f"0x{target:08X}", target)

    if opcode in BRANCH_RS_RT:
        return make(
            BRANCH_RS_RT[opcode], f"${GPR[rs]}, ${GPR[rt]}, 0x{branch_target:08X}", branch_target
        )
    if opcode in BRANCH_RS:
        return make(BRANCH_RS[opcode], f"${GPR[rs]}, 0x{branch_target:08X}", branch_target)
    if opcode in ARITH_IMM:
        return make(ARITH_IMM[opcode], f"${GPR[rt]}, ${GPR[rs]}, {_hex(simm)}")
    if opcode in LOGIC_IMM:
        return make(LOGIC_IMM[opcode], f"${GPR[rt]}, ${GPR[rs]}, {_hex(imm)}")
    if opcode == 15:
        return make("lui", f"${GPR[rt]}, {_hex(imm)}")
    if opcode in LOAD_STORE:
        return make(LOAD_STORE[opcode], f"${GPR[rt]}, {_hex(simm)}(${GPR[rs]})")
    if opcode in LOAD_STORE_FPU:
        return make(LOAD_STORE_FPU[opcode], f"$f{rt}, {_hex(simm)}(${GPR[rs]})")
    if opcode == 47:
        return make("cache", f"{_hex(rt)}, {_hex(simm)}(${GPR[rs]})")

    if opcode == 16:  # COP0
        if rs in COP0_MOVE:
            return make(COP0_MOVE[rs], f"${GPR[rt]}, {COP0[rd]}")
        if rs == 16 and funct in COP0_FUNCT:
            return make(COP0_FUNCT[funct])
        return unknown()

    if opcode == 17:  # COP1: here the fields are named fmt, ft, fs, fd
        ft, fs, fd = rt, rd, shamt
        if rs in COP1_MOVE:
            return make(COP1_MOVE[rs], f"${GPR[rt]}, $f{fs}")
        if rs == 8 and rt in COP1_BRANCH:
            return make(COP1_BRANCH[rt], f"0x{branch_target:08X}", branch_target)
        if rs in COP1_FORMAT:
            fmt = COP1_FORMAT[rs]
            if funct in COP1_THREE_REG:
                return make(f"{COP1_THREE_REG[funct]}.{fmt}", f"$f{fd}, $f{fs}, $f{ft}")
            if funct in COP1_TWO_REG:
                return make(f"{COP1_TWO_REG[funct]}.{fmt}", f"$f{fd}, $f{fs}")
            if funct >= 48:
                return make(f"c.{COP1_COMPARE[funct - 48]}.{fmt}", f"$f{fs}, $f{ft}")
        return unknown()

    return unknown()
