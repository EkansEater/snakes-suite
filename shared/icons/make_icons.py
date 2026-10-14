"""Generate the Snake's Suite icon family.

Every icon is the Snake's Code logo: the same tile, the same snake. Only the
muted glyph around the snake changes (the `< >` brackets on Snake's Code).

    python shared/icons/make_icons.py

Writes <id>.svg, <id>.png (512 px) and <id>.ico next to this file. PNG and ICO
need rsvg-convert and ImageMagick (`magick`); the SVGs need nothing.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
GLYPH = "#3c5a45"  # the muted green of the Snake's Code brackets
RED = "#ff7b72"

TILE = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1e2b22"/>
      <stop offset="1" stop-color="#0d1410"/>
    </linearGradient>
    <linearGradient id="body" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7ee787"/>
      <stop offset="1" stop-color="#2ea043"/>
    </linearGradient>
  </defs>
  <rect x="8" y="8" width="240" height="240" rx="52" fill="url(#bg)"/>
{glyph}
  <!-- snake body: an S curve -->
  <path d="M166 70 C 120 52, 82 72, 96 104 C 108 132, 160 124, 164 156 C 168 190, 116 200, 86 184"
        fill="none" stroke="url(#body)" stroke-width="26" stroke-linecap="round"/>
  <!-- head -->
  <ellipse cx="170" cy="70" rx="22" ry="17" fill="#7ee787"/>
  <circle cx="176" cy="64" r="4.5" fill="#0d1410"/>
  <path d="M190 74 L206 78 M206 78 L214 72 M206 78 L213 85" stroke="{red}" stroke-width="4" stroke-linecap="round" fill="none"/>
{extra}</svg>
"""

S = f'fill="none" stroke="{GLYPH}" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"'
F = f'fill="{GLYPH}"'

GLYPHS = {
    # Snake's Code: the original brackets.
    "code": f"""  <path d="M70 84 L36 128 L70 172" {S}/>
  <path d="M186 84 L220 128 L186 172" {S}/>""",
    # Snake's Suite: an app grid, a column of tiles on each side.
    "suite": "\n".join(
        f'  <rect x="{x}" y="{y}" width="28" height="28" rx="8" {F}/>'
        for x in (30, 198) for y in (82, 116, 150)
    ),
    # Compressor: two jaws squeezing inwards.
    "compressor": f"""  <path d="M30 84 L30 172" {S}/>
  <path d="M52 104 L72 128 L52 152" {S}/>
  <path d="M226 96 L226 172" {S}/>
  <path d="M204 104 L184 128 L204 152" {S}/>""",
    # Converter: two arrows chasing each other round the snake.
    "converter": f"""  <path d="M58 170 A 82 82 0 0 1 58 86" {S}/>
  <path d="M40 92 L58 86 L64 104" {S}/>
  <path d="M198 92 A 82 82 0 0 1 198 176" {S}/>
  <path d="M216 170 L198 176 L192 158" {S}/>""",
    # Decompiler: the pins of a chip (or a cartridge edge).
    "decompiler": "\n".join(
        f'  <path d="M{x1} {y} L{x2} {y}" {S}/>'
        for (x1, x2) in ((30, 62), (194, 226)) for y in (96, 128, 160)
    ),
    # SoundPad: a 2x2 pad on the left, sound waves on the right.
    "soundpad": "\n".join(
        f'  <rect x="{x}" y="{y}" width="24" height="24" rx="6" {F}/>'
        for x in (24, 54) for y in (100, 130)
    ) + f"""
  <path d="M196 106 Q 208 128 196 150" {S}/>
  <path d="M218 94 Q 236 128 218 162" {S}/>""",
    # MP3 Converter: a note on the left, an arrow down into a tray on the right.
    "mp3": f"""  <path d="M60 156 L60 92 L84 84" {S}/>
  <circle cx="46" cy="160" r="15" {F}/>
  <path d="M212 96 L212 146 M196 132 L212 148 L228 132" {S}/>
  <path d="M194 172 L230 172" {S}/>""",
    # DAW: level meters / waveform bars on both sides.
    "daw": "\n".join(
        f'  <path d="M{x} {128 - h} L{x} {128 + h}" {S}/>'
        for x, h in ((30, 18), (56, 36), (200, 30), (226, 16))
    ),
    # Screen Recorder: the corners of a capture region.
    "screen": f"""  <path d="M30 74 L30 44 L60 44" {S}/>
  <path d="M30 182 L30 212 L60 212" {S}/>
  <path d="M226 182 L226 212 L196 212" {S}/>
  <path d="M226 110 L226 140" {S}/>""",
}

# A record light for the Screen Recorder, bottom left of the snake.
EXTRA = {
    "screen": f'  <circle cx="58" cy="128" r="14" fill="{RED}"/>\n',
}


def main() -> None:
    rsvg, magick = shutil.which("rsvg-convert"), shutil.which("magick")
    for name, glyph in GLYPHS.items():
        svg = HERE / f"{name}.svg"
        svg.write_text(TILE.format(glyph=glyph, red=RED, extra=EXTRA.get(name, "")))
        if rsvg:
            png = HERE / f"{name}.png"
            subprocess.run([rsvg, "-w", "512", "-h", "512", str(svg), "-o", str(png)], check=True)
            if magick:
                subprocess.run([magick, str(png), "-define", "icon:auto-resize=256,128,64,48,32,16",
                                str(HERE / f"{name}.ico")], check=True)
        print("wrote", svg.name)


if __name__ == "__main__":
    main()
