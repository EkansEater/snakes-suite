/*
 * Changes made specially for Super Mario 64 (USA).
 *
 * host.c stands in for the console and knows nothing about any one game.
 * This file is the other kind of change: altering what the game itself
 * does. Because every function of the game is now a C function, we can
 * replace one, or wrap it: do something, call the original, undo it.
 */
#include <math.h>

#include "functions.h"

/* How much wider than the original the visible scene is; set by the host. */
extern float host_view_widen;

/*
 * obj_is_in_view decides whether an object is on screen and worth drawing.
 * It assumes the original screen shape, so on a wider picture objects near
 * the sides vanish while still visible. The function works from the
 * camera's field of view, so we widen that number for the duration of the
 * call and let the original code do the rest.
 */
void hle_obj_is_in_view(Context *ctx) {
    uint32_t camera = rd32(ctx, ADDR_gCurGraphNodeCamFrustum);
    if (host_view_widen <= 1 || camera == 0) {
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
