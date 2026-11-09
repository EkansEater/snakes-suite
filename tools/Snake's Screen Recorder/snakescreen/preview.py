"""Preview panel: plays the selected MP4, GIF or MP3 inside the main window, and trims it."""

import os
import subprocess
import tempfile
from pathlib import Path

from PyQt6.QtCore import QPointF, QRectF, QSize, Qt, QTimer, QUrl, pyqtSignal
from PyQt6.QtGui import QColor, QFont, QImage, QKeySequence, QMovie, QPainter, QPainterPath, QPen, QShortcut
from PyQt6.QtMultimedia import QAudioOutput, QMediaPlayer, QVideoSink
from . import snake_theme
from .platforms import POPEN_FLAGS, ffmpeg
from PyQt6.QtWidgets import QHBoxLayout, QLabel, QPushButton, QSlider, QStyle, QStyleOptionSlider, QVBoxLayout, QWidget

PANEL_WIDTH = 440


class _Canvas(QWidget):
    """Paints one image, scaled to fit with its aspect ratio kept.

    In crop mode a drag draws the rectangle to keep (in the image's own pixels): drag inside
    it to move it, near a corner to resize it, anywhere else to draw a new one.
    """

    clicked = pyqtSignal()
    cropChanged = pyqtSignal()

    GRAB = 10  # how close to a corner (screen pixels) grabs it

    def __init__(self):
        super().__init__()
        self.image = QImage()
        self.placeholder = ""
        self.crop_mode = False
        self.crop = None  # QRectF in image pixels, or None for the whole picture
        self._drag = None  # ("new" | "move" | corner index, press point in image px, crop at press)
        self.setMinimumSize(320, 220)
        self.setMouseTracking(True)

    def set_image(self, image):
        self.image = image
        self.update()

    def set_crop_mode(self, on):
        self.crop_mode = on
        self.setCursor(Qt.CursorShape.CrossCursor if on else Qt.CursorShape.ArrowCursor)
        self.update()

    def _target(self):
        size = QSize(self.image.size())
        size.scale(self.size(), Qt.AspectRatioMode.KeepAspectRatio)
        target = QRectF(0, 0, size.width(), size.height())
        target.moveCenter(QRectF(self.rect()).center())
        return target

    def _to_image(self, pos):
        t = self._target()
        if t.width() <= 0:
            return QPointF()
        k = self.image.width() / t.width()
        x = min(max((pos.x() - t.left()) * k, 0), self.image.width())
        y = min(max((pos.y() - t.top()) * k, 0), self.image.height())
        return QPointF(x, y)

    def _to_screen(self, rect):
        t = self._target()
        k = t.width() / max(self.image.width(), 1)
        return QRectF(t.left() + rect.left() * k, t.top() + rect.top() * k, rect.width() * k, rect.height() * k)

    def _corner_at(self, pos):
        if self.crop is None:
            return None
        r = self._to_screen(self.crop)
        for i, c in enumerate((r.topLeft(), r.topRight(), r.bottomRight(), r.bottomLeft())):
            if abs(c.x() - pos.x()) <= self.GRAB and abs(c.y() - pos.y()) <= self.GRAB:
                return i
        return None

    def mousePressEvent(self, event):
        if event.button() != Qt.MouseButton.LeftButton:
            return
        if not self.crop_mode or self.image.isNull():
            self.clicked.emit()
            return
        pos = event.position()
        corner = self._corner_at(pos)
        at = self._to_image(pos)
        if corner is not None:
            self._drag = (corner, at, QRectF(self.crop))
        elif self.crop is not None and self._to_screen(self.crop).contains(pos):
            self._drag = ("move", at, QRectF(self.crop))
        else:
            self._drag = ("new", at, None)

    def mouseMoveEvent(self, event):
        pos = event.position()
        if self._drag is None:
            if self.crop_mode:
                corner = self._corner_at(pos)
                inside = self.crop is not None and self._to_screen(self.crop).contains(pos)
                shape = (Qt.CursorShape.SizeFDiagCursor if corner in (0, 2) else Qt.CursorShape.SizeBDiagCursor
                         if corner in (1, 3) else Qt.CursorShape.SizeAllCursor if inside else Qt.CursorShape.CrossCursor)
                self.setCursor(shape)
            return
        kind, start, old = self._drag
        at = self._to_image(pos)
        w, h = self.image.width(), self.image.height()
        if kind == "new":
            rect = QRectF(start, at).normalized()
        elif kind == "move":
            rect = old.translated(at - start)
            rect.moveLeft(min(max(rect.left(), 0), w - rect.width()))
            rect.moveTop(min(max(rect.top(), 0), h - rect.height()))
        else:
            # the corner opposite the one dragged stays put
            fixed = (old.bottomRight(), old.bottomLeft(), old.topLeft(), old.topRight())[kind]
            rect = QRectF(fixed, at).normalized()
        self.crop = rect
        self.update()
        self.cropChanged.emit()

    def mouseReleaseEvent(self, _event):
        if self._drag is None:
            return
        self._drag = None
        r = self.crop
        if r is not None and (r.width() < 16 or r.height() < 16):
            self.crop = None  # a click, not a rectangle
        elif r is not None and r.width() >= self.image.width() - 1 and r.height() >= self.image.height() - 1:
            self.crop = None  # the whole picture
        self.update()
        self.cropChanged.emit()

    def paintEvent(self, _event):
        p = QPainter(self)
        p.fillRect(self.rect(), QColor(snake_theme.TITLE))
        if self.image.isNull():
            p.setPen(QColor(snake_theme.FG2))
            p.setFont(QFont(self.font().family(), 13))
            p.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, self.placeholder)
            return
        target = self._target()
        p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
        p.drawImage(target, self.image)
        if self.crop is None:
            if self.crop_mode:
                p.setPen(QColor(snake_theme.FG))
                p.drawText(target.adjusted(0, 0, 0, -10), Qt.AlignmentFlag.AlignHCenter | Qt.AlignmentFlag.AlignBottom,
                           "Drag a rectangle around the part to keep")
            return
        r = self._to_screen(self.crop)
        shade = QColor(snake_theme.TITLE)
        shade.setAlpha(170)
        outside = QPainterPath()
        outside.addRect(target)
        inside = QPainterPath()
        inside.addRect(r)
        p.fillPath(outside.subtracted(inside), shade)
        p.setPen(QPen(QColor(snake_theme.HIGHLIGHT), 1.5))
        p.drawRect(r)
        if self.crop_mode:
            p.setBrush(QColor(snake_theme.HIGHLIGHT))
            for c in (r.topLeft(), r.topRight(), r.bottomRight(), r.bottomLeft()):
                p.drawRect(QRectF(c.x() - 4, c.y() - 4, 8, 8))


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
    closed = pyqtSignal(bool)  # True when the person closed it
    trimmed = pyqtSignal(str)  # a trimmed copy was saved there
    trimStarted = pyqtSignal()

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
        close.clicked.connect(lambda: self.close_preview(user=True))
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
        self.trim_row = QWidget()
        trim = QHBoxLayout(self.trim_row)
        trim.setContentsMargins(0, 0, 0, 0)
        self.in_btn = QPushButton("⟦ Start here", objectName="small")
        self.in_btn.setToolTip("Keep from the current position (I)")
        self.in_btn.clicked.connect(self.mark_in)
        self.out_btn = QPushButton("End here ⟧", objectName="small")
        self.out_btn.setToolTip("Keep up to the current position (O)")
        self.out_btn.clicked.connect(self.mark_out)
        self.crop_btn = QPushButton("⬚ Crop", objectName="small", checkable=True)
        self.crop_btn.setToolTip("Keep only part of the picture: drag a rectangle on it (C)")
        self.crop_btn.toggled.connect(self._crop_toggled)
        self.reset_btn = QPushButton("Reset", objectName="small")
        self.reset_btn.setToolTip("Keep the whole recording")
        self.reset_btn.clicked.connect(self.reset_trim)
        self.save_trim_btn = QPushButton("Save copy", objectName="small")
        self.save_trim_btn.setToolTip("Save the trimmed and cropped recording as a new file next to this one; the original is kept")
        self.save_trim_btn.clicked.connect(self.save_trimmed)
        trim.addWidget(self.in_btn)
        trim.addWidget(self.out_btn)
        trim.addWidget(self.crop_btn)
        trim.addWidget(self.reset_btn)
        trim.addStretch(1)
        trim.addWidget(self.save_trim_btn)
        layout.addWidget(self.trim_row)
        self.trim_label = QLabel(objectName="hint")
        layout.addWidget(self.trim_label)
        self._trim_timer = QTimer(self, interval=250, timeout=self._poll_trim)
        self.canvas.cropChanged.connect(self._update_trim)
        for key, slot in (("I", self.mark_in), ("O", self.mark_out), ("C", self.crop_btn.toggle)):
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

    def close_preview(self, user=True):
        if not self.isVisible() and self.path is None:
            return
        self._unload()
        self.path = None
        self.hide()
        self.closed.emit(user)

    def trimming(self):
        return self._trim_proc is not None

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

    def _croppable(self):
        """MP4 and GIF can be cropped once a frame has been seen; MP3 has no picture."""
        if not self.path or not Path(self.path).exists() or Path(self.path).suffix.lower() == ".mp3":
            return False
        return bool(self._frame_size) and not self._frame_size.isEmpty()

    def _gif(self):
        return self._movie is not None

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
        self.canvas.crop = None
        self.crop_btn.setChecked(False)
        self.canvas.update()
        self._update_trim()

    def _crop_toggled(self, on):
        if on and not self._croppable():
            self.crop_btn.setChecked(False)
            return
        if on:
            self.pause()  # a still picture is easier to draw on
        self.canvas.set_crop_mode(on)
        self._update_trim()

    def crop_rect(self):
        """The crop as even (x, y, w, h) in the recording's pixels, or None."""
        r, size = self.canvas.crop, self._frame_size
        if r is None or not size or size.isEmpty():
            return None
        x = max(int(r.left()) // 2 * 2, 0)
        y = max(int(r.top()) // 2 * 2, 0)
        w = min(int(r.right()) - x, size.width() - x) // 2 * 2
        h = min(int(r.bottom()) - y, size.height() - y) // 2 * 2
        if w < 16 or h < 16 or (w >= size.width() - 1 and h >= size.height() - 1):
            return None
        return x, y, w, h

    def _update_trim(self):
        self.slider.trim_in, self.slider.trim_out = self.trim_in, self.trim_out
        self.slider.update()
        busy = self._trim_proc is not None
        gif = self._gif()
        mp3 = bool(self.path) and Path(self.path).suffix.lower() == ".mp3"
        trimmable, croppable = self._trimmable() and not busy, self._croppable() and not busy
        for b in (self.in_btn, self.out_btn):
            b.setEnabled(trimmable)
            b.setVisible(not gif)
        self.crop_btn.setEnabled(croppable)
        self.crop_btn.setVisible(not mp3)
        trimmed = self.trim_in is not None or self.trim_out is not None
        crop = self.crop_rect()
        marked = trimmed or crop is not None
        self.reset_btn.setEnabled(marked and not busy)
        self.save_trim_btn.setEnabled(marked and not busy and (trimmable or croppable))
        self.trim_row.setVisible(bool(self.path))
        self.trim_label.setVisible(bool(self.path))
        if busy:
            return
        parts = []
        if trimmed:
            start = self.trim_in or 0
            end = self.trim_out if self.trim_out is not None else self.player.duration()
            parts.append(f"Keeps {_exact(start)} to {_exact(end)} ({_exact(end - start)} of {_clock(self.player.duration())})")
        if crop is not None:
            parts.append(f"Crop to {crop[2]} × {crop[3]}")
        if parts:
            self.trim_label.setText("  ·  ".join(parts))
        elif self.crop_btn.isChecked():
            self.trim_label.setText("Drag a rectangle on the picture: inside it moves it, a corner resizes it.")
        elif gif:
            self.trim_label.setText("To crop, press Crop and drag a rectangle on the picture.")
        elif mp3:
            self.trim_label.setText("To trim, play to a spot and press Start here or End here.")
        else:
            self.trim_label.setText("To trim, play to a spot and press Start here or End here. To crop, press Crop.")

    def _trim_target(self):
        src = Path(self.path)
        trimmed = self.trim_in is not None or self.trim_out is not None
        cropped = self.crop_rect() is not None
        word = "edited" if trimmed and cropped else "cropped" if cropped else "trimmed"
        for n in range(1, 1000):
            out = src.with_name(f"{src.stem} ({word}{'' if n == 1 else f' {n}'}){src.suffix}")
            if not out.exists():
                return out
        raise OSError("too many edited copies")

    def save_trimmed(self):
        """Save the trimmed and/or cropped copy next to the original."""
        if self._trim_proc is not None or not (self._trimmable() or self._croppable()):
            return
        tool = ffmpeg()
        if not tool:
            self.trim_label.setText("Saving a copy needs ffmpeg, which was not found.")
            return
        crop = self.crop_rect()
        crop_filter = f"crop={crop[2]}:{crop[3]}:{crop[0]}:{crop[1]}" if crop else None
        out = self._trim_target()
        cmd = [tool, "-hide_banner", "-nostdin", "-y"]
        if self._gif():
            if not crop_filter:
                return
            cmd += ["-i", self.path, "-vf",
                    f"{crop_filter},split[a][b];[a]palettegen=stats_mode=diff[p];"
                    "[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle", "-loop", "0"]
            frames, delay = self._movie.frameCount(), self._movie.nextFrameDelay()
            length = frames * delay / 1000 if frames > 0 and delay > 0 else 1.0
        else:
            start = (self.trim_in or 0) / 1000
            end = (self.trim_out if self.trim_out is not None else self.player.duration()) / 1000
            length = end - start
            if start > 0:
                cmd += ["-ss", f"{start:.3f}"]
            cmd += ["-i", self.path, "-t", f"{length:.3f}", "-map", "0"]
            if out.suffix.lower() == ".mp3" or (start == 0 and not crop_filter):
                # MP3 cuts cleanly anywhere, and so does any video at its end: copy, losing nothing.
                cmd += ["-c", "copy"]
            else:
                # A video cut at its start, or cropped, must be encoded again.
                if crop_filter:
                    cmd += ["-vf", crop_filter]
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
        self._trim_out, self._trim_length = out, max(length, 0.001)
        self.crop_btn.setChecked(False)
        self.trim_label.setText("Saving…")
        self.trimStarted.emit()
        self._update_trim()
        self._trim_timer.start()

    def _poll_trim(self):
        proc = self._trim_proc
        if proc.poll() is None:
            try:
                lines = self._trim_progress.read_text(encoding="utf-8", errors="replace").splitlines()
                done = [int(x.split("=", 1)[1]) for x in lines if x.startswith("out_time_us=") and x[12:].strip().isdigit()]
                if done:
                    self.trim_label.setText(f"Saving… {min(99, done[-1] / 1e4 / self._trim_length):.0f}%")
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
            self.trim_label.setText("Saving failed" + (f": {tail[0]}" if tail else "."))

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
                self._update_trim()
            self.canvas.set_image(image)

    def _on_gif_frame(self, _number):
        image = self._movie.currentImage()
        if self._frame_size != image.size():
            self._frame_size = image.size()
            self._update_info()
            self._update_trim()
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
