/*
 * The game list: a window that shows the ROMs in a folder and starts the one
 * you choose. It works with a keyboard, a mouse or a gamepad, so that games
 * can be tried from the sofa.
 *
 * Along the top are tabs. The first is the list of games; the others are
 * the settings for all games (gamepad, keyboard and mouse, graphics, sound,
 * system), kept in settings/global.txt. A game's own menu changes them for
 * that game alone (see "Settings" in runtime/host.c).
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

#include "controls.h"
#include "font.h"
#include "snake_icon.h"
#include "snake_palette.h" /* the Snake's Suite colours, made by Snake's Suite/shared/sync.py */

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

/* ---- Drawing -----------------------------------------------------------------
 * Everything is text and boxes. Sizes are worked out from the window: about
 * 30 lines of text fit its height whatever its size. "unit" is how many
 * window dots go to one dot of the font, in steps of a quarter; a letter is
 * 8 by 16 of those. */

static SDL_Renderer *renderer;
static SDL_Texture *font;
static float unit = 1.5f;
static int letter, row_height, window_w, window_h, margin;
#define U(n) ((int)((float)(n) * unit)) /* n font dots, in window dots */

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

typedef struct { int r, g, b; } Colour;
/* YELLOW is the "chosen" colour; in the Snake's Suite look that is the snake's green. */
static const Colour WHITE = {SNAKE_FG}, BRIGHT = {SNAKE_FG}, GREY = {SNAKE_FG2}, DIM = {SNAKE_FG3},
                    YELLOW = {SNAKE_HIGHLIGHT}, BLUE = {SNAKE_INFO};

static void text(int x, int y, const char *s, Colour c) {
    SDL_SetTextureColorMod(font, (Uint8)c.r, (Uint8)c.g, (Uint8)c.b);
    for (; *s; s++, x += letter) {
        if (*s <= ' ' || *s > '~')
            continue;
        SDL_Rect from = {(*s - ' ') * (FONT_W + FONT_GAP), 0, FONT_W, FONT_H};
        SDL_FRect to = {(float)x, (float)y, (float)letter, 16 * unit};
        SDL_RenderCopyF(renderer, font, &from, &to);
    }
}

static void box(int x, int y, int w, int h, int r, int g, int b) {
    SDL_Rect rect = {x, y, w, h};
    SDL_SetRenderDrawColor(renderer, (Uint8)r, (Uint8)g, (Uint8)b, 255);
    SDL_RenderFillRect(renderer, &rect);
}

/* ---- The settings for all games -------------------------------------------------
 * global.txt is lines of "name = value". A setting with no line there has
 * the value built into the game program; those are repeated in the tables
 * below so that we can show them (they must agree with restore_defaults and
 * the list in controls.h). */

typedef struct { char key[64], value[48]; } Setting;
#define MAX_SETTINGS 512
static Setting global[MAX_SETTINGS];
static int global_count;
static const char *const global_file = "settings/global.txt";

static void load_global(void) {
    FILE *file = fopen(global_file, "r");
    char line[160];
    global_count = 0;
    while (file && global_count < MAX_SETTINGS && fgets(line, sizeof line, file)) {
        char *equals = strchr(line, '=');
        if (line[0] == '#' || !equals)
            continue;
        char *value = equals + 1 + strspn(equals + 1, " ");
        value[strcspn(value, "\r\n")] = 0;
        while (equals > line && equals[-1] == ' ')
            equals--;
        *equals = 0;
        snprintf(global[global_count].key, sizeof global[0].key, "%s", line);
        snprintf(global[global_count++].value, sizeof global[0].value, "%s", value);
    }
    if (file)
        fclose(file);
}

static void save_global(void) {
    FILE *file = fopen(global_file, "w");
    if (!file)
        return;
    fprintf(file, "# The settings every game starts from. A game's own file, next to this one,\n");
    fprintf(file, "# holds what that game does differently. 1 is on, 0 is off.\n");
    for (int i = 0; i < global_count; i++)
        fprintf(file, "%s = %s\n", global[i].key, global[i].value);
    fclose(file);
}

static const char *global_get(const char *key) {
    for (int i = 0; i < global_count; i++)
        if (!strcmp(global[i].key, key))
            return global[i].value;
    return NULL;
}

static void global_set(const char *key, const char *value) {
    int i = 0;
    while (i < global_count && strcmp(global[i].key, key))
        i++;
    if (i == global_count && global_count < MAX_SETTINGS)
        snprintf(global[global_count++].key, sizeof global[0].key, "%s", key);
    if (i < global_count)
        snprintf(global[i].value, sizeof global[0].value, "%s", value);
}

static void global_forget(const char *key) {
    for (int i = 0; i < global_count; i++)
        if (!strcmp(global[i].key, key))
            global[i--] = global[--global_count];
}

/* The tabs along the top. */
enum { TAB_GAMES, TAB_GAMEPAD, TAB_KEYBOARD, TAB_GRAPHICS, TAB_SOUND, TAB_SYSTEM, TAB_COUNT };
static const char *const tab_names[TAB_COUNT] = {"GAMES", "GAMEPAD", "KEYBOARD", "GRAPHICS", "SOUND", "SYSTEM"};
static int tab;

/* The settings that are a number or a switch: which tab each is on, its
 * name in the file, what to call it, its range, and its built-in value. */
enum { SWITCH, NUMBER };
typedef struct {
    int tab;
    const char *key, *label;
    int kind, least, most, step, usual;
    const char *about; /* a line of help shown when the row is chosen */
} Option;
static const Option options[] = {
    {TAB_GAMEPAD, "stick dead zone", "Stick dead zone", NUMBER, 0, 60, 2, 18, "How far a stick must move before it counts. Raise it if a worn stick drifts."},
    {TAB_GRAPHICS, "wide", "Widescreen (16:9)", SWITCH, 0, 1, 1, 0, "Shows more at the sides instead of stretching the picture."},
    {TAB_GRAPHICS, "scale", "Resolution", NUMBER, 1, 6, 1, 3, "How many times the N64's own 320 by 240 the picture is drawn at."},
    {TAB_GRAPHICS, "fullscreen", "Full screen", SWITCH, 0, 1, 1, 0, "F11 changes this while a game is running."},
    {TAB_GRAPHICS, "smooth", "Smooth motion (60 fps)", SWITCH, 0, 1, 1, 0, "Draws an extra picture between each two of a game that makes 30 a second."},
    {TAB_GRAPHICS, "smooth textures", "Smooth textures", SWITCH, 0, 1, 1, 1, "Off shows the square dots of each texture, as drawn."},
    {TAB_SOUND, "sound", "Sound", SWITCH, 0, 1, 1, 1, ""},
    {TAB_SOUND, "volume", "Volume", NUMBER, 0, 10, 1, 10, ""},
    {TAB_SOUND, "sound buffer", "Buffer", NUMBER, 25, 200, 25, 100, "How much sound is kept ready. Raise it if the sound crackles."},
    {TAB_SYSTEM, "speed limit", "Speed limit (60 Hz)", SWITCH, 0, 1, 1, 1, "Off lets a game run as fast as the PC can go."},
    {TAB_SYSTEM, "fast forward speed", "Fast forward speed", NUMBER, 0, 8, 1, 4, "How fast a game runs while the fast forward key is held."},
    {TAB_SYSTEM, "stats", "Statistics display", SWITCH, 0, 1, 1, 0, "Numbers about speed and sound in the corner. F3 changes this in a game."},
};
#define OPTION_COUNT ((int)(sizeof options / sizeof options[0]))

static int option_value(const Option *o) {
    const char *text = global_get(o->key);
    int value = text ? atoi(text) : o->usual;
    return value < o->least ? o->least : value > o->most ? o->most : value;
}

/* The things that can be given a key or button (controls.h), with what each
 * has to begin with. */
typedef struct { const char *name; int shortcut, usual[DEVICE_COUNT]; } Control;
#define CONTROL(name, button, x, y, shortcut, key, mouse, pad) {name, shortcut, {SDL_SCANCODE_##key, mouse, pad}},
static const Control controls[] = {CONTROL_LIST};
#undef CONTROL
#define CONTROL_COUNT ((int)(sizeof controls / sizeof controls[0]))

static SDL_GameController *pad; /* the gamepad touched last */

/* The key or button a control has for all games. */
static int control_code(int number, int device) {
    char key[64];
    snprintf(key, sizeof key, "%s %s", device_names[device], controls[number].name);
    const char *text = global_get(key);
    return text ? code_from_name(device, text) : controls[number].usual[device];
}

static void control_write(int number, int device, int code) {
    char key[64];
    snprintf(key, sizeof key, "%s %s", device_names[device], controls[number].name);
    global_set(key, control_code_name(device, code, 1, 0));
}

/* Give a control a new key or button. If another was using it, the two
 * change places, so that nothing ever does two things at once. */
static void control_assign(int number, int device, int code) {
    int nothing = device == DEVICE_PAD ? PAD_NONE : 0, was = control_code(number, device);
    for (int i = 0; i < CONTROL_COUNT; i++)
        if (i != number && code != nothing && control_code(i, device) == code)
            control_write(i, device, was);
    control_write(number, device, code);
    save_global();
}

/* A settings tab is a list of rows, built afresh each time it is drawn. */
enum { ROW_HEADING, ROW_OPTION, ROW_CONTROL, ROW_USUAL };
typedef struct {
    int kind, number; /* number: which option or control */
    char label[40], value[40], cells[2][20];
} SettingRow;
#define MAX_ROWS 64
static SettingRow rows[MAX_ROWS];
static int row_count, chosen_row[TAB_COUNT], first_row, cell; /* cell: which of a row's cells is chosen (keyboard, mouse) */
static int waiting; /* the chosen cell is waiting for its new key or button */

static int tab_device(int column) {
    return tab == TAB_GAMEPAD ? DEVICE_PAD : column ? DEVICE_MOUSE : DEVICE_KEY;
}

static void option_text(const Option *o, char *out, size_t room) {
    int v = option_value(o);
    if (o->kind == SWITCH)
        snprintf(out, room, "%s", v ? "ON" : "off");
    else if (!strcmp(o->key, "scale")) {
        const char *wide = global_get("wide");
        snprintf(out, room, "< %dx >   %d x %d", v, (wide && atoi(wide) ? 428 : 320) * v, 240 * v);
    } else if (!strcmp(o->key, "volume"))
        snprintf(out, room, "< %d%% >", v * 10);
    else if (!strcmp(o->key, "sound buffer"))
        snprintf(out, room, "< %d ms >", v);
    else if (!strcmp(o->key, "stick dead zone"))
        snprintf(out, room, "< %d%% >", v);
    else if (!strcmp(o->key, "fast forward speed"))
        snprintf(out, room, v ? "< %dx >" : "< no limit >", v);
    else
        snprintf(out, room, "< %d >", v);
}

static void build_rows(void) {
    row_count = 0;
#define ADD(k, n, ...) (rows[row_count].kind = (k), rows[row_count].number = (n), rows[row_count].value[0] = 0, \
                        snprintf(rows[row_count].label, sizeof rows[0].label, __VA_ARGS__), row_count++)
    if (tab == TAB_GAMEPAD || tab == TAB_KEYBOARD) {
        for (int shortcuts = 0; shortcuts < 2; shortcuts++) {
            ADD(ROW_HEADING, 0, shortcuts ? "SHORTCUTS" : "N64 CONTROLLER");
            for (int i = 0; i < CONTROL_COUNT; i++) {
                if ((controls[i].shortcut != 0) != shortcuts)
                    continue;
                int row = ADD(ROW_CONTROL, i, "%s", controls[i].name);
                for (int column = 0; column < (tab == TAB_GAMEPAD ? 1 : 2); column++) {
                    int device = tab_device(column), asking = waiting && row == chosen_row[tab] && column == cell;
                    snprintf(rows[row].cells[column], sizeof rows[row].cells[column], "%s",
                             asking ? "press..." : control_code_name(device, control_code(i, device), 0, pad_is_playstation(pad)));
                }
            }
        }
    }
    int heading_added = tab != TAB_GAMEPAD; /* (the gamepad tab's switches come under a heading of their own) */
    for (int i = 0; i < OPTION_COUNT; i++)
        if (options[i].tab == tab) {
            if (!heading_added)
                ADD(ROW_HEADING, 0, "OPTIONS"), heading_added = 1;
            int row = ADD(ROW_OPTION, i, "%s", options[i].label);
            option_text(&options[i], rows[row].value, sizeof rows[row].value);
        }
    if (tab != TAB_GAMES)
        ADD(ROW_USUAL, 0, "Put these back to usual");
#undef ADD
    if (chosen_row[tab] >= row_count)
        chosen_row[tab] = row_count - 1;
    while (chosen_row[tab] < row_count - 1 && rows[chosen_row[tab]].kind == ROW_HEADING)
        chosen_row[tab]++;
}

/* Change the chosen row: direction is -1 or +1 (Left, Right), or 0 for
 * "selected" (Enter, A, a click). */
static void change_row(int direction) {
    SettingRow *row = &rows[chosen_row[tab]];
    char text_value[16];
    if (row->kind == ROW_OPTION) {
        const Option *o = &options[row->number];
        int v = option_value(o);
        if (o->kind == SWITCH)
            v = !v;
        else if (direction == 0) /* selecting steps upwards, and round to the start */
            v = v + o->step > o->most ? o->least : v + o->step;
        else
            v += direction * o->step;
        v = v < o->least ? o->least : v > o->most ? o->most : v;
        snprintf(text_value, sizeof text_value, "%d", v);
        global_set(o->key, text_value);
        save_global();
    } else if (row->kind == ROW_CONTROL && direction == 0) {
        waiting = 1; /* the next press is the answer */
    } else if (row->kind == ROW_USUAL && direction == 0) {
        char key[64];
        for (int i = 0; i < OPTION_COUNT; i++)
            if (options[i].tab == tab)
                global_forget(options[i].key);
        for (int i = 0; i < CONTROL_COUNT && (tab == TAB_GAMEPAD || tab == TAB_KEYBOARD); i++)
            for (int column = 0; column < (tab == TAB_GAMEPAD ? 1 : 2); column++) {
                snprintf(key, sizeof key, "%s %s", device_names[tab_device(column)], controls[i].name);
                global_forget(key);
            }
        save_global();
    }
}

/* The chosen cell was waiting for a press and got one. */
static void finish_press(int device, int code) {
    if (!waiting || device != tab_device(cell))
        return; /* not the kind of press that was wanted */
    waiting = 0;
    control_assign(rows[chosen_row[tab]].number, device, code);
}

/* ---- The window's picture -------------------------------------------------------- */

/* A word and a colour for each state (the states are in check.py). */
static const char *const rank_words[] = {"Ready", "In Progress", "Untested", "Broken"};
static const int rank_colours[][3] = {{SNAKE_HIGHLIGHT}, {SNAKE_WARNING}, {SNAKE_INFO}, {SNAKE_ERROR_SOFT}};

static int rows_shown; /* how many rows of the list or the settings fit in the window */
static int list_top;
static int tab_left[TAB_COUNT + 1]; /* where each tab's name starts, for the mouse */
#define CELL_COLUMN 20   /* where a control's cells start, in letters */
#define CELL_WIDTH 16
#define VALUE_COLUMN 28  /* where a setting's value starts */

static void layout(void) {
    SDL_GetRendererOutputSize(renderer, &window_w, &window_h);
    unit = (float)(window_h * 4 / 480) / 4;
    while (unit > 1 && 76 * 8 * unit > (float)window_w)
        unit -= 0.25f;
    unit = unit < 1 ? 1 : unit;
    letter = (int)(8 * unit), margin = 2 * letter;
    row_height = U(18), list_top = U(46);
    rows_shown = (window_h - list_top - U(66)) / row_height;
    rows_shown = rows_shown < 1 ? 1 : rows_shown;
    /* Keep the chosen row in view. */
    int at = tab == TAB_GAMES ? chosen : chosen_row[tab], *first = tab == TAB_GAMES ? &first_shown : &first_row;
    if (at < *first)
        *first = at;
    if (at >= *first + rows_shown)
        *first = at - rows_shown + 1;
    if (*first < 0)
        *first = 0;
}

static void draw_games(void) {
    char line[200];
    int name_room = (window_w - 2 * margin) / letter - 16; /* letters left for the title */
    for (int i = first_shown; i < game_count && i < first_shown + rows_shown; i++) {
        const Game *g = &games[i];
        int y = list_top + (i - first_shown) * row_height, known = g->rank >= 0 && g->rank <= 3;
        if (i == chosen)
            box(margin - letter / 2, y - U(1), window_w - 2 * margin + letter, row_height, SNAKE_SELECTION);
        /* Broken games have their names greyed out. They can still be started. */
        int ready = known && g->rank <= 2;
        const int *c = known ? rank_colours[g->rank] : rank_colours[2];
        text(margin, y, known ? rank_words[g->rank] : "Untested", (Colour){c[0], c[1], c[2]});
        snprintf(line, sizeof line, "%.*s", name_room, g->title);
        text(margin + 13 * letter, y, line, !ready ? (i == chosen ? GREY : DIM) : i == chosen ? YELLOW : BRIGHT);
        if (!g->built)
            text(window_w - margin - 2 * letter, y, "..", GREY); /* not built yet */
    }
    if (game_count == 0) {
        text(margin, list_top, "No games here. Put ROMs (.z64 .n64 .v64 or .zip) in:", BRIGHT);
        text(margin, list_top + row_height, folder, YELLOW);
    }
    /* What we know about the chosen game. */
    int y = window_h - U(62);
    if (chosen < game_count) {
        const Game *g = &games[chosen];
        int room = (window_w - 2 * margin) / letter;
        snprintf(line, sizeof line, "%.*s", room, g->note);
        text(margin, y + U(5), line, BRIGHT);
        snprintf(line, sizeof line, "%d cheats.  %s", g->cheats, g->built ? "Starts straight away." : "First start takes a minute or two.");
        line[room < (int)sizeof line ? room : (int)sizeof line - 1] = 0;
        text(margin, y + U(22), line, GREY);
    }
    text(margin, window_h - U(20), "A/Enter play   X/S sort   Y/F5 refresh   LB/RB/Tab settings   B/Esc quit", GREY);
}

static void draw_settings(void) {
    build_rows();
    int controls_tab = tab == TAB_GAMEPAD || tab == TAB_KEYBOARD;
    for (int i = first_row; i < row_count && i < first_row + rows_shown; i++) {
        const SettingRow *row = &rows[i];
        int y = list_top + (i - first_row) * row_height, selected = i == chosen_row[tab];
        if (row->kind == ROW_HEADING) { /* the name of a group of rows, and of the columns beside it */
            text(margin, y, row->label, BLUE);
            if (tab == TAB_KEYBOARD)
                text(margin + CELL_COLUMN * letter, y, "Keyboard", GREY), text(margin + (CELL_COLUMN + CELL_WIDTH) * letter, y, "Mouse", GREY);
            if (tab == TAB_GAMEPAD && i == 0)
                text(margin + CELL_COLUMN * letter, y, pad ? SDL_GameControllerName(pad) : "(no gamepad switched on)", GREY);
            continue;
        }
        if (selected && row->kind != ROW_CONTROL) /* a bar behind the chosen row... */
            box(margin - letter / 2, y - U(1), window_w - 2 * margin + letter, row_height, SNAKE_SELECTION);
        text(margin + 2 * letter, y, row->label, selected ? YELLOW : BRIGHT);
        if (row->kind == ROW_OPTION)
            text(margin + VALUE_COLUMN * letter, y, row->value, selected ? YELLOW : BRIGHT);
        for (int column = 0; row->kind == ROW_CONTROL && column < (tab == TAB_GAMEPAD ? 1 : 2); column++) {
            int x = margin + (CELL_COLUMN + column * CELL_WIDTH) * letter, here = selected && column == cell;
            if (here) /* ...or behind the chosen cell */
                box(x - letter / 2, y - U(1), CELL_WIDTH * letter, row_height, SNAKE_SELECTION);
            text(x, y, row->cells[column], here ? YELLOW : !strcmp(row->cells[column], "-") ? DIM : BRIGHT);
        }
    }
    int y = window_h - U(62);
    const SettingRow *row = &rows[chosen_row[tab]];
    text(margin, y + U(5), row->kind == ROW_OPTION ? options[row->number].about : "", BRIGHT);
    text(margin, y + U(22), "For all games. A game's own menu changes these for that game alone.", GREY);
    const char *help = "Arrows choose, change   A/Enter select   LB/RB/Tab pages   B/Esc games";
    if (waiting)
        help = tab == TAB_GAMEPAD ? "Press a gamepad button.   Backspace: none   Esc: cancel"
               : cell ? "Press a mouse button.   Backspace: none   Esc: cancel" : "Press a key.   Backspace: none   Esc: cancel";
    else if (controls_tab && row->kind == ROW_CONTROL)
        help = "Arrows choose   A/Enter change   LB/RB/Tab pages   B/Esc games";
    text(margin, window_h - U(20), help, GREY);
}

static void draw(const char *banner, const char *banner_detail) {
    layout();
    SDL_SetRenderDrawColor(renderer, SNAKE_BG, 255);
    SDL_RenderClear(renderer);
    char line[200];

    text(margin, U(5), "SNAKE'S DECOMPILER", WHITE);
    snprintf(line, sizeof line, "%d games, %s", game_count, order_words[order]);
    text(window_w - margin - (int)strlen(line) * letter, U(5), line, GREY);
    /* The tabs: the one we are on has a bar under its name. */
    int x = margin;
    for (int i = 0; i < TAB_COUNT; i++) {
        tab_left[i] = x - letter;
        text(x, U(24), tab_names[i], i == tab ? YELLOW : GREY);
        if (i == tab)
            box(x, U(41), (int)strlen(tab_names[i]) * letter, U(2), SNAKE_ACCENT);
        x += ((int)strlen(tab_names[i]) + 3) * letter;
    }
    tab_left[TAB_COUNT] = x - letter;
    box(margin, U(43), window_w - 2 * margin, U(1), SNAKE_BORDER2);
    box(margin, window_h - U(62), window_w - 2 * margin, U(1), SNAKE_BORDER2);

    if (tab == TAB_GAMES)
        draw_games();
    else
        draw_settings();
    int count = tab == TAB_GAMES ? game_count : row_count, first = tab == TAB_GAMES ? first_shown : first_row;
    if (first > 0 || first + rows_shown < count) { /* say where we are in a list too long to show */
        snprintf(line, sizeof line, "%d/%d", (tab == TAB_GAMES ? chosen : chosen_row[tab]) + 1, count);
        text(window_w - margin - (int)strlen(line) * letter, window_h - U(20), line, GREY);
    }

    if (banner) { /* a message over the top of everything: "getting ready" */
        int w = window_w * 3 / 4, h = U(70), bx = (window_w - w) / 2, top = (window_h - h) / 2;
        box(bx - U(1), top - U(1), w + U(2), h + U(2), SNAKE_BORDER2);
        box(bx, top, w, h, SNAKE_WIDGET);
        snprintf(line, sizeof line, "%.*s", w / letter - 4, banner);
        text(bx + 2 * letter, top + U(14), line, WHITE);
        snprintf(line, sizeof line, "%.*s", w / letter - 4, banner_detail);
        text(bx + 2 * letter, top + U(40), line, GREY);
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
    read_list();   /* it is built now */
    load_global(); /* (and its menu may have changed the settings for all games) */
    return 1;
}

/* ---- Input ------------------------------------------------------------------- */

/* Move up or down the list on show: the games, or a settings tab's rows
 * (passing over the names of groups). */
static void move(int by) {
    if (tab == TAB_GAMES) {
        if (game_count == 0)
            return;
        chosen += by;
        chosen = chosen < 0 ? 0 : chosen >= game_count ? game_count - 1 : chosen;
        return;
    }
    int to = chosen_row[tab], step = by < 0 ? -1 : 1;
    for (int left = abs(by); left > 0; left--) {
        int next = to + step;
        while (next >= 0 && next < row_count && rows[next].kind == ROW_HEADING)
            next += step;
        if (next < 0 || next >= row_count)
            break;
        to = next;
    }
    chosen_row[tab] = to;
}

static void go_to_tab(int to) {
    tab = (to + TAB_COUNT) % TAB_COUNT;
    waiting = 0, cell = 0, first_row = 0;
    if (tab != TAB_GAMES)
        build_rows();
}

/* Left and Right: a page of the games list, the other cell of a keyboard
 * row, or a setting's value down and up. */
static void sideways(int direction) {
    if (tab == TAB_GAMES)
        move(direction * rows_shown);
    else if (rows[chosen_row[tab]].kind == ROW_CONTROL)
        cell = tab == TAB_KEYBOARD ? (direction > 0) : 0;
    else
        change_row(direction);
}

/* The pointer is in window units and the drawing in dots; on some screens those differ. */
static void pointer_in_dots(int *x, int *y) {
    int w, h;
    SDL_GetWindowSize(window, &w, &h);
    if (w > 0 && h > 0)
        *x = *x * window_w / w, *y = *y * window_h / h;
}

/* Which row of the list on show is under the pointer, or -1. */
static int row_at(int x, int y) {
    pointer_in_dots(&x, &y);
    int row = y >= list_top ? (y - list_top) / row_height : -1;
    int count = tab == TAB_GAMES ? game_count : row_count, first = tab == TAB_GAMES ? first_shown : first_row;
    if (row < 0 || row >= rows_shown || first + row >= count)
        return -1;
    return tab != TAB_GAMES && rows[first + row].kind == ROW_HEADING ? -1 : first + row;
}

/* Which tab's name is under the pointer, or -1. */
static int tab_at(int x, int y) {
    pointer_in_dots(&x, &y);
    if (y < U(20) || y >= U(44))
        return -1;
    for (int i = 0; i < TAB_COUNT; i++)
        if (x >= tab_left[i] && x < tab_left[i + 1])
            return i;
    return -1;
}

/* The pointer chooses the row it is over (and, on a keyboard row, the cell). */
static void point_at(int x, int y) {
    int row = row_at(x, y);
    if (row < 0 || waiting)
        return;
    if (tab == TAB_GAMES) {
        chosen = row;
        return;
    }
    chosen_row[tab] = row;
    pointer_in_dots(&x, &y);
    if (tab == TAB_KEYBOARD && rows[row].kind == ROW_CONTROL)
        cell = x >= margin + (CELL_COLUMN + CELL_WIDTH) * letter - letter / 2;
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
    /* A name the desktop knows our window by (otherwise it would be the
     * program file's name, "launcher"). The desktop can then keep settings for
     * it: on KDE with Wayland that is how the window's place on the screen
     * is remembered, by a window rule (see "Where the windows open" in
     * README.md), since there a program cannot place its own window. */
    setenv("SDL_VIDEO_WAYLAND_WMCLASS", "snakes-n64-decompiler-list", 0);
    setenv("SDL_VIDEO_X11_WMCLASS", "snakes-n64-decompiler-list", 0);
    SDL_SetHint("SDL_APP_ID", "snakes-n64-decompiler-list");
    if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_GAMECONTROLLER) != 0) {
        fprintf(stderr, "launcher: %s\n", SDL_GetError());
        return 1;
    }
    load_memory();
    int place = window_placed && positions_work() && on_a_screen(window_x0, window_y0);
    window = SDL_CreateWindow("Snake's Decompiler", place ? window_x0 : SDL_WINDOWPOS_CENTERED,
                              place ? window_y0 : SDL_WINDOWPOS_CENTERED, window_w0, window_h0,
                              SDL_WINDOW_RESIZABLE | SDL_WINDOW_ALLOW_HIGHDPI | (window_maximised ? SDL_WINDOW_MAXIMIZED : 0) |
                                  (fullscreen && !getenv("LAUNCHER_SHOT") ? SDL_WINDOW_FULLSCREEN_DESKTOP : 0));
    if (window) {
        SDL_Surface *icon = SDL_CreateRGBSurfaceWithFormatFrom((void *)snake_icon_rgba, 64, 64, 32, 64 * 4, SDL_PIXELFORMAT_RGBA32);
        if (icon) {
            SDL_SetWindowIcon(window, icon);
            SDL_FreeSurface(icon);
        }
    }
    renderer = window ? SDL_CreateRenderer(window, -1, SDL_RENDERER_ACCELERATED | SDL_RENDERER_PRESENTVSYNC) : NULL;
    if (!renderer) {
        fprintf(stderr, "launcher: %s\n", SDL_GetError());
        return 1;
    }
    make_font();
    load_global();
    draw("Looking for games...", folder);
    read_list();
    if (getenv("LAUNCHER_SHOT")) { /* for testing: draw once, save the picture, stop */
        if (getenv("LAUNCHER_TAB")) /* 0 games, 1 gamepad, 2 keyboard, 3 graphics, 4 sound, 5 system */
            go_to_tab(atoi(getenv("LAUNCHER_TAB")));
        if (getenv("LAUNCHER_ROW"))
            move(atoi(getenv("LAUNCHER_ROW")));
        if (getenv("LAUNCHER_CHANGE")) /* press Right this many times on the chosen row */
            for (int i = atoi(getenv("LAUNCHER_CHANGE")); i > 0; i--)
                sideways(1);
        if (getenv("LAUNCHER_BIND")) /* give the chosen control this key or button, as if it had been pressed */
            build_rows(), waiting = 1, finish_press(tab_device(cell), atoi(getenv("LAUNCHER_BIND")));
        if (getenv("LAUNCHER_ORDER")) /* 0 by state, 1 by name, 2 worst first */
            order = atoi(getenv("LAUNCHER_ORDER")) % ORDER_COUNT, sort_list();
        draw(NULL, NULL);
        draw(NULL, NULL); /* (twice: the picture read back is the one before last) */
        SDL_Surface *shot = SDL_CreateRGBSurfaceWithFormat(0, window_w, window_h, 32, SDL_PIXELFORMAT_ARGB8888);
        SDL_RenderReadPixels(renderer, NULL, SDL_PIXELFORMAT_ARGB8888, shot->pixels, shot->pitch);
        SDL_SaveBMP(shot, getenv("LAUNCHER_SHOT"));
        return 0;
    }

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
            case SDL_CONTROLLERAXISMOTION: {
                int far = abs(event.caxis.value) > 20000, positive = event.caxis.value > 0;
                if (abs(event.caxis.value) > 16000)
                    pad = SDL_GameControllerFromInstanceID(event.caxis.which);
                /* A stick pushed or a trigger pulled can be the answer for
                 * a gamepad cell that is waiting. */
                if (!waiting || !far || tab != TAB_GAMEPAD)
                    break;
                switch (event.caxis.axis) {
                case SDL_CONTROLLER_AXIS_LEFTX: finish_press(DEVICE_PAD, positive ? PAD_LSTICK_RIGHT : PAD_LSTICK_LEFT); break;
                case SDL_CONTROLLER_AXIS_LEFTY: finish_press(DEVICE_PAD, positive ? PAD_LSTICK_DOWN : PAD_LSTICK_UP); break;
                case SDL_CONTROLLER_AXIS_RIGHTX: finish_press(DEVICE_PAD, positive ? PAD_RSTICK_RIGHT : PAD_RSTICK_LEFT); break;
                case SDL_CONTROLLER_AXIS_RIGHTY: finish_press(DEVICE_PAD, positive ? PAD_RSTICK_DOWN : PAD_RSTICK_UP); break;
                case SDL_CONTROLLER_AXIS_TRIGGERLEFT: finish_press(DEVICE_PAD, PAD_LEFT_TRIGGER); break;
                case SDL_CONTROLLER_AXIS_TRIGGERRIGHT: finish_press(DEVICE_PAD, PAD_RIGHT_TRIGGER); break;
                }
                held = 2; /* (the push that answered is not also a move down the list) */
                break;
            }
            case SDL_KEYDOWN: {
                SDL_Scancode key = event.key.keysym.scancode;
                if (waiting) { /* a cell is waiting for its key or button */
                    if (key == SDL_SCANCODE_ESCAPE)
                        waiting = 0;
                    else if (key == SDL_SCANCODE_BACKSPACE) /* "nothing" */
                        finish_press(tab_device(cell), tab == TAB_GAMEPAD ? PAD_NONE : 0);
                    else if (tab == TAB_KEYBOARD && cell == 0 && !event.key.repeat)
                        finish_press(DEVICE_KEY, (int)key);
                    break;
                }
                switch (key) {
                case SDL_SCANCODE_UP: move(-1); break;
                case SDL_SCANCODE_DOWN: move(1); break;
                case SDL_SCANCODE_LEFT: sideways(-1); break;
                case SDL_SCANCODE_RIGHT: sideways(1); break;
                case SDL_SCANCODE_PAGEUP: move(-rows_shown); break;
                case SDL_SCANCODE_PAGEDOWN: move(rows_shown); break;
                case SDL_SCANCODE_HOME: move(-MAX_GAMES); break;
                case SDL_SCANCODE_END: move(MAX_GAMES); break;
                case SDL_SCANCODE_TAB: go_to_tab(tab + ((SDL_GetModState() & KMOD_SHIFT) ? -1 : 1)); break;
                case SDL_SCANCODE_RETURN: case SDL_SCANCODE_KP_ENTER: case SDL_SCANCODE_SPACE: go = !event.key.repeat; break;
                case SDL_SCANCODE_ESCAPE:
                    if (tab == TAB_GAMES)
                        running = 0;
                    else
                        go_to_tab(TAB_GAMES);
                    break;
                case SDL_SCANCODE_F5: read_list(), load_global(); break;
                case SDL_SCANCODE_S:
                    if (tab == TAB_GAMES)
                        next_order();
                    break;
                case SDL_SCANCODE_F11:
                    fullscreen = !fullscreen;
                    SDL_SetWindowFullscreen(window, fullscreen ? SDL_WINDOW_FULLSCREEN_DESKTOP : 0);
                    save_memory();
                    break;
                default: break;
                }
                break;
            }
            case SDL_CONTROLLERBUTTONDOWN:
                pad = SDL_GameControllerFromInstanceID(event.cbutton.which);
                if (waiting) {
                    if (tab == TAB_GAMEPAD)
                        finish_press(DEVICE_PAD, event.cbutton.button);
                    held = 2;
                    break;
                }
                switch (event.cbutton.button) {
                case SDL_CONTROLLER_BUTTON_A: case SDL_CONTROLLER_BUTTON_START: go = 1; break;
                case SDL_CONTROLLER_BUTTON_B:
                    if (tab == TAB_GAMES)
                        running = 0;
                    else
                        go_to_tab(TAB_GAMES);
                    break;
                case SDL_CONTROLLER_BUTTON_Y: read_list(), load_global(); break;
                case SDL_CONTROLLER_BUTTON_X:
                    if (tab == TAB_GAMES)
                        next_order();
                    break;
                case SDL_CONTROLLER_BUTTON_LEFTSHOULDER: go_to_tab(tab - 1); break;
                case SDL_CONTROLLER_BUTTON_RIGHTSHOULDER: go_to_tab(tab + 1); break;
                case SDL_CONTROLLER_BUTTON_DPAD_LEFT: sideways(-1); break;
                case SDL_CONTROLLER_BUTTON_DPAD_RIGHT: sideways(1); break;
                default: break;
                }
                break;
            case SDL_MOUSEWHEEL:
                if (!waiting)
                    move(event.wheel.y > 0 ? -1 : 1);
                break;
            case SDL_MOUSEMOTION: point_at(event.motion.x, event.motion.y); break;
            case SDL_MOUSEBUTTONDOWN:
                if (waiting) { /* a mouse cell takes the button; any other cell is left waiting */
                    if (tab == TAB_KEYBOARD && cell == 1)
                        finish_press(DEVICE_MOUSE, event.button.button);
                    break;
                }
                if (event.button.button != SDL_BUTTON_LEFT)
                    break;
                if (tab_at(event.button.x, event.button.y) >= 0)
                    go_to_tab(tab_at(event.button.x, event.button.y));
                else if (row_at(event.button.x, event.button.y) >= 0)
                    point_at(event.button.x, event.button.y), go = 1;
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
        if (waiting || held == 2) { /* a stick still out after answering a cell, or while one waits, moves nothing */
            held = waiting || direction ? 2 : 0;
        } else if (direction != held) {
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
        if (go && tab != TAB_GAMES) { /* on a settings tab, "play" means "change this row" */
            change_row(0);
            go = 0;
            armed = 0, armed_after = SDL_GetTicks() + 150; /* (and the same press is not also the answer) */
        }
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
