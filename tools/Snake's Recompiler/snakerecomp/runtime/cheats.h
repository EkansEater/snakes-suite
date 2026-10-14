/* Ready-made cheats, read from a file when the game starts; see cheats.c. */
#ifndef CHEATS_H
#define CHEATS_H

#include <stdint.h>

typedef struct Cheat {
    char name[72];
    char note[120];  /* a remark from whoever wrote the cheat, shown under the menu */
    /* 0 = off. Otherwise 1, or for a cheat with choices, 1 + which choice. */
    int on;
    int first_line, line_count;     /* its codes, in cheat_lines */
    int first_choice, choice_count; /* its choices, in cheat_choices (often none) */
    int needs_button;               /* some of its codes only act while the cheat button is held */
} Cheat;

extern Cheat *cheats;
extern int cheat_count;

/* Add the cheats in a file to the list. Returns how many it added. */
int cheats_load(const char *path);

/* Carry out every cheat that is on. Call once per screen refresh. */
void cheats_apply(uint8_t *ram, uint32_t ram_size, int button_held);

/* What to show beside a cheat in the menu: "off", "ON", or its chosen value's name. */
const char *cheat_state(const Cheat *cheat);

/* Step a cheat to its next setting (direction 1) or previous one (-1);
 * 0 switches it between off and on. */
void cheat_change(Cheat *cheat, int direction);

#endif
