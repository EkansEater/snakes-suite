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
 *   --settings FILE     where the choices made in the menu are kept
 *   --states NAME       save states are kept in files called NAME.slot1, ...
 *   --wide              16:9 picture instead of the original 4:3
 *   --smooth            60 pictures a second instead of the game's 30
 *   --headless          no window (for testing)
 *   --screenshots DIR   write a picture file every --every N frames
 *   --stats             start with the statistics display on
 *   --keys LIST         scripted input: frame:buttons:duration[:x:y],...
 *   --wav FILE          record the sound to a file
 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE /* for a few Linux-only things: mmap's options, REG_RSP */
#endif
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <time.h>
#include <ucontext.h>
#include <unistd.h>
#ifdef USE_SDL
#include <SDL.h>

#include "gfx_gl.h"
#endif

#include "audio.h"
#include "cheats.h"
#include "gfx.h"
#include "functions.h"
#include "mods.h"

static uint8_t *ram, *rom;
const uint8_t *host_rom;
static size_t rom_size;

static void fatal(const char *what, uint32_t value) {
    fprintf(stderr, "host: %s (0x%08X)\n", what, value);
    exit(1);
}

/* Ask the system for memory at an address of our choosing. Normally a
 * program takes whatever address it is given, and it differs on every run.
 * Save states (further down) store pointers into the game's memory and the
 * threads' stacks, and those are only right if both are in the same place
 * every time. */
#define RAM_SLACK 0x200000
#define RAM_PLACE 0x100000000000ull
#define STACKS_PLACE 0x110000000000ull
static void *memory_at(unsigned long long place, size_t size) {
    void *p = mmap((void *)place, size, PROT_READ | PROT_WRITE,
                   MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE, -1, 0);
    if (p != (void *)place)
        fatal("could not get memory at a fixed address", (uint32_t)(place >> 32));
    return p;
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

/* IDLE: going round an empty loop for ever; see host_time_slice. */
typedef enum { STOPPED, RUNNABLE, WAITING, DEAD, IDLE } State;

typedef struct Thread {
    uint32_t guest_address; /* the game's own record of this thread */
    int id, priority;
    State state;
    uint32_t wait_queue; /* message queue it is waiting on, if WAITING */
    int wait_to_send;
    uint32_t entry;
    uint64_t turn; /* threads of equal priority take turns, oldest first */
    long calls, calls_seen; /* library calls it has made: so far, and when it last used up its time */
    int quiet_slices;       /* how many times running it has used up its time without making one */
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

/* Each thread's stack has its own fixed place (see memory_at), with a gap
 * before the next. */
static uint8_t *thread_stack(int index) {
    static uint8_t *stacks[MAX_THREADS];
    if (!stacks[index])
        stacks[index] = memory_at(STACKS_PLACE + (unsigned long long)index * 2 * NATIVE_STACK_SIZE, NATIVE_STACK_SIZE);
    return stacks[index];
}

static void make_runnable(Thread *t) {
    t->state = RUNNABLE;
    t->turn = ++turn_counter;
}

/* Give control back to the scheduler. The thread resumes here later. */
static void switch_away(void) { swapcontext(&current->uc, &scheduler); }

static Thread *pick_thread(void) {
    Thread *best = NULL;
    for (int i = 0; i < thread_count; i++) {
        Thread *t = &threads[i];
        if (t->state != RUNNABLE)
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
    if (best && best != current && best->priority > current->priority) {
        /* The start-up code is not a real thread. Once the first real one
         * takes over, the console never goes back to it. */
        if (current == &threads[0])
            current->state = DEAD;
        switch_away();
    }
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
    t->uc.uc_stack.ss_sp = thread_stack(thread_count);
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
    /* A thread we were not asked to create: the game set it up with a
     * function of its own. Everything we need is in the game's record of
     * it, where a real console would also look when first running it:
     * priority at +4, id at +0x14, and the registers it starts with from
     * +0x20 on (a0 at +0x38, the stack pointer at +0xF0, where it begins
     * at +0x11C). */
    uint32_t entry = g32(guest_address + 0x11C);
    if (entry < 0x80000000u || entry >= 0x80800000u || (entry & 3))
        fatal("unknown thread", guest_address);
    Thread *t = new_thread(guest_address, (int)g32(guest_address + 0x14), (int)g32(guest_address + 4), entry);
    t->ctx.a0 = S32(g32(guest_address + 0x3C));
    t->ctx.sp = S32(g32(guest_address + 0xF4));
    return t;
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

static uint32_t pi_command_queue; /* see run_pi_manager, further down */
static void run_pi_manager(void);

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
    if (queue == pi_command_queue && queue)
        run_pi_manager();
    else
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

enum { EVENT_SP = 4, EVENT_SI = 5, EVENT_DP = 9, EVENT_COUNT = 32 }; /* (later library versions have more kinds) */
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

/* Some of our stand-ins also let the library's own version of the function
 * run (it is kept, translated, as original_<name>). That version only
 * exists in games where we recognised the function, and this file is
 * built for every game; "weak" lets us mention a function that may not be
 * there and find out when the program starts whether it is. */
#define MAY_EXIST(name) void original_##name(Context *ctx) __attribute__((weak))
#define RUN_ORIGINAL(name) do { if (original_##name) original_##name(ctx); } while (0)
MAY_EXIST(osInitialize);
MAY_EXIST(osViSetMode);
MAY_EXIST(osViBlack);
MAY_EXIST(osViSetSpecialFeatures);
MAY_EXIST(osViSetEvent);
MAY_EXIST(osViSwapBuffer);

/* The library's own start-up: we leave it out. Most of what it does is to
 * the hardware, which is not there. It also sets up a few variables that
 * other library functions rely on (the clock's speed, the list of timers),
 * which matters if those functions are ones we do not stand in for; so for
 * trying things out, OS_INIT=1 lets it run after all. */
void hle_osInitialize(Context *ctx) {
    if (getenv("OS_INIT"))
        RUN_ORIGINAL(osInitialize);
}

/* ---- Video -----------------------------------------------------------------
 * Nothing is drawn yet. We keep track of which picture the game wants shown
 * and tick the "screen refreshed" event 60 times a (virtual) second. */

static uint32_t vi_queue, vi_message, framebuffer;
static long frames;
static long max_frames = -1; /* stop after this many (--frames), for testing */
/* --log: tell the story of this run as it goes, for working out afterwards
 * what went wrong (see "The run log" further down). */
static int run_log;
static int cheat_button_held; /* see cheats.c: some cheats wait for a button */
static const char *pictures_path; /* where screenshots go: folder and start of the name (--pictures) */
static int picture_wanted;        /* the screenshot shortcut was pressed */
static long frames_now(void) { return frames; }

/* The library keeps two records of the video settings, "current" and
 * "next", and swaps them at every refresh. We do not need them ourselves,
 * but library functions we do not stand in for read and write them. With
 * VI_INIT=1 we run the library's function that sets them up, and from then
 * on let its own video functions keep them up to date alongside ours.
 * That is for trying things out: it gets some games further and stops
 * others (NFL Blitz Special Edition, for one), so it is off unless asked for. */
static int video_records; /* have they been set up? */
void hle_osCreateViManager(Context *ctx) {
    (void)ctx;
#ifdef ADDR___osViInit
    if (!getenv("VI_INIT"))
        return;
    uint64_t ra = ctx->ra;
    call_indirect(ctx, ADDR___osViInit);
    ctx->ra = ra;
    video_records = 1;
#endif
}
void hle_osViSetMode(Context *ctx) {
    if (video_records)
        RUN_ORIGINAL(osViSetMode);
}
void hle_osViBlack(Context *ctx) {
    if (video_records)
        RUN_ORIGINAL(osViBlack);
}
void hle_osViSetSpecialFeatures(Context *ctx) {
    if (video_records)
        RUN_ORIGINAL(osViSetSpecialFeatures);
}
void hle_osViSetEvent(Context *ctx) {
    vi_queue = ARG0, vi_message = ARG1;
    if (video_records)
        RUN_ORIGINAL(osViSetEvent);
}
void hle_osViSwapBuffer(Context *ctx) {
    framebuffer = ARG0;
    if (video_records)
        RUN_ORIGINAL(osViSwapBuffer);
}
/* What the console does to the two records at each refresh, as far as it
 * matters: the picture that was "next" (at +4) is now the one showing. */
static void swap_video_records(void) {
#if defined(ADDR___osViCurr) && defined(ADDR___osViNext)
    if (video_records) {
        uint32_t showing = g32(ADDR___osViCurr), next = g32(ADDR___osViNext);
        if (showing >= 0x80000000u && showing < 0x80800000u - 8 && next >= 0x80000000u && next < 0x80800000u - 8)
            w32(showing + 4, g32(next + 4));
    }
#endif
}
void hle_osViGetCurrentFramebuffer(Context *ctx) { RETURN(framebuffer); }
void hle_osViGetNextFramebuffer(Context *ctx) { RETURN(framebuffer); }

/* One screen refresh: 1/60 of a second of console time passes. */
#define LOOP_BUDGET_PER_FRAME 200000
long loop_budget = LOOP_BUDGET_PER_FRAME;
static uint64_t ticks;
#define TICKS_PER_FRAME (46875000 / 60)

static void present_frame(void); /* further down: window, input, screenshots */
static void run_timers(void);
static void sound_chip_update(void);

static long forced_frames;
long host_calls;
static long calls_at_switch; /* host_calls when the running thread was last given the CPU */
static long most_loops; /* the most of the loop budget any one refresh has used */

static void next_frame(void) {
    frames++;
    ticks += TICKS_PER_FRAME;
    if (frames > 1000 && LOOP_BUDGET_PER_FRAME - loop_budget > most_loops)
        most_loops = LOOP_BUDGET_PER_FRAME - loop_budget; /* (after start-up, which is always busy) */
    loop_budget = LOOP_BUDGET_PER_FRAME;
    present_frame();
    run_timers();
    sound_chip_update();
    swap_video_records();
    if (vi_queue)
        queue_put(vi_queue, vi_message, 0);
}

/* Called from recompiled code when a thread has been looping for about a
 * frame's worth of work without ever waiting. */
const char *host_loop_where = "";
void host_time_slice(Context *ctx) {
    if (getenv("SHOW_LOOPS")) /* for testing: who used up a whole frame's worth of looping, and where */
        fprintf(stderr, "loops %ld: thread %d in %s, called from 0x%08X\n", frames, current ? current->id : -1,
                host_loop_where, (uint32_t)ctx->ra);
    /* Games have an "idle thread": an endless empty loop for the CPU to sit
     * in when there is nothing else to do. One shows itself here: lowest
     * priority, and a whole refresh's worth of looping without asking the
     * library for anything. We stop running it, and let the scheduler move
     * time forward when nothing else can run. */
    if (current) {
        long calls = current->calls + (host_calls - calls_at_switch);
        /* (Half a second of it, to be sure: start-up code also loops for
         * a long time without calls, clearing and unpacking memory. And
         * never the start-up code itself, which is dealt with in
         * preempt_check.) */
        current->quiet_slices = current->calls_seen == calls ? current->quiet_slices + 1 : 0;
        if (current->priority <= 0 && current != &threads[0] && current->quiet_slices >= 30) {
            current->state = IDLE;
            loop_budget = LOOP_BUDGET_PER_FRAME;
            switch_away();
        }
        current->calls_seen = calls;
    }
    forced_frames++;
    next_frame();
    if (max_frames >= 0 && frames >= max_frames)
        exit(0); /* (a test run of so many frames: the thread that is looping would never let main() notice) */
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

/* Besides the game itself, a cartridge can hold a small battery-backed
 * memory for saved games ("SRAM", 32 KB), which the console reaches through
 * the same port at another address. Unlike the game, it can be written. */
#define SRAM_SIZE 0x8000
#define SRAM_PLACE 0x08000000u
static uint8_t sram[SRAM_SIZE];
static void save_sram(void);

/* Copy between the cartridge and memory. "device" is the cartridge-side
 * address as the hardware numbers it: the game from 0x10000000, the save
 * memory from 0x08000000. */
static void cart_copy(uint32_t device, uint32_t memory, uint32_t size, int to_cartridge) {
    device &= 0x1FFFFFFF;
    if (device < 0x08000000) /* (given as a distance from the start of the game) */
        device += 0x10000000;
    if (device >= SRAM_PLACE && device < SRAM_PLACE + 0x08000000) {
        uint32_t offset = (device - SRAM_PLACE) & (SRAM_SIZE - 1);
        if (size > SRAM_SIZE - offset)
            size = SRAM_SIZE - offset;
        if (to_cartridge) {
            memcpy(sram + offset, guest(memory, size), size);
            save_sram();
        } else {
            memcpy(guest(memory, size), sram + offset, size);
        }
        return;
    }
    uint32_t rom_address = device - 0x10000000;
    if (to_cartridge)
        return; /* the game itself cannot be written to */
    if (rom_address > rom_size || size > rom_size - rom_address)
        fatal("read past the end of the ROM", rom_address);
    memcpy(guest(memory, size), rom + rom_address, size);
    dma_count++, dma_bytes += size;
    if (getenv("SHOW_READS")) /* for working out where a game keeps its code */
        fprintf(stderr, "read %ld: ROM 0x%06X -> 0x%08X, 0x%X bytes\n", frames, rom_address, memory, size);
}

void hle_osPiStartDma(Context *ctx) {
    uint32_t request = ARG0, reply_queue = STACK_ARG(6);
    cart_copy(ARG3, STACK_ARG(4), STACK_ARG(5), ARG2 != 0);
    queue_put(reply_queue, request, 0);
    RETURN(0);
    preempt_check();
}

/* On the console a "PI manager" thread does the copying: the functions
 * games call only post a request on its queue and it answers when done.
 * We do not run that thread, and usually stand in for the functions
 * instead (above). But there are several of them, in several versions,
 * and we do not recognise every one; an unrecognised one runs as the
 * game's own code and posts its request as on the console. So we also
 * stand in for the manager: whatever lands on its queue is carried out on
 * the spot. A request is a small record: its kind at +0, the queue to
 * answer on at +4, the memory address at +8, the cartridge address at +0xC,
 * the size at +0x10, and for the newer kinds which part of the cartridge
 * (a "handle", whose own address is at its +0xC) at +0x14. */
void hle_osCreatePiManager(Context *ctx) {
    pi_command_queue = ARG1;
#ifdef ADDR___osPiDevMgr
    /* The library's own note that the manager exists: "running" at +0, its
     * queue at +8. The cartridge functions give up if it says not running. */
    w32(ADDR___osPiDevMgr, 1);
    w32(ADDR___osPiDevMgr + 8, ARG1);
#endif
}

/* One request record, carried out at once; see run_pi_manager. */
static void do_pi_request(uint32_t request, uint32_t handle, int to_cartridge) {
    uint32_t device = g32(request + 0xC);
    if (handle >= 0x80000000u && handle < 0x80800000u - 0x10)
        device = (g32(handle + 0xC) | device) & 0x1FFFFFFF;
    cart_copy(device, g32(request + 8), g32(request + 0x10), to_cartridge);
    queue_put(g32(request + 4), request, 0);
}
/* osEPiStartDma(handle, request, direction): the newer way to ask. */
void hle_osEPiStartDma(Context *ctx) {
    do_pi_request(ARG1, ARG0, ARG2 != 0);
    RETURN(0);
    preempt_check();
}

static void run_pi_manager(void) {
    while (g32(MQ_VALID(pi_command_queue)) > 0) {
        uint32_t first = g32(MQ_FIRST(pi_command_queue)), capacity = g32(MQ_CAPACITY(pi_command_queue));
        uint32_t request = g32(g32(MQ_MESSAGES(pi_command_queue)) + 4 * first);
        w32(MQ_FIRST(pi_command_queue), (first + 1) % capacity);
        w32(MQ_VALID(pi_command_queue), g32(MQ_VALID(pi_command_queue)) - 1);
        if (request < 0x80000000u || request >= 0x80800000u)
            continue;
        uint32_t kind = g32(request) >> 16;
        if (kind == 15 || kind == 16) /* the newer kinds: relative to a handle */
            do_pi_request(request, g32(request + 0x14), kind == 16);
        else if (kind == 11 || kind == 12)
            do_pi_request(request, 0, kind == 12);
        else
            queue_put(g32(request + 4), request, 0);
    }
}

/* ---- Free camera ----------------------------------------------------------------
 * A camera of our own, which the player turns with the right stick or the
 * mouse, in place of the game's. It circles the player's character at a
 * distance, like the camera of a modern game.
 *
 * The game knows nothing about it. The game still works out its own camera
 * and builds the scene for that; the renderer then draws the scene as our
 * camera would see it instead (gfx_set_free_camera). Three things have to
 * be patched up around that, and all three are further down or in the
 * game's file:
 *   - "Up" on the stick should mean "away from me, as I see it", but the
 *     game takes it to mean away from its own camera. So we turn the
 *     stick's direction by the angle between the two (turn_stick).
 *   - The game leaves out things its own camera cannot see, and turns flat
 *     things such as trees to face its own camera. The game's file undoes
 *     both, using host_view_widen and host_view_back.
 *   - Our camera must not go through walls. Only the game knows where the
 *     walls are, so its file measures how much room there is behind the
 *     character and tells us (host_camera.room).
 *
 * All of this needs to know where the character is, which the game's file
 * says (game_focus in mods.h). For a game that does not, the older, simpler
 * look-around is used: the view turns on the spot (gfx_set_view). */

FreeCamera host_camera = {.room = 1e9f};
float host_view_back[3][3] = {{1, 0, 0}, {0, 1, 0}, {0, 0, 1}};
static float camera_distance_now; /* how far away it actually is: host_camera.distance, less if a wall is in the way */
static float camera_game_facing;  /* the direction the game's own camera faces */
static float camera_test_turn;    /* for testing: start turned this far to the right (--look) */

/* For games whose file does not say where the character is: 1 = circle
 * whatever the game's camera is looking at (a guess, see gfx_guess_focus);
 * 0 = just turn the view on the spot. A setting under Controls. */
static int camera_circles = 1;
/* Should "up" on the stick mean "away from me as I now see it"? Right for
 * games where you steer a character relative to the camera; wrong for ones
 * where you steer a vehicle, or look through the character's eyes. */
static int stick_follows_camera;
static float camera_nearest = 300, camera_farthest = 2500;

/* Where the character is: from the game's file if it can tell us, and
 * otherwise our best guess. */
static int camera_focus(float focus[3]) {
    static Context ctx;
    ctx.ram = ram;
    if (game_focus)
        return game_focus(&ctx, focus);
    return camera_circles && gfx_guess_focus(focus);
}

/* Is the game paused, or showing a menu of its own? Then the sticks are for
 * that menu: ours leaves the camera where it is and does not interfere. */
static int camera_paused(void) {
    static Context ctx;
    ctx.ram = ram;
    return game_paused && game_paused(&ctx);
}

#define CAMERA_NEAREST camera_nearest
#define CAMERA_FARTHEST camera_farthest

/* Make the free camera the one in use, if it is not already. It starts
 * from exactly where the game's camera is, so that the picture does not
 * jump. Returns 0 if it cannot (there is no 3D scene to take over). */
static int camera_take_over(const float focus[3]) {
    if (host_camera.on)
        return 1;
    if (!gfx_game_camera(focus, &host_camera.yaw, &host_camera.pitch, &host_camera.distance, &camera_game_facing))
        return 0;
    if (!game_focus) {
        /* Games measure their worlds in different units, so how near and
         * far the camera may go is set from where the game had it. */
        camera_nearest = host_camera.distance / 4, camera_farthest = host_camera.distance * 6;
    }
    host_camera.distance = host_camera.distance < CAMERA_NEAREST ? CAMERA_NEAREST
                           : host_camera.distance > CAMERA_FARTHEST ? CAMERA_FARTHEST : host_camera.distance;
    camera_distance_now = host_camera.distance;
    host_camera.room = 1e9f;
    host_camera.on = 1;
    return 1;
}

/* Can the player move the free camera at this moment? */
static int camera_usable(void) {
    float focus[3];
    return !camera_paused() && camera_focus(focus);
}

/* The player moved the camera nearer (a factor below 1) or farther. */
static void zoom_camera(float factor) {
    float focus[3];
    if (!camera_usable() || !camera_focus(focus) || !camera_take_over(focus))
        return;
    host_camera.distance *= factor;
    host_camera.distance = host_camera.distance < CAMERA_NEAREST ? CAMERA_NEAREST
                           : host_camera.distance > CAMERA_FARTHEST ? CAMERA_FARTHEST : host_camera.distance;
}

/* The player turned the camera: right and down are angles in radians.
 * Returns 0 if this game has no free camera (the caller then falls back on
 * the simple look-around). */
static int turn_camera(float right, float down) {
    float focus[3];
    if (!game_focus && !camera_circles)
        return 0;
    if (camera_paused())
        return 1; /* stays exactly as it is */
    if (!camera_focus(focus)) {
        /* Nothing to circle just now, or the game is showing a scene of its
         * own (an introduction, a door opening): the camera is the game's,
         * and the stick does nothing to it. */
        host_camera.on = 0;
        return 1;
    }
    if ((right == 0 && down == 0) || !camera_take_over(focus))
        return 1;
    /* Seen from above, the world's angles run anticlockwise, so turning to
     * the right makes the angle smaller. */
    host_camera.yaw -= right;
    host_camera.pitch += down;
    /* From a little below level (looking up) to nearly overhead. */
    host_camera.pitch = host_camera.pitch < -0.3f ? -0.3f : host_camera.pitch > 1.4f ? 1.4f : host_camera.pitch;
    return 1;
}

/* Tell the renderer about the camera for the frame it is about to draw. */
static void camera_before_drawing(void) {
    float focus[3] = {0, 0, 0};
    /* For testing: --look takes effect at frame LOOK_FRAME (default: at once). */
    if (camera_test_turn != 0 && frames >= (getenv("LOOK_FRAME") ? atol(getenv("LOOK_FRAME")) : 0) &&
        turn_camera(camera_test_turn, getenv("LOOK_DOWN") ? (float)atof(getenv("LOOK_DOWN")) : 0) && host_camera.on)
        camera_test_turn = 0;
    if (host_camera.on && !camera_focus(focus))
        host_camera.on = 0; /* a scene of the game's own has begun: hand the camera back */
    if (host_camera.on && getenv("LOOK_DISTANCE")) /* for testing: how far away the camera wants to be */
        host_camera.distance = (float)atof(getenv("LOOK_DISTANCE"));
    int on = host_camera.on;
    if (on) {
        /* Come in at once when a wall is in the way; drift back out
         * gently when it no longer is, so the view does not lurch. */
        float wanted = host_camera.distance < host_camera.room ? host_camera.distance : host_camera.room;
        float step = game_focus ? 25 : host_camera.distance * 0.03f;
        if (wanted < camera_distance_now)
            camera_distance_now += (wanted - camera_distance_now) * 0.6f;
        else
            camera_distance_now = wanted < camera_distance_now + step ? wanted : camera_distance_now + step;
    }
    gfx_set_free_camera(on, host_camera.yaw, host_camera.pitch, camera_distance_now, focus);
    if (on && getenv("CAMERA_TEST")) /* for testing: say what the camera is doing */
        fprintf(stderr, "camera %ld: yaw %.2f pitch %.2f wants %.0f room %.0f at %.0f\n", frames, host_camera.yaw,
                host_camera.pitch, host_camera.distance, host_camera.room, camera_distance_now);
}

/* ...and afterwards, collect what the game's file needs for the next one. */
static void camera_after_drawing(void) {
    float focus[3], unused;
    /* In a game we know nothing about, we cannot tell when it starts a
     * scene of its own (a replay, a results screen). What we can see is
     * its camera suddenly being somewhere else: a "cut", as in a film. Our
     * camera was set up for the shot before, so at a cut we hand the
     * camera back to the game, until the player next moves it. */
    static float before[3];
    static int have_before;
    float place[3];
    if (gfx_game_camera_place(place)) {
        float moved = 0;
        for (int i = 0; i < 3; i++)
            moved += (place[i] - before[i]) * (place[i] - before[i]);
        if (!game_focus && host_camera.on && have_before && sqrtf(moved) > host_camera.distance * 1.5f)
            host_camera.on = 0;
        memcpy(before, place, sizeof before);
        have_before = 1;
    } else {
        have_before = 0;
    }
    gfx_view_back(host_view_back);
    if (camera_focus(focus))
        gfx_game_camera(focus, &unused, &unused, &unused, &camera_game_facing);
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
static int sound_volume = 10; /* 0 to 10: tenths of full volume */
static int fast_forward;      /* is the fast-forward button held? */
static int fast_speed = 4;    /* how many times normal speed that is; 0 = as fast as the PC can go */

/* Which dialect of drawing commands does this chip program understand?
 * Programs from F3DEX onwards carry their name and version as text in
 * their data, like "RSP Gfx ucode F3DEX       fifo 2.08". The earliest say
 * only "RSP SW Version: 2.0D", and those we tell apart by a checksum of the
 * program itself. A game may switch between programs, so we look every
 * time, but remember the answer for each. */
#define WAVE_RACE_PROGRAM 0xE3AF6C41u /* Wave Race 64 (USA) */
static int graphics_dialect(uint32_t program, uint32_t data) {
    static struct { uint32_t program, data; int dialect; } known[8]; /* (dialect: plus 0x100 for "no near") */
    static int count;
    for (int i = 0; i < count; i++)
        if (known[i].program == program && known[i].data == data)
            return known[i].dialect;

    int dialect = GFX_FAST3D;
    char name[64] = "(no name)";
    const char *text = (const char *)guest(data, 0x800);
    for (int i = 0; i + 40 < 0x800; i++) {
        if (memcmp(text + i, "RSP Gfx ucode ", 14))
            continue;
        memcpy(name, text + i + 14, 40), name[40] = 0;
        /* The version number is the first thing that looks like "N.NN". */
        double version = 0;
        for (const char *p = name; *p; p++)
            if (p[0] >= '0' && p[0] <= '9' && p[1] == '.' && p[2] >= '0' && p[2] <= '9') {
                version = atof(p);
                break;
            }
        dialect = (version >= 2 ? GFX_F3DEX2 : GFX_F3DEX) | (strstr(name, ".NoN") ? 0x100 : 0);
        break;
    }
    uint32_t sum = 0;
    const uint8_t *code = guest(program, 0x1000);
    for (int i = 0; i < 0x1000; i++)
        sum = sum * 31 + code[i];
    if (sum == WAVE_RACE_PROGRAM)
        dialect = GFX_F3DWAVE;
    if (run_log || getenv("SHOW_GRAPHICS"))
        fprintf(stderr, "graphics program at 0x%08X: \"%s\", checksum 0x%08X, dialect %d\n", program, name, sum,
                dialect & 0xFF);
    if (count < 8)
        known[count].program = program, known[count].data = data, known[count++].dialect = dialect;
    return dialect;
}


void hle_osSpTaskLoad(Context *ctx) { (void)ctx; }
/* An address inside a task may be given as the CPU sees it (0x80...) or as
 * the chips see it (counted from the start of memory). */
static uint32_t as_cpu_address(uint32_t address) { return address < RAM_SIZE ? address | 0x80000000u : address; }

/* Carry out a task for the signal chip. "task" is the game's 64-byte
 * description of it: its kind at +0, the chip program at +0x10 and its
 * data at +0x18, and the list of commands at +0x30 (length at +0x34). */
static void run_task(const uint8_t *task) {
#define FIELD(offset) ((uint32_t)task[offset] << 24 | (uint32_t)task[(offset) + 1] << 16 | (uint32_t)task[(offset) + 2] << 8 | task[(offset) + 3])
#define POINTER(offset) as_cpu_address(FIELD(offset))
    uint32_t type = FIELD(0); /* 1 = graphics, 2 = audio */
    if (type == 1) {
        /* Drawing a picture took the console a good part of a refresh, and
         * a few games count on that to set their pace rather than waiting
         * for the refresh itself. Ours takes no time at all, so a game
         * that asks for several pictures within one refresh is made to
         * wait for the next. */
        static long drawn_at_frame = -1;
        static int drawn_this_frame;
        drawn_this_frame = drawn_at_frame == frames ? drawn_this_frame + 1 : 1;
        drawn_at_frame = frames;
        if (drawn_this_frame > 3 && current) {
            next_frame();
            if (max_frames >= 0 && frames >= max_frames)
                exit(0);
            drawn_at_frame = frames, drawn_this_frame = 1;
        }
        graphics_tasks++;
        struct timespec t0, t1;
        clock_gettime(CLOCK_MONOTONIC, &t0);
        /* Which dialect of drawing commands? The chip program's data block
         * (+0x18) carries its name as text. */
        int dialect = graphics_dialect(POINTER(0x10), POINTER(0x18));
        gfx_set_dialect(dialect & 0xFF);
        gfx_set_no_near(dialect >> 8);
        camera_before_drawing();
        int made = gfx_run(POINTER(0x30), smooth_motion);
        camera_after_drawing();
        if (getenv("SHOW_PICTURES")) { /* for testing: when each picture is made, and a number that changes when it does */
            int w, h;
            const uint32_t *pixels = gfx_picture(1, &w, &h);
            uint32_t sum = 0;
            for (int i = 0; i < w * h; i += 97)
                sum = sum * 31 + pixels[i];
            fprintf(stderr, "picture %ld: %08X\n", frames, sum);
        }
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
    } else if (type == 2) {
        audio_tasks++;
        audio_run(POINTER(0x30), FIELD(0x34), POINTER(0x18), FIELD(0x1C));
    }
    post_event(EVENT_SP);
    if (type == 1)
        post_event(EVENT_DP);
#undef FIELD
#undef POINTER
}
void hle_osSpTaskStartGo(Context *ctx) { run_task(guest(ARG0, 0x40)); }

void hle_osSpTaskYield(Context *ctx) { (void)ctx; }
void hle_osSpTaskYielded(Context *ctx) { RETURN(0); }

/* ---- Sound output ---------------------------------------------------------------
 * The game hands over finished blocks of samples (16-bit, stereo). They are
 * queued for the sound card.
 *
 * The console's sound chip plays one block and can hold one more behind it.
 * A game learns how fast to make sound from the chip: it asks how much of
 * the current block is left, or whether the chip is full, or simply gets
 * told "no room" when it hands over a third block. Many games set their
 * whole pace by this. So we keep track of the chip in the game's own time
 * (ticks): when each block it was given would have finished playing. */
static struct {
    uint64_t ends[2]; /* when the block playing, and the one behind it, will finish */
    int count;        /* how many blocks the chip holds: 0, 1 or 2 */
    int frequency;    /* samples a second, as the game set it */
} sound_chip = {{0, 0}, 0, 32000};
#define TICKS_PER_SECOND 46875000ull

static void set_register(int group, int offset, uint32_t v); /* (further down, with the other hardware registers) */
static uint32_t sound_length_shown; /* what we last put in the chip's "length" register */
static long sound_taken, sound_refused; /* samples the chip was given; blocks it had no room for */

/* How many bytes of the block now playing are still to be played. */
static uint32_t sound_chip_left(void) {
    uint64_t left = sound_chip.count ? sound_chip.ends[0] - ticks : 0;
    return (uint32_t)(left * (uint64_t)sound_chip.frequency / TICKS_PER_SECOND) * 4;
}
/* Two facts in one number: the top bit says the chip is full, the next that it is playing. */
static uint32_t sound_chip_status(void) {
    return (sound_chip.count == 2 ? 0x80000001u : 0) | (sound_chip.count ? 0x40000000u : 0);
}

/* Blocks that have finished playing by now leave the chip, and the game is
 * told about each (some wait for exactly that). */
static void sound_chip_update(void) {
    while (sound_chip.count && sound_chip.ends[0] <= ticks) {
        sound_chip.ends[0] = sound_chip.ends[1];
        sound_chip.count--;
        post_event(6); /* EVENT_AI: "a block of sound has finished" */
    }
    /* Many games do not ask the library about the chip but look at its two
     * registers themselves, so those are kept true as well: how much is
     * left (register 4) and the status (register 0xC). */
    sound_length_shown = sound_chip_left();
    set_register(5, 0x04, sound_length_shown);
    set_register(5, 0x0C, sound_chip_status());
}

static void play_sound(uint32_t address, uint32_t size);

/* The game hands the chip a block of sound. Returns 0 if the chip is full
 * (the game must wait and try again). */
static int sound_chip_take(uint32_t address, uint32_t size) {
    sound_chip_update();
    if (sound_chip.count == 2) {
        sound_refused++;
        return 0;
    }
    sound_taken += size / 4;
    /* This block starts when the one before it ends (or now, if the chip
     * was idle) and lasts as long as its samples take to play. */
    uint64_t start = sound_chip.count ? sound_chip.ends[sound_chip.count - 1] : ticks;
    sound_chip.ends[sound_chip.count++] = start + (uint64_t)(size / 4) * TICKS_PER_SECOND / (uint64_t)sound_chip.frequency;
    /* The chip does not take the samples when it is told about a block: it
     * reads them out of the game's memory as it plays them, a moment later.
     * Some games rely on that, and name a block while its samples are still
     * being made. So we read each block one step late: when the next one is
     * named. (Games keep at least two blocks in turn, so it is still there.) */
    static uint32_t named_address, named_size;
    if (named_size)
        play_sound(named_address, named_size);
    named_address = address, named_size = size;
    sound_chip_update();
    return 1;
}

/* How much sound we keep waiting, beyond what the game asks for, as a
 * cushion against hiccups (see hle_osAiGetLength). More is safer against
 * crackling but makes sounds arrive later; it can be changed in the menu. */
static int sound_cushion_ms = 100;
/* (16-bit stereo is 4 bytes a sample) */
#define SOUND_CUSHION_BYTES (((uint32_t)sound_cushion_ms * (uint32_t)sound_chip.frequency / 250) & ~3u)
static FILE *wav_file;
static long wav_bytes, sound_blocks, sound_gaps, sound_skipped;
#ifdef USE_SDL
static SDL_AudioDeviceID audio_device;
#endif
static int headless;

static void open_sound(int frequency) {
#ifdef USE_SDL
    if (!headless && !audio_device && SDL_InitSubSystem(SDL_INIT_AUDIO) == 0) {
        SDL_AudioSpec want = {0};
        want.freq = frequency, want.format = AUDIO_S16SYS, want.channels = 2, want.samples = 512;
        audio_device = SDL_OpenAudioDevice(NULL, 0, &want, NULL, 0);
        if (audio_device)
            SDL_PauseAudioDevice(audio_device, 0);
        else
            fprintf(stderr, "host: no sound: %s\n", SDL_GetError());
    }
#else
    (void)frequency;
#endif
}
void hle_osAiSetFrequency(Context *ctx) {
    open_sound((int)ARG0);
    if (ARG0 >= 4000 && ARG0 <= 96000)
        sound_chip.frequency = (int)ARG0;
    RETURN(ARG0);
}
/* Hand a block of finished sound to the sound card. */
static void play_sound(uint32_t address, uint32_t size) {
    size &= ~3u;
    if (size == 0 || size > 0x8000)
        return;
    /* The game's samples are big-endian; the PC wants them the other way. */
    static int16_t samples[0x4000];
    const uint8_t *source = guest(address, size);
    for (uint32_t i = 0; i < size / 2; i++)
        samples[i] = (int16_t)(source[i * 2] << 8 | source[i * 2 + 1]);
    if (wav_file)
        wav_bytes += (long)fwrite(samples, 1, size, wav_file);
#ifdef USE_SDL
    /* If far too much is waiting (the game ran ahead), skip this block
     * rather than let the sound fall further and further behind. */
    if (audio_device && !sound_muted && !fast_forward) { /* fast forward is silent */
        uint32_t waiting = SDL_GetQueuedAudioSize(audio_device);
        sound_blocks++;
        if (waiting == 0 && sound_blocks > 1) {
            sound_gaps++; /* the sound card ran out: an audible gap */
            if (getenv("SOUND_TEST")) /* for testing: say when */
                fprintf(stderr, "sound gap at frame %ld\n", frames);
        }
        if (waiting == 0) {
            /* Nothing is waiting (the start, or after a gap): put the
             * cushion of silence in first, so that the PC being a moment
             * late with the next block does not make another gap. */
            static const int16_t silence[2048];
            for (uint32_t left = SOUND_CUSHION_BYTES; left; left -= left > sizeof silence ? sizeof silence : left)
                SDL_QueueAudio(audio_device, silence, left > sizeof silence ? sizeof silence : left);
            waiting = SOUND_CUSHION_BYTES;
        }
        if (getenv("SOUND_TEST") && frames % 120 == 0)
            fprintf(stderr, "sound queue at frame %ld: %u ms, block %u bytes\n", frames,
                    waiting / ((uint32_t)sound_chip.frequency / 250), size);
        if (sound_volume < 10) /* turned down in the menu */
            for (uint32_t i = 0; i < size / 2; i++)
                samples[i] = (int16_t)(samples[i] * sound_volume / 10);
        if (waiting < SOUND_CUSHION_BYTES * 2 + (uint32_t)sound_chip.frequency / 5 * 4) /* twice the cushion plus a fifth of a second */
            SDL_QueueAudio(audio_device, samples, size);
        else
            sound_skipped++;
    }
#endif
}
void hle_osAiSetNextBuffer(Context *ctx) { RETURN(sound_chip_take(ARG0, ARG1) ? 0 : -1); }
void hle_osAiGetLength(Context *ctx) {
    sound_chip_update();
    RETURN(sound_chip_left());
}
void hle_osAiGetStatus(Context *ctx) {
    sound_chip_update();
    RETURN(sound_chip_status());
}

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

/* The save chip comes in two sizes, 512 bytes and 2048. The game does not
 * choose: it asks the chip which it is. Which one a game's cartridge had is
 * something the tools look up (see profiles.py) and tell us with --eeprom. */
#define EEPROM_SIZE 2048
static uint8_t eeprom[EEPROM_SIZE];
static int eeprom_size = 512;
static const char *save_path;
static const char *settings_path;
static const char *states_path;

/* A short message for the player, shown at the bottom of the window for a
 * couple of seconds (and printed, for when there is no window). */
static char message[64];
static long message_until;
static long frames_now(void);
static void say(const char *text) {
    snprintf(message, sizeof message, "%s", text);
    message_until = frames_now() + 150;
    printf("%s\n", text);
    if (run_log)
        fprintf(stderr, "event %ld: %s\n", frames_now(), text);
}

static void save_eeprom(void) {
    FILE *file = save_path ? fopen(save_path, "wb") : NULL;
    if (file) {
        fwrite(eeprom, 1, (size_t)eeprom_size, file);
        fclose(file);
    }
}

/* The battery-backed memory is kept in a file of its own beside the save
 * chip's: the same name, ending in .sra. */
static const char *sram_path(void) {
    static char path[600];
    if (!save_path)
        return NULL;
    snprintf(path, sizeof path - 5, "%s", save_path);
    char *dot = strrchr(path, '.');
    strcpy(dot && !strchr(dot, '/') ? dot : path + strlen(path), ".sra");
    return path;
}
static void save_sram(void) {
    FILE *file = sram_path() ? fopen(sram_path(), "wb") : NULL;
    if (file) {
        fwrite(sram, 1, SRAM_SIZE, file);
        fclose(file);
    }
}

/* Answer one request. channel 0-3 are the controller ports, 4 the save
 * chip. Returns 0 if nothing is connected there. */
extern int host_trace;
static int pif_request(int channel, const uint8_t *request, int request_size, uint8_t *answer, int answer_size) {
    if (request_size < 1)
        return 0;
    uint8_t command = request[0];
    if (host_trace) {
        static int said[8][256];
        if (!said[channel & 7][command]++)
            fprintf(stderr, "trace %ld: controller port %d asked command 0x%02X (sends %d, wants %d back)\n", frames_now(), channel,
                    command, request_size, answer_size);
    }
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
            answer[0] = 0x00, answer[1] = eeprom_size > 512 ? 0xC0 : 0x80, answer[2] = 0x00; /* which size */
            return 1;
        }
        if (command == 0x04 && request_size >= 2 && answer_size >= 8 && request[1] < eeprom_size / 8) {
            memcpy(answer, eeprom + request[1] * 8, 8); /* read one 8-byte block */
            return 1;
        }
        if (command == 0x05 && request_size >= 10 && answer_size >= 1 && request[1] < eeprom_size / 8) {
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
/* ---- The console's hardware, seen from code we did not replace ----------------
 * Most games only reach the hardware through the OS library, which we stand
 * in for. Some also look at it directly: "is the graphics chip busy?",
 * "which line is the TV drawing?". Hardware is controlled through
 * "registers" at fixed addresses from 0xA4000000 up. We keep a small
 * pretend copy of each group and fill in answers that mean "idle, nothing
 * pending", which is what the game is waiting to see. What the game writes
 * there lands in the copy and is otherwise ignored. */
static uint8_t hardware[16][0x40]; /* one row per group of registers */
static uint8_t hardware_spare[0x2000]; /* the chip's own small memory (0xA4000000) */

static void set_register(int group, int offset, uint32_t v) {
    uint8_t *p = hardware[group] + offset;
    p[0] = (uint8_t)(v >> 24), p[1] = (uint8_t)(v >> 16), p[2] = (uint8_t)(v >> 8), p[3] = (uint8_t)v;
}

/* A few registers are orders rather than questions: writing a length to
 * the cartridge port means "copy that much from the cartridge now". The
 * OS library normally does this for a game and we stand in for the
 * library; but some games, and library versions we do not recognise, write
 * the registers themselves. We cannot see the moment of writing (it is a
 * plain write to memory, in our pretend copy), so we look afterwards:
 * each order register holds a marker meaning "nothing asked", and when one
 * holds something else we carry the order out and announce it finished,
 * just as the hardware would with an interrupt. Returns 1 if it did
 * anything. */
#define NOTHING_ASKED 0xFFFFFFFFu
enum { EVENT_AI = 6, EVENT_PI = 8 };
static uint32_t get_register(int group, int offset) {
    const uint8_t *p = hardware[group] + offset;
    return (uint32_t)p[0] << 24 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 8 | p[3];
}
static void pif_process(void);

static int hardware_poll(void) {
    static int ready;
    int did = 0;
    if (!ready) {
        ready = 1;
        set_register(6, 0x08, NOTHING_ASKED), set_register(6, 0x0C, NOTHING_ASKED);
        set_register(8, 0x04, NOTHING_ASKED), set_register(8, 0x10, NOTHING_ASKED);
        set_register(0, 0x08, NOTHING_ASKED), set_register(0, 0x0C, NOTHING_ASKED);
        set_register(0, 0x10, 1);
    }
    /* Cartridge port: copy from the cartridge into memory. */
    uint32_t length = get_register(6, 0x0C);
    if (length != NOTHING_ASKED) {
        uint32_t to = get_register(6, 0x00) & 0xFFFFFF, from = get_register(6, 0x04) & 0x0FFFFFFF;
        uint32_t size = (length & 0xFFFFFF) + 1;
        if (to < RAM_SIZE && size <= RAM_SIZE - to && from < rom_size && size <= rom_size - from) {
            memcpy(ram + to, rom + from, size);
            dma_count++, dma_bytes += size;
            if (getenv("SHOW_READS"))
                fprintf(stderr, "read %ld: ROM 0x%06X -> 0x%08X, 0x%X bytes (by the game itself)\n", frames, from,
                        to | 0x80000000u, size);
        }
        set_register(6, 0x0C, NOTHING_ASKED);
        post_event(EVENT_PI);
        did = 1;
    }
    if (get_register(6, 0x08) != NOTHING_ASKED) { /* ...or the other way: nothing to write to */
        set_register(6, 0x08, NOTHING_ASKED);
        post_event(EVENT_PI);
        did = 1;
    }
    /* Controller port: hand a block of requests to the controller chip, or
     * collect its answers. */
    if (get_register(8, 0x10) != NOTHING_ASKED) {
        uint32_t from = get_register(8, 0x00) & 0xFFFFFF;
        if (from <= RAM_SIZE - 64)
            memcpy(pif, ram + from, 64);
        set_register(8, 0x10, NOTHING_ASKED);
        post_event(EVENT_SI);
        did = 1;
    }
    if (get_register(8, 0x04) != NOTHING_ASKED) {
        uint32_t to = get_register(8, 0x00) & 0xFFFFFF;
        pif_process();
        if (to <= RAM_SIZE - 64)
            memcpy(ram + to, pif, 64);
        set_register(8, 0x04, NOTHING_ASKED);
        post_event(EVENT_SI);
        did = 1;
    }
    /* Signal chip: copy into its own small memory (that is how a task's
     * description reaches it), and "start running". */
    length = get_register(0, 0x08);
    if (length != NOTHING_ASKED) {
        uint32_t to = get_register(0, 0x00) & 0x1FFF, from = get_register(0, 0x04) & 0xFFFFFF;
        uint32_t size = (length & 0xFFF) + 1;
        if (size <= sizeof hardware_spare - to && from < RAM_SIZE && size <= RAM_SIZE - from)
            memcpy(hardware_spare + to, ram + from, size);
        set_register(0, 0x08, NOTHING_ASKED);
        did = 1;
    }
    if (get_register(0, 0x0C) != NOTHING_ASKED)
        set_register(0, 0x0C, NOTHING_ASKED), did = 1;
    uint32_t status = get_register(0, 0x10);
    if (status != 1) {            /* (1 is what we show: "halted") */
        set_register(0, 0x10, 1);
        if ((status & 3) == 1) {  /* bit 0: stop being halted */
            run_task(hardware_spare + 0xFC0);
            did = 1;
        }
    }
    /* Sound output: a block of sound to play. */
    /* (The length register also shows how much of the playing block is
     * left, which we keep up to date ourselves: see sound_chip_update. A
     * number there that we did not write is the game's.) */
    length = get_register(5, 0x04);
    if (length != sound_length_shown) {
        uint32_t rate = get_register(5, 0x10);
        int frequency = rate ? (int)(48681812 / (rate + 1)) : 32000;
        open_sound(frequency);
        if (frequency >= 4000 && frequency <= 96000)
            sound_chip.frequency = frequency;
        sound_chip_take(as_cpu_address(get_register(5, 0x00) & 0xFFFFFF), length & 0x3FFF8);
        sound_chip_update(); /* (puts the register back to "how much is left") */
        did = 1;
    }
    return did;
}

static uint8_t *hardware_at(uint32_t address, uint32_t size) {
    uint32_t physical = address & 0x1FFFFFFF;
    if (address >> 30 != 2)
        return NULL;
    static uint8_t nothing[8];
    if (physical >= 0x10000000 && physical - 0x10000000 <= rom_size - size && size <= rom_size)
        return rom + (physical - 0x10000000); /* the cartridge, read in place */
    if (physical >= RAM_SIZE && physical < 0x03F00000) {
        /* Past the end of memory. Games find out how much memory there is
         * by writing further and further out and reading back; what they
         * read here must not be what they wrote. */
        memset(nothing, 0, sizeof nothing);
        return nothing;
    }
    if ((physical >= 0x05000000 && physical < 0x10000000) || (physical >= 0x10000000 + rom_size && physical < 0x1FC00000) ||
        physical >= 0x1FD00000) {
        /* Where the 64DD disk drive and other add-ons would be. With none
         * plugged in, every read gives all ones. */
        memset(nothing, 0xFF, sizeof nothing);
        return nothing;
    }
    if (physical >= 0x04000000 && physical < 0x04002000)
        return hardware_spare + (physical - 0x04000000);
    if (physical >= 0x1FC007C0 && physical <= 0x1FC00800 - size)
        return pif + (physical - 0x1FC007C0); /* the controller chip's 64 bytes */
    if (physical < 0x04040000 || physical >= 0x04900000 || (physical & 0xFFFFF) > 0x40 - size)
        return NULL;
    int group = (int)((physical - 0x04000000) >> 20); /* 0: signal chip ... 8: controllers */
    if (host_trace) {
        static uint32_t seen[64];
        static int count;
        int known = 0;
        for (int i = 0; i < count; i++)
            known |= seen[i] == physical;
        if (!known && count < 64) {
            seen[count++] = physical;
            fprintf(stderr, "trace %ld: the game looks at hardware register 0x%08X itself\n", frames, physical);
        }
    }
    if ((physical & 0xF0000) == 0x80000)
        group = 15; /* 0x04080000: the signal chip's program counter */
    hardware_poll(); /* whatever the game wrote last time */
    static uint32_t line;
    line = (line + 2) % 525;
    set_register(0, 0x18, 0);             /* ...and not copying anything */
    set_register(1, 0x0C, 0x0080);        /* drawing chip: idle, ready for commands */
    set_register(3, 0x04, 0x02020102);    /* the console's version */
    set_register(3, 0x08, 0);             /* no interrupts pending */
    set_register(4, 0x10, line);          /* the TV line being drawn: keeps moving */
    sound_chip_update();                  /* sound output: how full it really is */
    set_register(6, 0x10, 0);             /* cartridge port: not busy */
    set_register(8, 0x18, 0);             /* controller port: not busy */
    return hardware[group] + (physical & 0x3F);
}

uint8_t *host_mapped_memory(Context *ctx, uint32_t address, uint32_t size) {
    uint8_t *p = mapped(address, size);
    if (!p)
        p = hardware_at(address, size);
    if (!p)
        trap(ctx, "bad memory access", address);
    return p;
}

void hle_osSetIntMask(Context *ctx) { RETURN(0); }

/* ---- Things recompiled code needs from us ---------------------------------- */

int host_interpret_loaded_code;
int host_trace;
void host_trace_call(Context *ctx, const char *name) {
    static char last[40][96];
    static int repeats[40];
    int id = current ? current->id & 31 : 32;
    char text[96];
    snprintf(text, sizeof text, "%s(0x%X, 0x%X, 0x%X) from 0x%08X", name, (uint32_t)ctx->a0, (uint32_t)ctx->a1,
             (uint32_t)ctx->a2, (uint32_t)ctx->ra);
    if (!strcmp(text, last[id])) { /* the same call over and over is said once, with a count */
        repeats[id]++;
        return;
    }
    if (repeats[id])
        fprintf(stderr, "  thread %d: ...%d more times\n", id, repeats[id]);
    repeats[id] = 0;
    strcpy(last[id], text);
    fprintf(stderr, "trace %ld thread %d: %s\n", frames, id, text);
}

void trap(Context *ctx, const char *reason, uint32_t address) {
    fprintf(stderr, "\ngame stopped: %s at 0x%08X\n", reason, address);
    fprintf(stderr, "  thread %d, return address 0x%08X, frame %ld\n",
            current ? current->id : -1, (uint32_t)ctx->ra, frames);
    exit(1);
}
/* The CPU's own control registers ("coprocessor 0"). The OS library uses
 * them for interrupts, which we do not have; what matters to us is the
 * handful that describe an address mapping, for the games that set
 * mappings up by hand instead of asking the library. */
enum { C0_INDEX = 0, C0_RANDOM = 1, C0_ENTRYLO0 = 2, C0_ENTRYLO1 = 3, C0_PAGEMASK = 5, C0_COUNT = 9, C0_ENTRYHI = 10 };
static uint64_t control[32];
static uint32_t tlb_raw[TLB_ENTRIES][4]; /* each entry as the game wrote it: mask, hi, lo0, lo1 */

uint64_t cop0_read(Context *ctx, int reg) {
    (void)ctx;
    if (reg == C0_COUNT)
        return (uint32_t)(ticks += 100);
    if (reg == C0_RANDOM)
        return (uint64_t)(31 - (ticks++ % 24));
    return control[reg & 31];
}
void cop0_write(Context *ctx, int reg, uint64_t value) {
    (void)ctx;
    control[reg & 31] = value;
}

void tlb_instruction(Context *ctx, int which) {
    (void)ctx;
    uint32_t index = (uint32_t)control[C0_INDEX] & 31;
    if (which == 6) /* "write a random entry" */
        index = (uint32_t)cop0_read(ctx, C0_RANDOM);
    if (which == 2 || which == 6) {
        /* An entry maps two neighbouring pages: the address they start at,
         * their size, and where in real memory each of the two is. */
        uint32_t mask = (uint32_t)control[C0_PAGEMASK], hi = (uint32_t)control[C0_ENTRYHI];
        uint32_t lo[2] = {(uint32_t)control[C0_ENTRYLO0], (uint32_t)control[C0_ENTRYLO1]};
        uint32_t page_size = ((mask >> 13) + 1) * 0x1000;
        uint32_t start = hi & ~(page_size * 2 - 1);
        tlb_raw[index][0] = mask, tlb_raw[index][1] = hi, tlb_raw[index][2] = lo[0], tlb_raw[index][3] = lo[1];
        for (int half = 0; half < 2; half++) {
            int valid = (lo[half] & 2) && start < 0x80000000u; /* (bit 1: "this page is in use") */
            tlb[index * 2 + half].start = start + (uint32_t)half * page_size;
            tlb[index * 2 + half].size = valid ? page_size : 0;
            tlb[index * 2 + half].physical = ((lo[half] >> 6) & 0xFFFFF) << 12;
        }
    } else if (which == 1) {
        control[C0_PAGEMASK] = tlb_raw[index][0], control[C0_ENTRYHI] = tlb_raw[index][1];
        control[C0_ENTRYLO0] = tlb_raw[index][2], control[C0_ENTRYLO1] = tlb_raw[index][3];
    } else if (which == 8) { /* which entry maps the address in EntryHi? */
        uint32_t address = (uint32_t)control[C0_ENTRYHI] & 0xFFFFE000;
        control[C0_INDEX] = 0x80000000u; /* "none" */
        for (int i = 0; i < TLB_ENTRIES * 2; i++)
            if (tlb[i].size && address - tlb[i].start < tlb[i].size)
                control[C0_INDEX] = (uint64_t)(i / 2);
    }
}

/* ---- Save states -----------------------------------------------------------------
 * A save state is a photograph of the whole machine at one moment: the
 * game's memory, every thread, the timers, the save chip. Loading one puts
 * all of it back, and the game carries on from that moment as if nothing
 * had happened. It is not the game's own saving and the game knows nothing
 * about it.
 *
 * The awkward part is the threads. Each is a half-finished chain of C
 * function calls, kept on its own stack: return addresses, and pointers to
 * memory. Bytes copied back into the same place work again only if
 * everything they point to is where it was. So the game's memory and the
 * stacks are at fixed addresses (memory_at), and the program is built so
 * that its own code and variables are too (-no-pie in __main__.py).
 *
 * That makes a state good for this exact build of this exact game. A state
 * from another build is refused: its return addresses would point into the
 * wrong code. Rebuilding (after any change to the tools) therefore makes
 * old states unusable; the game's own saves are not affected. */

static int state_slot = 1;
static int state_request; /* 1: save, 2: load. Carried out in main(), between threads. */
enum { STATE_SAVE = 1, STATE_LOAD = 2 };

/* Everything apart from the memory and the stacks. */
static struct { void *data; size_t size; } state_parts[] = {
    {tlb, sizeof tlb}, {threads, sizeof threads}, {&thread_count, sizeof thread_count},
    {&turn_counter, sizeof turn_counter}, {events, sizeof events},
    {&vi_queue, sizeof vi_queue}, {&vi_message, sizeof vi_message}, {&framebuffer, sizeof framebuffer},
    {&loop_budget, sizeof loop_budget}, {&ticks, sizeof ticks}, {timers, sizeof timers},
    {&video_records, sizeof video_records}, {eeprom, sizeof eeprom}, {pif, sizeof pif}, {sram, sizeof sram}, {&pi_command_queue, sizeof pi_command_queue},
    {hardware, sizeof hardware}, {hardware_spare, sizeof hardware_spare}, {control, sizeof control}, {tlb_raw, sizeof tlb_raw},
};
#define STATE_PART_COUNT (sizeof state_parts / sizeof state_parts[0])

static const char *state_file(int slot) {
    static char path[600];
    snprintf(path, sizeof path, "%s.slot%d", states_path ? states_path : "", slot);
    return path;
}
static int state_exists(int slot) { return states_path && access(state_file(slot), R_OK) == 0; }

/* A number that is different for every build and every ROM: a hash of this
 * program's own file and of the ROM. */
static uint64_t build_number(void) {
    static uint64_t hash;
    if (hash)
        return hash;
    hash = 1469598103934665603ull;
    FILE *file = fopen("/proc/self/exe", "rb"); /* Linux's name for "the program now running" */
    uint8_t block[65536];
    size_t got;
    while (file && (got = fread(block, 1, sizeof block, file)) > 0)
        for (size_t i = 0; i < got; i++)
            hash = (hash ^ block[i]) * 1099511628211ull;
    if (file)
        fclose(file);
    for (size_t i = 0; i < rom_size; i++)
        hash = (hash ^ rom[i]) * 1099511628211ull;
    return hash;
}

/* The part of a thread's stack that is in use: from where its stack pointer
 * was when it last stopped, to the top. (Stacks grow downwards.) */
static void stack_in_use(int index, uint8_t **start, uint64_t *size) {
    uint8_t *bottom = thread_stack(index), *top = bottom + NATIVE_STACK_SIZE;
    uint8_t *used = bottom;
#ifdef __x86_64__
    uint8_t *sp = (uint8_t *)threads[index].uc.uc_mcontext.gregs[REG_RSP] - 256;
    if (sp > bottom && sp < top)
        used = sp;
#endif
    *start = used, *size = (uint64_t)(top - used);
}

#define STATE_MAGIC "SnakeState 1"

static void save_state(void) {
    char text[64];
    FILE *file = states_path ? fopen(state_file(state_slot), "wb") : NULL;
    if (!file) {
        say("Could not save the state");
        return;
    }
    uint64_t build = build_number();
    fwrite(STATE_MAGIC, 1, sizeof STATE_MAGIC, file);
    fwrite(&build, sizeof build, 1, file);
    for (size_t i = 0; i < STATE_PART_COUNT; i++)
        fwrite(state_parts[i].data, 1, state_parts[i].size, file);
    fwrite(ram, 1, RAM_SIZE, file);
    for (int i = 0; i < thread_count; i++) {
        uint8_t *start;
        uint64_t size;
        stack_in_use(i, &start, &size);
        fwrite(&size, sizeof size, 1, file);
        fwrite(start, 1, size, file);
    }
    int failed = ferror(file);
    failed |= fclose(file) != 0;
    snprintf(text, sizeof text, failed ? "Could not save state %d" : "State %d saved", state_slot);
    say(text);
}

static void load_state(void) {
    char text[64], magic[sizeof STATE_MAGIC];
    uint64_t build = 0;
    FILE *file = states_path ? fopen(state_file(state_slot), "rb") : NULL;
    if (!file) {
        snprintf(text, sizeof text, "State %d is empty", state_slot);
        say(text);
        return;
    }
    /* Check everything we can before changing anything: once we start
     * copying over the machine there is no going back. */
    fseek(file, 0, SEEK_END);
    long length = ftell(file), fixed = (long)(sizeof magic + sizeof build) + RAM_SIZE;
    for (size_t i = 0; i < STATE_PART_COUNT; i++)
        fixed += (long)state_parts[i].size;
    rewind(file);
    if (length < fixed || fread(magic, 1, sizeof magic, file) != sizeof magic ||
        memcmp(magic, STATE_MAGIC, sizeof magic) || fread(&build, sizeof build, 1, file) != 1 ||
        build != build_number()) {
        fclose(file);
        snprintf(text, sizeof text, "State %d is from another build: not loaded", state_slot);
        say(text);
        return;
    }
    size_t got = 0, wanted = 0;
    for (size_t i = 0; i < STATE_PART_COUNT; i++)
        got += fread(state_parts[i].data, 1, state_parts[i].size, file), wanted += state_parts[i].size;
    got += fread(ram, 1, RAM_SIZE, file), wanted += RAM_SIZE;
    for (int i = 0; i < thread_count && i < MAX_THREADS; i++) {
        uint8_t *bottom = thread_stack(i); /* (this also makes the stack, if this run has not needed it yet) */
        uint64_t size = 0;
        got += fread(&size, 1, sizeof size, file), wanted += sizeof size;
        if (size > NATIVE_STACK_SIZE)
            break;
        got += fread(bottom + NATIVE_STACK_SIZE - size, 1, size, file), wanted += size;
    }
    fclose(file);
    if (got != wanted) /* a damaged file: the machine is now half one thing and half another */
        fatal("the state file was cut short; the game cannot carry on", (uint32_t)state_slot);

    /* The pictures and sound that were waiting belong to the moment we left. */
    shown_count = shown_next = 0;
    gfx_forget_last_frame();
    sound_chip.count = 0; /* (the chip is not part of a state: it starts idle) */
#ifdef USE_SDL
    if (audio_device)
        SDL_ClearQueuedAudio(audio_device);
#endif
    snprintf(text, sizeof text, "State %d loaded", state_slot);
    say(text);
}

/* Called from main() at a moment when no thread is part-way through running. */
static void carry_out_state_request(void) {
    if (state_request == STATE_SAVE)
        save_state();
    if (state_request == STATE_LOAD)
        load_state();
    state_request = 0;
}

/* ---- Window, input, screenshots ------------------------------------------------ */

enum { /* the N64 controller's buttons, as bits */
    BTN_A = 0x8000, BTN_B = 0x4000, BTN_Z = 0x2000, BTN_START = 0x1000,
    BTN_DUP = 0x0800, BTN_DDOWN = 0x0400, BTN_DLEFT = 0x0200, BTN_DRIGHT = 0x0100,
    BTN_L = 0x0020, BTN_R = 0x0010,
    BTN_CUP = 0x0008, BTN_CDOWN = 0x0004, BTN_CLEFT = 0x0002, BTN_CRIGHT = 0x0001,
};
#define STICK_MAX 80

/* How much wider than the original the visible scene is. Game-specific code
 * (the games/ folder) uses it to keep objects at the sides from vanishing. */
float host_view_widen = 1;
static float base_view_widen = 1;
/* How far the simple look-around has turned the view to the right (radians). */
static float simple_look_yaw, simple_look_pitch;
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
static int fullscreen;

/* ---- Controls --------------------------------------------------------------------
 * One table says what does what. Each row is something that can be done: a
 * button or stick direction of the N64 controller, or a shortcut (something
 * the PC does rather than the game). Each row can be given a keyboard key,
 * a mouse button and a gamepad button, all changeable in the menu. */

enum { DEVICE_KEY, DEVICE_MOUSE, DEVICE_PAD, DEVICE_COUNT };
static const char *device_names[DEVICE_COUNT] = {"key", "mouse", "pad"}; /* as written in the settings file */

/* What can be chosen on a gamepad: SDL's numbered buttons, and after them
 * the two triggers and the eight stick directions, which SDL counts as
 * sticks ("axes") and we give numbers of our own. -1 means "nothing". */
enum {
    PAD_NONE = -1,
    PAD_LEFT_TRIGGER = SDL_CONTROLLER_BUTTON_MAX, PAD_RIGHT_TRIGGER,
    PAD_LSTICK_UP, PAD_LSTICK_DOWN, PAD_LSTICK_LEFT, PAD_LSTICK_RIGHT,
    PAD_RSTICK_UP, PAD_RSTICK_DOWN, PAD_RSTICK_LEFT, PAD_RSTICK_RIGHT,
    PAD_CODE_COUNT
};
#define PAD(name) SDL_CONTROLLER_BUTTON_##name

enum {
    NOT_A_SHORTCUT, SHORTCUT_FAST, SHORTCUT_SAVE, SHORTCUT_LOAD, SHORTCUT_LOOK, SHORTCUT_CAMERA_RESET,
    SHORTCUT_CAMERA_NEARER, SHORTCUT_CAMERA_FARTHER, SHORTCUT_CHEAT, SHORTCUT_PICTURE, SHORTCUT_COUNT
};

typedef struct {
    const char *name;
    int button, x, y; /* the N64 button, or the stick direction, this row stands for */
    int shortcut;     /* or which shortcut */
    int now[DEVICE_COUNT], usual[DEVICE_COUNT]; /* key, mouse button, gamepad button: now, and to go back to */
} Binding;

/* key, mouse button (0: none; 1 left, 2 middle, 3 right), gamepad button */
#define USUAL(key, mouse, pad) {SDL_SCANCODE_##key, mouse, pad}, {SDL_SCANCODE_##key, mouse, pad}
static Binding bindings[] = {
    {"Stick up", 0, 0, 1, 0, USUAL(W, 0, PAD_LSTICK_UP)},
    {"Stick down", 0, 0, -1, 0, USUAL(S, 0, PAD_LSTICK_DOWN)},
    {"Stick left", 0, -1, 0, 0, USUAL(A, 0, PAD_LSTICK_LEFT)},
    {"Stick right", 0, 1, 0, 0, USUAL(D, 0, PAD_LSTICK_RIGHT)},
    {"A", BTN_A, 0, 0, 0, USUAL(J, 0, PAD(A))},
    {"B", BTN_B, 0, 0, 0, USUAL(K, 0, PAD(X))},
    {"Z", BTN_Z, 0, 0, 0, USUAL(L, 0, PAD(LEFTSHOULDER))},
    {"Start", BTN_START, 0, 0, 0, USUAL(RETURN, 0, PAD(START))},
    {"C up", BTN_CUP, 0, 0, 0, USUAL(UP, 0, PAD_RSTICK_UP)},
    {"C down", BTN_CDOWN, 0, 0, 0, USUAL(DOWN, 0, PAD_RSTICK_DOWN)},
    {"C left", BTN_CLEFT, 0, 0, 0, USUAL(LEFT, 0, PAD_RSTICK_LEFT)},
    {"C right", BTN_CRIGHT, 0, 0, 0, USUAL(RIGHT, 0, PAD_RSTICK_RIGHT)},
    {"L", BTN_L, 0, 0, 0, USUAL(Q, 0, PAD(Y))},
    {"R", BTN_R, 0, 0, 0, USUAL(E, 0, PAD(RIGHTSHOULDER))},
    {"D-pad up", BTN_DUP, 0, 0, 0, USUAL(UNKNOWN, 0, PAD(DPAD_UP))},
    {"D-pad down", BTN_DDOWN, 0, 0, 0, USUAL(UNKNOWN, 0, PAD(DPAD_DOWN))},
    {"D-pad left", BTN_DLEFT, 0, 0, 0, USUAL(UNKNOWN, 0, PAD(DPAD_LEFT))},
    {"D-pad right", BTN_DRIGHT, 0, 0, 0, USUAL(UNKNOWN, 0, PAD(DPAD_RIGHT))},
    /* (No gamepad button to begin with: the right trigger used to be it, and
     * is where a hand rests, so games ran four times too fast with the sound
     * cutting out, and it looked like a fault.) */
    {"Fast forward", 0, 0, 0, SHORTCUT_FAST, USUAL(TAB, 0, PAD_NONE)},
    {"Save state", 0, 0, 0, SHORTCUT_SAVE, USUAL(F5, 0, PAD_NONE)},
    {"Load state", 0, 0, 0, SHORTCUT_LOAD, USUAL(F7, 0, PAD_NONE)},
    {"Look (hold)", 0, 0, 0, SHORTCUT_LOOK, USUAL(UNKNOWN, 3, PAD_NONE)},
    {"Reset camera", 0, 0, 0, SHORTCUT_CAMERA_RESET, USUAL(UNKNOWN, 2, PAD(RIGHTSTICK))},
    {"Camera nearer", 0, 0, 0, SHORTCUT_CAMERA_NEARER, USUAL(PAGEUP, 0, PAD(DPAD_UP))},
    {"Camera farther", 0, 0, 0, SHORTCUT_CAMERA_FARTHER, USUAL(PAGEDOWN, 0, PAD(DPAD_DOWN))},
    /* Some ready-made cheats only act while this is held ("Press GS for..."). */
    {"Cheat button", 0, 0, 0, SHORTCUT_CHEAT, USUAL(G, 0, PAD_NONE)},
    /* Saves what is on screen as a picture file (see save_window_picture). */
    {"Screenshot", 0, 0, 0, SHORTCUT_PICTURE, USUAL(F12, 0, PAD(LEFTSTICK))},
};
#define BINDING_COUNT ((int)(sizeof bindings / sizeof bindings[0]))

/* With this on, the right stick turns the camera (see "Free camera" below)
 * instead of being whatever the table says. */
static int free_camera;
/* With this on, the gamepad's D-pad pushes the control stick as well as
 * being the N64's D-pad. Many N64 games ignore the D-pad altogether and
 * want the stick even in their menus, where a D-pad feels more natural. It
 * starts on for games whose file says they do not use the D-pad. */
static int dpad_moves_stick;

/* The names of gamepad buttons differ between makes, so we show the ones
 * printed on the gamepad that is plugged in. */
static int pad_is_playstation(void) {
    if (!gamepad)
        return 0;
    SDL_GameControllerType type = SDL_GameControllerGetType(gamepad);
    return type == SDL_CONTROLLER_TYPE_PS3 || type == SDL_CONTROLLER_TYPE_PS4 || type == SDL_CONTROLLER_TYPE_PS5;
}
static const char *pad_label(int pad) {
    static const char *xbox[PAD_CODE_COUNT] = {
        "A", "B", "X", "Y", "View", "Guide", "Menu", "LS click", "RS click", "LB", "RB",
        "D-pad up", "D-pad down", "D-pad left", "D-pad right", "Share", "Paddle 1", "Paddle 2", "Paddle 3",
        "Paddle 4", "Touchpad",
        [PAD_LEFT_TRIGGER] = "LT", "RT", "L stick up", "L stick down", "L stick left", "L stick right",
        "R stick up", "R stick down", "R stick left", "R stick right"};
    static const char *playstation[PAD_CODE_COUNT] = {
        "Cross", "Circle", "Square", "Triangle", "Share", "PS", "Options", "L3", "R3", "L1", "R1",
        [PAD_LEFT_TRIGGER] = "L2", "R2"};
    if (pad < 0 || pad >= PAD_CODE_COUNT)
        return "-";
    const char *name = pad_is_playstation() && playstation[pad] ? playstation[pad] : xbox[pad];
    return name ? name : "?";
}
/* The settings file uses names that do not depend on the gamepad's make. */
static const char *pad_file_names[] = {"lefttrigger", "righttrigger", "lstick-up", "lstick-down", "lstick-left",
                                       "lstick-right", "rstick-up", "rstick-down", "rstick-left", "rstick-right"};
static const char *mouse_names[] = {"-", "Left", "Middle", "Right", "Back", "Forward"};

/* A key, mouse button or gamepad button as text. for_file: the name used in
 * the settings file rather than the one shown in the menu. */
static const char *code_name(int device, int code, int for_file) {
    const char *nothing = for_file ? "(none)" : "-"; /* ("-" in the file would be the minus key) */
    if (device == DEVICE_KEY)
        return code == SDL_SCANCODE_UNKNOWN ? nothing : SDL_GetScancodeName((SDL_Scancode)code);
    if (device == DEVICE_MOUSE)
        return code >= 1 && code <= 5 ? mouse_names[code] : nothing;
    if (code < 0 || code >= PAD_CODE_COUNT)
        return nothing;
    if (!for_file)
        return pad_label(code);
    return code >= PAD_LEFT_TRIGGER ? pad_file_names[code - PAD_LEFT_TRIGGER] : SDL_GameControllerGetStringForButton(code);
}
static int code_from_name(int device, const char *name) {
    if (device == DEVICE_KEY)
        return (int)SDL_GetScancodeFromName(name); /* gives "no key" for anything it does not know */
    if (device == DEVICE_MOUSE) {
        for (int i = 1; i <= 5; i++)
            if (!strcmp(name, mouse_names[i]))
                return i;
        return 0;
    }
    for (int i = 0; i < PAD_CODE_COUNT - PAD_LEFT_TRIGGER; i++)
        if (!strcmp(name, pad_file_names[i]))
            return PAD_LEFT_TRIGGER + i;
    return (int)SDL_GameControllerGetButtonFromString(name); /* -1 for anything it does not know */
}

/* Give a row a new key or button. If another row was using it, the two
 * change places, so that nothing ever does two things at once. */
static void assign(int number, int device, int code) {
    int nothing = device == DEVICE_PAD ? PAD_NONE : 0;
    for (int i = 0; i < BINDING_COUNT; i++)
        if (code != nothing && bindings[i].now[device] == code)
            bindings[i].now[device] = bindings[number].now[device];
    bindings[number].now[device] = code;
}

static int shortcut_held[SHORTCUT_COUNT]; /* which shortcuts are being held right now */

/* A stick's position as two numbers from -1 to 1, with the small wobble of
 * a stick at rest (the "dead zone") taken out. */
static void stick_position(SDL_GameControllerAxis x_axis, float *x, float *y) {
    *x = (float)SDL_GameControllerGetAxis(gamepad, x_axis) / 32767;
    *y = (float)SDL_GameControllerGetAxis(gamepad, (SDL_GameControllerAxis)(x_axis + 1)) / 32767;
    if (sqrtf(*x * *x + *y * *y) < 0.18f)
        *x = *y = 0;
}

/* How far a gamepad button is pressed, 0 to 1. Real buttons are all or
 * nothing; triggers and stick directions can be anywhere in between. */
static float pad_amount(int pad) {
    if (!gamepad || pad == PAD_NONE)
        return 0;
    if (pad < SDL_CONTROLLER_BUTTON_MAX)
        return SDL_GameControllerGetButton(gamepad, (SDL_GameControllerButton)pad) ? 1 : 0;
    if (pad == PAD_LEFT_TRIGGER || pad == PAD_RIGHT_TRIGGER)
        return (float)SDL_GameControllerGetAxis(gamepad, pad == PAD_LEFT_TRIGGER ? SDL_CONTROLLER_AXIS_TRIGGERLEFT
                                                                                 : SDL_CONTROLLER_AXIS_TRIGGERRIGHT) / 32767;
    int right = pad >= PAD_RSTICK_UP, direction = (pad - PAD_LSTICK_UP) % 4; /* up, down, left, right */
    if (right && (free_camera || shortcut_held[SHORTCUT_LOOK]))
        return 0; /* the right stick is busy being the camera */
    float x, y, amount;
    stick_position(right ? SDL_CONTROLLER_AXIS_RIGHTX : SDL_CONTROLLER_AXIS_LEFTX, &x, &y);
    amount = direction == 0 ? -y : direction == 1 ? y : direction == 2 ? -x : x; /* up is negative for SDL */
    return amount > 0 ? amount : 0;
}

/* How far a row of the table is pressed, by any of its three means. */
static float binding_amount(const Binding *b) {
    float amount = pad_amount(b->now[DEVICE_PAD]);
    if (b->now[DEVICE_KEY] != SDL_SCANCODE_UNKNOWN && SDL_GetKeyboardState(NULL)[b->now[DEVICE_KEY]])
        amount = 1;
    if (b->now[DEVICE_MOUSE] && (SDL_GetMouseState(NULL, NULL) & SDL_BUTTON(b->now[DEVICE_MOUSE])))
        amount = 1;
    return amount;
}

static void open_window(void) {
    if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_GAMECONTROLLER) != 0)
        fatal(SDL_GetError(), 0);
    int w, h;
    gfx_picture(1, &w, &h);
    /* Ask for a window we can draw into with the graphics card (OpenGL 3.3). */
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 3);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_CORE);
    window = SDL_CreateWindow("Snake's N64 decompiler", SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED,
                              720 * w / h, 720, SDL_WINDOW_RESIZABLE | SDL_WINDOW_OPENGL);
    if (!window || !SDL_GL_CreateContext(window))
        fatal(SDL_GetError(), 0);
    SDL_GL_SetSwapInterval(0); /* we keep time ourselves (wait_for_next_frame) */
    glb_init();
    if (fullscreen) /* remembered from last time */
        SDL_SetWindowFullscreen(window, SDL_WINDOW_FULLSCREEN_DESKTOP);

    if (run_log) { /* which screen, and how often it redraws: a picture rate that does not divide it looks uneven */
        SDL_DisplayMode mode;
        int screen = SDL_GetWindowDisplayIndex(window);
        if (SDL_GetCurrentDisplayMode(screen, &mode) == 0)
            fprintf(stderr, "screen: %s, %dx%d at %d Hz, video driver %s\n", SDL_GetDisplayName(screen), mode.w, mode.h,
                    mode.refresh_rate, SDL_GetCurrentVideoDriver());
    }

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
    /* About 22 lines of text fit the height of the window, whatever its
     * size; the widest page of the menu is 60 characters and must fit too. */
    int size = (h + 180) / 360;
    while (size > 1 && 60 * 8 * size > w)
        size--;
    return size < 1 ? 1 : size > 6 ? 6 : size;
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
         audio_device ? SDL_GetQueuedAudioSize(audio_device) / ((uint32_t)sound_chip.frequency / 250) : 0, sound_gaps, late_refreshes);
#undef LINE
    stats.since = now, stats.refreshes = stats.shown = 0;
    stats.cpu_seconds_before = cpu_seconds_used();
    second_draw_ms = second_draw_worst = 0, second_pictures = 0;
}

/* ---- The menu ---------------------------------------------------------------
 * Esc (or F1, or Select on a gamepad) opens the main menu, which leads to a
 * page for each group of settings. The game keeps running behind it, and
 * every choice takes effect the moment it is made, so the result can be
 * seen straight away.
 *
 * A page is a list of rows. Each row has the text to show and an "action":
 * what to do when the player changes or selects it. menu_rows() builds the
 * list for a page, and menu_act() carries an action out. */

enum {
    PAGE_MAIN, PAGE_GRAPHICS, PAGE_SOUND, PAGE_CONTROLS, PAGE_CHEATS, PAGE_FIXES, PAGE_SYSTEM,
    PAGE_ASK_RESET, PAGE_ASK_QUIT, PAGE_STATES, PAGE_SHORTCUTS, PAGE_COUNT
};
/* The two pages of mods show one kind each (see mods.h). */
static const int page_kind[PAGE_COUNT] = {[PAGE_CHEATS] = KIND_CHEAT, [PAGE_FIXES] = KIND_FIX};
static const char *page_titles[PAGE_COUNT] = {
    "MENU", "GRAPHICS", "SOUND", "CONTROLS", "CHEATS", "FIXES", "SYSTEM",
    "RESET? UNSAVED PROGRESS WILL BE LOST", "QUIT? UNSAVED PROGRESS WILL BE LOST",
    "SAVE STATES", "SHORTCUTS",
};

enum {
    ACT_NONE, ACT_RESUME, ACT_BACK, ACT_OPEN, /* ACT_OPEN: go to page "number" */
    ACT_WIDE, ACT_SMOOTH, ACT_SCALE, ACT_FULLSCREEN, ACT_TEXTURES, ACT_LOOK,
    ACT_SOUND, ACT_VOLUME, ACT_SOUND_BUFFER,
    ACT_BIND, ACT_USUAL_CONTROLS, /* ACT_BIND: choose a key or button for bindings[number] */
    ACT_FREE_CAMERA, ACT_DPAD, ACT_CAMERA_STYLE, ACT_STICK_FOLLOWS,
    ACT_MOD, /* switch game_mods[number] */
    ACT_CHEAT, /* change cheats[number] (the ready-made ones, see cheats.c) */
    ACT_SLOT, ACT_SAVE_STATE, ACT_LOAD_STATE, ACT_FAST_SPEED,
    ACT_LIMIT, ACT_STATS, ACT_DEFAULTS,
    ACT_RESET, ACT_QUIT,
};

typedef struct {
    char text[64];
    int action, number;
    /* Rows of the controls table have three cells after the text, one for
     * each of keyboard, mouse and gamepad. */
    int has_cells;
    char cells[DEVICE_COUNT][16];
} Row;
#define MAX_ROWS 420
/* Where the cells start, counted in characters, and how wide the menu is
 * on pages with and without them. */
static const int cell_column[DEVICE_COUNT] = {17, 30, 39};
#define MENU_WIDTH 46
#define MENU_WIDTH_WITH_CELLS 58

static int menu_page, main_row;
static int menu_column;       /* which cell of a controls row is chosen */
static int waiting_for_press; /* the chosen cell is waiting for its new key or button */
static int mods_at_start[64]; /* which mods the game's file has on to begin with */

/* Write the menu's choices to the settings file, so they are still there
 * next time. Done after every change, so nothing is lost if the game stops
 * unexpectedly. */
static void save_settings(void) {
    FILE *file = settings_path ? fopen(settings_path, "w") : NULL;
    if (!file)
        return;
    fprintf(file, "# Choices made in the menu. 1 is on, 0 is off.\n");
    fprintf(file, "wide = %d\n", current_aspect > 1.5f);
    fprintf(file, "smooth = %d\n", smooth_motion);
    fprintf(file, "scale = %d\n", current_scale);
    fprintf(file, "fullscreen = %d\n", fullscreen);
    fprintf(file, "smooth textures = %d\n", gfx_texture_smoothing);
    fprintf(file, "stats = %d\n", stats_shown);
    fprintf(file, "sound = %d\n", !sound_muted);
    fprintf(file, "volume = %d\n", sound_volume);
    fprintf(file, "sound buffer = %d\n", sound_cushion_ms);
    fprintf(file, "speed limit = %d\n", speed_limit);
    fprintf(file, "fast forward speed = %d\n", fast_speed);
    fprintf(file, "state slot = %d\n", state_slot);
    fprintf(file, "free camera = %d\n", free_camera);
    fprintf(file, "dpad moves stick = %d\n", dpad_moves_stick);
    fprintf(file, "camera circles = %d\n", camera_circles);
    fprintf(file, "stick follows camera = %d\n", stick_follows_camera);
    for (int i = 0; i < BINDING_COUNT; i++)
        for (int device = 0; device < DEVICE_COUNT; device++)
            fprintf(file, "%s %s = %s\n", device_names[device], bindings[i].name,
                    code_name(device, bindings[i].now[device], 1));
    for (int i = 0; i < game_mod_count; i++)
        fprintf(file, "mod %s = %d\n", game_mods[i].name, game_mods[i].on);
    for (int i = 0; i < cheat_count; i++)
        if (cheats[i].on) /* (only the ones in use: the list can be long) */
            fprintf(file, "cheat %s = %d\n", cheats[i].name, cheats[i].on);
    fclose(file);
}

/* Make the window and the picture match the settings. Safe at any moment
 * the menu can be used: that is always between two of the game's pictures,
 * never part-way through drawing one. */
static void apply_picture_settings(void) {
    gfx_resize(current_scale, current_aspect);
    base_view_widen = current_aspect / (4.0f / 3);
    shown_count = shown_next = 0; /* pictures still waiting are the old size: drop them */
    SDL_SetWindowFullscreen(window, fullscreen ? SDL_WINDOW_FULLSCREEN_DESKTOP : 0);
    if (!fullscreen) {
        int w, h, window_w, window_h;
        gfx_picture(1, &w, &h);
        SDL_GetWindowSize(window, &window_w, &window_h);
        SDL_SetWindowSize(window, window_h * w / h, window_h); /* keep the height, fix the shape */
    }
}

/* Start the game again from the beginning, like the console's reset button.
 * The surest way to get everything back to how it starts is to start this
 * whole program again, so that is what we do: "exec" replaces the running
 * program with a fresh copy of itself. */
static char **start_arguments;
static void reset_game(void) {
    char *arguments[64];
    int count = 0;
    for (int i = 0; start_arguments[i] && count < 63; i++) {
        char *a = start_arguments[i];
        /* Leave out options that the menu has since overruled; the settings
         * file holds the current choices. */
        if (settings_path && i >= 2) {
            if (!strcmp(a, "--wide") || !strcmp(a, "--smooth") || !strcmp(a, "--stats"))
                continue;
            if (!strcmp(a, "--scale")) {
                i++;
                continue;
            }
        }
        arguments[count++] = a;
    }
    arguments[count] = NULL;
    save_settings();
    if (run_log)
        fprintf(stderr, "event %ld: reset\n", frames);
    SDL_Quit(); /* close the window and the sound first */
    execvp(arguments[0], arguments);
    fatal("could not start the game again", 0);
}

static void reset_camera(void) {
    host_camera.on = 0; /* back to the game's own camera */
    look_yaw = look_pitch = 0, look_zoom = 1;
}

static void usual_controls(int shortcuts) {
    for (int i = 0; i < BINDING_COUNT; i++)
        if (!bindings[i].shortcut == !shortcuts)
            memcpy(bindings[i].now, bindings[i].usual, sizeof bindings[i].now);
}

static void restore_defaults(void) {
    current_aspect = 4.0f / 3, current_scale = 3, smooth_motion = 0, fullscreen = 0;
    gfx_texture_smoothing = 1, stats_shown = 0;
    sound_muted = 0, sound_volume = 10, sound_cushion_ms = 100, speed_limit = 1, fast_speed = 4;
    reset_camera(), free_camera = 0, dpad_moves_stick = game_ignores_dpad;
    camera_circles = 1, stick_follows_camera = game_stick_follows_camera;
    usual_controls(0), usual_controls(1);
    for (int i = 0; i < game_mod_count && i < 64; i++)
        game_mods[i].on = mods_at_start[i];
    for (int i = 0; i < cheat_count; i++)
        cheats[i].on = 0;
    apply_picture_settings();
}

/* Build the rows of a page. Returns how many there are. */
static int menu_rows(int page, Row *rows) {
    int count = 0, w, h;
    gfx_picture(1, &w, &h);
/* Add a row: its action, a number that goes with the action, then the text. */
#define ROW(act, n, ...) \
    (rows[count].action = (act), rows[count].number = (n), rows[count].has_cells = 0, \
     snprintf(rows[count].text, 64, __VA_ARGS__), count++)
#define ON(value) ((value) ? "ON" : "off")
    switch (page) {
    case PAGE_MAIN:
        ROW(ACT_RESUME, 0, "Resume");
        ROW(ACT_OPEN, PAGE_STATES, "Save states");
        ROW(ACT_OPEN, PAGE_GRAPHICS, "Graphics");
        ROW(ACT_OPEN, PAGE_SOUND, "Sound");
        ROW(ACT_OPEN, PAGE_CONTROLS, "Controls");
        ROW(ACT_OPEN, PAGE_SHORTCUTS, "Shortcuts");
        for (int kind_page = PAGE_CHEATS; kind_page <= PAGE_FIXES; kind_page++) {
            int total = 0, on = 0;
            for (int i = 0; i < game_mod_count; i++)
                if (game_mods[i].kind == page_kind[kind_page])
                    total++, on += game_mods[i].on;
            for (int i = 0; kind_page == PAGE_CHEATS && i < cheat_count; i++)
                total++, on += cheats[i].on != 0;
            if (total) /* a game with none of them does not get the page */
                ROW(ACT_OPEN, kind_page, "%-26s%d of %d on", kind_page == PAGE_CHEATS ? "Cheats" : "Fixes", on, total);
        }
        ROW(ACT_OPEN, PAGE_SYSTEM, "System");
        ROW(ACT_OPEN, PAGE_ASK_RESET, "Reset game");
        ROW(ACT_OPEN, PAGE_ASK_QUIT, "Quit");
        return count;
    case PAGE_GRAPHICS:
        ROW(ACT_WIDE, 0, "%-26s%s", "Widescreen (16:9)", ON(current_aspect > 1.5f));
        ROW(ACT_SCALE, 0, "%-26s< %dx >  %dx%d", "Resolution", current_scale, w, h);
        ROW(ACT_FULLSCREEN, 0, "%-26s%s", "Full screen (F11)", ON(fullscreen));
        ROW(ACT_SMOOTH, 0, "%-26s%s", "Smooth motion (60 fps)", ON(smooth_motion));
        ROW(ACT_TEXTURES, 0, "%-26s%s", "Smooth textures", ON(gfx_texture_smoothing));
        ROW(ACT_LOOK, 0, "Reset camera");
        break;
    case PAGE_SOUND:
        ROW(ACT_SOUND, 0, "%-26s%s", "Sound", ON(!sound_muted));
        ROW(ACT_VOLUME, 0, "%-26s< %d%% >", "Volume", sound_volume * 10);
        ROW(ACT_SOUND_BUFFER, 0, "%-26s< %d ms >", "Buffer (more: no crackle)", sound_cushion_ms);
        break;
    case PAGE_CONTROLS:
    case PAGE_SHORTCUTS:
        if (page == PAGE_CONTROLS)
            ROW(ACT_FREE_CAMERA, 0, "%-17s%-5s%s", "Free camera", free_camera ? "ON" : "off",
                "right stick turns the view");
        if (page == PAGE_CONTROLS && !game_focus)
            ROW(ACT_CAMERA_STYLE, 0, "%-17s%s", "Camera style", camera_circles ? "circles the middle of the view" : "turns on the spot");
        if (page == PAGE_CONTROLS)
            ROW(ACT_STICK_FOLLOWS, 0, "%-17s%s", "Stick", stick_follows_camera ? "follows the free camera" : "as the game expects");
        if (page == PAGE_CONTROLS)
            ROW(ACT_DPAD, 0, "%-17s%s", "D-pad", dpad_moves_stick ? "also moves the control stick" : "N64 D-pad only");
        for (int i = 0; i < BINDING_COUNT; i++) {
            if (!bindings[i].shortcut != (page == PAGE_CONTROLS))
                continue;
            int row = ROW(ACT_BIND, i, "%s", bindings[i].name);
            rows[row].has_cells = 1;
            for (int device = 0; device < DEVICE_COUNT; device++)
                snprintf(rows[row].cells[device], sizeof rows[row].cells[device], "%s",
                         waiting_for_press && row == menu_row && device == menu_column
                             ? "press..." : code_name(device, bindings[i].now[device], 0));
        }
        ROW(ACT_USUAL_CONTROLS, page == PAGE_SHORTCUTS, "Put these back to usual");
        break;
    case PAGE_STATES:
        ROW(ACT_SLOT, 0, "%-26s< %d >  %s", "Slot", state_slot, state_exists(state_slot) ? "in use" : "empty");
        ROW(ACT_SAVE_STATE, 0, "Save state");
        ROW(ACT_LOAD_STATE, 0, "Load state");
        break;
    case PAGE_CHEATS:
    case PAGE_FIXES:
        for (int i = 0; i < game_mod_count; i++)
            if (game_mods[i].kind == page_kind[page])
                ROW(ACT_MOD, i, "%-37.37s%s", game_mods[i].name, ON(game_mods[i].on));
        /* Then the ready-made ones. One with choices shows the chosen
         * value's name, cut to fit; left and right step through them. */
        for (int i = 0; page == PAGE_CHEATS && i < cheat_count && count < MAX_ROWS - 2; i++) {
            if (cheats[i].choice_count)
                ROW(ACT_CHEAT, i, "%-24.24s <%.14s>", cheats[i].name, cheat_state(&cheats[i]));
            else
                ROW(ACT_CHEAT, i, "%-37.37s%s", cheats[i].name, cheat_state(&cheats[i]));
        }
        break;
    case PAGE_SYSTEM:
        ROW(ACT_LIMIT, 0, "%-26s%s", "Speed limit (60 Hz)", ON(speed_limit));
        if (fast_speed)
            ROW(ACT_FAST_SPEED, 0, "%-26s< %dx >", "Fast forward speed", fast_speed);
        else
            ROW(ACT_FAST_SPEED, 0, "%-26s< no limit >", "Fast forward speed");
        ROW(ACT_STATS, 0, "%-26s%s", "Statistics display (F3)", ON(stats_shown));
        ROW(ACT_DEFAULTS, 0, "Put every setting back to usual");
        break;
    case PAGE_ASK_RESET:
        ROW(ACT_BACK, 0, "No, go back");
        ROW(ACT_RESET, 0, "Yes, reset the game");
        return count;
    case PAGE_ASK_QUIT:
        ROW(ACT_BACK, 0, "No, go back");
        ROW(ACT_QUIT, 0, "Yes, quit");
        return count;
    }
    ROW(ACT_BACK, 0, "Back");
#undef ROW
#undef ON
    return count;
}

static void menu_go(int page) {
    if (menu_page == PAGE_MAIN)
        main_row = menu_row; /* to come back to the same place */
    menu_page = page;
    menu_row = page == PAGE_MAIN ? main_row : 0;
    waiting_for_press = 0;
}

static void menu_back(void) {
    if (menu_page == PAGE_MAIN)
        menu_open = 0;
    else
        menu_go(PAGE_MAIN);
}

/* Carry out a row's action. direction is -1 for Left and +1 for Right;
 * selected says the row was chosen with Enter (or A on a gamepad). Rows
 * that lead somewhere or do something drastic want Enter; rows that hold a
 * setting change with Left, Right or Enter alike. */
static void menu_act(int action, int number, int direction, int selected) {
    switch (action) {
    case ACT_RESUME: if (selected) menu_open = 0; return;
    case ACT_BACK: if (selected) menu_back(); return;
    case ACT_OPEN: if (selected || direction > 0) menu_go(number); return;
    case ACT_RESET: if (selected) reset_game(); return;
    case ACT_QUIT: if (selected) exit(0); return;
    case ACT_BIND: if (selected) waiting_for_press = 1; return; /* the next press is the answer */
    case ACT_USUAL_CONTROLS: if (!selected) return; usual_controls(number); break;
    case ACT_DEFAULTS: if (!selected) return; restore_defaults(); break;
    case ACT_LOOK: if (!selected) return; reset_camera(); break;
    /* Saving and loading happen a moment later, between two steps of the
     * game (see carry_out_state_request). */
    case ACT_SAVE_STATE: if (selected) state_request = STATE_SAVE; return;
    case ACT_LOAD_STATE: if (selected) state_request = STATE_LOAD, menu_open = 0; return;

    case ACT_WIDE:
        current_aspect = current_aspect > 1.5f ? 4.0f / 3 : 16.0f / 9;
        apply_picture_settings();
        break;
    case ACT_SCALE: {
        int scale = current_scale + direction;
        scale = scale < 1 ? 1 : scale > 6 ? 6 : scale;
        if (scale == current_scale)
            return;
        current_scale = scale;
        apply_picture_settings();
        break;
    }
    case ACT_FULLSCREEN: fullscreen = !fullscreen; apply_picture_settings(); break;
    case ACT_SMOOTH:
        smooth_motion = !smooth_motion;
        shown_count = shown_next = 0; /* do not show a leftover in-between picture */
        break;
    case ACT_TEXTURES: gfx_texture_smoothing = !gfx_texture_smoothing; break;
    case ACT_SOUND:
        sound_muted = !sound_muted;
        if (audio_device)
            SDL_ClearQueuedAudio(audio_device);
        break;
    case ACT_VOLUME:
        sound_volume += direction;
        sound_volume = sound_volume < 0 ? 0 : sound_volume > 10 ? 10 : sound_volume;
        break;
    case ACT_SOUND_BUFFER:
        sound_cushion_ms += 25 * direction;
        sound_cushion_ms = sound_cushion_ms < 25 ? 25 : sound_cushion_ms > 200 ? 200 : sound_cushion_ms;
        break;
    case ACT_FREE_CAMERA:
        free_camera = !free_camera;
        if (!free_camera) /* back to the game's own view */
            reset_camera();
        break;
    case ACT_DPAD: dpad_moves_stick = !dpad_moves_stick; break;
    case ACT_CAMERA_STYLE:
        camera_circles = !camera_circles;
        reset_camera(); /* start the other style from the game's own view */
        break;
    case ACT_STICK_FOLLOWS: stick_follows_camera = !stick_follows_camera; break;
    case ACT_MOD: game_mods[number].on ^= 1; break;
    case ACT_CHEAT: cheat_change(&cheats[number], selected ? 0 : direction); break;
    case ACT_SLOT: state_slot = (state_slot - 1 + direction + 9) % 9 + 1; break;
    case ACT_FAST_SPEED: {
        static const int speeds[] = {2, 3, 4, 8, 0}; /* 0: no limit */
        int at = 0;
        while (at < 4 && speeds[at] != fast_speed)
            at++;
        at += direction;
        fast_speed = speeds[at < 0 ? 0 : at > 4 ? 4 : at];
        break;
    }
    case ACT_LIMIT: speed_limit = !speed_limit; break;
    case ACT_STATS: stats_shown = !stats_shown; break;
    default: return;
    }
    save_settings();
}

static void draw_overlay(void) {
    int size = text_size(), line = 18 * size, letter = 8 * size;
    if (stats_shown && stats.line_count) {
        draw_box(4 * size, 4 * size, 49 * letter, stats.line_count * line + 6 * size, 150);
        for (int i = 0; i < stats.line_count; i++)
            draw_text(8 * size, 7 * size + i * line, stats.lines[i], 120, 255, 120);
    }
    int window_w, window_h;
    SDL_GL_GetDrawableSize(window, &window_w, &window_h);
    if (frames < message_until) { /* "State 1 saved" and the like, bottom left */
        draw_box(4 * size, window_h - line - 8 * size, ((int)strlen(message) + 2) * letter, line + 4 * size, 170);
        draw_text(12 * size, window_h - line - 4 * size, message, 255, 255, 255);
    } else if (fast_forward) {
        char text[40]; /* said in words, so that nobody takes it for a fault */
        if (fast_speed)
            snprintf(text, sizeof text, ">> Fast forward %dx (no sound)", fast_speed);
        else
            snprintf(text, sizeof text, ">> Fast forward (no sound)");
        draw_box(4 * size, window_h - line - 8 * size, ((int)strlen(text) + 2) * letter, line + 4 * size, 170);
        draw_text(12 * size, window_h - line - 4 * size, text, 255, 255, 255);
    }
    if (!menu_open)
        return;
    static Row rows[MAX_ROWS];
    int row_count = menu_rows(menu_page, rows);
    int table = menu_page == PAGE_CONTROLS || menu_page == PAGE_SHORTCUTS;
    /* A page too long for the window shows a part of itself, moved along so
     * that the chosen row is always in view. */
    int visible = window_h / line - 5;
    visible = visible < 3 ? 3 : visible > row_count ? row_count : visible;
    int first = menu_row - visible / 2;
    first = first > row_count - visible ? row_count - visible : first;
    first = first < 0 ? 0 : first;

    int box_w = (table ? MENU_WIDTH_WITH_CELLS : MENU_WIDTH) * letter, box_h = (visible + 4) * line;
    int x = (window_w - box_w) / 2, y = (window_h - box_h) / 2, text_x = x + 3 * letter;
    draw_box(x, y, box_w, box_h, 235);
    draw_text(x + letter, y + 6 * size, page_titles[menu_page], 255, 255, 255);
    if (table) { /* headings for the three cells */
        const char *pad_heading = pad_is_playstation() ? "PlayStation" : gamepad ? "Controller" : "(no gamepad)";
        draw_text(text_x + cell_column[DEVICE_KEY] * letter, y + 6 * size, "Keyboard", 150, 150, 150);
        draw_text(text_x + cell_column[DEVICE_MOUSE] * letter, y + 6 * size, "Mouse", 150, 150, 150);
        draw_text(text_x + cell_column[DEVICE_PAD] * letter, y + 6 * size, pad_heading, 150, 150, 150);
    }
    glb_overlay_bar(x + letter, y + line + 2 * size, box_w - 2 * letter, size, 255, 255, 255, 60); /* a rule under the title */
    for (int i = 0; i < visible; i++) {
        const Row *row = &rows[first + i];
        int selected = first + i == menu_row, row_y = y + (i + 2) * line - 6 * size;
        int bright = selected ? 255 : 200;
        if (selected && !row->has_cells) /* a soft bar behind the chosen row */
            glb_overlay_bar(x + letter / 2, row_y - size, box_w - letter, line, 255, 255, 255, 30);
        draw_text(x + letter, row_y, selected ? ">" : " ", 255, 220, 60);
        draw_text(text_x, row_y, row->text, bright, selected && !row->has_cells ? 220 : bright,
                  selected && !row->has_cells ? 60 : bright);
        for (int device = 0; row->has_cells && device < DEVICE_COUNT; device++) {
            int chosen = selected && device == menu_column, cell_x = text_x + cell_column[device] * letter;
            int next_x = device + 1 < DEVICE_COUNT ? text_x + cell_column[device + 1] * letter : x + box_w - letter / 2;
            if (chosen) /* ...or behind the chosen cell */
                glb_overlay_bar(cell_x - letter / 2, row_y - size, next_x - cell_x, line, 255, 255, 255, 45);
            int dim = !strcmp(row->cells[device], "-");
            draw_text(cell_x, row_y, row->cells[device], chosen ? 255 : dim ? 110 : 200, chosen ? 220 : dim ? 110 : 200,
                      chosen ? 60 : dim ? 110 : 200);
        }
    }
    const char *help = "Arrows: choose, change   Enter: select";
    if (waiting_for_press)
        help = menu_column == DEVICE_KEY ? "Press a key.  Backspace: none   Esc: cancel"
               : menu_column == DEVICE_MOUSE ? "Press a mouse button.  Backspace: none   Esc: cancel"
                                             : "Press a gamepad button.  Backspace: none   Esc: cancel";
    else if (rows[menu_row].has_cells)
        help = "Arrows: choose   Enter: change   Esc: back";
    char about[MENU_WIDTH - 6];
    if (rows[menu_row].action == ACT_CHEAT) { /* what the cheat's author said about it, if anything */
        const Cheat *cheat = &cheats[rows[menu_row].number];
        const char *note = cheat->needs_button ? "Acts while the cheat button is held (see Shortcuts)"
                           : cheat->note[0] ? cheat->note
                           : cheat->choice_count ? "Left, right: choose   Enter: next" : help;
        snprintf(about, sizeof about, "%s", note);
        help = about;
    }
    draw_text(x + letter, y + (visible + 2) * line + 2 * size, help, 150, 150, 150);
    if (visible < row_count) { /* say where we are in the list */
        char place[16];
        snprintf(place, sizeof place, "%d/%d", menu_row + 1, row_count);
        draw_text(x + box_w - ((int)strlen(place) + 1) * letter, y + (visible + 2) * line + 2 * size, place, 150, 150, 150);
    }
}

/* The chosen cell was waiting for a press and got one. */
static void finish_press(int device, int code) {
    static Row rows[MAX_ROWS];
    menu_rows(menu_page, rows);
    waiting_for_press = 0;
    if (device != menu_column || !rows[menu_row].has_cells)
        return; /* not the kind of press that was wanted: leave things as they are */
    assign(rows[menu_row].number, device, code);
    save_settings();
}

/* A key was pressed: is it one of ours? */
static void overlay_key(SDL_Scancode key) {
    if (menu_open && waiting_for_press) {
        if (key == SDL_SCANCODE_BACKSPACE) /* "nothing" for whichever cell is waiting */
            finish_press(menu_column, menu_column == DEVICE_PAD ? PAD_NONE : 0);
        else if (key == SDL_SCANCODE_ESCAPE || key == SDL_SCANCODE_F1 || key == SDL_SCANCODE_F3 || key == SDL_SCANCODE_F11)
            waiting_for_press = 0; /* these keys have fixed jobs */
        else if (menu_column == DEVICE_KEY)
            finish_press(DEVICE_KEY, (int)key);
        return;
    }
    static Row rows[MAX_ROWS];
    int row_count = menu_rows(menu_page, rows);
    if (key == SDL_SCANCODE_F3)
        menu_act(ACT_STATS, 0, 1, 0);
    else if (key == SDL_SCANCODE_F11)
        menu_act(ACT_FULLSCREEN, 0, 1, 0);
    else if (key == SDL_SCANCODE_F1) { /* opens and closes the menu from anywhere */
        menu_open = !menu_open;
        menu_page = PAGE_MAIN, menu_row = main_row = 0, waiting_for_press = 0;
    } else if (key == SDL_SCANCODE_ESCAPE) { /* opens the menu, then goes back a step at a time */
        if (menu_open)
            menu_back();
        else
            menu_open = 1, menu_page = PAGE_MAIN, menu_row = main_row = 0;
    } else if (!menu_open)
        return;
    else if (key == SDL_SCANCODE_UP)
        menu_row = (menu_row + row_count - 1) % row_count;
    else if (key == SDL_SCANCODE_DOWN)
        menu_row = (menu_row + 1) % row_count;
    else if ((key == SDL_SCANCODE_LEFT || key == SDL_SCANCODE_RIGHT) && rows[menu_row].has_cells) {
        menu_column += key == SDL_SCANCODE_LEFT ? -1 : 1; /* in the table, Left and Right move between cells */
        menu_column = menu_column < 0 ? 0 : menu_column >= DEVICE_COUNT ? DEVICE_COUNT - 1 : menu_column;
    } else if (key == SDL_SCANCODE_LEFT || key == SDL_SCANCODE_RIGHT)
        menu_act(rows[menu_row].action, rows[menu_row].number, key == SDL_SCANCODE_LEFT ? -1 : 1, 0);
    else if (key == SDL_SCANCODE_RETURN || key == SDL_SCANCODE_KP_ENTER)
        menu_act(rows[menu_row].action, rows[menu_row].number, 1, 1);
}

static void read_keyboard_and_gamepad(void) {
    SDL_Event event;
    float turn_right = 0, turn_down = 0; /* how far the player turns the camera this refresh */
    while (SDL_PollEvent(&event)) {
        if (event.type == SDL_QUIT) /* the window's close button */
            exit(0);
        if (event.type == SDL_KEYDOWN && !event.key.repeat)
            overlay_key(event.key.keysym.scancode);

        /* Controllers can be plugged in, or connect over Bluetooth, at any
         * time. SDL tells us when one arrives or leaves. We open every one
         * of them, and "gamepad" is whichever was touched last: with several
         * around (a second pad, or one left behind by a streaming program)
         * the one in the player's hands is the one that counts. */
        if (event.type == SDL_CONTROLLERDEVICEADDED) {
            SDL_GameController *arrived = SDL_GameControllerOpen(event.cdevice.which);
            if (arrived)
                printf("controller connected: %s\n", SDL_GameControllerName(arrived));
            if (!gamepad)
                gamepad = arrived;
        }
        if (event.type == SDL_CONTROLLERDEVICEREMOVED) {
            SDL_GameController *gone = SDL_GameControllerFromInstanceID(event.cdevice.which);
            if (gone) {
                printf("controller disconnected\n");
                SDL_GameControllerClose(gone);
            }
            if (gone == gamepad) {
                gamepad = NULL;
                for (int i = 0; i < SDL_NumJoysticks() && !gamepad; i++) /* fall back to another, if any */
                    gamepad = SDL_GameControllerFromInstanceID(SDL_JoystickGetDeviceInstanceID(i));
            }
        }
        if (event.type == SDL_CONTROLLERBUTTONDOWN)
            gamepad = SDL_GameControllerFromInstanceID(event.cbutton.which);
        if (event.type == SDL_CONTROLLERAXISMOTION && abs(event.caxis.value) > 20000)
            gamepad = SDL_GameControllerFromInstanceID(event.caxis.which);

        if (menu_open && waiting_for_press) {
            /* A cell of the controls table is waiting to be told its new
             * mouse or gamepad button. (Keys arrive through overlay_key.) */
            if (event.type == SDL_MOUSEBUTTONDOWN)
                finish_press(DEVICE_MOUSE, event.button.button <= 5 ? event.button.button : 0);
            else if (event.type == SDL_CONTROLLERBUTTONDOWN && event.cbutton.button == PAD(BACK))
                waiting_for_press = 0; /* Select is the menu button, and stays so */
            else if (event.type == SDL_CONTROLLERBUTTONDOWN)
                finish_press(DEVICE_PAD, event.cbutton.button);
            else if (event.type == SDL_CONTROLLERAXISMOTION && abs(event.caxis.value) > 20000) {
                /* A trigger pulled or a stick pushed: which one, which way? */
                int positive = event.caxis.value > 0;
                switch (event.caxis.axis) {
                case SDL_CONTROLLER_AXIS_TRIGGERLEFT: finish_press(DEVICE_PAD, PAD_LEFT_TRIGGER); break;
                case SDL_CONTROLLER_AXIS_TRIGGERRIGHT: finish_press(DEVICE_PAD, PAD_RIGHT_TRIGGER); break;
                case SDL_CONTROLLER_AXIS_LEFTX: finish_press(DEVICE_PAD, positive ? PAD_LSTICK_RIGHT : PAD_LSTICK_LEFT); break;
                case SDL_CONTROLLER_AXIS_LEFTY: finish_press(DEVICE_PAD, positive ? PAD_LSTICK_DOWN : PAD_LSTICK_UP); break;
                case SDL_CONTROLLER_AXIS_RIGHTX: finish_press(DEVICE_PAD, positive ? PAD_RSTICK_RIGHT : PAD_RSTICK_LEFT); break;
                case SDL_CONTROLLER_AXIS_RIGHTY: finish_press(DEVICE_PAD, positive ? PAD_RSTICK_DOWN : PAD_RSTICK_UP); break;
                }
            }
        } else if (event.type == SDL_CONTROLLERBUTTONDOWN) {
            /* On a controller, Select opens the menu; inside it the d-pad
             * moves and changes, A selects and B goes back. */
            switch (event.cbutton.button) {
            case SDL_CONTROLLER_BUTTON_BACK: overlay_key(SDL_SCANCODE_F1); break;
            case SDL_CONTROLLER_BUTTON_DPAD_UP: overlay_key(SDL_SCANCODE_UP); break;
            case SDL_CONTROLLER_BUTTON_DPAD_DOWN: overlay_key(SDL_SCANCODE_DOWN); break;
            case SDL_CONTROLLER_BUTTON_DPAD_LEFT: overlay_key(SDL_SCANCODE_LEFT); break;
            case SDL_CONTROLLER_BUTTON_DPAD_RIGHT: overlay_key(SDL_SCANCODE_RIGHT); break;
            case SDL_CONTROLLER_BUTTON_A:
                if (menu_open)
                    overlay_key(SDL_SCANCODE_RETURN);
                break;
            case SDL_CONTROLLER_BUTTON_B:
                if (menu_open)
                    overlay_key(SDL_SCANCODE_ESCAPE);
                break;
            }
        }
        /* Looking around with the mouse: while the "Look" shortcut is held,
         * moving the mouse turns the view. The wheel zooms. */
        if (event.type == SDL_MOUSEMOTION && shortcut_held[SHORTCUT_LOOK]) {
            turn_right += (float)event.motion.xrel * 0.004f;
            turn_down += (float)event.motion.yrel * 0.004f;
        }
        if (event.type == SDL_MOUSEWHEEL && !menu_open && camera_paused()) {
            /* nothing: the camera is fixed while the game is paused */
        } else if (event.type == SDL_MOUSEWHEEL && !menu_open && host_camera.on) { /* the free camera: nearer or farther */
            zoom_camera(event.wheel.y > 0 ? 1 / 1.1f : 1.1f);
        } else if (event.type == SDL_MOUSEWHEEL && !menu_open) {
            look_zoom *= event.wheel.y > 0 ? 1.1f : 1 / 1.1f;
            if (look_zoom < 0.5f) look_zoom = 0.5f;
            if (look_zoom > 8) look_zoom = 8;
        }
    }

    /* The table of controls: add up everything that is held. */
    int buttons = 0;
    float stick_x = 0, stick_y = 0;
    int held_now[SHORTCUT_COUNT] = {0};
    for (int i = 0; i < BINDING_COUNT; i++) {
        const Binding *b = &bindings[i];
        float amount = binding_amount(b);
        if (b->shortcut)
            held_now[b->shortcut] = amount > 0.4f && !menu_open;
        else if (b->button)
            buttons |= amount > 0.5f ? b->button : 0;
        else
            stick_x += (float)b->x * amount, stick_y += (float)b->y * amount;
    }
    /* Two extra keys that many people expect, unless they have been given
     * another job in the menu. */
    static const struct { SDL_Scancode key; int button; } extras[] = {
        {SDL_SCANCODE_SPACE, BTN_A}, {SDL_SCANCODE_LSHIFT, BTN_Z}};
    for (int e = 0; e < 2; e++) {
        int taken = 0;
        for (int i = 0; i < BINDING_COUNT; i++)
            taken |= bindings[i].now[DEVICE_KEY] == (int)extras[e].key;
        if (!taken && SDL_GetKeyboardState(NULL)[extras[e].key])
            buttons |= extras[e].button;
    }
    if (gamepad && dpad_moves_stick) {
        static const struct { int pad, x, y; } directions[4] = {
            {PAD(DPAD_UP), 0, 1}, {PAD(DPAD_DOWN), 0, -1}, {PAD(DPAD_LEFT), -1, 0}, {PAD(DPAD_RIGHT), 1, 0}};
        for (int d = 0; d < 4; d++) {
            /* ...unless that direction has been given some other job in the
             * table. (Moving the camera in and out only counts as a job
             * while there is a camera to move: in the game's menus and its
             * pause screen the D-pad is free to work the menu.) */
            int other_job = 0, camera_job;
            for (int i = 0; i < BINDING_COUNT; i++) {
                camera_job = bindings[i].shortcut == SHORTCUT_CAMERA_NEARER || bindings[i].shortcut == SHORTCUT_CAMERA_FARTHER;
                if (bindings[i].now[DEVICE_PAD] == directions[d].pad &&
                    !(bindings[i].button & (BTN_DUP | BTN_DDOWN | BTN_DLEFT | BTN_DRIGHT)) &&
                    !(camera_job && !camera_usable()))
                    other_job = 1;
            }
            if (!other_job && SDL_GameControllerGetButton(gamepad, (SDL_GameControllerButton)directions[d].pad))
                stick_x += (float)directions[d].x, stick_y += (float)directions[d].y;
        }
    }
    stick_x = stick_x > 1 ? 1 : stick_x < -1 ? -1 : stick_x;
    stick_y = stick_y > 1 ? 1 : stick_y < -1 ? -1 : stick_y;
    int x = (int)(stick_x * STICK_MAX), y = (int)(stick_y * STICK_MAX);

    /* While the menu is up, the keys are for the menu. And when it closes,
     * the key that closed it is probably still down: the game must not see
     * that as a press of its own (Enter is also Start), so it gets nothing
     * until everything has been let go. */
    static int wait_for_release;
    if (menu_open)
        wait_for_release = 1;
    else if (buttons == 0 && x == 0 && y == 0)
        wait_for_release = 0;
    if (menu_open || wait_for_release)
        buttons = 0, x = y = 0;
    pad_buttons = (uint16_t)buttons, pad_x = (int8_t)x, pad_y = (int8_t)y;

    /* Shortcuts. Fast forward and looking last as long as they are held;
     * the others act once, on the press. */
    if (getenv("PICTURE_TEST") && frames == atol(getenv("PICTURE_TEST"))) /* for testing: a screenshot at this frame */
        picture_wanted = 1;
    if (getenv("FAST_TEST")) /* for testing: hold fast forward from one frame to another */
        held_now[SHORTCUT_FAST] = frames >= atol(getenv("FAST_TEST")) && frames < atol(strchr(getenv("FAST_TEST"), ':') + 1);
    for (int i = 1; i < SHORTCUT_COUNT; i++) {
        int pressed = held_now[i] && !shortcut_held[i];
        shortcut_held[i] = held_now[i];
        if (pressed && i == SHORTCUT_SAVE)
            state_request = STATE_SAVE;
        if (pressed && i == SHORTCUT_LOAD)
            state_request = STATE_LOAD;
        if (pressed && i == SHORTCUT_CAMERA_RESET)
            reset_camera();
        if (pressed && i == SHORTCUT_PICTURE)
            picture_wanted = 1;
        /* Held: the camera slides in or out, about a third of the way a second. */
        /* (In a game without a camera made for it, these only act once the
         * free camera is switched on: the D-pad they are on to begin with
         * is something many games use themselves.) */
        int zoom_allowed = game_focus || free_camera || host_camera.on;
        if (held_now[i] && i == SHORTCUT_CAMERA_NEARER && zoom_allowed)
            zoom_camera(0.98f);
        if (held_now[i] && i == SHORTCUT_CAMERA_FARTHER && zoom_allowed)
            zoom_camera(1 / 0.98f);
    }
    fast_forward = shortcut_held[SHORTCUT_FAST];
    cheat_button_held = shortcut_held[SHORTCUT_CHEAT];

    /* The right stick turns the camera, a little every refresh for as long
     * as it is pushed. It does so whenever the "Free camera" setting is on,
     * and also while the "Look" shortcut is held. */
    if (gamepad && (free_camera || shortcut_held[SHORTCUT_LOOK]) && !menu_open) {
        float turn_x, turn_y;
        stick_position(SDL_CONTROLLER_AXIS_RIGHTX, &turn_x, &turn_y);
        turn_right += turn_x * 0.045f;
        turn_down += turn_y * 0.03f;
    }
    if (!turn_camera(turn_right, turn_down)) { /* no character to circle: turn on the spot instead */
        look_yaw += turn_right, look_pitch += turn_down;
        if (look_pitch > 1.4f) look_pitch = 1.4f;
        if (look_pitch < -1.4f) look_pitch = -1.4f;
    }
    simple_look_yaw = look_yaw, simple_look_pitch = look_pitch;
    gfx_set_view(look_yaw, look_pitch, look_zoom);
}

/* The screenshot shortcut: write what the window is showing to a file in
 * the screenshots folder, named after the game and numbered. Handy for
 * showing someone exactly what went wrong. */
static void save_window_picture(int w, int h) {
    char path[700], text[64];
    if (!pictures_path)
        return;
    int number = 1;
    do
        snprintf(path, sizeof path, "%s-%03d.bmp", pictures_path, number++);
    while (access(path, F_OK) == 0 && number < 1000);
    uint8_t *pixels = malloc((size_t)w * (size_t)h * 3);
    glb_read_window(pixels, w, h);
    SDL_Surface *surface = SDL_CreateRGBSurfaceWithFormatFrom(pixels, w, h, 24, w * 3, SDL_PIXELFORMAT_RGB24);
    int saved = surface && SDL_SaveBMP(surface, path) == 0;
    SDL_FreeSurface(surface);
    free(pixels);
    snprintf(text, sizeof text, saved ? "Screenshot %d saved" : "Could not save a screenshot", number - 1);
    say(text);
}

/* For the run log: what the window was last seen to show (see glb_window_colours). */
static int window_colours;
static uint32_t window_average;
static long window_looked_at = -60;

static void show_picture(int which) {
    int w, h;
    SDL_GL_GetDrawableSize(window, &w, &h);
    glb_present(which, w, h);
    if (run_log && frames >= window_looked_at + 60) /* once a second, before the menu is drawn over it */
        window_colours = glb_window_colours(&window_average), window_looked_at = frames;
    draw_overlay();
    glb_overlay_finish();
    /* For testing: WINDOW_SHOT=file.ppm saves what the window shows at frame
     * WINDOW_SHOT_FRAME (default 300), or the first time after that. */
    static int shot_taken;
    const char *shot_frame = getenv("WINDOW_SHOT_FRAME");
    const char *shot = !shot_taken && frames >= (shot_frame ? atol(shot_frame) : 300) ? getenv("WINDOW_SHOT") : NULL;
    FILE *file = shot ? fopen(shot, "wb") : NULL;
    if (file) {
        shot_taken = 1;
        uint8_t *pixels = malloc((size_t)w * (size_t)h * 3);
        glb_read_window(pixels, w, h);
        fprintf(file, "P6\n%d %d\n255\n", w, h);
        fwrite(pixels, 3, (size_t)w * (size_t)h, file);
        fclose(file);
        free(pixels);
    }
    if (picture_wanted) {
        picture_wanted = 0;
        save_window_picture(w, h);
    }
    SDL_GL_SwapWindow(window);
}

/* Sleep until 1/60 of a second after the previous frame was due. The game
 * draws on every second refresh, so one refresh running long is made up on
 * the next; only if we fall well behind do we give up catching up. */
static void wait_for_next_frame(void) {
    Uint64 frequency = SDL_GetPerformanceFrequency(), now = SDL_GetPerformanceCounter();
    /* Fast forward: the same wait, a few times shorter (or none at all). */
    int speed = fast_forward ? fast_speed : 1;
    next_frame_time += frequency / 60 / (Uint64)(speed ? speed : 1);
    if (now > next_frame_time) {
        double late = (double)(now - next_frame_time) * 1000 / (double)frequency;
        if (late > 4)
            late_refreshes++;
        if (late > latest_ms)
            latest_ms = late;
    }
    if (now > next_frame_time + frequency / 10)
        next_frame_time = now;
    if (!speed_limit || speed == 0) { /* run as fast as the PC can go */
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

/* ---- Mods -------------------------------------------------------------------
 * See mods.h. The list itself (game_mods) is in the game's file in games/,
 * or in games/none.c for a game that has no file of its own. */

/* Once per screen refresh: the parts of the free camera that concern the
 * game rather than the drawing (see "Free camera" near the top). */
static void turn_stick(void) {
    /* How far to the right of the game's own camera are we looking? */
    float turned = host_camera.on ? camera_game_facing - host_camera.yaw : simple_look_yaw;
    /* While the view is turned at all, the game is told to leave nothing out. */
    host_view_widen = (host_camera.on || simple_look_yaw != 0 || simple_look_pitch != 0) ? 20 : base_view_widen;
    /* (Not while the game is paused: in its menus up must stay up.) */
    if (turned != 0 && stick_follows_camera && !camera_paused()) {
        float c = cosf(turned), s = sinf(turned), x = pad_x, y = pad_y;
        float turned_x = x * c + y * s, turned_y = y * c - x * s;
        pad_x = (int8_t)(turned_x > 127 ? 127 : turned_x < -127 ? -127 : turned_x);
        pad_y = (int8_t)(turned_y > 127 ? 127 : turned_y < -127 ? -127 : turned_y);
    }
}

/* Carry out the mods that are switched on. Once per screen refresh. */
static void apply_mods(void) {
    static Context ctx; /* mods use the same memory functions as the game's code */
    ctx.ram = ram;
    for (int i = 0; i < game_mod_count; i++) {
        Mod *mod = &game_mods[i];
        if (!mod->on)
            continue;
        for (int j = 0; j < 4; j++) {
            Poke *poke = &mod->pokes[j];
            if (poke->size == 1) wr8(&ctx, poke->address, (uint8_t)poke->value);
            if (poke->size == 2) wr16(&ctx, poke->address, (uint16_t)poke->value);
            if (poke->size == 4) wr32(&ctx, poke->address, poke->value);
        }
        if (mod->every_frame)
            mod->every_frame(&ctx, pad_buttons);
    }
    cheats_apply(ram, RAM_SIZE, cheat_button_held);
}

/* Read the settings file written by the menu (see save_settings). Each line
 * is "name = number". Anything we do not recognise is skipped, so a file
 * from an older or newer version does no harm. */
static void load_settings(int *scale, float *aspect) {
    FILE *file = settings_path ? fopen(settings_path, "r") : NULL;
    if (!file)
        return;
    char line[160];
    while (fgets(line, sizeof line, file)) {
        char *equals = strchr(line, '=');
        if (line[0] == '#' || !equals)
            continue;
        char *text = equals + 1; /* what comes after the '=' */
        int value = atoi(text);
        /* End the name where the spaces before the '=' begin. */
        while (equals > line && equals[-1] == ' ')
            equals--;
        *equals = 0;
        if (!strcmp(line, "wide")) *aspect = value ? 16.0f / 9 : 4.0f / 3;
        else if (!strcmp(line, "smooth")) smooth_motion = value != 0;
        else if (!strcmp(line, "scale")) *scale = value < 1 ? 1 : value > 6 ? 6 : value;
        else if (!strcmp(line, "stats")) start_with_stats = value != 0;
        else if (!strcmp(line, "sound")) sound_muted = value == 0;
        else if (!strcmp(line, "speed limit")) speed_limit = value != 0;
        else if (!strcmp(line, "smooth textures")) gfx_texture_smoothing = value != 0;
        else if (!strcmp(line, "volume")) sound_volume = value < 0 ? 0 : value > 10 ? 10 : value;
        else if (!strcmp(line, "sound buffer")) sound_cushion_ms = value < 25 ? 25 : value > 200 ? 200 : value;
        else if (!strcmp(line, "fast forward speed")) fast_speed = value < 0 || value > 8 ? 4 : value;
        else if (!strcmp(line, "camera circles")) camera_circles = value != 0;
        else if (!strcmp(line, "stick follows camera")) stick_follows_camera = value != 0;
        else if (!strcmp(line, "state slot")) state_slot = value < 1 || value > 9 ? 1 : value;
        else if (!strncmp(line, "cheat ", 6)) {
            for (int i = 0; i < cheat_count; i++)
                if (!strcmp(line + 6, cheats[i].name))
                    cheats[i].on = value < 0 || value > (cheats[i].choice_count ? cheats[i].choice_count : 1) ? 0 : value;
        }
        else if (!strncmp(line, "mod ", 4)) {
            for (int i = 0; i < game_mod_count; i++)
                if (!strcmp(line + 4, game_mods[i].name))
                    game_mods[i].on = value != 0;
        }
#ifdef USE_SDL
        else if (!strcmp(line, "fullscreen")) fullscreen = value != 0;
        else if (!strcmp(line, "free camera")) free_camera = value != 0;
        else if (!strcmp(line, "dpad moves stick")) dpad_moves_stick = value != 0;
        else {
            /* "key A = J", "pad A = a", "mouse Look (hold) = Right": cut off
             * the spaces and line end around the name of the key or button. */
            char *code = text + strspn(text, " "), *row = line;
            code[strcspn(code, "\r\n")] = 0;
            if (!strncmp(row, "shortcut ", 9)) /* how older versions wrote the shortcuts */
                row += 9;
            for (int device = 0; device < DEVICE_COUNT; device++) {
                size_t length = strlen(device_names[device]);
                if (strncmp(row, device_names[device], length) || row[length] != ' ')
                    continue;
                for (int i = 0; i < BINDING_COUNT; i++)
                    if (!strcmp(row + length + 1, bindings[i].name) ||
                        (row != line && bindings[i].shortcut && /* older names had more on the end */
                         !strncmp(row + length + 1, bindings[i].name, strlen(bindings[i].name))))
                        bindings[i].now[device] = code_from_name(device, code);
            }
        }
#endif
    }
    fclose(file);
}

/* ---- The run log --------------------------------------------------------------
 * With --log the game writes down how it is doing as it runs, one line of
 * text at a time. Nobody has to watch: the "run" command keeps the text in
 * the logs/ folder, and the "diagnose" command (diagnose.py) reads it back
 * and says what went wrong and where to look. The lines:
 *
 *   health F: ...   once a second: what was drawn in that second, whether
 *                   the screen is blank, how fast the game is going, and
 *                   how evenly pictures reached the window
 *   screen: ...     which screen the window is on and how often it redraws
 *   input F: ...    the controller, every time it changes, so that the
 *                   same session can be played again with --replay
 *   event F: ...    things the player did in the menu (save states, reset)
 *   stalled F: ...  no picture for five seconds, and what each thread of
 *                   the game is waiting for
 *
 * F is the number of screen refreshes since the game started. */

static void print_threads(FILE *out) {
    for (int i = 0; i < thread_count; i++)
        fprintf(out, "  thread %d: priority %d, %s, queue 0x%08X (%u waiting), last call from 0x%08X\n",
                threads[i].id, threads[i].priority,
                (const char *[]){"stopped", "ready", "waiting", "finished", "idle loop"}[threads[i].state],
                threads[i].wait_queue,
                threads[i].state == WAITING ? g32(MQ_VALID(threads[i].wait_queue)) : 0,
                (uint32_t)threads[i].ctx.ra);
}

static int longest_wait, shortest_wait; /* between new pictures reaching the window, in tenths of a millisecond */

static void log_health(void) {
    static long pictures_before, triangles_before, rectangles_before, unhandled_before, sound_before;
    static int quiet_seconds;
    static struct timespec before;
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    /* Sixty refreshes should take one second. */
    double seconds = (double)(now.tv_sec - before.tv_sec) + (double)(now.tv_nsec - before.tv_nsec) / 1e9;
    int speed = before.tv_sec && seconds > 0 ? (int)(100 / seconds + 0.5) : 100;
    before = now;

    int colours = 0, menu = 0;
    uint32_t average = 0;
    if (headless) {
        /* No window: look at the picture itself, a few dozen dots of it. */
        int w, h;
        const uint32_t *pixels = gfx_picture(1, &w, &h);
        uint32_t seen[48], sum[3] = {0, 0, 0};
        for (int i = 0; i < 48; i++) {
            uint32_t dot = pixels[((i / 8 * 2 + 1) * h / 12) * w + (i % 8 * 2 + 1) * w / 16];
            sum[0] += dot >> 16 & 255, sum[1] += dot >> 8 & 255, sum[2] += dot & 255;
            uint32_t colour = dot & 0xF0F0F0;
            int known = 0;
            for (int j = 0; j < colours; j++)
                known |= seen[j] == colour;
            if (!known)
                seen[colours++] = colour;
        }
        average = sum[0] / 48 << 16 | sum[1] / 48 << 8 | sum[2] / 48;
    }
#ifdef USE_SDL
    else
        colours = window_colours, average = window_average, menu = menu_open;
#endif
    long pictures = graphics_tasks - pictures_before;
    fprintf(stderr, "health %ld: pictures %ld triangles %ld rectangles %ld unhandled %ld sound %ld colours %d average %06X speed %d menu %d longest %d shortest %d\n",
            frames, pictures, gfx_triangle_count - triangles_before, gfx_rectangle_count - rectangles_before,
            gfx_unhandled_count - unhandled_before, audio_tasks - sound_before, colours, average, speed, menu,
            longest_wait, shortest_wait);
    longest_wait = shortest_wait = 0;
    pictures_before = graphics_tasks, triangles_before = gfx_triangle_count, rectangles_before = gfx_rectangle_count;
    unhandled_before = gfx_unhandled_count, sound_before = audio_tasks;

    quiet_seconds = pictures ? 0 : quiet_seconds + 1;
    if (quiet_seconds == 5) {
        fprintf(stderr, "stalled %ld: no picture for five seconds. The threads:\n", frames);
        print_threads(stderr);
    }
}

/* --replay: the controller of an earlier run, read back from its log. */
static struct Replayed { long frame; int buttons, x, y; } *replayed, replay_now;
static int replay_count, replay_next;

static void load_replay(const char *path) {
    FILE *file = fopen(path, "r");
    char line[256];
    while (file && fgets(line, sizeof line, file)) {
        struct Replayed r;
        if (sscanf(line, "input %ld: %i %d %d", &r.frame, &r.buttons, &r.x, &r.y) != 4)
            continue;
        if (replay_count % 1024 == 0)
            replayed = realloc(replayed, (size_t)(replay_count + 1024) * sizeof *replayed);
        replayed[replay_count++] = r;
    }
    if (file)
        fclose(file);
}

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
            static const struct { long frame; int action, direction; } steps[] = {
                {200, ACT_WIDE, 1}, {260, ACT_SCALE, -1}, {320, ACT_SMOOTH, 1},
                {380, ACT_SCALE, 1}, {440, ACT_SCALE, 1}, {500, ACT_WIDE, 1}, {520, ACT_WIDE, 1},
            };
            for (size_t i = 0; i < sizeof steps / sizeof steps[0]; i++)
                if (steps[i].frame == frames)
                    menu_act(steps[i].action, 0, steps[i].direction, 0);
        }
        if (getenv("MENU_STRESS") && frames % 3 == 0) { /* for testing: change things at random, all the time */
            static const int actions[] = {ACT_WIDE, ACT_SCALE, ACT_SMOOTH, ACT_TEXTURES, ACT_SOUND,
                                          ACT_VOLUME, ACT_LIMIT, ACT_STATS, ACT_MOD, ACT_SCALE};
            int action = actions[rand() % 10];
            if (action != ACT_MOD || game_mod_count)
                menu_act(action, game_mod_count ? rand() % game_mod_count : 0, rand() % 2 ? 1 : -1, 0);
        }
        if (getenv("RESET_TEST") && frames == atol(getenv("RESET_TEST"))) { /* for testing: reset once */
            unsetenv("RESET_TEST");
            reset_game();
        }
        update_stats(which >= 0);
        if (which >= 0)
            on_screen = which;
        /* Redraw even without a new picture while the menu or statistics
         * are up, so they stay responsive. */
        if (which >= 0 || menu_open || stats_shown || frames <= message_until)
            show_picture(on_screen);
        if (which >= 0 && run_log) {
            /* For the run log: how evenly do new pictures reach the window?
             * The longest and shortest wait between two, this second. */
            static Uint64 before;
            Uint64 now = SDL_GetPerformanceCounter();
            int tenths = before ? (int)((now - before) * 10000 / SDL_GetPerformanceFrequency()) : 0; /* tenths of a millisecond */
            before = now;
            if (tenths > longest_wait)
                longest_wait = tenths;
            if (tenths && (tenths < shortest_wait || !shortest_wait))
                shortest_wait = tenths;
        }
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
    if (replay_count) {
        while (replay_next < replay_count && replayed[replay_next].frame <= frames)
            replay_now = replayed[replay_next++];
        pad_buttons = (uint16_t)replay_now.buttons, pad_x = (int8_t)replay_now.x, pad_y = (int8_t)replay_now.y;
    }
    if (run_log) {
        static int logged_buttons = -1, logged_x, logged_y;
        if (pad_buttons != logged_buttons || pad_x != logged_x || pad_y != logged_y)
            fprintf(stderr, "input %ld: 0x%04X %d %d\n", frames, pad_buttons, pad_x, pad_y);
        logged_buttons = pad_buttons, logged_x = pad_x, logged_y = pad_y;
        if (frames % 60 == 0)
            log_health();
    }
    static long next_screenshot = -1;
    if (next_screenshot < 0)
        next_screenshot = screenshot_from;
    if (screenshot_dir && which >= 0 && frames >= next_screenshot) {
        write_screenshot(which);
        next_screenshot = frames - frames % screenshot_every + screenshot_every;
    }
    turn_stick();
    apply_mods();
    if (getenv("DUMP_RAM") && frames == atol(getenv("DUMP_RAM"))) { /* for testing: DUMP_RAM=frame:file writes out the game's memory */
        FILE *dump = fopen(strchr(getenv("DUMP_RAM"), ':') ? strchr(getenv("DUMP_RAM"), ':') + 1 : "ram.bin", "wb");
        if (dump) {
            fwrite(ram, 1, RAM_SIZE, dump);
            fclose(dump);
        }
    }
    if (getenv("WATCH")) { /* for testing: WATCH=address prints what is there, every frame */
        uint32_t bits = g32((uint32_t)strtoul(getenv("WATCH"), NULL, 0));
        float value;
        memcpy(&value, &bits, 4);
        fprintf(stderr, "watch %ld: 0x%08X %g\n", frames, bits, value);
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
    /* These three should agree: what the game asked for, what its sound
     * program made, and what reached the chip. Where they do not, sound is
     * being lost or invented, and it will crackle. */
    if (frames > 0)
        printf("  sound rate:        wants %d a second; made %ld, sent to the chip %ld; %ld blocks refused (chip full), %ld commands not known\n",
               sound_chip.frequency, audio_samples_made * 60 / frames, sound_taken * 60 / frames, sound_refused,
               audio_commands_unknown);
    if (audio_lists_silent)
        printf("  SILENT:            %ld sound lists were not carried out (this sound program is not understood)\n", audio_lists_silent);
    printf("  sound commands:   "); /* which command numbers the game's sound lists use, and how often (in thousands) */
    for (int i = 0; i < 32; i++)
        if (audio_command_counts[i])
            printf(" %02X:%ldk", i, (audio_command_counts[i] + 999) / 1000);
    printf("\n");
    printf("  frames cut short by the loop budget: %ld (busiest refresh used %ld of %d)\n", forced_frames,
           most_loops, LOOP_BUDGET_PER_FRAME);
    if (host_interpreted)
        printf("  interpreted:       %ld instructions (code that was not translated ahead of time)\n",
               host_interpreted);
    if (run_log || getenv("SHOW_THREADS")) /* for working out why a game is stuck */
        print_threads(stdout);
}

/* ---- Main ------------------------------------------------------------------ */

/* A game that goes round and round without ever reaching the next screen
 * refresh would leave us frozen with no explanation. A timer checks every
 * few seconds that the refresh count is still going up. */
static void watchdog(int signal_number) {
    static long frames_before = -1;
    static int strikes;
    (void)signal_number;
    strikes = frames == frames_before ? strikes + 1 : 0;
    frames_before = frames;
    if (strikes >= 4) {
        static const char text[] = "\ngame stopped: it is stuck in a loop and no longer reaching the next frame\n";
        if (write(2, text, sizeof text - 1)) {}
        if (current)
            fprintf(stderr, "  thread %d, last call from 0x%08X, frame %ld\n", current->id, (uint32_t)current->ctx.ra, frames);
        exit(1);
    }
    alarm(5);
}

/* The program itself went wrong (it read or wrote memory that is not there,
 * say). Normally that ends it without a word; say where the game was first. */
static void crashed(int signal_number) {
    fprintf(stderr, "\ngame stopped: crashed (signal %d)\n", signal_number);
    if (current)
        fprintf(stderr, "  thread %d, last call from 0x%08X, frame %ld\n", current->id, (uint32_t)current->ctx.ra, frames);
    signal(signal_number, SIG_DFL); /* and then end the way it was going to */
    raise(signal_number);
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: %s <rom file> [options]\n", argv[0]);
        return 2;
    }
    int scale = 3;
    float aspect = 4.0f / 3;
#ifdef USE_SDL
    start_arguments = argv;
    dpad_moves_stick = game_ignores_dpad;
    for (int i = 0; i < game_mod_count && i < 64; i++)
        mods_at_start[i] = game_mods[i].on;
#endif
    stick_follows_camera = game_stick_follows_camera;
    /* The remembered settings come first, so that anything given on the
     * command line afterwards wins over them. */
    for (int i = 2; i + 1 < argc; i++) {
        if (!strcmp(argv[i], "--settings"))
            settings_path = argv[i + 1];
        if (!strcmp(argv[i], "--cheats")) /* may be given more than once */
            cheats_load(argv[i + 1]);
    }
    load_settings(&scale, &aspect);
    for (int i = 2; i < argc; i++) {
        const char *next = i + 1 < argc ? argv[i + 1] : "";
        if (!strcmp(argv[i], "--frames")) max_frames = atol(next), i++;
        else if (!strcmp(argv[i], "--scale")) scale = atoi(next), i++;
        else if (!strcmp(argv[i], "--save")) save_path = next, i++;
#ifdef USE_SDL
        else if (!strcmp(argv[i], "--pictures")) pictures_path = next, i++;
#endif
        else if (!strcmp(argv[i], "--eeprom")) eeprom_size = atoi(next) > 512 ? 2048 : 512, i++;
        else if (!strcmp(argv[i], "--settings")) i++; /* dealt with above */
        else if (!strcmp(argv[i], "--cheats")) i++;   /* ...and so was this */
        else if (!strcmp(argv[i], "--states")) states_path = next, i++;
        else if (!strcmp(argv[i], "--headless")) headless = 1;
        else if (!strcmp(argv[i], "--wide")) aspect = 16.0f / 9;
        else if (!strcmp(argv[i], "--stats")) start_with_stats = 1;
        else if (!strcmp(argv[i], "--smooth")) smooth_motion = 1;
        else if (!strcmp(argv[i], "--look")) look_test_yaw = (float)atof(next), i++;
        else if (!strcmp(argv[i], "--screenshots")) screenshot_dir = next, i++;
        else if (!strcmp(argv[i], "--every")) screenshot_every = atoi(next), i++;
        else if (!strcmp(argv[i], "--wav")) wav_file = fopen(next, "wb"), i++;
        else if (!strcmp(argv[i], "--from")) screenshot_from = atol(next), i++;
        else if (!strcmp(argv[i], "--log")) run_log = gfx_report_unhandled = 1;
        else if (!strcmp(argv[i], "--replay")) load_replay(next), i++;
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
    host_rom = rom;

    memset(eeprom, 0xFF, sizeof eeprom); /* a blank chip reads as all ones */
    file = save_path ? fopen(save_path, "rb") : NULL;
    if (file) {
        if (fread(eeprom, 1, (size_t)eeprom_size, file) != (size_t)eeprom_size)
            fprintf(stderr, "host: save file is short; missing part treated as blank\n");
        fclose(file);
    }
    memset(sram, 0, sizeof sram);
    file = sram_path() ? fopen(sram_path(), "rb") : NULL;
    if (file) {
        if (fread(sram, 1, SRAM_SIZE, file)) {}
        fclose(file);
    }

    /* What the console's boot code does before the game starts: copy the
     * first megabyte of game code into memory and leave a few facts about
     * the console at fixed addresses. */
    /* (With spare room after it: the renderer and the sound code copy
     * blocks out of the game's memory at addresses and lengths the game
     * gives, and a nonsense length near the end must not run off it.) */
    ram = memory_at(RAM_PLACE, RAM_SIZE + RAM_SLACK); /* arrives filled with zeros */
    memcpy(guest(ENTRY_POINT, BOOT_LOAD_SIZE), rom + ENTRY_ROM_OFFSET, BOOT_LOAD_SIZE);
    w32(0x80000300, 1);          /* TV type: NTSC */
    w32(0x80000308, 0xB0000000); /* where the cartridge is mapped */
    w32(0x80000318, 0x400000);   /* memory size: 4 MB, a console without the expansion */

    audio_init(ram);
    if (wav_file)
        fseek(wav_file, 44, SEEK_SET); /* leave room for the header, written at the end */
    gfx_init(ram, scale, aspect);
    host_view_widen = base_view_widen = aspect / (4.0f / 3);
    if (look_test_yaw != 0 && (game_focus || camera_circles)) { /* for testing the free camera without a gamepad */
        camera_test_turn = look_test_yaw;
    } else if (look_test_yaw != 0) { /* ...or the simple look-around */
        gfx_set_view(look_test_yaw, 0, 1);
        simple_look_yaw = look_test_yaw;
#ifdef USE_SDL
        look_yaw = look_test_yaw;
#endif
    }
    atexit(print_summary);
#ifdef USE_SDL
    if (!headless)
        current_scale = scale, current_aspect = aspect, stats_shown = start_with_stats;
    if (getenv("MENU_TEST")) /* for testing: start with the menu and statistics showing */
        menu_open = stats_shown = 1;
    if (getenv("MENU_PAGE")) /* ...and on this page of it */
        menu_page = atoi(getenv("MENU_PAGE")) % PAGE_COUNT;
    if (getenv("MENU_ROW"))
        menu_row = atoi(getenv("MENU_ROW"));
    if (!headless)
        open_window();
#endif

    host_trace = getenv("TRACE_OS") != NULL;
    host_interpret_loaded_code = getenv("INTERPRET_LOADED") != NULL;
    signal(SIGALRM, watchdog);
    alarm(5);
    for (int i = 0; i < 4; i++)
        signal((int[]){SIGSEGV, SIGBUS, SIGFPE, SIGILL}[i], crashed);
    if (run_log)
        setvbuf(stdout, NULL, _IOLBF, 0); /* a line at a time, so the log is in the order things happened */

    /* The start-up code runs as a thread of its own, below all others: on
     * the console it is not a thread at all, and the first real thread it
     * starts takes over from it at once. (Many games end their start-up
     * code with a loop that goes round forever, relying on exactly that.) */
    Thread *boot = new_thread(0, 0, -1, ENTRY_POINT);
    make_runnable(boot);

    int idle_frames = 0;
    while (max_frames < 0 || frames < max_frames) {
        /* For testing: STATE_TEST="save-frame:load-frame" saves and loads by itself. */
        static long test_save = -1, test_load = -1;
        if (test_save < 0 && getenv("STATE_TEST"))
            sscanf(getenv("STATE_TEST"), "%ld:%ld", &test_save, &test_load);
        if (frames == test_save && frames)
            state_request = STATE_SAVE, test_save = 0;
        if (frames == test_load && frames)
            state_request = STATE_LOAD, test_load = 0;
        if (state_request)
            carry_out_state_request();
        Thread *t = pick_thread();
        if (t) {
            idle_frames = 0;
            current = t;
            calls_at_switch = host_calls;
            swapcontext(&scheduler, &t->uc);
            t->calls += host_calls - calls_at_switch;
            current = NULL;
            continue;
        }
        if (hardware_poll())
            continue; /* something a thread was waiting for has now happened */
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
