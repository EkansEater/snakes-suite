# Where each game stands

Written by `python3 -m snakedecomp check`; do not edit by hand (it is written afresh each time).
What people find by playing or looking goes in `checks/notes.txt`, or:

```bash
python3 -m snakedecomp note NSM played good "Played to the first star, all fine"
```

Last written 2026-10-12 06:03. 6 Ready, 14 In Progress, 2 Untested, 10 Broken.

| State | Meaning |
|---|---|
| Ready | Playable 100%: a person has played it and found it good, and the machine finds no fault. |
| In Progress | Still being tested, somewhat playable: it runs, but has faults listed in its row or has not been played yet. |
| Untested | Not tested: the machine finds no fault, but nobody has looked at it or played it. |
| Broken | Tested, unplayable: it stops, freezes, crashes or shows nothing. |

The machine's columns come from running each game by itself for a while with no window. **Runs**: did it
reach the end. **Picture**: was the screen blank or were drawing commands not understood (it cannot see
wrong colours or garbled text; that is what "Looked at" is for). **Sound**: does the amount of sound
agree with what the game asked for, and is the recording silent, distorted or noise. **Pace**: pictures
a second. **Script**: "own" if the run pressed buttons written for that game to reach real play;
otherwise it only pressed Start and A, and may not have got past the menus. **Names**: whether a
decompilation project's list of function names is in `symbols/`.

| Game | State | Runs | Picture | Sound | Pace | Script | Names | Looked at | Played | Checked |
|---|---|---|---|---|---|---|---|---|---|---|
| Chameleon Twist | Ready | ok | ok | ok | 30 |  |  |  | good, 2026-10-12: A level played at the right speed with sound; fine apart from some HUD glitches, not yet pinned down (the hearts and crown count slide in and out by the game's own doing) | 2026-10-11 |
| Duke Nukem: Zero Hour | Ready | ok | ok | ok | 30 |  | yes | good, 2026-10-10: Menus, the opening scene and the briefing screen look right | good, 2026-10-12: Opening cutscenes and the first level look perfect with smooth motion and widescreen on | 2026-10-11 |
| Mario Kart 64 | Ready | ok | ok | ok | 30 | own |  | good, 2026-10-10: Scripted run: menus and a Luigi Raceway race look right | good, 2026-10-11: Mushroom Cup: a full Luigi Raceway race and the start of Moo Moo Farm play right. Very few visual glitches. Fixed since: in widescreen a strip of old picture stayed down the right of the results screen | 2026-10-11 |
| Star Fox 64 | Ready | ok | ok | ok | 30 |  |  | good, 2026-10-10: Map, briefing and the flight into Corneria look right | good, 2026-10-11: All of Corneria to the boss and the map play right. Very few visual glitches. Added since: a volume-boost sound command the game uses from Corneria on; not yet listened to | 2026-10-11 |
| Super Mario 64 | Ready | ok | ok | ok | 30 |  | yes |  | good, 2026-10-10: Picture, sound, controls and saving work (carried over from the README) | 2026-10-11 |
| Wave Race 64 | Ready | ok | ok | ok | 20 |  |  | good, 2026-10-10: Menus, the round screen and a Sunny Beach race look right | good, 2026-10-11: Intro and two Championship races (Sunny Beach, Sunset Bay) play right. Left: rank portraits 3 and 4 went black for a few seconds once; a rival marker's red ring blinks; window is made afresh on reset | 2026-10-11 |
| Army Men: Sarge's Heroes | In Progress | ok | **stuck: the last 11 of 13 pictures taken are identical** | **its sound lists produce nothing; recording is silent** | 60 |  |  |  | bad, 2026-10-11: Reaches the main menu, then crashes before play (bad memory access; a second try read past the end of the ROM). Visual glitches on the way | 2026-10-11 |
| Army Men: Sarge's Heroes 2 | In Progress | ok | **stuck: the last 10 of 13 pictures taken are identical** | **its sound lists produce nothing; recording is silent** | 60 |  |  |  | bad, 2026-10-11: Crashes at the Controller Pak question (calls an address that is not code), so never gets in-game | 2026-10-11 |
| Cruis'n USA | In Progress | ok | ok | **recording is silent** | 0 |  |  |  | bad, 2026-10-11: Shows only the copyright screen, then nothing; had to be closed by hand | 2026-10-11 |
| Duke Nukem 64 | In Progress | ok | ok | ok | 30 |  |  | bad, 2026-10-10: White patches in the level (seen in an earlier survey) | bad, 2026-10-11: Too fast and white menus, HUD and weapon; both fixed since, not yet played again | 2026-10-11 |
| F-1 World Grand Prix | In Progress | ok | **5656 drawing commands were skipped because we do not handle them** | **sends 19621 a second, wants 22050 (-12%)** | 30 |  |  | bad, 2026-10-10: Some wrong colours (seen in an earlier survey) | bad, 2026-10-11: Race was washed red (fixed since, not yet played again). Sound is still choppy | 2026-10-11 |
| Jet Force Gemini | In Progress | ok | **The screen went blank at 0:14 (frame 840) for 5 seconds** | **its sound lists produce nothing; recording is silent** | 30 |  |  |  |  | 2026-10-11 |
| Pokemon Snap | In Progress | ok | **The screen went blank at 0:08 (frame 480) and stayed blank until the run ended** | ok | 60 |  |  |  |  | 2026-10-11 |
| Pokemon Stadium | In Progress | ok | **The screen went blank at 0:14 (frame 840) and stayed blank until the run ended** | **its sound lists produce nothing; recording is silent** | 30 |  |  | bad, 2026-10-10: Corrupt textures (seen in an earlier survey) |  | 2026-10-11 |
| Quest 64 | In Progress | ok | ok | ok | 30 |  |  | bad, 2026-10-10: Pink boxes behind text (seen in an earlier survey) |  | 2026-10-11 |
| Rampage: World Tour | In Progress | ok | ok | **sends 18792 a second, wants 32000 (-42%)** | 180 **too fast** |  |  |  |  | 2026-10-11 |
| Resident Evil 2 | In Progress | ok | **The game draws with a chip program this tool has no drawing code for: S2DEX       fifo 2.0** | **its sound lists produce nothing; sends 11468 a second, wants 22050 (-48%); recording is silent** | 120 **too fast** |  |  | bad, 2026-10-10: Only ever shows "No Controller" |  | 2026-10-11 |
| Road Rash 64 | In Progress | ok | ok | **its sound lists produce nothing; recording is silent** | 60 |  |  |  |  | 2026-10-11 |
| WCW Nitro | In Progress | ok | **47290 drawing commands were skipped because we do not handle them** | ok | 180 **too fast** |  |  |  |  | 2026-10-11 |
| WCW vs. nWo: World Tour | In Progress | ok | **16004 drawing commands were skipped because we do not handle them** | **sends 21182 a second, wants 22050 (-4%)** | 30 |  |  |  |  | 2026-10-11 |
| Dr. Mario 64 | Untested | ok | ok | ok | 60 |  |  |  |  | 2026-10-11 |
| Rampage 2: Universal Tour | Untested | ok | ok | ok | 60 |  |  |  |  | 2026-10-11 |
| 007: The World Is Not Enough | Broken | **stops at 0:47: bad memory access at 0x00000000** | ok | **its sound lists produce nothing; sends 11487 a second, wants 22050 (-48%); recording is silent** | 30 |  |  |  |  | 2026-10-11 |
| Army Men: Air Combat | Broken | **stops at 0:28: bad memory access at 0x0000000C** | **The screen went blank at 0:08 (frame 480) for 10 seconds** | **its sound lists produce nothing; sends 21347 a second, wants 22050 (-4%); recording is silent** | 40 |  |  |  |  | 2026-10-11 |
| Cruis'n Exotica | Broken | **stops at 0:39: bad memory access at 0xCA000004** | **The screen went blank at 0:08 (frame 480) for 7 seconds** | **its sound lists produce nothing; recording is silent** | 30 |  |  | bad, 2026-10-10: Picture is garbage (seen in an earlier survey) | bad, 2026-10-11: Gets into a race, but the textures there are garbage; then the game stops itself (break at 0x800205D0) | 2026-10-11 |
| Diddy Kong Racing | Broken | ok | **The screen never showed anything (blank and stayed blank until the run ended)** | ok | 5 |  |  |  |  | 2026-10-11 |
| Mario Golf | Broken | **froze at 0:26: no new picture for five seconds or more** | **105 drawing commands were skipped because we do not handle them** | **its sound lists produce nothing; sends 16136 a second, wants 32000 (-50%); recording is silent** | 30 |  |  | bad, 2026-10-10: White ground, garbled text in the HUD, a blue box in the corner |  | 2026-10-11 |
| NFL Blitz 2001 | Broken | **froze at 0:09: no new picture for five seconds or more** | ok | **its sound lists produce nothing; recording is silent** | 30 |  |  |  |  | 2026-10-11 |
| NFL Blitz: Special Edition | Broken | **froze at 0:09: no new picture for five seconds or more** | ok | **its sound lists produce nothing; recording is silent** | 30 |  |  |  |  | 2026-10-11 |
| Pokemon Puzzle League | Broken | **froze at 0:00: no new picture for five seconds or more** | ok | **sends 20812 a second, wants 22050 (-6%)** | 47 |  |  |  |  | 2026-10-11 |
| Pokemon Stadium 2 | Broken | **froze at 0:01: no new picture for five seconds or more** | ok | **silent: sound program not understood; recording is silent** | 0 |  |  |  |  | 2026-10-11 |
| Star Wars Episode I: Racer | Broken | ok | **black: never showed anything** | **sends 223 a second, wants 22050 (-99%); recording is silent** | 1 |  |  |  |  | 2026-10-11 |
