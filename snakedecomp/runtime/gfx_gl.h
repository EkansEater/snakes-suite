/* Drawing with the graphics card; see gfx_gl.c. */
#ifndef GFX_GL_H
#define GFX_GL_H

#include <stdint.h>

/* Call once, with an OpenGL context ready. From then on the renderer draws
 * on the graphics card instead of the CPU. */
void glb_init(void);

/* Copy picture 0 (in-between) or 1 (finished) to the window. */
void glb_present(int which, int window_width, int window_height);

/* The menu and statistics, drawn on top. Positions are in window pixels
 * from the top-left; nothing appears until glb_overlay_finish. */
void glb_overlay_box(int x, int y, int w, int h, int opacity);
void glb_overlay_text(int x, int y, const char *text, int size, int r, int g, int b);
void glb_overlay_finish(void);

/* For test screenshots: the window's contents, 3 bytes per pixel. */
void glb_read_window(uint8_t *rgb, int width, int height);

#endif
