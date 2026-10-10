/*
 * Shared between the two halves of the renderer.
 *
 * gfx.c reads the game's drawing commands and turns them into a list of
 * "shapes": triangles and rectangles, each with a snapshot of every setting
 * that affects its pixels. Something then has to fill in the pixels. There
 * are two of those "back ends": gfx.c itself can do it on the CPU, and
 * gfx_gl.c hands the shapes to the graphics card through OpenGL.
 */
#ifndef GFX_INTERNAL_H
#define GFX_INTERNAL_H

#include <stdint.h>

typedef struct {
    int format, size, line, tmem, palette;
    int clamp_s, mirror_s, mask_s, clamp_t, mirror_t, mask_t;
    int uls, ult, lrs, lrt; /* corners, in quarter texels */
} Tile;

/* What is in each part of texture memory: where the texture is (address;
 * see "Texture copies" in gfx.c) and where in the game's RAM it came from
 * (source). */
typedef struct {
    int tmem;
    uint32_t address, source, row_bytes;
    uint32_t bytes;  /* total size, when a whole texture was loaded as one strip */
    int fixed_rows;  /* a rectangle cut from a larger picture: row length is the picture's */
    int step_plus_1; /* loaded as a strip with this row step, plus one; 0 once dealt with (see turn_odd_rows) */
} Loaded;

typedef struct {
    int use_texture, use_alpha, use_fog, cutout;
    int depth_test, depth_write, decal;
    int bilinear, first_cycle;
    int cc[2][4], ac[2][4]; /* colour and alpha combiner choices, two cycles */
    int prim[4], env[4], fog[4];
    Tile tile;
    Loaded loaded;
    uint32_t palette_address;
    int scissor[4];
} DrawState;

typedef struct {
    float x, y, z, q; /* screen position, depth, 1/w */
    float u, v, r, g, b, a, fog;
} ScreenVertex;

typedef enum { TRIANGLE, FILL, COMBINED_RECTANGLE, TEXTURE_RECTANGLE, COPY_RECTANGLE, DEPTH_CLEAR } Kind;

typedef struct {
    Kind kind;
    DrawState state;
    ScreenVertex v[3];        /* triangles */
    int x0, y0, x1, y1;       /* rectangles, in output pixels */
    uint32_t color;           /* FILL */
    float left, top, s, t, ds, dt; /* textured rectangles */
    int flip;
} Shape;

/* A back end: the functions gfx.c calls to get pixels drawn. */
typedef struct {
    /* the picture size changed: width and height in pixels */
    void (*resize)(int width, int height);
    /* draw into picture 0 (the in-between one, starting as a copy of the
     * finished one) or picture 1 (the finished one) */
    void (*select_picture)(int which);
    void (*draw)(const Shape *shapes, int count, int picture_width, int picture_height, int scale);
} GfxBackend;

/* Use this back end instead of drawing on the CPU. */
void gfx_set_backend(const GfxBackend *backend);

/* The texture a shape uses, for back ends that need a copy of it: its size,
 * then its pixels as bytes in red, green, blue, alpha order. */
void gfx_texture_size(const DrawState *d, int *width, int *height);
void gfx_texture_pixels(const DrawState *d, int width, int height, uint8_t *rgba);
/* A number that changes if the texture's contents do. */
uint32_t gfx_texture_checksum(const DrawState *d, int width, int height);

#endif
