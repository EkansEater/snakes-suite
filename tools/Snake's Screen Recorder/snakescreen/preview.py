"""Preview panel: plays the selected MP4, GIF or MP3 inside the main window, and trims it."""

import os
import subprocess
import tempfile
from pathlib import Path

from PyQt6.QtCore import QRectF, QSize, Qt, QTimer, QUrl, pyqtSignal
from PyQt6.QtGui import QColor, QFont, QImage, QKeySequence, QMovie, QPainter, QShortcut
from PyQt6.QtMultimedia import QAudioOutput, QMediaPlayer, QVideoSink
from . import snake_theme
from .platforms import POPEN_FLAGS, ffmpeg
from PyQt6.QtWidgets import QHBoxLayout, QLabel, QPushButton, QSlider, QStyle, QStyleOptionSlider, QVBoxLayout, QWidget

PANEL_WIDTH = 440


class _Canvas(QWidget):
    """Paints one image, scaled to fit with its aspect ratio kept."""

    clicked = pyqtSignal()

    def __init__(self):
        super().__init__()
        self.image = QImage()
        self.placeholder = ""
        self.setMinimumSize(320, 220)

    def set_image(self, image):
        self.image = image
        self.update()

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self.clicked.emit()

    def paintEvent(self, _event):
        p = QPainter(self)
        p.fillRect(self.rect(), QColor(snake_theme.TITLE))
        if self.image.isNull():
            p.setPen(QColor(snake_theme.FG2))
            p.setFont(QFont(self.font().family(), 13))
            p.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, self.placeholder)
            return
        size = QSize(self.image.size())
        size.scale(self.size(), Qt.AspectRatioMode.KeepAspectRatio)
        target = QRectF(0, 0, size.width(), size.height())
        target.moveCenter(QRectF(self.rect()).center())
        p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
        p.drawImage(target, self.image)


class _TrimSlider(QSlider):
    """The position slider, with the parts a trim would cut off shaded."""

    def __init__(self):
        super().__init__(Qt.Orientation.Horizontal)
        self.trim_in = None
        self.trim_out = None

    def _x(self, value, groove):
        span = max(self.maximum() - self.minimum(), 1)
        return groove.left() + (value - self.minimum()) / span * groove.width()

    def paintEvent(self, event):
        super().paintEvent(event)
        if self.trim_in is None and self.trim_out is None:
            return
        opt = QStyleOptionSlider()
        self.initStyleOption(opt)
        groove = self.style().subControlRect(QStyle.ComplexControl.CC_Slider, opt, QStyle.SubControl.SC_SliderGroove, self)
        p = QPainter(self)
        shade = QColor(snake_theme.TITLE)
        shade.setAlpha(190)
        top, height = self.rect().top() + 3, self.rect().height() - 6
        start = self._x(self.trim_in or 0, groove)
        end = self._x(self.trim_out if self.trim_out is not None else self.maximum(), groove)
        if start > groove.left():
            p.fillRect(QRectF(groove.left(), top, start - groove.left(), height), shade)
        if end < groove.right():
            p.fillRect(QRectF(end, top, groove.right() - end, height), shade)
        p.setPen(QColor(snake_theme.ACCENT))
        for x in (start, end):
            p.drawLine(int(x), top, int(x), top + height)


class PreviewPanel(QWidget):
    closed = pyqtSignal()
    trimmed = pyqtSignal(str)  # a trimmed copy was saved there

    def __init__(self, parent=None):
        super().__init__(parent)
        self.path = None
        self._movie = None
        self._seeking = False
        self._frame_size = None

        self.player = QMediaPlayer(self)
        self.audio_out = QAudioOutput(self)
        self.sink = QVideoSink(self)
        self.player.setAudioOutput(self.audio_out)
        self.player.setVideoSink(self.sink)
        self.sink.videoFrameChanged.connect(self._on_video_frame)
        self.player.positionChanged.connect(self._on_position)
        self.player.durationChanged.connect(self._on_duration)
        self.player.playbackStateChanged.connect(lambda _s: self._update_play_button())
        self.player.mediaStatusChanged.connect(self._on_media_status)
        self.player.errorOccurred.connect(lambda _e, text: self._set_info(f"Cannot play this file: {text}"))

        self.setFixedWidth(PANEL_WIDTH)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(4, 0, 0, 0)
        header = QHBoxLayout()
        self.title = QLabel(objectName="status")
        self.title.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        close = QPushButton("✕")
        close.setFixedWidth(34)
        close.setToolTip("Close preview")
        close.clicked.connect(self.close_preview)
        header.addWidget(self.title, 1)
        header.addWidget(close)
        layout.addLayout(header)

        self.canvas = _Canvas()
        self.canvas.clicked.connect(self.toggle_play)
        layout.addWidget(self.canvas, 1)

        controls = QHBoxLayout()
        self.play_btn = QPushButton()
        self.play_btn.setFixedWidth(44)
        self.play_btn.clicked.connect(self.toggle_play)
        self.slider = _TrimSlider()
        self.slider.sliderPressed.connect(lambda: setattr(self, "_seeking", True))
        self.slider.sliderReleased.connect(self._seek_released)
        self.slider.sliderMoved.connect(self._seek_to)
        self.time_label = QLabel("0:00 / 0:00")
        controls.addWidget(self.play_btn)
        controls.addWidget(self.slider, 1)
        controls.addWidget(self.time_label)
        layout.addLayout(controls)

        # Trim: mark where the copy starts and ends while watching, then save it.
        self.trim_in = None
        self.trim_out = None
        self._trim_proc = None
        trim = QHBoxLayout()
        self.in_btn = QPushButton("⟦ Start here", objectName="small")
        self.in_btn.setToolTip("Keep from the current position (I)")
        self.in_btn.clicked.connect(self.mark_in)
        self.out_btn = QPushButton("End here ⟧", objectName="small")
        self.out_btn.setToolTip("Keep up to the current position (O)")
        self.out_btn.clicked.connect(self.mark_out)
        self.reset_btn = QPushButton("Reset", objectName="small")
        self.reset_btn.setToolTip("Keep the whole recording")
        self.reset_btn.clicked.connect(self.reset_trim)
        self.save_trim_btn = QPushButton("Save trimmed copy", objectName="small")
        self.save_trim_btn.setToolTip("Save the part between the marks as a new file next to this one")
        self.save_trim_btn.clicked.connect(self.save_trimmed)
        trim.addWidget(self.in_btn)
        trim.addWidget(self.out_btn)
        trim.addWidget(self.reset_btn)
        trim.addStretch(1)
        trim.addWidget(self.save_trim_btn)
        layout.addLayout(trim)
        self.trim_label = QLabel(objectName="hint")
        layout.addWidget(self.trim_label)
        self._trim_timer = QTimer(self, interval=250, timeout=self._poll_trim)
        for key, slot in (("I", self.mark_in), ("O", self.mark_out)):
            QShortcut(QKeySequence(key), self, slot, context=Qt.ShortcutContext.WidgetWithChildrenShortcut)

        self.info = QLabel(objectName="hint", wordWrap=True)
        layout.addWidget(self.info)
        self._update_play_button()
        self._update_trim()

    # -- public -----------------------------------------------------------
    def show_file(self, path):
        """Open the panel on `path`, or empty when it is None."""
        if path == self.path and self.isVisible():
            return
        self._unload()
        self.path = path
        self.play_btn.setEnabled(bool(path))
        if not path:
            self.title.setText("Preview")
            self.title.setToolTip("")
            self.canvas.placeholder = "Select a recording to preview"
            self.canvas.set_image(QImage())
            self.slider.hide()
            self.time_label.hide()
            self._set_info("")
            self._update_play_button()
            self.show()
            return
        p = Path(path)
        self.title.setText(p.name)
        self.title.setToolTip(path)
        self._frame_size = None
        self.canvas.placeholder = "♪  Audio recording" if p.suffix.lower() == ".mp3" else ""
        self.canvas.set_image(QImage())
        if not p.exists():
            self.canvas.placeholder = "File not found"
            self._set_info("This recording was moved or deleted.")
        elif p.suffix.lower() == ".gif":
            self._movie = QMovie(path, parent=self)
            self._movie.frameChanged.connect(self._on_gif_frame)
            self._movie.stateChanged.connect(lambda _s: self._update_play_button())
            self._movie.start()  # GIFs are silent, so just loop them
        else:
            self.player.setSource(QUrl.fromLocalFile(path))
            self.player.pause()  # loads and shows the first frame without making noise
        gif = self._movie is not None
        self.slider.setVisible(not gif)
        self.time_label.setVisible(not gif)
        self.slider.setValue(0)
        self._update_info()
        self._update_play_button()
        self.reset_trim()
        self.show()

    def close_preview(self):
        self._unload()
        self.path = None
        self.hide()
        self.closed.emit()

    def pause(self):
        """Stop making sound, e.g. because a recording is about to start."""
        self.player.pause()
        if self._movie:
            self._movie.setPaused(True)

    def toggle_play(self):
        if self._movie:
            self._movie.setPaused(self._movie.state() == QMovie.MovieState.Running)
        elif self.path:
            if self.player.playbackState() == QMediaPlayer.PlaybackState.PlayingState:
                self.player.pause()
            else:
                self.player.play()

    # -- internals --------------------------------------------------------
    # -- trimming ---------------------------------------------------------
    def _trimmable(self):
        return bool(self.path) and self._movie is None and Path(self.path).exists() and self.player.duration() > 0

    def mark_in(self):
        if not self._trimmable():
            return
        pos = self.player.position()
        self.trim_in = pos if pos > 0 else None
        if self.trim_out is not None and self.trim_out <= pos:
            self.trim_out = None
        self._update_trim()

    def mark_out(self):
        if not self._trimmable():
            return
        pos = self.player.position()
        self.trim_out = pos if pos < self.player.duration() else None
        if self.trim_in is not None and self.trim_in >= pos:
            self.trim_in = None
        self._update_trim()

    def reset_trim(self):
        self.trim_in = self.trim_out = None
        self._update_trim()

    def _update_trim(self):
        self.slider.trim_in, self.slider.trim_out = self.trim_in, self.trim_out
        self.slider.update()
        busy = self._trim_proc is not None
        can = self._trimmable() and not busy
        for b in (self.in_btn, self.out_btn):
            b.setEnabled(can)
        marked = self.trim_in is not None or self.trim_out is not None
        self.reset_btn.setEnabled(can and marked)
        self.save_trim_btn.setEnabled(can and marked)
        if busy:
            return
        if self.path and self._movie is not None:
            self.trim_label.setText("GIFs cannot be trimmed here.")
        elif marked:
            start = self.trim_in or 0
            end = self.trim_out if self.trim_out is not None else self.player.duration()
            self.trim_label.setText(f"Keeps {_exact(start)} to {_exact(end)} ({_exact(end - start)} of {_clock(self.player.duration())})")
        else:
            self.trim_label.setText("To trim, play to a spot and press Start here or End here.")

    def _trim_target(self):
        src = Path(self.path)
        for n in range(1, 1000):
            out = src.with_name(f"{src.stem} (trimmed{'' if n == 1 else f' {n}'}){src.suffix}")
            if not out.exists():
                return out
        raise OSError("too many trimmed copies")

    def save_trimmed(self):
        if not self._trimmable() or self._trim_proc is not None:
            return
        tool = ffmpeg()
        if not tool:
            self.trim_label.setText("Trimming needs ffmpeg, which was not found.")
            return
        start = (self.trim_in or 0) / 1000
        end = (self.trim_out if self.trim_out is not None else self.player.duration()) / 1000
        out = self._trim_target()
        cmd = [tool, "-hide_banner", "-nostdin", "-y"]
        if start > 0:
            cmd += ["-ss", f"{start:.3f}"]
        cmd += ["-i", self.path, "-t", f"{end - start:.3f}", "-map", "0"]
        if out.suffix.lower() == ".mp3" or start == 0:
            # MP3 cuts cleanly anywhere, and so does any video at its end: copy, losing nothing.
            cmd += ["-c", "copy"]
        else:
            # A video cut at its start must be encoded again to begin on that exact frame.
            cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-c:a", "aac", "-b:a", "192k"]
        if out.suffix.lower() == ".mp4":
            cmd += ["-movflags", "+faststart"]
        fd, progress = tempfile.mkstemp(prefix="snakescreen-trim-", suffix=".txt")
        os.close(fd)
        self._trim_progress = Path(progress)
        self._trim_log = tempfile.TemporaryFile()
        cmd += ["-progress", str(self._trim_progress), "-nostats", str(out)]
        try:
            self._trim_proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=self._trim_log, stderr=self._trim_log, **POPEN_FLAGS)
        except OSError as e:
            self.trim_label.setText(f"Could not run ffmpeg: {e}")
            return
        self._trim_out, self._trim_length = out, max(end - start, 0.001)
        self.trim_label.setText("Trimming…")
        self._update_trim()
        self._trim_timer.start()

    def _poll_trim(self):
        proc = self._trim_proc
        if proc.poll() is None:
            try:
                lines = self._trim_progress.read_text(encoding="utf-8", errors="replace").splitlines()
                done = [int(x.split("=", 1)[1]) for x in lines if x.startswith("out_time_us=") and x[12:].strip().isdigit()]
                if done:
                    self.trim_label.setText(f"Trimming… {min(99, done[-1] / 1e4 / self._trim_length):.0f}%")
            except OSError:
                pass
            return
        self._trim_timer.stop()
        self._trim_proc = None
        self._trim_progress.unlink(missing_ok=True)
        out = self._trim_out
        if proc.returncode == 0 and out.exists() and out.stat().st_size > 0:
            self._trim_log.close()
            self.reset_trim()
            self.trim_label.setText(f"Saved {out.name}")
            self.trimmed.emit(str(out))
        else:
            self._trim_log.seek(0)
            tail = self._trim_log.read().decode("utf-8", "replace").strip().splitlines()[-1:]
            self._trim_log.close()
            out.unlink(missing_ok=True)
            self._update_trim()
            self.trim_label.setText("Trimming failed" + (f": {tail[0]}" if tail else "."))

    def _unload(self):
        self.player.stop()
        self.player.setSource(QUrl())
        if self._movie:
            self._movie.stop()
            self._movie.deleteLater()
            self._movie = None

    def _playing(self):
        if self._movie:
            return self._movie.state() == QMovie.MovieState.Running
        return self.player.playbackState() == QMediaPlayer.PlaybackState.PlayingState

    def _update_play_button(self):
        self.play_btn.setText("❚❚" if self._playing() else "▶")

    def _on_video_frame(self, frame):
        if frame.isValid():
            image = frame.toImage()
            if self._frame_size != image.size():
                self._frame_size = image.size()
                self._update_info()
            self.canvas.set_image(image)

    def _on_gif_frame(self, _number):
        image = self._movie.currentImage()
        if self._frame_size != image.size():
            self._frame_size = image.size()
            self._update_info()
        self.canvas.set_image(image)

    def _on_media_status(self, status):
        if status == QMediaPlayer.MediaStatus.EndOfMedia:
            self.player.setPosition(0)  # rewind so Play starts over
            self.player.pause()

    def _on_duration(self, ms):
        self.slider.setRange(0, max(ms, 0))
        self._on_position(self.player.position())
        self._update_info()
        self._update_trim()

    def _on_position(self, ms):
        if not self._seeking:
            self.slider.setValue(ms)
        self.time_label.setText(f"{_clock(ms)} / {_clock(self.player.duration())}")

    def _seek_to(self, ms):
        self.player.setPosition(ms)

    def _seek_released(self):
        self._seeking = False
        self.player.setPosition(self.slider.value())

    def _update_info(self):
        if not self.path or not Path(self.path).exists():
            return
        parts = [_size(Path(self.path).stat().st_size)]
        if self._frame_size and not self._frame_size.isEmpty():
            parts.append(f"{self._frame_size.width()} × {self._frame_size.height()}")
        if self._movie and self._movie.frameCount() > 0:
            parts.append(f"{self._movie.frameCount()} frames")
        elif not self._movie and self.player.duration() > 0:
            parts.append(_clock(self.player.duration()))
        self._set_info("  ·  ".join(parts))

    def _set_info(self, text):
        self.info.setText(text)


def _clock(ms):
    s = max(ms, 0) // 1000
    return f"{s // 3600}:{s % 3600 // 60:02}:{s % 60:02}" if s >= 3600 else f"{s // 60}:{s % 60:02}"


def _exact(ms):
    """A trim mark, to a tenth of a second."""
    s = max(ms, 0) / 1000
    return f"{int(s // 60)}:{s % 60:04.1f}"


def _size(n):
    for unit in ("bytes", "KB", "MB"):
        if n < 1024:
            return f"{n:.0f} {unit}" if unit == "bytes" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} GB"
