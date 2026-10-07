/*
 * Test harness: runs recompiled functions from given starting states and
 * reports what each one did, so the results can be compared against the
 * interpreter's.
 *
 * usage: harness <ram image> <tests file> <results file>
 */
#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>

#include "functions.h"

static jmp_buf escape;

void trap(Context *ctx, const char *reason, uint32_t address) {
    (void)ctx, (void)address;
    /* 2 = reached a function the recompiler could not translate. */
    longjmp(escape, strcmp(reason, "function not recompiled") == 0 ? 2 : 1);
}
uint64_t cop0_read(Context *ctx, int reg) {
    (void)ctx, (void)reg;
    return 0;
}
void cop0_write(Context *ctx, int reg, uint64_t value) { (void)ctx, (void)reg, (void)value; }

int main(int argc, char **argv) {
    if (argc != 4)
        return 2;
    uint8_t *base = malloc(RAM_SIZE), *ram = malloc(RAM_SIZE);
    FILE *in = fopen(argv[1], "rb");
    if (!in || fread(base, 1, RAM_SIZE, in) != RAM_SIZE)
        return 2;
    fclose(in);
    in = fopen(argv[2], "rb");
    FILE *out = fopen(argv[3], "wb");
    if (!in || !out)
        return 2;

    uint32_t address;
    while (fread(&address, 4, 1, in) == 1) {
        Context ctx = {0};
        ctx.ram = ram;
        memcpy(ram, base, RAM_SIZE);
        if (fread(ctx.r, 8, 32, in) != 32 || fread(ctx.fw, 4, 32, in) != 32)
            return 2;

        uint8_t status = (uint8_t)setjmp(escape);
        if (status == 0)
            call_indirect(&ctx, address);
        fwrite(&status, 1, 1, out);
        fwrite(ctx.r, 8, 32, out);
        fwrite(&ctx.hi, 8, 1, out);
        fwrite(&ctx.lo, 8, 1, out);
        fwrite(ctx.fw, 4, 32, out);
        fwrite(&ctx.fcr31, 4, 1, out);
        /* List every byte of memory the function changed. */
        uint32_t count = 0;
        for (uint32_t i = 0; i < RAM_SIZE; i++)
            count += ram[i] != base[i];
        fwrite(&count, 4, 1, out);
        for (uint32_t i = 0; i < RAM_SIZE; i++)
            if (ram[i] != base[i]) {
                fwrite(&i, 4, 1, out);
                fwrite(&ram[i], 1, 1, out);
            }
    }
    fclose(out);
    return 0;
}
