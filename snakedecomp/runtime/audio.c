/*
 * Sound: carries out the game's audio command lists.
 *
 * The game does not play sounds itself. About 60 times a second it writes a
 * list of commands for the N64's signal-processing chip, each working on a
 * small scratch memory inside the chip:
 *
 *   load some compressed sound data into scratch memory
 *   decompress it (the format is called ADPCM)
 *   change its pitch (play it faster or slower)
 *   mix it into the left and right outputs at some volume
 *   ... repeat for every note that is playing ...
 *   interleave left and right and save the result back to the game's memory
 *
 * The game then hands that finished block of samples to the sound output.
 * Here each command is an ordinary C function. Samples are 16-bit numbers,
 * big-endian like everything else on the N64, and are left that way in the
 * scratch memory so that loading and saving are plain copies.
 */
#include "audio.h"

#include <string.h>

#define RAM_MASK 0x7FFFFF
#define SCRATCH_SIZE 0x1000 /* offsets in commands are relative to this memory */
#define GUARD 0x100         /* some commands read a little before their input */

static uint8_t *ram;
/* A game whose sound program we do not know sends commands that mean
 * something else to us, with lengths far beyond anything real. Rather than
 * check every one, the working memory has room after it for the longest
 * length a command can carry, so the worst a wrong command does is make
 * noise. */
#define SLACK 0x30000
static uint8_t memory[GUARD + SCRATCH_SIZE + SLACK];
static uint8_t *const scratch = memory + GUARD;

/* Settings left behind by earlier commands for later ones to use. */
static struct {
    uint32_t in, out, count;          /* main input, output, byte count */
    uint32_t dry_right, wet_left, wet_right; /* extra outputs for mixing */
    int16_t volume[2], target[2];
    int32_t rate[2];
    int16_t dry_gain, wet_gain;
    uint32_t loop_state;
    /* the newer dialect's volume settings: plain 16-bit levels and steps */
    uint16_t level[2], step[2], wet_level, wet_step;
    int16_t codebook[8][2][8];        /* ADPCM prediction tables */
} state;

/* The pitch-changing filter: for each of 64 positions between two samples,
 * how much of the four nearest samples to blend. It is read from the game's
 * own data (the chip's program carries it), not stored in this file. */
static int16_t filter[64][4];
static int filter_found;

enum { FLAG_INIT = 1, FLAG_LOOP = 2, FLAG_LEFT = 2, FLAG_VOLUME = 4, FLAG_AUX = 8 };

/* ---- Reading and writing 16-bit samples ------------------------------------ */

static inline int16_t get16(const uint8_t *p) { return (int16_t)(p[0] << 8 | p[1]); }
static inline void put16(uint8_t *p, int value) { p[0] = (uint8_t)(value >> 8), p[1] = (uint8_t)value; }
static inline int32_t get32(const uint8_t *p) {
    return (int32_t)((uint32_t)p[0] << 24 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 8 | p[3]);
}
static inline void put32(uint8_t *p, int32_t v) {
    p[0] = (uint8_t)(v >> 24), p[1] = (uint8_t)(v >> 16), p[2] = (uint8_t)(v >> 8), p[3] = (uint8_t)v;
}
static inline int clamp16(int x) { return x < -32768 ? -32768 : x > 32767 ? 32767 : x; }
static inline int32_t clamp32(int64_t x) {
    return x < INT32_MIN ? INT32_MIN : x > INT32_MAX ? INT32_MAX : (int32_t)x;
}

static uint8_t *game(uint32_t address) { return ram + (address & RAM_MASK); }
static uint8_t *at(uint32_t offset) { return scratch + (offset & (SCRATCH_SIZE - 1)); }
static uint32_t round_up(uint32_t n, uint32_t to) { return (n + to - 1) & ~(to - 1); }

/* ---- Decompression (ADPCM) -----------------------------------------------------
 * Sound is stored at about a quarter of its size. Each 9-byte block holds 16
 * samples: one header byte, then 4 bits per sample. Those 4 bits are not the
 * sample but a correction to a prediction made from the two samples before
 * it, using one of several prediction tables chosen by the header. */

static void decode_adpcm(int flags, uint32_t memory_address) {
    uint8_t *in = at(state.in), *out = at(state.out);
    int remaining = (int)round_up(state.count, 32);
    uint8_t *saved = game(memory_address); /* the last 16 samples of the previous call */

    if (flags & FLAG_INIT)
        memset(out, 0, 32);
    else if (flags & FLAG_LOOP)
        memcpy(out, game(state.loop_state), 32);
    else
        memcpy(out, saved, 32);
    out += 32;

    while (remaining > 0) {
        int shift = *in >> 4, table = *in++ & 15;
        int16_t (*book)[8] = state.codebook[table & 7];
        for (int half = 0; half < 2; half++) {
            int corrections[8];
            int previous1 = get16(out - 2), previous2 = get16(out - 4);
            for (int j = 0; j < 4; j++) {
                int high = *in >> 4, low = *in++ & 15;
                corrections[j * 2] = (high >= 8 ? high - 16 : high) << shift;
                corrections[j * 2 + 1] = (low >= 8 ? low - 16 : low) << shift;
            }
            for (int j = 0; j < 8; j++) {
                int total = book[0][j] * previous2 + book[1][j] * previous1 + (corrections[j] << 11);
                for (int k = 0; k < j; k++)
                    total += book[1][j - k - 1] * corrections[k];
                put16(out, clamp16(total >> 11));
                out += 2;
            }
        }
        remaining -= 32;
    }
    memcpy(saved, out - 32, 32);
}

/* ---- Pitch change (resampling) -------------------------------------------------
 * To play a sound higher, step through it faster than one sample at a time;
 * lower, slower. The position lands between samples, so each output is a
 * blend of the four samples around it. pitch 0x8000 means original speed. */

static void resample(int flags, uint32_t pitch, uint32_t memory_address) {
    uint8_t *saved = game(memory_address);
    uint8_t *in_start = at(state.in), *in = in_start, *out = at(state.out);
    int remaining = (int)round_up(state.count, 16);
    uint8_t previous[32];

    if (flags & FLAG_INIT)
        memset(previous, 0, sizeof previous);
    else
        memcpy(previous, saved, sizeof previous);
    if (flags & 2) {
        memcpy(in - 16, previous + 16, 16);
        in -= (get16(previous + 10) / 2) * 2;
    }
    in -= 8;
    /* (The step back above comes from what the last call remembered. From
     * a sound program we do not know, it can be anything; never let it
     * take us out of our working memory.) */
    if (in < memory + 16 || in > scratch + SCRATCH_SIZE)
        in = memory + 16;
    uint32_t position = (uint16_t)get16(previous + 8); /* fraction of a sample, 16 bits */
    memcpy(in, previous, 8);

    do {
        for (int i = 0; i < 8; i++) {
            const int16_t *blend = filter[position * 64 >> 16];
            int sample = 0;
            for (int tap = 0; tap < 4; tap++)
                sample += (get16(in + tap * 2) * blend[tap] + 0x4000) >> 15;
            put16(out, clamp16(sample));
            out += 2;
            position += pitch << 1;
            in += (position >> 16) * 2;
            position &= 0xFFFF;
        }
        remaining -= 16;
    } while (remaining > 0);

    /* Remember where we stopped, for the next call to carry on smoothly. */
    put16(saved + 8, (int)position);
    memcpy(saved, in, 8);
    int offset = (int)(((in - in_start) / 2 + 4) & 7);
    in -= offset * 2;
    if (offset != 0)
        offset = -8 - offset;
    put16(saved + 10, offset * 2);
    memcpy(saved + 16, in, 16);
}

/* ---- Volume and mixing ("envelope mixer") ---------------------------------------
 * Adds one sound into the left and right outputs. The volume glides toward
 * a target rather than jumping, which avoids clicks. With FLAG_AUX the sound
 * also goes to a second pair of outputs used for the echo effect. */

static void envelope_mix(int flags, uint32_t memory_address) {
    uint8_t *saved = game(memory_address);
    uint8_t *in = at(state.in);
    uint8_t *dry[2] = {at(state.out), at(state.dry_right)};
    uint8_t *wet[2] = {at(state.wet_left), at(state.wet_right)};
    int remaining = (int)round_up(state.count, 16);
    int target[2], dry_gain, wet_gain;
    int32_t rate[2], volumes[2][8];

    if (flags & FLAG_INIT) {
        dry_gain = state.dry_gain, wet_gain = state.wet_gain;
        for (int c = 0; c < 2; c++) {
            target[c] = state.target[c], rate[c] = state.rate[c];
            int32_t step = state.volume[c] * (rate[c] - 0x10000) / 8;
            for (int i = 0; i < 8; i++)
                volumes[c][i] = clamp32((int64_t)state.volume[c] * 65536 + (int64_t)step * (i + 1));
        }
    } else {
        for (int c = 0; c < 2; c++) {
            for (int i = 0; i < 8; i++)
                volumes[c][i] = get32(saved + c * 32 + i * 4);
            target[c] = get16(saved + 64 + c * 6);
            rate[c] = get32(saved + 66 + c * 6);
        }
        dry_gain = get16(saved + 76), wet_gain = get16(saved + 78);
    }

    do {
        for (int c = 0; c < 2; c++) {
            for (int i = 0; i < 8; i++) {
                int32_t *volume = &volumes[c][i];
                /* stop gliding once the target is reached */
                if ((rate[c] >> 16) > 0 ? (*volume >> 16) > target[c] : (*volume >> 16) < target[c])
                    *volume = target[c] * 65536;
                int sample = get16(in + i * 2), level = *volume >> 16;
                put16(dry[c] + i * 2, clamp16((get16(dry[c] + i * 2) * 0x7FFF +
                                               sample * ((level * dry_gain + 0x4000) >> 15) + 0x4000) >> 15));
                if (flags & FLAG_AUX)
                    put16(wet[c] + i * 2, clamp16((get16(wet[c] + i * 2) * 0x7FFF +
                                                   sample * ((level * wet_gain + 0x4000) >> 15) + 0x4000) >> 15));
                *volume = clamp32((int64_t)*volume * rate[c] >> 16);
            }
            dry[c] += 16, wet[c] += 16;
        }
        remaining -= 16, in += 16;
    } while (remaining > 0);

    for (int c = 0; c < 2; c++) {
        for (int i = 0; i < 8; i++)
            put32(saved + c * 32 + i * 4, volumes[c][i]);
        put16(saved + 64 + c * 6, target[c]);
        put32(saved + 66 + c * 6, rate[c]);
    }
    put16(saved + 76, dry_gain), put16(saved + 78, wet_gain);
}

/* The newer dialect's version of the same job (used by later games). The
 * volume is a plain level that changes by a fixed step every 8 samples. */
static void envelope_mix_new(uint32_t w0, uint32_t w1) {
    uint8_t *in = at(((w0 >> 16) & 255) << 4);
    uint8_t *dry[2] = {at((w1 >> 24) << 4), at(((w1 >> 16) & 255) << 4)};
    uint8_t *wet[2] = {at(((w1 >> 8) & 255) << 4), at((w1 & 255) << 4)};
    int flip[2] = {(w0 & 2) ? -1 : 0, (w0 & 1) ? -1 : 0};
    int other[2] = {(w0 & 4) ? 1 : 0, (w0 & 4) ? 0 : 1}; /* swap sides for the echo */
    uint16_t level[2] = {state.level[0], state.level[1]}, wet_level = state.wet_level;

    for (int remaining = (int)round_up((w0 >> 8) & 255, 16); remaining > 0; remaining -= 8) {
        for (int i = 0; i < 8; i++, in += 2) {
            int samples[2];
            for (int c = 0; c < 2; c++)
                samples[c] = (int16_t)((get16(in) * level[c] >> 16) ^ flip[c]);
            for (int c = 0; c < 2; c++) {
                put16(dry[c], clamp16(get16(dry[c]) + samples[c]));
                put16(wet[c], clamp16(get16(wet[c]) + (samples[other[c]] * wet_level >> 16)));
                dry[c] += 2, wet[c] += 2;
            }
        }
        level[0] += state.step[0], level[1] += state.step[1], wet_level += state.wet_step;
    }
}

/* Add one scratch buffer into another at a fixed gain. */
static void mix(int gain, uint32_t in_offset, uint32_t out_offset, uint32_t count) {
    uint8_t *in = at(in_offset), *out = at(out_offset);
    for (int remaining = (int)round_up(count, 32); remaining > 0; remaining -= 2, in += 2, out += 2) {
        int sample = gain == -32768 ? get16(out) - get16(in)
                                    : (get16(out) * 0x7FFF + get16(in) * gain + 0x4000) >> 15;
        put16(out, clamp16(sample));
    }
}

/* Weave separate left and right buffers into left, right, left, right... */
static void interleave(uint32_t left_offset, uint32_t right_offset) {
    uint8_t *left = at(left_offset), *right = at(right_offset), *out = at(state.out);
    for (int remaining = (int)round_up(state.count, 16); remaining > 0; remaining -= 2) {
        memcpy(out, left, 2), memcpy(out + 2, right, 2);
        left += 2, right += 2, out += 4;
    }
}

/* ---- Finding the filter table ---------------------------------------------------
 * It is 64 rows of 4 numbers; each row adds up to about 1.0 (32768) and the
 * table reads the same backwards. That is distinctive enough to search for. */

static void find_filter(uint32_t data_address, uint32_t data_size) {
    for (uint32_t offset = 0; offset + 512 <= data_size; offset += 2) {
        const uint8_t *t = game(data_address + offset);
        int ok = 1;
        for (int row = 0; row < 32 && ok; row++) {
            int sum = 0;
            for (int tap = 0; tap < 4; tap++) {
                sum += get16(t + (row * 4 + tap) * 2);
                ok &= get16(t + (row * 4 + tap) * 2) == get16(t + ((63 - row) * 4 + 3 - tap) * 2);
            }
            ok &= sum > 32600 && sum < 32900;
        }
        if (ok) {
            for (int i = 0; i < 256; i++)
                filter[i / 4][i % 4] = get16(t + i * 2);
            filter_found = 1;
            return;
        }
    }
}

/* ---- The command loop -------------------------------------------------------- */

void audio_init(uint8_t *game_ram) { ram = game_ram; }

void audio_run(uint32_t commands, uint32_t size, uint32_t chip_data, uint32_t chip_data_size) {
    if (!filter_found) {
        find_filter(chip_data, chip_data_size);
        if (!filter_found)
            return; /* without it we cannot change pitch; stay silent */
    }
    const uint8_t *p = game(commands);
    /* Two dialects of these commands exist. The newer one is recognised by
     * commands the older one does not have; a few shared command numbers
     * then pack their details differently. */
    static int newer;
    for (uint32_t i = 0; i + 8 <= size && !newer; i += 8)
        newer = p[i] >= 0x12 && p[i] <= 0x16;
    for (uint32_t i = 0; i + 8 <= size; i += 8, p += 8) {
        uint32_t w0 = (uint32_t)get32(p), w1 = (uint32_t)get32(p + 4);
        int flags = (int)((w0 >> 16) & 255);
        switch (w0 >> 24) {
        case 1: decode_adpcm(flags, w1); break;
        case 2: memset(at(w0 & 0xFFFF), 0, round_up(w1 & 0xFFFF, 16)); break;
        case 3: envelope_mix(flags, w1); break;
        case 4: memcpy(at(state.in), game(w1), round_up(state.count, 8)); break;
        case 5: resample(flags, w0 & 0xFFFF, w1); break;
        case 6: memcpy(game(w1), at(state.out), round_up(state.count, 8)); break;
        case 8: /* choose which scratch buffers the next commands use */
            if (flags & FLAG_AUX) {
                state.dry_right = w0 & 0xFFFF, state.wet_left = w1 >> 16, state.wet_right = w1 & 0xFFFF;
            } else {
                state.in = w0 & 0xFFFF, state.out = w1 >> 16, state.count = w1 & 0xFFFF;
                if (state.count > 0x4000) /* (no real block of sound is this long) */
                    state.count = 0x4000;
            }
            break;
        case 9: { /* volume settings, several kinds packed into one command */
            int16_t value = (int16_t)w0, high = (int16_t)(w1 >> 16), low = (int16_t)w1;
            int channel = (flags & FLAG_LEFT) ? 0 : 1;
            if (flags & FLAG_AUX) {
                state.dry_gain = value, state.wet_gain = low;
            } else if (flags & FLAG_VOLUME) {
                state.volume[channel] = value;
            } else {
                state.target[channel] = value;
                state.rate[channel] = (int32_t)((uint32_t)(uint16_t)high << 16 | (uint16_t)low);
            }
            break;
        }
        case 10: memmove(at(w1 >> 16), at(w0 & 0xFFFF), round_up(w1 & 0xFFFF, 16)); break;
        case 11: { /* load ADPCM prediction tables */
            const uint8_t *book = game(w1);
            uint32_t count = (w0 & 0xFFFF) / 2;
            for (uint32_t n = 0; n < count && n < 128; n++)
                state.codebook[n / 16][(n / 8) & 1][n & 7] = get16(book + n * 2);
            break;
        }
        case 12:
            mix((int16_t)w0, w1 >> 16, w1 & 0xFFFF, newer ? ((w0 >> 16) & 255) << 4 : state.count);
            break;
        case 0x12: /* echo level and the volume steps */
            /* The low half of the first word is NOT a step for the echo
             * level, though a later dialect uses it that way. Watching the
             * values a game sends shows it simply repeats the low bytes of
             * the two volumes. Treating it as a step made the echo level
             * jump wildly eight samples at a time: loud static. */
            state.wet_level = (uint16_t)(((w0 >> 16) & 255) << 8), state.wet_step = 0;
            state.step[0] = (uint16_t)(w1 >> 16), state.step[1] = (uint16_t)w1;
            break;
        case 0x16: state.level[0] = (uint16_t)(w1 >> 16), state.level[1] = (uint16_t)w1; break;
        case 0x13: envelope_mix_new(w0, w1); break;
        case 0x14: memcpy(at(w0 & 0xFFFF), game(w1), ((w0 >> 16) & 255) << 4); break; /* load */
        case 0x15: memcpy(game(w1), at(w0 & 0xFFFF), ((w0 >> 16) & 255) << 4); break; /* save */
        case 13: interleave(w1 >> 16, w1 & 0xFFFF); break;
        case 15: state.loop_state = w1; break;
        }
    }
}
