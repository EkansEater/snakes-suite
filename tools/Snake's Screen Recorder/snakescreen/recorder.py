"""Recording engine.

A recording is captured as one or more segments (a new one after every pause)
and ffmpeg then joins them into the final MP4, GIF or MP3.

How a video segment is captured depends on the OS (see platforms.KIND):
  portal   Wayland: xdg-desktop-portal stream -> gst-launch -> Matroska
  x11      ffmpeg x11grab
  windows  ffmpeg gdigrab
  macos    ffmpeg avfoundation
Audio-only segments are always captured by ffmpeg straight to MP3.
"""

import os
import shutil
import signal
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

from PyQt6.QtCore import QObject, QSettings, QStandardPaths, QTimer, pyqtSignal

from . import audio
from .platforms import KIND, POPEN_FLAGS, ffmpeg

# x264 constant-quality level (lower = better) and MP3 bitrate per preset
QUALITY = {
    "high": {"crf": 18, "mp3": "320k"},
    "medium": {"crf": 23, "mp3": "192k"},
    "low": {"crf": 28, "mp3": "128k"},
}
GIF_CAPTURE_CRF = 12  # GIFs are re-encoded afterwards, so capture them near-lossless


@dataclass
class Job:
    mode: str = "mp4"            # mp4 | gif | mp3
    source: str = "screen"       # screen | region | window
    region: tuple | None = None  # (x, y, w, h) in logical pixels, relative to the screen
    screen_geo: tuple = (0, 0, 0, 0)  # geometry of the target screen as Qt reports it
    screen_name: str = ""
    screen_index: int = 0
    dpr: float = 1.0             # device pixel ratio of the target screen
    multi_screen: bool = False
    fps: int = 30
    quality: str = "high"
    cursor: bool = True
    audio: list = field(default_factory=list)  # device ids, see audio.py
    gif_width: int = 0           # 0 = keep original size
    out_dir: str = ""


class Recorder(QObject):
    stateChanged = pyqtSignal(str)  # idle | preparing | armed | recording | paused | processing
    prepared = pyqtSignal()         # sources are granted; call begin() to start capturing
    finished = pyqtSignal(str, str)  # output path, warning (may be empty)
    failed = pyqtSignal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.state = "idle"
        self.settings = QSettings()
        self.job = None
        self.cast = None
        self._procs = []       # every capture process started for this recording
        self._current = None   # the one capturing right now
        self._final = None     # ffmpeg process writing the final file
        self._segments = []
        self._tmp = None
        self._crop = (0, 0, 0, 0)
        self._node = None
        self._warning = ""
        self._elapsed = 0.0
        self._since = None
        self._stop_deadline = 0
        self._timer = QTimer(self, interval=150, timeout=self._poll)

    # -- public -----------------------------------------------------------
    def elapsed(self):
        return self._elapsed + (time.monotonic() - self._since if self._since else 0)

    def is_busy(self):
        return self.state != "idle"

    def prepare(self, job):
        if self.state != "idle":
            return
        self.job = job
        self._procs, self._segments = [], []
        self._current = self._final = None
        self._warning = ""
        self._elapsed, self._since = 0.0, None
        cache = Path(QStandardPaths.writableLocation(
            QStandardPaths.StandardLocation.GenericCacheLocation)) / "snakescreen"
        cache.mkdir(parents=True, exist_ok=True)
        self._tmp = Path(tempfile.mkdtemp(prefix="rec-", dir=cache))

        if job.mode == "mp3" and not job.audio:
            self._abort("Pick at least one audio source to record.")
        elif job.mode != "mp3" and KIND == "portal":
            self._open_portal()
        else:
            self._set_state("armed")
            self.prepared.emit()

    def begin(self):
        if self.state == "armed":
            self._start_segment()

    def toggle_pause(self):
        if self.state == "recording":
            self._interrupt_current()
            self._set_state("paused")
        elif self.state == "paused":
            self._start_segment()

    def stop(self):
        if self.state in ("preparing", "armed"):
            self._cleanup()
            self._set_state("idle")
        elif self.state in ("recording", "paused"):
            self._interrupt_current()
            self._stop_deadline = time.monotonic() + 15
            self._set_state("processing")
            self._timer.start()

    def forget_screen_choice(self):
        self.settings.remove("portal")

    # -- Wayland portal ---------------------------------------------------
    def _token_key(self):
        return "portal/window" if self.job.source == "window" else "portal/monitor"

    def _open_portal(self):
        from .portal import SOURCE_MONITOR, SOURCE_WINDOW, ScreenCast

        self._set_state("preparing")
        try:
            self.cast = ScreenCast(self)
        except Exception as e:
            self._abort(f"Could not reach the screen capture portal: {e}")
            return
        self.cast.ready.connect(self._on_cast_ready)
        self.cast.failed.connect(self._on_cast_failed)
        self.cast.closed.connect(self.stop)
        self.cast.open(
            SOURCE_WINDOW if self.job.source == "window" else SOURCE_MONITOR,
            self.job.cursor,
            self.settings.value(self._token_key(), "", str),
        )

    def _on_cast_ready(self, info):
        job = self.job
        self._node = info["node"]
        size, pos = info["size"], info["position"]

        if job.source == "region":
            gx, gy, gw, gh = job.screen_geo
            if job.multi_screen and pos is not None and tuple(pos) != (gx, gy):
                self.settings.remove(self._token_key())
                self._abort(
                    f"Your region is on {job.screen_name}, but a different screen was "
                    f"shared. Press Record again and choose {job.screen_name}."
                )
                return
            if not size:
                self._abort("The desktop did not report the screen size, so the region cannot be cropped.")
                return
            sw, sh = size
            x, y, w, h = _fit_region(job.region, sw / gw if gw else 1.0, sw, sh)
            if w < 2 or h < 2:
                self._abort("The selected region is too small.")
                return
            self._crop = (x, y, sw - x - w, sh - y - h)
        elif size:
            self._crop = (0, 0, size[0] % 2, size[1] % 2)
        else:
            self._crop = (0, 0, 0, 0)

        if info["restore_token"]:
            self.settings.setValue(self._token_key(), info["restore_token"])
        self._set_state("armed")
        self.prepared.emit()

    def _on_cast_failed(self, message):
        self.cast = None
        self._abort("" if message == "cancelled" else message)

    # -- capture ----------------------------------------------------------
    def _start_segment(self):
        job = self.job
        index = len(self._segments)
        fd = None
        try:
            with open(self._tmp / f"capture{index}.log", "wb") as log:
                if job.mode == "mp3":
                    path = self._tmp / f"seg{index}.mp3"
                    proc = _spawn(self._mp3_capture_cmd(path), log, "ffmpeg")
                elif KIND == "portal":
                    path = self._tmp / f"seg{index}.mkv"
                    fd = self.cast.open_remote()
                    proc = _spawn(self._portal_capture_cmd(path, fd), log, "gst", pass_fds=[fd])
                else:
                    path = self._tmp / f"seg{index}.mkv"
                    proc = _spawn(self._ffmpeg_capture_cmd(path), log, "ffmpeg")
        except Exception as e:  # missing binary, portal gone, ...
            self._warning = f"Could not start capturing: {e}"
            if self._segments:
                self.stop()
            else:
                self._abort(self._warning)
            return
        finally:
            if fd is not None:
                os.close(fd)
        self._segments.append(path)
        self._procs.append(proc)
        self._current = proc
        self._since = time.monotonic()
        self._set_state("recording")
        self._timer.start()

    def _crf(self):
        return GIF_CAPTURE_CRF if self.job.mode == "gif" else QUALITY[self.job.quality]["crf"]

    def _video_audio(self):
        return self.job.audio if self.job.mode == "mp4" else []

    def _portal_capture_cmd(self, path, fd):
        job = self.job
        left, top, right, bottom = self._crop
        cmd = [
            "gst-launch-1.0", "-e",
            "pipewiresrc", f"fd={fd}", f"path={self._node}", "do-timestamp=true",
            "always-copy=true", f"keepalive-time={max(1000 // job.fps, 10)}",
            "!", "queue", "max-size-buffers=8", "leaky=downstream",
            "!", "videoconvert",
            "!", "videocrop", f"left={left}", f"top={top}", f"right={right}", f"bottom={bottom}",
            "!", "videorate", "skip-to-first=true",
            "!", f"video/x-raw,framerate={job.fps}/1",
            "!", "videoconvert",
            "!", "video/x-raw,format=I420",
            "!", "x264enc", "speed-preset=veryfast", "pass=qual", f"quantizer={self._crf()}",
            f"key-int-max={job.fps * 2}",
            "!", "h264parse", "!", "queue", "!", "mux.",
        ]
        for device in self._video_audio():
            cmd += [
                "pulsesrc", f"device={device}", "client-name=SnakeScreen",
                "!", "queue", "!", "audioconvert", "!", "audioresample",
                "!", "audio/x-raw,rate=48000,channels=2",
                "!", "flacenc", "!", "queue", "!", "mux.",
            ]
        cmd += ["matroskamux", "name=mux", "!", "filesink", f"location={path}"]
        return cmd

    def _ffmpeg_capture_cmd(self, path):
        """Screen grab with ffmpeg's native device for X11, Windows or macOS."""
        job = self.job
        gx, gy, gw, gh = job.screen_geo
        sw, sh = round(gw * job.dpr), round(gh * job.dpr)  # screen size in real pixels
        if job.source == "region":
            x, y, w, h = _fit_region(job.region, job.dpr, sw, sh)
        else:
            x, y, w, h = 0, 0, sw & ~1, sh & ~1
        if w < 2 or h < 2:
            raise ValueError("the selected region is too small")
        fps, cursor = str(job.fps), "1" if job.cursor else "0"

        cmd = [ffmpeg(), "-hide_banner", "-y", "-thread_queue_size", "1024"]
        filters = []
        if KIND == "windows":
            cmd += ["-f", "gdigrab", "-framerate", fps, "-draw_mouse", cursor,
                    "-offset_x", str(gx + x), "-offset_y", str(gy + y),
                    "-video_size", f"{w}x{h}", "-i", "desktop"]
        elif KIND == "macos":
            screens = audio.screen_devices()
            if not screens:
                raise RuntimeError("no screen capture device found; allow Screen Recording "
                                   "for this app in System Settings > Privacy & Security")
            device = screens[min(job.screen_index, len(screens) - 1)]
            cmd += ["-f", "avfoundation", "-framerate", fps, "-capture_cursor", cursor,
                    "-i", f"{device}:none"]
            filters.append(f"crop={w}:{h}:{x}:{y}")
        else:
            display = os.environ.get("DISPLAY", ":0")
            cmd += ["-f", "x11grab", "-framerate", fps, "-draw_mouse", cursor,
                    "-video_size", f"{w}x{h}", "-i", f"{display}+{gx + x},{gy + y}"]

        devices = self._video_audio()
        for device in devices:
            cmd += ["-thread_queue_size", "1024", *audio.ffmpeg_input(device)]
        cmd += ["-map", "0:v:0"]
        for i in range(len(devices)):
            cmd += ["-map", f"{i + 1}:a:0"]
        if filters:
            cmd += ["-vf", ",".join(filters)]
        cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", str(self._crf()),
                "-pix_fmt", "yuv420p", "-r", fps, "-g", str(job.fps * 2)]
        if devices:
            cmd += ["-c:a", "flac", "-ar", "48000", "-ac", "2"]
        cmd.append(str(path))
        return cmd

    def _mp3_capture_cmd(self, path):
        job = self.job
        cmd = [ffmpeg(), "-hide_banner", "-y"]
        for device in job.audio:
            cmd += audio.ffmpeg_input(device)
        if len(job.audio) > 1:
            cmd += ["-filter_complex", _amix(len(job.audio), "{}:a"), "-map", "[a]"]
        cmd += ["-ac", "2", "-ar", "48000", "-c:a", "libmp3lame",
                "-b:a", QUALITY[job.quality]["mp3"], str(path)]
        return cmd

    def _interrupt_current(self):
        if self._since:
            self._elapsed += time.monotonic() - self._since
            self._since = None
        proc, self._current = self._current, None
        if not proc or proc.poll() is not None:
            return
        # Ask the tool to finish its file properly rather than killing it.
        if proc.kind == "ffmpeg":
            try:
                proc.stdin.write(b"q")
                proc.stdin.close()
            except OSError:
                pass
        else:
            proc.send_signal(signal.SIGINT)

    # -- supervision ------------------------------------------------------
    def _poll(self):
        if self.state == "recording":
            if self._current and self._current.poll() is not None:
                self._warning = "Capturing stopped unexpectedly. " + self._log_tail()
                self.stop()
        elif self.state == "processing":
            if self._final is None:
                running = [p for p in self._procs if p.poll() is None]
                if running and time.monotonic() > self._stop_deadline:
                    for p in running:
                        p.kill()
                elif not running:
                    self._finalize()
            elif self._final.poll() is not None:
                self._on_final_done()
        elif self.state != "paused":
            self._timer.stop()

    def _finalize(self):
        job = self.job
        if self.cast:
            self.cast.close()
            self.cast = None
        segments = [s for s in self._segments if s.exists() and s.stat().st_size > 0]
        if not segments:
            self._abort("Nothing was recorded. " + (self._warning or self._log_tail()))
            return

        out_dir = Path(job.out_dir).expanduser()
        try:
            out_dir.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            self._abort(f"Cannot write to {out_dir}: {e}. The raw capture is kept in {self._tmp}.", keep=True)
            return
        stamp = time.strftime("%Y-%m-%d_%H-%M-%S")
        self._out = out_dir / f"SnakeScreen_{stamp}.{job.mode}"

        listing = self._tmp / "segments.txt"
        listing.write_text(
            "".join("file '{}'\n".format(s.as_posix().replace("'", "'\\''")) for s in segments),
            encoding="utf-8",
        )
        cmd = [ffmpeg(), "-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", str(listing)]
        if job.mode == "mp3":
            cmd += ["-c", "copy"]
        elif job.mode == "gif":
            scale = f"scale='min({job.gif_width},iw)':-2:flags=lanczos," if job.gif_width else ""
            cmd += ["-an", "-vf",
                    f"fps={job.fps},{scale}split[a][b];[a]palettegen=stats_mode=diff[p];"
                    "[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle",
                    "-loop", "0"]
        else:
            n = len(job.audio)
            if n > 1:
                cmd += ["-filter_complex", _amix(n, "0:a:{}"), "-map", "0:v:0", "-map", "[a]"]
            elif n == 1:
                cmd += ["-map", "0:v:0", "-map", "0:a:0"]
            else:
                cmd += ["-map", "0:v:0"]
            cmd += ["-c:v", "copy"]
            if n:
                cmd += ["-c:a", "aac", "-b:a", "192k"]
            cmd += ["-avoid_negative_ts", "make_zero", "-movflags", "+faststart"]
        cmd.append(str(self._out))

        try:
            with open(self._tmp / "final.log", "wb") as log:
                self._final = _spawn(cmd, log, "ffmpeg")
        except OSError as e:
            self._abort(f"Could not run ffmpeg: {e}. The raw capture is kept in {self._tmp}.", keep=True)

    def _on_final_done(self):
        ok = self._final.returncode == 0 and self._out.exists() and self._out.stat().st_size > 0
        if not ok:
            tail = self._log_tail("final.log")
            self._abort(f"Saving the recording failed. The raw capture is kept in {self._tmp}. {tail}", keep=True)
            return
        out, warning = str(self._out), self._warning
        self._cleanup()
        self._set_state("idle")
        self.finished.emit(out, warning)

    # -- helpers ----------------------------------------------------------
    def _log_tail(self, name=None):
        try:
            path = self._tmp / (name or f"capture{len(self._segments) - 1}.log")
            lines = [l for l in path.read_text(errors="replace").splitlines() if l.strip()]
            return " ".join(lines[-3:])[-400:]
        except OSError:
            return ""

    def _abort(self, message, keep=False):
        self._cleanup(keep)
        self._set_state("idle")
        self.failed.emit(message)

    def _cleanup(self, keep=False):
        self._timer.stop()
        for p in self._procs + ([self._final] if self._final else []):
            if p.poll() is None:
                p.kill()
        self._procs, self._current, self._final = [], None, None
        self._since = None
        if self.cast:
            self.cast.close()
            self.cast = None
        if self._tmp and not keep:
            shutil.rmtree(self._tmp, ignore_errors=True)
        self._tmp = None

    def _set_state(self, state):
        if state != self.state:
            self.state = state
            self.stateChanged.emit(state)


def _spawn(cmd, log, kind, **kwargs):
    # ffmpeg is stopped by typing "q" at it, which works on every OS
    stdin = subprocess.PIPE if kind == "ffmpeg" else subprocess.DEVNULL
    proc = subprocess.Popen(cmd, stdin=stdin, stdout=log, stderr=log, **POPEN_FLAGS, **kwargs)
    proc.kind = kind
    return proc


def _fit_region(region, scale, max_w, max_h):
    """Logical region -> real-pixel (x, y, w, h), inside the screen, even-sized."""
    x, y, w, h = (round(v * scale) for v in region)
    x, y = max(0, min(x, max_w - 2)), max(0, min(y, max_h - 2))
    return x, y, min(w, max_w - x) & ~1, min(h, max_h - y) & ~1


def _amix(count, label):
    """ffmpeg filter graph mixing `count` audio inputs into [a]."""
    inputs = "".join(f"[{label.format(i)}]" for i in range(count))
    return f"{inputs}amix=inputs={count}:duration=longest:normalize=0[a]"
