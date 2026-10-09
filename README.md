# Snake's Decompiler

Turns a Nintendo 64 game ROM into a program that runs directly on your PC,
with no emulator. It reads the game's machine code, translates every function
to C, compiles it, and runs it against stand-ins for the console's operating
system, graphics chip, sound chip and controllers.

This is a learning project. It is not finished and it does not run every game.

**No games are included.** You need your own ROM, dumped from a cartridge you
own. Nothing in this project is, or contains, Nintendo's code or data.

## What works

| Game | State |
|---|---|
| Super Mario 64 (USA) | Playable: picture, sound, controls, saving |
| Mario Kart 64 (USA) | Boots, title, menus, attract-mode race; not played further |

Other games may start, or may stop with a line beginning `game stopped:`.

## Requirements

Linux, with:

- Python 3.10 or newer
- gcc
- SDL2 and OpenGL development files
- a graphics card with OpenGL 3.3

`./play` checks for these and tells you what to install.

## Playing

```bash
./play path/to/your-game.z64
```

Or put ROMs in the `roms/` folder and run `./play` on its own. The first run
of each game translates and compiles it, which takes a minute or two. Later
runs start straight away.

### Controls

| N64 | Keyboard | Gamepad (Xbox / PlayStation names) |
|---|---|---|
| Control stick | W A S D | Left stick |
| A | J or Space | A / Cross |
| B | K | X / Square |
| Z | L or Left Shift | LB / L1 |
| Start | Enter | Menu / Options |
| C buttons | Arrow keys | Right stick |
| R | E | RB / R1 |
| L | Q | Y / Triangle |
| D-pad | not set | D-pad |

Super Mario 64 never uses the N64's D-pad, so there the gamepad's D-pad also
pushes the control stick, which lets it work the game's own menus (the pause
screen, file select). "D-pad" under Controls switches that.

Every row can be given a keyboard key, a mouse button and a gamepad button
in the menu, under Controls: move to a cell, press Enter, then press what
you want there. The menu shows the names printed on the gamepad that is
plugged in. Gamepads can be connected at any time, including over Bluetooth.

**Free camera.** It is off to begin with. Switch on "Free camera", the
first row under Controls. The right stick then takes over the camera: it
circles the character, stays where you put it, and stops at walls, floors
and ceilings instead of going through them. The control stick moves
relative to what you see. Click the right stick to hand the camera back to
the game. (The C buttons then need other buttons, if you want them on the
gamepad.) Holding the right mouse button and moving the mouse does the
same. Page Up and Page Down (D-pad up and down on a gamepad, or the mouse
wheel) move the camera nearer and farther; like everything else, those can
be changed under Shortcuts. It turns most
smoothly with "Smooth motion (60 fps)" on; without it the view can only
change 30 times a second, like the game. So far only Super Mario 64 has
this; in other games the view simply turns on the spot.

### While playing

- **Esc** or **F1** (Select on a gamepad): the menu. The game keeps running
  behind it, and every choice takes effect straight away. Arrow keys (d-pad)
  move and change, Enter (A) selects, Esc (B) goes back.

  | Page | What is on it |
  |---|---|
  | Save states | Choose one of 9 slots, save, load |
  | Graphics | Widescreen, resolution, full screen, 60 fps smooth motion, smooth textures |
  | Sound | On/off, volume, buffer (raise it if the sound crackles) |
  | Controls | Keyboard key, mouse button and gamepad button for each N64 button; free camera |
  | Shortcuts | The same for fast forward, save state, load state, look, reset camera, camera nearer and farther |
  | Cheats, Fixes | For games that have them (see below) |
  | System | Speed limit, fast forward speed, statistics, put every setting back to usual |
  | Reset game | Starts the game again from the beginning |
  | Quit | |

  Everything chosen here is remembered for next time, separately for each
  game, in `settings/`.
- **Tab** (right trigger on a gamepad), held: fast forward, 4 times normal
  speed unless changed in the menu. It is silent.
- **F5**: save state. **F7**: load state. No gamepad buttons are set for
  these to begin with, so that a slip of the thumb cannot undo your progress;
  choose them under Shortcuts. A gamepad button given to a shortcut stops
  doing its usual job in the game.
- **F3**: live statistics (speed, drawing time, CPU and GPU use).
- **F11**: full screen.
- **Right mouse button + move**: look around. Wheel zooms, middle button
  (or a click of the right stick) resets.
- To stop: Quit in the menu, or close the window. A summary of the session
  is printed.

### Options

```bash
./play game.z64 --wide --smooth --scale 4 --stats
```

- `--wide`: 16:9 picture
- `--smooth`: 60 pictures a second (the game itself runs at 30)
- `--scale N`: resolution, as a multiple of the console's 240 lines
- `--stats`: start with the statistics showing

Saved games are kept in `saves/`, one file per ROM.

### Save states

A save state is a copy of the whole machine at one moment, kept in
`states/`. Loading it carries on from exactly that moment. It is separate
from the game's own saving, with two things to know:

- Loading a state also takes the game's own save data back to how it was at
  that moment, the next time the game saves.
- A state only works with the build that made it. Whenever the game is
  rebuilt (after any change to this project's code), older states are
  refused with a message. The game's own saves in `saves/` always carry over.

### Cheats and fixes

| Game | Cheats | Fixes |
|---|---|---|
| Super Mario 64 (USA) | Infinite lives; infinite health; enemies cannot hurt Mario; no damage from falling; wing, metal and vanish cap, always; every jump is a triple jump; higher jumps; jump again in mid-air; low gravity; moon jump (hold L); giant Mario; tiny Mario; fast Mario | Keep objects visible at the edges of a widescreen picture |

They are listed at the bottom of the game's file in
`snakedecomp/runtime/games/`. A simple cheat is one line there: a name, an
address in the game's memory, and the value to keep writing to it. Others
are a few lines of C that run every frame, or that change one of the game's
own functions; the file has examples of each, and
`snakedecomp/runtime/mods.h` explains the three ways.

## How it works

The tools are in `snakedecomp/`, and are meant to be read:

| File | What it does |
|---|---|
| `rom.py` | Loads a ROM, reads its header, checks its checksum |
| `mips.py` | Turns machine code into readable assembly |
| `functions.py`, `program.py` | Find the code segments and where each function starts and ends |
| `signatures.py` | Recognises the OS library's functions by fingerprint |
| `recomp.py` | Translates each function to C |
| `cpu.py`, `verify.py` | An interpreter, and a check of the translated C against it |
| `runtime/host.c` | Stands in for the console's OS: threads, messages, timers, controllers, saves |
| `runtime/gfx.c`, `gfx_gl.c` | The renderer: reads drawing commands, draws with OpenGL |
| `runtime/audio.c` | Carries out the game's sound commands |
| `tools/make_font.py` | Draws the menu's font into `runtime/font.h` |
| `runtime/games/` | Changes made specially for one game, including its cheats and fixes |
| `runtime/mods.h` | What a cheat or fix is made of |

Other commands, for looking inside a ROM:

```bash
python3 -m snakedecomp info game.z64
python3 -m snakedecomp functions game.z64
python3 -m snakedecomp disasm game.z64 -n 20
python3 -m snakedecomp recompile game.z64 --verify
```

## Known limits

- Linux only.
- Widescreen keeps the HUD in the middle, and full-screen wipes do not cover
  the sides.
- With the free camera, in places where the game only draws the room you
  are in, the other rooms are missing if you look their way.
- Smooth motion guesses the in-between pictures and can smear at camera cuts.
- Only Super Mario 64 has cheats and fixes so far.
- Save states do not survive a rebuild (see above).

## Credits

- `snakedecomp/data/libultra.json` holds one-way hashes of OS library
  functions, used to recognise them. It contains no code.
- The menu font is generated from DejaVu Sans Mono Bold.
