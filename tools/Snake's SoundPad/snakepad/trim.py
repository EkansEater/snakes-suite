"""Trim and loop: choose where a sound starts and ends on its waveform, and whether it repeats."""

from __future__ import annotations

from array import array

from PySide6.QtCore import QRectF, Qt, QUrl, Signal
from PySide6.QtGui import QColor, QPainter, QPen
from PySide6.QtWidgets import (
    QCheckBox, QDialog, QDialogButtonBox, QDoubleSpinBox, QHBoxLayout, QLabel, QPushButton, QVBoxLayout, QWidget,
)

from . import snake_theme
from .library import Sound

try:  # Qt Multimedia comes with PySide6-Addons; without it there is no waveform or preview
    from PySide6.QtMultimedia import QAudioDecoder, QAudioOutput, QMediaPlayer
except ImportError:
    QAudioDecoder = None

BARS = 400
# Sample formats a decoded buffer can come in: array type code, and the value of silence and of full scale.
SAMPLES = {"UInt8": ("B", 128, 128), "Int16": ("h", 0, 32768), "Int32": ("i", 0, 2 ** 31), "Float": ("f", 0, 1.0)}
GRIP = 7  # pixels either side of a mark that grab it


def clock(seconds: float) -> str:
    seconds = max(seconds, 0.0)
    return f"{int(seconds // 60)}:{seconds % 60:04.1f}"


class Waveform(QWidget):
    """The sound's loudness over time, with a start and an end mark to drag."""

    marksChanged = Signal()
    seekRequested = Signal(float)

    def __init__(self) -> None:
        super().__init__()
        self.peaks: list[float] = []
        self.length = 0.0
        self.start = 0.0
        self.end = 0.0
        self.playhead: float | None = None
        self.message = "Reading the sound…"
        self._drag: str | None = None
        self.setMinimumHeight(120)
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.setToolTip("Drag the marks to choose where the sound starts and ends; click to listen from there")

    def _area(self) -> QRectF:
        return QRectF(self.rect()).adjusted(GRIP, 6, -GRIP, -6)

    def x_of(self, t: float) -> float:
        a = self._area()
        return a.left() + (t / self.length if self.length else 0) * a.width()

    def t_of(self, x: float) -> float:
        a = self._area()
        return max(0.0, min(self.length, (x - a.left()) / max(a.width(), 1) * self.length))

    def _near(self, x: float) -> str | None:
        if not self.length:
            return None
        ds, de = abs(x - self.x_of(self.start)), abs(x - self.x_of(self.end))
        if min(ds, de) > GRIP:
            return None
        return "start" if ds <= de else "end"

    def paintEvent(self, _event) -> None:
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.fillRect(self.rect(), QColor(snake_theme.WIDGET))
        a = self._area()
        if not self.peaks or not self.length:
            p.setPen(QColor(snake_theme.FG2))
            p.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, self.message)
            return
        mid, half = a.center().y(), a.height() / 2
        step = a.width() / len(self.peaks)
        keep, cut = QColor(snake_theme.ACCENT), QColor(snake_theme.FG2)
        cut.setAlpha(110)
        for i, peak in enumerate(self.peaks):
            t = (i + 0.5) / len(self.peaks) * self.length
            h = max(1.0, peak * half)
            p.fillRect(QRectF(a.left() + i * step, mid - h, max(step - 1, 1), 2 * h), keep if self.start <= t <= self.end else cut)
        for t in (self.start, self.end):
            x = self.x_of(t)
            p.setPen(QPen(QColor(snake_theme.FG), 2))
            p.drawLine(int(x), int(a.top()), int(x), int(a.bottom()))
            p.setBrush(QColor(snake_theme.FG))
            p.drawRoundedRect(QRectF(x - 4, a.top() - 4, 8, 12), 2, 2)
        if self.playhead is not None:
            x = self.x_of(self.playhead)
            p.setPen(QPen(QColor(snake_theme.ACCENT_HOVER), 1, Qt.PenStyle.DashLine))
            p.drawLine(int(x), int(a.top()), int(x), int(a.bottom()))

    def mousePressEvent(self, e) -> None:
        if e.button() != Qt.MouseButton.LeftButton or not self.length:
            return
        x = e.position().x()
        self._drag = self._near(x)
        if not self._drag:
            self.seekRequested.emit(self.t_of(x))

    def mouseMoveEvent(self, e) -> None:
        x = e.position().x()
        if self._drag:
            t = self.t_of(x)
            if self._drag == "start":
                self.start = min(t, self.end - 0.05)
            else:
                self.end = max(t, self.start + 0.05)
            self.update()
            self.marksChanged.emit()
        else:
            self.setCursor(Qt.CursorShape.SizeHorCursor if self._near(x) else Qt.CursorShape.PointingHandCursor)

    def mouseReleaseEvent(self, _e) -> None:
        self._drag = None


class TrimDialog(QDialog):
    def __init__(self, sound: Sound, parent=None) -> None:
        super().__init__(parent)
        self.sound = sound
        self.setWindowTitle(f"Trim and loop · {sound.name}")
        self.resize(640, 330)
        layout = QVBoxLayout(self)
        layout.addWidget(QLabel("Drag the marks to choose where the sound starts and ends. Click the waveform to listen from there.",
                                objectName="hint", wordWrap=True))
        self.wave = Waveform()
        self.wave.marksChanged.connect(self._marks_moved)
        self.wave.seekRequested.connect(self._preview_from)
        layout.addWidget(self.wave, 1)

        row = QHBoxLayout()
        self.start_box = self._seconds_box()
        self.end_box = self._seconds_box()
        self.start_box.valueChanged.connect(self._boxes_changed)
        self.end_box.valueChanged.connect(self._boxes_changed)
        self.play_btn = QPushButton("▶ Listen")
        self.play_btn.setToolTip("Play the part you kept, on your own speakers only")
        self.play_btn.clicked.connect(self._toggle_preview)
        reset = QPushButton("Whole sound")
        reset.setToolTip("Keep the whole file again")
        reset.clicked.connect(self._reset)
        row.addWidget(QLabel("Start"))
        row.addWidget(self.start_box)
        row.addSpacing(10)
        row.addWidget(QLabel("End"))
        row.addWidget(self.end_box)
        row.addStretch(1)
        row.addWidget(reset)
        row.addWidget(self.play_btn)
        layout.addLayout(row)

        self.loop = QCheckBox("Loop: repeat it until you stop it (Esc, or Stop)")
        self.loop.setChecked(sound.loop)
        layout.addWidget(self.loop)
        self.info = QLabel(objectName="hint")
        layout.addWidget(self.info)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

        self.length = sound.length
        self._syncing = False
        self._preview_end = 0.0
        self._set_marks(sound.start, sound.end or sound.length)
        self.player = None
        if QAudioDecoder is None:
            self.wave.message = "Install PySide6-Addons to see the waveform and listen here."
            self.play_btn.setEnabled(False)
            self._limits()
        else:
            self._decode()
            self.player = QMediaPlayer(self)
            self.player.setAudioOutput(QAudioOutput(self))
            self.player.positionChanged.connect(self._preview_position)
            self.player.playbackStateChanged.connect(self._preview_state)
        self._update_info()

    @staticmethod
    def _seconds_box() -> QDoubleSpinBox:
        box = QDoubleSpinBox()
        box.setDecimals(2)
        box.setSingleStep(0.1)
        box.setSuffix(" s")
        box.setRange(0, 24 * 3600)
        return box

    # -- the sound ---------------------------------------------------------
    def _decode(self) -> None:
        self._chunks: list[float] = []  # loudest sample of each 1/100 s
        self._seconds = 0.0
        # The file's own sample format: asking Qt to convert it can stall the decoder.
        self.decoder = QAudioDecoder(self)
        self.decoder.bufferReady.connect(self._buffer)
        self.decoder.finished.connect(self._decoded)
        self.decoder.error.connect(lambda _e: self._decode_failed())
        self.decoder.setSource(QUrl.fromLocalFile(self.sound.path))
        self.decoder.start()

    def _buffer(self) -> None:
        buf = self.decoder.read()
        fmt = buf.format()
        kind = SAMPLES.get(fmt.sampleFormat().name)
        data = buf.constData()
        if not kind or data is None or not buf.frameCount() or fmt.sampleRate() <= 0:
            return
        code, zero, full = kind
        samples = array(code)
        raw = bytes(data)
        samples.frombytes(raw[: len(raw) - len(raw) % samples.itemsize])
        self._seconds += buf.frameCount() / fmt.sampleRate()
        size = max(1, fmt.sampleRate() // 100) * max(1, fmt.channelCount())
        for i in range(0, len(samples), size):
            part = samples[i:i + size]
            self._chunks.append(max(abs(max(part) - zero), abs(min(part) - zero)) / full)

    def _decoded(self) -> None:
        if not self._chunks:
            self._decode_failed()
            return
        self.length = self._seconds
        n = len(self._chunks)
        bars = min(BARS, n)
        peaks = [max(self._chunks[i * n // bars:max((i + 1) * n // bars, i * n // bars + 1)]) for i in range(bars)]
        top = max(peaks) or 1.0
        self.wave.peaks = [x / top for x in peaks]
        self.wave.length = self.length
        if not self.sound.end or self.sound.end > self.length:
            self.wave.end = self.length
        self._limits()
        self._set_marks(self.wave.start if self.wave.start < self.length else 0.0, self.wave.end)
        self._update_info()

    def _decode_failed(self) -> None:
        self.wave.message = "Could not read this file's sound."
        self.wave.update()
        self._limits()

    def _limits(self) -> None:
        top = self.length or 24 * 3600
        self.start_box.setMaximum(top)
        self.end_box.setMaximum(top)

    # -- marks -------------------------------------------------------------
    def _set_marks(self, start: float, end: float) -> None:
        self._syncing = True
        self.wave.start, self.wave.end = start, end
        self.start_box.setValue(start)
        self.end_box.setValue(end)
        self._syncing = False
        self.wave.update()
        self._update_info()

    def _marks_moved(self) -> None:
        self._syncing = True
        self.start_box.setValue(self.wave.start)
        self.end_box.setValue(self.wave.end)
        self._syncing = False
        self._update_info()

    def _boxes_changed(self) -> None:
        if self._syncing:
            return
        start, end = self.start_box.value(), self.end_box.value()
        if self.length and end <= start:
            end = min(self.length, start + 0.05)
        self._set_marks(start, end)

    def _reset(self) -> None:
        self._set_marks(0.0, self.length)
        self.loop.setChecked(False)

    def _update_info(self) -> None:
        start, end = self.wave.start, self.wave.end
        if not self.length:
            self.info.setText("")
            return
        self.info.setText(f"Plays {clock(start)} to {clock(end)}: {end - start:.1f} s of {self.length:.1f} s")

    # -- listening ---------------------------------------------------------
    def _preview_from(self, t: float) -> None:
        if not self.player:
            return
        self._preview_end = self.wave.end if t < self.wave.end else self.length
        self.player.setSource(QUrl.fromLocalFile(self.sound.path))
        self.player.setPosition(round(t * 1000))
        self.player.play()

    def _toggle_preview(self) -> None:
        if self.player.playbackState() == QMediaPlayer.PlaybackState.PlayingState:
            self.player.stop()
        else:
            self._preview_from(self.wave.start)

    def _preview_position(self, ms: int) -> None:
        t = ms / 1000
        if t >= self._preview_end - 0.01 and self.player.playbackState() == QMediaPlayer.PlaybackState.PlayingState:
            if self.loop.isChecked() and self._preview_end == self.wave.end:
                self.player.setPosition(round(self.wave.start * 1000))
                return
            self.player.stop()
        self.wave.playhead = t
        self.wave.update()

    def _preview_state(self, state) -> None:
        playing = state == QMediaPlayer.PlaybackState.PlayingState
        self.play_btn.setText("■ Stop" if playing else "▶ Listen")
        if not playing:
            self.wave.playhead = None
            self.wave.update()

    def done(self, result: int) -> None:
        if self.player:
            self.player.stop()
        if QAudioDecoder is not None and hasattr(self, "decoder"):
            self.decoder.stop()
        super().done(result)

    # -- result --------------------------------------------------------------
    def apply_to(self, sound: Sound) -> None:
        start, end = round(self.wave.start, 3), round(self.wave.end, 3)
        sound.start = start if start > 0.005 else 0.0
        # The end of the file is stored as 0, so a file that is edited later still plays to its end.
        if self.length:
            sound.end = 0.0 if end >= self.length - 0.005 else end
        else:  # length unknown (no Qt Multimedia): take the box as typed
            sound.end = end if end > sound.start else 0.0
        sound.loop = self.loop.isChecked()
        if self.length:
            sound.length = round(self.length, 3)
