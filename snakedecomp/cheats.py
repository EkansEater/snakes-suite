"""Finding ready-made cheats for a game.

In the 1990s you could buy a "GameShark": a cartridge that sat between the
game and the console and kept writing chosen values into chosen places in
the game's memory. "Infinite lives" is nothing more than writing 99 to the
byte that counts lives, sixty times a second. People collected thousands of
these codes, and they still work on us, because the game's memory is laid
out exactly as it was on the console.

data/cheats.txt.gz is such a collection: the one that comes with the
mupen64plus emulator (written by Gent for Project64; GPL, see the notice at
the top of the file). It lists cheats for each exact version of each game,
found by the two checksums in the ROM's header. Each cheat is a name and
some codes:

    crc 635A2BFF-8B022326-C:45        which ROM: checksum 1, checksum 2, country
    gn Super Mario 64 (U)
     cn Infinite Lives                a cheat's name
      8033B21D 0064                   a code: address, value
     cn Level Select
      cd Use it on the title screen   a note about the cheat
      8032D58C ???? 0001:"On",0000:"Off"     a code whose value the player chooses

The first two digits of a code say what kind it is (80 = write one byte,
81 = write two, D0 = "only if this byte equals..."); the rest is the
address. runtime/cheats.c carries them out and explains each kind.

We copy the cheats for the game being built into a small file of the same
layout, which the game program reads when it starts. You can add your own
in cheats/<rom name>.txt, written the same way (just the cn/cd/code lines).
"""

import gzip
import os
import re
from dataclasses import dataclass, field

from .rom import Rom

DATABASE = os.path.join(os.path.dirname(__file__), "data", "cheats.txt.gz")
CODE = re.compile(r"^\s*([0-9A-Fa-f]{8})\s+([0-9A-Fa-f]{4}|\?\?\?\?)\s*(.*)$")
# Kinds of code we carry out. Others set up the GameShark itself (where its
# own program goes, for instance) and mean nothing here.
WRITES = {0x80, 0x81, 0xA0, 0xA1, 0x88, 0x89, 0xF0, 0xF1}
UNDERSTOOD = WRITES | {0x50, 0xD0, 0xD1, 0xD2, 0xD3}


@dataclass
class Cheat:
    name: str
    note: str = ""
    lines: list[str] = field(default_factory=list)  # the code lines, as written

    def addresses(self) -> set[int]:
        """Every place in memory this cheat can write to."""
        found, repeat = set(), None
        for line in self.lines:
            code = CODE.match(line)
            kind, address = int(code[1][:2], 16), 0x80000000 | (int(code[1], 16) & 0xFFFFFF)
            if kind == 0x50:  # "do the next code N times, moving along each time"
                repeat = ((int(code[1], 16) >> 8) & 0xFF, int(code[1], 16) & 0xFF)
                continue
            if kind in WRITES:
                count, step = repeat or (1, 0)
                found |= {address + i * step for i in range(count)}
            repeat = None
        return found


def parse(lines) -> list[Cheat]:
    """Read cn/cd/code lines into cheats, leaving out what we cannot carry out."""
    cheats: list[Cheat] = []
    for line in lines:
        text = line.strip()
        if text.startswith("cn "):
            # "Group\Name" is how the list files cheats into folders.
            cheats.append(Cheat(text[3:].strip().replace("\\", ": ").replace("=", "-")))
        elif text.startswith("cd ") and cheats:
            cheats[-1].note = text[3:].strip()
        elif CODE.match(line) and cheats:
            cheats[-1].lines.append(text)
    usable = []
    for cheat in cheats:
        kinds = {int(CODE.match(line)[1][:2], 16) for line in cheat.lines}
        if cheat.lines and kinds <= UNDERSTOOD and kinds & WRITES:
            usable.append(cheat)
    return usable


def find_cheats(rom: Rom) -> list[Cheat]:
    """The collection's cheats for exactly this ROM (none if it is not listed)."""
    if not os.path.exists(DATABASE):
        return []
    wanted = f"crc {rom.header.crc1:08X}-{rom.header.crc2:08X}-C:{rom.data[0x3E]:02X}"
    mine: list[str] = []
    inside = False
    with gzip.open(DATABASE, "rt", encoding="latin-1") as lines:
        for line in lines:
            if line.startswith("crc "):
                if inside:
                    break
                inside = line.strip().lower() == wanted.lower()
            elif inside:
                mine.append(line)
    return parse(mine)


def read_cheat_file(path: str) -> list[Cheat]:
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8", errors="replace") as lines:
        return parse(lines)


def write_cheat_file(cheats: list[Cheat], path: str) -> None:
    with open(path, "w") as out:
        for cheat in cheats:
            out.write(f"cn {cheat.name}\n")
            if cheat.note:
                out.write(f" cd {cheat.note}\n")
            out.writelines(f" {line}\n" for line in cheat.lines)
