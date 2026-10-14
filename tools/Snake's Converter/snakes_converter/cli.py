"""Command line interface."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import APP_NAME, __version__
from .converters import CATEGORY_LABELS, category_of, convert_file, targets_for
from .core import ConversionError, Options
from .tools import find_ffmpeg, find_libreoffice


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="snakes-converter",
        description=f"{APP_NAME} {__version__} - convert audio, video, images, documents and more. "
                    "Run without arguments to open the app.",
    )
    parser.add_argument("files", nargs="*", type=Path, help="files to convert")
    parser.add_argument("-t", "--to", metavar="FORMAT", help="target format, e.g. wav, mp3, pdf, png")
    parser.add_argument("-o", "--output-dir", type=Path, help="folder for the converted files "
                        "(default: next to each source file)")
    parser.add_argument("--overwrite", action="store_true", help="replace existing files instead of "
                        "adding a number to the name")
    parser.add_argument("--bitrate", default="192k", help="audio bitrate for lossy formats (default: 192k)")
    parser.add_argument("--video-quality", choices=["high", "balanced", "small"], default="balanced")
    parser.add_argument("--quality", type=int, default=90, help="JPEG/WebP quality 1-100 (default: 90)")
    parser.add_argument("--dpi", type=int, default=150, help="resolution for PDF to image (default: 150)")
    parser.add_argument("--formats", action="store_true",
                        help="list the formats each given file can be converted to")
    parser.add_argument("--doctor", action="store_true", help="show which helper programs were found")
    parser.add_argument("--version", action="version", version=f"{APP_NAME} {__version__}")
    return parser


def _doctor() -> int:
    print(f"{APP_NAME} {__version__}")
    print(f"  ffmpeg       {find_ffmpeg() or 'NOT FOUND - audio/video conversion is unavailable'}")
    print(f"  LibreOffice  {find_libreoffice() or 'not found (optional) - built-in document engine in use'}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)

    if args.doctor:
        return _doctor()
    if not args.files:
        parser.error("no files given")
    if args.formats:
        for path in args.files:
            category = CATEGORY_LABELS.get(category_of(path), "Unsupported")
            formats = ", ".join(targets_for(path)) or "-"
            print(f"{path}  [{category}]  ->  {formats}")
        return 0
    if not args.to:
        parser.error("choose a target format with --to (see --formats)")

    opts = Options(audio_bitrate=args.bitrate, video_quality=args.video_quality,
                   image_quality=max(1, min(args.quality, 100)), pdf_dpi=max(36, min(args.dpi, 600)),
                   overwrite=args.overwrite)
    failures = 0
    for path in args.files:
        try:
            outputs = convert_file(path, args.to, args.output_dir, opts)
        except ConversionError as exc:
            failures += 1
            print(f"FAILED  {path}: {exc}", file=sys.stderr)
        except KeyboardInterrupt:
            print("Cancelled.", file=sys.stderr)
            return 130
        else:
            shown = str(outputs[0]) if len(outputs) == 1 else f"{len(outputs)} files in {outputs[0].parent}"
            print(f"OK      {path} -> {shown}")
    return 1 if failures else 0
