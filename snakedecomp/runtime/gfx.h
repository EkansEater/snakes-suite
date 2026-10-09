/* The renderer's interface; see gfx.c. */
#ifndef GFX_H
#define GFX_H

#include <stdint.h>

/* resolution_scale: 1 draws at the console's 240 lines, 2 at 480, ...
 * aspect: picture shape, width / height (4.0/3 is the original). */
void gfx_init(uint8_t *game_ram, int resolution_scale, float aspect);

/* Change the picture's size and shape later on (between frames). */
void gfx_resize(int resolution_scale, float aspect);

/* The next frame does not follow on from the last one (a save state was
 * loaded): smooth motion must not blend between the two. */
void gfx_forget_last_frame(void);

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

/* The free camera: draw the scene as seen by a camera of our own, which
 * looks at "focus" (a place in the game's world) from "distance" away.
 * yaw is the direction it looks in, round the compass; pitch is how far it
 * looks downwards. With on = 0 the game's own camera is used. */
void gfx_set_free_camera(int on, float yaw, float pitch, float distance, const float focus[3]);

/* Where the game's own camera was in the last frame drawn, in the same
 * terms: the angles and distance from which it saw "focus", and the
 * direction it was facing. Returns 0 if there was no 3D scene. */
int gfx_game_camera(const float focus[3], float *yaw, float *pitch, float *distance, float *facing);

/* The turn that undoes whatever turn the last frame was drawn with (the
 * free camera's, or gfx_set_view's). Games use it to keep flat things
 * facing the viewer. */
void gfx_view_back(float back[3][3]);

extern long gfx_triangle_count;

/* 1: blend neighbouring texture dots where the game asks for it, as the
 * console did. 0: always show them as sharp squares. Can change at any time. */
extern int gfx_texture_smoothing;

#endif
