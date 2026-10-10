/*
 * Used for any game that has no file of its own in this folder: an empty
 * list of mods, so the F1 menu shows only the settings page.
 *
 * To start on a new game, copy NSME.c to a file named after the game's
 * four-letter code (python3 -m snakedecomp info game.z64 shows it).
 */
#include "mods.h"

Mod game_mods[1];
int game_mod_count = 0;
int (*game_focus)(Context *ctx, float position[3]) = NULL;
int game_ignores_dpad = 0;
int game_stick_follows_camera = 0;
int (*game_paused)(Context *ctx) = NULL;
