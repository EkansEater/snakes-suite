/*
 * The graphics-card back end: draws the renderer's shapes with OpenGL.
 *
 * gfx.c has already done the N64-specific thinking: it gives us triangles
 * and rectangles in screen positions, each with a snapshot of the settings
 * that decide its pixels. Filling in pixels is exactly what a graphics card
 * is built for, and it does millions of them in the time a CPU does
 * thousands.
 *
 * Three ideas carry most of this file:
 *
 *   A "shader" is a small program the card runs for every pixel. Ours is
 *   the N64's colour combiner formula, (A - B) * C + D, with the choices
 *   for A, B, C and D passed in as numbers.
 *
 *   Sending work to the card has a fixed cost per batch, so consecutive
 *   shapes that share all their settings are sent together.
 *
 *   The card keeps its own copies of textures. We convert each N64 texture
 *   to plain RGBA once and remember it, checking a checksum of the original
 *   so that textures the game animates are noticed.
 */
#define GL_GLEXT_PROTOTYPES
#include <GL/gl.h>
#include <GL/glext.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "font.h"
#include "gfx_gl.h"
#include "gfx_internal.h"

/* ---- Shaders ---------------------------------------------------------------- */

static const char *SHAPE_VERTEX_SHADER =
    "#version 330 core\n"
    "layout(location = 0) in vec4 position;\n" /* already where it goes on screen */
    "layout(location = 1) in vec4 color;\n"
    "layout(location = 2) in vec2 uv;\n"
    "layout(location = 3) in float fog;\n"
    "out vec4 v_color; out vec2 v_uv; out float v_fog;\n"
    "void main() { gl_Position = position; v_color = color; v_uv = uv; v_fog = fog; }\n";

/* The colour combiner. Each of A, B, C, D is chosen by a number from the
 * game (see gfx.c for the menu); this is that menu, per pixel. */
static const char *SHAPE_FRAGMENT_SHADER =
    "#version 330 core\n"
    "in vec4 v_color; in vec2 v_uv; in float v_fog;\n"
    "uniform sampler2D tex;\n"
    "uniform int cc[8]; uniform int ac[8];\n" /* choices: 2 cycles x (A, B, C, D) */
    "uniform int first_cycle, use_texture, cutout, use_fog, copy_mode;\n"
    "uniform vec4 prim, env; uniform vec3 fog_color;\n"
    "out vec4 frag;\n"
    "vec3 color_input(int which, int slot, vec4 combined, vec4 texel, vec4 shade) {\n"
    "    if (which == 0) return combined.rgb;\n"
    "    if (which == 1 || which == 2) return texel.rgb;\n"
    "    if (which == 3) return prim.rgb;\n"
    "    if (which == 4) return shade.rgb;\n"
    "    if (which == 5) return env.rgb;\n"
    "    if (slot == 0 || slot == 3) return vec3(which == 6 ? 1.0 : 0.0);\n"
    "    if (slot == 2) {\n"
    "        if (which == 7) return vec3(combined.a);\n"
    "        if (which == 8 || which == 9) return vec3(texel.a);\n"
    "        if (which == 10) return vec3(prim.a);\n"
    "        if (which == 11) return vec3(shade.a);\n"
    "        if (which == 12) return vec3(env.a);\n"
    "    }\n"
    "    return vec3(0.0);\n"
    "}\n"
    "float alpha_input(int which, int slot, vec4 combined, vec4 texel, vec4 shade) {\n"
    "    if (which == 0) return slot == 2 ? 0.0 : combined.a;\n"
    "    if (which == 1 || which == 2) return texel.a;\n"
    "    if (which == 3) return prim.a;\n"
    "    if (which == 4) return shade.a;\n"
    "    if (which == 5) return env.a;\n"
    "    if (which == 6) return slot == 2 ? 0.0 : 1.0;\n"
    "    return 0.0;\n"
    "}\n"
    "void main() {\n"
    "    vec4 texel = use_texture != 0 ? texture(tex, v_uv) : vec4(0.0);\n"
    "    if (copy_mode != 0) {\n" /* straight copy of the texture, with holes */
    "        if (texel.a < 0.5) discard;\n"
    "        frag = vec4(texel.rgb, 1.0);\n"
    "        return;\n"
    "    }\n"
    "    vec4 shade = v_color;\n"
    "    if (use_fog != 0) shade.a = 1.0;\n"
    "    vec4 combined = vec4(0.0);\n"
    "    for (int c = first_cycle; c < 2; c++) {\n"
    "        vec3 a = color_input(cc[c * 4], 0, combined, texel, shade);\n"
    "        vec3 b = color_input(cc[c * 4 + 1], 1, combined, texel, shade);\n"
    "        vec3 m = color_input(cc[c * 4 + 2], 2, combined, texel, shade);\n"
    "        vec3 d = color_input(cc[c * 4 + 3], 3, combined, texel, shade);\n"
    "        float aa = alpha_input(ac[c * 4], 0, combined, texel, shade);\n"
    "        float ab = alpha_input(ac[c * 4 + 1], 1, combined, texel, shade);\n"
    "        float am = alpha_input(ac[c * 4 + 2], 2, combined, texel, shade);\n"
    "        float ad = alpha_input(ac[c * 4 + 3], 3, combined, texel, shade);\n"
    "        combined = clamp(vec4((a - b) * m + d, (aa - ab) * am + ad), 0.0, 1.0);\n"
    "    }\n"
    "    if (cutout != 0) {\n" /* textures with holes: all or nothing */
    "        if (combined.a < 0.3) discard;\n"
    "        combined.a = 1.0;\n"
    "    }\n"
    "    if (use_fog != 0) combined.rgb = mix(combined.rgb, fog_color, v_fog);\n"
    "    frag = combined;\n"
    "}\n";

/* A much simpler pair for the menu and statistics drawn on top. */
static const char *OVERLAY_VERTEX_SHADER =
    "#version 330 core\n"
    "layout(location = 0) in vec2 position; layout(location = 1) in vec2 uv;\n"
    "layout(location = 2) in vec4 color;\n"
    "uniform vec2 window;\n"
    "out vec2 v_uv; out vec4 v_color;\n"
    "void main() {\n"
    "    gl_Position = vec4(position.x / window.x * 2.0 - 1.0, 1.0 - position.y / window.y * 2.0, 0.0, 1.0);\n"
    "    v_uv = uv; v_color = color;\n"
    "}\n";
static const char *OVERLAY_FRAGMENT_SHADER =
    "#version 330 core\n"
    "in vec2 v_uv; in vec4 v_color;\n"
    "uniform sampler2D tex;\n"
    "out vec4 frag;\n"
    "void main() { frag = v_uv.x < 0.0 ? v_color : vec4(v_color.rgb, v_color.a * texture(tex, v_uv).a); }\n";

static GLuint compile(GLenum type, const char *source) {
    GLuint shader = glCreateShader(type);
    glShaderSource(shader, 1, &source, NULL);
    glCompileShader(shader);
    GLint ok;
    glGetShaderiv(shader, GL_COMPILE_STATUS, &ok);
    if (!ok) {
        char log[2048];
        glGetShaderInfoLog(shader, sizeof log, NULL, log);
        fprintf(stderr, "graphics: shader failed to compile:\n%s\n", log);
        exit(1);
    }
    return shader;
}

static GLuint link_program(const char *vertex, const char *fragment) {
    GLuint program = glCreateProgram();
    glAttachShader(program, compile(GL_VERTEX_SHADER, vertex));
    glAttachShader(program, compile(GL_FRAGMENT_SHADER, fragment));
    glLinkProgram(program);
    GLint ok;
    glGetProgramiv(program, GL_LINK_STATUS, &ok);
    if (!ok) {
        fprintf(stderr, "graphics: shader failed to link\n");
        exit(1);
    }
    return program;
}

/* ---- Pictures -----------------------------------------------------------------
 * We do not draw straight into the window. Each of the two pictures (the
 * in-between one and the finished one) is an off-screen "framebuffer" of
 * whatever size was asked for, copied to the window when it is its turn. */

static GLuint framebuffers[2], color_textures[2], depth_buffers[2];
static int picture_w, picture_h;
static GLuint shape_program, overlay_program, vertex_array, vertex_buffer, font_texture;
static struct {
    GLint cc, ac, first_cycle, use_texture, cutout, use_fog, copy_mode, prim, env, fog_color;
} uniform;

static void resize(int width, int height) {
    picture_w = width, picture_h = height;
    for (int i = 0; i < 2; i++) {
        if (!framebuffers[i]) {
            glGenFramebuffers(1, &framebuffers[i]);
            glGenTextures(1, &color_textures[i]);
            glGenRenderbuffers(1, &depth_buffers[i]);
        }
        glBindTexture(GL_TEXTURE_2D, color_textures[i]);
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, width, height, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        glBindRenderbuffer(GL_RENDERBUFFER, depth_buffers[i]);
        glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH_COMPONENT24, width, height);
        glBindFramebuffer(GL_FRAMEBUFFER, framebuffers[i]);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, color_textures[i], 0);
        glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, depth_buffers[i]);
        glDisable(GL_SCISSOR_TEST);
        glDepthMask(GL_TRUE);
        glClearColor(0, 0, 0, 1);
        glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
    }
}

static int current_picture = 1;

static void select_picture(int which) {
    if (which == 0) {
        /* The in-between picture starts as a copy of the last finished one,
         * as the game expects to draw over its previous frame. */
        glBindFramebuffer(GL_READ_FRAMEBUFFER, framebuffers[1]);
        glBindFramebuffer(GL_DRAW_FRAMEBUFFER, framebuffers[0]);
        glDisable(GL_SCISSOR_TEST);
        glBlitFramebuffer(0, 0, picture_w, picture_h, 0, 0, picture_w, picture_h, GL_COLOR_BUFFER_BIT, GL_NEAREST);
    }
    current_picture = which;
}

/* ---- Textures --------------------------------------------------------------- */

typedef struct {
    uint32_t address, row_bytes, palette, checksum;
    int format, size, palette_index, width, height;
    GLuint texture;
} CachedTexture;

#define CACHE_SIZE 1024
static CachedTexture cache[CACHE_SIZE];
static int cache_next;

static GLuint texture_for(const DrawState *d, int *width, int *height) {
    int w, h;
    gfx_texture_size(d, &w, &h);
    *width = w, *height = h;
    uint32_t checksum = gfx_texture_checksum(d, w, h);
    for (int i = 0; i < CACHE_SIZE; i++) {
        CachedTexture *c = &cache[i];
        if (c->texture && c->address == d->loaded.source && c->checksum == checksum &&
            c->row_bytes == d->loaded.row_bytes && c->format == d->tile.format && c->size == d->tile.size &&
            c->palette == d->palette_address && c->palette_index == d->tile.palette && c->width == w &&
            c->height == h)
            return c->texture;
    }
    /* Not seen before (or it changed): convert it and give it to the card,
     * reusing the oldest slot. */
    CachedTexture *c = &cache[cache_next++ % CACHE_SIZE];
    if (!c->texture)
        glGenTextures(1, &c->texture);
    static uint8_t pixels[1024 * 1024 * 4];
    gfx_texture_pixels(d, w, h, pixels);
    glBindTexture(GL_TEXTURE_2D, c->texture);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
    c->address = d->loaded.source, c->row_bytes = d->loaded.row_bytes, c->checksum = checksum;
    c->format = d->tile.format, c->size = d->tile.size;
    c->palette = d->palette_address, c->palette_index = d->tile.palette, c->width = w, c->height = h;
    return c->texture;
}

/* ---- Drawing shapes ----------------------------------------------------------- */

#define FLOATS_PER_VERTEX 11
#define MAX_BATCH_VERTICES 65536
static float *batch;
static int batch_vertices;

static void push_vertex(float x, float y, float z, float w, const float color[4], float u, float v, float fog) {
    float *p = batch + batch_vertices++ * FLOATS_PER_VERTEX;
    p[0] = x, p[1] = y, p[2] = z, p[3] = w;
    memcpy(p + 4, color, 4 * sizeof(float));
    p[8] = u, p[9] = v, p[10] = fog;
}

/* Apply one shape's settings to the card. Returns the texture's size. */
static void apply_state(const Shape *shape, int *texture_w, int *texture_h) {
    const DrawState *d = &shape->state;
    int copy = shape->kind == COPY_RECTANGLE, fill = shape->kind == FILL;
    *texture_w = *texture_h = 1;

    if (d->use_texture && !fill) {
        const Tile *tile = &d->tile;
        glBindTexture(GL_TEXTURE_2D, texture_for(d, texture_w, texture_h));
        GLint filter = d->bilinear && !copy ? GL_LINEAR : GL_NEAREST;
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, filter);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, filter);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S,
                        tile->clamp_s ? GL_CLAMP_TO_EDGE : tile->mirror_s ? GL_MIRRORED_REPEAT : GL_REPEAT);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T,
                        tile->clamp_t ? GL_CLAMP_TO_EDGE : tile->mirror_t ? GL_MIRRORED_REPEAT : GL_REPEAT);
    }

    GLint cc[8], ac[8];
    for (int i = 0; i < 8; i++)
        cc[i] = d->cc[i / 4][i % 4], ac[i] = d->ac[i / 4][i % 4];
    if (fill) { /* a flat colour: "0 * 0 + prim", with prim set to the fill colour */
        for (int i = 0; i < 8; i++)
            cc[i] = i % 4 == 3 ? 3 : 15, ac[i] = i % 4 == 3 ? 6 : 7;
    }
    glUniform1iv(uniform.cc, 8, cc);
    glUniform1iv(uniform.ac, 8, ac);
    glUniform1i(uniform.first_cycle, fill ? 1 : d->first_cycle);
    glUniform1i(uniform.use_texture, d->use_texture && !fill);
    glUniform1i(uniform.cutout, d->cutout && !fill);
    glUniform1i(uniform.use_fog, d->use_fog && !fill);
    glUniform1i(uniform.copy_mode, copy);
    if (fill)
        glUniform4f(uniform.prim, (float)((shape->color >> 16) & 255) / 255, (float)((shape->color >> 8) & 255) / 255,
                    (float)(shape->color & 255) / 255, 1);
    else
        glUniform4f(uniform.prim, (float)d->prim[0] / 255, (float)d->prim[1] / 255, (float)d->prim[2] / 255,
                    (float)d->prim[3] / 255);
    glUniform4f(uniform.env, (float)d->env[0] / 255, (float)d->env[1] / 255, (float)d->env[2] / 255,
                (float)d->env[3] / 255);
    glUniform3f(uniform.fog_color, (float)d->fog[0] / 255, (float)d->fog[1] / 255, (float)d->fog[2] / 255);

    /* See-through shapes are mixed with what is already there. */
    if (d->use_alpha && !fill && !copy) {
        glEnable(GL_BLEND);
        glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
    } else {
        glDisable(GL_BLEND);
    }
    /* Depth: is it hidden behind something, and does it hide what comes after? */
    if (d->depth_test) {
        glEnable(GL_DEPTH_TEST);
        glDepthFunc(d->decal ? GL_LEQUAL : GL_LESS);
    } else if (d->depth_write) {
        glEnable(GL_DEPTH_TEST);
        glDepthFunc(GL_ALWAYS);
    } else {
        glDisable(GL_DEPTH_TEST);
    }
    glDepthMask(d->depth_write ? GL_TRUE : GL_FALSE);
    /* A decal (a shadow, a marking) lies exactly on another surface. Nudge
     * it a hair toward the camera so it reliably wins the depth comparison;
     * the card scales the nudge by the surface's slope for us. */
    if (d->decal) {
        glEnable(GL_POLYGON_OFFSET_FILL);
        glPolygonOffset(-2, -2);
    } else {
        glDisable(GL_POLYGON_OFFSET_FILL);
    }
    glEnable(GL_SCISSOR_TEST); /* the scissor box counts from the bottom-left */
    glScissor(d->scissor[0], picture_h - d->scissor[3], d->scissor[2] - d->scissor[0],
              d->scissor[3] - d->scissor[1]);
}

static void flush(void) {
    if (batch_vertices == 0)
        return;
    glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr)(batch_vertices * FLOATS_PER_VERTEX * (int)sizeof(float)), batch,
                 GL_STREAM_DRAW);
    glDrawArrays(GL_TRIANGLES, 0, batch_vertices);
    batch_vertices = 0;
}

static void draw(const Shape *shapes, int count, int width, int height, int scale) {
    glBindFramebuffer(GL_FRAMEBUFFER, framebuffers[current_picture]);
    glViewport(0, 0, width, height);
    glUseProgram(shape_program);
    glBindVertexArray(vertex_array);
    glBindBuffer(GL_ARRAY_BUFFER, vertex_buffer);
    glActiveTexture(GL_TEXTURE0);
    glEnable(GL_DEPTH_CLAMP); /* things beyond the far distance are drawn, not cut off */

    const Shape *batch_first = NULL;
    int texture_w = 1, texture_h = 1;
    for (int i = 0; i < count; i++) {
        const Shape *s = &shapes[i];
        const DrawState *d = &s->state;

        if (s->kind == DEPTH_CLEAR) { /* reset the depth buffer inside a box */
            flush();
            batch_first = NULL;
            int x0 = s->x0 < d->scissor[0] ? d->scissor[0] : s->x0, x1 = s->x1 > d->scissor[2] ? d->scissor[2] : s->x1;
            int y0 = s->y0 < d->scissor[1] ? d->scissor[1] : s->y0, y1 = s->y1 > d->scissor[3] ? d->scissor[3] : s->y1;
            if (x1 > x0 && y1 > y0) {
                glEnable(GL_SCISSOR_TEST);
                glScissor(x0, height - y1, x1 - x0, y1 - y0);
                glDepthMask(GL_TRUE);
                glClear(GL_DEPTH_BUFFER_BIT);
            }
            continue;
        }

        /* Start a new batch whenever anything about how to draw changes. */
        if (!batch_first || batch_first->kind != s->kind || memcmp(&batch_first->state, d, sizeof *d) != 0 ||
            (s->kind == FILL && batch_first->color != s->color) || batch_vertices + 6 > MAX_BATCH_VERTICES) {
            flush();
            apply_state(s, &texture_w, &texture_h);
            batch_first = s;
        }

        if (s->kind == TRIANGLE) {
            /* Texture positions: the card counts from 0 to 1 across the
             * texture, with texel edges (not centres) at whole steps. */
            float shift = d->bilinear ? 0.5f : 0;
            for (int k = 0; k < 3; k++) {
                const ScreenVertex *v = &s->v[k];
                float w = 1.0f / v->q;
                /* Screen position back to the card's -1..1 space, multiplied
                 * by w so the card can apply perspective to the texture. */
                float x = (v->x / (float)width * 2 - 1) * w, y = (1 - v->y / (float)height * 2) * w;
                float z = (v->z * 2 - 1) * w;
                float color[4] = {v->r / 255, v->g / 255, v->b / 255, v->a / 255};
                push_vertex(x, y, z, w, color, (v->u - (float)d->tile.uls / 4 + shift) / (float)texture_w,
                            (v->v - (float)d->tile.ult / 4 + shift) / (float)texture_h, v->fog / 255);
            }
        } else { /* a rectangle: two triangles */
            float color[4] = {0, 0, 0, 0}; /* no shade on a rectangle: see draw_rectangle in gfx.c */
            int xs[2] = {s->x0, s->x1}, ys[2] = {s->y0, s->y1};
            static const int corners[6][2] = {{0, 0}, {1, 0}, {0, 1}, {1, 0}, {1, 1}, {0, 1}};
            for (int k = 0; k < 6; k++) {
                float px = (float)xs[corners[k][0]], py = (float)ys[corners[k][1]];
                float across = px / (float)scale - s->left, down = py / (float)scale - s->top;
                float u = s->s + (s->flip ? down : across) * s->ds, v = s->t + (s->flip ? across : down) * s->dt;
                push_vertex(px / (float)width * 2 - 1, 1 - py / (float)height * 2, 0, 1, color,
                            (u - (float)d->tile.uls / 4) / (float)texture_w,
                            (v - (float)d->tile.ult / 4) / (float)texture_h, 0);
            }
        }
    }
    flush();
}

/* ---- Showing a picture in the window, and the menu on top ---------------------- */

static int window_w, window_h;
static float *overlay_batch;
static int overlay_vertices;

/* Copy a picture to the window, keeping its shape (black bars if needed). */
void glb_present(int which, int width, int height) {
    window_w = width, window_h = height;
    int w = width, h = width * picture_h / picture_w;
    if (h > height)
        h = height, w = height * picture_w / picture_h;
    int x = (width - w) / 2, y = (height - h) / 2;
    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0);
    glBindFramebuffer(GL_READ_FRAMEBUFFER, framebuffers[which]);
    glDisable(GL_SCISSOR_TEST);
    glViewport(0, 0, width, height);
    glClearColor(0, 0, 0, 1);
    glClear(GL_COLOR_BUFFER_BIT);
    glBlitFramebuffer(0, 0, picture_w, picture_h, x, y, x + w, y + h, GL_COLOR_BUFFER_BIT, GL_LINEAR);
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    overlay_vertices = 0;
}

static void overlay_vertex(float x, float y, float u, float v, const float color[4]) {
    float *p = overlay_batch + overlay_vertices++ * 8;
    p[0] = x, p[1] = y, p[2] = u, p[3] = v;
    memcpy(p + 4, color, 4 * sizeof(float));
}

static void overlay_quad(float x, float y, float w, float h, float u0, float u1, const float color[4]) {
    if (overlay_vertices + 6 > 16384)
        return;
    overlay_vertex(x, y, u0, 0, color), overlay_vertex(x + w, y, u1, 0, color);
    overlay_vertex(x, y + h, u0, 1, color), overlay_vertex(x + w, y, u1, 0, color);
    overlay_vertex(x + w, y + h, u1, 1, color), overlay_vertex(x, y + h, u0, 1, color);
}

/* Positions are in window pixels from the top-left. */
void glb_overlay_box(int x, int y, int w, int h, int opacity) { glb_overlay_bar(x, y, w, h, 0, 0, 0, opacity); }

void glb_overlay_bar(int x, int y, int w, int h, int r, int g, int b, int opacity) {
    float color[4] = {(float)r / 255, (float)g / 255, (float)b / 255, (float)opacity / 255};
    overlay_quad((float)x, (float)y, (float)w, (float)h, -1, -1, color); /* u < 0: no texture */
}

void glb_overlay_text(int x, int y, const char *text, float size, int r, int g, int b) {
    float color[4] = {(float)r / 255, (float)g / 255, (float)b / 255, 1};
    /* (size need not be whole: a letter's place is a whole number of dots all the same, so that text lines up in columns) */
    int letter = (int)(8 * size);
    for (; *text; text++, x += letter) {
        if (*text < 32 || *text > 126)
            continue;
        float u = (float)((*text - 32) * (FONT_W + FONT_GAP) + FONT_GAP / 2) / FONT_PICTURE_W;
        overlay_quad((float)x, (float)y, (float)letter, 16 * size, u, u + (float)FONT_W / FONT_PICTURE_W, color);
    }
}

/* Draw everything queued by the two functions above. */
void glb_overlay_finish(void) {
    if (overlay_vertices == 0)
        return;
    glUseProgram(overlay_program);
    glUniform2f(glGetUniformLocation(overlay_program, "window"), (float)window_w, (float)window_h);
    glDisable(GL_DEPTH_TEST);
    glDisable(GL_POLYGON_OFFSET_FILL);
    glEnable(GL_BLEND);
    glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
    glBindTexture(GL_TEXTURE_2D, font_texture);
    static GLuint array, buffer;
    if (!array) {
        glGenVertexArrays(1, &array);
        glGenBuffers(1, &buffer);
        glBindVertexArray(array);
        glBindBuffer(GL_ARRAY_BUFFER, buffer);
        glEnableVertexAttribArray(0), glEnableVertexAttribArray(1), glEnableVertexAttribArray(2);
        glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 8 * sizeof(float), (void *)0);
        glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, 8 * sizeof(float), (void *)(2 * sizeof(float)));
        glVertexAttribPointer(2, 4, GL_FLOAT, GL_FALSE, 8 * sizeof(float), (void *)(4 * sizeof(float)));
    }
    glBindVertexArray(array);
    glBindBuffer(GL_ARRAY_BUFFER, buffer);
    glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr)(overlay_vertices * 8 * (int)sizeof(float)), overlay_batch, GL_STREAM_DRAW);
    glDrawArrays(GL_TRIANGLES, 0, overlay_vertices);
    overlay_vertices = 0;
}

/* Read back what is in the window (for test screenshots): 3 bytes a pixel,
 * top row first. */
void glb_read_window(uint8_t *rgb, int width, int height) {
    uint8_t *row = malloc((size_t)width * 3);
    glBindFramebuffer(GL_READ_FRAMEBUFFER, 0);
    glPixelStorei(GL_PACK_ALIGNMENT, 1);
    for (int y = 0; y < height; y++) {
        glReadPixels(0, height - 1 - y, width, 1, GL_RGB, GL_UNSIGNED_BYTE, row);
        memcpy(rgb + (size_t)y * (size_t)width * 3, row, (size_t)width * 3);
    }
    free(row);
}

int glb_window_colours(uint32_t *average) {
    enum { ACROSS = 8, DOWN = 6 };
    /* The picture sits in the middle of the window, as in glb_present. */
    int w = window_w, h = window_w * picture_h / (picture_w ? picture_w : 1);
    if (h > window_h)
        h = window_h, w = window_h * picture_w / (picture_h ? picture_h : 1);
    int left = (window_w - w) / 2, bottom = (window_h - h) / 2;
    uint32_t seen[ACROSS * DOWN], sum[3] = {0, 0, 0};
    int different = 0;
    glBindFramebuffer(GL_READ_FRAMEBUFFER, 0);
    glPixelStorei(GL_PACK_ALIGNMENT, 1);
    for (int i = 0; i < ACROSS * DOWN; i++) {
        uint8_t rgb[3] = {0, 0, 0};
        glReadPixels(left + (i % ACROSS * 2 + 1) * w / (ACROSS * 2), bottom + (i / ACROSS * 2 + 1) * h / (DOWN * 2), 1, 1,
                     GL_RGB, GL_UNSIGNED_BYTE, rgb);
        sum[0] += rgb[0], sum[1] += rgb[1], sum[2] += rgb[2];
        /* (nearly the same colour counts as the same: the low bits flicker) */
        uint32_t colour = (uint32_t)(rgb[0] >> 4) << 8 | (uint32_t)(rgb[1] >> 4) << 4 | (uint32_t)(rgb[2] >> 4);
        int known = 0;
        for (int j = 0; j < different; j++)
            known |= seen[j] == colour;
        if (!known)
            seen[different++] = colour;
    }
    *average = sum[0] / (ACROSS * DOWN) << 16 | sum[1] / (ACROSS * DOWN) << 8 | sum[2] / (ACROSS * DOWN);
    return different;
}

/* ---- Start-up ----------------------------------------------------------------- */

static const GfxBackend backend = {resize, select_picture, draw};

void glb_init(void) {
    shape_program = link_program(SHAPE_VERTEX_SHADER, SHAPE_FRAGMENT_SHADER);
    overlay_program = link_program(OVERLAY_VERTEX_SHADER, OVERLAY_FRAGMENT_SHADER);
    glUseProgram(shape_program);
    uniform.cc = glGetUniformLocation(shape_program, "cc");
    uniform.ac = glGetUniformLocation(shape_program, "ac");
    uniform.first_cycle = glGetUniformLocation(shape_program, "first_cycle");
    uniform.use_texture = glGetUniformLocation(shape_program, "use_texture");
    uniform.cutout = glGetUniformLocation(shape_program, "cutout");
    uniform.use_fog = glGetUniformLocation(shape_program, "use_fog");
    uniform.copy_mode = glGetUniformLocation(shape_program, "copy_mode");
    uniform.prim = glGetUniformLocation(shape_program, "prim");
    uniform.env = glGetUniformLocation(shape_program, "env");
    uniform.fog_color = glGetUniformLocation(shape_program, "fog_color");

    batch = malloc(MAX_BATCH_VERTICES * FLOATS_PER_VERTEX * sizeof(float));
    overlay_batch = malloc(16384 * 8 * sizeof(float));
    glGenVertexArrays(1, &vertex_array);
    glGenBuffers(1, &vertex_buffer);
    glBindVertexArray(vertex_array);
    glBindBuffer(GL_ARRAY_BUFFER, vertex_buffer);
    GLsizei stride = FLOATS_PER_VERTEX * sizeof(float);
    for (GLuint i = 0; i < 4; i++)
        glEnableVertexAttribArray(i);
    glVertexAttribPointer(0, 4, GL_FLOAT, GL_FALSE, stride, (void *)0);
    glVertexAttribPointer(1, 4, GL_FLOAT, GL_FALSE, stride, (void *)(4 * sizeof(float)));
    glVertexAttribPointer(2, 2, GL_FLOAT, GL_FALSE, stride, (void *)(8 * sizeof(float)));
    glVertexAttribPointer(3, 1, GL_FLOAT, GL_FALSE, stride, (void *)(10 * sizeof(float)));

    /* The menu font: every character side by side in one picture, much
     * larger than it is usually shown. "Mipmaps" are ready-made half-size,
     * quarter-size... copies, which the card uses to shrink it cleanly. */
    static uint8_t pixels[FONT_H][FONT_PICTURE_W][4];
    for (int y = 0; y < FONT_H; y++)
        for (int x = 0; x < FONT_PICTURE_W; x++) {
            memset(pixels[y][x], 255, 3);
            pixels[y][x][3] = (uint8_t)((font_rows[y][x] - 'A') * 17); /* how solid: 0 to 255 */
        }
    glGenTextures(1, &font_texture);
    glBindTexture(GL_TEXTURE_2D, font_texture);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, FONT_PICTURE_W, FONT_H, 0, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
    glGenerateMipmap(GL_TEXTURE_2D);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR_MIPMAP_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);

    gfx_set_backend(&backend);
}
