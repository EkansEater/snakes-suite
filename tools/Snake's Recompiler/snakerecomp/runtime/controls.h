/*
 * What can be pressed, and what it is called.
 *
 * Shared by the game (host.c), whose menu sets the controls of one game, and
 * the game list (launcher/launcher.c), whose settings pages set them for all
 * games. Both must agree on the list of things that can be done, on what
 * each is given to begin with, and on how a key or button is written in a
 * settings file, so all of that lives here.
 */
#ifndef CONTROLS_H
#define CONTROLS_H

#include <SDL.h>
#include <string.h>

/* Each thing that can be done may be given a keyboard key, a mouse button
 * and a gamepad button. */
enum { DEVICE_KEY, DEVICE_MOUSE, DEVICE_PAD, DEVICE_COUNT };
static const char *const device_names[DEVICE_COUNT] = {"key", "mouse", "pad"}; /* as written in a settings file */

/* What can be chosen on a gamepad: SDL's numbered buttons, and after them
 * the two triggers and the eight stick directions, which SDL counts as
 * sticks ("axes") and we give numbers of our own. -1 means "nothing". */
enum {
    PAD_NONE = -1,
    PAD_LEFT_TRIGGER = SDL_CONTROLLER_BUTTON_MAX, PAD_RIGHT_TRIGGER,
    PAD_LSTICK_UP, PAD_LSTICK_DOWN, PAD_LSTICK_LEFT, PAD_LSTICK_RIGHT,
    PAD_RSTICK_UP, PAD_RSTICK_DOWN, PAD_RSTICK_LEFT, PAD_RSTICK_RIGHT,
    PAD_CODE_COUNT
};
#define PAD(name) SDL_CONTROLLER_BUTTON_##name

enum {
    NOT_A_SHORTCUT, SHORTCUT_FAST, SHORTCUT_SAVE, SHORTCUT_LOAD, SHORTCUT_LOOK, SHORTCUT_CAMERA_RESET,
    SHORTCUT_CAMERA_NEARER, SHORTCUT_CAMERA_FARTHER, SHORTCUT_CHEAT, SHORTCUT_PICTURE, SHORTCUT_COUNT
};

/* The list. Each line is something that can be done: a button or stick
 * direction of the N64 controller, or a shortcut (something the PC does
 * rather than the game).
 *
 *   CONTROL(name, N64 button, stick x, stick y, shortcut,  key, mouse button, gamepad button)
 *
 * The last three are what it is given to begin with; the mouse buttons are
 * 0 none, 1 left, 2 middle, 3 right. Whoever includes this file says what a
 * CONTROL line turns into, and may leave out the parts it has no use for. */
#define CONTROL_LIST \
    CONTROL("Stick up", 0, 0, 1, 0, W, 0, PAD_LSTICK_UP) \
    CONTROL("Stick down", 0, 0, -1, 0, S, 0, PAD_LSTICK_DOWN) \
    CONTROL("Stick left", 0, -1, 0, 0, A, 0, PAD_LSTICK_LEFT) \
    CONTROL("Stick right", 0, 1, 0, 0, D, 0, PAD_LSTICK_RIGHT) \
    CONTROL("A", BTN_A, 0, 0, 0, J, 0, PAD(A)) \
    CONTROL("B", BTN_B, 0, 0, 0, K, 0, PAD(X)) \
    CONTROL("Z", BTN_Z, 0, 0, 0, L, 0, PAD(LEFTSHOULDER)) \
    CONTROL("Start", BTN_START, 0, 0, 0, RETURN, 0, PAD(START)) \
    CONTROL("C up", BTN_CUP, 0, 0, 0, UP, 0, PAD_RSTICK_UP) \
    CONTROL("C down", BTN_CDOWN, 0, 0, 0, DOWN, 0, PAD_RSTICK_DOWN) \
    CONTROL("C left", BTN_CLEFT, 0, 0, 0, LEFT, 0, PAD_RSTICK_LEFT) \
    CONTROL("C right", BTN_CRIGHT, 0, 0, 0, RIGHT, 0, PAD_RSTICK_RIGHT) \
    CONTROL("L", BTN_L, 0, 0, 0, Q, 0, PAD(Y)) \
    CONTROL("R", BTN_R, 0, 0, 0, E, 0, PAD(RIGHTSHOULDER)) \
    CONTROL("D-pad up", BTN_DUP, 0, 0, 0, UNKNOWN, 0, PAD(DPAD_UP)) \
    CONTROL("D-pad down", BTN_DDOWN, 0, 0, 0, UNKNOWN, 0, PAD(DPAD_DOWN)) \
    CONTROL("D-pad left", BTN_DLEFT, 0, 0, 0, UNKNOWN, 0, PAD(DPAD_LEFT)) \
    CONTROL("D-pad right", BTN_DRIGHT, 0, 0, 0, UNKNOWN, 0, PAD(DPAD_RIGHT)) \
    /* (No gamepad button to begin with: the right trigger used to be it, and \
     * is where a hand rests, so games ran four times too fast with the sound \
     * cutting out, and it looked like a fault.) */ \
    CONTROL("Fast forward", 0, 0, 0, SHORTCUT_FAST, TAB, 0, PAD_NONE) \
    CONTROL("Save state", 0, 0, 0, SHORTCUT_SAVE, F5, 0, PAD_NONE) \
    CONTROL("Load state", 0, 0, 0, SHORTCUT_LOAD, F7, 0, PAD_NONE) \
    CONTROL("Look (hold)", 0, 0, 0, SHORTCUT_LOOK, UNKNOWN, 3, PAD_NONE) \
    CONTROL("Reset camera", 0, 0, 0, SHORTCUT_CAMERA_RESET, UNKNOWN, 2, PAD(RIGHTSTICK)) \
    CONTROL("Camera nearer", 0, 0, 0, SHORTCUT_CAMERA_NEARER, PAGEUP, 0, PAD(DPAD_UP)) \
    CONTROL("Camera farther", 0, 0, 0, SHORTCUT_CAMERA_FARTHER, PAGEDOWN, 0, PAD(DPAD_DOWN)) \
    /* Some ready-made cheats only act while this is held ("Press GS for..."). */ \
    CONTROL("Cheat button", 0, 0, 0, SHORTCUT_CHEAT, G, 0, PAD_NONE) \
    /* Saves what is on screen as a picture file. */ \
    CONTROL("Screenshot", 0, 0, 0, SHORTCUT_PICTURE, F12, 0, PAD(LEFTSTICK))

/* The names of gamepad buttons differ between makes, so we show the ones
 * printed on the gamepad that is plugged in. */
static int pad_is_playstation(SDL_GameController *pad) {
    if (!pad)
        return 0;
    SDL_GameControllerType type = SDL_GameControllerGetType(pad);
    return type == SDL_CONTROLLER_TYPE_PS3 || type == SDL_CONTROLLER_TYPE_PS4 || type == SDL_CONTROLLER_TYPE_PS5;
}
static const char *pad_label(int code, int playstation) {
    static const char *xbox[PAD_CODE_COUNT] = {
        "A", "B", "X", "Y", "View", "Guide", "Menu", "LS click", "RS click", "LB", "RB",
        "D-pad up", "D-pad down", "D-pad left", "D-pad right", "Share", "Paddle 1", "Paddle 2", "Paddle 3",
        "Paddle 4", "Touchpad",
        [PAD_LEFT_TRIGGER] = "LT", "RT", "L stick up", "L stick down", "L stick left", "L stick right",
        "R stick up", "R stick down", "R stick left", "R stick right"};
    static const char *sony[PAD_CODE_COUNT] = {
        "Cross", "Circle", "Square", "Triangle", "Share", "PS", "Options", "L3", "R3", "L1", "R1",
        [PAD_LEFT_TRIGGER] = "L2", "R2"};
    if (code < 0 || code >= PAD_CODE_COUNT)
        return "-";
    const char *name = playstation && sony[code] ? sony[code] : xbox[code];
    return name ? name : "?";
}
/* A settings file uses names that do not depend on the gamepad's make. */
static const char *const pad_file_names[] = {"lefttrigger", "righttrigger", "lstick-up", "lstick-down", "lstick-left",
                                             "lstick-right", "rstick-up", "rstick-down", "rstick-left", "rstick-right"};
static const char *const mouse_names[] = {"-", "Left", "Middle", "Right", "Back", "Forward"};

/* A key, mouse button or gamepad button as text. for_file: the name used in
 * a settings file rather than the one shown in a menu (which, for a
 * gamepad, is the one printed on the make of gamepad in use). */
static const char *control_code_name(int device, int code, int for_file, int playstation) {
    const char *nothing = for_file ? "(none)" : "-"; /* ("-" in a file would be the minus key) */
    if (device == DEVICE_KEY)
        return code == SDL_SCANCODE_UNKNOWN ? nothing : SDL_GetScancodeName((SDL_Scancode)code);
    if (device == DEVICE_MOUSE)
        return code >= 1 && code <= 5 ? mouse_names[code] : nothing;
    if (code < 0 || code >= PAD_CODE_COUNT)
        return nothing;
    if (!for_file)
        return pad_label(code, playstation);
    return code >= PAD_LEFT_TRIGGER ? pad_file_names[code - PAD_LEFT_TRIGGER]
                                    : SDL_GameControllerGetStringForButton((SDL_GameControllerButton)code);
}
static int code_from_name(int device, const char *name) {
    if (device == DEVICE_KEY)
        return (int)SDL_GetScancodeFromName(name); /* gives "no key" for anything it does not know */
    if (device == DEVICE_MOUSE) {
        for (int i = 1; i <= 5; i++)
            if (!strcmp(name, mouse_names[i]))
                return i;
        return 0;
    }
    for (int i = 0; i < PAD_CODE_COUNT - PAD_LEFT_TRIGGER; i++)
        if (!strcmp(name, pad_file_names[i]))
            return PAD_LEFT_TRIGGER + i;
    return (int)SDL_GameControllerGetButtonFromString(name); /* -1 for anything it does not know */
}

#endif
