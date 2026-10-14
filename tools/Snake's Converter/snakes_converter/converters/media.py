"""Audio and video conversion through ffmpeg."""

from __future__ import annotations

import re
import subprocess
import threading
from pathlib import Path

from ..core import Cancelled, ConversionError, Options, Progress
from ..tools import find_ffmpeg, popen_kwargs

AUDIO_IN = {
    "mp3", "wav", "flac", "ogg", "oga", "opus", "m4a", "aac", "wma", "aiff", "aif",
    "ac3", "amr", "mka", "mp2", "ape", "wv", "caf", "au",
}
VIDEO_IN = {
    "mp4", "mkv", "webm", "mov", "avi", "flv", "wmv", "m4v", "mpg", "mpeg", "ts",
    "m2ts", "3gp", "ogv", "vob",
}
AUDIO_OUT = ["wav", "mp3", "flac", "ogg", "opus", "m4a", "aac", "aiff", "wma"]
VIDEO_OUT = ["mp4", "mkv", "webm", "mov", "avi", "gif"]

_CRF = {"high": 18, "balanced": 23, "small": 28}
_EVEN = "scale=trunc(iw/2)*2:trunc(ih/2)*2"  # H.264 needs even dimensions


def available() -> bool:
    return find_ffmpeg() is not None


def _audio_args(target: str, opts: Options) -> list[str]:
    rate = opts.audio_bitrate
    codecs = {
        "wav": ["-c:a", "pcm_s16le"],
        "aiff": ["-c:a", "pcm_s16be"],
        "flac": ["-c:a", "flac"],
        "mp3": ["-c:a", "libmp3lame", "-b:a", rate],
        "ogg": ["-c:a", "libvorbis", "-b:a", rate],
        "opus": ["-c:a", "libopus", "-b:a", rate],
        "m4a": ["-c:a", "aac", "-b:a", rate],
        "aac": ["-c:a", "aac", "-b:a", rate],
        "wma": ["-c:a", "wmav2", "-b:a", rate],
    }
    return ["-vn", *codecs[target]]


def _video_args(target: str, opts: Options) -> list[str]:
    crf = _CRF.get(opts.video_quality, 23)
    rate = opts.audio_bitrate
    if target in ("mp4", "mov", "mkv"):
        args = ["-c:v", "libx264", "-preset", "medium", "-crf", str(crf),
                "-pix_fmt", "yuv420p", "-vf", _EVEN, "-c:a", "aac", "-b:a", rate]
        if target != "mkv":
            args += ["-movflags", "+faststart"]
        return args
    if target == "webm":
        return ["-c:v", "libvpx-vp9", "-crf", str(crf + 9), "-b:v", "0",
                "-row-mt", "1", "-c:a", "libopus", "-b:a", rate]
    if target == "avi":
        quality = {"high": 3, "balanced": 5, "small": 8}.get(opts.video_quality, 5)
        return ["-c:v", "mpeg4", "-q:v", str(quality), "-c:a", "libmp3lame", "-b:a", rate]
    if target == "gif":
        width = {"high": 640, "balanced": 480, "small": 320}.get(opts.video_quality, 480)
        return ["-an", "-vf",
                f"fps=12,scale='min({width},iw)':-1:flags=lanczos,"
                "split[a][b];[a]palettegen[p];[b][p]paletteuse"]
    raise ConversionError(f"Unsupported video format: {target}")


def _duration(ffmpeg: str, src: Path) -> float:
    """Length of the media in seconds, or 0 if unknown."""
    try:
        out = subprocess.run(
            [ffmpeg, "-hide_banner", "-i", str(src)],
            capture_output=True, text=True, errors="replace", timeout=30, **popen_kwargs(),
        ).stderr
    except (OSError, subprocess.SubprocessError):
        return 0.0
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", out)
    if not m:
        return 0.0
    return int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3])


def convert(src: Path, dst: Path, target: str, opts: Options,
            progress: Progress, cancel: threading.Event) -> list[Path]:
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise ConversionError("ffmpeg was not found. Install ffmpeg or the imageio-ffmpeg package.")

    args = _audio_args(target, opts) if target in AUDIO_OUT else _video_args(target, opts)
    total = _duration(ffmpeg, src)
    cmd = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
           "-i", str(src), *args, "-progress", "pipe:1", "-nostats", str(dst)]

    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, errors="replace", **popen_kwargs(),
    )
    messages: list[str] = []
    try:
        for line in proc.stdout:
            if cancel.is_set():
                raise Cancelled()
            line = line.strip()
            m = re.fullmatch(r"out_time_(?:us|ms)=(\d+)", line)
            if m:
                if total > 0:
                    progress(min(int(m[1]) / 1_000_000 / total, 0.99))
            elif line and not re.fullmatch(r"[a-z_0-9]+=.*", line):
                messages.append(line)
        code = proc.wait()
    except BaseException:
        proc.kill()
        proc.wait()
        dst.unlink(missing_ok=True)
        raise
    if code != 0:
        dst.unlink(missing_ok=True)
        detail = "\n".join(messages[-5:]) or f"ffmpeg exited with code {code}"
        raise ConversionError(detail)
    return [dst]
