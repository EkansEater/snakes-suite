/*
 * Changes made specially for Super Mario 64 (USA).
 *
 * host.c stands in for the console and knows nothing about any one game.
 * This file is the other kind of change: altering what the game itself
 * does. There are two ways to do that here:
 *
 *   - Write to the game's memory while it runs. The game keeps everything
 *     it knows about Mario in one block of memory (gMarioStates); change a
 *     number in there and the game carries on with the new number.
 *   - Because every function of the game is now a C function, we can
 *     replace one, or wrap it: do something, call the original, undo it.
 *
 * The changes the player can switch on and off are listed in game_mods at
 * the bottom, and appear in the F1 menu (see mods.h).
 */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

#include "functions.h"
#include "mods.h"

/* The mods, by position in game_mods below. */
enum {
    MOD_LIVES, MOD_HEALTH, MOD_UNHURT, MOD_NO_FALL_DAMAGE,
    MOD_WING_CAP, MOD_METAL_CAP, MOD_VANISH_CAP,
    MOD_TRIPLE_JUMP, MOD_HIGH_JUMP, MOD_AIR_JUMP, MOD_LOW_GRAVITY, MOD_MOON_JUMP,
    MOD_BIG, MOD_TINY, MOD_FAST,
    MOD_EDGES,
};

/* Where things are inside gMarioStates, counted in bytes from its start. */
#define MARIO_FLAGS 0x04      /* four bytes of yes/no bits, among them which caps he has */
#define MARIO_ACTION 0x0C     /* what he is doing: a number for "jumping", "swimming"... */
#define MARIO_UNHURT_TIME 0x26 /* two bytes: frames left in which enemies cannot hurt him */
#define MARIO_HEIGHT 0x40     /* a float: how high up he is */
#define MARIO_UP_SPEED 0x4C   /* a float: how fast he is moving upwards */
#define MARIO_OBJECT 0x88     /* address of the object that is drawn as Mario */
#define MARIO_LIVES 0xAD      /* one byte */
#define MARIO_HEALTH 0xAE     /* two bytes: 0x100 for each of the 8 wedges, plus a fraction */
#define MARIO_CAP_TIME 0xB6   /* two bytes: frames left of a special cap */
#define MARIO_PEAK 0xBC       /* a float: the highest he has been in this fall */

#define OBJECT_SCALE 0x2C /* in a drawn object: three floats, its size in x, y and z */

/* Bits in MARIO_FLAGS. */
#define FLAG_VANISH_CAP 0x02
#define FLAG_METAL_CAP 0x04
#define FLAG_WING_CAP 0x08
#define FLAG_CAP_ON_HEAD 0x10

/* Values of MARIO_ACTION, and the bits in one that say he is in the air. */
#define ACTION_JUMP 0x03000880u
#define ACTION_DOUBLE_JUMP 0x03000881u
#define ACTION_TRIPLE_JUMP 0x01000882u
#define ACTION_KIND_BITS 0x1C0
#define ACTION_KIND_IN_AIR 0x080

#define BUTTON_A 0x8000
#define BUTTON_L 0x0020

/* Memory holds a float as a 32-bit pattern; these read and write one. */
static float read_float(Context *ctx, uint32_t address) {
    uint32_t bits = rd32(ctx, address);
    float value;
    memcpy(&value, &bits, 4);
    return value;
}
static void write_float(Context *ctx, uint32_t address, float value) {
    uint32_t bits;
    memcpy(&bits, &value, 4);
    wr32(ctx, address, bits);
}

/* ---- Cheats that work by writing to memory every frame ---------------------- */

/* While L is held, keep Mario moving upwards. Gravity pulls his upward
 * speed down a little every frame; we simply put it back. */
static void moon_jump(Context *ctx, int buttons) {
    if (buttons & BUTTON_L)
        write_float(ctx, ADDR_gMarioStates + MARIO_UP_SPEED, 30);
}

/* Pressing A while already in the air jumps again. "Pressing" means A is
 * down now and was not a moment ago, so holding it does not keep firing. */
static void air_jump(Context *ctx, int buttons) {
    static int before;
    int pressed = buttons & ~before & BUTTON_A;
    before = buttons;
    uint32_t action = rd32(ctx, ADDR_gMarioStates + MARIO_ACTION);
    if (pressed && (action & ACTION_KIND_BITS) == ACTION_KIND_IN_AIR)
        write_float(ctx, ADDR_gMarioStates + MARIO_UP_SPEED, 52);
}

/* The game works out how hard a landing is from how far Mario has dropped
 * below the highest point of his fall. Keep saying that the highest point is
 * where he is now, and no fall is ever a long one. */
static void no_fall_damage(Context *ctx, int buttons) {
    (void)buttons;
    wr32(ctx, ADDR_gMarioStates + MARIO_PEAK, rd32(ctx, ADDR_gMarioStates + MARIO_HEIGHT));
}

/* A special cap is a bit in Mario's flags and a countdown; when the
 * countdown reaches zero the game takes the cap away. We set the bit and
 * keep the countdown at ten seconds. Switched off, the cap wears off in the
 * normal way ten seconds later. */
static void keep_cap(Context *ctx, uint32_t cap) {
    uint32_t flags = rd32(ctx, ADDR_gMarioStates + MARIO_FLAGS);
    wr32(ctx, ADDR_gMarioStates + MARIO_FLAGS, flags | cap | FLAG_CAP_ON_HEAD);
    wr16(ctx, ADDR_gMarioStates + MARIO_CAP_TIME, 300);
}
static void wing_cap(Context *ctx, int buttons) { (void)buttons, keep_cap(ctx, FLAG_WING_CAP); }
static void metal_cap(Context *ctx, int buttons) { (void)buttons, keep_cap(ctx, FLAG_METAL_CAP); }
static void vanish_cap(Context *ctx, int buttons) { (void)buttons, keep_cap(ctx, FLAG_VANISH_CAP); }

/* ---- Cheats that work by changing one of the game's functions ------------------
 * A function named hle_<name> is called in place of the game's <name>, and
 * the game's own version is still there as original_<name>. The function's
 * arguments are in the registers a0, a1, a2... as the game left them. */

/* set_mario_action(mario, action, argument) is how the game changes what
 * Mario is doing. If it is about to start a first or second jump, tell it
 * to start a third one. */
void hle_set_mario_action(Context *ctx) {
    uint32_t action = (uint32_t)ctx->a1;
    if (game_mods[MOD_TRIPLE_JUMP].on && (action == ACTION_JUMP || action == ACTION_DOUBLE_JUMP))
        ctx->a1 = S32(ACTION_TRIPLE_JUMP);
    original_set_mario_action(ctx);
}

/* set_mario_y_vel_based_on_fspeed(mario, speed, multiplier) gives Mario his
 * upward speed at the start of every kind of jump. The speed arrives as a
 * float's bit pattern in a1; make it half as much again. */
void hle_set_mario_y_vel_based_on_fspeed(Context *ctx) {
    if (game_mods[MOD_HIGH_JUMP].on) {
        uint32_t bits = (uint32_t)ctx->a1;
        float speed;
        memcpy(&speed, &bits, 4);
        speed *= 1.5f;
        memcpy(&bits, &speed, 4);
        ctx->a1 = S32(bits);
    }
    original_set_mario_y_vel_based_on_fspeed(ctx);
}

/* apply_gravity(mario) lowers Mario's upward speed once a frame while he is
 * in the air. Let it, then give half of what it took back. */
void hle_apply_gravity(Context *ctx) {
    uint32_t mario = (uint32_t)ctx->a0;
    float before = read_float(ctx, mario + MARIO_UP_SPEED);
    original_apply_gravity(ctx);
    float after = read_float(ctx, mario + MARIO_UP_SPEED);
    if (game_mods[MOD_LOW_GRAVITY].on && after < before)
        write_float(ctx, mario + MARIO_UP_SPEED, (before + after) / 2);
}

/* Fast Mario. Three functions move Mario each frame: one for when he is on
 * the ground, one for the air and one for water. Each takes his speed (a
 * float for each of x, y and z, from MARIO_SPEED) and moves him that far,
 * stopping at walls and following the floor as it goes.
 *
 * We make his sideways speed larger just for the duration of the move, and
 * put it back afterwards. He covers more ground, but the rest of the game
 * still sees his ordinary speed, so nothing that depends on it (how far a
 * jump carries, when he starts to skid) is thrown off. "Put it back" is a
 * division rather than a remembered number, because the move itself may
 * have changed the speed, on hitting a wall for instance. */
#define MARIO_SPEED 0x48
#define FAST_MARIO 1.7f
static void scale_sideways_speed(Context *ctx, uint32_t mario, float by) {
    write_float(ctx, mario + MARIO_SPEED, read_float(ctx, mario + MARIO_SPEED) * by);         /* x */
    write_float(ctx, mario + MARIO_SPEED + 8, read_float(ctx, mario + MARIO_SPEED + 8) * by); /* z */
}
/* (Each is written out in full, because the build looks through this file
 * for the words "void hle_<name>(Context" to learn which of the game's
 * functions we replace.) */
void hle_perform_ground_step(Context *ctx) {
    uint32_t mario = (uint32_t)ctx->a0;
    int fast = game_mods[MOD_FAST].on;
    if (fast)
        scale_sideways_speed(ctx, mario, FAST_MARIO);
    original_perform_ground_step(ctx);
    if (fast)
        scale_sideways_speed(ctx, mario, 1 / FAST_MARIO);
}
void hle_perform_air_step(Context *ctx) {
    uint32_t mario = (uint32_t)ctx->a0;
    int fast = game_mods[MOD_FAST].on;
    if (fast)
        scale_sideways_speed(ctx, mario, FAST_MARIO);
    original_perform_air_step(ctx);
    if (fast)
        scale_sideways_speed(ctx, mario, 1 / FAST_MARIO);
}
void hle_perform_water_step(Context *ctx) {
    uint32_t mario = (uint32_t)ctx->a0;
    int fast = game_mods[MOD_FAST].on;
    if (fast)
        scale_sideways_speed(ctx, mario, FAST_MARIO);
    original_perform_water_step(ctx);
    if (fast)
        scale_sideways_speed(ctx, mario, 1 / FAST_MARIO);
}

/* squish_mario_model(mario) sets the size Mario is drawn at, every frame:
 * normal, or flattened when something has landed on him. Afterwards we put
 * our own size in. Only the drawing changes; he still fits through the same
 * gaps and is hit by the same things. */
static void update_camera_room(Context *ctx);
void hle_squish_mario_model(Context *ctx) {
    uint32_t object = rd32(ctx, (uint32_t)ctx->a0 + MARIO_OBJECT);
    original_squish_mario_model(ctx);
    float size = game_mods[MOD_BIG].on ? 2.0f : game_mods[MOD_TINY].on ? 0.4f : 1;
    /* This function runs once a frame while Mario is about, which makes it
     * a handy place to measure the room behind him for the free camera. */
    update_camera_room(ctx);
    /* For testing: WARP_TEST="level:after" sends Mario to another level
     * after that many frames of play, and PLACE_TEST="x,y,z:after" puts him
     * somewhere in the level. */
    static long calls;
    int level, after;
    float place[3];
    calls++;
    if (getenv("WARP_TEST") && sscanf(getenv("WARP_TEST"), "%d:%d", &level, &after) == 2 && calls == after) {
        uint64_t sp = ctx->sp, ra = ctx->ra;
        ctx->sp = S32(((uint32_t)sp - 0x40) & ~7u);
        ctx->a0 = S32(level), ctx->a1 = 1, ctx->a2 = 0x0A, ctx->a3 = 0;
        call_indirect(ctx, ADDR_initiate_warp);
        ctx->sp = sp, ctx->ra = ra;
    }
    if (getenv("PLACE_TEST") && sscanf(getenv("PLACE_TEST"), "%f,%f,%f:%d", &place[0], &place[1], &place[2], &after) == 4 &&
        calls == after)
        for (uint32_t axis = 0; axis < 3; axis++)
            write_float(ctx, ADDR_gMarioStates + 0x3C + 4 * axis, place[axis]);
    if (size != 1 && object != 0)
        for (int axis = 0; axis < 3; axis++)
            write_float(ctx, object + OBJECT_SCALE + 4 * (uint32_t)axis,
                        read_float(ctx, object + OBJECT_SCALE + 4 * (uint32_t)axis) * size);
}

/*
 * obj_is_in_view decides whether an object is on screen and worth drawing.
 * It assumes the original screen shape, so on a wider picture objects near
 * the sides vanish while still visible. The function works from the
 * camera's field of view, so we widen that number for the duration of the
 * call and let the original code do the rest.
 */
void hle_obj_is_in_view(Context *ctx) {
    /* With the free camera turned, "on screen" as the game works it out
     * means nothing: it is thinking of its own camera, and would leave out
     * whatever is behind that or off to its sides, which may be exactly
     * what we are looking at. So draw every object, apart from those the
     * game has marked as not to be shown at all (a bit in the object's
     * flags, two bytes in). The host sets host_view_widen to 20 while the
     * view is turned. */
    if (host_view_widen >= 20) {
        uint16_t flags = rd16(ctx, (uint32_t)ctx->a0 + 2);
        ctx->v0 = (flags & 0x10) ? 0 : 1;
        return;
    }
    uint32_t camera = rd32(ctx, ADDR_gCurGraphNodeCamFrustum);
    if (!game_mods[MOD_EDGES].on || host_view_widen <= 1 || camera == 0) {
        original_obj_is_in_view(ctx);
        return;
    }
    uint32_t fov_bits = rd32(ctx, camera + 0x1C); /* +0x1C: field of view in degrees */
    float fov;
    memcpy(&fov, &fov_bits, 4);

    /* The game takes (fov / 2 + 1) degrees as the half-angle to the edge. */
    float half = (fov / 2 + 1) * (float)M_PI / 180;
    float wider = atanf(tanf(half) * host_view_widen) * 180 / (float)M_PI;
    if (wider > 85)
        wider = 85;
    float new_fov = (wider - 1) * 2;
    uint32_t new_bits;
    memcpy(&new_bits, &new_fov, 4);

    wr32(ctx, camera + 0x1C, new_bits);
    original_obj_is_in_view(ctx);
    wr32(ctx, camera + 0x1C, fov_bits);
}

/* ---- Free camera -------------------------------------------------------------- */

/* Trees, coins, flames and many other things are "billboards": a flat
 * picture that the game keeps turned to face its camera, so that it never
 * shows its edge. Flat pictures are only drawn from the front. When our
 * free camera swings round to the side or the back, we would be looking at
 * the edge or the back of the picture, and it would thin out and vanish
 * (leaving its shadow behind).
 *
 * mtxf_billboard(result, matrix, position, roll) is where the game works
 * out how a billboard is turned. Afterwards we turn it once more, by the
 * turn the host gives us in host_view_back, so that when the renderer
 * draws the scene for our camera the billboard ends up facing us again.
 *
 * The result is a 4x4 grid of floats: three rows that say which way the
 * picture's across, up and out directions point, and a fourth that says
 * where it is. We change the first three and leave the fourth alone. */
void hle_mtxf_billboard(Context *ctx) {
    uint32_t result = (uint32_t)ctx->a0;
    original_mtxf_billboard(ctx);
    if (host_view_widen < 20) /* the view is not turned */
        return;
    for (uint32_t row = 0; row < 3; row++) {
        float old[3], turned[3];
        for (uint32_t i = 0; i < 3; i++)
            old[i] = read_float(ctx, result + 16 * row + 4 * i);
        for (int j = 0; j < 3; j++)
            turned[j] = old[0] * host_view_back[0][j] + old[1] * host_view_back[1][j] + old[2] * host_view_back[2][j];
        for (uint32_t j = 0; j < 3; j++)
            write_float(ctx, result + 16 * row + 4 * j, turned[j]);
    }
}

/* The sky is a big flat picture behind everything, and the game slides it
 * sideways and up and down according to where its camera is pointing.
 * create_skybox_facing_camera(player, which sky, field of view, camera x,
 * y, z, focus x, y, z) is where it decides how far. With the free camera
 * in use we hand it our camera's position instead, so the sky turns with
 * our view. Only the direction from the camera to its focus matters.
 *
 * The first four arguments are in registers (the fourth, camera x, as a
 * float's bit pattern in a3); the other five are on the stack, four bytes
 * each, starting sixteen bytes up. */
void hle_create_skybox_facing_camera(Context *ctx) {
    if (host_camera.on) {
        /* A camera one step back from the origin, looking at the origin,
         * in the direction ours looks (see "direction" in gfx.c). */
        float eye[3] = {-sinf(host_camera.yaw) * cosf(host_camera.pitch), sinf(host_camera.pitch),
                        -cosf(host_camera.yaw) * cosf(host_camera.pitch)};
        uint32_t stack = (uint32_t)ctx->sp;
        uint32_t bits;
        memcpy(&bits, &eye[0], 4);
        ctx->a3 = S32(bits);
        write_float(ctx, stack + 0x10, eye[1]), write_float(ctx, stack + 0x14, eye[2]);
        write_float(ctx, stack + 0x18, 0), write_float(ctx, stack + 0x1C, 0), write_float(ctx, stack + 0x20, 0);
    }
    original_create_skybox_facing_camera(ctx);
}

/* ---- Keeping the free camera out of the walls -----------------------------------
 * The game already has functions for asking about its world: is there a
 * wall near this point, how high is the floor under it, how low the
 * ceiling over it. Mario and the game's own camera use them all the time.
 * We call the same functions: walk from Mario towards where the camera
 * wants to be, a step at a time, and stop at the first place that is in a
 * wall, under the floor or above the ceiling.
 *
 * Calling one of the game's functions from here means doing what the game's
 * own code would: put the arguments in the registers the function expects
 * (a0-a3 for whole numbers and addresses, f12 and f14 for the first floats)
 * and anything the function hands back through an address needs somewhere
 * in the game's memory to go. We borrow a little of the stack for that: the
 * space just below the stack pointer is free by definition. */

/* The three functions, and the places in our borrowed memory. */
#define SCRATCH_SIZE 0x60 /* 0x00-0x1F: for the function being called; then ours */
#define SCRATCH_X 0x20
#define SCRATCH_Y 0x24
#define SCRATCH_Z 0x28
#define SCRATCH_SURFACE 0x2C

static uint32_t float_bits(float value) {
    uint32_t bits;
    memcpy(&bits, &value, 4);
    return bits;
}

/* f32_find_wall_collision(&x, &y, &z, height offset, radius): how many
 * walls are within "radius" of the point. (It also pushes the point out of
 * them, which we do not need.) */
static int walls_near(Context *ctx, uint32_t scratch, const float p[3], float radius) {
    for (uint32_t i = 0; i < 3; i++)
        write_float(ctx, scratch + SCRATCH_X + 4 * i, p[i]);
    ctx->a0 = S32(scratch + SCRATCH_X), ctx->a1 = S32(scratch + SCRATCH_Y), ctx->a2 = S32(scratch + SCRATCH_Z);
    ctx->a3 = S32(float_bits(0));
    write_float(ctx, scratch + 0x10, radius); /* a fifth argument goes on the stack */
    call_indirect(ctx, ADDR_f32_find_wall_collision);
    return (int)ctx->v0;
}

/* find_floor(x, y, z, &surface) and find_ceil(x, y, z, &surface): the
 * height of the nearest floor below the point, or ceiling above it. They
 * set "surface" to 0 if there is none. */
static int floor_or_ceiling(Context *ctx, uint32_t scratch, uint32_t function, float x, float y, float z, float *height) {
    set_f(ctx, 12, x), set_f(ctx, 14, y);
    ctx->a2 = S32(float_bits(z)), ctx->a3 = S32(scratch + SCRATCH_SURFACE);
    wr32(ctx, scratch + SCRATCH_SURFACE, 0);
    call_indirect(ctx, function);
    *height = get_f(ctx, 0); /* a float comes back in f0 */
    return rd32(ctx, scratch + SCRATCH_SURFACE) != 0;
}

/* How far from "from" can the camera go in direction "away" (a length-one
 * arrow), up to "wanted", before something is in the way? */
static float camera_room(Context *ctx, const float from[3], const float away[3], float wanted) {
    const float step = 30, clearance = 40;
    uint64_t saved_sp = ctx->sp, saved_ra = ctx->ra;
    uint32_t scratch = ((uint32_t)ctx->sp - SCRATCH_SIZE) & ~7u;
    ctx->sp = S32(scratch);
    /* The game marks some surfaces as "solid, but not to the camera" and
     * some the other way round; this flag says which kind of question we
     * are asking. */
    uint8_t saved_flag = rd8(ctx, ADDR_gCheckingSurfaceCollisionsForCamera);
    wr8(ctx, ADDR_gCheckingSurfaceCollisionsForCamera, 1);

    float room = wanted;
    for (float t = step; t < wanted + step; t += step) {
        float p[3] = {from[0] + away[0] * t, from[1] + away[1] * t, from[2] + away[2] * t}, height;
        int blocked = walls_near(ctx, scratch, p, clearance) > 0;
        /* Ask from a little above the point, so that a floor we have only
         * just gone under still counts as "the floor below". */
        blocked |= floor_or_ceiling(ctx, scratch, ADDR_find_floor, p[0], p[1] + 100, p[2], &height) && p[1] < height + clearance;
        blocked |= floor_or_ceiling(ctx, scratch, ADDR_find_ceil, p[0], p[1] - 100, p[2], &height) && p[1] > height - clearance;
        if (blocked) {
            room = t - step; /* the last place that was clear */
            break;
        }
    }
    wr8(ctx, ADDR_gCheckingSurfaceCollisionsForCamera, saved_flag);
    ctx->sp = saved_sp, ctx->ra = saved_ra;
    return room < 120 ? 120 : room; /* never right inside Mario */
}

/* Where Mario is, for the free camera to circle: his position (three floats
 * from MARIO_POSITION), raised from his feet to about chest height. */
#define MARIO_POSITION 0x3C
#define ACTION_KIND_CUTSCENE 0x100 /* in MARIO_ACTION: he is acting out a scene, not being played */
#define CAMERA_CUTSCENE 0x30       /* in the game's camera: one byte, which scene it is showing (0: none) */
static int mario_position(Context *ctx, float position[3]) {
    if (rd32(ctx, ADDR_gMarioStates + MARIO_OBJECT) == 0)
        return 0; /* no Mario at the moment */
    /* During the game's own scenes (the introduction, a star being
     * collected, a door, a sign being read) the game directs the camera,
     * and ours stays out of it. Two things tell us one is on: what Mario is
     * doing, and what the game's camera says it is doing. gCamera holds
     * the address of the camera, or nothing useful outside a level. */
    if ((rd32(ctx, ADDR_gMarioStates + MARIO_ACTION) & ACTION_KIND_BITS) == ACTION_KIND_CUTSCENE)
        return 0;
    uint32_t camera = rd32(ctx, ADDR_gCamera);
    if (camera >= 0x80000000u && camera < 0x80800000u && rd8(ctx, camera + CAMERA_CUTSCENE) != 0)
        return 0;
    for (uint32_t axis = 0; axis < 3; axis++)
        position[axis] = read_float(ctx, ADDR_gMarioStates + MARIO_POSITION + 4 * axis);
    position[1] += 80;
    return 1;
}
int (*game_focus)(Context *ctx, float position[3]) = mario_position;

/* sCurrPlayMode is the game's note of what it is doing: two bytes, 0 for
 * ordinary play, 2 for the pause screen, other numbers while it changes
 * area or level. Anything but ordinary play counts as paused for us. */
static int mario_paused(Context *ctx) { return rd16(ctx, ADDR_sCurrPlayMode) != 0; }
int (*game_paused)(Context *ctx) = mario_paused;

static void update_camera_room(Context *ctx) {
    float focus[3];
    if (!host_camera.on || !mario_position(ctx, focus))
        return;
    /* The camera sits behind the way it looks (see "direction" in gfx.c). */
    float away[3] = {-sinf(host_camera.yaw) * cosf(host_camera.pitch), sinf(host_camera.pitch),
                     -cosf(host_camera.yaw) * cosf(host_camera.pitch)};
    host_camera.room = camera_room(ctx, focus, away, host_camera.distance);
}

/* name, kind, on to begin with, then how it works (see mods.h) */
Mod game_mods[] = {
    [MOD_LIVES] = {"Infinite lives", KIND_CHEAT, 0, {{ADDR_gMarioStates + MARIO_LIVES, 1, 99}}},
    [MOD_HEALTH] = {"Infinite health", KIND_CHEAT, 0, {{ADDR_gMarioStates + MARIO_HEALTH, 2, 0x880}}},
    [MOD_UNHURT] = {"Enemies cannot hurt Mario", KIND_CHEAT, 0, {{ADDR_gMarioStates + MARIO_UNHURT_TIME, 2, 2}}},
    [MOD_NO_FALL_DAMAGE] = {"No damage from falling", KIND_CHEAT, 0, {{0}}, no_fall_damage},
    [MOD_WING_CAP] = {"Wing cap, always", KIND_CHEAT, 0, {{0}}, wing_cap},
    [MOD_METAL_CAP] = {"Metal cap, always", KIND_CHEAT, 0, {{0}}, metal_cap},
    [MOD_VANISH_CAP] = {"Vanish cap, always", KIND_CHEAT, 0, {{0}}, vanish_cap},
    /* The next three are used by the hle_ functions above. */
    [MOD_TRIPLE_JUMP] = {"Every jump is a triple jump", KIND_CHEAT, 0},
    [MOD_HIGH_JUMP] = {"Higher jumps", KIND_CHEAT, 0},
    [MOD_LOW_GRAVITY] = {"Low gravity", KIND_CHEAT, 0},
    [MOD_AIR_JUMP] = {"Jump again in mid-air (A)", KIND_CHEAT, 0, {{0}}, air_jump},
    [MOD_MOON_JUMP] = {"Moon jump (hold L)", KIND_CHEAT, 0, {{0}}, moon_jump},
    [MOD_BIG] = {"Giant Mario", KIND_CHEAT, 0},
    [MOD_TINY] = {"Tiny Mario", KIND_CHEAT, 0},
    [MOD_FAST] = {"Fast Mario", KIND_CHEAT, 0},
    /* Used by hle_obj_is_in_view above. */
    [MOD_EDGES] = {"Keep objects at widescreen edges", KIND_FIX, 1},
};
int game_mod_count = sizeof game_mods / sizeof game_mods[0];

/* Super Mario 64 does everything with the control stick, menus included. */
int game_ignores_dpad = 1;
/* Mario runs where the stick points, as seen by the camera. */
int game_stick_follows_camera = 1;
