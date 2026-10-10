"""Things about particular games that cannot be worked out from the ROM.

Nearly everything a game needs we detect: its library version from
fingerprints, its graphics dialect from the chip program it loads, its
cheats from the ROM's checksums. This file holds the little that is left,
by the game's code from the ROM header (python3 -m snakedecomp info shows
it; the last letter is the region and is left off here).
"""

# Cartridges carried one of two sizes of save chip, 512 bytes or 2048. The
# game cannot be asked which: it asks the chip. These had the big one.
BIG_SAVE_CHIP = {
    "NB7",  # Banjo-Tooie
    "NCW",  # Cruis'n World
    "NCZ",  # Custom Robo V2
    "ND3",  # Akumajou Dracula / Castlevania
    "ND4",  # Castlevania: Legacy of Darkness
    "NDO",  # Donkey Kong 64
    "NEP",  # Star Wars Episode I: Racer
    "NFU",  # Conker's Bad Fur Day
    "NK4",  # Kirby 64
    "NM8",  # Mario Tennis
    "NMV",  # Mario Party 3
    "NMX",  # Excitebike 64
    "NPD",  # Perfect Dark
    "NR7",  # Robot Poncots 64
    "NRZ",  # Ridge Racer 64
    "NUB",  # PD Ultraman Battle Collection 64
    "NYS",  # Yoshi's Story
}


def game_options(game_code: str) -> list[str]:
    """Extra options to start a game's program with."""
    options = []
    if game_code[:3] in BIG_SAVE_CHIP:
        options += ["--eeprom", "2048"]
    return options


# How far each game got when last tried (see "What works" in README.md), for
# the game list to show. The number sorts the list, best first:
#   0 plays   1 looks right in play   2 looks right at a title or menu
#   3 runs with faults   4 runs, black screen   5 does not start
TRIED = {
    "NSM": ("Super Mario 64", 0, "Playable. Its own free camera and cheats."),
    "NWR": ("Wave Race 64", 0, "Menus and races work in scripted tests. Needs your play-test."),
    "NKT": ("Mario Kart 64", 0, "Menus and Grand Prix work in scripted tests. Needs your play-test."),
    "NCT": ("Chameleon Twist", 1, "Gets into play; picture looked right."),
    "NDZ": ("Duke Nukem: Zero Hour", 1, "Gets into play; picture looked right."),
    "NPF": ("Pokemon Snap", 1, "Intro and map looked right."),
    "NET": ("Quest 64", 1, "Gets into play; cannot save (needs a Controller Pak)."),
    "NRP": ("Rampage: World Tour", 1, "Gets into play; picture looked right."),
    "NRO": ("Road Rash 64", 1, "Gets into a race; picture looked right."),
    "NFX": ("Star Fox 64", 1, "Reaches the mission briefing; picture looked right."),
    "NW3": ("WCW Nitro", 1, "Gets into the ring; picture looked right."),
    "NO7": ("007: The World Is Not Enough", 2, "Logos looked right; not seen further."),
    "NAC": ("Army Men: Air Combat", 2, "Menus looked right; not seen further."),
    "NAM": ("Army Men: Sarge's Heroes", 2, "Opening text looked right; not seen further."),
    "N32": ("Army Men: Sarge's Heroes 2", 2, "Stops at its Controller Pak question."),
    "NCU": ("Cruis'n USA", 2, "Copyright screen looked right; not seen further."),
    "NJF": ("Jet Force Gemini", 2, "Rare logo looked right; not seen further."),
    "NPN": ("Pokemon Puzzle League", 2, "Title screen looked right; not seen further."),
    "N2P": ("Rampage 2: Universal Tour", 2, "Level intro looked right; not seen further."),
    "NN6": ("Dr. Mario 64", 2, "Menus looked right; runs slowly (its code is interpreted)."),
    "NDN": ("Duke Nukem 64", 3, "Gets into a level; white patches in the picture."),
    "NFW": ("F-1 World Grand Prix", 3, "Title and races appear; some colours are wrong."),
    "NMF": ("Mario Golf", 3, "Gets into play; text is garbled."),
    "NPO": ("Pokemon Stadium", 3, "Starts; textures are corrupted."),
    "NXO": ("Cruis'n Exotica", 3, "Starts; the picture is garbage."),
    "NRE": ("Resident Evil 2", 3, "Starts, then says \"No Controller\"."),
    "NDY": ("Diddy Kong Racing", 4, "Runs, but the screen stays black."),
    "NSZ": ("NFL Blitz: Special Edition", 4, "Runs, but the screen stays black."),
    "NFB": ("NFL Blitz 2001", 4, "Runs, but the screen stays black."),
    "NP3": ("Pokemon Stadium 2", 4, "Runs, but the screen stays black."),
    "NEP": ("Star Wars Episode I: Racer", 4, "Runs, but the screen stays black."),
    "NWN": ("WCW vs. nWo: World Tour", 4, "Runs, but the screen stays black."),
}
UNTRIED = (9, "Not tried yet, or does not start yet.")
