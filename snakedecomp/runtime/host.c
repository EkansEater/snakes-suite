/*
 * The host: a PC program that runs the recompiled game.
 *
 * The game's own code was translated to C, but that code expects to be
 * running on an N64, under Nintendo's small operating system ("libultra").
 * It asks that OS to start threads, pass messages between them, read from
 * the cartridge, show a picture, and so on. The OS did those things by
 * poking at hardware we do not have.
 *
 * So every OS function the game calls is replaced here by a function named
 * hle_<name> that achieves the same result on a PC. (The recompiler finds
 * them by that name.) Anything not replaced runs as recompiled code.
 *
 * usage: game <rom file> [options]
 *   --frames N          stop after N screen refreshes (default: run until closed)
 *   --scale N           draw at N times the console's 320x240 (default 3)
 *   --save FILE         where saved games are kept
 *   --wide              16:9 picture instead of the original 4:3
 *   --smooth            60 pictures a second instead of the game's 30
 *   --headless          no window (for testing)
 *   --screenshots DIR   write a picture file every --every N frames
 *   --stats             start with the statistics display on
 *   --keys LIST         scripted input: frame:buttons:duration[:x:y],...
 *   --wav FILE          record the sound to a file
 */
#define _XOPEN_SOURCE 700
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <ucontext.h>
#include <unistd.h>
#ifdef USE_SDL
#include <SDL.h>

#include "gfx_gl.h"
#endif

#include "audio.h"
#include "gfx.h"
#include "functions.h"

static uint8_t *ram, *rom;
static size_t rom_size;

static void fatal(const char *what, uint32_t value) {
    fprintf(stderr, "host: %s (0x%08X)\n", what, value);
    exit(1);
}

/* ---- Reading and writing the game's memory from the host --------------- */

/* Mappings the game has set up from other addresses onto RAM. Each "TLB
 * entry" covers two neighbouring pages. */
#define TLB_ENTRIES 32
static struct { uint32_t start, size, physical; } tlb[TLB_ENTRIES * 2];

static uint8_t *mapped(uint32_t address, uint32_t size) {
    for (int i = 0; i < TLB_ENTRIES * 2; i++) {
        uint32_t offset = address - tlb[i].start;
        if (tlb[i].size && offset < tlb[i].size && size <= tlb[i].size - offset &&
            tlb[i].physical + offset <= RAM_SIZE - size)
            return ram + tlb[i].physical + offset;
    }
    return NULL;
}

static uint8_t *guest(uint32_t address, uint32_t size) {
    uint32_t physical = address & 0x1FFFFFFF;
    if (address >> 30 != 2 || physical > RAM_SIZE - size) {
        uint8_t *p = mapped(address, size);
        if (!p)
            fatal("host touched a bad game address", address);
        return p;
    }
    return ram + physical;
}
static uint32_t g32(uint32_t a) {
    uint8_t *p = guest(a, 4);
    return (uint32_t)p[0] << 24 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 8 | p[3];
}
static void w32(uint32_t a, uint32_t v) {
    uint8_t *p = guest(a, 4);
    p[0] = (uint8_t)(v >> 24), p[1] = (uint8_t)(v >> 16), p[2] = (uint8_t)(v >> 8), p[3] = (uint8_t)v;
}
static void w16(uint32_t a, uint16_t v) {
    uint8_t *p = guest(a, 2);
    p[0] = (uint8_t)(v >> 8), p[1] = (uint8_t)v;
}

/* Function arguments: the first four are in registers a0-a3, the rest are
 * on the stack. The return value goes in v0. */
#define ARG0 ((uint32_t)ctx->a0)
#define ARG1 ((uint32_t)ctx->a1)
#define ARG2 ((uint32_t)ctx->a2)
#define ARG3 ((uint32_t)ctx->a3)
#define STACK_ARG(n) g32((uint32_t)ctx->sp + 4 * (n)) /* n = 4 is the fifth argument */
#define RETURN(x) (ctx->v0 = S32(x))

/* ---- Threads -------------------------------------------------------------
 * The game runs several threads (game logic, sound, a coordinator...). On
 * the N64 only one runs at a time: the highest-priority one that is not
 * waiting for something. We reproduce exactly that. Each game thread gets
 * its own set of CPU registers (a Context) and its own stack on the PC, and
 * a scheduler switches between them with swapcontext(). */

typedef enum { STOPPED, RUNNABLE, WAITING, DEAD } State;

typedef struct Thread {
    uint32_t guest_address; /* the game's own record of this thread */
    int id, priority;
    State state;
    uint32_t wait_queue; /* message queue it is waiting on, if WAITING */
    int wait_to_send;
    uint32_t entry;
    uint64_t turn; /* threads of equal priority take turns, oldest first */
    Context ctx;
    ucontext_t uc;
} Thread;

#define MAX_THREADS 32
#define NATIVE_STACK_SIZE (4 << 20)
#define THREAD_RETURN_ADDRESS 0x8FFFFFF0u

static Thread threads[MAX_THREADS];
static int thread_count;
static Thread *current;
static ucontext_t scheduler;
static uint64_t turn_counter;

static void make_runnable(Thread *t) {
    t->state = RUNNABLE;
    t->turn = ++turn_counter;
}

/* Give control back to the scheduler. The thread resumes here later. */
static void switch_away(void) { swapcontext(&current->uc, &scheduler); }

/* A priority-0 thread is the game's "idle thread": an endless empty loop
 * for the CPU to sit in when there is nothing to do. We never run it; when
 * nothing else can run, the scheduler moves time forward instead. */
static Thread *pick_thread(void) {
    Thread *best = NULL;
    for (int i = 0; i < thread_count; i++) {
        Thread *t = &threads[i];
        if (t->state != RUNNABLE || t->priority <= 0)
            continue;
        if (!best || t->priority > best->priority ||
            (t->priority == best->priority && t->turn < best->turn))
            best = t;
    }
    return best;
}

/* If a more important thread just became ready, let it run right away. */
static void preempt_check(void) {
    Thread *best = pick_thread();
    if (best && best != current && best->priority > current->priority)
        switch_away();
}

static void thread_main(int index) {
    Thread *t = &threads[index];
    call_indirect(&t->ctx, t->entry);
    t->state = DEAD;
    switch_away();
}

static Thread *new_thread(uint32_t guest_address, int id, int priority, uint32_t entry) {
    if (thread_count == MAX_THREADS)
        fatal("too many threads", (uint32_t)thread_count);
    Thread *t = &threads[thread_count];
    memset(t, 0, sizeof *t);
    t->guest_address = guest_address, t->id = id, t->priority = priority, t->entry = entry;
    t->state = STOPPED;
    t->ctx.ram = ram;
    t->ctx.ra = S32(THREAD_RETURN_ADDRESS);
    getcontext(&t->uc);
    t->uc.uc_stack.ss_sp = malloc(NATIVE_STACK_SIZE);
    t->uc.uc_stack.ss_size = NATIVE_STACK_SIZE;
    t->uc.uc_link = &scheduler;
    makecontext(&t->uc, (void (*)(void))thread_main, 1, thread_count);
    thread_count++;
    return t;
}

static Thread *find_thread(uint32_t guest_address) {
    if (guest_address == 0)
        return current; /* the game passes NULL to mean "this thread" */
    for (int i = 0; i < thread_count; i++)
        if (threads[i].guest_address == guest_address && threads[i].state != DEAD)
            return &threads[i];
    fatal("unknown thread", guest_address);
    return NULL;
}

/* The game's OSThread record: priority at +4, id at +0x14. */
void hle_osCreateThread(Context *ctx) {
    Thread *t = new_thread(ARG0, (int)ARG1, (int)STACK_ARG(5), ARG2);
    t->ctx.a0 = S32(ARG3);
    t->ctx.sp = S32(STACK_ARG(4) - 16);
    w32(ARG0 + 4, (uint32_t)t->priority);
    w32(ARG0 + 0x14, ARG1);
}
void hle_osStartThread(Context *ctx) {
    Thread *t = find_thread(ARG0);
    if (t->state == STOPPED)
        make_runnable(t);
    preempt_check();
}
void hle_osStopThread(Context *ctx) {
    Thread *t = find_thread(ARG0);
    t->state = STOPPED;
    if (t == current)
        switch_away();
}
void hle_osDestroyThread(Context *ctx) {
    Thread *t = find_thread(ARG0);
    t->state = DEAD;
    if (t == current)
        switch_away();
}
void hle_osYieldThread(Context *ctx) {
    (void)ctx;
    make_runnable(current); /* go to the back of the queue */
    switch_away();
}
void hle_osSetThreadPri(Context *ctx) {
    Thread *t = find_thread(ARG0);
    t->priority = (int)ARG1;
    w32(t->guest_address + 4, ARG1);
    switch_away(); /* priorities changed: let the scheduler choose again */
}
void hle_osGetThreadPri(Context *ctx) { RETURN(find_thread(ARG0)->priority); }
void hle_osGetThreadId(Context *ctx) { RETURN(find_thread(ARG0)->id); }

/* ---- Message queues --------------------------------------------------------
 * Threads talk by posting 4-byte messages to queues. Receiving from an empty
 * queue (or sending to a full one) puts the thread to sleep until that
 * changes. The queue itself lives in the game's memory:
 *   +0x08 number of messages waiting   +0x0C index of the oldest one
 *   +0x10 capacity                     +0x14 address of the message array */

#define MQ_VALID(q) ((q) + 0x08)
#define MQ_FIRST(q) ((q) + 0x0C)
#define MQ_CAPACITY(q) ((q) + 0x10)
#define MQ_MESSAGES(q) ((q) + 0x14)

static void wake_one(uint32_t queue, int senders) {
    Thread *best = NULL;
    for (int i = 0; i < thread_count; i++) {
        Thread *t = &threads[i];
        if (t->state == WAITING && t->wait_queue == queue && t->wait_to_send == senders &&
            (!best || t->priority > best->priority))
            best = t;
    }
    if (best)
        make_runnable(best);
}

static void wait_on(uint32_t queue, int to_send) {
    current->state = WAITING;
    current->wait_queue = queue;
    current->wait_to_send = to_send;
    switch_away();
}

/* Put a message on a queue if there is room. front: jump the queue. */
static int queue_put(uint32_t queue, uint32_t message, int front) {
    uint32_t valid = g32(MQ_VALID(queue)), capacity = g32(MQ_CAPACITY(queue));
    uint32_t first = g32(MQ_FIRST(queue));
    if (valid >= capacity)
        return 0;
    uint32_t slot;
    if (front) {
        slot = (first + capacity - 1) % capacity;
        w32(MQ_FIRST(queue), slot);
    } else {
        slot = (first + valid) % capacity;
    }
    w32(g32(MQ_MESSAGES(queue)) + 4 * slot, message);
    w32(MQ_VALID(queue), valid + 1);
    wake_one(queue, 0);
    return 1;
}

static void send(Context *ctx, int front) {
    while (!queue_put(ARG0, ARG1, front)) {
        if (!ARG2) { /* caller did not want to wait */
            RETURN(-1);
            return;
        }
        wait_on(ARG0, 1);
    }
    RETURN(0);
    preempt_check();
}
void hle_osSendMesg(Context *ctx) { send(ctx, 0); }
void hle_osJamMesg(Context *ctx) { send(ctx, 1); }

void hle_osRecvMesg(Context *ctx) {
    uint32_t queue = ARG0;
    while (g32(MQ_VALID(queue)) == 0) {
        if (!ARG2) {
            RETURN(-1);
            return;
        }
        wait_on(queue, 0);
    }
    uint32_t first = g32(MQ_FIRST(queue));
    if (ARG1)
        w32(ARG1, g32(g32(MQ_MESSAGES(queue)) + 4 * first));
    w32(MQ_FIRST(queue), (first + 1) % g32(MQ_CAPACITY(queue)));
    w32(MQ_VALID(queue), g32(MQ_VALID(queue)) - 1);
    wake_one(queue, 1);
    RETURN(0);
    preempt_check();
}

/* ---- Events ----------------------------------------------------------------
 * Hardware tells the game things ("the screen finished drawing", "the
 * graphics chip is done") through interrupts, which the OS turns into
 * messages on whichever queue the game registered for that event. */

enum { EVENT_SP = 4, EVENT_SI = 5, EVENT_DP = 9, EVENT_COUNT = 15 };
static struct { uint32_t queue, message; } events[EVENT_COUNT];

static void post_event(int event) {
    if (events[event].queue)
        queue_put(events[event].queue, events[event].message, 0);
}
void hle_osSetEventMesg(Context *ctx) {
    if (ARG0 >= EVENT_COUNT)
        fatal("unknown event", ARG0);
    events[ARG0].queue = ARG1;
    events[ARG0].message = ARG2;
}

/* ---- Start-up -------------------------------------------------------------- */

void hle_osInitialize(Context *ctx) { (void)ctx; }

/* ---- Video -----------------------------------------------------------------
 * Nothing is drawn yet. We keep track of which picture the game wants shown
 * and tick the "screen refreshed" event 60 times a (virtual) second. */

static uint32_t vi_queue, vi_message, framebuffer;
static long frames;

void hle_osCreateViManager(Context *ctx) { (void)ctx; }
void hle_osViSetMode(Context *ctx) { (void)ctx; }
void hle_osViBlack(Context *ctx) { (void)ctx; }
void hle_osViSetSpecialFeatures(Context *ctx) { (void)ctx; }
void hle_osViSetEvent(Context *ctx) { vi_queue = ARG0, vi_message = ARG1; }
void hle_osViSwapBuffer(Context *ctx) { framebuffer = ARG0; }
void hle_osViGetCurrentFramebuffer(Context *ctx) { RETURN(framebuffer); }
void hle_osViGetNextFramebuffer(Context *ctx) { RETURN(framebuffer); }

/* One screen refresh: 1/60 of a second of console time passes. */
#define LOOP_BUDGET_PER_FRAME 200000
long loop_budget = LOOP_BUDGET_PER_FRAME;
static uint64_t ticks;
#define TICKS_PER_FRAME (46875000 / 60)

static void present_frame(void); /* further down: window, input, screenshots */
static void run_timers(void);

static long forced_frames;

static void next_frame(void) {
    frames++;
    ticks += TICKS_PER_FRAME;
    loop_budget = LOOP_BUDGET_PER_FRAME;
    present_frame();
    run_timers();
    if (vi_queue)
        queue_put(vi_queue, vi_message, 0);
}

/* Called from recompiled code when a thread has been looping for about a
 * frame's worth of work without ever waiting. */
void host_time_slice(Context *ctx) {
    (void)ctx;
    forced_frames++;
    next_frame();
    preempt_check();
}

/* ---- Time ------------------------------------------------------------------ */

/* Timers: "post this message after this long, and optionally keep
 * repeating". Times are in ticks of the console's 46.875 MHz clock. They are
 * checked once per screen refresh, which is as finely as our clock moves. */
#define MAX_TIMERS 32
static struct { uint64_t due, interval; uint32_t queue, message; } timers[MAX_TIMERS];

void hle_osSetTimer(Context *ctx) {
    /* 64-bit arguments take two slots each: countdown, then the repeat interval */
    uint64_t countdown = (uint64_t)ARG2 << 32 | ARG3;
    uint64_t interval = (uint64_t)STACK_ARG(4) << 32 | STACK_ARG(5);
    for (int i = 0; i < MAX_TIMERS; i++)
        if (timers[i].queue == 0) {
            timers[i].due = ticks + (countdown ? countdown : interval);
            timers[i].interval = interval;
            timers[i].queue = STACK_ARG(6), timers[i].message = STACK_ARG(7);
            break;
        }
    RETURN(0);
}

static void run_timers(void) {
    for (int i = 0; i < MAX_TIMERS; i++)
        while (timers[i].queue && timers[i].due <= ticks) {
            queue_put(timers[i].queue, timers[i].message, 0);
            if (timers[i].interval)
                timers[i].due += timers[i].interval;
            else
                timers[i].queue = 0;
        }
}

void hle_osGetTime(Context *ctx) {
    ticks += 100;
    ctx->v0 = S32(ticks >> 32); /* 64-bit results come back in two registers */
    ctx->v1 = S32(ticks);
}
void hle_osGetCount(Context *ctx) {
    ticks += 100;
    RETURN(ticks);
}

/* ---- Cartridge -------------------------------------------------------------
 * "DMA" = the game asking for a block of the ROM to be copied into memory.
 * On the console this takes a while and a message announces completion; here
 * the copy is instant and the message is posted straight away. */

static long dma_count, dma_bytes;

void hle_osCreatePiManager(Context *ctx) { (void)ctx; }
void hle_osPiStartDma(Context *ctx) {
    uint32_t request = ARG0, rom_address = ARG3;
    uint32_t destination = STACK_ARG(4), size = STACK_ARG(5), reply_queue = STACK_ARG(6);
    if (ARG2 != 0)
        fatal("game tried to write to the cartridge", rom_address);
    if (rom_address > rom_size || size > rom_size - rom_address)
        fatal("read past the end of the ROM", rom_address);
    memcpy(guest(destination, size), rom + rom_address, size);
    dma_count++, dma_bytes += size;
    queue_put(reply_queue, request, 0);
    RETURN(0);
    preempt_check();
}

/* ---- Graphics and audio chip tasks --------------------------------------------
 * Each frame the game builds a "display list" (a list of drawing commands)
 * and hands it to the graphics chip; our renderer (gfx.c) draws it instead.
 * Audio command lists go to the same chip. Those are not played yet: we
 * just report them finished so the game carries on. */

static long graphics_tasks, audio_tasks;
static int smooth_motion;
/* Pictures drawn and waiting to be shown, one per screen refresh. */
static int shown_queue[2], shown_count, shown_next;

static double draw_ms_total, draw_ms_worst; /* time spent drawing pictures */
/* the same, but only for the current second (for the on-screen statistics) */
static double second_draw_ms, second_draw_worst;
static int second_pictures;
static int sound_muted, speed_limit = 1;

void hle_osSpTaskLoad(Context *ctx) { (void)ctx; }
void hle_osSpTaskStartGo(Context *ctx) {
    uint32_t type = g32(ARG0); /* 1 = graphics, 2 = audio */
    if (type == 1) {
        graphics_tasks++;
        struct timespec t0, t1;
        clock_gettime(CLOCK_MONOTONIC, &t0);
        /* Which dialect of drawing commands? The chip program's data block
         * (+0x18) carries its name as text. */
        static int dialect_known;
        if (!dialect_known) {
            const char *data = (const char *)guest(g32(ARG0 + 0x18), 0x800);
            int f3dex = 0;
            for (int i = 0; i + 5 < 0x800; i++)
                f3dex |= !memcmp(data + i, "F3DEX", 5) || !memcmp(data + i, "F3DLX", 5);
            gfx_set_extended(f3dex);
            dialect_known = 1;
        }
        int made = gfx_run(g32(ARG0 + 0x30), smooth_motion); /* +0x30: the display list */
        shown_count = shown_next = 0;
        if (made == 2)
            shown_queue[shown_count++] = 0; /* the in-between picture first */
        shown_queue[shown_count++] = 1;

        clock_gettime(CLOCK_MONOTONIC, &t1);
        double ms = (double)(t1.tv_sec - t0.tv_sec) * 1e3 + (double)(t1.tv_nsec - t0.tv_nsec) / 1e6;
        draw_ms_total += ms;
        second_draw_ms += ms, second_pictures++;
        if (ms > second_draw_worst)
            second_draw_worst = ms;
        if (ms > draw_ms_worst)
            draw_ms_worst = ms;
    } else {
        audio_tasks++;
        /* +0x30/+0x34: the command list; +0x18/+0x1C: the chip program's data */
        audio_run(g32(ARG0 + 0x30), g32(ARG0 + 0x34), g32(ARG0 + 0x18), g32(ARG0 + 0x1C));
    }
    post_event(EVENT_SP);
    if (type == 1)
        post_event(EVENT_DP);
}
void hle_osSpTaskYield(Context *ctx) { (void)ctx; }
void hle_osSpTaskYielded(Context *ctx) { RETURN(0); }

/* ---- Sound output ---------------------------------------------------------------
 * The game hands over finished blocks of samples (16-bit, stereo). They are
 * queued for the sound card. The game asks how much is still waiting to be
 * played and makes a little more or less next time, which keeps it in step
 * with the sound card's clock. */

#define SOUND_CUSHION_BYTES 6400 /* 50 ms of 16-bit stereo at 32 kHz */
static FILE *wav_file;
static long wav_bytes, sound_blocks, sound_gaps, sound_skipped;
#ifdef USE_SDL
static SDL_AudioDeviceID audio_device;
#endif
static int headless;

void hle_osAiSetFrequency(Context *ctx) {
#ifdef USE_SDL
    if (!headless && !audio_device && SDL_InitSubSystem(SDL_INIT_AUDIO) == 0) {
        SDL_AudioSpec want = {0};
        want.freq = (int)ARG0, want.format = AUDIO_S16SYS, want.channels = 2, want.samples = 512;
        audio_device = SDL_OpenAudioDevice(NULL, 0, &want, NULL, 0);
        if (audio_device)
            SDL_PauseAudioDevice(audio_device, 0);
        else
            fprintf(stderr, "host: no sound: %s\n", SDL_GetError());
    }
#endif
    RETURN(ARG0);
}
void hle_osAiSetNextBuffer(Context *ctx) {
    uint32_t size = ARG1 & ~3u;
    if (size == 0 || size > 0x8000) {
        RETURN(0);
        return;
    }
    /* The game's samples are big-endian; the PC wants them the other way. */
    static int16_t samples[0x4000];
    const uint8_t *source = guest(ARG0, size);
    for (uint32_t i = 0; i < size / 2; i++)
        samples[i] = (int16_t)(source[i * 2] << 8 | source[i * 2 + 1]);
    if (wav_file)
        wav_bytes += (long)fwrite(samples, 1, size, wav_file);
#ifdef USE_SDL
    /* If far too much is waiting (the game ran ahead), skip this block
     * rather than let the sound fall further and further behind. */
    if (audio_device && !sound_muted) {
        uint32_t waiting = SDL_GetQueuedAudioSize(audio_device);
        sound_blocks++;
        if (waiting == 0 && sound_blocks > 1)
            sound_gaps++; /* the sound card ran out: an audible gap */
        if (waiting < 32000)
            SDL_QueueAudio(audio_device, samples, size);
        else
            sound_skipped++;
    }
#endif
    RETURN(0);
}
void hle_osAiGetLength(Context *ctx) {
#ifdef USE_SDL
    if (audio_device) {
        /* The game tries to keep only a few milliseconds waiting, which a
         * console can manage but a PC cannot: any hiccup and the sound card
         * runs dry. So we under-report, and the game keeps that much extra
         * queued without knowing. */
        uint32_t waiting = SDL_GetQueuedAudioSize(audio_device);
        RETURN(waiting > SOUND_CUSHION_BYTES ? (waiting - SOUND_CUSHION_BYTES) & ~3u : 0);
        return;
    }
#endif
    RETURN(0);
}
void hle_osAiGetStatus(Context *ctx) { RETURN(0); }

/* ---- Controllers and save data ------------------------------------------------
 * Controllers and the cartridge's save chip are reached through one small
 * chip, the PIF. The OS library fills a 64-byte block with requests ("port
 * 1: which buttons are held?", "save chip: read block 3"), hands it to the
 * PIF, and later asks for the block back with the answers filled in.
 *
 * Rather than replace each OS function that does this (there are many, and
 * they differ between games), we play the part of the PIF itself and let
 * the game's own OS code run unchanged on top.
 *
 * One controller is plugged in; its state comes from the keyboard or a
 * gamepad once per frame (see present_frame). The save chip is a file. */

static uint16_t pad_buttons;
static int8_t pad_x, pad_y;

#define EEPROM_SIZE 512
static uint8_t eeprom[EEPROM_SIZE];
static const char *save_path;

static void save_eeprom(void) {
    FILE *file = save_path ? fopen(save_path, "wb") : NULL;
    if (file) {
        fwrite(eeprom, 1, EEPROM_SIZE, file);
        fclose(file);
    }
}

/* Answer one request. channel 0-3 are the controller ports, 4 the save
 * chip. Returns 0 if nothing is connected there. */
static int pif_request(int channel, const uint8_t *request, int request_size, uint8_t *answer, int answer_size) {
    if (request_size < 1)
        return 0;
    uint8_t command = request[0];
    if (channel == 0) {
        if ((command == 0x00 || command == 0xFF) && answer_size >= 3) { /* what are you? */
            answer[0] = 0x05, answer[1] = 0x00; /* a standard controller */
            answer[2] = 0x02;                   /* with nothing in its expansion slot */
            return 1;
        }
        if (command == 0x01 && answer_size >= 4) { /* buttons and stick */
            answer[0] = (uint8_t)(pad_buttons >> 8), answer[1] = (uint8_t)pad_buttons;
            answer[2] = (uint8_t)pad_x, answer[3] = (uint8_t)pad_y;
            return 1;
        }
        return 0; /* anything else is for an expansion-slot accessory we do not have */
    }
    if (channel == 4) {
        if ((command == 0x00 || command == 0xFF) && answer_size >= 3) {
            answer[0] = 0x00, answer[1] = 0x80, answer[2] = 0x00; /* the 512-byte kind */
            return 1;
        }
        if (command == 0x04 && request_size >= 2 && answer_size >= 8 && request[1] < EEPROM_SIZE / 8) {
            memcpy(answer, eeprom + request[1] * 8, 8); /* read one 8-byte block */
            return 1;
        }
        if (command == 0x05 && request_size >= 10 && answer_size >= 1 && request[1] < EEPROM_SIZE / 8) {
            memcpy(eeprom + request[1] * 8, request + 2, 8); /* write one block */
            answer[0] = 0;
            save_eeprom();
            return 1;
        }
    }
    return 0;
}

static uint8_t pif[64];

/* Walk the block: each request is [bytes to send][bytes wanted back][the
 * bytes sent][room for the answer]. 0x00 skips a channel, 0xFE ends. */
static void pif_process(void) {
    int channel = 0;
    for (int i = 0; i < 63 && channel < 6;) {
        int send = pif[i];
        if (send == 0xFE)
            break;
        if (send == 0xFF || send == 0xFD) {
            i++;
        } else if (send == 0x00) {
            channel++, i++;
        } else {
            send &= 0x3F;
            int want = pif[i + 1] & 0x3F;
            if (i + 2 + send + want > 63)
                break;
            if (!pif_request(channel, &pif[i + 2], send, &pif[i + 2 + send], want))
                pif[i + 1] |= 0x80; /* "no response" */
            i += 2 + send + want;
            channel++;
        }
    }
    pif[63] = 0;
}

/* The OS's lowest-level "exchange a block with the PIF" function. */
void hle___osSiRawStartDma(Context *ctx) {
    if (ARG0 == 1) { /* write: hand over the requests */
        memcpy(pif, guest(ARG1, 64), 64);
    } else { /* read: collect the answers */
        pif_process();
        memcpy(guest(ARG1, 64), pif, 64);
    }
    post_event(EVENT_SI); /* "done" */
    RETURN(0);
}
void hle___osSiDeviceBusy(Context *ctx) { RETURN(0); }
void hle___osSiRawReadIo(Context *ctx) {
    w32(ARG1, 0);
    RETURN(0);
}
void hle___osSiRawWriteIo(Context *ctx) { RETURN(0); }

/* ---- Memory mapping ---------------------------------------------------------- */

void hle_osMapTLB(Context *ctx) {
    uint32_t index = ARG0, page_size = (ARG1 + 0x2000) / 2, start = ARG2;
    uint32_t even = ARG3, odd = STACK_ARG(4); /* 0xFFFFFFFF = leave unmapped */
    if (index >= TLB_ENTRIES)
        fatal("bad TLB index", index);
    tlb[index * 2].start = start;
    tlb[index * 2].size = even == 0xFFFFFFFFu ? 0 : page_size;
    tlb[index * 2].physical = even;
    tlb[index * 2 + 1].start = start + page_size;
    tlb[index * 2 + 1].size = odd == 0xFFFFFFFFu ? 0 : page_size;
    tlb[index * 2 + 1].physical = odd;
}
void hle_osUnmapTLBAll(Context *ctx) {
    (void)ctx;
    memset(tlb, 0, sizeof tlb);
}
void hle_osVirtualToPhysical(Context *ctx) {
    uint32_t address = ARG0;
    if (address >> 30 == 2) {
        RETURN(address & 0x1FFFFFFF);
        return;
    }
    uint8_t *p = mapped(address, 1);
    RETURN(p ? (uint32_t)(p - ram) : 0xFFFFFFFFu);
}
uint8_t *host_mapped_memory(Context *ctx, uint32_t address, uint32_t size) {
    uint8_t *p = mapped(address, size);
    if (!p)
        trap(ctx, "bad memory access", address);
    return p;
}

void hle_osSetIntMask(Context *ctx) { RETURN(0); }

/* ---- Things recompiled code needs from us ---------------------------------- */

void trap(Context *ctx, const char *reason, uint32_t address) {
    fprintf(stderr, "\ngame stopped: %s at 0x%08X\n", reason, address);
    fprintf(stderr, "  thread %d, return address 0x%08X, frame %ld\n",
            current ? current->id : -1, (uint32_t)ctx->ra, frames);
    exit(1);
}
uint64_t cop0_read(Context *ctx, int reg) {
    (void)ctx, (void)reg;
    return 0;
}
void cop0_write(Context *ctx, int reg, uint64_t value) { (void)ctx, (void)reg, (void)value; }

/* ---- Window, input, screenshots ------------------------------------------------ */

enum { /* the N64 controller's buttons, as bits */
    BTN_A = 0x8000, BTN_B = 0x4000, BTN_Z = 0x2000, BTN_START = 0x1000,
    BTN_DUP = 0x0800, BTN_DDOWN = 0x0400, BTN_DLEFT = 0x0200, BTN_DRIGHT = 0x0100,
    BTN_L = 0x0020, BTN_R = 0x0010,
    BTN_CUP = 0x0008, BTN_CDOWN = 0x0004, BTN_CLEFT = 0x0002, BTN_CRIGHT = 0x0001,
};
#define STICK_MAX 80

static long max_frames = -1;
/* How much wider than the original the visible scene is. Game-specific code
 * (the games/ folder) uses it to keep objects at the sides from vanishing. */
float host_view_widen = 1;
static float base_view_widen = 1;
static int screenshot_every = 60;
static float look_test_yaw;
static int start_with_stats;
static long screenshot_from;
static const char *screenshot_dir;

/* Scripted input, for testing without a person at the keyboard. */
static struct { long start, duration; int buttons, x, y; } script[64];
static int script_count;

static void write_screenshot(int which) {
    int w, h;
    const uint32_t *pixels = gfx_picture(which, &w, &h);
    char path[512];
    snprintf(path, sizeof path, "%s/frame_%06ld.ppm", screenshot_dir, frames);
    FILE *file = fopen(path, "wb");
    if (!file)
        return;
    fprintf(file, "P6\n%d %d\n255\n", w, h);
    for (int i = 0; i < w * h; i++) {
        uint8_t rgb[3] = {(uint8_t)(pixels[i] >> 16), (uint8_t)(pixels[i] >> 8), (uint8_t)pixels[i]};
        fwrite(rgb, 1, 3, file);
    }
    fclose(file);
}

#ifdef USE_SDL
static SDL_Window *window;
static float look_yaw, look_pitch, look_zoom = 1;
static SDL_GameController *gamepad;
static Uint64 next_frame_time;
static long late_refreshes;
static double latest_ms;

static float current_aspect = 4.0f / 3;
static int current_scale = 3;

static void open_window(void) {
    if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_GAMECONTROLLER) != 0)
        fatal(SDL_GetError(), 0);
    int w, h;
    gfx_picture(1, &w, &h);
    /* Ask for a window we can draw into with the graphics card (OpenGL 3.3). */
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 3);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_CORE);
    window = SDL_CreateWindow("Snake's Decompiler", SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED,
                              720 * w / h, 720, SDL_WINDOW_RESIZABLE | SDL_WINDOW_OPENGL);
    if (!window || !SDL_GL_CreateContext(window))
        fatal(SDL_GetError(), 0);
    SDL_GL_SetSwapInterval(0); /* we keep time ourselves (wait_for_next_frame) */
    glb_init();

    /* Controllers are opened as SDL announces them (see the event loop),
     * which covers ones already connected as well as ones that turn up later. */
    next_frame_time = SDL_GetPerformanceCounter();
}

/* ---- On-screen menu and statistics ---------------------------------------------
 * F1 opens a menu of settings that can be changed while the game runs; F3
 * shows live statistics in the top-left corner. Both are drawn by the PC on
 * top of the game's picture, and the game knows nothing about them. */

static int menu_open, menu_row, stats_shown;

/* Text is sized relative to the window so it stays readable. */
static int text_size(void) {
    int w, h;
    SDL_GL_GetDrawableSize(window, &w, &h);
    return h >= 1300 ? 3 : h >= 650 ? 2 : 1;
}

static void draw_box(int x, int y, int w, int h, int opacity) { glb_overlay_box(x, y, w, h, opacity); }

static void draw_text(int x, int y, const char *text, int r, int g, int b) {
    glb_overlay_text(x, y, text, text_size(), r, g, b);
}

/* The statistics are worked out once a second. */
static struct {
    Uint64 since;
    int refreshes, shown;
    double cpu_seconds_before;
    char lines[7][80];
    int line_count;
} stats;

static double cpu_seconds_used(void) {
    struct timespec t;
    clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &t); /* total over all our threads */
    return (double)t.tv_sec + (double)t.tv_nsec / 1e9;
}

/* How busy the graphics card is, if the system will tell us (-1 if not).
 * This is for the whole computer, not just this program. */
static int gpu_busy_percent(void) {
    static const char *places[] = {"/sys/class/drm/card0/device/gpu_busy_percent",
                                   "/sys/class/drm/card1/device/gpu_busy_percent",
                                   "/sys/class/drm/card2/device/gpu_busy_percent"};
    for (int i = 0; i < 3; i++) {
        FILE *file = fopen(places[i], "r");
        int percent = -1;
        if (file) {
            if (fscanf(file, "%d", &percent) != 1)
                percent = -1;
            fclose(file);
            if (percent >= 0)
                return percent;
        }
    }
    return -1;
}

static void update_stats(int showed_picture) {
    Uint64 now = SDL_GetPerformanceCounter(), frequency = SDL_GetPerformanceFrequency();
    stats.refreshes++, stats.shown += showed_picture;
    if (stats.since == 0)
        stats.since = now, stats.cpu_seconds_before = cpu_seconds_used();
    double elapsed = (double)(now - stats.since) / (double)frequency;
    if (elapsed < 1)
        return;

    int w, h, cores = (int)sysconf(_SC_NPROCESSORS_ONLN), gpu = gpu_busy_percent();
    gfx_picture(1, &w, &h);
    double cpu = (cpu_seconds_used() - stats.cpu_seconds_before) / elapsed * 100;
    static long triangles_before;
    long triangles = second_pictures ? (gfx_triangle_count - triangles_before) / second_pictures : 0;
    triangles_before = gfx_triangle_count;

    stats.line_count = 0;
#define LINE(...) snprintf(stats.lines[stats.line_count++], sizeof stats.lines[0], __VA_ARGS__)
    LINE("Shown  %4.1f pictures/s  (game makes %.1f/s)", stats.shown / elapsed, second_pictures / elapsed);
    LINE("Speed  %4.0f%%  (%.1f refreshes/s of 60)", stats.refreshes / elapsed / 60 * 100, stats.refreshes / elapsed);
    LINE("Draw   %4.1f ms average, %.1f worst", second_pictures ? second_draw_ms / second_pictures : 0.0,
         second_draw_worst);
    LINE("CPU    %4.0f%% of one core  (%.0f%% of all %d)", cpu, cpu / cores, cores);
    if (gpu >= 0)
        LINE("GPU    %4d%% (whole system)", gpu);
    else
        LINE("GPU    not reported by this system");
    LINE("Size   %dx%d, %ld triangles per picture", w, h, triangles);
    LINE("Sound  %u ms queued, %ld gaps; %ld late refreshes",
         audio_device ? SDL_GetQueuedAudioSize(audio_device) / 128 : 0, sound_gaps, late_refreshes);
#undef LINE
    stats.since = now, stats.refreshes = stats.shown = 0;
    stats.cpu_seconds_before = cpu_seconds_used();
    second_draw_ms = second_draw_worst = 0, second_pictures = 0;
}

enum { ROW_WIDE, ROW_SMOOTH, ROW_SCALE, ROW_STATS, ROW_SOUND, ROW_LIMIT, ROW_LOOK, ROW_COUNT };

static void apply_picture_settings(void) {
    gfx_resize(current_scale, current_aspect);
    base_view_widen = current_aspect / (4.0f / 3);
    shown_count = shown_next = 0;
    int w, h, window_w, window_h;
    gfx_picture(1, &w, &h);
    SDL_GetWindowSize(window, &window_w, &window_h);
    SDL_SetWindowSize(window, window_h * w / h, window_h); /* keep the height, fix the shape */
}

static void menu_change(int direction) {
    switch (menu_row) {
    case ROW_WIDE:
        current_aspect = current_aspect > 1.5f ? 4.0f / 3 : 16.0f / 9;
        apply_picture_settings();
        break;
    case ROW_SMOOTH: smooth_motion = !smooth_motion; break;
    case ROW_SCALE:
        current_scale += direction;
        current_scale = current_scale < 1 ? 1 : current_scale > 6 ? 6 : current_scale;
        apply_picture_settings();
        break;
    case ROW_STATS: stats_shown = !stats_shown; break;
    case ROW_SOUND:
        sound_muted = !sound_muted;
        if (audio_device)
            SDL_ClearQueuedAudio(audio_device);
        break;
    case ROW_LIMIT: speed_limit = !speed_limit; break;
    case ROW_LOOK: look_yaw = look_pitch = 0, look_zoom = 1; break;
    }
}

static void draw_overlay(void) {
    int size = text_size(), line = 18 * size;
    if (stats_shown && stats.line_count) {
        draw_box(4 * size, 4 * size, 49 * 8 * size, stats.line_count * line + 6 * size, 150);
        for (int i = 0; i < stats.line_count; i++)
            draw_text(8 * size, 7 * size + i * line, stats.lines[i], 120, 255, 120);
    }
    if (!menu_open)
        return;
    int w, h;
    gfx_picture(1, &w, &h);
    char rows[ROW_COUNT][64];
    snprintf(rows[ROW_WIDE], 64, "Widescreen (16:9)        %s", current_aspect > 1.5f ? "ON" : "off");
    snprintf(rows[ROW_SMOOTH], 64, "Smooth motion (60 fps)   %s", smooth_motion ? "ON" : "off");
    snprintf(rows[ROW_SCALE], 64, "Resolution             < %dx >  %dx%d", current_scale, w, h);
    snprintf(rows[ROW_STATS], 64, "Statistics display       %s", stats_shown ? "ON" : "off");
    snprintf(rows[ROW_SOUND], 64, "Sound                    %s", sound_muted ? "off" : "ON");
    snprintf(rows[ROW_LIMIT], 64, "Speed limit (60 Hz)      %s", speed_limit ? "ON" : "off");
    snprintf(rows[ROW_LOOK], 64, "Reset free look");
    int window_w, window_h;
    SDL_GL_GetDrawableSize(window, &window_w, &window_h);
    int box_w = 46 * 8 * size, box_h = (ROW_COUNT + 4) * line;
    int x = (window_w - box_w) / 2, y = (window_h - box_h) / 2;
    draw_box(x, y, box_w, box_h, 235);
    draw_text(x + 8 * size, y + 6 * size, "SETTINGS", 255, 255, 255);
    for (int i = 0; i < ROW_COUNT; i++) {
        int selected = i == menu_row;
        draw_text(x + 8 * size, y + (i + 2) * line - 6 * size, selected ? ">" : " ", 255, 220, 60);
        draw_text(x + 24 * size, y + (i + 2) * line - 6 * size, rows[i], selected ? 255 : 200,
                  selected ? 220 : 200, selected ? 60 : 200);
    }
    draw_text(x + 8 * size, y + (ROW_COUNT + 2) * line + 2 * size,
              "Up/Down choose  Left/Right change  F1/Select", 150, 150, 150);
}

/* A key was pressed: is it one of ours? */
static void overlay_key(SDL_Scancode key) {
    if (key == SDL_SCANCODE_F1)
        menu_open = !menu_open;
    else if (key == SDL_SCANCODE_F3)
        stats_shown = !stats_shown;
    else if (menu_open && key == SDL_SCANCODE_UP)
        menu_row = (menu_row + ROW_COUNT - 1) % ROW_COUNT;
    else if (menu_open && key == SDL_SCANCODE_DOWN)
        menu_row = (menu_row + 1) % ROW_COUNT;
    else if (menu_open && (key == SDL_SCANCODE_LEFT || key == SDL_SCANCODE_RIGHT || key == SDL_SCANCODE_RETURN))
        menu_change(key == SDL_SCANCODE_LEFT ? -1 : 1);
}

static void read_keyboard_and_gamepad(void) {
    SDL_Event event;
    while (SDL_PollEvent(&event)) {
        if (event.type == SDL_QUIT ||
            (event.type == SDL_KEYDOWN && event.key.keysym.scancode == SDL_SCANCODE_ESCAPE))
            exit(0);
        if (event.type == SDL_KEYDOWN && !event.key.repeat)
            overlay_key(event.key.keysym.scancode);

        /* Controllers can be plugged in, or connect over Bluetooth, at any
         * time. SDL tells us when one arrives or leaves. */
        if (event.type == SDL_CONTROLLERDEVICEADDED && !gamepad) {
            gamepad = SDL_GameControllerOpen(event.cdevice.which);
            if (gamepad)
                printf("controller connected: %s\n", SDL_GameControllerName(gamepad));
        }
        if (event.type == SDL_CONTROLLERDEVICEREMOVED && gamepad &&
            event.cdevice.which == SDL_JoystickInstanceID(SDL_GameControllerGetJoystick(gamepad))) {
            printf("controller disconnected\n");
            SDL_GameControllerClose(gamepad);
            gamepad = NULL;
            for (int i = 0; i < SDL_NumJoysticks() && !gamepad; i++) /* fall back to another, if any */
                if (SDL_IsGameController(i))
                    gamepad = SDL_GameControllerOpen(i);
        }
        /* On a controller, Select opens the menu; inside it the d-pad
         * moves, A changes the setting and B closes. */
        if (event.type == SDL_CONTROLLERBUTTONDOWN) {
            switch (event.cbutton.button) {
            case SDL_CONTROLLER_BUTTON_BACK: overlay_key(SDL_SCANCODE_F1); break;
            case SDL_CONTROLLER_BUTTON_DPAD_UP: overlay_key(SDL_SCANCODE_UP); break;
            case SDL_CONTROLLER_BUTTON_DPAD_DOWN: overlay_key(SDL_SCANCODE_DOWN); break;
            case SDL_CONTROLLER_BUTTON_DPAD_LEFT: overlay_key(SDL_SCANCODE_LEFT); break;
            case SDL_CONTROLLER_BUTTON_DPAD_RIGHT:
            case SDL_CONTROLLER_BUTTON_A: overlay_key(SDL_SCANCODE_RIGHT); break;
            case SDL_CONTROLLER_BUTTON_B:
                if (menu_open)
                    menu_open = 0;
                break;
            }
        }
        /* Free look: hold the right mouse button and move to turn the view,
         * wheel to zoom, middle button to put it back. */
        if (event.type == SDL_MOUSEMOTION && (event.motion.state & SDL_BUTTON_RMASK)) {
            look_yaw += (float)event.motion.xrel * 0.004f;
            look_pitch += (float)event.motion.yrel * 0.004f;
            if (look_pitch > 1.4f) look_pitch = 1.4f;
            if (look_pitch < -1.4f) look_pitch = -1.4f;
        }
        if (event.type == SDL_MOUSEWHEEL) {
            look_zoom *= event.wheel.y > 0 ? 1.1f : 1 / 1.1f;
            if (look_zoom < 0.5f) look_zoom = 0.5f;
            if (look_zoom > 8) look_zoom = 8;
        }
        if (event.type == SDL_MOUSEBUTTONDOWN && event.button.button == SDL_BUTTON_MIDDLE)
            look_yaw = look_pitch = 0, look_zoom = 1;
    }
    gfx_set_view(look_yaw, look_pitch, look_zoom);
    /* While looking around, tell the game to keep far more in view. */
    host_view_widen = (look_yaw != 0 || look_pitch != 0 || look_zoom < 1) ? 20 : base_view_widen;

    const Uint8 *key = SDL_GetKeyboardState(NULL);
    int buttons = 0, x = 0, y = 0;
    static const struct { int scancode, button; } keys[] = {
        {SDL_SCANCODE_J, BTN_A}, {SDL_SCANCODE_K, BTN_B}, {SDL_SCANCODE_L, BTN_Z},
        {SDL_SCANCODE_LSHIFT, BTN_Z}, {SDL_SCANCODE_RETURN, BTN_START}, {SDL_SCANCODE_SPACE, BTN_A},
        {SDL_SCANCODE_UP, BTN_CUP}, {SDL_SCANCODE_DOWN, BTN_CDOWN},
        {SDL_SCANCODE_LEFT, BTN_CLEFT}, {SDL_SCANCODE_RIGHT, BTN_CRIGHT},
        {SDL_SCANCODE_Q, BTN_L}, {SDL_SCANCODE_E, BTN_R},
    };
    for (size_t i = 0; i < sizeof keys / sizeof keys[0]; i++)
        if (key[keys[i].scancode])
            buttons |= keys[i].button;
    x = (key[SDL_SCANCODE_D] ? STICK_MAX : 0) - (key[SDL_SCANCODE_A] ? STICK_MAX : 0);
    y = (key[SDL_SCANCODE_W] ? STICK_MAX : 0) - (key[SDL_SCANCODE_S] ? STICK_MAX : 0);

    if (gamepad) {
        static const struct { SDL_GameControllerButton pad; int button; } pad_map[] = {
            {SDL_CONTROLLER_BUTTON_A, BTN_A}, {SDL_CONTROLLER_BUTTON_X, BTN_B},
            {SDL_CONTROLLER_BUTTON_B, BTN_B}, {SDL_CONTROLLER_BUTTON_START, BTN_START},
            {SDL_CONTROLLER_BUTTON_LEFTSHOULDER, BTN_Z}, {SDL_CONTROLLER_BUTTON_RIGHTSHOULDER, BTN_R},
        };
        for (size_t i = 0; i < sizeof pad_map / sizeof pad_map[0]; i++)
            if (SDL_GameControllerGetButton(gamepad, pad_map[i].pad))
                buttons |= pad_map[i].button;
        if (SDL_GameControllerGetAxis(gamepad, SDL_CONTROLLER_AXIS_TRIGGERLEFT) > 8000)
            buttons |= BTN_Z;
        int lx = SDL_GameControllerGetAxis(gamepad, SDL_CONTROLLER_AXIS_LEFTX);
        int ly = SDL_GameControllerGetAxis(gamepad, SDL_CONTROLLER_AXIS_LEFTY);
        if (abs(lx) > 6000 || abs(ly) > 6000)
            x = lx * STICK_MAX / 32768, y = -ly * STICK_MAX / 32768;
        int rx = SDL_GameControllerGetAxis(gamepad, SDL_CONTROLLER_AXIS_RIGHTX);
        int ry = SDL_GameControllerGetAxis(gamepad, SDL_CONTROLLER_AXIS_RIGHTY);
        buttons |= (rx > 16000 ? BTN_CRIGHT : 0) | (rx < -16000 ? BTN_CLEFT : 0);
        buttons |= (ry > 16000 ? BTN_CDOWN : 0) | (ry < -16000 ? BTN_CUP : 0);
    }
    if (menu_open) /* while the menu is up, the keys are for the menu */
        buttons = 0, x = y = 0;
    pad_buttons = (uint16_t)buttons, pad_x = (int8_t)x, pad_y = (int8_t)y;
}

static void show_picture(int which) {
    int w, h;
    SDL_GL_GetDrawableSize(window, &w, &h);
    glb_present(which, w, h);
    draw_overlay();
    glb_overlay_finish();
    /* For testing: WINDOW_SHOT=file.ppm saves what the window shows at frame
     * WINDOW_SHOT_FRAME (default 300). */
    const char *shot_frame = getenv("WINDOW_SHOT_FRAME");
    const char *shot = frames == (shot_frame ? atol(shot_frame) : 300) ? getenv("WINDOW_SHOT") : NULL;
    FILE *file = shot ? fopen(shot, "wb") : NULL;
    if (file) {
        uint8_t *pixels = malloc((size_t)w * (size_t)h * 3);
        glb_read_window(pixels, w, h);
        fprintf(file, "P6\n%d %d\n255\n", w, h);
        fwrite(pixels, 3, (size_t)w * (size_t)h, file);
        fclose(file);
        free(pixels);
    }
    SDL_GL_SwapWindow(window);
}

/* Sleep until 1/60 of a second after the previous frame was due. The game
 * draws on every second refresh, so one refresh running long is made up on
 * the next; only if we fall well behind do we give up catching up. */
static void wait_for_next_frame(void) {
    Uint64 frequency = SDL_GetPerformanceFrequency(), now = SDL_GetPerformanceCounter();
    next_frame_time += frequency / 60;
    if (now > next_frame_time) {
        double late = (double)(now - next_frame_time) * 1000 / (double)frequency;
        if (late > 4)
            late_refreshes++;
        if (late > latest_ms)
            latest_ms = late;
    }
    if (now > next_frame_time + frequency / 10)
        next_frame_time = now;
    if (!speed_limit) { /* run as fast as the PC can go */
        next_frame_time = now;
        return;
    }
    while (now < next_frame_time) {
        Uint64 left = (next_frame_time - now) * 1000 / frequency;
        if (left > 1)
            SDL_Delay((Uint32)left - 1); /* sleep most of it, then wait precisely */
        now = SDL_GetPerformanceCounter();
    }
}
#endif

/* Once per screen refresh. */
static void present_frame(void) {
    if (max_frames >= 0 && frames > max_frames)
        return;
    int which = shown_next < shown_count ? shown_queue[shown_next++] : -1;
#ifdef USE_SDL
    if (!headless) {
        static int on_screen = 1; /* which picture is currently displayed */
        read_keyboard_and_gamepad();
        if (getenv("MENU_SCRIPT")) { /* for testing: change settings with nobody at the keyboard */
            static const struct { long frame; int row, direction; } steps[] = {
                {200, ROW_WIDE, 1}, {260, ROW_SCALE, -1}, {320, ROW_SMOOTH, 1},
                {380, ROW_SCALE, 1}, {440, ROW_SCALE, 1}, {500, ROW_WIDE, 1}, {520, ROW_WIDE, 1},
            };
            for (size_t i = 0; i < sizeof steps / sizeof steps[0]; i++)
                if (steps[i].frame == frames)
                    menu_row = steps[i].row, menu_change(steps[i].direction);
        }
        update_stats(which >= 0);
        if (which >= 0)
            on_screen = which;
        /* Redraw even without a new picture while the menu or statistics
         * are up, so they stay responsive. */
        if (which >= 0 || menu_open || stats_shown)
            show_picture(on_screen);
        wait_for_next_frame();
    }
#endif
    for (int i = 0; i < script_count; i++)
        if (frames >= script[i].start && frames < script[i].start + script[i].duration) {
            pad_buttons |= (uint16_t)script[i].buttons;
            if (script[i].x || script[i].y)
                pad_x = (int8_t)script[i].x, pad_y = (int8_t)script[i].y;
        } else if (frames == script[i].start + script[i].duration) {
            pad_buttons = 0, pad_x = pad_y = 0;
        }
    static long next_screenshot = -1;
    if (next_screenshot < 0)
        next_screenshot = screenshot_from;
    if (screenshot_dir && which >= 0 && frames >= next_screenshot) {
        write_screenshot(which);
        next_screenshot = frames - frames % screenshot_every + screenshot_every;
    }
}

/* Printed when the game ends, however it ends. */
static void print_summary(void) {
    if (wav_file) { /* finish the recording: a WAV file is a header plus raw samples */
        uint32_t header[11] = {0x46464952, (uint32_t)wav_bytes + 36, 0x45564157, 0x20746D66, 16,
                               0x00020001, 32000, 32000 * 4, 0x00100004, 0x61746164, (uint32_t)wav_bytes};
        rewind(wav_file);
        fwrite(header, 4, 11, wav_file);
        fclose(wav_file);
    }
    printf("ran %ld frames\n", frames);
    printf("  threads created:   %d\n", thread_count - 1);
    printf("  cartridge reads:   %ld (%ld KB)\n", dma_count, dma_bytes / 1024);
    printf("  pictures drawn:    %ld (%ld triangles)\n", graphics_tasks, gfx_triangle_count);
    if (graphics_tasks)
        printf("  drawing time:      %.1f ms average, %.1f ms worst (16.7 ms is one refresh)\n",
               draw_ms_total / (double)graphics_tasks, draw_ms_worst);
#ifdef USE_SDL
    if (!headless)
        printf("  late refreshes:    %ld (worst %.1f ms late)\n", late_refreshes, latest_ms);
#endif
    printf("  sound:             %ld blocks made", audio_tasks);
    if (sound_blocks)
        printf(", %ld played, %ld gaps, %ld skipped", sound_blocks, sound_gaps, sound_skipped);
    printf("\n");
    printf("  frames cut short by the loop budget: %ld\n", forced_frames);
    if (getenv("SHOW_THREADS")) /* for working out why a game is stuck */
        for (int i = 0; i < thread_count; i++)
            printf("  thread %d: priority %d, %s, queue 0x%08X (%u waiting), last call from 0x%08X\n",
                   threads[i].id, threads[i].priority,
                   (const char *[]){"stopped", "ready", "waiting", "finished"}[threads[i].state],
                   threads[i].wait_queue,
                   threads[i].state == WAITING ? g32(MQ_VALID(threads[i].wait_queue)) : 0,
                   (uint32_t)threads[i].ctx.ra);
}

/* ---- Main ------------------------------------------------------------------ */

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: %s <rom file> [options]\n", argv[0]);
        return 2;
    }
    int scale = 3;
    float aspect = 4.0f / 3;
    for (int i = 2; i < argc; i++) {
        const char *next = i + 1 < argc ? argv[i + 1] : "";
        if (!strcmp(argv[i], "--frames")) max_frames = atol(next), i++;
        else if (!strcmp(argv[i], "--scale")) scale = atoi(next), i++;
        else if (!strcmp(argv[i], "--save")) save_path = next, i++;
        else if (!strcmp(argv[i], "--headless")) headless = 1;
        else if (!strcmp(argv[i], "--wide")) aspect = 16.0f / 9;
        else if (!strcmp(argv[i], "--stats")) start_with_stats = 1;
        else if (!strcmp(argv[i], "--smooth")) smooth_motion = 1;
        else if (!strcmp(argv[i], "--look")) look_test_yaw = (float)atof(next), i++;
        else if (!strcmp(argv[i], "--screenshots")) screenshot_dir = next, i++;
        else if (!strcmp(argv[i], "--every")) screenshot_every = atoi(next), i++;
        else if (!strcmp(argv[i], "--wav")) wav_file = fopen(next, "wb"), i++;
        else if (!strcmp(argv[i], "--from")) screenshot_from = atol(next), i++;
        else if (!strcmp(argv[i], "--keys")) {
            for (const char *p = next; *p && script_count < 64; script_count++) {
                char *end;
                script[script_count].start = strtol(p, &end, 0);
                script[script_count].buttons = *end == ':' ? (int)strtol(end + 1, &end, 0) : 0;
                script[script_count].duration = *end == ':' ? strtol(end + 1, &end, 0) : 4;
                script[script_count].x = *end == ':' ? (int)strtol(end + 1, &end, 0) : 0;
                script[script_count].y = *end == ':' ? (int)strtol(end + 1, &end, 0) : 0;
                p = *end == ',' ? end + 1 : end;
                if (end == p && *p)
                    break;
            }
            i++;
        } else {
            fprintf(stderr, "unknown option %s\n", argv[i]);
            return 2;
        }
    }
#ifndef USE_SDL
    headless = 1;
#endif

    FILE *file = fopen(argv[1], "rb");
    if (!file)
        fatal("cannot open ROM", 0);
    fseek(file, 0, SEEK_END);
    rom_size = (size_t)ftell(file);
    rewind(file);
    rom = malloc(rom_size);
    if (fread(rom, 1, rom_size, file) != rom_size)
        fatal("cannot read ROM", 0);
    fclose(file);

    memset(eeprom, 0xFF, sizeof eeprom); /* a blank chip reads as all ones */
    file = save_path ? fopen(save_path, "rb") : NULL;
    if (file) {
        if (fread(eeprom, 1, EEPROM_SIZE, file) != EEPROM_SIZE)
            fprintf(stderr, "host: save file is short; missing part treated as blank\n");
        fclose(file);
    }

    /* What the console's boot code does before the game starts: copy the
     * first megabyte of game code into memory and leave a few facts about
     * the console at fixed addresses. */
    ram = calloc(1, RAM_SIZE);
    memcpy(guest(ENTRY_POINT, BOOT_LOAD_SIZE), rom + ENTRY_ROM_OFFSET, BOOT_LOAD_SIZE);
    w32(0x80000300, 1);          /* TV type: NTSC */
    w32(0x80000308, 0xB0000000); /* where the cartridge is mapped */
    w32(0x80000318, 0x400000);   /* memory size: 4 MB, a console without the expansion */

    audio_init(ram);
    if (wav_file)
        fseek(wav_file, 44, SEEK_SET); /* leave room for the header, written at the end */
    gfx_init(ram, scale, aspect);
    host_view_widen = base_view_widen = aspect / (4.0f / 3);
    if (look_test_yaw != 0) { /* for testing free look without a mouse */
        gfx_set_view(look_test_yaw, 0, 1);
        host_view_widen = base_view_widen = 20;
    }
    atexit(print_summary);
#ifdef USE_SDL
    if (!headless)
        current_scale = scale, current_aspect = aspect, stats_shown = start_with_stats;
    if (getenv("MENU_TEST")) /* for testing: start with the menu and statistics showing */
        menu_open = stats_shown = 1;
    if (!headless)
        open_window();
#endif

    /* The start-up code runs as a thread of its own, above all others. */
    Thread *boot = new_thread(0, 0, 1000, ENTRY_POINT);
    make_runnable(boot);

    int idle_frames = 0;
    while (max_frames < 0 || frames < max_frames) {
        Thread *t = pick_thread();
        if (t) {
            idle_frames = 0;
            current = t;
            swapcontext(&scheduler, &t->uc);
            current = NULL;
            continue;
        }
        /* Every thread is waiting, so the frame's work is done. Move time
         * forward to the next screen refresh and announce it. */
        next_frame();
        if (++idle_frames > 600) {
            fprintf(stderr, "host: nothing has run for 600 frames; the game is stuck\n");
            return 1;
        }
    }

    return 0;
}
