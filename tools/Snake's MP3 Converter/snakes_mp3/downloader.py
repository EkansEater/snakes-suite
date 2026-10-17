"""Background worker that turns a video URL into MP3 (or other audio) file(s) using yt-dlp + ffmpeg."""

from __future__ import annotations

import glob
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import dataclass

import yt_dlp
from yt_dlp.postprocessor.common import PostProcessor
from PySide6.QtCore import QThread, Signal

QUALITIES = {
    "320 kbps (best)": "320K",
    "256 kbps": "256K",
    "192 kbps": "192K",
    "128 kbps (small)": "128K",
    "VBR V0 (~245 kbps)": "0",
}

# Name shown -> yt-dlp's --audio-format
FORMATS = {
    "MP3": "mp3",
    "M4A (AAC)": "m4a",
    "Opus": "opus",
    "FLAC (lossless)": "flac",
    "WAV (lossless)": "wav",
}
LOSSLESS = {"flac", "wav"}  # no bitrate to choose
COVER_ART = {"mp3", "m4a", "opus", "flac"}  # formats that can carry the thumbnail

NAME_TEMPLATES = {
    "Title": "%(title)s",
    "Artist - Title": "%(artist,creator,uploader|Unknown)s - %(title)s",
    "Title [video ID]": "%(title)s [%(id)s]",
    "Upload date - Title": "%(upload_date>%Y-%m-%d|)s - %(title)s",
}

PP_STAGES = {
    "FFmpegExtractAudio": "Converting to {format}…",
    "FFmpegThumbnailsConvertor": "Preparing cover art…",
    "EmbedThumbnail": "Embedding cover art…",
    "FFmpegMetadata": "Writing tags…",
}


_NO_WINDOW = {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}


def _file_name(text: str) -> str:
    """A chapter title made safe as a file name on every system."""
    text = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", text).strip(" .")
    return text[:120] or "Track"


def _remove(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


def find_ffmpeg() -> str | None:
    """ffmpeg on the PATH, else the copy that comes with imageio-ffmpeg (Windows, macOS)."""
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001 - not installed, or no binary for this system
        return None


@dataclass
class JobOptions:
    output_dir: str
    quality: str = "320K"
    name_template: str = "%(title)s"
    whole_playlist: bool = False
    playlist_subfolder: bool = True
    embed_thumbnail: bool = True
    embed_metadata: bool = True
    skip_existing: bool = True
    cookies_browser: str = ""
    audio_format: str = "mp3"
    split_chapters: bool = False  # one file per chapter, in a folder named after the video


class Cancelled(Exception):
    pass


class _QuietLogger:
    def __init__(self):
        self.errors: list[str] = []

    def debug(self, msg):
        pass

    def info(self, msg):
        pass

    def warning(self, msg):
        pass

    def error(self, msg):
        self.errors.append(_clean_error(msg))


class _MetaPP(PostProcessor):
    """Runs before each video is downloaded; reports its metadata to the UI."""

    def __init__(self, job: "DownloadJob"):
        super().__init__()
        self._job = job

    def run(self, info):
        try:
            self._job._stems.add(os.path.splitext(self._downloader.prepare_filename(info))[0])
        except Exception:  # noqa: BLE001 - only used for cleanup on cancel
            pass
        self._job._report_meta(info)
        return [], info


def _clean_error(msg: str) -> str:
    msg = str(msg).strip()
    for prefix in ("ERROR: ", "\x1b[0;31mERROR:\x1b[0m "):
        if msg.startswith(prefix):
            msg = msg[len(prefix):]
    return msg


def _pick_thumbnail(info: dict) -> str | None:
    # Prefer a mid-size JPEG: Qt can always decode it and it's quick to fetch.
    thumbs = [t for t in info.get("thumbnails") or [] if t.get("url")]
    jpgs = [t for t in thumbs if ".jpg" in t["url"].split("?")[0]]
    for pool in (jpgs, thumbs):
        if pool:
            sized = [t for t in pool if 200 <= (t.get("width") or 0) <= 720]
            best = max(sized or pool, key=lambda t: (t.get("preference") or 0, t.get("width") or 0))
            return best["url"]
    return info.get("thumbnail")


def human_bytes(n: float | None) -> str:
    if not n:
        return "?"
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def human_time(secs: float | None) -> str:
    if secs is None:
        return ""
    secs = int(secs)
    h, rem = divmod(secs, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


class DownloadJob(QThread):
    meta = Signal(dict)           # title, uploader, duration, thumbnail, index, count
    progress = Signal(float, str)  # percent (-1 = unknown), detail text
    stage = Signal(str)           # human-readable stage text
    succeeded = Signal(list)      # list of mp3 paths
    failed = Signal(str)
    cancelled = Signal()

    def __init__(self, url: str, options: JobOptions, parent=None):
        super().__init__(parent)
        self.url = url
        self.options = options
        self._cancel = threading.Event()
        self._paths: dict[str, str] = {}
        self._stems: set[str] = set()
        self._started = time.time()
        self._index = 1
        self._count = 1
        self._infos: dict[str, dict] = {}  # output file -> its video's info (for chapters)
        self._made: list[str] = []  # chapter tracks written so far

    def cancel(self):
        self._cancel.set()

    # ---------------------------------------------------------------- yt-dlp
    def _build_opts(self, logger: _QuietLogger) -> dict:
        o = self.options
        template = o.name_template
        if o.whole_playlist and o.playlist_subfolder:
            template = "%(playlist_title|.)s/%(playlist_index&{:03d} - |)s" + template
        argv = [
            "--extract-audio", "--audio-format", o.audio_format,
            *([] if o.audio_format in LOSSLESS else ["--audio-quality", o.quality]),
            "--paths", o.output_dir,
            "--output", template + ".%(ext)s",
            "--yes-playlist" if o.whole_playlist else "--no-playlist",
            "--no-mtime",
            "--windows-filenames",
            "--trim-filenames", "180",
        ]
        if o.embed_metadata:
            argv += ["--embed-metadata"]
        if o.embed_thumbnail and o.audio_format in COVER_ART:
            argv += ["--embed-thumbnail", "--convert-thumbnails", "jpg"]
        if o.skip_existing:
            argv += ["--no-overwrites", "--no-post-overwrites"]
        else:
            argv += ["--force-overwrites"]
        if o.cookies_browser:
            argv += ["--cookies-from-browser", o.cookies_browser]

        opts = yt_dlp.parse_options(argv).ydl_opts
        ffmpeg = find_ffmpeg()
        if ffmpeg:
            opts["ffmpeg_location"] = ffmpeg
        opts.update(
            quiet=True,
            no_warnings=True,
            noprogress=True,
            logger=logger,
            progress_hooks=[self._progress_hook],
            postprocessor_hooks=[self._pp_hook],
        )
        return opts

    def _report_meta(self, info: dict):
        if self._cancel.is_set():
            raise Cancelled()
        self._index = info.get("playlist_index") or 1
        self._count = info.get("n_entries") or info.get("playlist_count") or 1
        self.meta.emit({
            "title": info.get("title") or info.get("id") or self.url,
            "uploader": info.get("artist") or info.get("uploader") or info.get("channel") or "",
            "duration": info.get("duration"),
            "thumbnail": _pick_thumbnail(info),
            "index": self._index,
            "count": self._count,
            "playlist": info.get("playlist_title") if self._count > 1 else None,
        })
        self.stage.emit("Downloading…")

    def _progress_hook(self, d: dict):
        if self._cancel.is_set():
            raise Cancelled()
        status = d.get("status")
        if status == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            done = d.get("downloaded_bytes") or 0
            pct = min(done / total * 100, 100) if total else -1
            parts = [f"{human_bytes(done)} / {human_bytes(total)}" if total else human_bytes(done)]
            if d.get("speed"):
                parts.append(f"{human_bytes(d['speed'])}/s")
            if d.get("eta") is not None:
                parts.append(f"{human_time(d['eta'])} left")
            self.progress.emit(self._overall(pct), "  ·  ".join(parts))
        elif status == "finished":
            self.progress.emit(self._overall(100), "")

    def _pp_hook(self, d: dict):
        info = d.get("info_dict") or {}
        if d.get("status") == "started":
            text = PP_STAGES.get(d.get("postprocessor"))
            if text:
                self.stage.emit(text.format(format=self.options.audio_format.upper()))
        elif d.get("status") == "finished" and info.get("filepath"):
            self._paths[info.get("id") or info["filepath"]] = info["filepath"]
            self._infos[info["filepath"]] = info

    def _overall(self, pct: float) -> float:
        if pct < 0 or self._count <= 1:
            return pct
        return ((self._index - 1) + pct / 100) / self._count * 100

    # ---------------------------------------------------------------- chapters
    def _split_all(self, paths: list[str]) -> list[str]:
        out = []
        for path in paths:
            info = self._infos.get(path) or {}
            chapters = [c for c in info.get("chapters") or [] if c.get("end_time", 0) > c.get("start_time", 0)]
            out += self._split(path, info, chapters) if len(chapters) >= 2 else [path]
        return out

    def _split(self, path: str, info: dict, chapters: list[dict]) -> list[str]:
        """One file per chapter, tagged as an album, in a folder named after the video; the long file goes."""
        ffmpeg = find_ffmpeg()
        if not ffmpeg:
            return [path]
        stem, ext = os.path.splitext(path)
        os.makedirs(stem, exist_ok=True)
        album = info.get("title") or os.path.basename(stem)
        artist = info.get("artist") or info.get("creator") or info.get("uploader") or info.get("channel") or ""
        n = len(chapters)
        tracks = []
        for i, ch in enumerate(chapters, 1):
            if self._cancel.is_set():
                raise Cancelled()
            self.stage.emit(f"Splitting into chapters: track {i} of {n}…")
            self.progress.emit((i - 1) / n * 100, "")
            title = (ch.get("title") or "").strip() or f"Part {i}"
            dest = os.path.join(stem, f"{i:02d} - {_file_name(title)}{ext}")
            start, end = float(ch["start_time"]), float(ch["end_time"])
            cmd = [ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-ss", f"{start:.3f}", "-i", path,
                   "-t", f"{end - start:.3f}", "-map", "0", "-c", "copy", "-map_metadata", "0", "-map_metadata:s:a", "0:s:a"]
            if ext.lower() == ".flac":
                cmd += ["-c:a", "flac"]  # copied FLAC keeps the whole file's length in its header; encoding again is lossless
            tags = {"title": title, "album": album, "track": f"{i}/{n}"}
            if artist:
                tags.update(artist=artist, album_artist=artist)
            for key, value in tags.items():
                # File-wide tags for most formats; Ogg (Opus) keeps them on the audio stream.
                cmd += ["-metadata", f"{key}={value}", "-metadata:s:a:0", f"{key}={value}"]
            if ext.lower() == ".m4a":
                cmd += ["-movflags", "+faststart"]
            self._made.append(dest)
            result = subprocess.run(cmd + [dest], stdin=subprocess.DEVNULL, capture_output=True, **_NO_WINDOW)
            if result.returncode != 0 or not os.path.exists(dest):
                for t in tracks + [dest]:
                    _remove(t)
                err = result.stderr.decode("utf-8", "replace").strip().splitlines()
                raise RuntimeError("Splitting into chapters failed" + (f": {err[-1]}" if err else "."))
            tracks.append(dest)
        _remove(path)
        return tracks

    def _cleanup_partials(self):
        """Delete leftovers (partial media, thumbnails, half-written files) this job created."""
        for t in self._made:
            _remove(t)
        for stem in self._stems:
            for f in glob.glob(glob.escape(stem) + ".*"):
                try:
                    if os.path.getmtime(f) >= self._started - 1:
                        os.remove(f)
                except OSError:
                    pass

    # ---------------------------------------------------------------- thread
    def run(self):
        logger = _QuietLogger()
        try:
            os.makedirs(self.options.output_dir, exist_ok=True)
            self.stage.emit("Fetching info…")
            with yt_dlp.YoutubeDL(self._build_opts(logger)) as ydl:
                ydl.add_post_processor(_MetaPP(self), when="pre_process")
                info = ydl.extract_info(self.url, download=True)
            if self._cancel.is_set():
                raise Cancelled()
            paths = [p for p in self._paths.values() if os.path.exists(p)]
            if not paths and info:
                for entry in (info.get("entries") or [info]):
                    for rd in (entry or {}).get("requested_downloads") or []:
                        p = rd.get("filepath")
                        if p and os.path.exists(p):
                            paths.append(p)
            if not paths:
                raise RuntimeError(logger.errors[-1] if logger.errors else "No audio was produced for this link.")
            paths = sorted(set(paths))
            if self.options.split_chapters:
                paths = self._split_all(paths)
            self.succeeded.emit(paths)
        except Exception as exc:  # noqa: BLE001 - every failure goes to the UI
            if self._cancel.is_set() or isinstance(exc, Cancelled):
                self._cleanup_partials()
                self.cancelled.emit()
            else:
                msg = logger.errors[-1] if logger.errors else _clean_error(exc)
                self.failed.emit(msg or exc.__class__.__name__)
