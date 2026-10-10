"""An interpreter for the N64's CPU: the heart of an emulator.

Where the recompiler translates the whole game to C ahead of time, an
interpreter does the work at run time, one instruction at a time:

    fetch the instruction the program counter points at
    decode it
    do what it says
    repeat

It is far slower, but simple, and it is written independently of the
recompiler, so the two can be checked against each other.

Registers are kept as unsigned 64-bit Python integers.
"""

import bisect
import math
import struct

MASK32 = 0xFFFFFFFF
MASK64 = 0xFFFFFFFFFFFFFFFF
RAM_SIZE = 0x800000

FCR31_CONDITION = 0x00800000
FCR31_INVALID = 0x00010040


class Trap(Exception):
    """The program did something the CPU cannot carry on from."""


def s32(value: int) -> int:
    """Sign-extend the low 32 bits to 64 (kept as an unsigned number)."""
    value &= MASK32
    return value | 0xFFFFFFFF00000000 if value & 0x80000000 else value


def signed(value: int, bits: int = 64) -> int:
    """Read an unsigned number as a signed one."""
    return value - (1 << bits) if value >> (bits - 1) else value


def bits_to_float(bits: int) -> float:
    return struct.unpack(">f", struct.pack(">I", bits))[0]


def float_to_bits(value: float) -> int:
    try:
        return struct.unpack(">I", struct.pack(">f", value))[0]
    except OverflowError:  # too big for single precision: becomes infinity
        return 0x7F800000 if value > 0 else 0xFF800000


def bits_to_double(bits: int) -> float:
    return struct.unpack(">d", struct.pack(">Q", bits))[0]


def double_to_bits(value: float) -> int:
    return struct.unpack(">Q", struct.pack(">d", value))[0]


def float_divide(a: float, b: float) -> float:
    """Division the way hardware does it: dividing by zero gives infinity."""
    if b != 0:
        return a / b
    if a == 0 or math.isnan(a):
        return math.nan
    return math.copysign(math.inf, a) * math.copysign(1.0, b)


def float_sqrt(a: float) -> float:
    return math.sqrt(a) if a >= 0 else (a if a == 0 else math.nan)


class Cpu:
    def __init__(self, ram: bytes, function_starts: set[int] = frozenset()):
        self.base = ram  # memory as it was at the start; never modified
        self.writes: dict[int, int] = {}  # every byte changed since: address -> value
        self.r = [0] * 32  # general-purpose registers
        self.hi = self.lo = 0
        self.fw = [0] * 32  # floating-point registers, as raw 32-bit patterns
        self.fcr31 = 0
        self.pc = 0
        # The instruction after a jump still runs before the jump happens, so
        # a jump only records where to go; the main loop applies it one
        # instruction later.
        self.next_pc = 4
        self.steps = 0
        self.bad_jump, self.bad_jump_target = False, 0
        self.function_starts = sorted(function_starts)
        self.function_set = set(function_starts)

    # ---- memory -----------------------------------------------------------

    def _physical(self, address: int, size: int) -> int:
        address &= MASK32
        physical = address & 0x1FFFFFFF
        if address >> 30 != 2 or physical > RAM_SIZE - size:
            raise Trap(f"bad memory access at 0x{address:08X}")
        return physical

    def read(self, address: int, size: int) -> int:
        """Read a big-endian value of 1, 2, 4 or 8 bytes."""
        physical = self._physical(address, size)
        value = 0
        for i in range(physical, physical + size):
            byte = self.writes.get(i)
            value = value << 8 | (self.base[i] if byte is None else byte)
        return value

    def write(self, address: int, size: int, value: int) -> None:
        physical = self._physical(address, size)
        for i in range(size):
            self.writes[physical + i] = (value >> (8 * (size - 1 - i))) & 0xFF

    # ---- floating-point register access -----------------------------------

    # A 64-bit value spans two neighbouring registers. Real code only uses
    # even-numbered ones for this; "& 31" keeps nonsense input in bounds.
    def get_l(self, n: int) -> int:
        return self.fw[(n + 1) & 31] << 32 | self.fw[n]

    def set_l(self, n: int, value: int) -> None:
        self.fw[n] = value & MASK32
        self.fw[(n + 1) & 31] = (value >> 32) & MASK32

    def _get_fp(self, n: int, double: bool) -> float:
        return bits_to_double(self.get_l(n)) if double else bits_to_float(self.fw[n])

    def _set_fp(self, n: int, double: bool, value: float) -> None:
        if double:
            self.set_l(n, double_to_bits(value))
        else:
            self.fw[n] = float_to_bits(value)

    def _to_integer(self, value: float, mode: int, bits: int) -> int:
        """Convert a float to an integer of the given width.

        mode: 0 nearest, 1 toward zero, 2 up, 3 down.
        """
        limit = 1 << (bits - 1)
        if math.isnan(value) or math.isinf(value):
            self.fcr31 |= FCR31_INVALID
            return limit - 1
        rounded = (round, math.trunc, math.ceil, math.floor)[mode & 3](value)
        if not -limit <= rounded < limit:
            self.fcr31 |= FCR31_INVALID
            return limit - 1
        return rounded & ((1 << bits) - 1)

    # ---- running ----------------------------------------------------------

    def call(self, address: int, max_steps: int) -> bool:
        """Run the function at an address until it returns.

        Returns False if it was still running after max_steps instructions.
        """
        return_address = self.r[31] & MASK32
        self.pc, self.next_pc = address, address + 4
        while self.pc != return_address:
            if self.steps >= max_steps:
                return False
            self.step()
        return True

    def _jump(self, target: int) -> None:
        self.next_pc = target & MASK32

    def _indirect(self, target: int, is_call: bool) -> None:
        """Jump to an address held in a register."""
        target &= MASK32
        if self.function_starts and (is_call or target != self.r[31] & MASK32):
            # A call must go to a function; a plain jump may also be a switch
            # statement, which stays inside the current function.
            i = bisect.bisect_right(self.function_starts, self.pc)
            current = self.function_starts[i - 1] if i else 0
            following = self.function_starts[i] if i < len(self.function_starts) else MASK32
            inside = not is_call and current <= target < following
            if target not in self.function_set and not inside:
                # The delay slot still runs first, so fail on arrival.
                self.bad_jump, self.bad_jump_target = True, target
        self._jump(target)

    def step(self) -> None:
        """Execute one instruction."""
        pc = self.pc
        if self.bad_jump and pc == self.bad_jump_target:
            raise Trap(f"jump to 0x{pc:08X}, which is not code")
        word = self.read(pc, 4)
        self.pc = self.next_pc
        self.next_pc = (self.pc + 4) & MASK32
        self.steps += 1
        if word == 0:
            return

        r = self.r
        op = word >> 26
        rs, rt, rd = (word >> 21) & 0x1F, (word >> 16) & 0x1F, (word >> 11) & 0x1F
        sa, fn, imm = (word >> 6) & 0x1F, word & 0x3F, word & 0xFFFF
        simm = imm - 0x10000 if imm & 0x8000 else imm
        s, t = r[rs], r[rt]
        branch_target = pc + 4 + simm * 4

        def branch(taken: bool, likely: bool = False) -> None:
            if taken:
                self._jump(branch_target)
            elif likely:
                # A "likely" branch that is not taken skips its delay slot.
                self.pc = (pc + 8) & MASK32
                self.next_pc = (pc + 12) & MASK32

        if op == 0:
            self._special(pc, word, rs, rt, rd, sa, fn)
        elif op == 1:
            if rt in (0, 1, 2, 3):
                branch((signed(s) < 0) == (rt in (0, 2)), likely=rt >= 2)
            elif rt in (16, 17, 18, 19):
                taken = (signed(s) < 0) == (rt in (16, 18))
                r[31] = s32(pc + 8)
                branch(taken, likely=rt >= 18)
            else:
                raise Trap(f"unknown instruction 0x{word:08X}")
        elif op in (2, 3):
            if op == 3:
                r[31] = s32(pc + 8)
            self._jump((pc & 0xF0000000) | ((word & 0x03FFFFFF) << 2))
        elif op in (4, 20):
            branch(s == t, op == 20)
        elif op in (5, 21):
            branch(s != t, op == 21)
        elif op in (6, 22):
            branch(signed(s) <= 0, op == 22)
        elif op in (7, 23):
            branch(signed(s) > 0, op == 23)
        elif op in (8, 9):
            r[rt] = s32(s + simm)
        elif op in (24, 25):
            r[rt] = (s + simm) & MASK64
        elif op == 10:
            r[rt] = int(signed(s) < simm)
        elif op == 11:
            r[rt] = int(s < (simm & MASK64))
        elif op == 12:
            r[rt] = s & imm
        elif op == 13:
            r[rt] = s | imm
        elif op == 14:
            r[rt] = s ^ imm
        elif op == 15:
            r[rt] = s32(imm << 16)
        elif op == 16:
            self._cop0(word, rs, rt)
        elif op == 17:
            self._cop1(word, rs, rt, rd, sa, fn, branch)
        else:
            self._memory(word, op, rt, (s + simm) & MASK32, t)
        r[0] = 0  # register 0 is hard-wired to zero

    def _special(self, pc: int, word: int, rs: int, rt: int, rd: int, sa: int, fn: int) -> None:
        r = self.r
        s, t = r[rs], r[rt]
        if fn in (32, 33):
            r[rd] = s32(s + t)
        elif fn in (34, 35):
            r[rd] = s32(s - t)
        elif fn == 36:
            r[rd] = s & t
        elif fn == 37:
            r[rd] = s | t
        elif fn == 38:
            r[rd] = s ^ t
        elif fn == 39:
            r[rd] = ~(s | t) & MASK64
        elif fn == 42:
            r[rd] = int(signed(s) < signed(t))
        elif fn == 43:
            r[rd] = int(s < t)
        elif fn in (44, 45):
            r[rd] = (s + t) & MASK64
        elif fn in (46, 47):
            r[rd] = (s - t) & MASK64
        elif fn in (0, 4):
            r[rd] = s32((t & MASK32) << (sa if fn == 0 else s & 31))
        elif fn in (2, 6):
            r[rd] = s32((t & MASK32) >> (sa if fn == 2 else s & 31))
        elif fn in (3, 7):
            r[rd] = s32(signed(t) >> (sa if fn == 3 else s & 31))
        elif fn in (20, 56, 60):
            r[rd] = (t << {20: s & 63, 56: sa, 60: sa + 32}[fn]) & MASK64
        elif fn in (22, 58, 62):
            r[rd] = t >> {22: s & 63, 58: sa, 62: sa + 32}[fn]
        elif fn in (23, 59, 63):
            r[rd] = (signed(t) >> {23: s & 63, 59: sa, 63: sa + 32}[fn]) & MASK64
        elif fn == 8:
            self._indirect(s, is_call=False)
        elif fn == 9:
            r[rd] = s32(pc + 8)
            self._indirect(s, is_call=True)
        elif fn == 16:
            r[rd] = self.hi
        elif fn == 17:
            self.hi = s
        elif fn == 18:
            r[rd] = self.lo
        elif fn == 19:
            self.lo = s
        elif fn in (24, 25):  # 32-bit multiply: 64-bit product split over HI and LO
            if fn == 24:
                product = signed(s & MASK32, 32) * signed(t & MASK32, 32)
            else:
                product = (s & MASK32) * (t & MASK32)
            self.lo, self.hi = s32(product), s32(product >> 32)
        elif fn in (26, 27):
            self._divide(s, t, bits=32, is_signed=fn == 26)
        elif fn in (28, 29):
            product = signed(s) * signed(t) if fn == 28 else s * t
            self.lo, self.hi = product & MASK64, (product >> 64) & MASK64
        elif fn in (30, 31):
            self._divide(s, t, bits=64, is_signed=fn == 30)
        elif fn in (12, 13):
            raise Trap("syscall" if fn == 12 else "break")
        elif fn == 15:
            pass  # sync
        elif fn in (48, 49, 50, 51, 52, 54):
            a, b = (signed(s), signed(t)) if fn in (48, 50) else (s, t)
            if {48: a >= b, 49: a >= b, 50: a < b, 51: a < b, 52: a == b, 54: a != b}[fn]:
                raise Trap("trap")
        else:
            raise Trap(f"unknown instruction 0x{word:08X}")

    def _divide(self, s: int, t: int, bits: int, is_signed: bool) -> None:
        mask = (1 << bits) - 1
        extend = s32 if bits == 32 else (lambda v: v & MASK64)
        a, b = s & mask, t & mask
        if is_signed:
            a, b = signed(a, bits), signed(b, bits)
        if b == 0:
            # No crash on a real CPU: it leaves these values behind instead.
            self.lo = 1 if a < 0 else MASK64
            self.hi = extend(a)
            return
        # Python rounds division toward minus infinity; CPUs round toward zero.
        quotient = abs(a) // abs(b)
        if (a < 0) != (b < 0):
            quotient = -quotient
        self.lo, self.hi = extend(quotient), extend(a - quotient * b)

    def _memory(self, word: int, op: int, rt: int, address: int, t: int) -> None:
        r, fw = self.r, self.fw
        if op == 32:
            r[rt] = signed(self.read(address, 1), 8) & MASK64
        elif op == 36:
            r[rt] = self.read(address, 1)
        elif op == 33:
            r[rt] = signed(self.read(address, 2), 16) & MASK64
        elif op == 37:
            r[rt] = self.read(address, 2)
        elif op == 35:
            r[rt] = s32(self.read(address, 4))
        elif op == 39:
            r[rt] = self.read(address, 4)
        elif op == 55:
            r[rt] = self.read(address, 8)
        elif op == 40:
            self.write(address, 1, t)
        elif op == 41:
            self.write(address, 2, t)
        elif op == 43:
            self.write(address, 4, t)
        elif op == 63:
            self.write(address, 8, t)
        elif op == 49:
            fw[rt] = self.read(address, 4)
        elif op == 53:
            self.set_l(rt, self.read(address, 8))
        elif op == 57:
            self.write(address, 4, fw[rt])
        elif op == 61:
            self.write(address, 8, self.get_l(rt))
        elif op == 47:
            pass  # cache
        elif op in (34, 38, 26, 27, 42, 46, 44, 45):
            self._unaligned(op, rt, address, t)
        else:
            raise Trap(f"unknown instruction 0x{word:08X}")

    def _unaligned(self, op: int, rt: int, address: int, t: int) -> None:
        """The "left" and "right" halves of an unaligned load or store.

        Work a byte at a time: "left" instructions handle the bytes from the
        address to the end of the aligned word, filling the register from its
        most significant byte; "right" ones handle the bytes from the start
        of the word up to the address, filling from the least significant.
        """
        size = 8 if op in (26, 27, 44, 45) else 4
        offset = address & (size - 1)
        left = op in (34, 26, 42, 44)
        count = size - offset if left else offset + 1
        if op in (34, 38, 26, 27):  # loads
            value = t & ((1 << (size * 8)) - 1)
            for i in range(count):
                if left:
                    byte, position = self.read(address + i, 1), size - 1 - i
                else:
                    byte, position = self.read(address - i, 1), i
                value = value & ~(0xFF << (position * 8)) | byte << (position * 8)
            self.r[rt] = s32(value) if size == 4 else value
        else:  # stores
            for i in range(count):
                if left:
                    self.write(address + i, 1, t >> ((size - 1 - i) * 8))
                else:
                    self.write(address - i, 1, t >> (i * 8))

    def _cop0(self, word: int, rs: int, rt: int) -> None:
        # System control registers are not modelled yet: they read as zero.
        if rs in (0, 1):
            self.r[rt] = 0
        elif rs >= 16 and word & 0x3F in (1, 2, 6, 8):
            pass  # the four address-mapping instructions: not modelled here either
        elif rs not in (4, 5):
            raise Trap("system instruction")

    def _cop1(self, word: int, rs: int, ft: int, fs: int, fd: int, fn: int, branch) -> None:
        r, fw = self.r, self.fw
        if rs == 0:
            r[ft] = s32(fw[fs])
        elif rs == 1:
            r[ft] = self.get_l(fs)
        elif rs == 2:
            r[ft] = s32(self.fcr31) if fs == 31 else 0
        elif rs == 4:
            fw[fs] = r[ft] & MASK32
        elif rs == 5:
            self.set_l(fs, r[ft])
        elif rs == 6:
            if fs == 31:
                self.fcr31 = r[ft] & MASK32
        elif rs == 8:
            condition = bool(self.fcr31 & FCR31_CONDITION)
            branch(condition == bool(ft & 1), likely=ft >= 2)
        elif rs in (16, 17):
            double = rs == 17
            a = self._get_fp(fs, double)
            if fn < 4:
                b = self._get_fp(ft, double)
                result = (a + b, a - b, a * b, None)[fn] if fn != 3 else float_divide(a, b)
                self._set_fp(fd, double, result)
            elif fn == 4:
                self._set_fp(fd, double, float_sqrt(a))
            elif fn in (5, 6, 7):  # abs, mov, neg: just bit operations
                sign = 1 << (63 if double else 31)
                bits = self.get_l(fs) if double else fw[fs]
                bits = {5: bits & ~sign, 6: bits, 7: bits ^ sign}[fn]
                if double:
                    self.set_l(fd, bits)
                else:
                    fw[fd] = bits
            elif fn in (8, 9, 10, 11, 37):
                self.set_l(fd, self._to_integer(a, self.fcr31 if fn == 37 else fn, 64))
            elif fn in (12, 13, 14, 15, 36):
                fw[fd] = self._to_integer(a, self.fcr31 if fn == 36 else fn, 32)
            elif fn == 32 and double:
                self._set_fp(fd, False, a)
            elif fn == 33 and not double:
                self._set_fp(fd, True, a)
            elif fn >= 48:
                b = self._get_fp(ft, double)
                if math.isnan(a) or math.isnan(b):
                    result = bool(fn & 1)
                else:
                    result = bool((fn & 2 and a == b) or (fn & 4 and a < b))
                self.fcr31 = self.fcr31 & ~FCR31_CONDITION | (FCR31_CONDITION if result else 0)
            else:
                raise Trap(f"unknown instruction 0x{word:08X}")
        elif rs in (20, 21) and fn in (32, 33):
            value = signed(fw[fs], 32) if rs == 20 else signed(self.get_l(fs))
            self._set_fp(fd, fn == 33, float(value))
        else:
            raise Trap(f"unknown instruction 0x{word:08X}")
