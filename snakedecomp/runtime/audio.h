/* Sound synthesis; see audio.c. */
#ifndef AUDIO_H
#define AUDIO_H

#include <stdint.h>

void audio_init(uint8_t *game_ram);

/* Carry out one audio command list. chip_data is the data block of the
 * sound chip's program, which holds a table we need. */
void audio_run(uint32_t commands, uint32_t size, uint32_t chip_data, uint32_t chip_data_size);

#endif
