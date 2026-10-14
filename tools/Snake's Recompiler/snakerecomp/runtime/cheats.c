/*
 * Ready-made cheats ("GameShark codes").
 *
 * A code is two numbers, such as 8033B21D 0064. The first two digits of
 * the first number say what to do, the other six are an address in the
 * game's memory, and the second number is a value:
 *
 *   80 / A0   write the value's low byte at the address, every refresh
 *   81 / A1   write the whole two-byte value
 *   88 / 89   the same two, but only while the "cheat button" is held
 *             (the GameShark had a button on top for these)
 *   F0 / F1   the same two; on the real thing these were written once,
 *             before the game started
 *   D0 / D1   a condition: carry out the NEXT code only if the byte (D0)
 *             or two bytes (D1) at the address equal the value
 *   D2 / D3   ...only if they do NOT equal the value
 *   50        a repeat: 5000NNSS VVVV means "do the next code NN times,
 *             moving its address on by SS and adding VVVV to its value
 *             each time"
 *
 * Writing the same value over and over is what makes "infinite lives":
 * the game takes one away, and a sixtieth of a second later it is back.
 *
 * The files are written by the tools (see cheats.py), from a public
 * collection and from the player's own cheats/ folder.
 */
#include "cheats.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    uint32_t code;
    uint16_t value;
    uint8_t chosen; /* the value comes from the player's choice, not from here */
} Line;
typedef struct { char label[44]; uint16_t value; } Choice;

Cheat *cheats;
int cheat_count;
static Line *lines;
static Choice *choices;
static int line_count, choice_count;

/* Make room for one more thing in a list that grows as needed. */
static void *one_more(void *list, int count, size_t each) {
    if (count % 64 == 0)
        list = realloc(list, (size_t)(count + 64) * each);
    if (!list) {
        fprintf(stderr, "host: out of memory reading cheats\n");
        exit(1);
    }
    memset((char *)list + (size_t)count * each, 0, each);
    return list;
}

/* Copy text, never overflowing, always ending it properly. */
static void copy_text(char *to, size_t room, const char *from, size_t length) {
    if (length >= room)
        length = room - 1;
    memcpy(to, from, length);
    to[length] = 0;
}

/* The end of a code line may list choices: 0001:"One lap",0002:"Two laps" */
static void read_choices(Cheat *cheat, const char *p) {
    while ((p = strchr(p, ':')) != NULL && p[1] == '"') {
        const char *number = p;
        while (number[-1] != ',' && number[-1] != ' ' && number[-1] != '\t')
            number--;
        const char *end = strchr(p + 2, '"');
        if (!end)
            break;
        choices = one_more(choices, choice_count, sizeof *choices);
        choices[choice_count].value = (uint16_t)strtoul(number, NULL, 16);
        copy_text(choices[choice_count].label, sizeof choices[0].label, p + 2, (size_t)(end - p - 2));
        if (!cheat->choice_count)
            cheat->first_choice = choice_count;
        cheat->choice_count++, choice_count++;
        p = end + 1;
    }
}

int cheats_load(const char *path) {
    FILE *file = fopen(path, "r");
    if (!file)
        return 0;
    char text[4096];
    int added = 0;
    Cheat *cheat = NULL;
    while (fgets(text, sizeof text, file)) {
        char *p = text + strspn(text, " \t");
        p[strcspn(p, "\r\n")] = 0;
        if (!strncmp(p, "cn ", 3)) {
            cheats = one_more(cheats, cheat_count, sizeof *cheats);
            cheat = &cheats[cheat_count++];
            copy_text(cheat->name, sizeof cheat->name, p + 3, strlen(p + 3));
            cheat->first_line = line_count;
            added++;
        } else if (!strncmp(p, "cd ", 3) && cheat) {
            copy_text(cheat->note, sizeof cheat->note, p + 3, strlen(p + 3));
        } else if (cheat && strlen(p) >= 13 && p[8] == ' ') {
            char *end;
            uint32_t code = (uint32_t)strtoul(p, &end, 16);
            if (end != p + 8)
                continue;
            lines = one_more(lines, line_count, sizeof *lines);
            lines[line_count].code = code;
            lines[line_count].chosen = !strncmp(p + 9, "????", 4);
            lines[line_count].value = (uint16_t)strtoul(p + 9, NULL, 16);
            if (code >> 24 == 0x88 || code >> 24 == 0x89)
                cheat->needs_button = 1;
            cheat->line_count++, line_count++;
            read_choices(cheat, p + 13);
        }
    }
    fclose(file);
    return added;
}

const char *cheat_state(const Cheat *cheat) {
    if (!cheat->on)
        return "off";
    if (cheat->choice_count && cheat->on - 1 < cheat->choice_count)
        return choices[cheat->first_choice + cheat->on - 1].label;
    return "ON";
}

void cheat_change(Cheat *cheat, int direction) {
    int settings = cheat->choice_count ? cheat->choice_count + 1 : 2; /* off, then each choice */
    if (direction == 0)
        direction = 1;
    cheat->on = (cheat->on + direction + settings) % settings;
}

void cheats_apply(uint8_t *ram, uint32_t ram_size, int button_held) {
    for (int c = 0; c < cheat_count; c++) {
        const Cheat *cheat = &cheats[c];
        if (!cheat->on || (cheat->choice_count && cheat->on > cheat->choice_count))
            continue;
        int repeat = 1, skip = 0;
        uint32_t address_step = 0, value_step = 0;
        for (int i = cheat->first_line; i < cheat->first_line + cheat->line_count; i++) {
            const Line *line = &lines[i];
            uint32_t kind = line->code >> 24, address = line->code & 0x7FFFFF;
            uint32_t value = line->chosen && cheat->choice_count ? choices[cheat->first_choice + cheat->on - 1].value
                                                                 : line->value;
            if (address > ram_size - 2)
                continue;
            if (kind == 0x50) { /* repeat the next code */
                repeat = (int)((line->code >> 8) & 0xFF), address_step = line->code & 0xFF, value_step = line->value;
                continue;
            }
            uint32_t there = kind & 1 ? (uint32_t)(ram[address] << 8 | ram[address + 1]) : ram[address];
            uint32_t wanted = kind & 1 ? value : value & 0xFF;
            if (skip) {
                skip = 0; /* the condition before this code was not met */
            } else if (kind == 0xD0 || kind == 0xD1) {
                skip = there != wanted;
                continue; /* (a repeat applies to the code after the condition) */
            } else if (kind == 0xD2 || kind == 0xD3) {
                skip = there == wanted;
                continue;
            } else if ((kind & 0xF8) == 0x88 && !button_held) {
                /* waits for the cheat button */
            } else if ((kind & 0xFE) == 0x80 || (kind & 0xFE) == 0xA0 || (kind & 0xFE) == 0x88 || (kind & 0xFE) == 0xF0) {
                for (int n = 0; n < repeat; n++) {
                    uint32_t a = address + (uint32_t)n * address_step, v = value + (uint32_t)n * value_step;
                    if (a > ram_size - 2)
                        break;
                    if (kind & 1)
                        ram[a] = (uint8_t)(v >> 8), ram[a + 1] = (uint8_t)v;
                    else
                        ram[a] = (uint8_t)v;
                }
            }
            repeat = 1, address_step = value_step = 0;
        }
    }
}
