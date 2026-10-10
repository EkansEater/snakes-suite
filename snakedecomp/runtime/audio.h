/* Sound synthesis; see audio.c. */
#ifndef AUDIO_H
#define AUDIO_H

#include <stdint.h>

void audio_init(uint8_t *game_ram);

/* Carry out one audio command list. chip_data is the data block of the
 * sound chip's program, which holds a table we need. */
void audio_run(uint32_t commands, uint32_t size, uint32_t chip_data, uint32_t chip_data_size);

/* For the summary at the end of a run: how many samples the lists have
 * produced, and how many commands in them we did not know. */
extern long audio_samples_made, audio_commands_unknown;
extern long audio_lists_silent; /* lists not carried out: the sound program's pitch table was not found */
extern long audio_command_counts[32]; /* by command number; which numbers a game uses shows its dialect */

#endif
