"""Image conversion through Pillow (plus Qt for reading SVG)."""

from __future__ import annotations

import io
import threading
from pathlib import Path

from PIL import Image, ImageOps, ImageSequence, features

from ..core import ConversionError, Options, Progress, ensure_qt

IMAGE_IN = {
    "png", "jpg", "jpeg", "jfif", "webp", "bmp", "tif", "tiff", "gif", "ico",
    "heic", "heif", "avif", "svg", "tga", "ppm", "pgm", "psd", "dds",
}
_FORMATS = {
    "png": "PNG", "jpg": "JPEG", "webp": "WEBP", "pdf": "PDF", "gif": "GIF",
    "bmp": "BMP", "tiff": "TIFF", "ico": "ICO", "avif": "AVIF",
}
_NO_ALPHA = {"jpg", "bmp", "pdf"}
_ANIMATED = {"gif", "webp", "png"}


def targets() -> list[str]:
    out = ["png", "jpg", "webp", "pdf", "gif", "bmp", "tiff", "ico"]
    if features.check("avif"):
        out.append("avif")
    return out


def _render_svg(src: Path) -> Image.Image:
    ensure_qt()
    from PySide6.QtCore import QBuffer, QIODevice, QSize, Qt
    from PySide6.QtGui import QImage, QPainter
    from PySide6.QtSvg import QSvgRenderer

    renderer = QSvgRenderer(str(src))
    if not renderer.isValid():
        raise ConversionError("The SVG file could not be read.")
    size = renderer.defaultSize()
    if size.isEmpty():
        size = QSize(1024, 1024)
    scale = max(1.0, 1024 / max(size.width(), size.height()))
    image = QImage(size * scale, QImage.Format.Format_ARGB32)
    image.fill(Qt.GlobalColor.transparent)
    painter = QPainter(image)
    renderer.render(painter)
    painter.end()
    buffer = QBuffer()
    buffer.open(QIODevice.OpenModeFlag.WriteOnly)
    image.save(buffer, "PNG")
    return Image.open(io.BytesIO(bytes(buffer.data())))


def _open(src: Path) -> Image.Image:
    ext = src.suffix.lower().lstrip(".")
    if ext == "svg":
        return _render_svg(src)
    if ext in ("heic", "heif"):
        try:
            import pillow_heif

            pillow_heif.register_heif_opener()
        except ImportError:
            raise ConversionError(
                "HEIC images need the optional 'pillow-heif' package (pip install pillow-heif)."
            ) from None
    try:
        return Image.open(src)
    except Exception:
        raise ConversionError("The image could not be read. The file may be damaged.") from None


def _flatten(img: Image.Image) -> Image.Image:
    """Drop transparency by compositing onto white."""
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        rgba = img.convert("RGBA")
        background = Image.new("RGB", rgba.size, "white")
        background.paste(rgba, mask=rgba.getchannel("A"))
        return background
    return img.convert("RGB")


def _prepare(img: Image.Image, target: str) -> Image.Image:
    if target in _NO_ALPHA:
        return _flatten(img)
    if target == "ico":
        img = img.convert("RGBA")
        img.thumbnail((256, 256), Image.Resampling.LANCZOS)
        side = max(img.size)
        canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        canvas.paste(img, ((side - img.width) // 2, (side - img.height) // 2))
        return canvas
    if img.mode not in ("RGB", "RGBA", "L", "LA", "P"):
        return img.convert("RGBA" if "A" in img.getbands() else "RGB")
    return img


def _save_args(target: str, opts: Options, img: Image.Image) -> dict:
    if target == "jpg":
        return {"quality": opts.image_quality, "optimize": True}
    if target in ("webp", "avif"):
        return {"quality": opts.image_quality}
    if target == "png":
        return {"optimize": True}
    if target == "tiff":
        return {"compression": "tiff_lzw"}
    if target == "ico":
        sizes = [s for s in (16, 24, 32, 48, 64, 128, 256) if s <= img.width] or [img.width]
        return {"sizes": [(s, s) for s in sizes]}
    return {}


def convert(src: Path, dst: Path, target: str, opts: Options,
            progress: Progress, cancel: threading.Event) -> list[Path]:
    img = _open(src)
    fmt = _FORMATS[target]
    frames = getattr(img, "n_frames", 1)
    try:
        if frames > 1 and (target in _ANIMATED or target == "pdf"):
            # Animations stay animated; multi-page images become multi-page PDFs.
            mode = "RGBA" if target in ("webp", "png") else None
            pages = []
            for frame in ImageSequence.Iterator(img):
                frame = _flatten(frame) if target == "pdf" else frame.copy()
                pages.append(frame.convert(mode) if mode else frame)
            extra = {}
            if target != "pdf":
                extra = {"duration": img.info.get("duration", 100), "loop": img.info.get("loop", 0)}
            pages[0].save(dst, fmt, save_all=True, append_images=pages[1:], **extra)
        else:
            img = _prepare(ImageOps.exif_transpose(img), target)
            img.save(dst, fmt, **_save_args(target, opts, img))
    except ConversionError:
        raise
    except Exception as exc:
        dst.unlink(missing_ok=True)
        raise ConversionError(f"The image could not be saved as {target.upper()}: {exc}") from None
    return [dst]
