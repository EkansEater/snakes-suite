"""Clip: keep only part of a converted track (an intro, one song of a mix, a ringtone).

The window shows the track's waveform. Drag the green handles (or play to a spot and press
I and O) to mark the part to keep, play it, then save it as a new file next to the original
or in its place. Tags and cover art are kept; MP3, M4A, Opus and WAV are cut without
encoding again, FLAC is encoded again (losslessly) so its header gets the new length.
"""

from __future__ import annotations

import os
import re
import sys
from array import array
from pathlib import Path

from PySide6.QtCore import QProcess, QRectF, QSettings, Qt, QUrl, Signal
from PySide6.QtGui import QColor, QKeySequence, QPainter, QPen, QPixmap, QShortcut
from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer
from PySide6.QtWidgets import (
    QCheckBox, QDialog, QHBoxLayout, QLabel, QLineEdit, QPushButton, QSizePolicy, QVBoxLayout, QWidget,
)

from . import snake_theme
from .downloader import find_ffmpeg, human_bytes

WAVE_RATE = 4000  # samples per second read for the waveform: plenty for a picture, quick for an hour
MIN_CLIP_MS = 100


def clock(ms: float, tenths: bool = True) -> str:
    """1:05.3 (or 1:02:05.3 past an hour)."""
    s = max(ms, 0) / 1000
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    secs = f"{sec:04.1f}" if tenths else f"{int(sec):02d}"
    return f"{int(h)}:{int(m):02d}:{secs}" if h >= 1 else f"{int(m)}:{secs}"


def parse_clock(text: str) -> int | None:
    """'1:05.3', '65.3', '1:02:05' -> milliseconds; None if it is not a time."""
    text = text.strip().replace(",", ".")
    if not re.fullmatch(r"\d+(:\d{1,2})?(:\d{1,2})?(\.\d*)?", text):
        return None
    total = 0.0
    for part in text.split(":"):
        total = total * 60 + float(part or 0)
    return int(round(total * 1000))


def clip_target(src: str) -> str:
    p = Path(src)
    for n in range(1, 1000):
        out = p.with_name(f"{p.stem} (clip{'' if n == 1 else f' {n}'}){p.suffix}")
        if not out.exists():
            return str(out)
    raise OSError("too many clips of this file")


def clip_command(ffmpeg: str, src: str, dest: str, start_ms: int, end_ms: int) -> list[str]:
    """ffmpeg arguments that copy src's start..end to dest, with its tags and cover art."""
    ext = Path(dest).suffix.lower()
    cmd = [ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y"]
    if start_ms > 0:
        cmd += ["-ss", f"{start_ms / 1000:.3f}"]
    cmd += ["-i", src, "-t", f"{(end_ms - start_ms) / 1000:.3f}", "-map", "0", "-c", "copy",
            "-map_metadata", "0", "-map_metadata:s:a", "0:s:a"]
    if ext == ".flac":
        cmd += ["-c:a", "flac"]  # copied FLAC keeps the whole file's length in its header
    if ext == ".m4a":
        cmd += ["-movflags", "+faststart"]
    return cmd + [dest]


# --------------------------------------------------------------------------- waveform
class Waveform(QWidget):
    """The track's peaks; the part outside the clip is shaded. Drag the handles, click to seek."""

    seek = Signal(int)          # ms
    marksChanged = Signal()

    HANDLE = 7  # half-width of the grab area around a handle

    def __init__(self, parent=None):
        super().__init__(parent)
        self.peaks: list[float] = []
        self.duration = 0
        self.position = 0
        self.start = 0
        self.end = 0
        self.message = "Reading the track…"
        self._drag: str | None = None
        self.setMinimumHeight(150)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self.setMouseTracking(True)
        self.setCursor(Qt.PointingHandCursor)
        self.setToolTip("Drag the green handles to choose the part to keep; click anywhere to listen from there")

    def set_duration(self, ms: int):
        if ms <= 0:
            return
        whole = self.end in (0, self.duration)
        self.duration = ms
        if whole:
            self.end = ms
        self.start, self.end = min(self.start, ms), min(self.end, ms)
        self.update()

    def set_marks(self, start: int, end: int):
        self.start, self.end = start, end
        self.update()
        self.marksChanged.emit()

    def _x(self, ms: float) -> float:
        return 4 + (ms / self.duration if self.duration else 0) * (self.width() - 8)

    def _ms(self, x: float) -> int:
        if not self.duration:
            return 0
        return int(min(max((x - 4) / max(self.width() - 8, 1), 0), 1) * self.duration)

    def paintEvent(self, _):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        r = QRectF(self.rect())
        p.setPen(Qt.NoPen)
        p.setBrush(QColor(snake_theme.INPUT))
        p.drawRoundedRect(r, 8, 8)
        mid, half = r.center().y(), r.height() / 2 - 10
        if self.peaks:
            accent, dim = QColor(snake_theme.ACCENT), QColor(snake_theme.FG3)
            n, w = len(self.peaks), r.width() - 8
            x0, x1 = self._x(self.start), self._x(self.end)
            for i, peak in enumerate(self.peaks):
                x = 4 + (i + 0.5) / n * w
                h = max(peak * half, 0.75)
                p.setPen(QPen(accent if x0 <= x <= x1 else dim, max(w / n * 0.7, 1)))
                p.drawLine(int(x), int(mid - h), int(x), int(mid + h))
        else:
            p.setPen(QColor(snake_theme.FG2))
            p.drawText(r, Qt.AlignCenter, self.message)
        if not self.duration:
            return
        shade = QColor(snake_theme.TITLE)
        shade.setAlpha(150)
        x0, x1 = self._x(self.start), self._x(self.end)
        p.setPen(Qt.NoPen)
        p.setBrush(shade)
        p.drawRect(QRectF(r.left(), r.top(), x0 - r.left(), r.height()))
        p.drawRect(QRectF(x1, r.top(), r.right() - x1, r.height()))
        # the handles
        for x in (x0, x1):
            p.setPen(QPen(QColor(snake_theme.HIGHLIGHT), 2))
            p.drawLine(int(x), int(r.top() + 2), int(x), int(r.bottom() - 2))
            p.setPen(Qt.NoPen)
            p.setBrush(QColor(snake_theme.HIGHLIGHT))
            p.drawRoundedRect(QRectF(x - 5, r.top() + 2, 10, 14), 3, 3)
            p.drawRoundedRect(QRectF(x - 5, r.bottom() - 16, 10, 14), 3, 3)
        # where playback is
        px = self._x(self.position)
        p.setPen(QPen(QColor(snake_theme.FG), 1.5))
        p.drawLine(int(px), int(r.top()), int(px), int(r.bottom()))

    def _handle_at(self, x: float) -> str | None:
        d0, d1 = abs(x - self._x(self.start)), abs(x - self._x(self.end))
        if min(d0, d1) > self.HANDLE:
            return None
        return "start" if d0 < d1 or (d0 == d1 and x < self._x(self.start)) else "end"

    def mousePressEvent(self, e):
        if e.button() != Qt.LeftButton or not self.duration:
            return
        x = e.position().x()
        self._drag = self._handle_at(x)
        if not self._drag:
            self.seek.emit(self._ms(x))

    def mouseMoveEvent(self, e):
        x = e.position().x()
        if self._drag == "start":
            self.start = min(self._ms(x), self.end - MIN_CLIP_MS)
            self.start = max(self.start, 0)
            self.update()
            self.marksChanged.emit()
        elif self._drag == "end":
            self.end = max(self._ms(x), self.start + MIN_CLIP_MS)
            self.end = min(self.end, self.duration)
            self.update()
            self.marksChanged.emit()
        else:
            self.setCursor(Qt.SizeHorCursor if self._handle_at(x) else Qt.PointingHandCursor)

    def mouseReleaseEvent(self, _):
        if self._drag:
            self.seek.emit(self.start if self._drag == "start" else max(self.end - 3000, self.start))
        self._drag = None


# --------------------------------------------------------------------------- the window
class ClipDialog(QDialog):
    """Pick the part of `path` to keep and save it. `saved` gives the new file."""

    saved = Signal(str)

    def __init__(self, path: str, thumb: QPixmap | None = None, parent=None):
        super().__init__(parent)
        self.path = path
        self.settings = QSettings("SnakesSounds", "SnakesSounds")
        self._proc: QProcess | None = None
        self._wave_proc: QProcess | None = None
        self._wave_data = bytearray()
        self._dest = self._final = ""
        self.setWindowTitle(f"Clip · {Path(path).name}")
        self.setMinimumSize(760, 400)
        self.resize(self.settings.value("clip_size", self.minimumSize()))

        self.player = QMediaPlayer(self)
        self.audio = QAudioOutput(self)
        self.player.setAudioOutput(self.audio)
        self.player.positionChanged.connect(self._on_position)
        self.player.durationChanged.connect(self._on_duration)
        self.player.playbackStateChanged.connect(lambda _s: self._sync())
        self.player.errorOccurred.connect(lambda _e, text: self.note.setText(f"Cannot play this file: {text}"))

        # top: cover and name
        top = QHBoxLayout()
        if thumb is not None and not thumb.isNull():
            cover = QLabel()
            cover.setPixmap(thumb.scaled(96, 54, Qt.KeepAspectRatio, Qt.SmoothTransformation))
            top.addWidget(cover)
        name = QLabel(Path(path).name)
        name.setObjectName("heading")
        name.setWordWrap(True)
        name.setToolTip(path)
        top.addWidget(name, 1)

        self.wave = Waveform()
        self.wave.seek.connect(self.player.setPosition)
        self.wave.marksChanged.connect(self._marks_changed)

        # transport and marks
        self.play_btn = QPushButton("▶ Play clip")
        self.play_btn.setToolTip("Play the part you keep (Space)")
        self.play_btn.clicked.connect(self.toggle_play)
        self.time = QLabel("0:00.0")
        self.time.setObjectName("muted")
        self.in_btn = QPushButton("⟦ Start here")
        self.in_btn.setObjectName("small")
        self.in_btn.setToolTip("The clip starts where playback is now (I)")
        self.in_btn.clicked.connect(self.mark_in)
        self.out_btn = QPushButton("End here ⟧")
        self.out_btn.setObjectName("small")
        self.out_btn.setToolTip("The clip ends where playback is now (O)")
        self.out_btn.clicked.connect(self.mark_out)
        self.start_edit = QLineEdit()
        self.end_edit = QLineEdit()
        for edit, tip in ((self.start_edit, "Start of the clip, like 1:05.3"), (self.end_edit, "End of the clip, like 2:40")):
            edit.setFixedWidth(90)
            edit.setAlignment(Qt.AlignCenter)
            edit.setToolTip(tip + "; press Enter")
            edit.editingFinished.connect(self._edits_changed)
        reset = QPushButton("Whole track")
        reset.setObjectName("small")
        reset.setToolTip("Keep everything again")
        reset.clicked.connect(lambda: self.wave.set_marks(0, self.wave.duration))

        row = QHBoxLayout()
        row.addWidget(self.play_btn)
        row.addWidget(self.time)
        row.addStretch()
        row.addWidget(self.in_btn)
        row.addWidget(self.start_edit)
        dash = QLabel("to")
        dash.setObjectName("muted")
        row.addWidget(dash)
        row.addWidget(self.end_edit)
        row.addWidget(self.out_btn)
        row.addWidget(reset)

        self.length = QLabel()
        self.length.setObjectName("muted")
        self.note = QLabel("Drag the handles, or play to a spot and press I (start) and O (end).")
        self.note.setObjectName("hint")
        self.note.setWordWrap(True)

        self.replace = QCheckBox("Replace the original")
        self.replace.setToolTip("Off: the clip is saved next to the track as \"… (clip)\" and the track is kept")
        self.replace.setChecked(self.settings.value("clip_replace", False, type=bool))
        self.save_btn = QPushButton("✂ Save clip")
        self.save_btn.setObjectName("primary")
        self.save_btn.clicked.connect(self.save)
        cancel = QPushButton("Cancel")
        cancel.clicked.connect(self.reject)
        bottom = QHBoxLayout()
        bottom.addWidget(self.replace)
        bottom.addStretch()
        bottom.addWidget(cancel)
        bottom.addWidget(self.save_btn)

        lay = QVBoxLayout(self)
        lay.setSpacing(10)
        lay.addLayout(top)
        lay.addWidget(self.wave, 1)
        lay.addLayout(row)
        lay.addWidget(self.length)
        lay.addWidget(self.note)
        lay.addLayout(bottom)

        for key, slot in (("Space", self.toggle_play), ("I", self.mark_in), ("O", self.mark_out),
                          ("Left", lambda: self._nudge(-5000)), ("Right", lambda: self._nudge(5000)),
                          ("Shift+Left", lambda: self._nudge(-1000)), ("Shift+Right", lambda: self._nudge(1000)),
                          ("Home", lambda: self.player.setPosition(self.wave.start)),
                          ("End", lambda: self.player.setPosition(max(self.wave.end - 3000, self.wave.start)))):
            sc = QShortcut(QKeySequence(key), self)
            sc.activated.connect(slot)

        self.player.setSource(QUrl.fromLocalFile(path))
        self._read_waveform()
        self._marks_changed()

    # ---------------------------------------------------------------- waveform
    def _read_waveform(self):
        ffmpeg = find_ffmpeg()
        if not ffmpeg:
            self.wave.message = "No waveform: ffmpeg was not found"
            return
        self._wave_proc = proc = QProcess(self)
        proc.readyReadStandardOutput.connect(lambda: self._wave_data.extend(proc.readAllStandardOutput().data()))
        proc.finished.connect(self._waveform_read)
        proc.start(ffmpeg, ["-hide_banner", "-nostdin", "-loglevel", "error", "-i", self.path, "-map", "0:a:0",
                            "-ac", "1", "-ar", str(WAVE_RATE), "-f", "s16le", "-"])

    def _waveform_read(self, *_):
        data = self._wave_data
        self._wave_proc = None
        samples = array("h")
        samples.frombytes(bytes(data[: len(data) // 2 * 2]))
        if sys.byteorder == "big":
            samples.byteswap()
        if not samples:
            self.wave.message = "No waveform for this file"
            self.wave.update()
            return
        buckets = 800
        step = max(len(samples) / buckets, 1)
        peaks = []
        for i in range(min(buckets, len(samples))):
            chunk = samples[int(i * step): max(int((i + 1) * step), int(i * step) + 1)]
            peaks.append(max(max(chunk), -min(chunk)) / 32768)
        top = max(peaks) or 1
        self.wave.peaks = [min(pk / top, 1) ** 0.8 for pk in peaks]
        if not self.wave.duration:  # the player has not told us yet
            self.wave.set_duration(int(len(samples) / WAVE_RATE * 1000))
            self._marks_changed()
        self.wave.update()

    # ---------------------------------------------------------------- playback
    def toggle_play(self):
        if self.player.playbackState() == QMediaPlayer.PlayingState:
            self.player.pause()
            return
        pos = self.player.position()
        if pos < self.wave.start or pos >= self.wave.end - 50:
            self.player.setPosition(self.wave.start)
        self.player.play()

    def _nudge(self, ms: int):
        self.player.setPosition(int(min(max(self.player.position() + ms, 0), self.wave.duration)))

    def _on_position(self, ms: int):
        self.wave.position = ms
        self.wave.update()
        self.time.setText(clock(ms))
        # Playing the clip stops at its end, so you hear exactly what you keep.
        if self.player.playbackState() == QMediaPlayer.PlayingState and ms >= self.wave.end:
            self.player.pause()
            self.player.setPosition(self.wave.end)

    def _on_duration(self, ms: int):
        self.wave.set_duration(ms)
        self._marks_changed()

    def _sync(self):
        playing = self.player.playbackState() == QMediaPlayer.PlayingState
        self.play_btn.setText("❚❚ Pause" if playing else "▶ Play clip")

    # ---------------------------------------------------------------- marks
    def mark_in(self):
        pos = self.player.position()
        end = self.wave.end if self.wave.end - pos >= MIN_CLIP_MS else self.wave.duration
        self.wave.set_marks(min(pos, end - MIN_CLIP_MS), end)

    def mark_out(self):
        pos = max(self.player.position(), MIN_CLIP_MS)
        start = self.wave.start if pos - self.wave.start >= MIN_CLIP_MS else 0
        self.wave.set_marks(start, pos)

    def _edits_changed(self):
        start, end = parse_clock(self.start_edit.text()), parse_clock(self.end_edit.text())
        dur = self.wave.duration
        if start is None or end is None or not dur:
            self._marks_changed()  # put back what is valid
            return
        end = min(end, dur)
        start = min(start, max(end - MIN_CLIP_MS, 0))
        if (start, end) != (self.wave.start, self.wave.end):
            self.wave.set_marks(start, end)
            self.player.setPosition(start)

    def _marks_changed(self):
        w = self.wave
        ready = w.duration > 0
        for b in (self.in_btn, self.out_btn, self.play_btn, self.start_edit, self.end_edit):
            b.setEnabled(ready and self._proc is None)
        whole = w.start == 0 and w.end >= w.duration
        self.save_btn.setEnabled(ready and not whole and self._proc is None)
        if not ready:
            self.length.setText("")
            return
        self.start_edit.setText(clock(w.start))
        self.end_edit.setText(clock(w.end))
        size = os.path.getsize(self.path) if os.path.exists(self.path) else 0
        est = size * (w.end - w.start) / w.duration if w.duration else 0
        self.length.setText(f"Keeps {clock(w.end - w.start)} of {clock(w.duration, tenths=False)}"
                            + (f"  ·  about {human_bytes(est)}" if est else ""))

    # ---------------------------------------------------------------- saving
    def save(self):
        ffmpeg = find_ffmpeg()
        if not ffmpeg:
            self.note.setText("Clipping needs ffmpeg, which was not found.")
            return
        if self._proc is not None:
            return
        self.player.pause()
        replace = self.replace.isChecked()
        self.settings.setValue("clip_replace", replace)
        src = Path(self.path)
        self._final = str(src) if replace else clip_target(self.path)
        self._dest = str(src.with_name(f".{src.stem}.clipping{src.suffix}")) if replace else self._final
        cmd = clip_command(ffmpeg, self.path, self._dest, self.wave.start, self.wave.end)
        self._proc = proc = QProcess(self)
        proc.setProcessChannelMode(QProcess.MergedChannels)
        proc.finished.connect(self._saved)
        proc.errorOccurred.connect(lambda _e: self._saved(-1, None))
        self.note.setText("Saving the clip…")
        self._marks_changed()
        proc.start(cmd[0], cmd[1:])

    def _saved(self, code, _status):
        proc, self._proc = self._proc, None
        if proc is None:
            return
        out = bytes(proc.readAll().data()).decode("utf-8", "replace").strip().splitlines()
        ok = code == 0 and os.path.exists(self._dest) and os.path.getsize(self._dest) > 0
        if ok and self._dest != self._final:
            self.player.setSource(QUrl())  # let go of the original before it is replaced
            try:
                os.replace(self._dest, self._final)
            except OSError as e:
                ok, out = False, [str(e)]
        if not ok:
            try:
                os.remove(self._dest)
            except OSError:
                pass
            self.note.setText("Saving the clip failed" + (f": {out[-1]}" if out else "."))
            self._marks_changed()
            return
        self.saved.emit(self._final)
        self.accept()

    # ---------------------------------------------------------------- closing
    def done(self, result):
        if self._proc is not None:
            return  # still writing; it closes itself when done
        self.settings.setValue("clip_size", self.size())
        self.player.stop()
        if self._wave_proc is not None:
            self._wave_proc.kill()
            self._wave_proc.waitForFinished(1000)
        super().done(result)
