# Fix schedule

Written 2026-10-10 from an audit of all 32 games in `roms/`: each was built
and run by itself for one minute of game time with no window, pressing Start
and A now and then. The numbers below are from that audit. "Sound made /
wanted" is how many samples a second the game produced against how many it
asked to play.

Nothing here has been fixed yet. This is the list to work from.

## The causes, and which games each one touches

These are faults in the shared runtime, so one fix helps every game in its
row.

| # | Cause | What you would notice | Games |
|---|-------|-----------------------|-------|
| A | **Drawing takes no time.** On the console, drawing a picture took a good part of a frame, and some games set their pace by waiting for it. Ours finishes instantly, so they race ahead. | Game runs too fast | Rampage World Tour (178 pictures a second), WCW Nitro (143), Resident Evil 2 (119), Quest 64 (69). To check: Chameleon Twist, Duke Nukem 64, Army Men Sarge's Heroes 1 and 2, Rampage 2, Road Rash 64 (all at 60; some of these should be 30) |
| B | **A sound dialect we do not speak.** These games' sound lists are written for a different version of the sound program. We carry them out as if they were the version we know, which gives noise or nothing. | Static, wrong or missing sound | Army Men Air Combat, Sarge's Heroes, Sarge's Heroes 2, Cruis'n Exotica, Jet Force Gemini, Mario Golf, NFL Blitz SE, NFL Blitz 2001, Pokemon Stadium, Road Rash 64 |
| C | **Gaps in the newer sound dialect.** We know this one, but not every command. | Some sounds missing or wrong | Mario Kart 64 (7,650 commands skipped in a minute), Star Fox 64 (8,294), Pokemon Stadium 2 (all sound skipped: silent) |
| D | **Sound rate.** The game changes how fast sound plays and we keep the old speed, or it makes more or less sound than it plays. | Wrong pitch, crackle, music too fast or slow | Wave Race 64 (switches 32,000 to 26,900 in a race; we stay at 32,000), Chameleon Twist (makes double; 1,780 blocks thrown away), Duke Nukem 64 (25% too much), Mario Golf, Resident Evil 2 and 007 (half), Rampage World Tour (41% short), F-1 World Grand Prix (7% short), WCW vs. nWo (4% short), Pokemon Puzzle League |
| E | **Stops or freezes.** | Game ends or hangs | 007 (bad memory access, 47 s in), Army Men Air Combat (same, 29 s in), Pokemon Snap (freezes after first A), Dr. Mario 64 (its code is interpreted: too slow to finish the audit) |
| F | **No picture.** | Black screen | Cruis'n USA, Star Wars Racer, Diddy Kong Racing, NFL Blitz SE, NFL Blitz 2001, Pokemon Puzzle League, Pokemon Stadium 2, Jet Force Gemini (logo only) |
| G | **Wrong picture** (seen earlier, not measured by the audit). | Visual faults | Quest 64 (pink boxes behind text), Mario Golf (garbled text), Pokemon Stadium (corrupt textures), Cruis'n Exotica (garbage), Duke Nukem 64 (white patches), F-1 World Grand Prix (wrong colours) |

Is Duke Nukem: Zero Hour's fault the same as the others'? Partly. Its fault
(not being told the sound chip is full) was in the shared runtime and is
fixed for every game. But the audit shows most other games' sound problems
have **different** causes: B, C and D above.

Sound is in balance, with nothing skipped, in: Super Mario 64, Duke Nukem:
Zero Hour, Pokemon Snap, Diddy Kong Racing, Rampage 2, Cruis'n USA and
Quest 64 (though several of those have other faults).

## Schedule: batches of five

Each batch: fix, run the audit again on all 32 games (to catch anything a
shared fix broke), you play-test the five, then release (commit, tag
`batch-N`, update "What works" in the README). A batch is not released until
you have played its five games.

Order: games nearest to working first, and shared fixes as early as
possible so later batches inherit them.

| Batch | Games | Fixes needed (cause) |
|-------|-------|----------------------|
| **1** | Super Mario 64, Mario Kart 64, Wave Race 64, Star Fox 64, Duke Nukem: Zero Hour | Sound rate changes mid-game (D). Missing commands in the newer sound dialect (C). Your play-test of each, since all five are meant to be playable. |
| **2** | Chameleon Twist, Quest 64, Rampage World Tour, WCW Nitro, Duke Nukem 64 | Drawing time, so games keep their own pace (A): this is the big shared fix. Sound doubling in Chameleon Twist and the 25% excess in Duke Nukem 64 (D), probably cured by A. Quest 64's pink text boxes and Duke Nukem 64's white patches (G). |
| **3** | Road Rash 64, Army Men: Sarge's Heroes, Army Men: Sarge's Heroes 2, Rampage 2, Pokemon Snap | The other sound dialect (B): the second big shared fix. Check pace of the three at 60 pictures a second (A). Pokemon Snap's freeze (E). Sarge's Heroes 2 stops at its Controller Pak question. |
| **4** | Mario Golf, F-1 World Grand Prix, Cruis'n Exotica, Pokemon Stadium, WCW vs. nWo | Sound dialect B should arrive from batch 3; then the sound rate of each (D). Picture faults: garbled text, wrong colours, garbage, corrupt textures (G). |
| **5** | Resident Evil 2, 007: The World Is Not Enough, Army Men: Air Combat, Jet Force Gemini, Dr. Mario 64 | The two crashes (E). Resident Evil 2's pace and "No Controller" (A). Jet Force Gemini past its logo (F). Dr. Mario 64: translate its code instead of interpreting it. |
| **6** | Diddy Kong Racing, NFL Blitz SE, NFL Blitz 2001, Pokemon Puzzle League, Pokemon Stadium 2 | Black screens (F): each needs its own look at what it is waiting for. Pokemon Stadium 2's silent sound (C). |
| **7** | Cruis'n USA, Star Wars Episode I: Racer | Black screens after one picture (F). Two games, since 32 does not divide by five. |

## What can be said about effort

- Batches 1 to 3 carry the three big shared fixes (C and D, then A, then B).
  They are the most work and the most valuable.
- Batches 4 and 5 are mostly one-game faults that have to be found first;
  how long each takes is not knowable until it is looked at.
- Batches 6 and 7 are the least certain: a black screen can be one missing
  answer from the runtime or something much deeper.

Where a game has a public decompilation, its name list goes in `symbols/`
first (see the README): it removes the guesswork about which functions are
the console's library.
