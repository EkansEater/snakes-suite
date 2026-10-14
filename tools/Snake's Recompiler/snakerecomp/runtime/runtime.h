/*
 * Support code for the recompiled game.
 *
 * Every recompiled function takes a Context: the state of the N64's CPU
 * (its registers) plus a pointer to the console's memory. The functions in
 * this file do the things that have no direct C equivalent, such as reading
 * big-endian memory or dividing the way a MIPS CPU does.
 */
#ifndef RUNTIME_H
#define RUNTIME_H

#include <math.h>
#include <stdint.h>
#include <string.h>

#define RAM_SIZE 0x800000 /* 8 MB */

typedef struct Context {
    /* General-purpose registers. They are 64 bits wide, but most game code
     * uses them as 32-bit values that are sign-extended to 64. */
    union {
        uint64_t r[32];
        struct {
            uint64_t zero, at, v0, v1, a0, a1, a2, a3;
            uint64_t t0, t1, t2, t3, t4, t5, t6, t7;
            uint64_t s0, s1, s2, s3, s4, s5, s6, s7;
            uint64_t t8, t9, k0, k1, gp, sp, fp, ra;
        };
    };
    uint64_t hi, lo; /* results of multiply and divide */
    /* Floating-point registers, stored as raw 32-bit patterns. A "double"
     * uses two neighbours: the even register holds the low half. */
    uint32_t fw[32];
    uint32_t fcr31; /* floating-point control: rounding mode, compare result */
    uint8_t *ram;
} Context;

/* Sign-extend a 32-bit result to 64 bits, as the CPU does. */
#define S32(x) ((uint64_t)(int64_t)(int32_t)(x))

/* Provided by whatever program hosts the recompiled code. */
void trap(Context *ctx, const char *reason, uint32_t address) __attribute__((noreturn));
uint64_t cop0_read(Context *ctx, int reg);
void cop0_write(Context *ctx, int reg, uint64_t value);
/* The four instructions that work the CPU's address-mapping table (the
 * "TLB"). which: 1 read an entry, 2 write one, 6 write a random one, 8 look
 * one up. */
void tlb_instruction(Context *ctx, int which);
/* Generated: call a function given only its address (function pointers). */
void call_indirect(Context *ctx, uint32_t address);
/* Generated: the translated function at an address, if there is one. */
void (*native_function(Context *ctx, uint32_t address))(Context *);
/* Run the function at an address straight from the game's memory, one
 * instruction at a time (interp.c). */
void interpret(Context *ctx, uint32_t pc);
extern long host_interpreted;

/* A recompiled loop cannot be interrupted from outside the way a real CPU
 * can, so every jump backwards counts down a budget. When it runs out the
 * host gets a chance to act as the console's timer interrupt would: announce
 * a screen refresh and let a more important thread run. */
#ifdef HOST_RUNTIME
extern long loop_budget;
extern const uint8_t *host_rom; /* the cartridge's contents */
/* For testing the translator: with INTERPRET_LOADED=1, code the game loads
 * itself is never run from its translation, only interpreted. If the game
 * then behaves differently, a translation is wrong (or was used when the
 * code in memory was not the code it was made from). */
extern int host_interpret_loaded_code;
void host_time_slice(Context *ctx);
/* (host_loop_where: which function was looping when the budget ran out, for
 * working out what a game spends its time on; see SHOW_LOOPS in host.c) */
extern const char *host_loop_where;
#define LOOP_CHECK() do { if (--loop_budget < 0) { host_loop_where = __func__; host_time_slice(ctx); } } while (0)
/* For working out what a game is up to: with TRACE_OS set, every call to a
 * library function we stand in for is printed. */
extern int host_trace;
void host_trace_call(Context *ctx, const char *name);
extern long host_calls; /* how many such calls there have been */
#define HLE_CALL(name) do { host_calls++; if (host_trace) host_trace_call(ctx, name); } while (0)
/* Code we have no translation of is interpreted instead. */
#define NOT_RECOMPILED(ctx, address) interpret(ctx, address)
/* Has something (a cheat) rewritten these instructions since the ROM was loaded? */
#define CODE_CHANGED(ctx, address, rom_offset, size) \
    (memcmp((ctx)->ram + ((address) & 0x7FFFFF), host_rom + (rom_offset), (size)) != 0)
#else
#define LOOP_CHECK() ((void)0)
#define NOT_RECOMPILED(ctx, address) trap(ctx, "function not recompiled", address)
#define HLE_CALL(name) ((void)0)
#define CODE_CHANGED(ctx, address, rom_offset, size) 0
#endif

/* ---- Memory ------------------------------------------------------------
 * Addresses 0x80000000-0x807FFFFF and 0xA0000000-0xA07FFFFF both refer to
 * RAM. The N64 is big-endian: the most significant byte is stored first. */

#ifdef HOST_RUNTIME
/* Other addresses can be mapped onto RAM by the game at run time (through
 * the CPU's "TLB"); the host keeps track of those mappings. */
uint8_t *host_mapped_memory(Context *ctx, uint32_t address, uint32_t size);
#endif

static inline uint8_t *mem(Context *ctx, uint32_t address, uint32_t size) {
    uint32_t physical = address & 0x1FFFFFFF;
    if (address >> 30 != 2 || physical > RAM_SIZE - size) {
#ifdef HOST_RUNTIME
        return host_mapped_memory(ctx, address, size);
#else
        trap(ctx, "bad memory access", address);
#endif
    }
    return ctx->ram + physical;
}

static inline uint8_t rd8(Context *ctx, uint32_t a) { return *mem(ctx, a, 1); }
static inline uint16_t rd16(Context *ctx, uint32_t a) {
    uint8_t *p = mem(ctx, a, 2);
    return (uint16_t)(p[0] << 8 | p[1]);
}
static inline uint32_t rd32(Context *ctx, uint32_t a) {
    uint8_t *p = mem(ctx, a, 4);
    return (uint32_t)p[0] << 24 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 8 | p[3];
}
static inline uint64_t rd64(Context *ctx, uint32_t a) {
    mem(ctx, a, 8);
    return (uint64_t)rd32(ctx, a) << 32 | rd32(ctx, a + 4);
}
static inline void wr8(Context *ctx, uint32_t a, uint8_t v) { *mem(ctx, a, 1) = v; }
static inline void wr16(Context *ctx, uint32_t a, uint16_t v) {
    uint8_t *p = mem(ctx, a, 2);
    p[0] = (uint8_t)(v >> 8);
    p[1] = (uint8_t)v;
}
static inline void wr32(Context *ctx, uint32_t a, uint32_t v) {
    uint8_t *p = mem(ctx, a, 4);
    p[0] = (uint8_t)(v >> 24);
    p[1] = (uint8_t)(v >> 16);
    p[2] = (uint8_t)(v >> 8);
    p[3] = (uint8_t)v;
}
static inline void wr64(Context *ctx, uint32_t a, uint64_t v) {
    mem(ctx, a, 8);
    wr32(ctx, a, (uint32_t)(v >> 32));
    wr32(ctx, a + 4, (uint32_t)v);
}

/* Unaligned access. Reading a 4-byte value from an address that is not a
 * multiple of 4 takes two instructions: one fetches the left part of the
 * value and the other the right part. */
static inline uint64_t do_lwl(Context *ctx, uint32_t a, uint64_t old) {
    uint32_t shift = (a & 3) * 8;
    uint32_t word = rd32(ctx, a & ~3u);
    uint32_t keep = shift ? (uint32_t)old & (0xFFFFFFFFu >> (32 - shift)) : 0;
    return S32(keep | word << shift);
}
static inline uint64_t do_lwr(Context *ctx, uint32_t a, uint64_t old) {
    uint32_t shift = (3 - (a & 3)) * 8;
    uint32_t word = rd32(ctx, a & ~3u);
    uint32_t keep = shift ? (uint32_t)old & (0xFFFFFFFFu << (32 - shift)) : 0;
    return S32(keep | word >> shift);
}
static inline void do_swl(Context *ctx, uint32_t a, uint64_t value) {
    uint32_t shift = (a & 3) * 8;
    uint32_t word = rd32(ctx, a & ~3u);
    uint32_t keep = shift ? word & (0xFFFFFFFFu << (32 - shift)) : 0;
    wr32(ctx, a & ~3u, keep | (uint32_t)value >> shift);
}
static inline void do_swr(Context *ctx, uint32_t a, uint64_t value) {
    uint32_t shift = (3 - (a & 3)) * 8;
    uint32_t word = rd32(ctx, a & ~3u);
    uint32_t keep = shift ? word & (0xFFFFFFFFu >> (32 - shift)) : 0;
    wr32(ctx, a & ~3u, keep | (uint32_t)value << shift);
}
static inline uint64_t do_ldl(Context *ctx, uint32_t a, uint64_t old) {
    uint32_t shift = (a & 7) * 8;
    uint64_t word = rd64(ctx, a & ~7u);
    uint64_t keep = shift ? old & (~0ull >> (64 - shift)) : 0;
    return keep | word << shift;
}
static inline uint64_t do_ldr(Context *ctx, uint32_t a, uint64_t old) {
    uint32_t shift = (7 - (a & 7)) * 8;
    uint64_t word = rd64(ctx, a & ~7u);
    uint64_t keep = shift ? old & (~0ull << (64 - shift)) : 0;
    return keep | word >> shift;
}
static inline void do_sdl(Context *ctx, uint32_t a, uint64_t value) {
    uint32_t shift = (a & 7) * 8;
    uint64_t word = rd64(ctx, a & ~7u);
    uint64_t keep = shift ? word & (~0ull << (64 - shift)) : 0;
    wr64(ctx, a & ~7u, keep | value >> shift);
}
static inline void do_sdr(Context *ctx, uint32_t a, uint64_t value) {
    uint32_t shift = (7 - (a & 7)) * 8;
    uint64_t word = rd64(ctx, a & ~7u);
    uint64_t keep = shift ? word & (~0ull >> (64 - shift)) : 0;
    wr64(ctx, a & ~7u, keep | value << shift);
}

/* ---- Multiply and divide -------------------------------------------------
 * Results go to the special HI and LO registers. Dividing by zero does not
 * crash a MIPS CPU; it leaves specific values behind, reproduced here. */

static inline void do_mult(Context *ctx, uint64_t a, uint64_t b) {
    int64_t p = (int64_t)(int32_t)a * (int64_t)(int32_t)b;
    ctx->lo = S32(p);
    ctx->hi = S32(p >> 32);
}
static inline void do_multu(Context *ctx, uint64_t a, uint64_t b) {
    uint64_t p = (uint64_t)(uint32_t)a * (uint64_t)(uint32_t)b;
    ctx->lo = S32(p);
    ctx->hi = S32(p >> 32);
}
static inline void do_div(Context *ctx, uint64_t a64, uint64_t b64) {
    int32_t a = (int32_t)a64, b = (int32_t)b64;
    if (b == 0) {
        ctx->lo = a < 0 ? 1 : ~0ull;
        ctx->hi = S32(a);
    } else if (a == INT32_MIN && b == -1) {
        ctx->lo = S32(a);
        ctx->hi = 0;
    } else {
        ctx->lo = S32(a / b);
        ctx->hi = S32(a % b);
    }
}
static inline void do_divu(Context *ctx, uint64_t a64, uint64_t b64) {
    uint32_t a = (uint32_t)a64, b = (uint32_t)b64;
    if (b == 0) {
        ctx->lo = ~0ull;
        ctx->hi = S32(a);
    } else {
        ctx->lo = S32(a / b);
        ctx->hi = S32(a % b);
    }
}
static inline void do_dmult(Context *ctx, uint64_t a, uint64_t b) {
    __int128 p = (__int128)(int64_t)a * (__int128)(int64_t)b;
    ctx->lo = (uint64_t)p;
    ctx->hi = (uint64_t)(p >> 64);
}
static inline void do_dmultu(Context *ctx, uint64_t a, uint64_t b) {
    unsigned __int128 p = (unsigned __int128)a * (unsigned __int128)b;
    ctx->lo = (uint64_t)p;
    ctx->hi = (uint64_t)(p >> 64);
}
static inline void do_ddiv(Context *ctx, uint64_t a64, uint64_t b64) {
    int64_t a = (int64_t)a64, b = (int64_t)b64;
    if (b == 0) {
        ctx->lo = a < 0 ? 1 : ~0ull;
        ctx->hi = a64;
    } else if (a == INT64_MIN && b == -1) {
        ctx->lo = a64;
        ctx->hi = 0;
    } else {
        ctx->lo = (uint64_t)(a / b);
        ctx->hi = (uint64_t)(a % b);
    }
}
static inline void do_ddivu(Context *ctx, uint64_t a, uint64_t b) {
    if (b == 0) {
        ctx->lo = ~0ull;
        ctx->hi = a;
    } else {
        ctx->lo = a / b;
        ctx->hi = a % b;
    }
}

/* ---- Floating point ---------------------------------------------------- */

static inline float get_f(Context *ctx, int n) {
    float f;
    memcpy(&f, &ctx->fw[n], 4);
    return f;
}
static inline void set_f(Context *ctx, int n, float v) { memcpy(&ctx->fw[n], &v, 4); }
/* Real code only uses even-numbered registers for 64-bit values; "& 31"
 * keeps nonsense input in bounds. */
static inline uint64_t get_l(Context *ctx, int n) {
    return (uint64_t)ctx->fw[(n + 1) & 31] << 32 | ctx->fw[n];
}
static inline void set_l(Context *ctx, int n, uint64_t v) {
    ctx->fw[n] = (uint32_t)v;
    ctx->fw[(n + 1) & 31] = (uint32_t)(v >> 32);
}
static inline double get_d(Context *ctx, int n) {
    uint64_t bits = get_l(ctx, n);
    double d;
    memcpy(&d, &bits, 8);
    return d;
}
static inline void set_d(Context *ctx, int n, double v) {
    uint64_t bits;
    memcpy(&bits, &v, 8);
    set_l(ctx, n, bits);
}

#define FCR31_CONDITION 0x00800000u /* result of the last float comparison */
#define FCR31_INVALID 0x00010040u   /* "that conversion did not fit" flags */

/* Round to a whole number. mode: 0 nearest, 1 toward zero, 2 up, 3 down. */
static inline double round_mode(double v, int mode) {
    switch (mode & 3) {
    case 0: return rint(v);
    case 1: return trunc(v);
    case 2: return ceil(v);
    default: return floor(v);
    }
}
static inline uint32_t to_w(Context *ctx, double v, int mode) {
    double r = round_mode(v, mode);
    if (!(r >= -2147483648.0 && r < 2147483648.0)) {
        ctx->fcr31 |= FCR31_INVALID;
        return 0x7FFFFFFFu;
    }
    return (uint32_t)(int32_t)r;
}
static inline uint64_t to_l(Context *ctx, double v, int mode) {
    double r = round_mode(v, mode);
    if (!(r >= -9223372036854775808.0 && r < 9223372036854775808.0)) {
        ctx->fcr31 |= FCR31_INVALID;
        return 0x7FFFFFFFFFFFFFFFull;
    }
    return (uint64_t)(int64_t)r;
}

/* Comparison. cond bits: 1 = true if unordered (either value is NaN),
 * 2 = true if equal, 4 = true if less than. */
static inline void fp_compare(Context *ctx, double a, double b, int cond) {
    int result;
    if (isnan(a) || isnan(b))
        result = cond & 1;
    else
        result = ((cond & 2) && a == b) || ((cond & 4) && a < b);
    ctx->fcr31 = (ctx->fcr31 & ~FCR31_CONDITION) | (result ? FCR31_CONDITION : 0);
}

#endif
