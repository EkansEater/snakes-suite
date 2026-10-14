"""Conversions delegated to LibreOffice, when it is installed."""

from __future__ import annotations

import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path

from ..core import Cancelled, ConversionError, Progress
from ..tools import find_libreoffice, popen_kwargs

PRESENTATION_IN = {"ppt", "pptx", "odp", "pps", "ppsx"}
PRESENTATION_OUT = ["pdf", "pptx", "odp"]

# LibreOffice picks the wrong export filter for a few extensions unless told.
_FILTERS = {"txt": "txt:Text (encoded):UTF8"}


def available() -> bool:
    return find_libreoffice() is not None


def convert(src: Path, dst: Path, target: str,
            progress: Progress, cancel: threading.Event) -> list[Path]:
    soffice = find_libreoffice()
    if not soffice:
        raise ConversionError(
            "This conversion needs LibreOffice. Install it from https://www.libreoffice.org "
            "and try again."
        )
    with tempfile.TemporaryDirectory(prefix="snakes-converter-") as tmp:
        outdir = Path(tmp) / "out"
        outdir.mkdir()
        # A private profile lets this run alongside an already open LibreOffice.
        profile = (Path(tmp) / "profile").as_uri()
        cmd = [soffice, f"-env:UserInstallation={profile}", "--headless", "--norestore",
               "--convert-to", _FILTERS.get(target, target), "--outdir", str(outdir), str(src)]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, errors="replace", **popen_kwargs())
        started = time.monotonic()
        while proc.poll() is None:
            if cancel.is_set():
                proc.kill()
                proc.wait()
                raise Cancelled()
            if time.monotonic() - started > 600:
                proc.kill()
                proc.wait()
                raise ConversionError("LibreOffice took too long and was stopped.")
            time.sleep(0.1)
        produced = [p for p in outdir.iterdir() if p.is_file()]
        if not produced:
            detail = (proc.stdout.read() or "").strip().splitlines()[-3:]
            raise ConversionError("LibreOffice could not convert this file. " + " ".join(detail))
        shutil.move(str(produced[0]), str(dst))
    return [dst]
