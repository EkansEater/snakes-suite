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

/* Free look: an extra turn and zoom applied on top of the game's camera. */
static float look_yaw, look_pitch, look_zoom = 1;

/* Smooth motion: the game moves things 30 times a second. For 60, we draw an
 * extra picture halfway between each pair of frames by blending the
 * position matrices of the previous frame with the current one's. */
#define MAX_MATRICES 4096
static float previous_matrices[MAX_MATRICES][4][4], current_matrices[MAX_MATRICES][4][4];
static int previous_matrix_count, matrix_index;
static float blend = 1;      /* 1 = this frame as is, 0.5 = halfway from the previous */
static int measuring;        /* a dry run: read the matrices, draw nothing */
static int seen_perspective; /* has this frame started its 3D scene yet? */
static int extended;         /* is the game using F3DEX rather than plain Fast3D? */
/* The camera's own matrix this frame, as the game gave it and as blended for
 * an in-between picture. Used to place shadows; see command_vertices. */
static float camera_exact[4][4], camera_blended[4][4];
static int have_camera;

/* World positions of the corners of each see-through shape, this frame and
 * the previous one (see command_vertices). */
#define MAX_TRACKED 2048
typedef struct { int count; float corner[64][3]; } Tracked;
static Tracked *tracked_now, *tracked_before;
static int tracked_count, tracked_before_count;
static float *depth_buffer;    /* 0 = nearest, 1 = farthest */
long gfx_triangle_count;

/* ---- Reading the game's memory -------------------------------------------- */

static uint32_t rd8(uint32_t a) { return ram[a & RAM_MASK]; }
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

static struct {
    uint32_t segments[16];
    float modelview[11][4][4]; /* a stack: objects are positioned relative to others */
    float modelview_exact[11][4][4]; /* the same, never blended (see "smooth motion") */
    int modelview_top;
    float projection[4][4];
    float combined[4][4]; /* modelview * projection */
    uint32_t geometry_mode;
    Vertex vertices[64];
    struct { float color[3], direction[3]; } lights[8];
    int light_count;
    float fog_multiply, fog_offset;
    float texture_scale_s, texture_scale_t;
    float viewport_scale[3], viewport_translate[3];
} rsp;

/* ---- State of the pixel half ("RDP") --------------------------------------- */



static struct {
    uint32_t other_mode_h, other_mode_l;
    int cc[2][4], ac[2][4]; /* colour and alpha combiner settings, two cycles */
    int prim[4], env[4], fog[4], blend[4];
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

static int is_perspective(float m[4][4]) { return m[3][3] == 0; }

/* modelview * projection, slipping in the free-look turn between them
 * (only for 3D scenes, not for flat things like the HUD). */
static void combine_with(float out[4][4], float modelview[4][4]) {
    if (!is_perspective(rsp.projection) || (look_yaw == 0 && look_pitch == 0 && look_zoom == 1)) {
        multiply(out, modelview, rsp.projection);
        return;
    }
    float cy = cosf(look_yaw), sy = sinf(look_yaw), cp = cosf(look_pitch), sp = sinf(look_pitch);
    float turn[4][4] = {{cy, sy * sp, -sy * cp, 0}, {0, cp, sp, 0}, {sy, -cy * sp, cy * cp, 0}, {0, 0, 0, 1}};
    float zoomed[4][4];
    memcpy(zoomed, rsp.projection, sizeof zoomed);
    for (int i = 0; i < 4; i++)
        zoomed[i][0] *= look_zoom, zoomed[i][1] *= look_zoom;
    multiply(turn, turn, zoomed);
    multiply(out, modelview, turn);
}

static void update_combined(void) { combine_with(rsp.combined, rsp.modelview[rsp.modelview_top]); }

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

static void command_matrix(uint32_t w0, uint32_t w1) {
    float m[4][4], exact[4][4];
    int projection = (w0 >> 16) & 1, load = (w0 >> 16) & 2, push = (w0 >> 16) & 4;
    load_matrix(segmented(w1), m);
    memcpy(exact, m, sizeof exact);

    /* Matrices arrive in much the same order every frame (the game walks
     * its scene the same way), so this one's counterpart in the previous
     * frame is at or near the same place in the list. Objects appearing and
     * disappearing shift the list a little, so look a few places either
     * side and take the closest match. */
    if (matrix_index < MAX_MATRICES) {
        memcpy(current_matrices[matrix_index], m, sizeof m);
        float (*best)[4] = NULL, best_score = 0;
        for (int j = matrix_index - 8; blend < 1 && j <= matrix_index + 8; j++) {
            if (j < 0 || j >= previous_matrix_count)
                continue;
            float (*old)[4] = previous_matrices[j], score = 0, jump = 0;
            if (is_perspective(m) != is_perspective(old))
                continue;
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
        if (load)
            memcpy(rsp.projection, m, sizeof m);
        else
            multiply(rsp.projection, m, rsp.projection);
        if (is_perspective(rsp.projection))
            seen_perspective = 1;
    } else {
        if (push && rsp.modelview_top < 10) {
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
            if (!have_camera && is_perspective(rsp.projection)) {
                memcpy(camera_exact, exact, sizeof m);
                memcpy(camera_blended, m, sizeof m);
                have_camera = 1;
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
    int count = (int)((w0 >> 20) & 15) + 1, first = (int)((w0 >> 16) & 15);
    if (extended) /* F3DEX packs the same two numbers differently, and holds more vertices */
        count = (int)((w0 >> 10) & 63), first = (int)((w0 >> 16) & 255) / 2;
    if (first + count > 64)
        return;
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
    int track = (decal || see_through) && have_camera && is_perspective(rsp.projection) &&
                tracked_count < MAX_TRACKED && invert(to_world, camera_exact);
    Tracked *now = NULL;
    const Tracked *before = NULL;
    if (track) {
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
             * corners, and the nearest (but not far away). */
            float nearest = 300;
            for (int j = 0; j < tracked_before_count; j++) {
                const Tracked *t = &tracked_before[j];
                if (t->count != count)
                    continue;
                float distance = 0;
                for (int k = 0; k < 3; k++)
                    distance += fabsf(t->corner[0][k] - now->corner[0][k]);
                if (distance < nearest)
                    nearest = distance, before = t;
            }
            combine_with(world_to_screen, camera_blended);
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

        /* In widescreen the left and right edges are further out. */
        float side = v->w * wide_units / SCREEN_W;
        v->backdrop = !seen_perspective && !is_perspective(rsp.projection);
        v->clip = (v->x < -side ? CLIP_LEFT : 0) | (v->x > side ? CLIP_RIGHT : 0) |
                  (v->y < -v->w ? CLIP_BOTTOM : 0) | (v->y > v->w ? CLIP_TOP : 0) |
                  (v->z < -v->w ? CLIP_NEAR : 0);

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
            float f = v->z * inverse * rsp.fog_multiply + rsp.fog_offset;
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
static void capture_state(DrawState *d, int tile_index, int allow_depth) {
    memset(d, 0, sizeof *d); /* so that two identical states compare equal byte for byte */
    const Loaded *loaded = find_loaded(rdp.tiles[tile_index].tmem);
    d->tile = rdp.tiles[tile_index];
    if (loaded)
        d->loaded = *loaded;
    d->use_texture = loaded != NULL && combiner_uses_texture();
    /* How the pixel meets what is already on screen ("blender"). Bit 18 says
     * the new pixel simply replaces the old; otherwise they are mixed. */
    d->use_alpha = (rdp.other_mode_l & 0x40000) == 0;
    d->use_fog = (rdp.other_mode_l >> 30) == 3;
    /* "Texture edge" mode: the texture's alpha cuts holes in the shape. */
    d->cutout = (rdp.other_mode_l & 0x1000) != 0;
    int z = allow_depth && (rsp.geometry_mode & G_ZBUFFER);
    d->depth_test = z && (rdp.other_mode_l & 0x10);
    d->depth_write = z && (rdp.other_mode_l & 0x20);
    d->decal = ((rdp.other_mode_l >> 10) & 3) == 3; /* drawn flat on another surface */
    d->bilinear = BILINEAR;
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
    for (int i = 0; i < 4; i++)
        p->shade[i] = shape->kind == COMBINED_RECTANGLE ? 0 : 255;

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
    float x = rsp.viewport_translate[0] + v->x * q * rsp.viewport_scale[0];
    /* A backdrop is stretched to fill the wider picture; everything else
     * keeps its shape and is shifted to the middle. */
    x = v->backdrop ? x * wide_units / SCREEN_W : x + wide_offset;
    s->x = x * (float)scale;
    s->y = (rsp.viewport_translate[1] - v->y * q * rsp.viewport_scale[1]) * (float)scale;
    s->z = v->z * q * 0.5f + 0.5f;
    s->q = q;
    s->u = v->u, s->v = v->v, s->r = v->r, s->g = v->g, s->b = v->b, s->a = v->a, s->fog = v->fog;
}

/* Triangle commands name their corners by position in the vertex list,
 * multiplied by 10 in Fast3D and by 2 in its successor F3DEX. */
static void triangle(uint32_t a, uint32_t b, uint32_t c) {
    uint32_t unit = extended ? 2 : 10;
    const Vertex *v[3] = {
        &rsp.vertices[(a & 255) / unit & 63],
        &rsp.vertices[(b & 255) / unit & 63],
        &rsp.vertices[(c & 255) / unit & 63],
    };
    if (measuring || (v[0]->clip & v[1]->clip & v[2]->clip))
        return; /* all three corners are off the same side of the screen */

    /* Skip triangles facing away from the camera, if asked to. */
    if (rsp.geometry_mode & (G_CULL_FRONT | G_CULL_BACK)) {
        float dx1 = v[0]->x / v[0]->w - v[1]->x / v[1]->w, dy1 = v[0]->y / v[0]->w - v[1]->y / v[1]->w;
        float dx2 = v[2]->x / v[2]->w - v[1]->x / v[1]->w, dy2 = v[2]->y / v[2]->w - v[1]->y / v[1]->w;
        float cross = dx1 * dy2 - dy1 * dx2;
        if ((v[0]->w < 0) ^ (v[1]->w < 0) ^ (v[2]->w < 0))
            cross = -cross;
        uint32_t cull = rsp.geometry_mode & (G_CULL_FRONT | G_CULL_BACK);
        if (cull == (G_CULL_FRONT | G_CULL_BACK) || (cull == G_CULL_FRONT && cross <= 0) ||
            (cull == G_CULL_BACK && cross >= 0))
            return;
    }

    /* A triangle that passes behind the camera must be cut off at the
     * "near plane" first, or the maths below would divide by zero or worse.
     * Cutting a triangle with a plane leaves three or four corners. */
    Vertex polygon[4];
    int count = 0;
    for (int i = 0; i < 3; i++) {
        const Vertex *a = v[i], *b = v[(i + 1) % 3];
        float da = a->z + a->w, db = b->z + b->w; /* distance in front of the plane */
        if (da >= 0)
            polygon[count++] = *a;
        if ((da >= 0) != (db >= 0)) {
            float t = da / (da - db);
            Vertex *n = &polygon[count++];
#define LERP(field) n->field = a->field + (b->field - a->field) * t
            LERP(x); LERP(y); LERP(z); LERP(w); LERP(u); LERP(v);
            LERP(r); LERP(g); LERP(b); LERP(a); LERP(fog);
#undef LERP
            n->backdrop = a->backdrop;
        }
    }
    if (count < 3)
        return;

    ScreenVertex s[4];
    for (int i = 0; i < count; i++) {
        if (polygon[i].w <= 1e-6f)
            return;
        to_screen(&polygon[i], &s[i]);
    }
    for (int i = 1; i + 1 < count; i++) {
        Shape *shape = new_shape(TRIANGLE);
        capture_state(&shape->state, 0, 1);
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
    if (quarter_units >= SCREEN_W * 4)
        return width;
    return (int)(((float)quarter_units / 4 + wide_offset) * (float)scale);
}

/* Coordinates arrive as 10.2 fixed point (quarter pixels). */
static void command_fill_rectangle(uint32_t w0, uint32_t w1) {
    int right = (int)((w0 >> 12) & 0xFFF), bottom = (int)(w0 & 0xFFF);
    int left = (int)((w1 >> 12) & 0xFFF), top = (int)(w1 & 0xFFF);
    int fill = CYCLE_TYPE == CYCLE_FILL;
    if (fill || CYCLE_TYPE == CYCLE_COPY)
        right += 4, bottom += 4; /* these modes include the last row and column */

    if (measuring)
        return;
    /* The game "draws" into its depth buffer to reset it each frame. */
    Shape *shape = new_shape(rdp.color_image == rdp.depth_image ? DEPTH_CLEAR : fill ? FILL : COMBINED_RECTANGLE);
    capture_state(&shape->state, 0, 0);
    shape->state.use_texture = 0, shape->state.use_fog = 0;
    shape->x0 = wide_x(left), shape->y0 = top * scale / 4;
    shape->x1 = wide_x(right), shape->y1 = bottom * scale / 4;
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
    Shape *shape = new_shape(copy ? COPY_RECTANGLE : TEXTURE_RECTANGLE);
    capture_state(&shape->state, (int)((w1 >> 24) & 7), 0);
    if (find_loaded(shape->state.tile.tmem) == NULL) {
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
    shape->left = (float)left / 4 + wide_offset, shape->top = (float)top / 4, shape->flip = flip;
    shape->x0 = (int)(shape->left * (float)scale), shape->y0 = top * scale / 4;
    shape->x1 = shape->x0 + (right - left) * scale / 4, shape->y1 = bottom * scale / 4;
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
}

static void command_load_tile(uint32_t w0, uint32_t w1) {
    const Tile *tile = &rdp.tiles[(w1 >> 24) & 7];
    uint32_t bits = 4u << rdp.texture_size;
    uint32_t row = rdp.texture_width * bits / 8;
    uint32_t start = rdp.texture_image + ((w0 & 0xFFF) / 4) * row + (((w0 >> 12) & 0xFFF) / 4) * bits / 8;
    remember_loaded(tile->tmem, start, row, 1, 0);
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

static void command_move_memory(uint32_t w0, uint32_t w1) {
    uint32_t index = (w0 >> 16) & 255, address = segmented(w1);
    if (index == 0x80) { /* viewport: where on screen the 3D view goes */
        for (int i = 0; i < 3; i++) {
            rsp.viewport_scale[i] = (float)(int16_t)rd16(address + (uint32_t)i * 2) / 4.0f;
            rsp.viewport_translate[i] = (float)(int16_t)rd16(address + 8 + (uint32_t)i * 2) / 4.0f;
        }
    } else if (index >= 0x86 && index <= 0x94) { /* a light */
        int n = (int)(index - 0x86) / 2;
        float d[3], length;
        for (int i = 0; i < 3; i++) {
            rsp.lights[n].color[i] = (float)rd8(address + (uint32_t)i);
            d[i] = (float)(int8_t)rd8(address + 8 + (uint32_t)i);
        }
        length = sqrtf(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
        for (int i = 0; i < 3; i++)
            rsp.lights[n].direction[i] = length > 0 ? d[i] / length : 0;
    }
}

static void command_move_word(uint32_t w0, uint32_t w1) {
    switch (w0 & 255) {
    case 0x02: rsp.light_count = (int)((w1 - 0x80000000u) / 32) - 1; break;
    case 0x06: rsp.segments[((w0 >> 8) & 0xFFFF) / 4 & 15] = w1 & 0xFFFFFF; break;
    case 0x08:
        rsp.fog_multiply = (float)(int16_t)(w1 >> 16);
        rsp.fog_offset = (float)(int16_t)w1;
        break;
    }
    if (rsp.light_count < 0 || rsp.light_count > 7)
        rsp.light_count = 0;
}

static void run_list(uint32_t address) {
    uint32_t return_stack[18];
    matrix_index = 0;
    seen_perspective = 0;
    have_camera = 0;
    tracked_count = 0;
    int depth = 0;
    uint32_t pc = segmented(address);

    for (long guard = 0; guard < 2000000; guard++) {
        uint32_t w0 = rd32(pc), w1 = rd32(pc + 4);
        pc += 8;
        switch (w0 >> 24) {
        case 0x01: command_matrix(w0, w1); break;
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
        case 0xBB: /* texture coordinate scale */
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
            if (extended) {
                triangle(w0 >> 16, w0 >> 8, w0);
                triangle(w1 >> 16, w1 >> 8, w1);
            }
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
            rdp.scissor[0] = wide_x((int)((w0 >> 12) & 0xFFF));
            rdp.scissor[1] = (int)(w0 & 0xFFF) * scale / 4;
            rdp.scissor[2] = wide_x((int)((w1 >> 12) & 0xFFF));
            rdp.scissor[3] = (int)(w1 & 0xFFF) * scale / 4;
            if (rdp.scissor[2] > width) rdp.scissor[2] = width;
            if (rdp.scissor[3] > height) rdp.scissor[3] = height;
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
        case 0xFA: set_color(rdp.prim, w1); break;
        case 0xFB: set_color(rdp.env, w1); break;
        case 0xFC: set_combine(w0, w1); break;
        case 0xFD:
            rdp.texture_format = (w0 >> 21) & 7, rdp.texture_size = (w0 >> 19) & 3;
            rdp.texture_width = (w0 & 0xFFF) + 1;
            rdp.texture_image = segmented(w1);
            break;
        case 0xFE: rdp.depth_image = segmented(w1); break;
        case 0xFF: rdp.color_image = segmented(w1); break;
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
        memcpy(previous_matrices, current_matrices, (size_t)matrix_index * sizeof previous_matrices[0]);
    return count;
}

void gfx_set_extended(int is_f3dex) { extended = is_f3dex; }

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
