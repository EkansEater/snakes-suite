# Fix schedule

Written 2026-10-10 from an audit of all 32 games in `roms/`: each was built
and run by itself for one minute of game time with no window, pressing Start
and A now and then. The numbers below are from that audit. "Sound made /
wanted" is how many samples a second the game produced against how many it
asked to play.

This is the list to work from. What has been done since is under
"Progress" at the end.

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

How each fix goes (changed 2026-10-10, so that the work does not wait on
play-testing):

1. Fix one issue.
2. `python3 -m snakerecomp check` on all 32 games. It says what got better
   and what got worse; nothing may get worse.
3. Claude looks at the picture sheets of the games the fix touched.
4. Commit. [STATUS.md](STATUS.md) is updated by the check and goes in the
   same commit.

Your play-test of a batch's five games comes when you have time, and is
recorded with the `note` command; a batch is tagged `batch-N` once all five
have been played.

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

## Progress

**Batch 1: done 2026-10-11** (tagged `batch-1`). All five played and found
good. Fixed on the way: sound rate changes, missing sound commands, Wave
Race 64's smooth-motion faults, Mario Kart 64's widescreen results screen.

**Batch 2: in hand.** Played 2026-10-11 (with five games from later batches,
below). Cause A turned out to be three different things, none of them
"drawing takes no time":

| Fixed 2026-10-11 | What it was | Games it cured |
|---|---|---|
| Refresh message | A game can ask to be told of every second refresh; we told it of every one, so it ran twice too fast, sound and all | Chameleon Twist (60 to 30 pictures a second; no sound thrown away now) |
| The clock | Each look at the clock moved it on, and a game that looks thousands of times a refresh had a clock running fast | Duke Nukem 64 (60 to 30; sound was 24% over, now in balance) |
| Shade on rectangles | Flat pictures were mixed with full white light where the console uses none | Duke Nukem 64 (white menus, HUD and weapon) |
| Light colours | A light's colour set by a single number was ignored | F-1 World Grand Prix (race washed red). Also changes Duke Nukem: Zero Hour, which lights every object this way: it is darker now. To be confirmed by eye |

| Fixed 2026-10-13 | What it was | Games it cured |
|---|---|---|
| Volume jump | A note told to jump straight to its volume is given the largest glide speed there is, and our sum overflowed: one sample in every eight was a loud click, a robotic buzz over everything | Chameleon Twist, Duke Nukem 64 (the check now listens for this in every game; no other has it) |
| Depth of rectangles | A flat rectangle can be given a depth and be hidden by nearer things; we drew every rectangle on top | Duke Nukem 64 (pickups showed through walls) |
| Picture records | Some games never wait for the refresh: they draw into whichever of their pictures is neither on screen nor next, and wait only when none is free. The library's records of "on screen" and "next" never changed, so one always was | Rampage: World Tour (180 to 60 pictures a second), WCW Nitro (180 to 120), WCW vs. nWo (sound was 4% short, now in balance) |
| Sound rate written to the chip | A game whose rate-setting library function we did not recognise writes the rate to the sound chip itself; we never read it and played at 32,000 a second | Rampage: World Tour (asked for 22,050). The check still shows it 12% short, but that is its first seven seconds, when it makes no sound at all; after that it is in balance |

Still to do in batch 2: WCW Nitro at 120 pictures a second (on the console
the time drawing took held it back; whether the game itself is too fast at
120 needs playing to tell) and its skipped drawing commands; Quest 64's
pink text boxes.

Rampage: World Tour plays right, but its title screens are silent and
should have sound (found by play-testing, 2026-10-13). What is known: the
game does play notes there, about one every half second for five seconds,
but asks for them at a volume of 120 where its sound effects in play ask
for 2,000 to 8,700, and then stops. It is the same whenever the buttons are
pressed, so it is not a matter of timing at start-up, and the library's own
start-up (OS_INIT, VI_INIT) makes no difference. Not yet known: why the
game asks for so little. `SHOW_VOLUMES=1` prints the volume each note is
told to reach. Resident Evil 2 (120)
is batch 5. Chameleon Twist and Duke Nukem 64 are played and good.

**Found by play-testing, for their own batches:**

| Game | Batch | What was found |
|---|---|---|
| Army Men: Sarge's Heroes | 3 | Reaches the main menu, then stops: bad memory access; another time, a read past the end of the ROM |
| Army Men: Sarge's Heroes 2 | 3 | Stops at the Controller Pak question: calls an address that is not code |
| F-1 World Grand Prix | 4 | Sound choppy: it makes 7% too little, and a large part of its code is interpreted rather than translated, which is slow. Played 2026-10-13 with smooth motion on: the car's wheels were squashed or out of place in every in-between picture (fixed the same day: see-through only where the game asks for mixing, big turns not blended, lone matrices paired by their place in the list). Still open: pale see-through boxes around distant buildings |
| Cruis'n Exotica | 4 | Gets into a race with garbage textures, then stops itself (break) |
| Cruis'n USA | 7 | One picture (the copyright screen), then nothing |
