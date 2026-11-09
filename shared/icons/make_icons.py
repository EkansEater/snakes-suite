"""Generate the Snake's Suite icon family.

Every icon shares one tile: the dark-green rounded square with the suite's snake
faded into the background as a watermark (only its red tongue keeps its colour).
In front sits the app's own symbol in bright green, so each app can be told
apart at taskbar size.

    python shared/icons/make_icons.py

Writes <id>.svg, <id>.png (512 px) and <id>.ico next to this file. PNG and ICO
need rsvg-convert and ImageMagick (`magick`); the SVGs need nothing.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
GREEN = "#7ee787"   # the symbol
GHOST = "#26392c"   # the watermark snake, a step above the tile
RED = "#ff7b72"     # the snake's tongue: the only red in the family
DARK = "#0d1410"

TILE = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1e2b22"/>
      <stop offset="1" stop-color="#0d1410"/>
    </linearGradient>
  </defs>
  <rect x="8" y="8" width="240" height="240" rx="52" fill="url(#bg)"/>
  <!-- the snake, as a watermark -->
  <path d="M166 70 C 120 52, 82 72, 96 104 C 108 132, 160 124, 164 156 C 168 190, 116 200, 86 184"
        fill="none" stroke="{ghost}" stroke-width="26" stroke-linecap="round"/>
  <ellipse cx="170" cy="70" rx="22" ry="17" fill="{ghost}"/>
  <path d="M190 74 L206 78 M206 78 L214 72 M206 78 L213 85" stroke="{red}" stroke-width="5" stroke-linecap="round" fill="none"/>
  <!-- the app's symbol -->
{glyph}
</svg>
"""


def S(w: float) -> str:
    """A green line `w` wide."""
    return f'fill="none" stroke="{GREEN}" stroke-width="{w:g}" stroke-linecap="round" stroke-linejoin="round"'


F = f'fill="{GREEN}"'


def star(cx: float, cy: float, r: float) -> str:
    """A four-pointed sparkle."""
    k = r * 0.12
    return (f'  <path d="M{cx} {cy - r} Q{cx + k:g} {cy - k:g} {cx + r} {cy} Q{cx + k:g} {cy + k:g} {cx} {cy + r} '
            f'Q{cx - k:g} {cy + k:g} {cx - r} {cy} Q{cx - k:g} {cy - k:g} {cx} {cy - r} Z" {F}/>')


GLYPHS = {
    # Snake's Suite: an app grid.
    "suite": "\n".join(f'  <rect x="{62 + i * 48}" y="{62 + j * 48}" width="36" height="36" rx="9" {F}/>'
                       for i in range(3) for j in range(3)),
    # Word: a blank page with the cursor waiting at the top.
    "word": f"""  <path d="M70 44 L156 44 L196 84 L196 212 L70 212 Z" {S(10.4)}/>
  <path d="M156 44 L156 84 L196 84" {S(9.1)}/>
  <path d="M96 76 L96 120" {S(13)}/>""",
    # Spreadsheets: a table of cells.
    "sheets": f"""  <rect x="50" y="70" width="156" height="116" rx="12" {S(10.4)}/>
  <path d="M102 70 L102 186 M154 70 L154 186 M50 109 L206 109 M50 148 L206 148" {S(9.1)}/>""",
    # Slides: a screen on a stand, with a rising line on it.
    "slides": f"""  <rect x="46" y="60" width="164" height="104" rx="12" {S(10.4)}/>
  <path d="M128 164 L128 196 M98 198 L158 198" {S(10.4)}/>
  <path d="M78 136 L110 106 L138 124 L180 88" {S(9.1)}/>""",
    # Paint: a brush.
    "paint": f"""  <path d="M200 56 L134 122" {S(14.3)}/>
  <path d="M126 120 C 100 112, 72 132, 74 162 C 74 180, 64 190, 50 196 C 92 206, 136 184, 140 140 Z" {F}/>""",
    # Photo: a framed landscape with a sun.
    "photo": f"""  <rect x="46" y="64" width="164" height="128" rx="16" {S(10.4)}/>
  <path d="M60 180 L104 122 L134 158 L156 134 L196 180 Z" {F}/>
  <circle cx="168" cy="100" r="14" {F}/>""",
    # Player: a play button in a ring.
    "player": f"""  <circle cx="128" cy="128" r="76" {S(11.7)}/>
  <path d="M110 94 L164 128 L110 162 Z" {F} stroke="{GREEN}" stroke-width="6" stroke-linejoin="round"/>""",
    # Movie Maker: a clapperboard.
    "movie": f"""  <rect x="52" y="112" width="152" height="80" rx="10" {S(10.4)}/>
  <g transform="rotate(-14 52 104)">
    <rect x="52" y="80" width="152" height="24" rx="5" {F}/>
    <path d="M84 80 L100 104 M124 80 L140 104 M164 80 L180 104" stroke="{DARK}" stroke-width="8"/>
  </g>""",
    # Code: </>.
    "code": f"""  <path d="M88 78 L46 128 L88 178" {S(14.3)}/>
  <path d="M168 78 L210 128 L168 178" {S(14.3)}/>
  <path d="M144 70 L112 186" {S(11.7)}/>""",
    # Terminal: a shell prompt, >_.
    "terminal": f"""  <path d="M64 88 L110 128 L64 168" {S(15.6)}/>
  <path d="M130 168 L196 168" {S(15.6)}/>""",
    # Snake's Net: a download arrow and an upload arrow side by side.
    "net": f"""  <path d="M96 56 L96 196 M70 170 L96 198 L122 170" {S(13)}/>
  <path d="M160 200 L160 60 M134 86 L160 58 L186 86" {S(13)}/>""",
    # Compressor: two arrows pressing onto a bar.
    "compressor": f"""  <path d="M128 46 L128 98 M104 76 L128 100 L152 76" {S(13)}/>
  <path d="M128 210 L128 158 M104 180 L128 156 L152 180" {S(13)}/>
  <path d="M60 128 L196 128" {S(14.3)}/>""",
    # Converter: two arrows chasing each other round.
    "converter": f"""  <path d="M64 116 A 66 66 0 0 1 188 98" {S(13)}/>
  <path d="M196 66 L190 102 L156 92" {S(13)}/>
  <path d="M192 140 A 66 66 0 0 1 68 158" {S(13)}/>
  <path d="M60 190 L66 154 L100 164" {S(13)}/>""",
    # Recompiler: a chip.
    "recompiler": f"""  <rect x="78" y="78" width="100" height="100" rx="12" {S(10.4)}/>
  <rect x="108" y="108" width="40" height="40" rx="6" {F}/>
""" + "\n".join(f'  <path d="M{p} 52 L{p} 70 M{p} 186 L{p} 204 M52 {p} L70 {p} M186 {p} L204 {p}" {S(7.8)}/>'
                for p in (104, 128, 152)),
    # SoundPad: a 2x2 pad with one pad lit.
    "soundpad": f"""  <rect x="58" y="58" width="62" height="62" rx="14" {F}/>
  <rect x="136" y="58" width="62" height="62" rx="14" {S(7.8)}/>
  <rect x="58" y="136" width="62" height="62" rx="14" {S(7.8)}/>
  <rect x="136" y="136" width="62" height="62" rx="14" {S(7.8)}/>""",
    # MP3 Converter: a pair of notes.
    "mp3": f"""  <circle cx="90" cy="176" r="22" {F}/>
  <circle cx="178" cy="160" r="22" {F}/>
  <path d="M110 176 L110 80 L198 62 L198 160" {S(11.7)}/>
  <path d="M110 104 L198 86" {S(11.7)}/>""",
    # DAW: level meters.
    "daw": "\n".join(f'  <path d="M{x} {128 - h} L{x} {128 + h}" {S(14.3)}/>'
                     for x, h in ((56, 26), (92, 56), (128, 78), (164, 48), (200, 22))),
    # Screen Recorder: the corners of a capture region round a record light.
    "screen": f"""  <path d="M50 92 L50 56 L86 56 M170 56 L206 56 L206 92 M206 164 L206 200 L170 200 M86 200 L50 200 L50 164" {S(11.7)}/>
  <circle cx="128" cy="128" r="30" {F}/>""",
    # Snake's Studio: sparkles.
    "studio": star(116, 136, 70) + "\n" + star(190, 70, 26),
}


def main() -> None:
    rsvg, magick = shutil.which("rsvg-convert"), shutil.which("magick")
    for name, glyph in GLYPHS.items():
        svg = HERE / f"{name}.svg"
        svg.write_text(TILE.format(glyph=glyph, ghost=GHOST, red=RED))
        if rsvg:
            png = HERE / f"{name}.png"
            subprocess.run([rsvg, "-w", "512", "-h", "512", str(svg), "-o", str(png)], check=True)
            if magick:
                subprocess.run([magick, str(png), "-define", "icon:auto-resize=256,128,64,48,32,16",
                                str(HERE / f"{name}.ico")], check=True)
        print("wrote", svg.name)


if __name__ == "__main__":
    main()
