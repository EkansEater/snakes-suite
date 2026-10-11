/*
 * The game list: a window that shows the ROMs in a folder and starts the one
 * you choose. It works with a keyboard, a mouse or a gamepad, so that games
 * can be tried from the sofa.
 *
 *   usage: launcher <folder of ROMs>
 *
 * It knows nothing about ROMs itself. It asks the Python tools for the list
 * ("python3 -m snakedecomp list <folder>", one line per game), and to start
 * a game it runs the same commands you could type:
 *
 *   python3 -m snakedecomp build <rom>     translate and compile, if needed
 *   python3 -m snakedecomp run <rom>       play
 *
 * While the first is working we show a "getting ready" screen; while the
 * second is running our window is hidden, and it comes back when the game
 * is quit.
 */
#include <SDL.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#include "font.h"

/* ---- The list ---------------------------------------------------------------- */

typedef struct {
    char path[512], title[80], note[120];
    int rank;   /* its state: 0 Ready, 1 In Progress, 2 Untested, 3 Broken (see check.py) */
    int cheats; /* how many ready-made cheats it has */
    int built;  /* has it been translated and compiled already? */
} Game;

#define MAX_GAMES 512
static Game games[MAX_GAMES];
static int game_count, chosen, first_shown;
static SDL_Window *window;
static const char *folder;

/* The orders the list can be put in. S (or X on a gamepad) steps through
 * them, and the choice is remembered in a small file for next time, along
 * with the size and place of this window. */
enum { BY_STATE, BY_NAME, WORST_FIRST, ORDER_COUNT };
static const char *const order_words[] = {"by state", "by name", "worst first"};
static const char *const memory_file = "settings/launcher.txt";
static int order = BY_STATE;
/* The window as it was last: its ordinary size and place (not counting
 * maximised or full screen, which are remembered as such). On a Wayland
 * desktop a program cannot find out or choose where its window is, so there
 * only the size is kept. */
static int window_w0 = 960, window_h0 = 720, window_x0, window_y0, window_placed, window_maximised, fullscreen;

static int in_order(const void *a, const void *b) {
    const Game *x = a, *y = b;
    if (order != BY_NAME && x->rank != y->rank)
        return order == WORST_FIRST ? y->rank - x->rank : x->rank - y->rank;
    return strcasecmp(x->title, y->title);
}

/* Put the list in the chosen order, staying on the same game. */
static void sort_list(void) {
    char was[512] = "";
    if (chosen < game_count)
        strcpy(was, games[chosen].path);
    qsort(games, (size_t)game_count, sizeof games[0], in_order);
    chosen = 0;
    for (int i = 0; i < game_count; i++)
        if (!strcmp(games[i].path, was))
            chosen = i;
}

static void load_memory(void) {
    FILE *file = fopen(memory_file, "r");
    char line[120];
    int number, w, h;
    while (file && fgets(line, sizeof line, file)) {
        if (sscanf(line, "order = %d", &number) == 1 && number >= 0 && number < ORDER_COUNT)
            order = number;
        if (sscanf(line, "size = %d %d", &w, &h) == 2 && w >= 320 && h >= 240 && w < 16000 && h < 16000)
            window_w0 = w, window_h0 = h;
        if (sscanf(line, "position = %d %d", &window_x0, &window_y0) == 2)
            window_placed = 1;
        sscanf(line, "maximised = %d", &window_maximised);
        sscanf(line, "fullscreen = %d", &fullscreen);
    }
    if (file)
        fclose(file);
}

static void save_memory(void) {
    FILE *file = fopen(memory_file, "w");
    if (!file)
        return;
    fprintf(file, "# The game list: its order and where its window was. Written by the list.\n");
    fprintf(file, "order = %d\n", order);
    fprintf(file, "size = %d %d\n", window_w0, window_h0);
    if (window_placed)
        fprintf(file, "position = %d %d\n", window_x0, window_y0);
    fprintf(file, "maximised = %d\nfullscreen = %d\n", window_maximised, fullscreen);
    fclose(file);
}

static void next_order(void) {
    order = (order + 1) % ORDER_COUNT;
    sort_list();
    save_memory();
}

/* Copy one tab-separated part of a line; returns where the next one starts. */
static char *part(char *from, char *to, size_t room) {
    size_t length = strcspn(from, "\t\r\n");
    snprintf(to, room, "%.*s", (int)length, from);
    return from[length] == '\t' ? from + length + 1 : from + length;
}

static void read_list(void) {
    char command[700], line[1024], number[16], was[512] = "";
    if (chosen < game_count)
        strcpy(was, games[chosen].path); /* stay on the same game afterwards */
    snprintf(command, sizeof command, "python3 -m snakedecomp list '%s'", folder);
    FILE *list = popen(command, "r");
    game_count = 0;
    while (list && game_count < MAX_GAMES && fgets(line, sizeof line, list)) {
        Game *g = &games[game_count];
        char *p = part(line, g->path, sizeof g->path);
        p = part(p, g->title, sizeof g->title);
        p = part(p, number, sizeof number), g->rank = atoi(number);
        p = part(p, g->note, sizeof g->note);
        p = part(p, number, sizeof number), g->cheats = atoi(number);
        part(p, number, sizeof number), g->built = atoi(number);
        if (g->path[0] && g->title[0])
            game_count++;
    }
    if (list)
        pclose(list);
    /* (sort_list keeps its place by the game at "chosen", which the fresh
     * list has just overwritten: so find the old game first) */
    chosen = game_count;
    for (int i = 0; i < game_count; i++)
        if (!strcmp(games[i].path, was))
            chosen = i;
    sort_list();
}

/* ---- Drawing ----------------------------------------------------------------- */

static SDL_Renderer *renderer;
static SDL_Texture *font;
static int size = 2; /* text size: a letter is 8 x 16 dots times this */

/* Turn the font's picture (see font.h) into something the graphics card can
 * draw from: white letters, see-through where there is no letter. */
static void make_font(void) {
    Uint32 *pixels = malloc(sizeof(Uint32) * FONT_PICTURE_W * FONT_H);
    for (int y = 0; y < FONT_H; y++)
        for (int x = 0; x < FONT_PICTURE_W; x++)
            pixels[y * FONT_PICTURE_W + x] = 0x00FFFFFFu | (Uint32)((font_rows[y][x] - 'A') * 17) << 24;
    font = SDL_CreateTexture(renderer, SDL_PIXELFORMAT_ARGB8888, SDL_TEXTUREACCESS_STATIC, FONT_PICTURE_W, FONT_H);
    SDL_UpdateTexture(font, NULL, pixels, FONT_PICTURE_W * 4);
    SDL_SetTextureBlendMode(font, SDL_BLENDMODE_BLEND);
    SDL_SetTextureScaleMode(font, SDL_ScaleModeLinear);
    free(pixels);
}

static void text(int x, int y, const char *s, int r, int g, int b) {
    SDL_SetTextureColorMod(font, (Uint8)r, (Uint8)g, (Uint8)b);
    for (; *s; s++, x += 8 * size) {
        if (*s <= ' ' || *s > '~')
            continue;
        SDL_Rect from = {(*s - ' ') * (FONT_W + FONT_GAP), 0, FONT_W, FONT_H};
        SDL_Rect to = {x, y, 8 * size, 16 * size};
        SDL_RenderCopy(renderer, font, &from, &to);
    }
}

static void box(int x, int y, int w, int h, int r, int g, int b) {
    SDL_Rect rect = {x, y, w, h};
    SDL_SetRenderDrawColor(renderer, (Uint8)r, (Uint8)g, (Uint8)b, 255);
    SDL_RenderFillRect(renderer, &rect);
}

/* A word and a colour for each rank. */
static const char *const rank_words[] = {"Ready", "In Progress", "Untested", "Broken"};
static const int rank_colours[][3] = {{110, 255, 120}, {255, 200, 90}, {150, 190, 255}, {255, 90, 90}};

static int rows_shown; /* how many games fit in the window */
static int row_height, list_top, window_w, window_h;

static void layout(void) {
    SDL_GetRendererOutputSize(renderer, &window_w, &window_h);
    size = (window_h + 180) / 360; /* about 22 lines, whatever the window's size */
    while (size > 1 && 58 * 8 * size > window_w)
        size--;
    size = size < 1 ? 1 : size;
    row_height = 20 * size, list_top = 30 * size;
    rows_shown = (window_h - list_top - 78 * size) / row_height;
    rows_shown = rows_shown < 1 ? 1 : rows_shown;
    /* Keep the chosen game in view. */
    if (chosen < first_shown)
        first_shown = chosen;
    if (chosen >= first_shown + rows_shown)
        first_shown = chosen - rows_shown + 1;
}

static void draw(const char *banner, const char *banner_detail) {
    layout();
    SDL_SetRenderDrawColor(renderer, 14, 16, 24, 255);
    SDL_RenderClear(renderer);
    int letter = 8 * size, margin = 2 * letter;
    char line[200];

    text(margin, 6 * size, "SNAKE'S N64 DECOMPILER", 255, 255, 255);
    snprintf(line, sizeof line, "%d games, %s (X/S)", game_count, order_words[order]);
    text(window_w - margin - (int)strlen(line) * letter, 6 * size, line, 130, 130, 140);
    box(margin, 25 * size, window_w - 2 * margin, size, 70, 70, 80);

    int name_room = (window_w - 2 * margin) / letter - 15; /* letters left for the title */
    for (int i = first_shown; i < game_count && i < first_shown + rows_shown; i++) {
        const Game *g = &games[i];
        int y = list_top + (i - first_shown) * row_height, known = g->rank >= 0 && g->rank <= 3;
        if (i == chosen)
            box(margin - letter / 2, y - size, window_w - 2 * margin + letter, row_height - size, 50, 56, 80);
        /* Broken games have their names greyed out. They can still be started. */
        int ready = known && g->rank <= 2;
        const int *colour = known ? rank_colours[g->rank] : (const int[]){95, 95, 105};
        text(margin, y, known ? rank_words[g->rank] : "Untested", colour[0], colour[1], colour[2]);
        snprintf(line, sizeof line, "%.*s", name_room, g->title);
        int bright = !ready ? (i == chosen ? 150 : 95) : i == chosen ? 255 : 205;
        text(margin + 12 * letter, y, line, bright, bright, ready && i == chosen ? 120 : bright + (ready ? 0 : 10));
        if (!g->built)
            text(window_w - margin - 2 * letter, y, "..", 120, 120, 130); /* not built yet */
    }
    if (game_count == 0 && !banner) {
        text(margin, list_top, "No games here. Put ROMs (.z64 .n64 .v64 or .zip) in:", 230, 230, 230);
        text(margin, list_top + row_height, folder, 255, 255, 120);
    }

    /* What we know about the chosen game. */
    int y = window_h - 72 * size;
    box(margin, y, window_w - 2 * margin, size, 70, 70, 80);
    if (chosen < game_count) {
        const Game *g = &games[chosen];
        int room = (window_w - 2 * margin) / letter;
        snprintf(line, sizeof line, "%.*s", room, g->note);
        text(margin, y + 6 * size, line, 230, 230, 230);
        snprintf(line, sizeof line, "%d cheats.  %s", g->cheats,
                 g->built ? "Starts straight away." : "First start takes a minute or two.");
        line[room < (int)sizeof line ? room : (int)sizeof line - 1] = 0;
        text(margin, y + 24 * size, line, 150, 150, 160);
        if (first_shown > 0 || first_shown + rows_shown < game_count) {
            snprintf(line, sizeof line, "%d/%d", chosen + 1, game_count);
            text(window_w - margin - (int)strlen(line) * letter, y - 18 * size, line, 130, 130, 140);
        }
    }
    text(margin, window_h - 22 * size, "A/Enter play  B/Esc quit  Y/F5 refresh  F11 full screen", 130, 130, 140);

    if (banner) { /* a message over the top of everything: "getting ready" */
        int w = window_w * 3 / 4, h = 70 * size, x = (window_w - w) / 2, top = (window_h - h) / 2;
        box(x - size, top - size, w + 2 * size, h + 2 * size, 120, 120, 140);
        box(x, top, w, h, 24, 28, 44);
        snprintf(line, sizeof line, "%.*s", w / letter - 4, banner);
        text(x + 2 * letter, top + 14 * size, line, 255, 255, 255);
        snprintf(line, sizeof line, "%.*s", w / letter - 4, banner_detail);
        text(x + 2 * letter, top + 40 * size, line, 170, 170, 180);
    }
    SDL_RenderPresent(renderer);
}

/* ---- Starting a game ----------------------------------------------------------- */

static pid_t start(const char *what, const char *rom) {
    pid_t child = fork();
    if (child == 0) {
        execlp("python3", "python3", "-m", "snakedecomp", what, rom, (char *)NULL);
        _exit(127);
    }
    return child;
}

/* Has the child finished? Returns -1 while it has not, else how it ended (0 = well). */
static int finished(pid_t child) {
    int status;
    if (waitpid(child, &status, WNOHANG) != child)
        return -1;
    return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
}

/* Returns 0 if the window was closed meanwhile. */
static int play(const Game *game) {
    char title[160], dots[8];
    int result, quit = 0;
    snprintf(title, sizeof title, "Getting %s ready", game->title);
    pid_t child = start("build", game->path);
    for (int tick = 0; (result = finished(child)) < 0; tick++) {
        SDL_Event event;
        while (SDL_PollEvent(&event))
            quit |= event.type == SDL_QUIT;
        if (quit) { /* stop the build too */
            kill(child, SIGTERM);
            waitpid(child, NULL, 0);
            return 0;
        }
        snprintf(dots, sizeof dots, "%.*s", 1 + tick / 4 % 3, "...");
        char detail[120];
        snprintf(detail, sizeof detail, "%s%s", game->built ? "Checking it is up to date" : "Translating and compiling: a minute or two",
                 dots);
        draw(title, detail);
        SDL_Delay(100);
    }
    if (result != 0) {
        for (int tick = 0; tick < 50 && !quit; tick++) { /* five seconds, or until a press */
            SDL_Event event;
            while (SDL_PollEvent(&event))
                quit |= event.type == SDL_KEYDOWN || event.type == SDL_CONTROLLERBUTTONDOWN || event.type == SDL_MOUSEBUTTONDOWN;
            draw("That game could not be built.", "The terminal this was started from says why.");
            SDL_Delay(100);
        }
        return 1;
    }
    /* Out of the way while the game has the screen. Our window gets no
     * keyboard or mouse then, but gamepad presses reach every program, so
     * whatever arrives meanwhile is thrown away afterwards. */
    SDL_HideWindow(window);
    child = start("run", game->path);
    while (finished(child) < 0) {
        SDL_PumpEvents();
        SDL_Delay(100);
    }
    SDL_ShowWindow(window);
    SDL_RaiseWindow(window);
    SDL_FlushEvents(SDL_FIRSTEVENT, SDL_LASTEVENT);
    read_list(); /* it is built now */
    return 1;
}

/* ---- Input ------------------------------------------------------------------- */

static void move(int by) {
    if (game_count == 0)
        return;
    chosen += by;
    chosen = chosen < 0 ? 0 : chosen >= game_count ? game_count - 1 : chosen;
}

/* Which game is under the mouse pointer, or -1. (The pointer is in window
 * units and the drawing in dots; on some screens those differ.) */
static int game_at(int mouse_y) {
    int w, h;
    SDL_GetWindowSize(window, &w, &h);
    int y = h > 0 ? mouse_y * window_h / h : mouse_y;
    int row = y >= list_top ? (y - list_top) / row_height : -1;
    return row >= 0 && row < rows_shown && first_shown + row < game_count ? first_shown + row : -1;
}

static int positions_work(void) {
    return strcmp(SDL_GetCurrentVideoDriver(), "wayland") != 0;
}

/* The window was moved or resized: note how it is now. Returns 1 if that
 * differs from what we had. */
static int note_window(void) {
    Uint32 flags = SDL_GetWindowFlags(window);
    int before[5] = {window_w0, window_h0, window_x0, window_y0, window_maximised};
    if (!(flags & SDL_WINDOW_FULLSCREEN))
        window_maximised = (flags & SDL_WINDOW_MAXIMIZED) != 0;
    if (!(flags & (SDL_WINDOW_FULLSCREEN | SDL_WINDOW_MAXIMIZED | SDL_WINDOW_MINIMIZED | SDL_WINDOW_HIDDEN))) {
        int w, h;
        SDL_GetWindowSize(window, &w, &h);
        if (w >= 320 && h >= 240)
            window_w0 = w, window_h0 = h;
        if (positions_work())
            SDL_GetWindowPosition(window, &window_x0, &window_y0), window_placed = 1;
    }
    int now[5] = {window_w0, window_h0, window_x0, window_y0, window_maximised};
    return memcmp(before, now, sizeof now) != 0;
}

/* Is this spot on a screen that is plugged in now? */
static int on_a_screen(int x, int y) {
    for (int i = 0; i < SDL_GetNumVideoDisplays(); i++) {
        SDL_Rect area;
        if (SDL_GetDisplayBounds(i, &area) == 0 && x + 80 >= area.x && x + 80 < area.x + area.w && y >= area.y &&
            y + 40 < area.y + area.h)
            return 1;
    }
    return 0;
}

int main(int argc, char **argv) {
    folder = argc > 1 ? argv[1] : "roms";
    if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_GAMECONTROLLER) != 0) {
        fprintf(stderr, "launcher: %s\n", SDL_GetError());
        return 1;
    }
    load_memory();
    int place = window_placed && positions_work() && on_a_screen(window_x0, window_y0);
    window = SDL_CreateWindow("Snake's N64 decompiler", place ? window_x0 : SDL_WINDOWPOS_CENTERED,
                              place ? window_y0 : SDL_WINDOWPOS_CENTERED, window_w0, window_h0,
                              SDL_WINDOW_RESIZABLE | SDL_WINDOW_ALLOW_HIGHDPI | (window_maximised ? SDL_WINDOW_MAXIMIZED : 0) |
                                  (fullscreen && !getenv("LAUNCHER_SHOT") ? SDL_WINDOW_FULLSCREEN_DESKTOP : 0));
    renderer = window ? SDL_CreateRenderer(window, -1, SDL_RENDERER_ACCELERATED | SDL_RENDERER_PRESENTVSYNC) : NULL;
    if (!renderer) {
        fprintf(stderr, "launcher: %s\n", SDL_GetError());
        return 1;
    }
    make_font();
    draw("Looking for games...", folder);
    read_list();
    if (getenv("LAUNCHER_SHOT")) { /* for testing: draw once, save the picture, stop */
        if (getenv("LAUNCHER_ROW"))
            move(atoi(getenv("LAUNCHER_ROW")));
        if (getenv("LAUNCHER_ORDER")) /* 0 by state, 1 by name, 2 worst first */
            order = atoi(getenv("LAUNCHER_ORDER")) % ORDER_COUNT, sort_list();
        draw(NULL, NULL);
        draw(NULL, NULL); /* (twice: the picture read back is the one before last) */
        SDL_Surface *shot = SDL_CreateRGBSurfaceWithFormat(0, window_w, window_h, 32, SDL_PIXELFORMAT_ARGB8888);
        SDL_RenderReadPixels(renderer, NULL, SDL_PIXELFORMAT_ARGB8888, shot->pixels, shot->pitch);
        SDL_SaveBMP(shot, getenv("LAUNCHER_SHOT"));
        return 0;
    }

    SDL_GameController *pad = NULL;
    /* A direction held down moves once, then after a pause keeps moving. */
    int held = 0;
    Uint32 next_repeat = 0;
    int running = 1;
    int window_changed = 0; /* the window's size or place wants writing down... */
    Uint32 window_changed_at = 0; /* ...once it has stopped changing */
    int armed = 0; /* may "play" be acted on yet? See further down. */
    Uint32 armed_after = 0;
    while (running) {
        int go = 0;
        SDL_Event event;
        while (SDL_PollEvent(&event)) {
            switch (event.type) {
            case SDL_QUIT: running = 0; break;
            case SDL_WINDOWEVENT:
                if ((event.window.event == SDL_WINDOWEVENT_SIZE_CHANGED || event.window.event == SDL_WINDOWEVENT_MOVED ||
                     event.window.event == SDL_WINDOWEVENT_MAXIMIZED || event.window.event == SDL_WINDOWEVENT_RESTORED) &&
                    note_window())
                    window_changed = 1, window_changed_at = SDL_GetTicks();
                break;
            case SDL_CONTROLLERDEVICEADDED: /* plugged in, or a wireless one woke up */
                /* Every gamepad is opened, so that a press on any of them
                 * arrives; "pad" is whichever was touched last. */
                if (SDL_GameControllerOpen(event.cdevice.which) && !pad)
                    pad = SDL_GameControllerFromInstanceID(SDL_JoystickGetDeviceInstanceID(event.cdevice.which));
                break;
            case SDL_CONTROLLERDEVICEREMOVED:
                if (pad == SDL_GameControllerFromInstanceID(event.cdevice.which))
                    pad = NULL;
                if (SDL_GameControllerFromInstanceID(event.cdevice.which))
                    SDL_GameControllerClose(SDL_GameControllerFromInstanceID(event.cdevice.which));
                break;
            case SDL_CONTROLLERAXISMOTION:
                if (abs(event.caxis.value) > 16000)
                    pad = SDL_GameControllerFromInstanceID(event.caxis.which);
                break;
            case SDL_KEYDOWN:
                switch (event.key.keysym.scancode) {
                case SDL_SCANCODE_UP: move(-1); break;
                case SDL_SCANCODE_DOWN: move(1); break;
                case SDL_SCANCODE_PAGEUP: move(-rows_shown); break;
                case SDL_SCANCODE_PAGEDOWN: move(rows_shown); break;
                case SDL_SCANCODE_HOME: move(-MAX_GAMES); break;
                case SDL_SCANCODE_END: move(MAX_GAMES); break;
                case SDL_SCANCODE_RETURN: case SDL_SCANCODE_KP_ENTER: case SDL_SCANCODE_SPACE: go = !event.key.repeat; break;
                case SDL_SCANCODE_ESCAPE: running = 0; break;
                case SDL_SCANCODE_F5: read_list(); break;
                case SDL_SCANCODE_S: next_order(); break;
                case SDL_SCANCODE_F11:
                    fullscreen = !fullscreen;
                    SDL_SetWindowFullscreen(window, fullscreen ? SDL_WINDOW_FULLSCREEN_DESKTOP : 0);
                    save_memory();
                    break;
                default: break;
                }
                break;
            case SDL_CONTROLLERBUTTONDOWN:
                pad = SDL_GameControllerFromInstanceID(event.cbutton.which);
                switch (event.cbutton.button) {
                case SDL_CONTROLLER_BUTTON_A: case SDL_CONTROLLER_BUTTON_START: go = 1; break;
                case SDL_CONTROLLER_BUTTON_B: running = 0; break;
                case SDL_CONTROLLER_BUTTON_Y: read_list(); break;
                case SDL_CONTROLLER_BUTTON_X: next_order(); break;
                case SDL_CONTROLLER_BUTTON_LEFTSHOULDER: move(-rows_shown); break;
                case SDL_CONTROLLER_BUTTON_RIGHTSHOULDER: move(rows_shown); break;
                default: break;
                }
                break;
            case SDL_MOUSEWHEEL: move(event.wheel.y > 0 ? -1 : 1); break;
            case SDL_MOUSEMOTION:
                if (game_at(event.motion.y) >= 0)
                    chosen = game_at(event.motion.y);
                break;
            case SDL_MOUSEBUTTONDOWN:
                if (event.button.button == SDL_BUTTON_LEFT && game_at(event.button.y) >= 0)
                    chosen = game_at(event.button.y), go = 1;
                break;
            }
        }
        /* The D-pad and the left stick: up and down, repeating while held. */
        int direction = 0;
        if (pad) {
            int stick = SDL_GameControllerGetAxis(pad, SDL_CONTROLLER_AXIS_LEFTY);
            direction = SDL_GameControllerGetButton(pad, SDL_CONTROLLER_BUTTON_DPAD_UP) || stick < -16000 ? -1
                        : SDL_GameControllerGetButton(pad, SDL_CONTROLLER_BUTTON_DPAD_DOWN) || stick > 16000 ? 1 : 0;
        }
        Uint32 now = SDL_GetTicks();
        if (direction != held) {
            held = direction;
            move(direction);
            next_repeat = now + 350;
        } else if (direction && now >= next_repeat) {
            move(direction);
            next_repeat = now + 80;
        }

        /* Coming back from a game, the button that quit it is usually still
         * down (A on "Yes, quit", or Enter), and as our window returns the
         * system tells us about it as if it had just been pressed, which
         * would start the game again, and again every time it was quit. So
         * after a game nothing counts as "play" until a moment has passed
         * and every play button has been let go. */
        int play_held = SDL_GetKeyboardState(NULL)[SDL_SCANCODE_RETURN] || SDL_GetKeyboardState(NULL)[SDL_SCANCODE_SPACE] ||
                        SDL_GetKeyboardState(NULL)[SDL_SCANCODE_KP_ENTER] || (SDL_GetMouseState(NULL, NULL) & SDL_BUTTON_LMASK) ||
                        (pad && (SDL_GameControllerGetButton(pad, SDL_CONTROLLER_BUTTON_A) ||
                                 SDL_GameControllerGetButton(pad, SDL_CONTROLLER_BUTTON_START)));
        if (!armed) {
            go = 0;
            armed = now >= armed_after && !play_held;
        }
        if (getenv("LAUNCHER_TEST")) /* for testing: start the chosen game by itself, once */
            go = 1;
        if (go && chosen < game_count) {
            if (!play(&games[chosen]) || getenv("LAUNCHER_TEST"))
                running = 0;
            held = direction; /* (a direction still held is not a new push) */
            armed = 0, armed_after = SDL_GetTicks() + 500;
        }
        if (window_changed && SDL_GetTicks() - window_changed_at > 500)
            window_changed = 0, save_memory();
        draw(NULL, NULL);
        SDL_Delay(8);
    }
    if (window_changed)
        save_memory();
    SDL_Quit();
    return 0;
}
