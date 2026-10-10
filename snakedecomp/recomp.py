"""Static recompiler: translate every MIPS function into a C function.

Each MIPS instruction becomes one line of C that does the same thing to a
"Context" struct holding the CPU's registers. The result is not pretty and
is not what the original programmers wrote, but it is real C: it can be
compiled for any modern computer, with no emulator interpreting
instructions at run time.

Arithmetic and memory instructions translate one to one. The interesting
part is control flow:

  * Branches become "goto". The instruction after a branch (the delay slot)
    runs before the jump happens, but the branch's condition is decided
    first, so we save the condition, run the delay slot, then jump.
  * "Likely" branches run their delay slot only when the branch is taken.
  * "jal" becomes a C function call, and "jr $ra" becomes "return".
  * "jr" through a jump table becomes a C switch statement.
  * Calls through a register (function pointers) look the address up in a
    table of every function, at run time.
"""

import bisect
import io
import os

from .functions import RETURN, Function
from .mips import GPR, disassemble
from .program import Program

FUNCTIONS_PER_FILE = 400

BRANCHES = {4: "beq", 5: "bne", 6: "blez", 7: "bgtz"}  # +16 for the "likely" forms
FP_ROUNDERS = {8: "round.l", 9: "trunc.l", 10: "ceil.l", 11: "floor.l",
               12: "round.w", 13: "trunc.w", 14: "ceil.w", 15: "floor.w"}  # fmt: skip


class Unsupported(Exception):
    pass


def reg(n: int) -> str:
    """C expression for reading a register. Register 0 is always zero."""
    return "0ULL" if n == 0 else f"ctx->{GPR[n]}"


def assign(n: int, expression: str) -> str:
    """C statement for writing a register. Writes to register 0 are ignored."""
    return ";" if n == 0 else f"ctx->{GPR[n]} = {expression};"


def simple_statement(word: int, address: int) -> str:
    """Translate one instruction that is not a branch, jump or call."""
    op = word >> 26
    rs, rt, rd = (word >> 21) & 0x1F, (word >> 16) & 0x1F, (word >> 11) & 0x1F
    sa, fn, imm = (word >> 6) & 0x1F, word & 0x3F, word & 0xFFFF
    simm = imm - 0x10000 if imm & 0x8000 else imm
    s, t = reg(rs), reg(rt)
    mem_address = f"(uint32_t)({s} + ({simm}))"

    if word == 0:
        return ";"

    if op == 0:  # register arithmetic
        simple = {
            32: f"S32((uint32_t){s} + (uint32_t){t})",
            33: f"S32((uint32_t){s} + (uint32_t){t})",
            34: f"S32((uint32_t){s} - (uint32_t){t})",
            35: f"S32((uint32_t){s} - (uint32_t){t})",
            36: f"{s} & {t}",
            37: f"{s} | {t}",
            38: f"{s} ^ {t}",
            39: f"~({s} | {t})",
            42: f"(int64_t){s} < (int64_t){t}",
            43: f"{s} < {t}",
            44: f"{s} + {t}",
            45: f"{s} + {t}",
            46: f"{s} - {t}",
            47: f"{s} - {t}",
            0: f"S32((uint32_t){t} << {sa})",
            2: f"S32((uint32_t){t} >> {sa})",
            3: f"S32((int64_t){t} >> {sa})",
            4: f"S32((uint32_t){t} << ({s} & 31))",
            6: f"S32((uint32_t){t} >> ({s} & 31))",
            7: f"S32((int64_t){t} >> ({s} & 31))",
            20: f"{t} << ({s} & 63)",
            22: f"{t} >> ({s} & 63)",
            23: f"(uint64_t)((int64_t){t} >> ({s} & 63))",
            56: f"{t} << {sa}",
            58: f"{t} >> {sa}",
            59: f"(uint64_t)((int64_t){t} >> {sa})",
            60: f"{t} << {sa + 32}",
            62: f"{t} >> {sa + 32}",
            63: f"(uint64_t)((int64_t){t} >> {sa + 32})",
            16: "ctx->hi",
            18: "ctx->lo",
        }
        if fn in simple:
            return assign(rd, simple[fn])
        muldiv = {24: "mult", 25: "multu", 26: "div", 27: "divu",
                  28: "dmult", 29: "dmultu", 30: "ddiv", 31: "ddivu"}  # fmt: skip
        if fn in muldiv:
            return f"do_{muldiv[fn]}(ctx, {s}, {t});"
        if fn == 17:
            return f"ctx->hi = {s};"
        if fn == 19:
            return f"ctx->lo = {s};"
        if fn == 15:  # sync
            return ";"
        if fn in (12, 13):
            name = "syscall" if fn == 12 else "break"
            return f'trap(ctx, "{name}", 0x{address:08X});'
        traps = {48: f"(int64_t){s} >= (int64_t){t}", 49: f"{s} >= {t}",
                 50: f"(int64_t){s} < (int64_t){t}", 51: f"{s} < {t}",
                 52: f"{s} == {t}", 54: f"{s} != {t}"}  # fmt: skip
        if fn in traps:
            return f'if ({traps[fn]}) trap(ctx, "trap", 0x{address:08X});'

    immediate = {
        8: f"S32((uint32_t){s} + (uint32_t)({simm}))",
        9: f"S32((uint32_t){s} + (uint32_t)({simm}))",
        24: f"{s} + (uint64_t)(int64_t)({simm})",
        25: f"{s} + (uint64_t)(int64_t)({simm})",
        10: f"(int64_t){s} < {simm}",
        11: f"{s} < (uint64_t)(int64_t)({simm})",
        12: f"{s} & 0x{imm:X}",
        13: f"{s} | 0x{imm:X}",
        14: f"{s} ^ 0x{imm:X}",
        15: f"S32(0x{imm << 16:08X}u)",
        32: f"S32((int8_t)rd8(ctx, {mem_address}))",
        36: f"rd8(ctx, {mem_address})",
        33: f"S32((int16_t)rd16(ctx, {mem_address}))",
        37: f"rd16(ctx, {mem_address})",
        35: f"S32(rd32(ctx, {mem_address}))",
        39: f"rd32(ctx, {mem_address})",
        55: f"rd64(ctx, {mem_address})",
        34: f"do_lwl(ctx, {mem_address}, {t})",
        38: f"do_lwr(ctx, {mem_address}, {t})",
        26: f"do_ldl(ctx, {mem_address}, {t})",
        27: f"do_ldr(ctx, {mem_address}, {t})",
    }
    if op in immediate:
        return assign(rt, immediate[op])
    stores = {
        40: f"wr8(ctx, {mem_address}, (uint8_t){t});",
        41: f"wr16(ctx, {mem_address}, (uint16_t){t});",
        43: f"wr32(ctx, {mem_address}, (uint32_t){t});",
        63: f"wr64(ctx, {mem_address}, {t});",
        42: f"do_swl(ctx, {mem_address}, {t});",
        46: f"do_swr(ctx, {mem_address}, {t});",
        44: f"do_sdl(ctx, {mem_address}, {t});",
        45: f"do_sdr(ctx, {mem_address}, {t});",
        49: f"ctx->fw[{rt}] = rd32(ctx, {mem_address});",
        53: f"set_l(ctx, {rt}, rd64(ctx, {mem_address}));",
        57: f"wr32(ctx, {mem_address}, ctx->fw[{rt}]);",
        61: f"wr64(ctx, {mem_address}, get_l(ctx, {rt}));",
        47: ";",  # cache: tells the CPU cache what to do; nothing to do here
    }
    if op in stores:
        return stores[op]

    if op == 16:  # system control
        if rs == 0:
            return assign(rt, f"S32(cop0_read(ctx, {rd}))")
        if rs == 1:
            return assign(rt, f"cop0_read(ctx, {rd})")
        if rs in (4, 5):
            return f"cop0_write(ctx, {rd}, {t});"
        if rs >= 16 and fn in (1, 2, 6, 8):  # tlbr, tlbwi, tlbwr, tlbp: address mapping
            return f"tlb_instruction(ctx, {fn});"
        return f'trap(ctx, "system instruction", 0x{address:08X});'

    if op == 17:  # floating point
        ft, fs, fd = rt, rd, sa
        moves = {
            0: assign(rt, f"S32(ctx->fw[{fs}])"),
            1: assign(rt, f"get_l(ctx, {fs})"),
            2: assign(rt, "S32(ctx->fcr31)" if fs == 31 else "0"),
            4: f"ctx->fw[{fs}] = (uint32_t){t};",
            5: f"set_l(ctx, {fs}, {t});",
            6: f"ctx->fcr31 = (uint32_t){t};" if fs == 31 else ";",
        }
        if rs in moves:
            return moves[rs]
        if rs in (16, 17):  # single or double precision
            x = "f" if rs == 16 else "d"
            a, b = f"get_{x}(ctx, {fs})", f"get_{x}(ctx, {ft})"
            maths = {0: f"{a} + {b}", 1: f"{a} - {b}", 2: f"{a} * {b}", 3: f"{a} / {b}",
                     4: f"sqrt{'f' if rs == 16 else ''}({a})",
                     5: f"fabs{'f' if rs == 16 else ''}({a})", 7: f"-{a}"}  # fmt: skip
            if fn in maths:
                return f"set_{x}(ctx, {fd}, {maths[fn]});"
            if fn == 6:  # mov
                if rs == 16:
                    return f"ctx->fw[{fd}] = ctx->fw[{fs}];"
                return f"set_l(ctx, {fd}, get_l(ctx, {fs}));"
            if fn in FP_ROUNDERS or fn in (36, 37):
                mode = "ctx->fcr31" if fn >= 36 else str(fn & 3)
                if fn in (36, 12, 13, 14, 15):
                    return f"ctx->fw[{fd}] = to_w(ctx, {a}, {mode});"
                return f"set_l(ctx, {fd}, to_l(ctx, {a}, {mode}));"
            if fn == 32 and rs == 17:
                return f"set_f(ctx, {fd}, (float){a});"
            if fn == 33 and rs == 16:
                return f"set_d(ctx, {fd}, (double){a});"
            if fn >= 48:
                return f"fp_compare(ctx, {a}, {b}, {fn & 7});"
        if rs in (20, 21) and fn in (32, 33):  # integer to float
            source = f"(int32_t)ctx->fw[{fs}]" if rs == 20 else f"(int64_t)get_l(ctx, {fs})"
            if fn == 32:
                return f"set_f(ctx, {fd}, (float){source});"
            return f"set_d(ctx, {fd}, (double){source});"

    raise Unsupported(f"0x{address:08X}: {disassemble(word, address)}")


class Recompiler:
    def __init__(
        self,
        program: Program,
        replaced: set[str] = frozenset(),
        wanted_addresses: set[str] = frozenset(),
        rewritten: set[int] = frozenset(),
    ):
        """replaced: names of functions the host program implements itself.

        Functions that talk to the console's hardware cannot simply be
        translated, because the hardware is not there. Those are left out,
        and calls to them go to a hand-written "hle_<name>" function instead.
        (HLE = high-level emulation: imitate what a function achieves rather
        than the hardware it used to achieve it.)
        """
        # rewritten: addresses that a cheat may write to. Where one of them
        # is inside a function, the cheat is changing the game's
        # instructions ("skip the line that takes a life away"). Our
        # translation was made from the original instructions and would
        # carry on unchanged, so such a function first checks whether its
        # instructions in memory are still the original ones, and if not,
        # hands over to the interpreter, which runs whatever is there now.
        self.rewritten = rewritten
        self.program = program
        self.replaced = replaced
        self.wanted_addresses = wanted_addresses
        self.problems: list[str] = []
        self.not_recompiled: set[int] = set()
        self._local_returns: list[int] = []

    def _rewritten_near(self, f: Function) -> list[int]:
        if not hasattr(self, "_rewritten_sorted"):
            self._rewritten_sorted = sorted(self.rewritten)
        low = bisect.bisect_left(self._rewritten_sorted, f.start)
        return self._rewritten_sorted[low : bisect.bisect_left(self._rewritten_sorted, f.end)]

    def _call(self, f: Function, target: int) -> str | None:
        """C for calling the function at an address, from inside f."""
        group = self.program.alternatives.get(target)
        if group:
            # Several overlays have a function here (see program.py). From
            # inside one of them it is that overlay's own; otherwise only
            # the running game knows which is loaded.
            own = [g for g in group if g.segment is f.segment]
            if own:
                return f"{own[0].name}(ctx);"
            return f"call_indirect(ctx, 0x{target:08X}u);"
        callee = self.program.functions.get(target)
        if callee is None:
            return None
        # Code outside the main segment is loaded by the game when it likes,
        # so a call into it from elsewhere is checked as the game runs.
        if callee.segment is self.program.segments[0] or callee.segment is f.segment:
            return f"func_{target:08X}(ctx);"
        return f"call_indirect(ctx, 0x{target:08X}u);"

    def _word(self, f: Function, address: int) -> int:
        return self.program.rom.word(f.segment.to_rom(address))

    def _delay_slot(self, f: Function, address: int) -> str:
        """C for the instruction in a delay slot."""
        if address >= f.end:
            return ";"
        word = self._word(f, address)
        if disassemble(word, address).target is not None or (word >> 26 == 0 and word & 0x3E == 8):
            raise Unsupported(f"0x{address:08X}: jump inside a delay slot")
        return simple_statement(word, address)

    def _is_delay_slot(self, f: Function, address: int) -> bool:
        if address == f.start:
            return False
        word = self._word(f, address - 4)
        return disassemble(word, address - 4).target is not None or (
            word >> 26 == 0 and word & 0x3E == 8  # jr, jalr
        )

    def _transfer(self, f: Function, source: int, target: int, labels: set[int]) -> str:
        """C for "continue execution at this address"."""
        if f.start <= target < f.end:
            labels.add(target)
            # A jump backwards is a loop; see LOOP_CHECK in runtime.h.
            check = "LOOP_CHECK(); " if target <= source else ""
            return f"{check}goto L_{target:08X};"
        call = self._call(f, target)
        if call:
            # Jumping to another function without "jal" is a tail call: that
            # function will return straight to whoever called this one.
            return f"{call} return;"
        raise Unsupported(f"jump from {f.name} into the middle of another function")

    def _control_flow(self, f: Function, address: int, labels: set[int]):
        """Describe a branch/jump/call as (setup, condition, action, likely).

        Returns None if the instruction is not a control-flow instruction.
        setup runs before the delay slot, action after it.
        """
        word = self._word(f, address)
        op = word >> 26
        rs, rt, rd, fn = (word >> 21) & 0x1F, (word >> 16) & 0x1F, (word >> 11) & 0x1F, word & 0x3F
        s, t = reg(rs), reg(rt)
        target = disassemble(word, address).target
        link = f"S32(0x{address + 8:08X}u)"

        if op in BRANCHES or op - 16 in BRANCHES:
            likely = op >= 20
            condition = {
                4: f"{s} == {t}",
                5: f"{s} != {t}",
                6: f"(int64_t){s} <= 0",
                7: f"(int64_t){s} > 0",
            }[op - 16 if likely else op]
            if op == 4 and rs == rt:
                condition = "1"  # "beq $zero, $zero" is how MIPS spells "always"
            return "", condition, self._transfer(f, address, target, labels), likely
        if op == 1 and rt in (0, 1, 2, 3):
            condition = f"(int64_t){s} < 0" if rt in (0, 2) else f"(int64_t){s} >= 0"
            return "", condition, self._transfer(f, address, target, labels), rt >= 2
        if op == 1 and rt in (16, 17, 18, 19):  # "branch and link": a call to somewhere nearby
            condition = f"(int64_t){s} < 0" if rt in (16, 18) else f"(int64_t){s} >= 0"
            if rs == 0:
                condition = "1" if rt in (17, 19) else "0"
            if f.start <= target < f.end:
                # Hand-written assembly sometimes calls a piece of its own
                # function as a subroutine. In C that is a goto there, and a
                # goto back when the piece does "jr $ra" (see below).
                return f"ctx->ra = {link};", condition, self._transfer(f, address, target, labels), rt >= 18
            if self._call(f, target):
                return f"ctx->ra = {link};", condition, self._call(f, target), rt >= 18
            raise Unsupported(f"0x{address:08X}: call into the middle of another function")
        if op == 17 and rs == 8:  # branch on the last float comparison
            condition = "ctx->fcr31 & FCR31_CONDITION"
            if rt & 1 == 0:
                condition = f"!({condition})"
            return "", condition, self._transfer(f, address, target, labels), rt >= 2
        if op == 2:  # j
            return "", "1", self._transfer(f, address, target, labels), False
        if op == 3:  # jal
            # (A call to somewhere we found no function is left to the
            # interpreter to sort out, when and if it happens.)
            call = self._call(f, target) or f"call_indirect(ctx, 0x{target:08X}u);"
            return f"ctx->ra = {link};", "1", call, False
        if op == 0 and fn == 9:  # jalr: call through a register
            setup = f"target = {s}; " + assign(rd, link)
            return setup, "1", "call_indirect(ctx, (uint32_t)target);", False
        if op == 0 and fn == 8:  # jr
            if word == RETURN:
                if not self._local_returns:
                    return "", "1", "return;", False
                # This function calls pieces of itself (see above), so a
                # return may be going back to one of those call sites.
                labels.update(self._local_returns)
                cases = " ".join(
                    f"case 0x{a:08X}u: goto L_{a:08X};" for a in self._local_returns
                )
                return (f"target = {s};", "1",
                        f"switch ((uint32_t)target) {{ {cases} default: return; }}", False)  # fmt: skip
            # A switch statement. If we could not read its table, allow a
            # jump to any instruction in this function.
            targets = f.jump_tables.get(address)
            if not targets or not all(f.start <= t < f.end for t in targets):
                # (...or it does not belong to this function after all)
                targets = [a for a in range(f.start, f.end, 4) if not self._is_delay_slot(f, a)]
            labels.update(targets)
            cases = " ".join(f"case 0x{a:08X}u: goto L_{a:08X};" for a in sorted(set(targets)))
            action = (
                f"switch ((uint32_t)target) {{ {cases} "
                "default: call_indirect(ctx, (uint32_t)target); return; }"
            )
            return f"target = {s};", "1", action, False
        if disassemble(word, address).target is not None or (op == 16 and fn == 24):
            raise Unsupported(f"0x{address:08X}: {disassemble(word, address)}")
        return None

    def function_source(self, f: Function, name: str | None = None) -> str:
        """Translate one function to C (optionally under a different name)."""
        labels: set[int] = set()
        body: list[tuple[int, str]] = []  # (address, C code)
        # Where this function's calls to pieces of itself return to.
        self._local_returns = [
            a + 8
            for a in range(f.start, f.end, 4)
            if (w := self._word(f, a)) >> 26 == 1
            and (w >> 16) & 0x1F in (16, 17, 18, 19)
            and f.start <= disassemble(w, a).target < f.end
            and a + 8 < f.end
        ]
        address = f.start
        while address < f.end:
            flow = self._control_flow(f, address, labels)
            if flow is None:
                body.append((address, simple_statement(self._word(f, address), address)))
                address += 4
                continue
            body.append((address, (*flow, self._delay_slot(f, address + 4))))
            body.append((address + 4, None))  # the delay slot, emitted with its jump
            address += 8

        lines = [f"/* {f.label} */" if f.symbol else "",
                 f"void {name or f.name}(Context *ctx) {{", "    int cond; uint64_t target;",
                 "    (void)cond; (void)target;"]  # fmt: skip
        for address, code in body:
            if address >= f.end:
                continue
            asm = self.program.describe(address, f.segment)
            if code is None:
                lines.append(f"    /* {address:08X}  {asm}  (delay slot, done above) */")
                continue
            if address in labels:
                lines.append(f"L_{address:08X}:;")
            if isinstance(code, tuple):
                setup, condition, action, likely, delay = code
                if address + 4 in labels:
                    # Rare: something jumps straight to the delay slot. Then
                    # it runs as an ordinary instruction, without the jump.
                    if likely:
                        raise Unsupported(f"0x{address:08X}: jump into a likely delay slot")
                    code = (
                        f"{setup} cond = {condition}; goto D_{address:08X}; "
                        f"L_{address + 4:08X}:; cond = 0; D_{address:08X}:; "
                        f"{delay} if (cond) {{ {action} }}"
                    )
                elif likely:
                    code = f"if ({condition}) {{ {delay} {action} }}"
                elif condition == "1":
                    code = f"{setup} {delay} {action}".strip()
                else:
                    code = f"cond = {condition}; {delay} if (cond) {{ {action} }}"
            lines.append(f"    {code:<60} /* {address:08X}  {asm} */")
        # Running off the end continues into whatever comes next in memory.
        if self._call(f, f.end):
            lines.append(f"    {self._call(f, f.end)}")
        lines.append("}")
        return "\n".join(lines)

    def write(self, out_dir: str) -> int:
        """Write the recompiled game as C files. Returns the function count."""
        os.makedirs(out_dir, exist_ok=True)
        with open(os.path.join(os.path.dirname(__file__), "runtime", "runtime.h")) as source:
            _write(os.path.join(out_dir, "runtime.h"), source.read())
        functions = sorted(self.program.all_functions, key=lambda f: f.start)

        sources = []
        replaced = [f for f in functions if f.symbol in self.replaced]
        for f in functions:
            if f.symbol in self.replaced:
                sources.append(
                    f"/* {f.symbol}: provided by the host program */\n"
                    f'void {f.name}(Context *ctx) {{ HLE_CALL("{f.symbol}"); hle_{f.symbol}(ctx); }}'
                )
                # The translated original is kept too, as original_<name>, so
                # a replacement can do a little extra and then call it.
                try:
                    sources.append(self.function_source(f, f"original_{f.symbol}"))
                except Unsupported:
                    sources.append(
                        f"void original_{f.symbol}(Context *ctx) {{\n"
                        f'    trap(ctx, "function not recompiled", 0x{f.start:08X});\n}}'
                    )
                continue
            try:
                if any(a & ~3 in range(f.start, f.end, 4) for a in self._rewritten_near(f)):
                    sources.append(self.function_source(f, f"{f.name}_translated"))
                    sources.append(
                        f"/* a cheat may rewrite this one: see Recompiler */\n"
                        f"void {f.name}_translated(Context *ctx);\n"
                        f"void {f.name}(Context *ctx) {{\n"
                        f"    if (CODE_CHANGED(ctx, 0x{f.start:08X}u, 0x{f.segment.to_rom(f.start):X}u, {f.end - f.start}))\n"
                        f"        NOT_RECOMPILED(ctx, 0x{f.start:08X}u);\n"
                        f"    else\n        {f.name}_translated(ctx);\n}}"
                    )
                    continue
                sources.append(self.function_source(f))
            except Unsupported as problem:
                self.problems.append(f"{f.name}: {problem}")
                self.not_recompiled.add(f.start)
                sources.append(
                    f"void {f.name}(Context *ctx) {{\n"
                    f"    NOT_RECOMPILED(ctx, 0x{f.start:08X}u);\n}}"
                )

        with _Output(os.path.join(out_dir, "functions.h")) as out:
            out.write('#include "runtime.h"\n\n')
            out.writelines(f"void {f.name}(Context *ctx);\n" for f in functions)
            out.writelines(f"void hle_{f.symbol}(Context *ctx);\n" for f in replaced)
            out.writelines(f"void original_{f.symbol}(Context *ctx);\n" for f in replaced)
            out.write("\n")
            for name in sorted(self.wanted_addresses):
                symbols = self.program.symbols
                address = symbols.addresses.get(name) if symbols else None
                if address is None:
                    # (The host copes without the library's own variables.)
                    if not name.startswith(("__os", "os")):
                        self.problems.append(f"the host wants ADDR_{name}, which is not in the name list")
                else:
                    out.write(f"#define ADDR_{name} 0x{address:08X}u\n")
            entry = self.program.segments[0]
            out.write(f"\n#define ENTRY_POINT 0x{entry.vram_start:08X}u\n")
            out.write(f"#define ENTRY_ROM_OFFSET 0x{entry.rom_start:X}u\n")
            out.write(f"#define BOOT_LOAD_SIZE 0x{entry.size:X}u\n")
        for i in range(0, len(sources), FUNCTIONS_PER_FILE):
            path = os.path.join(out_dir, f"functions_{i // FUNCTIONS_PER_FILE:02}.c")
            with _Output(path) as out:
                out.write('#include "functions.h"\n\n')
                out.write("\n\n".join(sources[i : i + FUNCTIONS_PER_FILE]) + "\n")

        # The lookup table for calls through function pointers.
        with _Output(os.path.join(out_dir, "lookup.c")) as out:
            out.write('#include "functions.h"\n\n')
            out.write("/* rom_offset and size are filled in for code the game loads itself. */\n")
            out.write("static const struct { uint32_t address; void (*function)(Context *); ")
            out.write("uint32_t rom_offset, size; } table[] = {\n")
            for f in functions:
                shared = f.segment is not self.program.segments[0]
                where = f"0x{f.segment.to_rom(f.start):X}u, {f.end - f.start}" if shared else "0, 0"
                out.write(f"    {{0x{f.start:08X}u, {f.name}, {where}}},\n")
            out.write("};\n\n")
            out.write(LOOKUP_FUNCTION)
        return len(functions)


def _write(path: str, text: str) -> None:
    """Write a file, unless it already says exactly this.

    Leaving unchanged files alone lets the build skip compiling them again.
    """
    if os.path.exists(path):
        with open(path) as old:
            if old.read() == text:
                return
    with open(path, "w") as out:
        out.write(text)


class _Output(io.StringIO):
    """Collects text like an open file does, then hands it to _write."""

    def __init__(self, path: str):
        super().__init__()
        self.path = path

    def __exit__(self, *problem):
        _write(self.path, self.getvalue())
        return super().__exit__(*problem)


LOOKUP_FUNCTION = """\
/* The translated function for an address, or NULL if there is none, or if
 * the code in the game's memory there is no longer the code we translated. */
void (*native_function(Context *ctx, uint32_t address))(Context *) {
    /* The table is sorted, so halve the search range until we find it. */
    int count = (int)(sizeof(table) / sizeof(table[0]));
    int low = 0, high = count - 1;
    while (low <= high) {
        int middle = (low + high) / 2;
        if (table[middle].address < address) {
            low = middle + 1;
        } else if (table[middle].address > address) {
            high = middle - 1;
        } else {
#ifdef HOST_RUNTIME
            if (!table[middle].size)
                return table[middle].function;
            if (host_interpret_loaded_code)
                return NULL; /* (for testing: see runtime.h) */
            /* Code outside the part loaded at start-up comes and goes, and
             * several pieces may use this address in turn. Take the one
             * that matches what is in memory at this moment. */
            if (address < 0x80000000u || address - 0x80000000u > RAM_SIZE - table[middle].size)
                return NULL;
            while (middle > 0 && table[middle - 1].address == address)
                middle--;
            for (; middle < count && table[middle].address == address; middle++)
                if (!memcmp(ctx->ram + (address - 0x80000000u), host_rom + table[middle].rom_offset,
                            table[middle].size))
                    return table[middle].function;
            return NULL;
#else
            return table[middle].function;
#endif
        }
    }
    return NULL;
}

void call_indirect(Context *ctx, uint32_t address) {
    void (*function)(Context *) = native_function(ctx, address);
    if (function)
        function(ctx);
    else
        NOT_RECOMPILED(ctx, address);
}
"""
