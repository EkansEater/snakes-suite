/*
 * The interpreter: a safety net under the recompiler.
 *
 * The recompiler translates the code it can find in the ROM ahead of time.
 * That is fast, but it cannot cover everything a game might run:
 *   - code the game unpacks or moves about while running, so that it is
 *     not at any address we could know beforehand;
 *   - pieces of code that take turns at one address ("overlays") which our
 *     analysis did not find;
 *   - the odd function written in a way the recompiler does not handle.
 *
 * For all of those there is this: it reads the game's instructions from
 * the game's memory one at a time, as they are at that moment, and does
 * what each says. It is slower than translated code (though a modern PC
 * interprets faster than the console ran), and it never needs to have seen
 * the code before.
 *
 * The two mix freely. interpret() runs one function. When that function
 * calls another, we ask whether a translated version exists and is still
 * what is in memory (native_function, in the generated lookup.c); if so it
 * runs at full speed, and if not we interpret that one too.
 *
 * Each instruction here does exactly what recomp.py's translation of the
 * same instruction does; keep the two in step.
 */
#include <stdio.h>

#include "runtime.h"

long host_interpreted; /* how many instructions we have interpreted, for the statistics */

static void not_understood(Context *ctx, uint32_t pc) {
    static char text[64];
    snprintf(text, sizeof text, "instruction not understood (%08X)", rd32(ctx, pc));
    trap(ctx, text, pc);
}

/* Carry out one instruction that is not a branch, jump or call. */
static void simple(Context *ctx, uint32_t word, uint32_t pc) {
    uint32_t op = word >> 26, rs = (word >> 21) & 31, rt = (word >> 16) & 31;
    uint32_t rd = (word >> 11) & 31, sa = (word >> 6) & 31, fn = word & 63;
    uint32_t imm = word & 0xFFFF;
    int32_t simm = (int16_t)imm;
    uint64_t s = ctx->r[rs], t = ctx->r[rt];
    uint32_t at = (uint32_t)(s + (uint64_t)(int64_t)simm); /* the address, for loads and stores */
    uint64_t *d = &ctx->r[rd], *T = &ctx->r[rt];

    switch (op) {
    case 0: /* register arithmetic */
        switch (fn) {
        case 0: *d = S32((uint32_t)t << sa); break;
        case 2: *d = S32((uint32_t)t >> sa); break;
        case 3: *d = S32((int64_t)t >> sa); break;
        case 4: *d = S32((uint32_t)t << (s & 31)); break;
        case 6: *d = S32((uint32_t)t >> (s & 31)); break;
        case 7: *d = S32((int64_t)t >> (s & 31)); break;
        case 12: trap(ctx, "syscall", pc);
        case 13: trap(ctx, "break", pc);
        case 15: break; /* sync */
        case 16: *d = ctx->hi; break;
        case 17: ctx->hi = s; break;
        case 18: *d = ctx->lo; break;
        case 19: ctx->lo = s; break;
        case 20: *d = t << (s & 63); break;
        case 22: *d = t >> (s & 63); break;
        case 23: *d = (uint64_t)((int64_t)t >> (s & 63)); break;
        case 24: do_mult(ctx, s, t); break;
        case 25: do_multu(ctx, s, t); break;
        case 26: do_div(ctx, s, t); break;
        case 27: do_divu(ctx, s, t); break;
        case 28: do_dmult(ctx, s, t); break;
        case 29: do_dmultu(ctx, s, t); break;
        case 30: do_ddiv(ctx, s, t); break;
        case 31: do_ddivu(ctx, s, t); break;
        case 32: case 33: *d = S32((uint32_t)s + (uint32_t)t); break;
        case 34: case 35: *d = S32((uint32_t)s - (uint32_t)t); break;
        case 36: *d = s & t; break;
        case 37: *d = s | t; break;
        case 38: *d = s ^ t; break;
        case 39: *d = ~(s | t); break;
        case 42: *d = (int64_t)s < (int64_t)t; break;
        case 43: *d = s < t; break;
        case 44: case 45: *d = s + t; break;
        case 46: case 47: *d = s - t; break;
        case 48: if ((int64_t)s >= (int64_t)t) trap(ctx, "trap", pc); break;
        case 49: if (s >= t) trap(ctx, "trap", pc); break;
        case 50: if ((int64_t)s < (int64_t)t) trap(ctx, "trap", pc); break;
        case 51: if (s < t) trap(ctx, "trap", pc); break;
        case 52: if (s == t) trap(ctx, "trap", pc); break;
        case 54: if (s != t) trap(ctx, "trap", pc); break;
        case 56: *d = t << sa; break;
        case 58: *d = t >> sa; break;
        case 59: *d = (uint64_t)((int64_t)t >> sa); break;
        case 60: *d = t << (sa + 32); break;
        case 62: *d = t >> (sa + 32); break;
        case 63: *d = (uint64_t)((int64_t)t >> (sa + 32)); break;
        default: not_understood(ctx, pc);
        }
        break;
    case 8: case 9: *T = S32((uint32_t)s + (uint32_t)simm); break;
    case 24: case 25: *T = s + (uint64_t)(int64_t)simm; break;
    case 10: *T = (int64_t)s < simm; break;
    case 11: *T = s < (uint64_t)(int64_t)simm; break;
    case 12: *T = s & imm; break;
    case 13: *T = s | imm; break;
    case 14: *T = s ^ imm; break;
    case 15: *T = S32(imm << 16); break;
    case 16: /* system control */
        if (rs == 0) *T = S32(cop0_read(ctx, (int)rd));
        else if (rs == 1) *T = cop0_read(ctx, (int)rd);
        else if (rs == 4 || rs == 5) cop0_write(ctx, (int)rd, t);
        else if (rs >= 16 && (fn == 1 || fn == 2 || fn == 6 || fn == 8)) tlb_instruction(ctx, (int)fn);
        else trap(ctx, "system instruction", pc);
        break;
    case 17: { /* floating point */
        int ft = (int)rt, fs = (int)rd, fd = (int)sa;
        if (rs == 0) *T = S32(ctx->fw[fs]);
        else if (rs == 1) *T = get_l(ctx, fs);
        else if (rs == 2) *T = fs == 31 ? S32(ctx->fcr31) : 0;
        else if (rs == 4) ctx->fw[fs] = (uint32_t)t;
        else if (rs == 5) set_l(ctx, fs, t);
        else if (rs == 6) { if (fs == 31) ctx->fcr31 = (uint32_t)t; }
        else if (rs == 16) { /* single precision */
            float a = get_f(ctx, fs), b = get_f(ctx, ft);
            if (fn == 0) set_f(ctx, fd, a + b);
            else if (fn == 1) set_f(ctx, fd, a - b);
            else if (fn == 2) set_f(ctx, fd, a * b);
            else if (fn == 3) set_f(ctx, fd, a / b);
            else if (fn == 4) set_f(ctx, fd, sqrtf(a));
            else if (fn == 5) set_f(ctx, fd, fabsf(a));
            else if (fn == 6) ctx->fw[fd] = ctx->fw[fs];
            else if (fn == 7) set_f(ctx, fd, -a);
            else if (fn >= 12 && fn <= 15) ctx->fw[fd] = to_w(ctx, a, (int)(fn & 3));
            else if (fn >= 8 && fn <= 11) set_l(ctx, fd, to_l(ctx, a, (int)(fn & 3)));
            else if (fn == 36) ctx->fw[fd] = to_w(ctx, a, (int)ctx->fcr31);
            else if (fn == 37) set_l(ctx, fd, to_l(ctx, a, (int)ctx->fcr31));
            else if (fn == 33) set_d(ctx, fd, (double)a);
            else if (fn >= 48) fp_compare(ctx, a, b, (int)(fn & 7));
            else not_understood(ctx, pc);
        } else if (rs == 17) { /* double precision */
            double a = get_d(ctx, fs), b = get_d(ctx, ft);
            if (fn == 0) set_d(ctx, fd, a + b);
            else if (fn == 1) set_d(ctx, fd, a - b);
            else if (fn == 2) set_d(ctx, fd, a * b);
            else if (fn == 3) set_d(ctx, fd, a / b);
            else if (fn == 4) set_d(ctx, fd, sqrt(a));
            else if (fn == 5) set_d(ctx, fd, fabs(a));
            else if (fn == 6) set_l(ctx, fd, get_l(ctx, fs));
            else if (fn == 7) set_d(ctx, fd, -a);
            else if (fn >= 12 && fn <= 15) ctx->fw[fd] = to_w(ctx, a, (int)(fn & 3));
            else if (fn >= 8 && fn <= 11) set_l(ctx, fd, to_l(ctx, a, (int)(fn & 3)));
            else if (fn == 36) ctx->fw[fd] = to_w(ctx, a, (int)ctx->fcr31);
            else if (fn == 37) set_l(ctx, fd, to_l(ctx, a, (int)ctx->fcr31));
            else if (fn == 32) set_f(ctx, fd, (float)a);
            else if (fn >= 48) fp_compare(ctx, a, b, (int)(fn & 7));
            else not_understood(ctx, pc);
        } else if (rs == 20 && fn == 32) set_f(ctx, fd, (float)(int32_t)ctx->fw[fs]);
        else if (rs == 20 && fn == 33) set_d(ctx, fd, (double)(int32_t)ctx->fw[fs]);
        else if (rs == 21 && fn == 32) set_f(ctx, fd, (float)(int64_t)get_l(ctx, fs));
        else if (rs == 21 && fn == 33) set_d(ctx, fd, (double)(int64_t)get_l(ctx, fs));
        else not_understood(ctx, pc);
        break;
    }
    case 26: *T = do_ldl(ctx, at, t); break;
    case 27: *T = do_ldr(ctx, at, t); break;
    case 32: *T = S32((int8_t)rd8(ctx, at)); break;
    case 33: *T = S32((int16_t)rd16(ctx, at)); break;
    case 34: *T = do_lwl(ctx, at, t); break;
    case 35: *T = S32(rd32(ctx, at)); break;
    case 36: *T = rd8(ctx, at); break;
    case 37: *T = rd16(ctx, at); break;
    case 38: *T = do_lwr(ctx, at, t); break;
    case 39: *T = rd32(ctx, at); break;
    case 55: *T = rd64(ctx, at); break;
    case 40: wr8(ctx, at, (uint8_t)t); break;
    case 41: wr16(ctx, at, (uint16_t)t); break;
    case 42: do_swl(ctx, at, t); break;
    case 43: wr32(ctx, at, (uint32_t)t); break;
    case 44: do_sdl(ctx, at, t); break;
    case 45: do_sdr(ctx, at, t); break;
    case 46: do_swr(ctx, at, t); break;
    case 47: break; /* cache */
    case 49: ctx->fw[rt] = rd32(ctx, at); break;
    case 53: set_l(ctx, (int)rt, rd64(ctx, at)); break;
    case 57: wr32(ctx, at, ctx->fw[rt]); break;
    case 61: wr64(ctx, at, get_l(ctx, (int)rt)); break;
    case 63: wr64(ctx, at, t); break;
    default: not_understood(ctx, pc);
    }
    ctx->r[0] = 0; /* register 0 is always zero, whatever was written to it */
}

/* Is this a branch, jump or call? Those may not sit in a delay slot. */
static int changes_flow(uint32_t word) {
    uint32_t op = word >> 26, fn = word & 63, rs = (word >> 21) & 31;
    return op == 1 || (op >= 2 && op <= 7) || (op >= 20 && op <= 23) || (op == 0 && (fn == 8 || fn == 9)) ||
           (op == 17 && rs == 8);
}

static void delay_slot(Context *ctx, uint32_t pc) {
    uint32_t word = rd32(ctx, pc);
    if (changes_flow(word))
        trap(ctx, "jump inside a delay slot", pc);
    simple(ctx, word, pc);
}

static void call(Context *ctx, uint32_t target) {
    void (*function)(Context *) = native_function(ctx, target);
    if (function)
        function(ctx);
    else
        interpret(ctx, target);
}

/* Run the function at pc until it returns. */
void interpret(Context *ctx, uint32_t pc) {
    if (pc & 3)
        trap(ctx, "call to an address that is not code", pc);
    for (;;) {
        uint32_t word = rd32(ctx, pc);
        uint32_t op = word >> 26, rs = (word >> 21) & 31, rt = (word >> 16) & 31, fn = word & 63;
        uint64_t s = ctx->r[rs], t = ctx->r[rt];
        uint32_t branch_to = pc + 4 + ((uint32_t)(int32_t)(int16_t)word << 2);
        uint32_t jump_to = (pc & 0xF0000000) | (word & 0x03FFFFFF) << 2;
        int taken, likely = 0, is_call = 0;
        host_interpreted++;

        if (op == 0 && fn == 8) { /* jr: return, or a jump to wherever a register says */
            delay_slot(ctx, pc + 4);
            if (rs == 31)
                return;
            jump_to = (uint32_t)s;
            goto jump;
        } else if (op == 0 && fn == 9) { /* jalr: call through a register */
            ctx->r[(word >> 11) & 31] = S32(pc + 8);
            ctx->r[0] = 0;
            delay_slot(ctx, pc + 4);
            call(ctx, (uint32_t)s);
            pc += 8;
            continue;
        } else if (op == 2) { /* j */
            delay_slot(ctx, pc + 4);
            goto jump;
        } else if (op == 3) { /* jal: call */
            ctx->ra = S32(pc + 8);
            delay_slot(ctx, pc + 4);
            call(ctx, jump_to);
            pc += 8;
            continue;
        } else if (op == 4 || op == 20) taken = s == t, likely = op == 20;
        else if (op == 5 || op == 21) taken = s != t, likely = op == 21;
        else if (op == 6 || op == 22) taken = (int64_t)s <= 0, likely = op == 22;
        else if (op == 7 || op == 23) taken = (int64_t)s > 0, likely = op == 23;
        else if (op == 1 && (rt & 0x0C) == 0) taken = rt & 1 ? (int64_t)s >= 0 : (int64_t)s < 0, likely = rt >= 2;
        else if (op == 1 && rt >= 16 && rt <= 19) { /* "branch and link": a call to somewhere nearby */
            taken = rt & 1 ? (int64_t)s >= 0 : (int64_t)s < 0, likely = rt >= 18, is_call = 1;
            ctx->ra = S32(pc + 8);
        } else if (op == 17 && rs == 8) { /* branch on the last float comparison */
            taken = (ctx->fcr31 & FCR31_CONDITION) != 0;
            if (!(rt & 1))
                taken = !taken;
            likely = rt >= 2;
        } else if (op == 16 && rs >= 16 && fn == 24) {
            /* eret, "return from an interruption": carry on at the address
             * in control register 14. Start-up code sometimes uses it as a
             * plain jump, by putting the destination there first. */
            jump_to = (uint32_t)cop0_read(ctx, 14);
            goto jump;
        } else {
            if (op == 1)
                not_understood(ctx, pc);
            simple(ctx, word, pc);
            pc += 4;
            continue;
        }

        /* A branch. Its condition was decided above, before the delay slot
         * runs; a "likely" branch skips the delay slot when not taken. */
        if (taken || !likely)
            delay_slot(ctx, pc + 4);
        if (!taken) {
            pc += 8;
        } else if (is_call) {
            call(ctx, branch_to);
            pc += 8;
        } else {
            if (branch_to <= pc)
                LOOP_CHECK();
            pc = branch_to;
        }
        continue;

    jump:
        /* Jumping to the start of another function is a "tail call": that
         * function returns straight to whoever called this one. */
        {
            void (*function)(Context *) = native_function(ctx, jump_to);
            if (function) {
                function(ctx);
                return;
            }
        }
        if (jump_to & 3)
            trap(ctx, "jump to an address that is not code", jump_to);
        if (jump_to <= pc)
            LOOP_CHECK();
        pc = jump_to;
    }
}
