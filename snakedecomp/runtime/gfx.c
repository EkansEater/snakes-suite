/*
 * The renderer: turns the game's drawing commands into a picture.
 *
 * Each frame the game writes a "display list": a long list of 8-byte
 * commands for the N64's graphics chip, in a format called Fast3D. They come
 * in two families, matching the chip's two halves:
 *
 *   Geometry commands ("RSP"): load a matrix, load some vertices, draw a
 *   triangle from three of them, set up lights...
 *
 *   Pixel commands ("RDP"): choose a texture, choose how texture and vertex
 *   colours are mixed (the "colour combiner"), fill a rectangle...
 *
 * We do what the chip did, in ordinary C: transform the vertices, then fill
 * in each triangle pixel by pixel into our own picture buffer. Because we
 * work in floating point rather than at the console's fixed 320x240, the
 * picture can be drawn at several times the original resolution.
 */
#include "gfx.h"
#include "gfx_internal.h"

#include <math.h>
#include <stdio.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define RAM_MASK 0x7FFFFF
#define SCREEN_W 320
#define SCREEN_H 240

static uint8_t *ram;
static int scale, width, height;
static uint32_t *pictures[2];  /* [1] is the finished frame; [0] an in-between one */
static uint32_t *color_buffer; /* the one being drawn: 0xAARRGGBB per pixel */

/* Widescreen. The game thinks the screen is 320 units wide. We draw a wider
 * picture and place the game's 320 in the middle: 3D scenery simply
 * continues into the extra space at the sides, since it was only ever cut
 * off there, not squeezed. */
static float wide_units = SCREEN_W; /* picture width in the game's units */
static float wide_offset;           /* where the game's x = 0 lands */

/* High resolution. Most games draw a picture of 320 by 240 units, but some
 * switch to a finer one for their menus and title screens (and a few for
 * everything): 640 by 480, or 320 by 480, twice as fine downwards only.
 * The game says how wide its picture is when it names the memory to draw
 * into, and how tall when it sets the box nothing may be drawn outside of.
 * We draw the same size of picture either way, so every position the game
 * gives is divided by these (2 where it is twice as fine). */
static float hires_x = 1, hires_y = 1;

/* Normally anything closer to the camera than a set distance (the "near
 * plane") is cut away. Chip programs with "NoN" in their name do not do
 * that: things may come right up to the camera, and flat models drawn over
 * the scene (a weapon shown in a corner, say) need not mind their depth. */
static int no_near;
/* A distance in quarter units of the game's screen, in our pixels. */
static int unit_x(int quarter_units) { return (int)((float)(quarter_units * scale) / (4 * hires_x)); }
static int unit_y(int quarter_units) { return (int)((float)(quarter_units * scale) / (4 * hires_y)); }

/* Free look: an extra turn and zoom applied on top of the game's camera. */
static float look_yaw, look_pitch, look_zoom = 1;

/* The free camera: a camera of our own that circles a point in the game's
 * world (the player's character), looking at it from "distance" away in
 * the direction given by yaw (round to the side) and pitch (up and over).
 * We keep the setting the previous frame was drawn with as well, so that
 * an in-between picture can use the halfway point. */
typedef struct {
    int on;
    float yaw, pitch, distance, focus[3];
} FreeCameraSetting;
static FreeCameraSetting free_now, free_before;
static float free_turn[4][4]; /* turns what the game's camera sees into what ours sees */
static int free_turn_ready;
static long gfx_frame_number; /* how many frames have been drawn */
static float last_camera[4][4]; /* the game's own camera, as of the last frame drawn */
static int have_last_camera;
static float view_back[3][3] = {{1, 0, 0}, {0, 1, 0}, {0, 0, 1}}; /* undoes the last frame's turn */

/* Smooth motion: the game moves things 30 times a second. For 60, we draw an
 * extra picture halfway between each pair of frames by blending the
 * position matrices of the previous frame with the current one's. */
#define MAX_MATRICES 4096
static float previous_matrices[MAX_MATRICES][4][4], current_matrices[MAX_MATRICES][4][4];
static int previous_matrix_count, matrix_index;
/* Where in the game's memory each matrix came from. A game keeps the matrix
 * of each thing it draws (an arm, a buoy) in the same place from one frame
 * to the next, which tells us which is which. */
static uint32_t previous_sources[MAX_MATRICES], current_sources[MAX_MATRICES];
static float blend = 1;      /* 1 = this frame as is, 0.5 = halfway from the previous */
static int measuring;        /* a dry run: read the matrices, draw nothing */
static int seen_perspective; /* has this frame started its 3D scene yet? */
static int dialect;          /* which set of drawing commands the game uses: GFX_FAST3D, ... (gfx.h) */
/* The camera's own matrix this frame, as the game gave it and as blended for
 * an in-between picture. Used to place shadows; see command_vertices. */
static float camera_exact[4][4], camera_blended[4][4];
static int have_camera;
/* A frame can hold more than one 3D scene, each with a lens and a camera of
 * its own: Wave Race 64's watercraft select has the rider on the water and,
 * above, four small jet skis turning on the spot. The camera above is the
 * first scene's. While a later scene with another lens is being drawn,
 * side_scene is set and its camera is kept here instead. */
static float lens_exact[4][4], scene_lens[4][4]; /* the lens last loaded; the first scene's */
static float side_camera_exact[4][4], side_camera_blended[4][4];
static int side_scene, have_side_camera;

/* World positions of the corners of each see-through shape, this frame and
 * the previous one (see command_vertices). */
#define MAX_TRACKED 2048
typedef struct { int count; float corner[64][3]; } Tracked;
static Tracked *tracked_now, *tracked_before;
static int tracked_count, tracked_before_count;
static float *depth_buffer;    /* 0 = nearest, 1 = farthest */
long gfx_triangle_count;
long gfx_rectangle_count, gfx_unhandled_count;
int gfx_report_unhandled;
int gfx_texture_smoothing = 1;

/* ---- Reading the game's memory -------------------------------------------- */

/* Texture copies
 * --------------
 * "Load texture" on the console copies the texture out of the game's memory
 * into the graphics chip's own. The game is then free to reuse that piece
 * of its memory, and some do so at once: Mario Kart 64 unpacks every letter
 * of its results screen into the same small buffer, loading each in turn.
 * We draw a frame's shapes together at the end, by which time such a
 * buffer holds only the last thing put in it. So we take a copy at load
 * time too, into a block that is emptied for each frame, and give the copy
 * an "address" with COPY_FLAG set, which the reading functions below
 * understand. */
#define COPY_FLAG 0x40000000u
#define COPY_ROOM 0x2000000u /* 32 MB: far more than a frame's textures */
static uint8_t *copies;
static uint32_t copies_used;

static uint32_t rd8(uint32_t a) { return a & COPY_FLAG ? copies[a & (COPY_ROOM - 1)] : ram[a & RAM_MASK]; }

/* Copy a texture's bytes and return the copy's address (or the original, if
 * there is no room left). */
static uint32_t keep_copy(uint32_t address, uint32_t bytes) {
    address &= RAM_MASK;
    if (!copies)
        copies = malloc(COPY_ROOM + 16);
    if (!copies || bytes == 0 || bytes > COPY_ROOM - copies_used - 16 || bytes > RAM_MASK + 1 - address)
        return address;
    uint32_t at = copies_used;
    memcpy(copies + at, ram + address, bytes);
    copies_used += (bytes + 15) & ~15u;
    return COPY_FLAG | at;
}
static uint32_t rd16(uint32_t a) { return rd8(a) << 8 | rd8(a + 1); }
static uint32_t rd32(uint32_t a) { return rd16(a) << 16 | rd16(a + 2); }

/* ---- State of the geometry half ("RSP") ------------------------------------ */

typedef struct {
    float x, y, z, w;     /* position after the matrices ("clip space") */
    float u, v;           /* texture coordinates, in texels */
    float r, g, b, a;     /* colour, 0-255 */
    float fog;            /* 0-255: how much fog colour to mix in */
    int clip;             /* which edges of the view it is outside of */
    int backdrop;         /* flat art drawn before the 3D scene, such as the sky */
} Vertex;

enum { CLIP_LEFT = 1, CLIP_RIGHT = 2, CLIP_BOTTOM = 4, CLIP_TOP = 8, CLIP_NEAR = 16 };

enum {
    G_ZBUFFER = 0x1,
    G_CULL_FRONT = 0x1000,
    G_CULL_BACK = 0x2000,
    G_FOG = 0x10000,
    G_LIGHTING = 0x20000,
    G_TEXTURE_GEN = 0x40000,
};

/* How many matrices can be kept to come back to. The game chooses the real
 * limit when it starts a list (10 in the earliest games, more later); ours
 * is simply bigger than any of them. */
#define MATRIX_STACK 32

static struct {
    uint32_t segments[16];
    float modelview[MATRIX_STACK + 1][4][4]; /* a stack: objects are positioned relative to others */
    float modelview_exact[MATRIX_STACK + 1][4][4]; /* the same, never blended (see "smooth motion") */
    int modelview_top;
    float projection[4][4];
    float combined[4][4]; /* modelview * projection */
    uint32_t geometry_mode;
    Vertex vertices[64];
    struct { float color[3], direction[3]; } lights[8];
    int light_count;
    float fog_multiply, fog_offset;
    float texture_scale_s, texture_scale_t;
    int texture_tile; /* which of the eight tile settings triangles are drawn with */
    /* How far outside its view a shape may reach before the chip cuts it
     * off, as a multiple of the view's size; 0 until the game says. With 1
     * nothing leaves the view, which split-screen games rely on. */
    int clip_ratio;
    float viewport_scale[3], viewport_translate[3];
} rsp;

/* ---- State of the pixel half ("RDP") --------------------------------------- */



static struct {
    uint32_t other_mode_h, other_mode_l;
    float prim_depth; /* one depth for a whole shape, 0 (nearest) to 1, for when the game asks for that */
    int cc[2][4], ac[2][4]; /* colour and alpha combiner settings, two cycles */
    int prim[4], env[4], fog[4], blend[4];
    int prim_lod_fraction; /* a number sent along with the prim colour: how far to fade between two textures (0..255) */
    uint32_t fill_color;
    uint32_t texture_image, texture_format, texture_size, texture_width;
    uint32_t color_image, depth_image, palette_address;
    Tile tiles[8];
    Loaded loaded[8];
    int next_loaded;
    int scissor[4]; /* left, top, right, bottom in output pixels */
} rdp;

enum { CYCLE_1 = 0, CYCLE_2 = 1, CYCLE_COPY = 2, CYCLE_FILL = 3 };
#define CYCLE_TYPE ((rdp.other_mode_h >> 20) & 3)
#define BILINEAR (((rdp.other_mode_h >> 12) & 3) != 0)

static uint32_t segmented(uint32_t address) {
    return (rsp.segments[(address >> 24) & 15] + (address & 0xFFFFFF)) & RAM_MASK;
}

/* ---- Matrices ---------------------------------------------------------------
 * A matrix is 4x4 numbers that move, rotate, scale or project points. The
 * N64 stores each number as a 32-bit fixed-point value, oddly split: first
 * all sixteen upper halves, then all sixteen lower halves. */

static void load_matrix(uint32_t address, float m[4][4]) {
    for (int i = 0; i < 16; i++) {
        int32_t fixed = (int32_t)(rd16(address + i * 2) << 16 | rd16(address + 32 + i * 2));
        m[i / 4][i % 4] = (float)fixed / 65536.0f;
    }
}

static void multiply(float out[4][4], float a[4][4], float b[4][4]) {
    float result[4][4];
    for (int i = 0; i < 4; i++)
        for (int j = 0; j < 4; j++)
            result[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j] + a[i][3] * b[3][j];
    memcpy(out, result, sizeof result);
}

/* A perspective matrix makes far things small: the fourth number it works
 * out for a point (w, which everything is then divided by) depends on
 * where the point is. For a flat picture like the HUD, w is always 1. */
static int is_perspective(float m[4][4]) { return m[0][3] != 0 || m[1][3] != 0 || m[2][3] != 0; }

/* ---- Finding the game's camera ------------------------------------------------
 * Games hand the graphics chip two matrices: "modelview" (where a thing is)
 * and "projection" (the camera's lens). Where the camera itself goes is up
 * to the game, and there are two habits:
 *
 *   - Super Mario 64 puts the camera in the modelview: the first one it
 *     loads for the 3D scene is the camera alone, and every object's is
 *     "object, then camera".
 *   - Mario Kart 64, Wave Race 64 and many others fold the camera into the
 *     projection: "camera, then lens" as one matrix.
 *
 * To put a camera of our own in, we need the game's camera on its own.
 * A lens matrix has a very particular shape (mostly zeros), so a "camera,
 * then lens" matrix can be split back into its two parts: proj_view (the
 * camera part, or "no change" if there was none) and proj_pure (the lens). */
static float proj_view[4][4], proj_pure[4][4];
static float proj_w_scale = 1; /* how many units of w one unit of distance from the camera is */
static int proj_has_view;
static const float no_change[4][4] = {{1, 0, 0, 0}, {0, 1, 0, 0}, {0, 0, 1, 0}, {0, 0, 0, 1}};

static void multiply(float out[4][4], float a[4][4], float b[4][4]);
static void split_projection(void) {
    float (*m)[4] = rsp.projection;
    memcpy(proj_view, no_change, sizeof proj_view);
    memcpy(proj_pure, m, sizeof proj_pure);
    proj_has_view = 0, proj_w_scale = 1;
    if (!is_perspective(m))
        return;
    /* The lens: x' = a*x + kx*z, y' = b*y + ky*z, z' = c*z + d, w = e*z.
     * (kx and ky are zero for an ordinary lens; a game can use them to
     * move the middle of the view off-centre, as Wave Race 64 does.)
     * Behind the lens, the camera part V is a turn and a move. Multiplying
     * the two out shows that the matrix's fourth column is V's third
     * column times e, and that its first two columns are V's first two
     * times a and b, plus kx and ky times that third column. */
    float e = -sqrtf(m[0][3] * m[0][3] + m[1][3] * m[1][3] + m[2][3] * m[2][3]);
    if (e > -1e-6f)
        return;
    float v[4][4] = {{0}};
    for (int i = 0; i < 4; i++)
        v[i][2] = m[i][3] / e;
    float kx = m[0][0] * v[0][2] + m[1][0] * v[1][2] + m[2][0] * v[2][2];
    float ky = m[0][1] * v[0][2] + m[1][1] * v[1][2] + m[2][1] * v[2][2];
    for (int i = 0; i < 4; i++)
        v[i][0] = m[i][0] - kx * v[i][2], v[i][1] = m[i][1] - ky * v[i][2];
    float a = sqrtf(v[0][0] * v[0][0] + v[1][0] * v[1][0] + v[2][0] * v[2][0]);
    float b = sqrtf(v[0][1] * v[0][1] + v[1][1] * v[1][1] + v[2][1] * v[2][1]);
    if (a < 1e-6f || b < 1e-6f)
        return;
    for (int i = 0; i < 4; i++)
        v[i][0] /= a, v[i][1] /= b;
    v[3][3] = 1;
    /* Is V really a turn (its directions square to each other)? If not,
     * this is some unusual projection: leave it whole. */
    if (fabsf(v[0][0] * v[0][1] + v[1][0] * v[1][1] + v[2][0] * v[2][1]) > 0.02f)
        return;
    float c = m[0][2] * v[0][2] + m[1][2] * v[1][2] + m[2][2] * v[2][2];
    float d = m[3][2] - v[3][2] * c;
    float pure[4][4] = {{a, 0, 0, 0}, {0, b, 0, 0}, {kx, ky, c, e}, {0, 0, d, 0}};
    proj_w_scale = -e;
    /* Only worth calling a camera if it differs from "no change". */
    float differs = 0;
    for (int i = 0; i < 4; i++)
        for (int j = 0; j < 3; j++)
            differs += fabsf(v[i][j] - no_change[i][j]);
    if (differs < 1e-3f)
        return;
    memcpy(proj_view, v, sizeof v);
    memcpy(proj_pure, pure, sizeof pure);
    proj_has_view = 1;
}

/* Which way is up in this game's world? Most use y; some use z. Our camera
 * is worked out for a y-up world, and world_fix turns the game's world
 * into one (and is "no change" when it already is). We find out by
 * watching the game's own camera: its "up" points mostly along the
 * world's up. */
static float world_fix[4][4] = {{1, 0, 0, 0}, {0, 1, 0, 0}, {0, 0, 1, 0}, {0, 0, 0, 1}};
static int up_votes; /* above 0: z is up; below: y is up */
static void notice_world_up(float camera[4][4]) {
    float up_y = camera[1][1], up_z = camera[2][1];
    if (fabsf(up_z) > fabsf(up_y) + 0.2f && fabsf(up_z) > fabsf(camera[0][1]))
        up_votes += up_votes < 60;
    else if (fabsf(up_y) > fabsf(up_z) + 0.2f)
        up_votes -= up_votes > -60;
    static const float z_up[4][4] = {{1, 0, 0, 0}, {0, 0, -1, 0}, {0, 1, 0, 0}, {0, 0, 0, 1}};
    if (up_votes > 20)
        memcpy(world_fix, z_up, sizeof world_fix);
    else if (up_votes < -20)
        memcpy(world_fix, no_change, sizeof world_fix);
}

/* How far in front of the game's camera is whatever it is looking at?
 * (Usually the player's character.) We note the distance of everything
 * drawn in the middle of the picture and a little below, where games put
 * the character, and take a typical near one. For games
 * we know nothing else about, the free camera circles the point that far
 * along the game camera's line of sight. */
#define MAX_DEPTH_SAMPLES 4096
static float depth_samples[MAX_DEPTH_SAMPLES];
static int depth_sample_count;
static float guess_depth;

static int compare_floats(const void *a, const void *b) {
    float x = *(const float *)a, y = *(const float *)b;
    return x < y ? -1 : x > y;
}
static void update_guess_depth(void) {
    if (depth_sample_count < 12)
        return;
    qsort(depth_samples, (size_t)depth_sample_count, sizeof(float), compare_floats);
    /* One of the nearer ones: the character is in front of the scenery
     * behind it, and may be only a few points among the scenery's many. */
    float typical = depth_samples[depth_sample_count * 15 / 100];
    guess_depth = guess_depth > 0 ? guess_depth * 0.8f + typical * 0.2f : typical;
}

/* A camera cannot draw what is right in front of its nose: anything nearer
 * than its "near plane" is cut away. The game sets that distance for its
 * own camera, which keeps well back from walls, and it is generous (100
 * units in Super Mario 64, about two thirds of Mario's height). Our free
 * camera gets pressed up against walls and slopes, and with the game's
 * setting it would cut holes in them and show what is behind. So for the
 * free camera we bring the near plane in to a tenth of the distance.
 *
 * Two numbers in the projection matrix hold the near and far distances in
 * a mixed-up form; we unmix them, change near, and mix them again. Fog is
 * worked out from the depth those two numbers produce, so we also note how
 * to get from the new depth back to the one the game expected. */
static float fog_scale = 1, fog_shift;
static void bring_near_plane_closer(float projection[4][4]) {
    float a = projection[2][2], b = projection[3][2];
    if (a >= -1 || b >= 0 || projection[0][2] != 0 || projection[1][2] != 0)
        return; /* not the usual kind of projection: leave it alone */
    float near = b / (a - 1), far = b / (a + 1);
    near /= 10;
    float new_a = (near + far) / (near - far), new_b = 2 * near * far / (near - far);
    projection[2][2] = new_a, projection[3][2] = new_b;
    fog_scale = a / new_a, fog_shift = b - new_b * a / new_a;
}

/* modelview * projection, slipping in the free-look turn between them
 * (only for 3D scenes, not for flat things like the HUD). */
static void combine_with(float out[4][4], float modelview[4][4]) {
    fog_scale = 1, fog_shift = 0;
    if (is_perspective(rsp.projection) && free_turn_ready) { /* the free camera: see prepare_free_turn */
        float through_ours[4][4], projection[4][4];
        memcpy(projection, proj_pure, sizeof projection);
        bring_near_plane_closer(projection);
        multiply(through_ours, free_turn, projection);
        multiply(through_ours, proj_view, through_ours);
        multiply(out, modelview, through_ours);
        return;
    }
    if (!is_perspective(rsp.projection) || (look_yaw == 0 && look_pitch == 0 && look_zoom == 1)) {
        multiply(out, modelview, rsp.projection);
        return;
    }
    float cy = cosf(look_yaw), sy = sinf(look_yaw), cp = cosf(look_pitch), sp = sinf(look_pitch);
    float turn[4][4] = {{cy, sy * sp, -sy * cp, 0}, {0, cp, sp, 0}, {sy, -cy * sp, cy * cp, 0}, {0, 0, 0, 1}};
    float zoomed[4][4];
    memcpy(zoomed, proj_pure, sizeof zoomed);
    for (int i = 0; i < 4; i++)
        zoomed[i][0] *= look_zoom, zoomed[i][1] *= look_zoom;
    multiply(turn, turn, zoomed);
    multiply(turn, proj_view, turn); /* (the turn goes after the game's camera, wherever that is) */
    multiply(out, modelview, turn);
}

static void update_combined(void) { combine_with(rsp.combined, rsp.modelview[rsp.modelview_top]); }

static int invert(float out[4][4], float m[4][4]);
static void direction(float out[3], float yaw, float pitch);

/* Work out free_turn for the picture about to be drawn. Called as soon as
 * we have seen the game's camera matrix for this frame (camera_blended).
 *
 * Everything the game draws arrives already worked out for the game's
 * camera. So to see it through ours instead we first undo the game's
 * camera, which gives positions in the world, and then apply our own:
 *     free_turn = (undo the game's camera) x (our camera)                */
static void prepare_free_turn(void) {
    free_turn_ready = 0;
    if (!free_now.on)
        return;
    /* An in-between picture (blend 0.5) uses a camera halfway between the
     * last frame's and this one's, so that turning is as smooth as the rest. */
    float t = free_before.on ? blend : 1;
    float yaw = free_before.yaw + (free_now.yaw - free_before.yaw) * t;
    float pitch = free_before.pitch + (free_now.pitch - free_before.pitch) * t;
    float distance = free_before.distance + (free_now.distance - free_before.distance) * t;
    float focus[3], eye[3], forward[3], game_focus[3];
    direction(forward, yaw, pitch);
    for (int i = 0; i < 3; i++)
        game_focus[i] = free_before.focus[i] + (free_now.focus[i] - free_before.focus[i]) * t;
    for (int i = 0; i < 3; i++) {
        /* (into a y-up world, where the rest of this is worked out) */
        focus[i] = game_focus[0] * world_fix[0][i] + game_focus[1] * world_fix[1][i] + game_focus[2] * world_fix[2][i];
        eye[i] = focus[i] - forward[i] * distance;
    }
    /* Our camera's matrix. Its three columns are the directions that
     * become right, up and backwards on screen; the last row moves the
     * camera's own position to the middle. */
    float right[3] = {-forward[2], 0, forward[0]}; /* level, and square to forward */
    float length = sqrtf(right[0] * right[0] + right[2] * right[2]);
    right[0] /= length, right[2] /= length;
    float up[3] = {right[1] * forward[2] - right[2] * forward[1], right[2] * forward[0] - right[0] * forward[2],
                   right[0] * forward[1] - right[1] * forward[0]};
    float ours[4][4] = {{0}}, undo[4][4];
    for (int i = 0; i < 3; i++) {
        ours[i][0] = right[i], ours[i][1] = up[i], ours[i][2] = -forward[i];
        ours[3][0] -= eye[i] * right[i], ours[3][1] -= eye[i] * up[i], ours[3][2] += eye[i] * forward[i];
    }
    ours[3][3] = 1;
    if (!invert(undo, camera_blended))
        return;
    multiply(ours, world_fix, ours);
    multiply(free_turn, undo, ours);
    free_turn_ready = 1;
}

/* The matrix that undoes another (so that m * inverse = no change).
 * Returns 0 if there is none. */
static int invert(float out[4][4], float m[4][4]) {
    double a[4][8];
    for (int i = 0; i < 4; i++)
        for (int j = 0; j < 8; j++)
            a[i][j] = j < 4 ? m[i][j] : (j - 4 == i);
    for (int col = 0; col < 4; col++) {
        int pivot = col;
        for (int row = col + 1; row < 4; row++)
            if (fabs(a[row][col]) > fabs(a[pivot][col]))
                pivot = row;
        if (fabs(a[pivot][col]) < 1e-12)
            return 0;
        for (int j = 0; j < 8; j++) {
            double t = a[col][j];
            a[col][j] = a[pivot][j], a[pivot][j] = t;
        }
        double scale_by = 1 / a[col][col];
        for (int j = 0; j < 8; j++)
            a[col][j] *= scale_by;
        for (int row = 0; row < 4; row++)
            if (row != col) {
                double factor = a[row][col];
                for (int j = 0; j < 8; j++)
                    a[row][j] -= factor * a[col][j];
            }
    }
    for (int i = 0; i < 4; i++)
        for (int j = 0; j < 4; j++)
            out[i][j] = (float)a[i][j + 4];
    return 1;
}

/* projection: for the camera's lens rather than for placing things.
 * load: replace the current matrix rather than combine with it.
 * push: keep a copy of the current one first, to come back to. */
static void command_matrix(int projection, int load, int push, uint32_t w1) {
    float m[4][4], exact[4][4];
    load_matrix(segmented(w1), m);
    memcpy(exact, m, sizeof exact);
    if (getenv("SHOW_MATRICES") && !measuring && gfx_frame_number == atol(getenv("SHOW_MATRICES"))) /* for testing */
        fprintf(stderr, "matrix #%d %s%s%s top %d at %08X: %8.3f %8.3f %8.3f | %8.3f %8.3f %8.3f | %8.3f %8.3f %8.3f | move %9.2f %9.2f %9.2f | w %.3f %.3f %.3f %.3f\n",
                matrix_index, projection ? "PROJ " : "", load ? "load" : "mul", push ? " push" : "", rsp.modelview_top, w1,
                m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2], m[2][0], m[2][1], m[2][2], m[3][0], m[3][1], m[3][2],
                m[0][3], m[1][3], m[2][3], m[3][3]);

    /* Matrices arrive in much the same order every frame (the game walks
     * its scene the same way), so this one's counterpart in the previous
     * frame is at or near the same place in the list. Objects appearing and
     * disappearing shift the list a little, so look a few places either
     * side.
     *
     * The counterpart is the one that came from the same place in the
     * game's memory, if there is one. Only failing that do we take the one
     * that looks most alike, because looks deceive: the parts of one
     * moving figure (Wave Race 64's rider and jet ski are some thirty
     * pieces, a few units apart) are closer to each other than to where
     * they themselves were a frame ago. Paired by looks, each piece was
     * drawn halfway to its neighbour in every in-between picture, and the
     * figure flickered. */
    if (matrix_index < MAX_MATRICES) {
        memcpy(current_matrices[matrix_index], m, sizeof m);
        current_sources[matrix_index] = w1;
        float (*best)[4] = NULL, best_score = 0;
        int same_source = 0;
        for (int j = matrix_index - 8; blend < 1 && j <= matrix_index + 8; j++)
            same_source |= j >= 0 && j < previous_matrix_count && previous_sources[j] == w1;
        for (int j = matrix_index - 8; blend < 1 && j <= matrix_index + 8; j++) {
            if (j < 0 || j >= previous_matrix_count)
                continue;
            if (same_source && previous_sources[j] != w1)
                continue;
            float (*old)[4] = previous_matrices[j], score = 0, jump = 0;
            if (is_perspective(m) != is_perspective(old))
                continue;
            if (same_source) /* (drawn twice from one place: the nearer in the list is the one) */
                score = (float)abs(j - matrix_index) * 1e6f;
            for (int i = 0; i < 3; i++) {
                jump = fmaxf(jump, fabsf(m[3][i] - old[3][i]));
                for (int k = 0; k < 3; k++)
                    score += fabsf(m[i][k] - old[i][k]) * 100; /* turned or resized */
                score += fabsf(m[3][i] - old[3][i]);         /* moved */
            }
            /* A long jump means it is something else, or the camera cut to
             * a new shot; blending would smear it across the screen. */
            if (jump < 300 && (!best || score < best_score))
                best = old, best_score = score;
        }
        if (best) {
            for (int i = 0; i < 4; i++)
                for (int j = 0; j < 4; j++)
                    m[i][j] = best[i][j] + (m[i][j] - best[i][j]) * blend;
        }
    }
    matrix_index++;

    if (projection) {
        if (load) {
            memcpy(rsp.projection, m, sizeof m);
            if (is_perspective(exact)) {
                /* A lens unlike the first scene's begins another scene. */
                memcpy(lens_exact, exact, sizeof m);
                side_scene = have_camera && memcmp(lens_exact, scene_lens, sizeof m) != 0;
                have_side_camera = 0;
            }
        } else {
            multiply(rsp.projection, m, rsp.projection);
        }
        split_projection();
        if (is_perspective(rsp.projection)) {
            seen_perspective = 1;
            if (proj_has_view && !have_camera) { /* the camera came with the lens */
                memcpy(camera_exact, proj_view, sizeof m);
                memcpy(camera_blended, proj_view, sizeof m);
                memcpy(scene_lens, lens_exact, sizeof m);
                have_camera = 1;
                prepare_free_turn();
            }
        }
    } else {
        if (push && rsp.modelview_top < MATRIX_STACK) {
            rsp.modelview_top++;
            memcpy(rsp.modelview[rsp.modelview_top], rsp.modelview[rsp.modelview_top - 1], sizeof m);
            memcpy(rsp.modelview_exact[rsp.modelview_top], rsp.modelview_exact[rsp.modelview_top - 1], sizeof m);
        }
        float (*top)[4] = rsp.modelview[rsp.modelview_top], (*top_exact)[4] = rsp.modelview_exact[rsp.modelview_top];
        if (load) {
            memcpy(top, m, sizeof m);
            memcpy(top_exact, exact, sizeof m);
            /* The first matrix of the 3D scene is the camera on its own:
             * the game draws the level itself before the objects in it. */
            if (!have_camera && is_perspective(rsp.projection) && !proj_has_view) {
                memcpy(camera_exact, exact, sizeof m);
                memcpy(camera_blended, m, sizeof m);
                memcpy(scene_lens, lens_exact, sizeof m);
                have_camera = 1;
                prepare_free_turn();
            } else if (side_scene && !have_side_camera && is_perspective(rsp.projection) && !proj_has_view) {
                memcpy(side_camera_exact, exact, sizeof m); /* likewise, for a later scene */
                memcpy(side_camera_blended, m, sizeof m);
                have_side_camera = 1;
            }
        } else {
            multiply(top, m, top);
            multiply(top_exact, exact, top_exact);
        }
    }
    update_combined();
}

/* ---- Vertices ---------------------------------------------------------------
 * Loading a vertex does the 3D maths once: where it lands on screen, and
 * what colour the lights make it. Triangles then just refer to vertices. */

static void command_vertices(uint32_t w0, uint32_t w1) {
    /* "Load count vertices into the list, starting at position first." Each
     * dialect packs those two numbers into the command differently. */
    int count, first;
    switch (dialect) {
    case GFX_F3DEX: count = (int)((w0 >> 10) & 63), first = (int)((w0 >> 16) & 255) / 2; break;
    case GFX_F3DEX2: count = (int)((w0 >> 12) & 255), first = (int)((w0 >> 1) & 127) - count; break;
    case GFX_F3DWAVE: count = (int)((w0 >> 9) & 127), first = (int)((w0 >> 16) & 255) / 5; break;
    default: count = (int)((w0 >> 20) & 15) + 1, first = (int)((w0 >> 16) & 15); break;
    }
    if (first < 0 || first + count > 64) {
        if (getenv("SHOW_GRAPHICS")) /* for testing: a vertex load we cannot hold */
            fprintf(stderr, "gfx: vertex load of %d at %d does not fit (command %08X)\n", count, first, w0);
        return;
    }
    uint32_t address = segmented(w1);
    float (*mv)[4] = rsp.modelview[rsp.modelview_top];

    /* Shadows, and other see-through things, in an in-between picture need
     * care. A shadow's corners are worked out by the game for exactly where
     * its owner is THIS frame, so that it hugs the floor there. Drawn with a
     * blended matrix it would float above the floor or sink under it
     * whenever the owner moves up or down or crosses a slope, and so flicker
     * or jitter.
     *
     * So for these we go corner by corner instead. Removing the camera from
     * the matrix tells us where each corner is in the world. We remember
     * those from the previous frame, find the same shape among them, and put
     * each corner partway between where it was and where it is now. Both
     * ends lie on the floor, so the in-between does too. */
    int decal = ((rdp.other_mode_l >> 10) & 3) == 3, see_through = (rdp.other_mode_l & 0x40000) == 0;
    float to_world[4][4], world_to_screen[4][4];
    /* Most games put the camera into the position matrix, so removing it
     * gives the world. A few (Wave Race 64) put it into the lens instead:
     * their position matrices are the world already, and there is nothing
     * to remove. Removing it all the same sent every see-through shape
     * somewhere else in each in-between picture: spray, buoys and
     * shadows flashed on and off as you raced. */
    /* The camera to remove is the one of the scene being drawn. Using the
     * first scene's for all of them gave the small jet skis of Wave Race
     * 64's watercraft select "world" positions that slid along with the
     * rider's camera below, far enough each frame for a piece to be taken
     * for its neighbour: the rear of the chosen jet ski jumped back and
     * forth. */
    float (*scene_camera)[4] = side_scene ? side_camera_exact : camera_exact;
    int have_scene_camera = side_scene ? have_side_camera || proj_has_view : have_camera;
    int track = (decal || see_through) && have_scene_camera && is_perspective(rsp.projection) &&
                tracked_count < MAX_TRACKED && (proj_has_view || invert(to_world, scene_camera));
    Tracked *now = NULL;
    const Tracked *before = NULL;
    if (track) {
        if (proj_has_view)
            memcpy(to_world, rsp.modelview_exact[rsp.modelview_top], sizeof to_world);
        else
            multiply(to_world, rsp.modelview_exact[rsp.modelview_top], to_world);
        now = &tracked_now[tracked_count++];
        now->count = count;
        for (int i = 0; i < count; i++) {
            uint32_t a = address + (uint32_t)i * 16;
            float x = (int16_t)rd16(a), y = (int16_t)rd16(a + 2), z = (int16_t)rd16(a + 4);
            for (int k = 0; k < 3; k++)
                now->corner[i][k] = x * to_world[0][k] + y * to_world[1][k] + z * to_world[2][k] + to_world[3][k];
        }
        if (blend < 1) {
            /* Find the same shape in the previous frame: same number of
             * corners, and the nearest (but not far away). Every corner is
             * compared, not just the first: pieces of one surface often
             * start from a corner they share, and going by that alone would
             * pair a piece with its neighbour and draw it bent halfway
             * into the neighbour's shape. */
            float nearest = 300;
            for (int j = 0; j < tracked_before_count; j++) {
                const Tracked *t = &tracked_before[j];
                if (t->count != count)
                    continue;
                float distance = 0;
                for (int c = 0; c < count && distance < nearest * (float)count; c++)
                    for (int k = 0; k < 3; k++)
                        distance += fabsf(t->corner[c][k] - now->corner[c][k]);
                distance /= (float)count; /* the average over the corners */
                if (distance < nearest)
                    nearest = distance, before = t;
            }
            float no_change[4][4] = {{1, 0, 0, 0}, {0, 1, 0, 0}, {0, 0, 1, 0}, {0, 0, 0, 1}};
            /* (the lens matrix, blended like any other, holds the camera in those games) */
            combine_with(world_to_screen, proj_has_view ? no_change : side_scene ? side_camera_blended : camera_blended);
        }
    }

    for (int i = 0; i < count; i++, address += 16) {
        Vertex *v = &rsp.vertices[first + i];
        float x = (int16_t)rd16(address), y = (int16_t)rd16(address + 2), z = (int16_t)rd16(address + 4);
        float s = (int16_t)rd16(address + 8), t = (int16_t)rd16(address + 10);

        v->x = x * rsp.combined[0][0] + y * rsp.combined[1][0] + z * rsp.combined[2][0] + rsp.combined[3][0];
        v->y = x * rsp.combined[0][1] + y * rsp.combined[1][1] + z * rsp.combined[2][1] + rsp.combined[3][1];
        v->z = x * rsp.combined[0][2] + y * rsp.combined[1][2] + z * rsp.combined[2][2] + rsp.combined[3][2];
        v->w = x * rsp.combined[0][3] + y * rsp.combined[1][3] + z * rsp.combined[2][3] + rsp.combined[3][3];

        if (track && blend < 1 && (before || decal)) {
            /* partway from last frame's corner to this frame's (or, with no
             * match, a decal at least goes exactly where it is this frame) */
            float p[3];
            for (int k = 0; k < 3; k++)
                p[k] = before ? before->corner[i][k] + (now->corner[i][k] - before->corner[i][k]) * blend
                              : now->corner[i][k];
            v->x = p[0] * world_to_screen[0][0] + p[1] * world_to_screen[1][0] + p[2] * world_to_screen[2][0] + world_to_screen[3][0];
            v->y = p[0] * world_to_screen[0][1] + p[1] * world_to_screen[1][1] + p[2] * world_to_screen[2][1] + world_to_screen[3][1];
            v->z = p[0] * world_to_screen[0][2] + p[1] * world_to_screen[1][2] + p[2] * world_to_screen[2][2] + world_to_screen[3][2];
            v->w = p[0] * world_to_screen[0][3] + p[1] * world_to_screen[1][3] + p[2] * world_to_screen[2][3] + world_to_screen[3][3];
        }

        /* (see update_guess_depth) */
        if (!measuring && blend == 1 && !free_turn_ready && v->w > 0 && depth_sample_count < MAX_DEPTH_SAMPLES &&
            fabsf(v->x) < 0.15f * v->w && v->y > -0.5f * v->w && v->y < 0.2f * v->w && is_perspective(rsp.projection))
            depth_samples[depth_sample_count++] = v->w / proj_w_scale;

        /* In widescreen the left and right edges are further out. */
        float side = v->w * wide_units / SCREEN_W;
        v->backdrop = !seen_perspective && !is_perspective(rsp.projection);
        v->clip = (v->x < -side ? CLIP_LEFT : 0) | (v->x > side ? CLIP_RIGHT : 0) |
                  (v->y < -v->w ? CLIP_BOTTOM : 0) | (v->y > v->w ? CLIP_TOP : 0) |
                  ((no_near ? v->w <= 0 : v->z < -v->w) ? CLIP_NEAR : 0);

        v->u = s * rsp.texture_scale_s / 32.0f;
        v->v = t * rsp.texture_scale_t / 32.0f;

        if (rsp.geometry_mode & G_LIGHTING) {
            /* The last three bytes are not a colour but the direction the
             * surface faces. Turn it the way the object is turned, then see
             * how directly each light shines on it. */
            float n[3] = {(int8_t)rd8(address + 12), (int8_t)rd8(address + 13), (int8_t)rd8(address + 14)};
            float e[3];
            for (int j = 0; j < 3; j++)
                e[j] = n[0] * mv[0][j] + n[1] * mv[1][j] + n[2] * mv[2][j];
            float length = sqrtf(e[0] * e[0] + e[1] * e[1] + e[2] * e[2]);
            if (length > 0)
                e[0] /= length, e[1] /= length, e[2] /= length;

            float *ambient = rsp.lights[rsp.light_count].color;
            float c[3] = {ambient[0], ambient[1], ambient[2]};
            for (int k = 0; k < rsp.light_count; k++) {
                float *d = rsp.lights[k].direction;
                float amount = e[0] * d[0] + e[1] * d[1] + e[2] * d[2];
                if (amount > 0)
                    for (int j = 0; j < 3; j++)
                        c[j] += rsp.lights[k].color[j] * amount;
            }
            v->r = fminf(c[0], 255), v->g = fminf(c[1], 255), v->b = fminf(c[2], 255);

            if (rsp.geometry_mode & G_TEXTURE_GEN) {
                /* Shiny surfaces: pick the texture by facing direction. */
                v->u = (e[0] + 1) / 4 * rsp.texture_scale_s * 65536.0f / 32.0f;
                v->v = (e[1] + 1) / 4 * rsp.texture_scale_t * 65536.0f / 32.0f;
            }
        } else {
            v->r = (float)rd8(address + 12), v->g = (float)rd8(address + 13), v->b = (float)rd8(address + 14);
        }
        v->a = (float)rd8(address + 15);

        v->fog = 0;
        if (rsp.geometry_mode & G_FOG) {
            float inverse = v->w > 0 ? 1.0f / v->w : 32767.0f;
            /* (fog_scale and fog_shift: see bring_near_plane_closer) */
            float f = (v->z * fog_scale + fog_shift) * inverse * rsp.fog_multiply + rsp.fog_offset;
            v->fog = f < 0 ? 0 : f > 255 ? 255 : f;
        }
    }
}

/* ---- Everything needed to draw one shape -------------------------------------
 * Shapes are not drawn the moment their command arrives. Each is recorded
 * with a copy of all the settings that affect its pixels, and at the end of
 * the frame several CPU cores draw the whole list at once, each core taking
 * its own horizontal strip of the screen. Within a strip the shapes are
 * still drawn in order, so the picture is the same as drawing one by one. */





#define MAX_SHAPES 16384
static Shape *shapes;
static int shape_count;
static void draw_all_shapes(void);

static Shape *new_shape(Kind kind) {
    if (shape_count == MAX_SHAPES)
        draw_all_shapes();
    Shape *shape = &shapes[shape_count++];
    shape->kind = kind;
    return shape;
}

static int combiner_uses_texture(void) {
    for (int cycle = CYCLE_TYPE == CYCLE_2 ? 0 : 1; cycle < 2; cycle++) {
        for (int i = 0; i < 4; i++)
            if (rdp.cc[cycle][i] == 1 || rdp.cc[cycle][i] == 2 || rdp.ac[cycle][i] == 1 || rdp.ac[cycle][i] == 2)
                return 1;
        if (rdp.cc[cycle][2] == 8 || rdp.cc[cycle][2] == 9)
            return 1;
    }
    return 0;
}

static const Loaded *find_loaded(int tmem) {
    for (int i = 0; i < 8; i++)
        if (rdp.loaded[i].address && rdp.loaded[i].tmem == tmem)
            return &rdp.loaded[i];
    return NULL;
}

/* Take a snapshot of the current settings. */
/* A quirk of the chip that a few games lean on. Texture memory is made of
 * 8-byte words, and on every odd row the chip stores the two halves of each
 * word the other way round, and turns them back when drawing. When loading
 * a strip it works out which row a word is on from a step the game gives
 * (the last number in the load command), not from the row length. Normally
 * the two agree and nothing shows. But a game may give a step of 0 ("all one
 * row") for a texture it has stored with its odd rows already turned round:
 * then nothing is turned on the way in, and the odd rows are turned on the
 * way out. Where the two disagree, we do the turning here, in our copy of
 * the texture, the first time it is drawn (only then is the row length
 * certain). */
static void turn_odd_rows(Loaded *loaded, uint32_t row) {
    uint32_t step = (uint32_t)loaded->step_plus_1 - 1;
    loaded->step_plus_1 = 0; /* once is enough */
    if (!(loaded->address & COPY_FLAG) || row < 8 || row % 8)
        return;
    uint8_t *words = copies + (loaded->address & (COPY_ROOM - 1));
    for (uint32_t i = 0; i * 8 + 8 <= loaded->bytes; i++) {
        uint32_t row_when_loading = i * step >> 11, row_when_drawing = i * 8 / row;
        if ((row_when_loading ^ row_when_drawing) & 1) {
            uint8_t half[4];
            memcpy(half, words + i * 8, 4);
            memcpy(words + i * 8, words + i * 8 + 4, 4);
            memcpy(words + i * 8 + 4, half, 4);
        }
    }
}

static void capture_state(DrawState *d, int tile_index, int allow_depth) {
    memset(d, 0, sizeof *d); /* so that two identical states compare equal byte for byte */
    const Tile *tile = &rdp.tiles[tile_index];
    const Loaded *loaded = find_loaded(tile->tmem);
    d->tile = *tile;
    if (loaded) {
        d->loaded = *loaded;
    } else {
        /* Nothing was loaded at exactly this tile's place in texture memory,
         * but it may lie inside something bigger that was: games load
         * several pictures as one block and point a tile at each. Texture
         * memory is counted in 8-byte units. */
        for (int i = 0; i < 8; i++) {
            const Loaded *whole = &rdp.loaded[i];
            uint32_t offset = (uint32_t)(tile->tmem - whole->tmem) * 8;
            if (whole->address && !whole->fixed_rows && tile->tmem > whole->tmem && offset < whole->bytes) {
                d->loaded = *whole;
                d->loaded.address += offset, d->loaded.source += offset, d->loaded.bytes -= offset;
                loaded = whole;
                break;
            }
        }
    }
    /* A texture loaded as one long strip is cut into rows by the tile it
     * is drawn with, whichever of the eight that is. */
    if (loaded && !d->loaded.fixed_rows && tile->line)
        d->loaded.row_bytes = (uint32_t)tile->line * 8 * (tile->size == 3 ? 2 : 1);
    if (loaded && loaded->step_plus_1 == 1 && tile->size != 3) /* (a step of 0: the one case games rely on) */
        turn_odd_rows((Loaded *)loaded, d->loaded.row_bytes);
    d->use_texture = loaded != NULL && combiner_uses_texture();
    /* How the pixel meets what is already on screen ("blender"). Bit 18 says
     * the new pixel simply replaces the old; otherwise they are mixed. */
    d->use_alpha = (rdp.other_mode_l & 0x40000) == 0;
    {
        /* The blender's full recipe is "(P * A + M * B) / (A + B)", with
         * each of the four chosen from a short menu by two bits of the
         * mode (a second set of choices applies in two-cycle mode). The
         * usual way to say "opaque" is A = nothing, M = the new pixel,
         * B = everything: the new pixel exactly, whatever its alpha. Games
         * clear parts of the screen that way with an alpha of zero (Mario
         * Kart 64 behind its results board), so it must not be mixed. */
        int second = CYCLE_TYPE == CYCLE_2;
        uint32_t a_choice = (rdp.other_mode_l >> (second ? 24 : 26)) & 3;
        uint32_t m_choice = (rdp.other_mode_l >> (second ? 20 : 22)) & 3;
        if (a_choice == 3 && m_choice == 0)
            d->use_alpha = 0;
    }
    d->use_fog = (rdp.other_mode_l >> 30) == 3;
    /* "Texture edge" mode: the texture's alpha cuts holes in the shape. */
    d->cutout = (rdp.other_mode_l & 0x1000) != 0;
    int z = allow_depth && (rsp.geometry_mode & G_ZBUFFER);
    d->depth_test = z && (rdp.other_mode_l & 0x10);
    d->depth_write = z && (rdp.other_mode_l & 0x20);
    d->decal = ((rdp.other_mode_l >> 10) & 3) == 3; /* drawn flat on another surface */
    d->bilinear = BILINEAR && gfx_texture_smoothing;
    /* One-cycle mode uses the second set of combiner choices; two-cycle mode
     * runs the first set and feeds its result into the second. */
    d->first_cycle = CYCLE_TYPE == CYCLE_2 ? 0 : 1;
    memcpy(d->cc, rdp.cc, sizeof d->cc);
    memcpy(d->ac, rdp.ac, sizeof d->ac);
    memcpy(d->prim, rdp.prim, sizeof d->prim);
    memcpy(d->env, rdp.env, sizeof d->env);
    memcpy(d->fog, rdp.fog, sizeof d->fog);
    d->palette_address = rdp.palette_address;
    memcpy(d->scissor, rdp.scissor, sizeof d->scissor);
}

/* ---- Textures ---------------------------------------------------------------
 * Look up one texel (texture pixel). The N64 has many compact texture
 * formats; all are converted here to red, green, blue, alpha (0-255). */

enum { FMT_RGBA = 0, FMT_YUV = 1, FMT_CI = 2, FMT_IA = 3, FMT_I = 4 };

static inline void rgba16(uint32_t p, int out[4]) {
    out[0] = (int)((p >> 11) & 31) * 255 / 31;
    out[1] = (int)((p >> 6) & 31) * 255 / 31;
    out[2] = (int)((p >> 1) & 31) * 255 / 31;
    out[3] = (p & 1) ? 255 : 0;
}

static inline int wrap(int i, int clamp, int mirror, int mask, int low, int high) {
    if (clamp || !mask) {
        int limit = (high - low) / 4;
        if (i < 0)
            i = 0;
        if (i > limit && (clamp || limit > 0))
            i = limit;
    }
    if (mask) {
        if (mirror && ((i >> mask) & 1))
            i = ~i;
        i &= (1 << mask) - 1;
    }
    return i;
}

static inline void fetch_raw(const DrawState *d, int s, int t, int out[4]);

static inline void fetch_texel(const DrawState *d, int s, int t, int out[4]) {
    const Tile *tile = &d->tile;
    s = wrap(s, tile->clamp_s, tile->mirror_s, tile->mask_s, tile->uls, tile->lrs);
    t = wrap(t, tile->clamp_t, tile->mirror_t, tile->mask_t, tile->ult, tile->lrt);
    fetch_raw(d, s, t, out);
}

/* The texel at column s, row t of the loaded texture, with no wrapping. */
static inline void fetch_raw(const DrawState *d, int s, int t, int out[4]) {
    const Tile *tile = &d->tile;
    uint32_t row = d->loaded.address + (uint32_t)t * d->loaded.row_bytes;
    uint32_t p;
    switch (tile->size) {
    case 0: /* 4 bits per texel */
        p = rd8(row + (uint32_t)s / 2);
        p = (s & 1) ? p & 15 : p >> 4;
        if (tile->format == FMT_CI) {
            rgba16(rd16(d->palette_address + (uint32_t)(tile->palette * 16 + (int)p) * 2), out);
        } else if (tile->format == FMT_IA) {
            out[0] = out[1] = out[2] = (int)(p >> 1) * 255 / 7;
            out[3] = (p & 1) ? 255 : 0;
        } else {
            out[0] = out[1] = out[2] = out[3] = (int)p * 17;
        }
        break;
    case 1: /* 8 bits */
        p = rd8(row + (uint32_t)s);
        if (tile->format == FMT_CI) {
            rgba16(rd16(d->palette_address + p * 2), out);
        } else if (tile->format == FMT_IA) {
            out[0] = out[1] = out[2] = (int)(p >> 4) * 17;
            out[3] = (int)(p & 15) * 17;
        } else {
            out[0] = out[1] = out[2] = out[3] = (int)p;
        }
        break;
    case 2: /* 16 bits */
        p = rd16(row + (uint32_t)s * 2);
        if (tile->format == FMT_IA) {
            out[0] = out[1] = out[2] = (int)(p >> 8);
            out[3] = (int)(p & 255);
        } else {
            rgba16(p, out);
        }
        break;
    default: /* 32 bits */
        p = rd32(row + (uint32_t)s * 4);
        out[0] = (int)(p >> 24), out[1] = (int)((p >> 16) & 255);
        out[2] = (int)((p >> 8) & 255), out[3] = (int)(p & 255);
    }
}

/* u, v: position in the texture, where texel i covers i to i+1. With
 * filtering on, blend the four nearest texels for a smooth result. */
static inline void sample_texture(const DrawState *d, float u, float v, int out[4]) {
    u -= (float)d->tile.uls / 4, v -= (float)d->tile.ult / 4;
    if (!d->bilinear) {
        fetch_texel(d, (int)floorf(u), (int)floorf(v), out);
        return;
    }
    u -= 0.5f, v -= 0.5f; /* texel i is centred at i + 0.5 */
    int s = (int)floorf(u), t = (int)floorf(v);
    int fu = (int)((u - (float)s) * 256), fv = (int)((v - (float)t) * 256);
    int a[4], b[4], c[4], e[4];
    fetch_texel(d, s, t, a);
    fetch_texel(d, s + 1, t, b);
    fetch_texel(d, s, t + 1, c);
    fetch_texel(d, s + 1, t + 1, e);
    for (int i = 0; i < 4; i++) {
        int top = a[i] * 256 + (b[i] - a[i]) * fu;
        int bottom = c[i] * 256 + (e[i] - c[i]) * fu;
        out[i] = (top * 256 + (bottom - top) * fv + 32768) >> 16;
    }
}

/* For back ends that keep their own copy of textures (the graphics card
 * does): how big the texture is, and all of its texels. */
void gfx_texture_size(const DrawState *d, int *w, int *h) {
    const Tile *tile = &d->tile;
    int bits = 4 << tile->size;
    if (d->loaded.fixed_rows) {
        *w = (tile->lrs - tile->uls) / 4 + 1, *h = (tile->lrt - tile->ult) / 4 + 1;
    } else {
        *w = (int)(d->loaded.row_bytes * 8) / bits;
        *h = d->loaded.bytes && d->loaded.row_bytes ? (int)(d->loaded.bytes / d->loaded.row_bytes)
                                                    : (tile->lrt - tile->ult) / 4 + 1;
    }
    /* A texture set to repeat every 2^n texels is only that big. */
    if (!tile->clamp_s && tile->mask_s && (1 << tile->mask_s) < *w)
        *w = 1 << tile->mask_s;
    if (!tile->clamp_t && tile->mask_t && (1 << tile->mask_t) < *h)
        *h = 1 << tile->mask_t;
    *w = *w < 1 ? 1 : *w > 1024 ? 1024 : *w;
    *h = *h < 1 ? 1 : *h > 1024 ? 1024 : *h;
}

void gfx_texture_pixels(const DrawState *d, int w, int h, uint8_t *rgba) {
    for (int t = 0; t < h; t++)
        for (int s = 0; s < w; s++, rgba += 4) {
            int texel[4];
            fetch_raw(d, s, t, texel);
            rgba[0] = (uint8_t)texel[0], rgba[1] = (uint8_t)texel[1];
            rgba[2] = (uint8_t)texel[2], rgba[3] = (uint8_t)texel[3];
        }
}

uint32_t gfx_texture_checksum(const DrawState *d, int w, int h) {
    uint32_t sum = 2166136261u;
    uint32_t bytes = (uint32_t)h * d->loaded.row_bytes;
    (void)w;
    for (uint32_t i = 0; i < bytes; i += 4)
        sum = (sum ^ rd32(d->loaded.address + i)) * 16777619u;
    if (d->tile.format == FMT_CI) /* colour-indexed: the palette matters too */
        for (uint32_t i = 0; i < 512; i += 4)
            sum = (sum ^ rd32(d->palette_address + i)) * 16777619u;
    return sum;
}

/* ---- Colour combiner ----------------------------------------------------------
 * The N64 has no shaders. Instead every pixel's colour is (A - B) * C + D,
 * where the game picks what A, B, C and D are from a menu: the texture, the
 * vertex colour ("shade"), a couple of constant colours, one, zero. The same
 * formula with its own choices produces the alpha (opacity). */

/* One of these per CPU core: the values for the pixel being worked on. */
typedef struct {
    int texel[4], shade[4], combined[4];
    /* alphas repeated three times, for when a colour slot asks for
     * "texture alpha" and the like */
    int texel_alpha[3], shade_alpha[3], combined_alpha[3], prim_alpha[3], env_alpha[3];
    /* Decoding the menu choices for every pixel would be slow, so for each
     * shape they are resolved once into "where to read it from". */
    const int *color[2][4], *alpha[2][4];
} Pixel;

static const int ZERO[3] = {0, 0, 0}, ONE[3] = {255, 255, 255};

static const int *color_source(const DrawState *d, const Pixel *p, int which, int slot) {
    /* slot: 0 = A, 1 = B, 2 = C, 3 = D; each has a slightly different menu */
    switch (which) {
    case 0: return p->combined;
    case 1: case 2: return p->texel;
    case 3: return d->prim;
    case 4: return p->shade;
    case 5: return d->env;
    }
    if (slot == 0 || slot == 3)
        return which == 6 ? ONE : ZERO;
    if (slot == 2) {
        switch (which) {
        case 7: return p->combined_alpha;
        case 8: case 9: return p->texel_alpha;
        case 10: return p->prim_alpha;
        case 11: return p->shade_alpha;
        case 12: return p->env_alpha;
        }
    }
    return ZERO;
}

static const int *alpha_source(const DrawState *d, const Pixel *p, int which, int slot) {
    switch (which) {
    case 0: return slot == 2 ? ZERO : &p->combined[3];
    case 1: case 2: return &p->texel[3];
    case 3: return &d->prim[3];
    case 4: return &p->shade[3];
    case 5: return &d->env[3];
    case 6: return slot == 2 ? ZERO : ONE;
    }
    return ZERO;
}

static void prepare_pixel(const DrawState *d, Pixel *p) {
    memset(p, 0, sizeof *p);
    for (int cycle = 0; cycle < 2; cycle++)
        for (int slot = 0; slot < 4; slot++) {
            p->color[cycle][slot] = color_source(d, p, d->cc[cycle][slot], slot);
            p->alpha[cycle][slot] = alpha_source(d, p, d->ac[cycle][slot], slot);
        }
    for (int i = 0; i < 3; i++)
        p->prim_alpha[i] = d->prim[3], p->env_alpha[i] = d->env[3];
}

static inline int clamp255(int x) { return x < 0 ? 0 : x > 255 ? 255 : x; }

static inline void combine(const DrawState *d, Pixel *p, int out[4]) {
    for (int i = 0; i < 3; i++) {
        p->texel_alpha[i] = p->texel[3], p->shade_alpha[i] = p->shade[3];
        p->combined[i] = p->combined_alpha[i] = 0;
    }
    p->combined[3] = 0;
    out[0] = out[1] = out[2] = out[3] = 0;
    for (int cycle = d->first_cycle; cycle < 2; cycle++) {
        const int *a = p->color[cycle][0], *b = p->color[cycle][1];
        const int *c = p->color[cycle][2], *e = p->color[cycle][3];
        for (int ch = 0; ch < 3; ch++)
            out[ch] = clamp255((((a[ch] - b[ch]) * (c[ch] + (c[ch] >> 7))) >> 8) + e[ch]);
        int ca = *p->alpha[cycle][2];
        out[3] = clamp255((((*p->alpha[cycle][0] - *p->alpha[cycle][1]) * (ca + (ca >> 7))) >> 8) + *p->alpha[cycle][3]);
        for (int i = 0; i < 3; i++)
            p->combined[i] = out[i], p->combined_alpha[i] = out[3];
        p->combined[3] = out[3];
    }
}

/* ---- Putting a pixel on screen -------------------------------------------- */

static inline void shade_pixel(const DrawState *d, size_t index, float z, Pixel *p, float u, float v, int fog) {
    if (d->use_texture)
        sample_texture(d, u, v, p->texel);
    int c[4];
    combine(d, p, c);

    if (d->cutout) { /* textures with holes, like fences: all or nothing */
        if (c[3] < 77)
            return;
        c[3] = 255;
    }
    if (d->use_fog) { /* pull the colour toward the fog colour with distance */
        fog += fog >> 7;
        for (int i = 0; i < 3; i++)
            c[i] = (c[i] * (256 - fog) + d->fog[i] * fog) >> 8;
    }
    if (d->use_alpha) { /* see-through: mix with what is already there */
        uint32_t old = color_buffer[index];
        int a = c[3] + (c[3] >> 7);
        c[0] = ((int)((old >> 16) & 255) * (256 - a) + c[0] * a) >> 8;
        c[1] = ((int)((old >> 8) & 255) * (256 - a) + c[1] * a) >> 8;
        c[2] = ((int)(old & 255) * (256 - a) + c[2] * a) >> 8;
    }
    color_buffer[index] = 0xFF000000u | (uint32_t)c[0] << 16 | (uint32_t)c[1] << 8 | (uint32_t)c[2];
    if (d->depth_write)
        depth_buffer[index] = z;
}

/* ---- Triangles ----------------------------------------------------------------
 * For every pixel in the triangle's bounding box, work out whether it is
 * inside and how close it is to each corner (three weights that add up to
 * one). Those weights blend the corners' colour, depth and texture
 * position. Texture positions are blended divided by distance (w) so that
 * textures recede correctly into the distance.
 *
 * strip_top, strip_bottom: the rows this CPU core is responsible for. */

static void rasterize(const Shape *shape, Pixel *p, int strip_top, int strip_bottom) {
    const DrawState *d = &shape->state;
    const ScreenVertex *v0 = &shape->v[0], *v1 = &shape->v[1], *v2 = &shape->v[2];
    float area = (v1->x - v0->x) * (v2->y - v0->y) - (v1->y - v0->y) * (v2->x - v0->x);
    if (area == 0)
        return;
    int min_x = (int)floorf(fminf(v0->x, fminf(v1->x, v2->x)));
    int max_x = (int)ceilf(fmaxf(v0->x, fmaxf(v1->x, v2->x)));
    int min_y = (int)floorf(fminf(v0->y, fminf(v1->y, v2->y)));
    int max_y = (int)ceilf(fmaxf(v0->y, fmaxf(v1->y, v2->y)));
    if (min_x < d->scissor[0]) min_x = d->scissor[0];
    if (min_y < d->scissor[1]) min_y = d->scissor[1];
    if (max_x > d->scissor[2]) max_x = d->scissor[2];
    if (max_y > d->scissor[3]) max_y = d->scissor[3];
    /* Whatever the game asked for, never outside the picture itself. */
    if (min_x < 0) min_x = 0;
    if (min_y < 0) min_y = 0;
    if (max_x > width) max_x = width;
    if (max_y > height) max_y = height;
    if (min_y < strip_top) min_y = strip_top;
    if (max_y > strip_bottom) max_y = strip_bottom;
    if (min_y >= max_y || min_x >= max_x)
        return;
    prepare_pixel(d, p);

    /* Each weight changes by a fixed amount per pixel moved right, so along
     * a row we only need additions. (Set up in double precision: corners
     * can be far off screen, and small errors here show up as flicker.) */
    double inverse_area = 1.0 / ((double)(v1->x - v0->x) * (v2->y - v0->y) - (double)(v1->y - v0->y) * (v2->x - v0->x));
    float step0 = (float)((v1->y - v2->y) * inverse_area), step1 = (float)((v2->y - v0->y) * inverse_area);
    float down0 = (float)((v2->x - v1->x) * inverse_area), down1 = (float)((v0->x - v2->x) * inverse_area);

    /* A "decal" (a shadow, a painted marking) lies exactly on a surface
     * drawn earlier, so its depth should equal what is already there. It
     * never does exactly, and the mismatch grows with how fast depth changes
     * from pixel to pixel, so the tolerance is scaled by that slope. */
    float bias = 0;
    if (d->decal) {
        float slope_x = step0 * v0->z + step1 * v1->z - (step0 + step1) * v2->z;
        float slope_y = down0 * v0->z + down1 * v1->z - (down0 + down1) * v2->z;
        bias = 4 * (fabsf(slope_x) + fabsf(slope_y)) + 2e-5f;
    }

    for (int y = min_y; y < max_y; y++) {
        double py = (double)y + 0.5, px = (double)min_x + 0.5;
        /* Added to thousands of times along a wide row, so kept in double
         * precision: the rounding otherwise builds up into visible flicker. */
        double a0 = ((v1->x - px) * (v2->y - py) - (v1->y - py) * (v2->x - px)) * inverse_area;
        double a1 = ((v2->x - px) * (v0->y - py) - (v2->y - py) * (v0->x - px)) * inverse_area;
        double astep0 = (v1->y - v2->y) * inverse_area, astep1 = (v2->y - v0->y) * inverse_area;
        size_t index = (size_t)y * (size_t)width + (size_t)min_x;
        for (int x = min_x; x < max_x; x++, index++, a0 += astep0, a1 += astep1) {
            float w0 = (float)a0, w1 = (float)a1;
            float w2 = (float)(1.0 - a0 - a1);
            if (w0 < 0 || w1 < 0 || w2 < 0)
                continue;
            float z = w0 * v0->z + w1 * v1->z + w2 * v2->z;
            if (z < 0) z = 0;
            if (z > 1) z = 1;
            /* Hidden behind something already drawn? Then skip the rest. */
            if (d->depth_test && (d->decal ? z > depth_buffer[index] + bias : z >= depth_buffer[index]))
                continue;

            float q0 = w0 * v0->q, q1 = w1 * v1->q, q2 = w2 * v2->q;
            float inverse_q = 1.0f / (q0 + q1 + q2);
            q0 *= inverse_q, q1 *= inverse_q, q2 *= inverse_q;

            p->shade[0] = (int)(q0 * v0->r + q1 * v1->r + q2 * v2->r);
            p->shade[1] = (int)(q0 * v0->g + q1 * v1->g + q2 * v2->g);
            p->shade[2] = (int)(q0 * v0->b + q1 * v1->b + q2 * v2->b);
            /* With fog on, the vertex alpha slot carries the fog amount
             * instead, and the combiner sees "fully opaque". */
            p->shade[3] = d->use_fog ? 255 : (int)(q0 * v0->a + q1 * v1->a + q2 * v2->a);
            /* Vertex texture positions count texel centres as whole numbers;
             * sample_texture counts texel edges. Half a texel apart. */
            float u = q0 * v0->u + q1 * v1->u + q2 * v2->u + (d->bilinear ? 0.5f : 0);
            float v = q0 * v0->v + q1 * v1->v + q2 * v2->v + (d->bilinear ? 0.5f : 0);
            int fog = d->use_fog ? (int)(q0 * v0->fog + q1 * v1->fog + q2 * v2->fog) : 0;
            shade_pixel(d, index, z, p, u, v, fog);
        }
    }
}

static void draw_rectangle(const Shape *shape, Pixel *p, int strip_top, int strip_bottom) {
    const DrawState *d = &shape->state;
    int x0 = shape->x0, y0 = shape->y0, x1 = shape->x1, y1 = shape->y1;
    if (x0 < d->scissor[0]) x0 = d->scissor[0];
    if (y0 < d->scissor[1]) y0 = d->scissor[1];
    if (x1 > d->scissor[2]) x1 = d->scissor[2];
    if (y1 > d->scissor[3]) y1 = d->scissor[3];
    /* Whatever the game asked for, never outside the picture itself. */
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 > width) x1 = width;
    if (y1 > height) y1 = height;
    if (y0 < strip_top) y0 = strip_top;
    if (y1 > strip_bottom) y1 = strip_bottom;
    if (y0 >= y1 || x0 >= x1)
        return;
    if (shape->kind == FILL || shape->kind == DEPTH_CLEAR) { /* the common, simple cases */
        for (int y = y0; y < y1; y++)
            for (size_t i = (size_t)y * (size_t)width + (size_t)x0, end = i + (size_t)(x1 - x0); i < end; i++) {
                if (shape->kind == FILL)
                    color_buffer[i] = shape->color;
                else
                    depth_buffer[i] = 1.0f;
            }
        return;
    }
    prepare_pixel(d, p);
    /* "Shade" is the light worked out at a triangle's corners. A rectangle
     * has no corners with light on them, and the console mixes in nothing
     * (zero) where a game asks for shade there. We used to give textured
     * rectangles full white instead, and Duke Nukem 64, which draws its
     * weapon, HUD and menus as "(env - shade) * texture + shade", came out
     * plain white. */
    for (int i = 0; i < 4; i++)
        p->shade[i] = 0;

    for (int y = y0; y < y1; y++) {
        size_t index = (size_t)y * (size_t)width + (size_t)x0;
        for (int x = x0; x < x1; x++, index++) {
            float u = 0, v = 0;
            if (shape->kind == TEXTURE_RECTANGLE || shape->kind == COPY_RECTANGLE) {
                float across = ((float)x + 0.5f) / (float)scale - shape->left;
                float down = ((float)y + 0.5f) / (float)scale - shape->top;
                u = shape->s + (shape->flip ? down : across) * shape->ds;
                v = shape->t + (shape->flip ? across : down) * shape->dt;
            }
            switch (shape->kind) {
            case COPY_RECTANGLE: { /* bypasses the combiner: the texel goes straight in */
                int texel[4];
                sample_texture(d, u, v, texel);
                if (texel[3] >= 128)
                    color_buffer[index] = 0xFF000000u | (uint32_t)texel[0] << 16 | (uint32_t)texel[1] << 8 | (uint32_t)texel[2];
                break;
            }
            default: shade_pixel(d, index, 0, p, u, v, 0);
            }
        }
    }
}

/* ---- Drawing the recorded shapes on several cores ------------------------------ */

#define MAX_WORKERS 16
#define STRIP_ROWS 16
static int worker_count = 1; /* including the main thread */
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t work_ready = PTHREAD_COND_INITIALIZER, work_done = PTHREAD_COND_INITIALIZER;
static long generation;
static int workers_busy;
static atomic_int next_strip;

/* Some parts of the screen take far longer than others, so the strips are
 * thin and each core keeps taking the next undrawn one until none are left. */
static void draw_strips(void) {
    Pixel pixel;
    for (;;) {
        int top = atomic_fetch_add(&next_strip, 1) * STRIP_ROWS;
        if (top >= height)
            return;
        int bottom = top + STRIP_ROWS > height ? height : top + STRIP_ROWS;
        for (int i = 0; i < shape_count; i++) {
            if (shapes[i].kind == TRIANGLE)
                rasterize(&shapes[i], &pixel, top, bottom);
            else
                draw_rectangle(&shapes[i], &pixel, top, bottom);
        }
    }
}

static void *worker_main(void *argument) {
    (void)argument;
    long seen = 0;
    for (;;) {
        pthread_mutex_lock(&lock);
        while (generation == seen)
            pthread_cond_wait(&work_ready, &lock);
        seen = generation;
        pthread_mutex_unlock(&lock);

        draw_strips();

        pthread_mutex_lock(&lock);
        if (--workers_busy == 0)
            pthread_cond_signal(&work_done);
        pthread_mutex_unlock(&lock);
    }
    return NULL;
}

static const GfxBackend *backend; /* NULL: draw on the CPU, below */

void gfx_set_backend(const GfxBackend *chosen) {
    backend = chosen;
    if (backend && width)
        backend->resize(width, height);
}

static void draw_all_shapes(void) {
    if (getenv("SHOW_SCISSORS") && !measuring && gfx_frame_number == atol(getenv("SHOW_SCISSORS"))) { /* for testing */
        int last[4] = {-1, -1, -1, -1}, run = 0;
        for (int i = 0; i <= shape_count; i++) {
            const Shape *shape = &shapes[i < shape_count ? i : 0];
            if (i == shape_count || memcmp(last, shape->state.scissor, sizeof last)) {
                if (run)
                    fprintf(stderr, "%5d shapes with scissor %d %d %d %d\n", run, last[0], last[1], last[2], last[3]);
                memcpy(last, shape->state.scissor, sizeof last), run = 0;
            }
            run++;
        }
    }
    if (shape_count == 0)
        return;
    if (backend) {
        backend->draw(shapes, shape_count, width, height, scale);
        shape_count = 0;
        return;
    }
    pthread_mutex_lock(&lock);
    atomic_store(&next_strip, 0);
    generation++;
    workers_busy = worker_count - 1;
    pthread_cond_broadcast(&work_ready);
    pthread_mutex_unlock(&lock);

    draw_strips(); /* the main thread joins in */

    pthread_mutex_lock(&lock);
    while (workers_busy > 0)
        pthread_cond_wait(&work_done, &lock);
    pthread_mutex_unlock(&lock);
    shape_count = 0;
}

/* ---- Recording shapes ---------------------------------------------------------- */

static void to_screen(const Vertex *v, ScreenVertex *s) {
    float q = 1.0f / v->w;
    float x = (rsp.viewport_translate[0] + v->x * q * rsp.viewport_scale[0]) / hires_x;
    /* A backdrop is stretched to fill the wider picture; everything else
     * keeps its shape and is shifted to the middle. */
    x = v->backdrop ? x * wide_units / SCREEN_W : x + wide_offset;
    s->x = x * (float)scale;
    s->y = (rsp.viewport_translate[1] - v->y * q * rsp.viewport_scale[1]) / hires_y * (float)scale;
    s->z = v->z * q * 0.5f + 0.5f;
    /* The game can ask for everything it draws to be at one depth of its
     * choosing instead of each corner's own: that is how parts of a HUD are
     * kept in front of the scene. */
    if (rdp.other_mode_l & 4)
        s->z = rdp.prim_depth;
    if (no_near && s->z < 0)
        s->z = 0; /* nearer than the near plane: as near as can be */
    s->q = q;
    s->u = v->u, s->v = v->v, s->r = v->r, s->g = v->g, s->b = v->b, s->a = v->a, s->fog = v->fog;
}

/* How far a corner is on the wanted side of one of the planes a triangle is
 * cut with (see triangle). */
static float clip_distance(const Vertex *v, int plane) {
    const float far_out = 16; /* times the width of the view */
    if (!no_near)
        return v->z + v->w; /* the near plane */
    switch (plane) {
    case 0: return v->w - 0.001f; /* in front of the camera */
    case 1: return far_out * v->w - v->x;
    case 2: return far_out * v->w + v->x;
    case 3: return far_out * v->w - v->y;
    default: return far_out * v->w + v->y;
    }
}

/* Triangle commands name their corners by position in the vertex list,
 * multiplied by 10 in Fast3D, by 2 in its successors F3DEX and F3DEX2, and
 * by 5 in Wave Race 64's own variant. */
static void triangle(uint32_t a, uint32_t b, uint32_t c) {
    uint32_t unit = dialect == GFX_FAST3D ? 10 : dialect == GFX_F3DWAVE ? 5 : 2;
    const Vertex *v[3] = {
        &rsp.vertices[(a & 255) / unit & 63],
        &rsp.vertices[(b & 255) / unit & 63],
        &rsp.vertices[(c & 255) / unit & 63],
    };
    if (measuring || (v[0]->clip & v[1]->clip & v[2]->clip))
        return; /* all three corners are off the same side of the screen */

    /* Skip triangles facing away from the camera, if asked to. */
    if (rsp.geometry_mode & (G_CULL_FRONT | G_CULL_BACK)) {
        /* Which way round the three corners go on screen says which side
         * we are looking at. The obvious way to find out is to work out
         * where each corner lands on screen and compare, but that goes
         * wrong when a corner is behind the camera, where "on screen" has
         * no meaning; big pieces of floor seen from above often have one
         * there, and they would vanish and reappear. This sum gives the
         * same answer without the division that causes the trouble. */
        float cross = -(v[0]->x * (v[1]->y * v[2]->w - v[2]->y * v[1]->w) -
                        v[0]->y * (v[1]->x * v[2]->w - v[2]->x * v[1]->w) +
                        v[0]->w * (v[1]->x * v[2]->y - v[2]->x * v[1]->y));
        uint32_t cull = rsp.geometry_mode & (G_CULL_FRONT | G_CULL_BACK);
        if (cull == (G_CULL_FRONT | G_CULL_BACK) || (cull == G_CULL_FRONT && cross <= 0) ||
            (cull == G_CULL_BACK && cross >= 0))
            return;
    }

    /* A triangle that passes behind the camera must be cut off at the
     * "near plane" first, or the maths below would divide by zero or worse.
     * Cutting a triangle with a plane leaves three or four corners. */
    /* (Chip programs with "no near" keep what is closer than the near plane.
     * For those we cut only what is behind the camera, and then what is far
     * off to the sides, above or below: a corner almost level with the
     * camera lands so far off screen that the numbers stop making sense.) */
    Vertex polygon[10], cut[10];
    int count = 3;
    for (int i = 0; i < 3; i++)
        polygon[i] = *v[i];
    for (int plane = 0; plane < (no_near ? 5 : 1) && count >= 3; plane++) {
        int made = 0;
        for (int i = 0; i < count; i++) {
            const Vertex *a = &polygon[i], *b = &polygon[(i + 1) % count];
            float da = clip_distance(a, plane), db = clip_distance(b, plane); /* distance in front of the plane */
            if (da >= 0)
                cut[made++] = *a;
            if ((da >= 0) != (db >= 0)) {
                float t = da / (da - db);
                Vertex *n = &cut[made++];
#define LERP(field) n->field = a->field + (b->field - a->field) * t
                LERP(x); LERP(y); LERP(z); LERP(w); LERP(u); LERP(v);
                LERP(r); LERP(g); LERP(b); LERP(a); LERP(fog);
#undef LERP
                n->backdrop = a->backdrop;
            }
        }
        memcpy(polygon, cut, (size_t)made * sizeof *cut);
        count = made;
    }
    if (count < 3)
        return;

    ScreenVertex s[10];
    for (int i = 0; i < count; i++) {
        if (polygon[i].w <= 1e-6f)
            return;
        to_screen(&polygon[i], &s[i]);
    }
    for (int i = 1; i + 1 < count; i++) {
        Shape *shape = new_shape(TRIANGLE);
        capture_state(&shape->state, rsp.texture_tile, 1);
        if (rsp.clip_ratio == 1 && rsp.viewport_scale[0] * 2 / hires_x < SCREEN_W - 2) {
            /* A view smaller than the screen that nothing may leave: keep
             * this shape inside it. (A full-screen view is left alone, so
             * that a widescreen picture can show more at the sides.) */
            int box[4] = {(int)(((rsp.viewport_translate[0] - fabsf(rsp.viewport_scale[0])) / hires_x + wide_offset) * (float)scale),
                          (int)((rsp.viewport_translate[1] - fabsf(rsp.viewport_scale[1])) / hires_y * (float)scale),
                          (int)(((rsp.viewport_translate[0] + fabsf(rsp.viewport_scale[0])) / hires_x + wide_offset) * (float)scale),
                          (int)((rsp.viewport_translate[1] + fabsf(rsp.viewport_scale[1])) / hires_y * (float)scale)};
            int *scissor = shape->state.scissor;
            if (scissor[0] < box[0]) scissor[0] = box[0];
            if (scissor[1] < box[1]) scissor[1] = box[1];
            if (scissor[2] > box[2]) scissor[2] = box[2];
            if (scissor[3] > box[3]) scissor[3] = box[3];
        }
        /* for testing: flat (menu and HUD) triangles with SHOW_RECTANGLES, every triangle with SHOW_TRIANGLES */
        if (getenv("SHOW_TRIANGLES") || (getenv("SHOW_RECTANGLES") && !is_perspective(rsp.projection) && shape->state.use_texture))
            fprintf(stderr, "flat tri u %.1f %.1f %.1f v %.1f %.1f %.1f x %.0f %.0f %.0f tile %d..%d,%d..%d clamp %d%d mask %d%d size %d fmt %d line %u scale %.3f q %.3f %.3f %.3f y %.0f %.0f %.0f from %06X rows %d tmem %d cyc %d cc %d %d %d %d prim %d %d %d %d ac %d %d %d %d ac0 %d %d %d %d modes %06X %08X env %d shade %.0f %.0f %.0f %.0f cc0 %d %d %d %d lodfrac %d\n",
                    s[0].u, s[i].u, s[i + 1].u, s[0].v, s[i].v, s[i + 1].v, s[0].x, s[i].x, s[i + 1].x,
                    shape->state.tile.uls / 4, shape->state.tile.lrs / 4, shape->state.tile.ult / 4, shape->state.tile.lrt / 4,
                    shape->state.tile.clamp_s, shape->state.tile.clamp_t, shape->state.tile.mask_s, shape->state.tile.mask_t,
                    shape->state.tile.size, shape->state.tile.format, (unsigned)shape->state.loaded.row_bytes, rsp.texture_scale_s, s[0].q, s[i].q, s[i + 1].q,
                    s[0].y, s[i].y, s[i + 1].y, shape->state.loaded.source, shape->state.loaded.fixed_rows, shape->state.tile.tmem,
                    shape->state.first_cycle, shape->state.cc[1][0], shape->state.cc[1][1], shape->state.cc[1][2],
                    shape->state.cc[1][3], shape->state.prim[0], shape->state.prim[1], shape->state.prim[2], shape->state.prim[3],
                    shape->state.ac[1][0], shape->state.ac[1][1], shape->state.ac[1][2], shape->state.ac[1][3],
                    shape->state.ac[0][0], shape->state.ac[0][1], shape->state.ac[0][2], shape->state.ac[0][3],
                    rdp.other_mode_h, rdp.other_mode_l, shape->state.env[3], s[0].r, s[0].g, s[0].b, s[0].a,
                    shape->state.cc[0][0], shape->state.cc[0][1], shape->state.cc[0][2], shape->state.cc[0][3], rdp.prim_lod_fraction);
        /* The rasteriser wants a consistent winding; flip if needed. */
        float area = (s[i].x - s[0].x) * (s[i + 1].y - s[0].y) - (s[i].y - s[0].y) * (s[i + 1].x - s[0].x);
        shape->v[0] = s[0];
        shape->v[1] = area > 0 ? s[i] : s[i + 1];
        shape->v[2] = area > 0 ? s[i + 1] : s[i];
    }
    gfx_triangle_count++;
}

/* Where a horizontal position (in quarter units of the game's 320) lands in
 * our picture. Anything touching the game's screen edge is taken to mean
 * "the edge", so full-screen fills and fades cover the wider picture too. */
static int wide_x(int quarter_units) {
    if (quarter_units <= 0)
        return 0;
    if ((float)quarter_units >= SCREEN_W * 4 * hires_x)
        return width;
    return (int)(((float)quarter_units / (4 * hires_x) + wide_offset) * (float)scale);
}

/* Coordinates arrive as 10.2 fixed point (quarter pixels). */
static void command_fill_rectangle(uint32_t w0, uint32_t w1) {
    int right = (int)((w0 >> 12) & 0xFFF), bottom = (int)(w0 & 0xFFF);
    int left = (int)((w1 >> 12) & 0xFFF), top = (int)(w1 & 0xFFF);
    int fill = CYCLE_TYPE == CYCLE_FILL;
    if (fill || CYCLE_TYPE == CYCLE_COPY)
        right += 4, bottom += 4; /* these modes include the last row and column */
    /* Some games wipe the screen with a box that stops one column short of
     * the right edge (Mario Kart 64's results screen asks for 0..319 in a
     * mode that leaves the last column out). On a TV nobody could see that
     * column. In widescreen it would leave a whole strip of the old picture
     * down the right side, so a box from the left edge to within one column
     * of the right edge is taken to mean "the whole width". */
    if (left <= 0 && (float)right >= (SCREEN_W - 1) * 4 * hires_x)
        right = (int)(SCREEN_W * 4 * hires_x);

    if (measuring)
        return;
    gfx_rectangle_count++;
    if (getenv("SHOW_RECTANGLES")) /* for testing */
        fprintf(stderr, "fill x %d..%d y %d..%d cycle %d colour %08X image %06X depth %06X scissor %d %d %d %d cc %d %d %d %d ac %d %d %d %d prim %d %d %d %d env %d %d %d %d modes %06X %08X\n", left / 4, right / 4,
                top / 4, bottom / 4, (int)CYCLE_TYPE, rdp.fill_color, rdp.color_image, rdp.depth_image, rdp.scissor[0],
                rdp.scissor[1], rdp.scissor[2], rdp.scissor[3], rdp.cc[1][0], rdp.cc[1][1], rdp.cc[1][2], rdp.cc[1][3],
                rdp.ac[1][0], rdp.ac[1][1], rdp.ac[1][2], rdp.ac[1][3], rdp.prim[0], rdp.prim[1], rdp.prim[2], rdp.prim[3],
                rdp.env[0], rdp.env[1], rdp.env[2], rdp.env[3], rdp.other_mode_h, rdp.other_mode_l);
    /* The game "draws" into its depth buffer to reset it each frame. */
    Shape *shape = new_shape(rdp.color_image == rdp.depth_image ? DEPTH_CLEAR : fill ? FILL : COMBINED_RECTANGLE);
    capture_state(&shape->state, 0, 0);
    shape->state.use_texture = 0, shape->state.use_fog = 0;
    shape->x0 = wide_x(left), shape->y0 = unit_y(top);
    shape->x1 = wide_x(right), shape->y1 = unit_y(bottom);
    int c[4];
    rgba16(rdp.fill_color & 0xFFFF, c);
    shape->color = 0xFF000000u | (uint32_t)c[0] << 16 | (uint32_t)c[1] << 8 | (uint32_t)c[2];
}

/* A rectangle with a texture stretched over it: used for text and menus. */
static void command_texture_rectangle(uint32_t w0, uint32_t w1, uint32_t st, uint32_t steps, int flip) {
    int right = (int)((w0 >> 12) & 0xFFF), bottom = (int)(w0 & 0xFFF);
    int left = (int)((w1 >> 12) & 0xFFF), top = (int)(w1 & 0xFFF);
    int copy = CYCLE_TYPE == CYCLE_COPY;
    if (measuring)
        return;
    gfx_rectangle_count++;
    Shape *shape = new_shape(copy ? COPY_RECTANGLE : TEXTURE_RECTANGLE);
    capture_state(&shape->state, (int)((w1 >> 24) & 7), 0);
    if (find_loaded(shape->state.tile.tmem) == NULL) {
        if (getenv("SHOW_RECTANGLES")) /* for testing */
            fprintf(stderr, "rect x %d..%d y %d..%d left out: nothing loaded at %d in texture memory\n", left / 4, right / 4,
                    top / 4, bottom / 4, shape->state.tile.tmem);
        shape_count--; /* nothing to draw it with */
        return;
    }
    shape->state.use_texture = 1, shape->state.use_fog = 0;
    shape->s = (float)(int16_t)(st >> 16) / 32.0f, shape->t = (float)(int16_t)st / 32.0f;
    shape->ds = (float)(int16_t)(steps >> 16) / 1024.0f, shape->dt = (float)(int16_t)steps / 1024.0f;
    if (copy) {
        shape->ds /= 4; /* copy mode steps four texels at a time */
        right += 4, bottom += 4;
    }
    /* Flat art drawn dot for dot (text, HUD numbers, portraits made of
     * several pieces side by side) is not smoothed. Smoothing blends each
     * dot with its neighbours, which at the edge of a piece means dots that
     * are not part of the picture: on the console's small blurry screen
     * that did not show, but enlarged it smears letters into each other
     * and draws thin lines where the pieces meet. */
    if (fabsf(shape->ds) == 1 && fabsf(shape->dt) == 1)
        shape->state.bilinear = 0;
    if (getenv("SHOW_RECTANGLES")) /* for testing */
        fprintf(stderr, "rect x %d..%d y %d..%d s %.2f t %.2f ds %.4f dt %.4f tile %d..%d clamp %d mask %d size %d fmt %d line %u from %06X cycle %d cc %d %d %d %d / %d %d %d %d prim %d %d %d %d env %d %d %d %d modes %06X %08X ac %d %d %d %d / %d %d %d %d\n",
                left / 4, right / 4, top / 4, bottom / 4, shape->s, shape->t, shape->ds, shape->dt, shape->state.tile.uls / 4,
                shape->state.tile.lrs / 4, shape->state.tile.clamp_s, shape->state.tile.mask_s, shape->state.tile.size,
                shape->state.tile.format, (unsigned)shape->state.loaded.row_bytes, shape->state.loaded.source, (int)CYCLE_TYPE,
                rdp.cc[0][0], rdp.cc[0][1], rdp.cc[0][2], rdp.cc[0][3], rdp.cc[1][0], rdp.cc[1][1], rdp.cc[1][2], rdp.cc[1][3],
                rdp.prim[0], rdp.prim[1], rdp.prim[2], rdp.prim[3], rdp.env[0], rdp.env[1], rdp.env[2], rdp.env[3],
                rdp.other_mode_h, rdp.other_mode_l, rdp.ac[0][0], rdp.ac[0][1], rdp.ac[0][2], rdp.ac[0][3], rdp.ac[1][0],
                rdp.ac[1][1], rdp.ac[1][2], rdp.ac[1][3]);
    /* (left, top and the steps are kept in units of a 320-wide screen) */
    shape->left = (float)left / (4 * hires_x) + wide_offset, shape->top = (float)top / (4 * hires_y), shape->flip = flip;
    shape->ds *= flip ? hires_y : hires_x, shape->dt *= flip ? hires_x : hires_y; /* (flipped: ds goes downwards) */
    shape->x0 = (int)(shape->left * (float)scale), shape->y0 = unit_y(top);
    shape->x1 = shape->x0 + unit_x(right - left), shape->y1 = unit_y(bottom);
}

/* ---- Texture set-up commands ------------------------------------------------- */

/* fixed_rows: the row length is that of the source picture and must not be
 * changed by later tile settings (true when a rectangle was cut out of a
 * larger picture, rather than a whole texture loaded as one strip). */
static void remember_loaded(int tmem, uint32_t address, uint32_t row_bytes, int fixed_rows, uint32_t bytes) {
    Loaded *slot = NULL;
    for (int i = 0; i < 8; i++)
        if (rdp.loaded[i].address && rdp.loaded[i].tmem == tmem)
            slot = &rdp.loaded[i];
    if (!slot)
        slot = &rdp.loaded[rdp.next_loaded++ & 7];
    slot->tmem = tmem, slot->address = address, slot->row_bytes = row_bytes, slot->fixed_rows = fixed_rows;
    slot->bytes = bytes;
    if (!(address & COPY_FLAG))
        slot->source = address;
}

/* How many bytes one row of a tile takes, from its "line" setting (which
 * counts 8-byte units). */
static uint32_t tile_row_bytes(const Tile *tile) {
    return (uint32_t)tile->line * 8 * (tile->size == 3 ? 2 : 1);
}

static void command_set_tile(uint32_t w0, uint32_t w1) {
    Tile *tile = &rdp.tiles[(w1 >> 24) & 7];
    tile->format = (int)((w0 >> 21) & 7), tile->size = (int)((w0 >> 19) & 3);
    tile->line = (int)((w0 >> 9) & 0x1FF), tile->tmem = (int)(w0 & 0x1FF);
    tile->palette = (int)((w1 >> 20) & 15);
    tile->clamp_t = (int)((w1 >> 19) & 1), tile->mirror_t = (int)((w1 >> 18) & 1);
    tile->mask_t = (int)((w1 >> 14) & 15);
    tile->clamp_s = (int)((w1 >> 9) & 1), tile->mirror_s = (int)((w1 >> 8) & 1);
    tile->mask_s = (int)((w1 >> 4) & 15);
    /* A tile set up after its texture was loaded reuses that data with its
     * own row length. */
    const Loaded *loaded = find_loaded(tile->tmem);
    if (loaded && tile->line && !loaded->fixed_rows)
        remember_loaded(tile->tmem, loaded->address, tile_row_bytes(tile), 0, loaded->bytes);
}

static void command_load_block(uint32_t w1) {
    const Tile *tile = &rdp.tiles[(w1 >> 24) & 7];
    /* The texture is loaded as one long strip; the tile that is later used
     * for drawing says how long each row really is. */
    const Tile *render = &rdp.tiles[0];
    uint32_t row = tile_row_bytes(render->tmem == tile->tmem && render->line ? render : tile);
    /* the command gives the number of texels loaded, less one */
    uint32_t bytes = (((w1 >> 12) & 0xFFF) + 1) * (4u << tile->size) / 8;
    remember_loaded(tile->tmem, rdp.texture_image, row, 0, bytes);
    /* (remembered first under its real address, which is noted as where it
     * came from; then pointed at the copy) */
    Loaded *loaded = (Loaded *)find_loaded(tile->tmem);
    if (loaded && !measuring)
        loaded->address = keep_copy(rdp.texture_image, bytes);
    if (loaded && !measuring && (loaded->address & COPY_FLAG))
        loaded->step_plus_1 = (int)(w1 & 0xFFF) + 1; /* (see turn_odd_rows) */
    else if (loaded)
        loaded->step_plus_1 = 0;
}

static void command_load_tile(uint32_t w0, uint32_t w1) {
    const Tile *tile = &rdp.tiles[(w1 >> 24) & 7];
    uint32_t bits = 4u << rdp.texture_size;
    uint32_t row = rdp.texture_width * bits / 8;
    uint32_t start = rdp.texture_image + ((w0 & 0xFFF) / 4) * row + (((w0 >> 12) & 0xFFF) / 4) * bits / 8;
    remember_loaded(tile->tmem, start, row, 1, 0);
    /* The rows from the first to the last asked for, whole. */
    uint32_t rows = ((w1 & 0xFFF) / 4) - ((w0 & 0xFFF) / 4) + 1;
    Loaded *loaded = (Loaded *)find_loaded(tile->tmem);
    if (loaded)
        loaded->step_plus_1 = 0;
    if (loaded && !measuring && rows < 2048)
        loaded->address = keep_copy(start, rows * row);
}

/* ---- The command loop -------------------------------------------------------- */

static void set_combine(uint32_t w0, uint32_t w1) {
    rdp.cc[0][0] = (int)((w0 >> 20) & 15), rdp.cc[0][1] = (int)((w1 >> 28) & 15);
    rdp.cc[0][2] = (int)((w0 >> 15) & 31), rdp.cc[0][3] = (int)((w1 >> 15) & 7);
    rdp.ac[0][0] = (int)((w0 >> 12) & 7), rdp.ac[0][1] = (int)((w1 >> 12) & 7);
    rdp.ac[0][2] = (int)((w0 >> 9) & 7), rdp.ac[0][3] = (int)((w1 >> 9) & 7);
    rdp.cc[1][0] = (int)((w0 >> 5) & 15), rdp.cc[1][1] = (int)((w1 >> 24) & 15);
    rdp.cc[1][2] = (int)(w0 & 31), rdp.cc[1][3] = (int)((w1 >> 6) & 7);
    rdp.ac[1][0] = (int)((w1 >> 21) & 7), rdp.ac[1][1] = (int)((w1 >> 3) & 7);
    rdp.ac[1][2] = (int)((w1 >> 18) & 7), rdp.ac[1][3] = (int)(w1 & 7);
}

static void set_color(int color[4], uint32_t w1) {
    color[0] = (int)(w1 >> 24), color[1] = (int)((w1 >> 16) & 255);
    color[2] = (int)((w1 >> 8) & 255), color[3] = (int)(w1 & 255);
}

/* The viewport: where on screen the 3D view goes. */
static void set_viewport(uint32_t address) {
    for (int i = 0; i < 3; i++) {
        rsp.viewport_scale[i] = (float)(int16_t)rd16(address + (uint32_t)i * 2) / 4.0f;
        rsp.viewport_translate[i] = (float)(int16_t)rd16(address + 8 + (uint32_t)i * 2) / 4.0f;
    }
    if (getenv("SHOW_MATRICES") && !measuring && gfx_frame_number == atol(getenv("SHOW_MATRICES"))) /* for testing */
        fprintf(stderr, "viewport: middle %.1f %.1f %.1f, half size %.1f %.1f %.1f (after %d shapes)\n", rsp.viewport_translate[0],
                rsp.viewport_translate[1], rsp.viewport_translate[2], rsp.viewport_scale[0], rsp.viewport_scale[1],
                rsp.viewport_scale[2], shape_count);
}

static void set_light(int n, uint32_t address) {
    float d[3], length;
    if (n < 0 || n > 7)
        return;
    for (int i = 0; i < 3; i++) {
        rsp.lights[n].color[i] = (float)rd8(address + (uint32_t)i);
        d[i] = (float)(int8_t)rd8(address + 8 + (uint32_t)i);
    }
    length = sqrtf(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
    for (int i = 0; i < 3; i++)
        rsp.lights[n].direction[i] = length > 0 ? d[i] / length : 0;
}

/* A game can also change just the colour of a light it has already set up,
 * with a single number (red, green and blue in its top three bytes). It is
 * sent twice, to two copies the chip keeps; either one will do for us.
 * F-1 World Grand Prix colours all its lights this way: without it every
 * lit surface kept the colour its lights were first loaded with, plain red. */
static void set_light_color(int n, uint32_t rgb) {
    if (n < 0 || n > 7)
        return;
    if (getenv("SHOW_LIGHTS")) /* for testing */
        fprintf(stderr, "light %d of %d coloured %06X (picture %ld)\n", n, rsp.light_count, rgb >> 8, gfx_frame_number);
    rsp.lights[n].color[0] = (float)(rgb >> 24), rsp.lights[n].color[1] = (float)((rgb >> 16) & 255);
    rsp.lights[n].color[2] = (float)((rgb >> 8) & 255);
}

static void command_move_memory(uint32_t w0, uint32_t w1) {
    uint32_t index = (w0 >> 16) & 255, address = segmented(w1);
    if (index == 0x80)
        set_viewport(address);
    else if (index >= 0x86 && index <= 0x94)
        set_light((int)(index - 0x86) / 2, address);
}

/* ---- F3DEX2 ---------------------------------------------------------------------
 * The third dialect does what F3DEX does, but every command has a new
 * number and most pack their details differently. This turns each one into
 * the same actions as its older counterpart. */

/* F3DEX2 moved the two "do not draw this side" settings to other bits. */
static uint32_t geometry_mode_ex2;
static void set_geometry_mode_ex2(uint32_t mode) {
    geometry_mode_ex2 = mode;
    rsp.geometry_mode = (mode & ~0x3600u) | (mode & 0x200 ? G_CULL_FRONT : 0) | (mode & 0x400 ? G_CULL_BACK : 0);
}

static void triangle(uint32_t a, uint32_t b, uint32_t c);
static void update_combined(void);
static uint32_t half_word; /* a number handed over ahead of the command that uses it */

/* Returns the address of a display list to go to, or 0. */
static void command_ex2(uint32_t w0, uint32_t w1) {
    switch (w0 >> 24) {
    case 0x01: command_vertices(w0, w1); break;
    case 0x02: { /* change one thing about a vertex already loaded */
        Vertex *v = &rsp.vertices[((w0 & 0xFFFF) / 2) & 63];
        uint32_t what = (w0 >> 16) & 255;
        if (what == 0x10)
            v->r = (float)(w1 >> 24), v->g = (float)((w1 >> 16) & 255), v->b = (float)((w1 >> 8) & 255),
            v->a = (float)(w1 & 255);
        else if (what == 0x14)
            v->u = (float)(int16_t)(w1 >> 16) / 32.0f, v->v = (float)(int16_t)w1 / 32.0f;
        break;
    }
    case 0x05: triangle(w0 >> 16, w0 >> 8, w0); break;
    case 0x06: case 0x07: /* two triangles (0x07: the two halves of a four-cornered shape) */
        triangle(w0 >> 16, w0 >> 8, w0);
        triangle(w1 >> 16, w1 >> 8, w1);
        break;
    case 0xD7: /* texture coordinate scale, and which tile */
        rsp.texture_tile = (int)((w0 >> 8) & 7);
        rsp.texture_scale_s = (float)(w1 >> 16) / 65536.0f;
        rsp.texture_scale_t = (float)(w1 & 0xFFFF) / 65536.0f;
        break;
    case 0xD8: /* pop the matrix stack, possibly several levels */
        for (uint32_t i = 0; i < w1 / 64 && rsp.modelview_top > 0; i++)
            rsp.modelview_top--;
        update_combined();
        break;
    case 0xD9: set_geometry_mode_ex2((geometry_mode_ex2 & w0 & 0xFFFFFF) | w1); break;
    case 0xDA: {
        uint32_t flags = (w0 & 255) ^ 1; /* (the "push" bit is stored upside down) */
        command_matrix(flags & 4, flags & 2, flags & 1, w1);
        break;
    }
    case 0xDB: { /* set one number */
        uint32_t index = (w0 >> 16) & 255, offset = w0 & 0xFFFF;
        if (index == 0x04)
            rsp.clip_ratio = (int)(w1 < 0x8000 ? w1 : 0x10000 - (w1 & 0xFFFF));
        if (index == 0x02)
            rsp.light_count = (int)(w1 / 24);
        else if (index == 0x06)
            rsp.segments[offset / 4 & 15] = w1 & 0xFFFFFF;
        else if (index == 0x08)
            rsp.fog_multiply = (float)(int16_t)(w1 >> 16), rsp.fog_offset = (float)(int16_t)w1;
        else if (index == 0x0A) /* one light's colour (each light is 0x18 apart in this dialect) */
            set_light_color((int)(offset / 0x18), w1);
        if (rsp.light_count < 0 || rsp.light_count > 7)
            rsp.light_count = 0;
        break;
    }
    case 0xDC: { /* hand over a block of numbers */
        uint32_t index = w0 & 255, offset = ((w0 >> 8) & 255) * 8;
        if (index == 8)
            set_viewport(segmented(w1));
        else if (index == 10 && offset >= 48) /* (the first two slots are not lights) */
            set_light((int)(offset / 24) - 2, segmented(w1));
        break;
    }
    case 0xE1: half_word = w1; break;
    case 0xE2: case 0xE3: { /* change some bits of the pixel settings */
        uint32_t length = (w0 & 255) + 1, shift = (32 - ((w0 >> 8) & 255) - length) & 31;
        uint32_t mask = (length >= 32 ? 0xFFFFFFFFu : ((1u << length) - 1)) << shift;
        uint32_t *mode = (w0 >> 24) == 0xE2 ? &rdp.other_mode_l : &rdp.other_mode_h;
        *mode = (*mode & ~mask) | (w1 & mask);
        break;
    }
    case 0x00: break; /* "do nothing" */
    default:
        gfx_unhandled_count++;
        if (gfx_report_unhandled || getenv("SHOW_GRAPHICS")) { /* for testing: commands we do nothing with */
            static long seen[256];
            if (seen[w0 >> 24]++ < 3)
                fprintf(stderr, "gfx: F3DEX2 command %08X %08X not handled\n", w0, w1);
        }
        break;
    }
}

static void command_move_word(uint32_t w0, uint32_t w1) {
    if (getenv("SHOW_GRAPHICS")) { /* for testing: which kinds a game uses */
        static long seen[256];
        if (seen[w0 & 255]++ < 2)
            fprintf(stderr, "gfx: set-one-number command %08X %08X\n", w0, w1);
    }
    switch (w0 & 255) {
    case 0x02: rsp.light_count = (int)((w1 - 0x80000000u) / 32) - 1; break;
    case 0x04: rsp.clip_ratio = (int)(w1 < 0x8000 ? w1 : 0x10000 - (w1 & 0xFFFF)); break;
    case 0x06: rsp.segments[((w0 >> 8) & 0xFFFF) / 4 & 15] = w1 & 0xFFFFFF; break;
    case 0x08:
        rsp.fog_multiply = (float)(int16_t)(w1 >> 16);
        rsp.fog_offset = (float)(int16_t)w1;
        break;
    case 0x0A: set_light_color((int)(((w0 >> 8) & 0xFFFF) / 0x20), w1); break; /* (each light is 0x20 apart here) */
    }
    if (rsp.light_count < 0 || rsp.light_count > 7)
        rsp.light_count = 0;
}

static void run_list(uint32_t address) {
    uint32_t return_stack[18];
    /* The chip starts every list with its stack of matrices empty. Games
     * rely on that: Wave Race 64 leaves matrices on the stack at the end of
     * a frame, and if they were still there for the next one the stack
     * would soon be full and later objects (its dolphins) come out built on
     * the wrong matrices, the wrong size and shape. */
    copies_used = 0;
    if (rsp.modelview_top > 0) {
        memcpy(rsp.modelview[0], rsp.modelview[rsp.modelview_top], sizeof rsp.modelview[0]);
        memcpy(rsp.modelview_exact[0], rsp.modelview_exact[rsp.modelview_top], sizeof rsp.modelview_exact[0]);
        rsp.modelview_top = 0;
    }
    matrix_index = 0;
    seen_perspective = 0;
    have_camera = 0;
    side_scene = have_side_camera = 0;
    free_turn_ready = 0;
    tracked_count = 0;
    int depth = 0;
    uint32_t pc = segmented(address);

    for (long guard = 0; guard < 2000000; guard++) {
        uint32_t w0 = rd32(pc), w1 = rd32(pc + 4);
        pc += 8;
        if (dialect == GFX_F3DEX2 && (w0 >> 24) < 0xE4) {
            switch (w0 >> 24) {
            case 0x04: /* "the detailed version, if it is near enough": always take it */
                pc = segmented(half_word);
                break;
            case 0xDE: /* run another display list */
                if (((w0 >> 16) & 255) == 0 && depth < 18)
                    return_stack[depth++] = pc;
                pc = segmented(w1);
                break;
            case 0xDF: /* end of this display list */
                if (depth == 0) {
                    draw_all_shapes();
                    return;
                }
                pc = return_stack[--depth];
                break;
            default: command_ex2(w0, w1); break;
            }
            continue;
        }
        switch (w0 >> 24) {
        case 0x01: command_matrix((w0 >> 16) & 1, (w0 >> 16) & 2, (w0 >> 16) & 4, w1); break;
        case 0x03: command_move_memory(w0, w1); break;
        case 0x04: command_vertices(w0, w1); break;
        case 0x06: /* run another display list */
            if (((w0 >> 16) & 255) == 0 && depth < 18)
                return_stack[depth++] = pc;
            pc = segmented(w1);
            break;
        case 0xB6: rsp.geometry_mode &= ~w1; break;
        case 0xB7: rsp.geometry_mode |= w1; break;
        case 0xB8: /* end of this display list */
            if (depth == 0) {
                draw_all_shapes();
                return;
            }
            pc = return_stack[--depth];
            break;
        case 0xB9: case 0xBA: { /* change some bits of the pixel settings */
            uint32_t shift = (w0 >> 8) & 255, length = w0 & 255;
            uint32_t mask = (length >= 32 ? 0xFFFFFFFFu : ((1u << length) - 1)) << shift;
            uint32_t *mode = (w0 >> 24) == 0xB9 ? &rdp.other_mode_l : &rdp.other_mode_h;
            *mode = (*mode & ~mask) | (w1 & mask);
            break;
        }
        case 0xBB: /* texture coordinate scale, and which tile */
            rsp.texture_tile = (int)((w0 >> 8) & 7);
            rsp.texture_scale_s = (float)(w1 >> 16) / 65536.0f;
            rsp.texture_scale_t = (float)(w1 & 0xFFFF) / 65536.0f;
            break;
        case 0xBC: command_move_word(w0, w1); break;
        case 0xBD: /* pop the matrix stack */
            if (rsp.modelview_top > 0)
                rsp.modelview_top--;
            update_combined();
            break;
        case 0xBF: triangle(w1 >> 16, w1 >> 8, w1); break;
        case 0xB1: /* F3DEX: two triangles in one command */
            if (dialect != GFX_FAST3D) {
                triangle(w0 >> 16, w0 >> 8, w0);
                triangle(w1 >> 16, w1 >> 8, w1);
            }
            break;
        case 0xB4: half_word = w1; break;
        case 0xB0: /* F3DEX: "the detailed version, if it is near enough": always take it */
            if (dialect == GFX_F3DEX)
                pc = segmented(half_word);
            break;
        case 0xB5: /* a four-cornered shape, as two triangles */
            triangle(w1 >> 24, w1 >> 16, w1 >> 8);
            triangle(w1 >> 24, w1 >> 8, w1);
            break;

        case 0xE4: case 0xE5: /* textured rectangle: two more words follow */
            command_texture_rectangle(w0, w1, rd32(pc + 4), rd32(pc + 12), (w0 >> 24) == 0xE5);
            pc += 16;
            break;
        case 0xED: /* scissor: nothing is drawn outside this box */
            if (getenv("SHOW_SCISSORS") && !measuring && gfx_frame_number == atol(getenv("SHOW_SCISSORS"))) /* for testing */
                fprintf(stderr, "scissor command %08X %08X: x %.2f..%.2f y %.2f..%.2f (after %d shapes)\n", w0, w1,
                        ((w0 >> 12) & 0xFFF) / 4.0, ((w1 >> 12) & 0xFFF) / 4.0, (w0 & 0xFFF) / 4.0, (w1 & 0xFFF) / 4.0, shape_count);
            /* A box (nearly) as wide as the screen tells us how tall the screen is:
             * well over 240 lines for its width means twice as fine downwards. */
            if ((float)((w0 >> 12) & 0xFFF) <= 16 * 4 * hires_x && (float)((w1 >> 12) & 0xFFF) >= (SCREEN_W - 16) * 4 * hires_x)
                hires_y = (float)(w1 & 0xFFF) > SCREEN_H * 4 * hires_x * 1.5f ? hires_x * 2 : hires_x;
            rdp.scissor[0] = wide_x((int)((w0 >> 12) & 0xFFF));
            rdp.scissor[1] = unit_y((int)(w0 & 0xFFF));
            rdp.scissor[2] = wide_x((int)((w1 >> 12) & 0xFFF));
            rdp.scissor[3] = unit_y((int)(w1 & 0xFFF));
            if (rdp.scissor[2] > width) rdp.scissor[2] = width;
            if (rdp.scissor[3] > height) rdp.scissor[3] = height;
            if (rdp.scissor[0] < 0) rdp.scissor[0] = 0;
            if (rdp.scissor[1] < 0) rdp.scissor[1] = 0;
            break;
        case 0xEF: rdp.other_mode_h = w0 & 0xFFFFFF, rdp.other_mode_l = w1; break;
        case 0xF0: rdp.palette_address = rdp.texture_image; break;
        case 0xF2: {
            Tile *tile = &rdp.tiles[(w1 >> 24) & 7];
            tile->uls = (int)((w0 >> 12) & 0xFFF), tile->ult = (int)(w0 & 0xFFF);
            tile->lrs = (int)((w1 >> 12) & 0xFFF), tile->lrt = (int)(w1 & 0xFFF);
            break;
        }
        case 0xF3: command_load_block(w1); break;
        case 0xF4: command_load_tile(w0, w1); break;
        case 0xF5: command_set_tile(w0, w1); break;
        case 0xF6: command_fill_rectangle(w0, w1); break;
        case 0xF7: rdp.fill_color = w1; break;
        case 0xF8: set_color(rdp.fog, w1); break;
        case 0xF9: set_color(rdp.blend, w1); break;
        case 0xFA: set_color(rdp.prim, w1), rdp.prim_lod_fraction = (int)(w0 & 0xFF); break;
        case 0xFB: set_color(rdp.env, w1); break;
        case 0xFC: set_combine(w0, w1); break;
        case 0xFD:
            rdp.texture_format = (w0 >> 21) & 7, rdp.texture_size = (w0 >> 19) & 3;
            rdp.texture_width = (w0 & 0xFFF) + 1;
            rdp.texture_image = segmented(w1);
            break;
        case 0xFE: rdp.depth_image = segmented(w1); break;
        case 0xFF:
            rdp.color_image = segmented(w1);
            if ((w0 & 0xFFF) + 1 >= SCREEN_W) { /* (narrower ones are side pictures, not the screen) */
                float finer = (float)((w0 & 0xFFF) + 1) / SCREEN_W;
                hires_y *= finer / hires_x, hires_x = finer;
            }
            break;
        /* "Wait until the chip has caught up" (four kinds) and "do nothing":
         * we draw each command as it comes, so there is nothing to wait for. */
        case 0xE6: case 0xE7: case 0xE8: case 0xE9: case 0xC0: break;
        /* "Skip the rest of this list if these corners are all off the
         * screen": a way for the game to save the console work. We have
         * the speed to draw it anyway, and what is off the screen is cut
         * away later all the same. */
        case 0xBE: break;
        case 0xEE: rdp.prim_depth = (float)((w1 >> 16) & 0x7FFF) / 32767.0f; break;
        default:
            gfx_unhandled_count++;
            if (gfx_report_unhandled || getenv("SHOW_GRAPHICS")) { /* for testing: commands we do nothing with */
                static long seen[256];
                if (seen[w0 >> 24]++ < 3)
                    fprintf(stderr, "gfx: command %08X %08X not handled\n", w0, w1);
            }
            break;
        }
    }
    draw_all_shapes();
}

int gfx_run(uint32_t address, int smooth) {
    int count = 1;
    if (smooth) {
        /* Dry run first, to learn this frame's matrices and whether they
         * line up with the previous frame's. */
        measuring = 1;
        run_list(address);
        measuring = 0;
        if (previous_matrix_count > 0 && matrix_index <= MAX_MATRICES) {
            if (backend) {
                backend->select_picture(0);
            } else {
                memcpy(pictures[0], pictures[1], (size_t)width * (size_t)height * 4);
                color_buffer = pictures[0];
            }
            blend = 0.5f;
            run_list(address);
            blend = 1;
            count = 2;
        }
    }
    if (backend)
        backend->select_picture(1);
    color_buffer = pictures[1];
    run_list(address);
    previous_matrix_count = matrix_index;
    Tracked *swap = tracked_before;
    tracked_before = tracked_now, tracked_now = swap, tracked_before_count = tracked_count;
    if (matrix_index <= MAX_MATRICES)
        memcpy(previous_matrices, current_matrices, (size_t)matrix_index * sizeof previous_matrices[0]),
        memcpy(previous_sources, current_sources, (size_t)matrix_index * sizeof previous_sources[0]);

    /* Things the free camera wants to know about the frame just drawn. */
    free_before = free_now;
    have_last_camera = have_camera;
    if (have_camera) {
        memcpy(last_camera, camera_exact, sizeof last_camera);
        notice_world_up(camera_exact);
        update_guess_depth();
    }
    if (getenv("SHOW_CAMERA") && gfx_frame_number % 60 == 0) { /* for working out how a game does its camera */
        fprintf(stderr, "gfx: camera %s (%s), z-up votes %d, %d depth samples, guess %.1f, matrices %d\n",
                have_camera ? "found" : "NOT found", proj_has_view ? "in the projection" : "in the modelview",
                up_votes, depth_sample_count, guess_depth, matrix_index);
        for (int i = 0; i < 4; i++)
            fprintf(stderr, "   proj %10.3f %10.3f %10.3f %10.3f   cam %10.3f %10.3f %10.3f %10.3f\n", rsp.projection[i][0],
                    rsp.projection[i][1], rsp.projection[i][2], rsp.projection[i][3], camera_exact[i][0],
                    camera_exact[i][1], camera_exact[i][2], camera_exact[i][3]);
    }
    gfx_frame_number++;
    depth_sample_count = 0;
    float cy = cosf(look_yaw), sy = sinf(look_yaw), cp = cosf(look_pitch), sp = sinf(look_pitch);
    float turn[3][3] = {{cy, sy * sp, -sy * cp}, {0, cp, sp}, {sy, -cy * sp, cy * cp}};
    /* For a pure turn, the matrix that undoes it is the same numbers with
     * rows and columns swapped. */
    for (int i = 0; i < 3; i++)
        for (int j = 0; j < 3; j++)
            view_back[i][j] = free_turn_ready ? free_turn[j][i] : turn[j][i];
    return count;
}

void gfx_set_free_camera(int on, float yaw, float pitch, float distance, const float focus[3]) {
    free_now.on = on, free_now.yaw = yaw, free_now.pitch = pitch, free_now.distance = distance;
    memcpy(free_now.focus, focus, sizeof free_now.focus);
}

/* The direction a camera looks in, from its two angles. Yaw 0 looks along
 * the world's z; pitch above 0 looks downwards. */
static void direction(float out[3], float yaw, float pitch) {
    out[0] = sinf(yaw) * cosf(pitch), out[1] = -sinf(pitch), out[2] = cosf(yaw) * cosf(pitch);
}

int gfx_game_camera(const float focus[3], float *yaw, float *pitch, float *distance, float *facing) {
    float inverse[4][4];
    if (!have_last_camera || !invert(inverse, last_camera))
        return 0;
    /* Undoing the camera's matrix tells us where the camera is: the place
     * that it turns into "right here". */
    float to_focus[3], length = 0;
    for (int i = 0; i < 3; i++) {
        to_focus[i] = focus[i] - inverse[3][i];
        length += to_focus[i] * to_focus[i];
    }
    length = sqrtf(length);
    if (length < 1e-3f)
        return 0;
    /* Angles are worked out in a y-up world (see world_fix). A camera looks
     * along its own -z, and the third column of its matrix says where z is. */
    float fixed[3], looking[3];
    for (int i = 0; i < 3; i++) {
        fixed[i] = to_focus[0] * world_fix[0][i] + to_focus[1] * world_fix[1][i] + to_focus[2] * world_fix[2][i];
        looking[i] = -(last_camera[0][2] * world_fix[0][i] + last_camera[1][2] * world_fix[1][i] +
                       last_camera[2][2] * world_fix[2][i]);
    }
    *distance = length;
    *yaw = atan2f(fixed[0], fixed[2]);
    *pitch = asinf(-fixed[1] / length);
    /* Which way it is pointing (not quite the same thing: the game's camera
     * does not always look straight at the character). */
    *facing = atan2f(looking[0], looking[2]);
    return 1;
}

int gfx_game_camera_place(float place[3]) {
    float inverse[4][4];
    if (!have_last_camera || !invert(inverse, last_camera))
        return 0;
    memcpy(place, inverse[3], 3 * sizeof(float));
    return 1;
}

int gfx_guess_focus(float focus[3]) {
    float inverse[4][4];
    if (!have_last_camera || guess_depth <= 0 || !invert(inverse, last_camera))
        return 0;
    /* From where the camera is, guess_depth along the way it looks. */
    for (int i = 0; i < 3; i++)
        focus[i] = inverse[3][i] - last_camera[i][2] * guess_depth;
    return 1;
}

void gfx_view_back(float back[3][3]) { memcpy(back, view_back, sizeof view_back); }


void gfx_set_dialect(int which) { dialect = which; }
void gfx_set_no_near(int on) { no_near = on; }

void gfx_set_view(float yaw, float pitch, float zoom) {
    look_yaw = yaw, look_pitch = pitch, look_zoom = zoom;
}

/* Set (or change) the picture's size and shape. Safe to call between frames. */
void gfx_resize(int resolution_scale, float aspect) {
    scale = resolution_scale < 1 ? 1 : resolution_scale;
    /* The height stays 240 units; the width follows the shape asked for. */
    wide_units = aspect > 4.0f / 3 ? (float)(((int)(SCREEN_H * aspect) + 3) & ~3) : SCREEN_W;
    wide_offset = (wide_units - SCREEN_W) / 2;
    width = (int)wide_units * scale, height = SCREEN_H * scale;
    for (int i = 0; i < 2; i++) {
        free(pictures[i]);
        pictures[i] = calloc((size_t)width * (size_t)height, sizeof *pictures[i]);
    }
    free(depth_buffer);
    depth_buffer = calloc((size_t)width * (size_t)height, sizeof *depth_buffer);
    color_buffer = pictures[1];
    rdp.scissor[0] = rdp.scissor[1] = 0, rdp.scissor[2] = width, rdp.scissor[3] = height;
    previous_matrix_count = 0; /* nothing to blend the next frame with */
    if (backend)
        backend->resize(width, height);
}

void gfx_forget_last_frame(void) {
    previous_matrix_count = 0; /* nothing to blend the next frame with */
}

void gfx_init(uint8_t *game_ram, int resolution_scale, float aspect) {
    ram = game_ram;
    shapes = malloc(MAX_SHAPES * sizeof *shapes);
    tracked_now = malloc(MAX_TRACKED * sizeof *tracked_now);
    tracked_before = malloc(MAX_TRACKED * sizeof *tracked_before);
    /* One strip of the screen per CPU core, leaving a couple of cores free. */
    long cores = sysconf(_SC_NPROCESSORS_ONLN) - 2;
    worker_count = cores < 1 ? 1 : cores > MAX_WORKERS ? MAX_WORKERS : (int)cores;
    for (int i = 1; i < worker_count; i++) {
        pthread_t thread;
        pthread_create(&thread, NULL, worker_main, (void *)(intptr_t)i);
    }
    memset(&rsp, 0, sizeof rsp);
    memset(&rdp, 0, sizeof rdp);
    for (int i = 0; i < 4; i++)
        rsp.modelview[0][i][i] = rsp.modelview_exact[0][i][i] = rsp.projection[i][i] = rsp.combined[i][i] = 1;
    rsp.viewport_scale[0] = rsp.viewport_translate[0] = SCREEN_W / 2;
    rsp.viewport_scale[1] = rsp.viewport_translate[1] = SCREEN_H / 2;
    gfx_resize(resolution_scale, aspect);
}

const uint32_t *gfx_picture(int which, int *picture_width, int *picture_height) {
    *picture_width = width, *picture_height = height;
    return pictures[which];
}
