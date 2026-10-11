# Snake's N64 decompiler

Turns a Nintendo 64 game ROM into a program that runs directly on your PC,
with no emulator. It reads the game's machine code, translates every function
to C, compiles it, and runs it against stand-ins for the console's operating
system, graphics chip, sound chip and controllers.

You give it a ROM and it works out the rest for that game: which version of
Nintendo's library the game was built with, which dialect of drawing
commands it uses, where its code is, and which ready-made cheats exist for
it. Each game gets its own menu with its own cheats, and every game gets a
free camera.

One point of wording: this tool *recompiles* rather than *decompiles*. It
produces C that runs, not readable source like a hand-made decompilation.

This is a learning project. It is not finished and it does not run every game.

**No games are included.** You need your own ROM, dumped from a cartridge you
own. Nothing in this project is, or contains, Nintendo's code or data.

## What works

**The list that is kept up to date is [STATUS.md](STATUS.md)**, written by
the `check` command below. What follows here is the wider survey of 63 ROMs
from before that list existed.

Checked on 63 ROMs with the `survey` command below, which runs each game by
itself with no window, pressing Start and A now and then. "Looks right"
means one or two screenshots looked right; nobody has played those games
on this yet.

| Game | State |
|---|---|
| Super Mario 64 | Playable: picture, sound, controls, saving; its own free camera and its own cheats |
| Wave Race 64 | Goes through its menus and into races under scripted button presses, with sound; general free camera, 12 ready-made cheats. Not yet played by a person |
| Mario Kart 64 | The same: menus and a Grand Prix race under scripted presses; general free camera, 23 ready-made cheats. Not yet played by a person |

**Start, and the picture looks right (17).** In play or a demo: Chameleon
Twist, Duke Nukem: Zero Hour, Pokémon Snap, Quest 64, Rampage: World Tour,
Road Rash 64, Star Fox 64, WCW Nitro. At a title, logo, menu or message
screen: 007: The World Is Not Enough, Army Men: Air Combat, Army Men:
Sarge's Heroes, Army Men: Sarge's Heroes 2, Cruis'n USA, Dr. Mario 64 (slow:
its code is interpreted), Jet Force Gemini, Pokémon Puzzle League, Rampage
2: Universal Tour.

**Start, with faults in the picture (6).** Duke Nukem 64 (in a level, white
patches), F-1 World Grand Prix (some wrong colours), Mario Golf (in play,
garbled text),
Pokémon Stadium (corrupted textures), Cruis'n Exotica (garbage), Resident
Evil 2 (says "No Controller").

**Run, but the screen stays black (6).** Diddy Kong Racing, NFL Blitz:
Special Edition, NFL Blitz 2001, Pokémon Stadium 2, Star Wars Episode I:
Racer, WCW vs. nWo: World Tour.

**Stop during start-up, or never draw (30).** All-Star Baseball 2000 and
2001, Banjo-Kazooie, Banjo-Tooie, Conker's Bad Fur Day, Cruis'n World,
Donkey Kong 64, Doom 64, GoldenEye 007, Kirby 64, both Zeldas, Mario
Tennis, NFL Blitz, NFL Blitz 2000, Paper Mario, Perfect Dark, both South
Parks, Super Smash Bros., Tony Hawk's Pro Skater 3, all three Turoks, WCW
Mayhem, WCW/nWo Revenge, WWF No Mercy, WWF WrestleMania 2000, Wetrix,
Yoshi's Story. (One more, All-Star Baseball '99, is a zip file that could not be read.)

Sound, saving and controls have not been checked in any game below the
table.

A game that stops prints a line beginning `game stopped:` saying where.
To see how far every ROM in a folder gets, without opening a window:

```bash
python3 -m snakedecomp survey path/to/folder
```

It builds each game, runs it by itself for a while pressing Start now and
then, and prints one line per game. Screenshots and the full output of each
are kept under `build/survey/`. Your real saves are not touched.

### Checking every game by machine

Where each game stands today is in [STATUS.md](STATUS.md): one row per game,
written afresh by this command, which is also how a change to the tool is
tested without anyone having to play 32 games:

```bash
python3 -m snakedecomp check
```

It builds every game in `roms/`, runs each by itself for a minute with no
window, and judges what a machine can: whether it stops or crashes, whether
the screen goes blank, whether the sound it makes agrees with what the game
asked for (and whether a recording of it is silent, distorted or noise),
and whether it runs too fast. It then says what got **better or worse since
the last check**. `--only mario` checks just the games with that in their
file name; `--frames 7200` runs for two minutes.

Each run also leaves one image, `build/check/<game>/sheet.png`, with twelve
pictures of the run side by side: a quick way to see wrong colours or
garbled text, which a machine cannot judge. (The sheets and the sound
measurements need the Python packages Pillow and numpy; without them the
rest still works.)

By default a run only presses Start and A in turn, which gets past most
title screens and no further. A file `checks/keys/<game code>.txt` gives a
game its own presses, to take it into real play; `check.py` describes it.

What you find by playing goes in the same list:

```bash
python3 -m snakedecomp note NKT played good "Two Grand Prix cups, all fine"
python3 -m snakedecomp note NMF played bad "Text on the scorecard is garbled"
```

The three letters are the game's code, shown by `info`.

### When a game goes wrong while you play

Every game you play leaves a log in `logs/<game>/`: once a second, what it
drew and whether the screen was blank, plus every button you pressed. When
you quit, the terminal says in a line what the log shows. For the full
story of the last games you played:

```bash
python3 -m snakedecomp diagnose
```

For each run it says what happened (the screen went blank, the game froze,
stopped, crashed or ran slowly), shows the evidence, and points at the part
of this tool to look at. The same text is saved as `logs/report.txt`.

```bash
python3 -m snakedecomp diagnose --replay
```

also plays each troubled run again by itself, with no window and the same
button presses, and saves pictures from around the bad moment next to the
log. If the fault happens again there, it can be worked on without anyone
having to play the game to that point again. (A replay starts from a copy
of the save you had; it cannot follow a loaded save state or a reset.)

A log cannot see wrong colours or garbled text. For those, press F12 at the
bad moment: the screenshot goes to `screenshots/`. It can see one kind of
bad sound: every run ends with a "sound rate" line saying how much sound the
game asked to play, how much its sound program made and how much reached
the sound chip. Those should agree; where they do not, the report says so.

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

The ROM can be a `.z64`, `.n64` or `.v64` file, or a `.zip` with one inside.

### The game list

```bash
./play
```

With no ROM named, a window lists the games in the `roms/` folder
(`./play some/folder` lists another folder). Choose one and it starts; quit
the game and you are back at the list.

| | Keyboard | Mouse | Gamepad |
|---|---|---|---|
| Move | Up, Down, Page Up, Page Down | pointer, wheel | D-pad or left stick; LB, RB a page |
| Play | Enter | click | A or Start |
| Look at the folder again | F5 | | Y |
| Change the order of the list | S | | X |
| Full screen | F11 | | |
| Quit | Esc | close the window | B |

Each game has a word in front saying where it stood at its last check
(Ready, In Progress, Untested, Broken; STATUS.md says what
each means), and a line at the bottom saying more. Games are sorted best first to begin with;
S (or X on a gamepad) changes the order: by state, by name, or worst first. The order you chose is remembered. Two dots at the right mean the game has
not been built yet, so its first start takes a minute or two; this builds
every game in a folder ahead of time:

```bash
python3 -m snakedecomp build roms
```

The list's window and the game's window each come back the size they were
last (maximised too, if that is how they were left). It is kept in
`settings/launcher.txt` and `settings/window.txt`; delete those to start
afresh. Where the window was on the screen is remembered as well, except on a
Wayland desktop: there a program is not allowed to know or choose where its
window goes, so the desktop puts it where it likes.

A gamepad can be switched on after the list is open, wireless ones included. The first run
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
circles what you are playing and stays where you put it. Click the right
stick to hand the camera back to the game. (The C buttons then need other
buttons, if you want them on the gamepad.) Holding the right mouse button
and moving the mouse does the same. Page Up and Page Down (D-pad up and
down on a gamepad, or the mouse wheel) move the camera nearer and farther;
like everything else, those can be changed under Shortcuts. It turns most
smoothly with "Smooth motion (60 fps)" on; without it the view can only
change 30 times a second, like the game.

It works in every game, in one of two ways:

- **Super Mario 64** has a camera made for it: the tool knows where Mario
  is, the camera stops at walls, floors and ceilings, the stick moves Mario
  relative to what you see, and the sky turns with you.
- **Every other game** gets a general one. The tool finds the game's own
  camera in what the game draws, guesses what it is looking at (usually
  your character), and circles that. Two rows under Controls adjust it:
  - "Camera style": circle the middle of the view, or just turn on the
    spot (better for games seen through the character's eyes).
  - "Stick": whether the control stick should follow the free camera. Leave
    it "as the game expects" for racing and first-person games; switch it
    to "follows the free camera" for games where you run a character
    around, so that up on the stick is still "away from me".

  The camera nearer and farther buttons start out on the gamepad's D-pad.
  In these games they only act while the free camera is switched on, and
  the game still sees the D-pad too; if a game needs its D-pad, give the
  two shortcuts other buttons under Shortcuts.

  The general camera does not know where walls are, and the game still
  only draws what its own camera can see, so scenery can be missing when
  you look somewhere the game did not expect.

### While playing

- **Esc** or **F1** (Select on a gamepad): the menu. The game keeps running
  behind it, and every choice takes effect straight away. Arrow keys (d-pad)
  move and change, Enter (A) selects, Esc (B) goes back.

  | Page | What is on it |
  |---|---|
  | Save states | Choose one of 9 slots, save, load |
  | Graphics | Widescreen, resolution, full screen, 60 fps smooth motion, smooth textures |
  | Sound | On/off, volume, buffer (raise it if the sound crackles) |
  | Controls | Keyboard key, mouse button and gamepad button for each N64 button; free camera and how it behaves |
  | Shortcuts | The same for fast forward, save state, load state, look, reset camera, camera nearer and farther, cheat button, screenshot |
  | Cheats, Fixes | For games that have them (see below) |
  | System | Speed limit, fast forward speed, statistics, put every setting back to usual |
  | Reset game | Starts the game again from the beginning |
  | Quit | |

  Everything chosen here is remembered for next time, separately for each
  game, in `settings/`.
- **Tab**, held: fast forward, 4 times normal (no gamepad button to begin with; choose one under Shortcuts)
  speed unless changed in the menu. It is silent.
- **F5**: save state. **F7**: load state. No gamepad buttons are set for
  these to begin with, so that a slip of the thumb cannot undo your progress;
  choose them under Shortcuts. A gamepad button given to a shortcut stops
  doing its usual job in the game.
- **F12** (click the left stick on a gamepad): screenshot. It is saved in
  `screenshots/`, named after the game and numbered.
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

Saved games are kept in `saves/` (see "Saved games" below).

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

Every game's menu has its own Cheats page, filled in two ways.

**Ready-made cheats.** The tool comes with a public collection of
"GameShark" codes (the one the mupen64plus emulator uses). When it builds a
game it looks the ROM up by its checksums and takes that exact version's
cheats, so Wave Race 64 gets "Always First Place" and Mario Kart 64 gets
"Infinite Items". Most are on/off. Some have a list to choose from (which
course, which item): left and right step through it. A few only act while
the "Cheat button" is held (G on the keyboard; change it under Shortcuts).
These were written by many people over many years for the real console;
most work, a few do nothing or misbehave. Switching one off simply stops
it.

**Your own.** Put them in `cheats/<rom name>.txt` (for `roms/wr64.us.z64`
that is `cheats/wr64.us.txt`), written the way the collection writes them:

```
cn Infinite Time
 cd A note about it, shown under the menu (optional)
 801C2BFE 00FF
```

`cn` starts a cheat and gives its name; each line after it is a code: where
in the game's memory, and the value to keep writing there.
`snakedecomp/runtime/cheats.c` explains every kind of code.

**Cheats made for one game.** Super Mario 64 also has cheats written
specially for it, which can do what codes cannot (change how a jump works,
not just a number): infinite lives and health, no fall damage, the three
caps, triple jumps, higher jumps, mid-air jumps, low gravity, moon jump,
giant, tiny and fast Mario. And one fix: keep objects visible at the edges
of a widescreen picture. They live in `snakedecomp/runtime/games/NSME.c`;
a file there named after another game's four-letter code does the same for
that game, and `snakedecomp/runtime/mods.h` explains how.

### Saved games

Saved games are kept in `saves/`, one set of files per ROM. Cartridges
saved in different ways and the tool handles these:

| Kind | Handled | File |
|---|---|---|
| Save chip, small and large (EEPROM) | yes | `.eep` |
| Battery memory (SRAM) | yes | `.sra` |
| Flash memory | not yet | |
| Controller Pak | not yet | |

## How it works

The tools are in `snakedecomp/`, and are meant to be read:

| File | What it does |
|---|---|
| `rom.py` | Loads a ROM (any byte order, or zipped), reads its header, checks its checksum |
| `mips.py` | Turns machine code into readable assembly |
| `functions.py`, `program.py` | Find the code segments and where each function starts and ends |
| `libsigs.py`, `signatures.py` | Recognise the OS library's functions, whichever version the game has |
| `recomp.py` | Translates each function to C |
| `cheats.py`, `profiles.py` | Find the game's ready-made cheats; the few facts that cannot be detected |
| `survey.py` | Tries a whole folder of games and reports on each |
| `check.py` | Runs every game by itself, judges picture, sound and pace, and writes STATUS.md |
| `diagnose.py` | Keeps a log of every run, and reads the logs back to say what went wrong |
| `launcher/launcher.c` | The game list window |
| `cpu.py`, `verify.py` | An interpreter in Python, and a check of the translated C against it |
| `runtime/host.c` | Stands in for the console: threads, messages, timers, controllers, saves, hardware registers |
| `runtime/interp.c` | Runs code that could not be translated ahead of time, one instruction at a time |
| `runtime/gfx.c`, `gfx_gl.c` | The renderer: reads drawing commands in four dialects, draws with OpenGL |
| `runtime/audio.c` | Carries out the game's sound commands |
| `runtime/cheats.c` | Carries out the ready-made cheats |
| `tools/make_font.py` | Draws the menu's font into `runtime/font.h` |
| `runtime/games/` | Changes made specially for one game |
| `runtime/mods.h` | What a made-for-one-game cheat or fix is made of |

Three ideas carry most of the weight:

- **Translate what can be found, interpret the rest.** Code in the ROM is
  translated to C ahead of time. Games also unpack code while running, or
  keep several pieces that take turns at one address; whatever was not
  translated is run by the interpreter straight from the game's memory.
- **Stand in for the library, and for the hardware under it.** Where we
  recognise a library function that talks to hardware, we do its job
  ourselves. Where a game talks to the hardware directly, a pretend copy of
  the hardware's registers answers it.
- **Detect, do not configure.** Nothing has to be set up per game for it
  to start.

Other commands, for looking inside a ROM:

```bash
python3 -m snakedecomp info game.z64
python3 -m snakedecomp functions game.z64
python3 -m snakedecomp disasm game.z64 -n 20
python3 -m snakedecomp recompile game.z64 --verify
python3 -m snakedecomp run game.z64 --notes     (what could not be translated, and why)
```

When a game misbehaves, these show what it is doing (set before `./play`):
`TRACE_OS=1` prints every library call, `SHOW_READS=1` every read from the
cartridge, `SHOW_GRAPHICS=1` the drawing dialect, `SHOW_CAMERA=1` how the
game sets up its camera, `SHOW_THREADS=1` the threads when it stops.
Two more switch on parts of the console's own start-up that are normally
left out, which gets some stubborn games further: `OS_INIT=1` and
`VI_INIT=1`.

### Names from a decompilation project

Where people have decompiled a game, their project usually publishes a list
of every function's name and address. Given that list, this tool no longer
has to guess which parts of the game are the console's library, and the
disassembly and reports show real names. Put the list in `symbols/`, named
after the ROM file or its four-letter game code (`info` shows it): a linker
map as `name.map`, or a list in the form the splat tool uses
(`symbol_addrs.txt`) as `name.txt`. Such lists belong to their projects;
`symbols/` is not shared with this tool's code.

## Known limits

- Linux only.
- Most games do not get as far as playing yet; see "What works".
- Games that move code in and out of memory with the CPU's address mapping
  (Turok 2, South Park, All-Star Baseball) do not start.
- Games that keep their main code packed in the ROM (Dr. Mario 64, the
  Banjo games, Perfect Dark) can only be interpreted, not translated, so
  those that start run much more slowly.
- Flash memory and Controller Pak saves are not there yet.
- Sound has only been listened to in Super Mario 64 and Mario Kart 64. Games
  that use a different sound program may be silent or wrong.
- Widescreen keeps the HUD in the middle, and full-screen wipes do not cover
  the sides.
- With the free camera, a game only draws what its own camera can see, so
  things can be missing if you look elsewhere. (Super Mario 64 is told to
  draw everything, but still only the room you are in.)
- Smooth motion guesses the in-between pictures and can smear at camera cuts.
- Code that is interpreted runs slower than translated code. The session
  summary says how much was interpreted.
- Save states do not survive a rebuild (see above).

## Credits

- `snakedecomp/data/libultra.json` holds one-way hashes of OS library
  functions, used to recognise them. It contains no code.
- `snakedecomp/data/n64sym.sig.gz` is the signature list of the
  [n64sym](https://github.com/shygoo/n64sym) project by shygoo: checksums
  of library functions from many SDK releases. MIT licence, in
  `snakedecomp/data/n64sym-LICENSE.md`.
- `snakedecomp/data/cheats.txt.gz` is the cheat list that comes with
  [mupen64plus](https://mupen64plus.org/), written by Gent for Project64.
  GPL version 2 or later; the notice is at the top of the file.
- The menu font is generated from DejaVu Sans Mono Bold.
