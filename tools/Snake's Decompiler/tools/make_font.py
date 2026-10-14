"""Draws the menu's font and writes it out as snakedecomp/runtime/font.h.

The game program cannot read font files, so the letters are stored inside it
as a picture: every printable character side by side, each in a box 32 dots
wide and 64 tall. That is four times the size the menu usually shows them
at; the graphics card shrinks them smoothly to whatever size is needed.

Each dot is a letter from A (empty) to P (solid), sixteen shades, so that
edges can be soft instead of jagged.

Only needed if you want a different font:  python3 tools/make_font.py
(needs the Pillow library and the DejaVu fonts).
"""

import os

from PIL import Image, ImageDraw, ImageFont

FONT_FILE = "/usr/share/fonts/TTF/DejaVuSansMono-Bold.ttf"
WIDTH, HEIGHT, GAP = 32, 64, 4  # GAP: empty columns between characters
POINT_SIZE = 52  # chosen so one character is just under WIDTH dots wide

font = ImageFont.truetype(FONT_FILE, POINT_SIZE)
ascent, descent = font.getmetrics()
top = (HEIGHT - (ascent + descent)) // 2  # centre the line in the box

picture = Image.new("L", (95 * (WIDTH + GAP), HEIGHT), 0)
draw = ImageDraw.Draw(picture)
for index in range(95):
    character = chr(32 + index)
    left = index * (WIDTH + GAP) + GAP // 2 + (WIDTH - font.getlength(character)) / 2
    draw.text((left, top), character, font=font, fill=255)

out = os.path.join(os.path.dirname(__file__), "..", "snakedecomp", "runtime", "font.h")
with open(out, "w") as f:
    f.write("/* The menu's font: a picture of every printable character (space to ~)\n")
    f.write(" * side by side. One letter per dot, A = empty to P = solid. Generated\n")
    f.write(" * from DejaVu Sans Mono Bold by tools/make_font.py. */\n")
    f.write(f"#define FONT_W {WIDTH}\n#define FONT_H {HEIGHT}\n#define FONT_GAP {GAP}\n")
    f.write("#define FONT_PICTURE_W (95 * (FONT_W + FONT_GAP))\n")
    f.write("static const char *const font_rows[FONT_H] = {\n")
    for y in range(HEIGHT):
        row = "".join(chr(65 + picture.getpixel((x, y)) * 15 // 255) for x in range(picture.width))
        f.write(f'    "{row}",\n')
    f.write("};\n")
print(f"wrote {out}: characters are {font.getlength('M'):.1f} dots wide, line is {ascent + descent} tall")
