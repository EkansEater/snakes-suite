"""Turn the Snake's Suite icons into Android vector drawables.

Reads the SVGs that `shared/icons/make_icons.py` writes and
writes, for every tool id:

    core/src/main/res/drawable/tile_<id>.xml          the whole icon (hub tiles, header bars)
    core/src/main/res/drawable/ic_launcher_fg_<id>.xml adaptive-icon foreground (no tile)
    core/src/main/res/drawable/ic_launcher_bg.xml      adaptive-icon background (the tile gradient)
    apps/<app>/src/main/res/mipmap-anydpi/ic_launcher.xml
    apps/studio/src/main/res/mipmap-anydpi/ic_<studio app>.xml

    python tools/make_icons.py
"""

from __future__ import annotations

import math
import re
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT.parent / "shared" / "icons"
DRAWABLE = ROOT / "core" / "src" / "main" / "res" / "drawable"
NS = "{http://www.w3.org/2000/svg}"
APPS = {"suite": "suite", "soundpad": "soundpad", "compressor": "compressor", "converter": "converter",
        "screen": "screen", "mp3": "mp3", "code": "code", "daw": "daw"}
# One APK (apps/studio) with a launcher icon for each Studio app.
STUDIO = ["word", "sheets", "slides", "paint", "photo", "player", "movie"]
ALL_IDS = list(APPS.values()) + ["recompiler"] + STUDIO

# Foreground scale: the 256 px artwork in the 108 dp adaptive canvas, inside the 72 dp visible circle.
FG_SCALE = 0.28
FG_SHIFT = (108 - 256 * FG_SCALE) / 2


def fmt(v: float) -> str:
    return f"{v:.2f}".rstrip("0").rstrip(".")


def rect_path(x, y, w, h, r) -> str:
    r = min(r, w / 2, h / 2)
    return (f"M{fmt(x + r)},{fmt(y)} H{fmt(x + w - r)} A{fmt(r)},{fmt(r)} 0 0 1 {fmt(x + w)},{fmt(y + r)} "
            f"V{fmt(y + h - r)} A{fmt(r)},{fmt(r)} 0 0 1 {fmt(x + w - r)},{fmt(y + h)} H{fmt(x + r)} "
            f"A{fmt(r)},{fmt(r)} 0 0 1 {fmt(x)},{fmt(y + h - r)} V{fmt(y + r)} "
            f"A{fmt(r)},{fmt(r)} 0 0 1 {fmt(x + r)},{fmt(y)} Z")


def ellipse_path(cx, cy, rx, ry) -> str:
    return (f"M{fmt(cx - rx)},{fmt(cy)} A{fmt(rx)},{fmt(ry)} 0 1 0 {fmt(cx + rx)},{fmt(cy)} "
            f"A{fmt(rx)},{fmt(ry)} 0 1 0 {fmt(cx - rx)},{fmt(cy)} Z")


def bbox(d: str) -> tuple[float, float, float, float]:
    """Rough bounding box from the numbers in a path (control points included)."""
    nums = [float(n) for n in re.findall(r"-?\d+(?:\.\d+)?", d)]
    xs, ys = nums[0::2], nums[1::2]
    return min(xs), min(ys), max(xs), max(ys)


def gradient(stops: list[tuple[str, str]], box) -> str:
    x0, y0, x1, y1 = box
    items = "\n".join(f'          <item android:offset="{o}" android:color="{c}"/>' for o, c in stops)
    return (f'      <gradient android:type="linear" android:startX="{fmt(x0)}" android:startY="{fmt(y0)}"'
            f' android:endX="{fmt(x1)}" android:endY="{fmt(y1)}">\n{items}\n      </gradient>')


def convert(svg: Path) -> tuple[str, list[str]]:
    """(background element, [foreground elements]) as VectorDrawable <path> XML."""
    root = ET.parse(svg).getroot()
    grads = {}
    for g in root.iter(f"{NS}linearGradient"):
        grads[g.get("id")] = [(s.get("offset"), s.get("stop-color")) for s in g.iter(f"{NS}stop")]
    background, fg = "", []
    for el in root:
        tag = el.tag.removeprefix(NS)
        if tag == "defs":
            continue
        if tag == "rect":
            d = rect_path(*(float(el.get(k, 0)) for k in ("x", "y", "width", "height", "rx")))
        elif tag == "ellipse":
            d = ellipse_path(*(float(el.get(k)) for k in ("cx", "cy", "rx", "ry")))
        elif tag == "circle":
            r = float(el.get("r"))
            d = ellipse_path(float(el.get("cx")), float(el.get("cy")), r, r)
        elif tag == "path":
            d = " ".join(el.get("d").split())
        else:
            continue
        attrs, children = [f'android:pathData="{d}"'], ""
        fill, stroke = el.get("fill", "#000000"), el.get("stroke")
        for kind, value in (("fill", fill), ("stroke", stroke)):
            if not value or value == "none":
                continue
            m = re.match(r"url\(#(\w+)\)", value)
            if m:
                x0, y0, x1, y1 = (8, 8, 248, 248) if tag == "rect" else bbox(d)
                children += (f'\n    <aapt:attr name="android:{kind}Color">\n'
                             f"{gradient(grads[m.group(1)], (x0, y0, x1, y1))}\n    </aapt:attr>")
            else:
                attrs.append(f'android:{kind}Color="{value}"')
        if stroke:
            attrs.append(f'android:strokeWidth="{el.get("stroke-width", "1")}"')
            if el.get("stroke-linecap"):
                attrs.append(f'android:strokeLineCap="{el.get("stroke-linecap")}"')
            if el.get("stroke-linejoin"):
                attrs.append(f'android:strokeLineJoin="{el.get("stroke-linejoin")}"')
        xml = "  <path " + "\n        ".join(attrs) + (f">{children}\n  </path>" if children else "/>")
        if tag == "rect" and el.get("width") == "240":
            background = xml
        else:
            fg.append(xml)
    return background, fg


def vector(size: int, body: str, viewport: int) -> str:
    return (f'<?xml version="1.0" encoding="utf-8"?>\n<!-- Generated by tools/make_icons.py. Do not edit. -->\n'
            f'<vector xmlns:android="http://schemas.android.com/apk/res/android"\n'
            f'    xmlns:aapt="http://schemas.android.com/aapt"\n'
            f'    android:width="{size}dp" android:height="{size}dp"\n'
            f'    android:viewportWidth="{viewport}" android:viewportHeight="{viewport}">\n{body}\n</vector>\n')


def main() -> None:
    DRAWABLE.mkdir(parents=True, exist_ok=True)
    for tool in ALL_IDS:
        bg, fg = convert(ICONS / f"{tool}.svg")
        (DRAWABLE / f"tile_{tool}.xml").write_text(vector(48, "\n".join([bg, *fg]), 256))
        group = (f'  <group android:scaleX="{FG_SCALE}" android:scaleY="{FG_SCALE}"'
                 f' android:translateX="{fmt(FG_SHIFT)}" android:translateY="{fmt(FG_SHIFT)}">\n'
                 + "\n".join(fg) + "\n  </group>")
        (DRAWABLE / f"ic_launcher_fg_{tool}.xml").write_text(vector(108, group, 108))
    bg_body = ('  <path android:pathData="M0,0 H108 V108 H0 Z">\n    <aapt:attr name="android:fillColor">\n'
               + gradient([("0", "#1e2b22"), ("1", "#0d1410")], (0, 0, 108, 108)) + "\n    </aapt:attr>\n  </path>")
    (DRAWABLE / "ic_launcher_bg.xml").write_text(vector(108, bg_body, 108))
    def adaptive(path: Path, tool: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            '<?xml version="1.0" encoding="utf-8"?>\n<!-- Generated by tools/make_icons.py. -->\n'
            '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
            '    <background android:drawable="@drawable/ic_launcher_bg"/>\n'
            f'    <foreground android:drawable="@drawable/ic_launcher_fg_{tool}"/>\n'
            f'    <monochrome android:drawable="@drawable/ic_launcher_fg_{tool}"/>\n'
            '</adaptive-icon>\n')

    for app, tool in APPS.items():
        adaptive(ROOT / "apps" / app / "src" / "main" / "res" / "mipmap-anydpi" / "ic_launcher.xml", tool)
    for tool in STUDIO:
        adaptive(ROOT / "apps" / "studio" / "src" / "main" / "res" / "mipmap-anydpi" / f"ic_{tool}.xml", tool)
    print("icons written for", ", ".join(ALL_IDS))


if __name__ == "__main__":
    main()
