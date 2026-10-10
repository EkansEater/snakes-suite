# Where each game stands

Written by `python3 -m snakedecomp check`; do not edit by hand (it is written afresh each time).
What people find by playing or looking goes in `checks/notes.txt`, or:

```bash
python3 -m snakedecomp note NSM played good "Played to the first star, all fine"
```

Last written 2026-10-10 16:10. 1 PLAYS, 4 CHECKS OUT, 2 MACHINE OK, 16 FAULTS, 2 BLACK, 7 STOPS.

| State | Meaning |
|---|---|
| PLAYS | A person has played it and found it good. |
| CHECKS OUT | No fault found by machine, and its pictures have been looked at. Waiting to be played. |
| MACHINE OK | No fault found by machine. Nobody has looked at its pictures yet. |
| FAULTS | It runs, with faults listed in its row. |
| BLACK | It runs, but shows nothing. |
| STOPS | It stops, freezes or crashes. |

The machine's columns come from running each game by itself for a while with no window. **Runs**: did it
reach the end. **Picture**: was the screen blank or were drawing commands not understood (it cannot see
wrong colours or garbled text; that is what "Looked at" is for). **Sound**: does the amount of sound
agree with what the game asked for, and is the recording silent, distorted or noise. **Pace**: pictures
a second. **Script**: "own" if the run pressed buttons written for that game to reach real play;
otherwise it only pressed Start and A, and may not have got past the menus. **Names**: whether a
decompilation project's list of function names is in `symbols/`.

| Game | State | Runs | Picture | Sound | Pace | Script | Names | Looked at | Played | Checked |
|---|---|---|---|---|---|---|---|---|---|---|
| Super Mario 64 | PLAYS | ok | ok | ok | 30 |  | yes |  | good, 2026-10-10: Picture, sound, controls and saving work (carried over from the README) | 2026-10-10 |
| Duke Nukem: Zero Hour | CHECKS OUT | ok | ok | ok | 30 |  | yes | good, 2026-10-10: Menus, the opening scene and the briefing screen look right |  | 2026-10-10 |
| Mario Kart 64 | CHECKS OUT | ok | ok | ok | 30 | own |  | good, 2026-10-10: Scripted run: menus and a Luigi Raceway race look right |  | 2026-10-10 |
| Star Fox 64 | CHECKS OUT | ok | ok | ok | 30 |  |  | good, 2026-10-10: Map, briefing and the flight into Corneria look right |  | 2026-10-10 |
| Wave Race 64 | CHECKS OUT | ok | ok | ok | 20 |  |  | good, 2026-10-10: Menus, the round screen and a Sunny Beach race look right |  | 2026-10-10 |
| Dr. Mario 64 | MACHINE OK | ok | ok | ok | 60 |  |  |  |  | 2026-10-10 |
| Rampage 2: Universal Tour | MACHINE OK | ok | ok | ok | 60 |  |  |  |  | 2026-10-10 |
| Army Men: Sarge's Heroes | FAULTS | ok | **stuck: the last 11 of 13 pictures taken are identical** | **its sound lists produce nothing; recording is silent** | 60 |  |  |  |  | 2026-10-10 |
| Army Men: Sarge's Heroes 2 | FAULTS | ok | ok | **its sound lists produce nothing; recording is silent** | 60 |  |  |  |  | 2026-10-10 |
| Chameleon Twist | FAULTS | ok | ok | **1780 blocks thrown away** | 60 |  |  |  |  | 2026-10-10 |
| Cruis'n Exotica | FAULTS | ok | **The screen went blank at 0:10 (frame 600) for 5 seconds** | **its sound lists produce nothing; recording is silent** | 30 |  |  | bad, 2026-10-10: Picture is garbage (seen in an earlier survey) |  | 2026-10-10 |
| Cruis'n USA | FAULTS | ok | ok | **recording is silent** | 0 |  |  |  |  | 2026-10-10 |
| Duke Nukem 64 | FAULTS | ok | ok | **sends 27506 a second, wants 22050 (+24%)** | 60 |  |  | bad, 2026-10-10: White patches in the level (seen in an earlier survey) |  | 2026-10-10 |
| F-1 World Grand Prix | FAULTS | ok | **6868 drawing commands were skipped because we do not handle them** | **sends 20433 a second, wants 22050 (-8%)** | 30 |  |  | bad, 2026-10-10: Some wrong colours (seen in an earlier survey) |  | 2026-10-10 |
| Jet Force Gemini | FAULTS | ok | **The screen went blank at 0:14 (frame 840) for 5 seconds** | **its sound lists produce nothing; recording is silent** | 30 |  |  |  |  | 2026-10-10 |
| Pokemon Snap | FAULTS | ok | **The screen went blank at 0:08 (frame 480) and stayed blank until the run ended** | ok | 60 |  |  |  |  | 2026-10-10 |
| Pokemon Stadium | FAULTS | ok | **The screen went blank at 0:14 (frame 840) and stayed blank until the run ended** | **its sound lists produce nothing; recording is silent** | 30 |  |  | bad, 2026-10-10: Corrupt textures (seen in an earlier survey) |  | 2026-10-10 |
| Quest 64 | FAULTS | ok | ok | ok | 30 |  |  | bad, 2026-10-10: Pink boxes behind text (seen in an earlier survey) |  | 2026-10-10 |
| Rampage: World Tour | FAULTS | ok | ok | **sends 18792 a second, wants 32000 (-42%)** | 180 **too fast** |  |  |  |  | 2026-10-10 |
| Resident Evil 2 | FAULTS | ok | **The game draws with a chip program this tool has no drawing code for: S2DEX       fifo 2.0** | **its sound lists produce nothing; sends 11468 a second, wants 22050 (-48%); recording is silent** | 120 **too fast** |  |  | bad, 2026-10-10: Only ever shows "No Controller" |  | 2026-10-10 |
| Road Rash 64 | FAULTS | ok | ok | **its sound lists produce nothing; recording is silent** | 60 |  |  |  |  | 2026-10-10 |
| WCW Nitro | FAULTS | ok | **47290 drawing commands were skipped because we do not handle them** | ok | 180 **too fast** |  |  |  |  | 2026-10-10 |
| WCW vs. nWo: World Tour | FAULTS | ok | **16004 drawing commands were skipped because we do not handle them** | **sends 21182 a second, wants 22050 (-4%)** | 30 |  |  |  |  | 2026-10-10 |
| Diddy Kong Racing | BLACK | ok | **The screen never showed anything (blank and stayed blank until the run ended)** | ok | 5 |  |  |  |  | 2026-10-10 |
| Star Wars Episode I: Racer | BLACK | ok | **black: never showed anything** | **sends 223 a second, wants 22050 (-99%); recording is silent** | 1 |  |  |  |  | 2026-10-10 |
| 007: The World Is Not Enough | STOPS | **stops at 0:47: bad memory access at 0x00000000** | ok | **its sound lists produce nothing; sends 11487 a second, wants 22050 (-48%); recording is silent** | 30 |  |  |  |  | 2026-10-10 |
| Army Men: Air Combat | STOPS | **stops at 0:28: bad memory access at 0xFFFFFFFF** | **The screen went blank at 0:08 (frame 480) for 10 seconds** | **its sound lists produce nothing; sends 21366 a second, wants 22050 (-4%); recording is silent** | 40 |  |  |  |  | 2026-10-10 |
| Mario Golf | STOPS | **froze at 0:26: no new picture for five seconds or more** | **105 drawing commands were skipped because we do not handle them** | **its sound lists produce nothing; sends 16142 a second, wants 32000 (-50%); recording is silent** | 30 |  |  | bad, 2026-10-10: White ground, garbled text in the HUD, a blue box in the corner |  | 2026-10-10 |
| NFL Blitz 2001 | STOPS | **froze at 0:09: no new picture for five seconds or more** | ok | **its sound lists produce nothing; recording is silent** | 30 |  |  |  |  | 2026-10-10 |
| NFL Blitz: Special Edition | STOPS | **froze at 0:09: no new picture for five seconds or more** | ok | **its sound lists produce nothing; recording is silent** | 30 |  |  |  |  | 2026-10-10 |
| Pokemon Puzzle League | STOPS | **froze at 0:00: no new picture for five seconds or more** | ok | **sends 20813 a second, wants 22050 (-6%)** | 47 |  |  |  |  | 2026-10-10 |
| Pokemon Stadium 2 | STOPS | **froze at 0:01: no new picture for five seconds or more** | ok | **silent: sound program not understood; recording is silent** | 0 |  |  |  |  | 2026-10-10 |
