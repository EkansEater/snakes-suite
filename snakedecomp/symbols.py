"""Reading function names from a linker map.

When a program is built, the linker can write a "map": a text file listing
where it put every piece of every source file, and the address of every
named function. A map from a finished decompilation of the same ROM gives us
the real names, and something to check our own function finding against.

The parts of the file we care about look like this:

 .text          0x00000000803223b0       0x30 build/us/libultra.a(osSetTime.o)
                0x00000000803223b0                osSetTime

The first line says a 0x30-byte block of code (".text") from osSetTime.o
was placed at 0x803223B0; the second names a function inside it.

A decompilation project may publish a plainer list instead ("symbol_addrs",
one name per line, as the splat tool reads it), which load_list reads:

mainLoop = 0x80002548; // type:func size:0xCB0 (global, .text, src/code0/main.c)

The same facts, differently written: the name, where it is, that it is a
function, how long it is and which source file it came from.
"""

import re
from dataclasses import dataclass, field

SECTION = re.compile(r"^ (\.\w+)\s+0x([0-9a-f]{16})\s+0x([0-9a-f]+)\s+(\S+)$")
SYMBOL = re.compile(r"^\s+0x([0-9a-f]{16})\s+(\w+)$")


@dataclass
class Symbols:
    functions: dict[int, str] = field(default_factory=dict)  # address -> name
    addresses: dict[str, int] = field(default_factory=dict)  # every name -> address
    # Blocks of code, one per original source file: (start, end, file name)
    code_blocks: list[tuple[int, int, str]] = field(default_factory=list)

    def source_file(self, address: int) -> str | None:
        for start, end, name in self.code_blocks:
            if start <= address < end:
                return name
        return None

    def is_library(self, address: int) -> bool:
        """Is this address part of Nintendo's OS library rather than the game?"""
        return "libultra" in (self.source_file(address) or "")


def load_map(path: str) -> Symbols:
    symbols = Symbols()
    in_code = False
    with open(path) as lines:
        for line in lines:
            section = SECTION.match(line)
            if section:
                name, start, size = section[1], int(section[2], 16), int(section[3], 16)
                in_code = name == ".text" and size > 0
                if in_code:
                    symbols.code_blocks.append((start, start + size, section[4]))
                continue
            symbol = SYMBOL.match(line)
            if symbol:
                symbols.addresses.setdefault(symbol[2], int(symbol[1], 16))
            if symbol and in_code:
                symbols.functions.setdefault(int(symbol[1], 16), symbol[2])
            elif not symbol and not line.startswith("  "):
                in_code = False
    return symbols


LISTED = re.compile(r"^(\w+)\s*=\s*0x([0-9A-Fa-f]+);\s*(?://(.*))?$")


def load_list(path: str) -> Symbols:
    """Read a decompilation project's list of names (see the top of this file)."""
    symbols = Symbols()
    with open(path) as lines:
        for line in lines:
            found = LISTED.match(line.strip())
            if not found:
                continue
            name, address, notes = found[1], int(found[2], 16), found[3] or ""
            if "ignore:true" in notes or address < 0x80000000:
                continue  # not a place in the running game's memory
            symbols.addresses.setdefault(name, address)
            size = re.search(r"size:0x([0-9A-Fa-f]+)", notes)
            source = re.search(r"\.text,\s*([^)\s]+)\)", notes)
            if "type:func" in notes:
                symbols.functions.setdefault(address, name)
                if size and source:
                    symbols.code_blocks.append((address, address + int(size[1], 16), source[1]))
    return symbols


def find_names(rom_path: str, game_code: str, folder: str = "symbols") -> Symbols | None:
    """The names for a ROM, if we have been given any.

    Looked for in the symbols folder under the ROM's file name or its
    four-letter game code: a linker map (.map) or a list of names (.txt).
    """
    import os

    stem = os.path.splitext(os.path.basename(rom_path))[0]
    for name in (stem, game_code):
        for ending, reader in ((".map", load_map), (".txt", load_list)):
            path = os.path.join(folder, name + ending)
            if os.path.exists(path):
                return reader(path)
    return None
