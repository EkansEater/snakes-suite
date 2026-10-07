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
