"""Registry that maps a file to the formats it can be converted to."""

from __future__ import annotations

import threading
from pathlib import Path

from ..core import ConversionError, Options, Progress, unique_path
from . import document, image, media, office, pdf, sheet

CATEGORY_LABELS = {
    "audio": "Audio",
    "video": "Video",
    "image": "Image",
    "document": "Document",
    "spreadsheet": "Spreadsheet",
    "presentation": "Presentation",
    "pdf": "PDF",
}

# Different spellings of the same format.
_SAME = {"jpeg": "jpg", "jfif": "jpg", "tif": "tiff", "aif": "aiff", "oga": "ogg"}


def _ext(path: Path) -> str:
    return path.suffix.lower().lstrip(".")


def category_of(path: Path) -> str | None:
    ext = _ext(path)
    if ext == "pdf":
        return "pdf"
    if ext in media.AUDIO_IN:
        return "audio"
    if ext in media.VIDEO_IN:
        return "video"
    if ext in image.IMAGE_IN:
        return "image"
    if ext in document.DOCUMENT_IN:
        return "document"
    if ext in sheet.SHEET_IN:
        return "spreadsheet"
    if ext in office.PRESENTATION_IN:
        return "presentation"
    return None


def is_supported(path: Path) -> bool:
    return category_of(path) is not None


def targets_for(path: Path) -> list[str]:
    """Formats this file can be converted to right now, best default first."""
    ext = _ext(path)
    category = category_of(path)
    if category == "audio":
        out = media.AUDIO_OUT if media.available() else []
    elif category == "video":
        out = media.VIDEO_OUT + media.AUDIO_OUT if media.available() else []
    elif category == "image":
        out = image.targets()
    elif category == "document":
        out = document.targets(ext)
    elif category == "spreadsheet":
        out = sheet.targets(ext)
    elif category == "presentation":
        # PDF is built in for PowerPoint files; LibreOffice adds the rest (and draws PDFs itself).
        out = office.PRESENTATION_OUT if office.available() else (["pdf"] if ext in ("pptx", "ppsx") else [])
    elif category == "pdf":
        out = pdf.PDF_OUT
    else:
        out = []
    same = _SAME.get(ext, ext)
    return [t for t in out if t != same]


def missing_tool(path: Path) -> str | None:
    """Name of the program to install when a known file type has no targets."""
    category = category_of(path)
    if category in ("audio", "video"):
        return "ffmpeg"
    if category in ("document", "spreadsheet", "presentation"):
        return "LibreOffice"
    return None


def convert_file(src: Path, target: str, outdir: Path | None = None,
                 opts: Options | None = None, progress: Progress | None = None,
                 cancel: threading.Event | None = None) -> list[Path]:
    """Convert `src` to `target` and return the files that were written."""
    src = Path(src)
    opts = opts or Options()
    progress = progress or (lambda fraction: None)
    cancel = cancel or threading.Event()
    target = target.lower().lstrip(".")
    target = _SAME.get(target, target)

    if not src.is_file():
        raise ConversionError(f"File not found: {src}")
    category = category_of(src)
    if category is None:
        raise ConversionError(f"Unsupported file type: {src.suffix or src.name}")
    if target not in targets_for(src):
        tool = missing_tool(src)
        hint = f" Installing {tool} may enable it." if tool and not targets_for(src) else ""
        raise ConversionError(
            f"Cannot convert {_ext(src).upper()} to {target.upper()}.{hint}"
        )

    outdir = Path(outdir) if outdir else src.parent
    outdir.mkdir(parents=True, exist_ok=True)
    dst = outdir / f"{src.stem}.{target}"
    if not opts.overwrite:
        dst = unique_path(dst)

    if category in ("audio", "video"):
        outputs = media.convert(src, dst, target, opts, progress, cancel)
    elif category == "image":
        outputs = image.convert(src, dst, target, opts, progress, cancel)
    elif category == "document":
        outputs = document.convert(src, dst, target, opts, progress, cancel)
    elif category == "spreadsheet":
        outputs = sheet.convert(src, dst, target, opts, progress, cancel)
    elif category == "presentation":
        if target == "pdf" and not office.available():
            from ..core import ensure_qt
            from .slides_pdf import render

            ensure_qt()
            try:
                render(src, dst, src.stem)
            except Exception as exc:
                raise ConversionError(f"The presentation could not be drawn: {exc}") from None
            outputs = [dst]
        else:
            outputs = office.convert(src, dst, target, progress, cancel)
    else:
        outputs = pdf.convert(src, dst, target, opts, progress, cancel)
    progress(1.0)
    return outputs
