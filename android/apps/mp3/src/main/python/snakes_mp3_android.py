"""yt-dlp worker for Snake's MP3 Converter on Android.

The same job as snakes_mp3/downloader.py on the desktop, without Qt: Kotlin
creates a Job, calls run() on a background thread and gets progress through a
listener object with three methods:

    meta(json: str)                 title, uploader, duration, thumbnail, index, count, playlist
    progress(percent: float, detail: str)   percent is -1 when unknown
    stage(text: str)

run() returns the finished MP3 paths. They are written under the app's cache;
Kotlin moves them into the shared Music folder.
"""

from __future__ import annotations

import glob
import json
import os
import threading
import time

import yt_dlp
from yt_dlp.postprocessor.common import PostProcessor

PP_STAGES = {
    "FFmpegExtractAudio": "Converting to MP3…",
    "FFmpegThumbnailsConvertor": "Preparing cover art…",
    "EmbedThumbnail": "Embedding cover art…",
    "FFmpegMetadata": "Writing tags…",
}


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


def _clean_error(msg) -> str:
    msg = str(msg).strip()
    for prefix in ("ERROR: ", "\x1b[0;31mERROR:\x1b[0m "):
        if msg.startswith(prefix):
            msg = msg[len(prefix):]
    return msg


def _pick_thumbnail(info: dict) -> str | None:
    thumbs = [t for t in info.get("thumbnails") or [] if t.get("url")]
    jpgs = [t for t in thumbs if ".jpg" in t["url"].split("?")[0]]
    for pool in (jpgs, thumbs):
        if pool:
            sized = [t for t in pool if 200 <= (t.get("width") or 0) <= 720]
            best = max(sized or pool, key=lambda t: (t.get("preference") or 0, t.get("width") or 0))
            return best["url"]
    return info.get("thumbnail")


def _human_bytes(n) -> str:
    if not n:
        return "?"
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def _human_time(secs) -> str:
    if secs is None:
        return ""
    secs = int(secs)
    h, rem = divmod(secs, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


class _MetaPP(PostProcessor):
    """Runs before each video downloads and reports its metadata."""

    def __init__(self, job: "Job"):
        super().__init__()
        self._job = job

    def run(self, info):
        try:
            self._job._stems.add(os.path.splitext(self._downloader.prepare_filename(info))[0])
        except Exception:  # noqa: BLE001 - only used for cleanup on cancel
            pass
        self._job._report_meta(info)
        return [], info


class Job:
    def __init__(self, url: str, options: str, listener):
        self.url = url
        self.o = json.loads(options)
        self.listener = listener
        self._cancel = threading.Event()
        self._paths: dict[str, str] = {}
        self._stems: set[str] = set()
        self._started = time.time()
        self._index = 1
        self._count = 1

    def cancel(self):
        self._cancel.set()

    def _build_opts(self, logger: _QuietLogger) -> dict:
        o = self.o
        template = o.get("name_template") or "%(title)s"
        if o.get("whole_playlist") and o.get("playlist_subfolder", True):
            template = "%(playlist_title|.)s/%(playlist_index&{:03d} - |)s" + template
        argv = [
            "--extract-audio", "--audio-format", "mp3", "--audio-quality", o.get("quality", "320K"),
            "--paths", o["output_dir"],
            "--output", template + ".%(ext)s",
            "--yes-playlist" if o.get("whole_playlist") else "--no-playlist",
            "--no-mtime",
            "--windows-filenames",
            "--trim-filenames", "180",
            "--no-cache-dir",
        ]
        if o.get("embed_metadata", True):
            argv += ["--embed-metadata"]
        if o.get("embed_thumbnail", True):
            argv += ["--embed-thumbnail", "--convert-thumbnails", "jpg"]
        if o.get("skip_existing", True) and o.get("archive"):
            argv += ["--download-archive", o["archive"]]
        argv += ["--force-overwrites"]
        if o.get("cookies"):
            argv += ["--cookies", o["cookies"]]

        opts = yt_dlp.parse_options(argv).ydl_opts
        opts["ffmpeg_location"] = o["ffmpeg"]
        if o.get("quickjs"):
            opts["js_runtimes"] = {"quickjs": {"path": o["quickjs"]}}
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
        self.listener.meta(json.dumps({
            "title": info.get("title") or info.get("id") or self.url,
            "uploader": info.get("artist") or info.get("uploader") or info.get("channel") or "",
            "duration": info.get("duration"),
            "thumbnail": _pick_thumbnail(info),
            "index": self._index,
            "count": self._count,
            "playlist": info.get("playlist_title") if self._count > 1 else None,
        }))
        self.listener.stage("Downloading…")

    def _progress_hook(self, d: dict):
        if self._cancel.is_set():
            raise Cancelled()
        status = d.get("status")
        if status == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            done = d.get("downloaded_bytes") or 0
            pct = min(done / total * 100, 100) if total else -1
            parts = [f"{_human_bytes(done)} / {_human_bytes(total)}" if total else _human_bytes(done)]
            if d.get("speed"):
                parts.append(f"{_human_bytes(d['speed'])}/s")
            if d.get("eta") is not None:
                parts.append(f"{_human_time(d['eta'])} left")
            self.listener.progress(float(self._overall(pct)), "  ·  ".join(parts))
        elif status == "finished":
            self.listener.progress(float(self._overall(100)), "")

    def _pp_hook(self, d: dict):
        if self._cancel.is_set():
            raise Cancelled()
        info = d.get("info_dict") or {}
        if d.get("status") == "started":
            text = PP_STAGES.get(d.get("postprocessor"))
            if text:
                self.listener.stage(text)
        elif d.get("status") == "finished" and info.get("filepath"):
            self._paths[info.get("id") or info["filepath"]] = info["filepath"]

    def _overall(self, pct: float) -> float:
        if pct < 0 or self._count <= 1:
            return pct
        return ((self._index - 1) + pct / 100) / self._count * 100

    def _cleanup_partials(self):
        for stem in self._stems:
            for f in glob.glob(glob.escape(stem) + ".*"):
                try:
                    if os.path.getmtime(f) >= self._started - 1:
                        os.remove(f)
                except OSError:
                    pass

    def run(self) -> list[str]:
        """Download and convert. Returns MP3 paths; raises Cancelled or RuntimeError(message)."""
        logger = _QuietLogger()
        try:
            os.makedirs(self.o["output_dir"], exist_ok=True)
            self.listener.stage("Fetching info…")
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
                if self.o.get("skip_existing", True) and not logger.errors:
                    return []   # everything was in the download archive already
                raise RuntimeError(logger.errors[-1] if logger.errors else "No audio was produced for this link.")
            return sorted(set(paths))
        except Exception as exc:  # noqa: BLE001 - every failure goes to the UI
            if self._cancel.is_set() or isinstance(exc, Cancelled):
                self._cleanup_partials()
                raise Cancelled() from None
            msg = logger.errors[-1] if logger.errors else _clean_error(exc)
            raise RuntimeError(msg or exc.__class__.__name__) from None


def version() -> str:
    return yt_dlp.version.__version__
