"""Loading an N64 ROM and reading its header.

An N64 cartridge is one big blob of bytes:

    0x0000 - 0x003F   header (name, entry point, checksums, ...)
    0x0040 - 0x0FFF   boot code (the "IPL3"), identical across most games
    0x1000 - ...      the game itself: code and data

The N64's CPU is big-endian, meaning the most significant byte of a number
comes first. ROM dumps exist in three byte orders depending on the dumping
hardware, so the first job is to normalise them all to big-endian (.z64).
"""

import struct
from dataclasses import dataclass

HEADER_SIZE = 0x40
CODE_START = 0x1000  # where the game's own code begins in the ROM

# Every ROM starts with the same 4-byte value, so its byte order tells us
# which dump format we are looking at.
MAGIC_Z64 = bytes([0x80, 0x37, 0x12, 0x40])  # big-endian, the native order
MAGIC_V64 = bytes([0x37, 0x80, 0x40, 0x12])  # every pair of bytes swapped
MAGIC_N64 = bytes([0x40, 0x12, 0x37, 0x80])  # every 4 bytes reversed

# The checksum covers the first megabyte after the boot code.
CHECKSUM_START = 0x1000
CHECKSUM_END = 0x101000
CHECKSUM_SEED_6102 = 0xF8CA4DDC

# The boot code copies exactly 1 MB of the ROM into memory before starting
# the game, so the main code segment cannot be larger than that.
BOOT_LOAD_SIZE = 0x100000

REGIONS = {
    "E": "USA",
    "J": "Japan",
    "P": "Europe",
    "A": "All regions",
}


def to_big_endian(data: bytes) -> bytes:
    """Convert a ROM dump of any byte order to big-endian (.z64) order."""
    magic = data[:4]
    if magic == MAGIC_Z64:
        return data
    if magic == MAGIC_V64:
        swapped = bytearray(len(data))
        swapped[0::2] = data[1::2]
        swapped[1::2] = data[0::2]
        return bytes(swapped)
    if magic == MAGIC_N64:
        swapped = bytearray(len(data))
        for i in range(4):
            swapped[i::4] = data[3 - i :: 4]
        return bytes(swapped)
    raise ValueError(f"not an N64 ROM (first bytes are {magic.hex()})")


@dataclass(frozen=True)
class Segment:
    """A piece of the ROM that gets loaded to a fixed place in memory.

    Code refers to memory addresses ("vram"), not ROM offsets, so to read the
    instruction at an address we need to know which segment holds it.
    """

    name: str
    rom_start: int
    vram_start: int
    size: int  # in bytes

    @property
    def vram_end(self) -> int:
        return self.vram_start + self.size

    def contains(self, vram: int) -> bool:
        return self.vram_start <= vram < self.vram_end

    def to_rom(self, vram: int) -> int:
        return vram - self.vram_start + self.rom_start

    def to_vram(self, rom_offset: int) -> int:
        return rom_offset - self.rom_start + self.vram_start


@dataclass
class Header:
    entry_point: int  # memory address where the game's code starts running
    libultra_version: str  # revision letter of Nintendo's SDK library
    crc1: int
    crc2: int
    name: str
    game_code: str  # e.g. "NSME": N = cartridge, SM = Super Mario, E = USA
    version: int

    @property
    def region(self) -> str:
        return REGIONS.get(self.game_code[3], "unknown")


class Rom:
    def __init__(self, data: bytes):
        self.data = to_big_endian(data)
        self.header = self._parse_header()

    @classmethod
    def from_file(cls, path: str) -> "Rom":
        with open(path, "rb") as f:
            return cls(f.read())

    def _parse_header(self) -> Header:
        # ">" means big-endian, "I" means an unsigned 32-bit integer.
        entry_point, release, crc1, crc2 = struct.unpack_from(">IIII", self.data, 0x08)
        name = self.data[0x20:0x34].decode("ascii", errors="replace").strip()
        game_code = self.data[0x3B:0x3F].decode("ascii", errors="replace")
        return Header(
            entry_point=entry_point,
            libultra_version=chr(release & 0xFF),
            crc1=crc1,
            crc2=crc2,
            name=name,
            game_code=game_code,
            version=self.data[0x3F],
        )

    def word(self, offset: int) -> int:
        """Read one 32-bit big-endian value at a ROM offset."""
        return struct.unpack_from(">I", self.data, offset)[0]

    @property
    def main_segment(self) -> "Segment":
        """The code the boot code loads before starting the game.

        The boot code copies exactly 1 MB of the ROM, from 0x1000 onwards, to
        the entry point in memory. The game loads everything else itself.
        """
        return Segment("main", CODE_START, self.header.entry_point, BOOT_LOAD_SIZE)

    def compute_checksum(self) -> tuple[int, int]:
        """Compute the two checksums the boot code verifies (CIC-6102).

        The console refuses to boot if these don't match the header, so this
        also tells us whether the dump is intact.
        """
        mask = 0xFFFFFFFF
        t1 = t2 = t3 = t4 = t5 = t6 = CHECKSUM_SEED_6102
        for offset in range(CHECKSUM_START, CHECKSUM_END, 4):
            d = self.word(offset)
            if (t6 + d) & mask < t6:
                t4 = (t4 + 1) & mask
            t6 = (t6 + d) & mask
            t3 ^= d
            shift = d & 0x1F
            r = ((d << shift) | (d >> (32 - shift))) & mask
            t5 = (t5 + r) & mask
            if t2 > d:
                t2 ^= r
            else:
                t2 ^= t6 ^ d
            t1 = (t1 + (t5 ^ d)) & mask
        return t6 ^ t4 ^ t3, t5 ^ t2 ^ t1
