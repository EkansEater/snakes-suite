"""Preview panel: plays the selected MP4, GIF or MP3 inside the main window."""

from pathlib import Path

from PyQt6.QtCore import QRectF, QSize, Qt, QUrl, pyqtSignal
from PyQt6.QtGui import QColor, QFont, QImage, QMovie, QPainter
from PyQt6.QtMultimedia import QAudioOutput, QMediaPlayer, QVideoSink
from . import snake_theme
from PyQt6.QtWidgets import QHBoxLayout, QLabel, QPushButton, QSlider, QVBoxLayout, QWidget

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


class PreviewPanel(QWidget):
    closed = pyqtSignal()

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
        self.slider = QSlider(Qt.Orientation.Horizontal)
        self.slider.sliderPressed.connect(lambda: setattr(self, "_seeking", True))
        self.slider.sliderReleased.connect(self._seek_released)
        self.slider.sliderMoved.connect(self._seek_to)
        self.time_label = QLabel("0:00 / 0:00")
        controls.addWidget(self.play_btn)
        controls.addWidget(self.slider, 1)
        controls.addWidget(self.time_label)
        layout.addLayout(controls)
        self.info = QLabel(objectName="hint", wordWrap=True)
        layout.addWidget(self.info)
        self._update_play_button()

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


def _size(n):
    for unit in ("bytes", "KB", "MB"):
        if n < 1024:
            return f"{n:.0f} {unit}" if unit == "bytes" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} GB"
