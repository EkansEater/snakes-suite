/*
 * Mods: cheats and fixes for one game that the player can switch on and off
 * in the F1 menu.
 *
 * Each game's file in games/ may provide a list of them (game_mods). The
 * host shows the list, remembers the choices, and carries the mods out. A
 * mod can work in three ways, and may combine them:
 *
 *   pokes        Values written into the game's memory on every screen
 *                refresh while the mod is on. This is how cheat cartridges
 *                such as the GameShark worked: "keep the number of lives at
 *                99" is one byte written over and over.
 *   every_frame  A C function called on every screen refresh while the mod
 *                is on, for anything that needs a condition ("only while
 *                this button is held").
 *   neither      The game's file looks at the mod's "on" itself, usually in
 *                a function that replaces or wraps one of the game's own
 *                (see hle_obj_is_in_view in games/NSME.c).
 */
#ifndef MODS_H
#define MODS_H

#include "runtime.h"

enum { KIND_CHEAT = 1, KIND_FIX = 2 }; /* which page of the menu a mod is on */

typedef struct Poke {
    uint32_t address; /* where in the game's memory */
    int size;         /* how many bytes: 1, 2 or 4 (0 marks an unused entry) */
    uint32_t value;
} Poke;

typedef struct Mod {
    const char *name; /* shown in the menu, and used in the settings file */
    int kind;
    int on;
    Poke pokes[4];
    /* buttons: what is held on the controller right now, as N64 button bits */
    void (*every_frame)(Context *ctx, int buttons);
} Mod;

extern Mod game_mods[];
extern int game_mod_count;

/* 1 if the game never looks at the controller's D-pad. The host then lets
 * the gamepad's D-pad push the control stick (a setting under Controls). */
extern int game_ignores_dpad;

/* 1 if the player steers a character relative to the camera, so that with
 * the free camera turned, the stick should be turned to match. */
extern int game_stick_follows_camera;

/* ---- The free camera (see "Free camera" in host.c) ----------------------------
 * What the game's file gives the host, and what it gets back. */

/* Where the player's character is in the game's world, for the camera to
 * circle. Returns 0 when the camera should be left to the game: there is no
 * character (a title screen, say), or the game is showing a scene of its
 * own. NULL if the game's file does not have one, and then there is no
 * free camera. */
extern int (*game_focus)(Context *ctx, float position[3]);

/* Is the game paused, or in a menu of its own? While it is, the free camera
 * cannot be moved and the control stick is passed to the game untouched.
 * NULL if the game's file cannot tell. */
extern int (*game_paused)(Context *ctx);

typedef struct {
    int on;           /* is the free camera in use just now? */
    float yaw, pitch; /* which way it looks: round the compass, and how far downwards (radians) */
    float distance;   /* how far from the character it would like to be */
    /* How far from the character it can be before something is in the way.
     * The game's file sets this, if it knows where the walls are. */
    float room;
} FreeCamera;
extern FreeCamera host_camera;

/* While the view is turned away from the game's own camera, this is 20, and
 * the game should draw everything rather than only what its own camera can
 * see. Otherwise it is how much wider than the original the picture is. */
extern float host_view_widen;

/* The turn that takes "facing the game's camera" back to "facing the
 * viewer": for flat things that the game keeps turned to its camera. */
extern float host_view_back[3][3];

#endif
