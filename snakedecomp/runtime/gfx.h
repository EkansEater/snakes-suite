/* The renderer's interface; see gfx.c. */
#ifndef GFX_H
#define GFX_H

#include <stdint.h>

/* resolution_scale: 1 draws at the console's 240 lines, 2 at 480, ...
 * aspect: picture shape, width / height (4.0/3 is the original). */
void gfx_init(uint8_t *game_ram, int resolution_scale, float aspect);

/* Change the picture's size and shape later on (between frames). */
void gfx_resize(int resolution_scale, float aspect);

/* Carry out one display list (one frame's drawing commands). With smooth
 * set, also draws a picture halfway between the previous frame and this
 * one. Returns how many pictures were made: 1, or 2 (in-between, then final). */
int gfx_run(uint32_t display_list_address, int smooth);

/* which: 1 = the finished frame, 0 = the in-between one. One 0xAARRGGBB
 * value per pixel. */
const uint32_t *gfx_picture(int which, int *width, int *height);

/* Games use one of two dialects of the drawing commands: the original
 * Fast3D (Super Mario 64) or the later F3DEX (most other games). */
void gfx_set_extended(int is_f3dex);

/* Free look: turn (radians) and zoom applied on top of the game's camera. */
void gfx_set_view(float yaw, float pitch, float zoom);

extern long gfx_triangle_count;

#endif
