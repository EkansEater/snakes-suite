"""Snake's MP3 Converter: drag a video link in, get an MP3 out."""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

import yt_dlp
from PySide6.QtCore import QMimeData, QPoint, QRectF, QSettings, QSize, Qt, QTimer, QUrl, Signal
from PySide6.QtGui import (
    QAction, QBrush, QColor, QDesktopServices, QDrag, QFont, QFontMetrics, QIcon, QKeySequence,
    QPainter, QPainterPath, QPen, QPixmap, QShortcut,
)
from PySide6.QtNetwork import QNetworkAccessManager, QNetworkReply, QNetworkRequest
from PySide6.QtWidgets import (
    QApplication, QCheckBox, QComboBox, QDialog, QDialogButtonBox, QFileDialog, QFormLayout, QFrame,
    QHBoxLayout, QLabel, QLineEdit, QMainWindow, QMessageBox, QProgressBar, QPushButton, QScrollArea,
    QSizePolicy, QSpinBox, QSystemTrayIcon, QVBoxLayout, QWidget,
)

from . import APP_NAME, snake_theme
from .downloader import NAME_TEMPLATES, QUALITIES, DownloadJob, JobOptions, human_bytes, human_time

HERE = Path(__file__).resolve().parent
ICON_PATH = HERE / "assets" / "icon.svg"
# Before the rename the app was "Snake's Sounds"; keep saving there if that folder exists.
_OLD_DIR = Path.home() / "Music" / "Snake's Sounds"
DEFAULT_DIR = str(_OLD_DIR if _OLD_DIR.is_dir() else Path.home() / "Music" / APP_NAME)
URL_RE = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)
BROWSERS = ["", "firefox", "chrome", "chromium", "brave", "edge", "vivaldi", "opera", "librewolf", "zen"]

def extract_urls(mime: QMimeData) -> list[str]:
    found: list[str] = []
    if mime.hasUrls():
        found += [u.toString() for u in mime.urls() if u.scheme() in ("http", "https")]
    if mime.hasText():
        found += URL_RE.findall(mime.text())
    return list(dict.fromkeys(u.rstrip(").,;") for u in found))


repolish = snake_theme.repolish


# --------------------------------------------------------------------------- widgets
class ElidedLabel(QLabel):
    """Single-line label that elides with … instead of stretching the layout."""

    def __init__(self, text="", parent=None):
        super().__init__(text, parent)
        self.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Preferred)
        self.setMinimumWidth(40)

    def paintEvent(self, _):
        p = QPainter(self)
        p.setPen(self.palette().color(self.foregroundRole()))
        fm = QFontMetrics(self.font())
        p.setFont(self.font())
        p.drawText(self.rect(), Qt.AlignLeft | Qt.AlignVCenter, fm.elidedText(self.text(), Qt.ElideRight, self.width()))


class DropZone(QFrame):
    clicked = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.active = False
        self.setMinimumHeight(170)
        self.setCursor(Qt.PointingHandCursor)
        self.setToolTip("Drop a link here, or click to paste one from the clipboard")

    def set_active(self, on: bool):
        self.active = on
        self.update()

    def mouseReleaseEvent(self, e):
        if e.button() == Qt.LeftButton:
            self.clicked.emit()

    def paintEvent(self, _):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        r = QRectF(self.rect()).adjusted(2, 2, -2, -2)
        accent = QColor(snake_theme.ACCENT)
        fill = QColor(accent)
        fill.setAlpha(34 if self.active else 0)
        pen = QPen(accent if self.active else QColor(snake_theme.BORDER2), 2, Qt.DashLine)
        pen.setDashPattern([6, 5])
        p.setPen(pen)
        p.setBrush(fill)
        p.drawRoundedRect(r, 16, 16)

        # simple waveform glyph
        cx, cy = r.center().x(), r.top() + 58
        p.setPen(Qt.NoPen)
        p.setBrush(accent if self.active else QColor(snake_theme.FG3))
        for i, h in enumerate([14, 26, 40, 30, 46, 30, 40, 26, 14]):
            x = cx - 4 * 11 + i * 11
            p.drawRoundedRect(QRectF(x - 3, cy - h / 2, 6, h), 3, 3)

        p.setPen(QColor(snake_theme.FG))
        f = QFont(self.font())
        f.setPointSizeF(14)
        f.setBold(True)
        p.setFont(f)
        title = "Release to convert!" if self.active else "Drag a video link here"
        p.drawText(QRectF(r.left(), cy + 32, r.width(), 28), Qt.AlignCenter, title)
        f.setPointSizeF(10)
        f.setBold(False)
        p.setFont(f)
        p.setPen(QColor(snake_theme.FG2))
        p.drawText(QRectF(r.left(), cy + 60, r.width(), 22), Qt.AlignCenter,
                   "YouTube, SoundCloud, Bandcamp, Vimeo, TikTok… and 1000+ more sites  ·  Ctrl+V to paste")


class JobWidget(QFrame):
    THUMB = QSize(128, 72)
    changed = Signal()

    def __init__(self, url: str, window: "MainWindow"):
        super().__init__()
        self.url = url
        self.win = window
        self.state = "queued"
        self.worker: DownloadJob | None = None
        self.files: list[str] = []
        self._drag_start: QPoint | None = None
        self.setObjectName("card")

        self.thumb = QLabel()
        self.thumb.setFixedSize(self.THUMB)
        self.thumb.setPixmap(self._placeholder())

        self.title = ElidedLabel(url)
        f = self.title.font()
        f.setBold(True)
        self.title.setFont(f)
        self.subtitle = ElidedLabel("")
        self.subtitle.setObjectName("muted")
        self.bar = QProgressBar()
        self.bar.setTextVisible(False)
        self.bar.setRange(0, 1000)
        self.status = ElidedLabel("Waiting in queue…")
        self.status.setObjectName("status")

        mid = QVBoxLayout()
        mid.setSpacing(4)
        mid.addWidget(self.title)
        mid.addWidget(self.subtitle)
        mid.addStretch()
        mid.addWidget(self.bar)
        mid.addWidget(self.status)

        self.btn_play = self._button("▶ Play", self.open_file)
        self.btn_folder = self._button("Show", self.show_in_folder)
        self.btn_retry = self._button("↻ Retry", self.retry)
        self.btn_cancel = self._button("Cancel", self.cancel, danger=True)
        self.btn_remove = self._button("✕", self.remove, danger=True)
        self.btn_remove.setToolTip("Remove from list")
        self.btn_play.setToolTip("Open with your default music player")
        self.btn_folder.setToolTip("Show the file in your file manager")

        btns = QHBoxLayout()
        btns.setSpacing(6)
        for b in (self.btn_play, self.btn_folder, self.btn_retry, self.btn_cancel, self.btn_remove):
            btns.addWidget(b)

        right = QVBoxLayout()
        right.addLayout(btns)
        right.addStretch()

        lay = QHBoxLayout(self)
        lay.setContentsMargins(12, 12, 12, 12)
        lay.setSpacing(14)
        lay.addWidget(self.thumb)
        lay.addLayout(mid, 1)
        lay.addLayout(right)
        self.setFixedHeight(self.THUMB.height() + 26)
        self._sync_buttons()

    def _button(self, text, slot, danger=False):
        b = QPushButton(text)
        b.setObjectName("smallDanger" if danger else "small")
        b.setCursor(Qt.PointingHandCursor)
        b.clicked.connect(slot)
        return b

    def _placeholder(self) -> QPixmap:
        pm = QPixmap(self.THUMB)
        pm.fill(Qt.transparent)
        p = QPainter(pm)
        p.setRenderHint(QPainter.Antialiasing)
        p.setPen(Qt.NoPen)
        p.setBrush(QColor(snake_theme.BUTTON2))
        p.drawRoundedRect(QRectF(pm.rect()), 8, 8)
        p.setPen(QColor(snake_theme.FG3))
        f = QFont()
        f.setPointSize(24)
        p.setFont(f)
        p.drawText(pm.rect(), Qt.AlignCenter, "♪")
        p.end()
        return pm

    # ---------------------------------------------------------------- state
    def set_state(self, state: str, text: str | None = None):
        self.state = state
        self.setProperty("state", state)
        self.status.setProperty("state", state)
        repolish(self)
        repolish(self.status)
        if text is not None:
            self.status.setText(text)
            self.status.setToolTip(text)
        self._sync_buttons()
        self.changed.emit()

    def _sync_buttons(self):
        active = self.state in ("queued", "running")
        self.btn_cancel.setVisible(active)
        self.btn_remove.setVisible(not active)
        self.btn_retry.setVisible(self.state in ("failed", "cancelled"))
        self.btn_play.setVisible(self.state == "done")
        self.btn_folder.setVisible(self.state == "done")
        self.bar.setVisible(self.state in ("queued", "running"))
        self.setCursor(Qt.OpenHandCursor if self.state == "done" else Qt.ArrowCursor)
        if self.state == "done":
            self.setToolTip("Drag this card into another app to drop the MP3 file there")
        else:
            self.setToolTip("")

    def start(self, options: JobOptions):
        self.worker = DownloadJob(self.url, options, self)
        self.worker.meta.connect(self._on_meta)
        self.worker.progress.connect(self._on_progress)
        self.worker.stage.connect(self._on_stage)
        self.worker.succeeded.connect(self._on_success)
        self.worker.failed.connect(lambda msg: self.set_state("failed", f"Failed: {msg}"))
        self.worker.cancelled.connect(lambda: self.set_state("cancelled", "Cancelled"))
        self.worker.finished.connect(self._on_thread_finished)
        self.bar.setRange(0, 0)
        self.set_state("running", "Starting…")
        self.worker.start()

    def is_busy(self) -> bool:
        return self.worker is not None and self.worker.isRunning()

    # ---------------------------------------------------------------- worker slots
    def _on_meta(self, m: dict):
        self.title.setText(m["title"])
        self.title.setToolTip(f"{m['title']}\n{self.url}")
        bits = [m["uploader"], human_time(m["duration"])]
        if m["count"] > 1:
            bits.insert(0, f"Track {m['index']} of {m['count']}" + (f" · {m['playlist']}" if m["playlist"] else ""))
        self.subtitle.setText("  ·  ".join(b for b in bits if b))
        if m["thumbnail"]:
            self.win.load_thumbnail(self, m["thumbnail"])

    def _on_progress(self, pct: float, detail: str):
        if pct < 0:
            self.bar.setRange(0, 0)
        else:
            self.bar.setRange(0, 1000)
            self.bar.setValue(int(pct * 10))
        if detail:
            self.status.setText(f"Downloading  ·  {detail}")

    def _on_stage(self, text: str):
        self.status.setText(text)
        if text != "Downloading…":
            self.bar.setRange(0, 0)  # busy indicator while ffmpeg works

    def _on_success(self, files: list):
        self.files = files
        size = sum(os.path.getsize(f) for f in files if os.path.exists(f))
        if len(files) == 1:
            text = f"Saved  ·  {Path(files[0]).name}  ·  {human_bytes(size)}"
        else:
            text = f"Saved {len(files)} tracks  ·  {human_bytes(size)}"
        self.btn_play.setText("▶ Play" if len(files) == 1 else "▶ Play all")
        self.set_state("done", text)

    def _on_thread_finished(self):
        if self.worker:
            self.worker.deleteLater()
            self.worker = None
        self.win.schedule()

    def set_thumbnail(self, pm: QPixmap):
        target = self.THUMB
        scaled = pm.scaled(target, Qt.KeepAspectRatioByExpanding, Qt.SmoothTransformation)
        x = (scaled.width() - target.width()) // 2
        y = (scaled.height() - target.height()) // 2
        out = QPixmap(target)
        out.fill(Qt.transparent)
        p = QPainter(out)
        p.setRenderHint(QPainter.Antialiasing)
        path = QPainterPath()
        path.addRoundedRect(QRectF(out.rect()), 8, 8)
        p.setClipPath(path)
        p.drawPixmap(0, 0, scaled, x, y, target.width(), target.height())
        p.end()
        self.thumb.setPixmap(out)

    # ---------------------------------------------------------------- actions
    def cancel(self):
        if self.state == "queued":
            self.set_state("cancelled", "Cancelled")
        elif self.worker:
            self.status.setText("Cancelling…")
            self.btn_cancel.setEnabled(False)
            self.worker.cancel()

    def retry(self):
        self.btn_cancel.setEnabled(True)
        self.bar.setRange(0, 1000)
        self.bar.setValue(0)
        self.set_state("queued", "Waiting in queue…")
        self.win.schedule()

    def remove(self):
        self.win.remove_job(self)

    def open_file(self):
        if len(self.files) == 1:
            QDesktopServices.openUrl(QUrl.fromLocalFile(self.files[0]))
        elif self.files:
            # hand the whole set to the default player as an m3u playlist
            folder = Path(self.files[0]).parent
            m3u = folder / "playlist.m3u"
            try:
                m3u.write_text("\n".join(os.path.relpath(f, folder) for f in self.files) + "\n", encoding="utf-8")
                QDesktopServices.openUrl(QUrl.fromLocalFile(str(m3u)))
            except OSError:
                QDesktopServices.openUrl(QUrl.fromLocalFile(str(folder)))

    def show_in_folder(self):
        if self.files:
            reveal_in_file_manager(self.files[0])

    # ---------------------------------------------------------------- drag-out
    def mousePressEvent(self, e):
        if e.button() == Qt.LeftButton and self.state == "done":
            self._drag_start = e.position().toPoint()
        super().mousePressEvent(e)

    def mouseMoveEvent(self, e):
        if (self._drag_start is not None and self.files and
                (e.position().toPoint() - self._drag_start).manhattanLength() >= QApplication.startDragDistance()):
            mime = QMimeData()
            mime.setUrls([QUrl.fromLocalFile(f) for f in self.files if os.path.exists(f)])
            drag = QDrag(self)
            drag.setMimeData(mime)
            drag.setPixmap(self.thumb.pixmap().scaled(96, 54, Qt.KeepAspectRatio, Qt.SmoothTransformation))
            self.win.dragging_out = True
            drag.exec(Qt.CopyAction)
            self.win.dragging_out = False
            self._drag_start = None
        super().mouseMoveEvent(e)

    def mouseDoubleClickEvent(self, e):
        if self.state == "done":
            self.open_file()


def reveal_in_file_manager(path: str):
    """Highlight the file in the file manager, falling back to opening its folder."""
    try:
        from PySide6.QtDBus import QDBusConnection, QDBusInterface
        iface = QDBusInterface("org.freedesktop.FileManager1", "/org/freedesktop/FileManager1",
                               "org.freedesktop.FileManager1", QDBusConnection.sessionBus())
        if iface.isValid():
            reply = iface.call("ShowItems", [QUrl.fromLocalFile(path).toString()], "")
            if not reply.errorName():
                return
    except Exception:  # noqa: BLE001
        pass
    QDesktopServices.openUrl(QUrl.fromLocalFile(str(Path(path).parent)))


# --------------------------------------------------------------------------- settings
class SettingsDialog(QDialog):
    def __init__(self, settings: QSettings, parent=None):
        super().__init__(parent)
        self.s = settings
        self.setWindowTitle("Settings")
        self.setMinimumWidth(460)

        self.concurrency = QSpinBox()
        self.concurrency.setRange(1, 6)
        self.concurrency.setValue(int(settings.value("concurrency", 2)))

        self.template = QComboBox()
        self.template.addItems(NAME_TEMPLATES.keys())
        self.template.setCurrentText(settings.value("template", "Title"))

        def check(key, label, default=True):
            c = QCheckBox(label)
            c.setChecked(settings.value(key, default, type=bool))
            return c

        self.subfolder = check("playlist_subfolder", "Put playlists in their own subfolder")
        self.thumb = check("embed_thumbnail", "Embed the video thumbnail as album art")
        self.meta = check("embed_metadata", "Write title / artist / date tags")
        self.skip = check("skip_existing", "Skip files that already exist")
        self.notify = check("notify", "Desktop notification when the queue finishes")

        self.cookies = QComboBox()
        for b in BROWSERS:
            self.cookies.addItem(b.capitalize() if b else "Don't use cookies", b)
        self.cookies.setCurrentIndex(max(0, self.cookies.findData(settings.value("cookies", ""))))
        self.cookies.setToolTip("Borrow your browser's login cookies — needed for age-restricted or members-only videos")

        form = QFormLayout()
        form.setSpacing(10)
        form.addRow("Simultaneous downloads", self.concurrency)
        form.addRow("File names", self.template)
        form.addRow("Cookies from browser", self.cookies)
        for c in (self.subfolder, self.thumb, self.meta, self.skip, self.notify):
            form.addRow("", c)

        about = QLabel(f"yt-dlp {yt_dlp.version.__version__}  ·  ffmpeg handles the MP3 encoding")
        about.setObjectName("muted")

        buttons = QDialogButtonBox(QDialogButtonBox.Save | QDialogButtonBox.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)

        lay = QVBoxLayout(self)
        lay.addLayout(form)
        lay.addSpacing(8)
        lay.addWidget(about)
        lay.addWidget(buttons)

    def accept(self):
        s = self.s
        s.setValue("concurrency", self.concurrency.value())
        s.setValue("template", self.template.currentText())
        s.setValue("cookies", self.cookies.currentData())
        s.setValue("playlist_subfolder", self.subfolder.isChecked())
        s.setValue("embed_thumbnail", self.thumb.isChecked())
        s.setValue("embed_metadata", self.meta.isChecked())
        s.setValue("skip_existing", self.skip.isChecked())
        s.setValue("notify", self.notify.isChecked())
        super().accept()


# --------------------------------------------------------------------------- main window
class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.settings = QSettings("SnakesSounds", "SnakesSounds")
        self.jobs: list[JobWidget] = []
        self.dragging_out = False
        self.nam = QNetworkAccessManager(self)
        self.tray: QSystemTrayIcon | None = None
        self._had_work = False

        self.setWindowTitle(APP_NAME)
        self.setWindowIcon(QIcon(str(ICON_PATH)))
        self.setAcceptDrops(True)
        self.resize(self.settings.value("size", QSize(860, 720)))

        root = QWidget(objectName="root")
        self.setCentralWidget(root)
        self.header = snake_theme.HeaderBar(APP_NAME, "Drop a link. Get an MP3.", ICON_PATH)
        self.setMenuWidget(self.header)
        lay = QVBoxLayout(root)
        lay.setContentsMargins(16, 14, 16, 10)
        lay.setSpacing(12)

        settings_btn = self.header.add_action("⚙  Settings", self.open_settings)
        settings_btn.setToolTip("Downloads, file names, tags and cookies")

        # drop zone
        self.drop = DropZone()
        self.drop.clicked.connect(self.paste_from_clipboard)
        lay.addWidget(self.drop)

        # manual entry
        self.url_edit = QLineEdit()
        self.url_edit.setPlaceholderText("…or paste a link here and press Enter")
        self.url_edit.setAcceptDrops(False)
        self.url_edit.setClearButtonEnabled(True)
        self.url_edit.returnPressed.connect(self.add_from_field)
        convert = QPushButton("Convert to MP3")
        convert.setObjectName("primary")
        convert.setCursor(Qt.PointingHandCursor)
        convert.clicked.connect(self.add_from_field)
        row = QHBoxLayout()
        row.addWidget(self.url_edit, 1)
        row.addWidget(convert)
        lay.addLayout(row)

        # options
        self.quality = QComboBox()
        self.quality.addItems(QUALITIES.keys())
        self.quality.setCurrentText(self.settings.value("quality", "320 kbps (best)"))
        self.quality.currentTextChanged.connect(lambda v: self.settings.setValue("quality", v))
        self.playlist = QCheckBox("Whole playlist")
        self.playlist.setToolTip("If the link is part of a playlist, convert every track in it")
        self.playlist.setChecked(self.settings.value("whole_playlist", False, type=bool))
        self.playlist.toggled.connect(lambda v: self.settings.setValue("whole_playlist", v))
        self.folder_btn = QPushButton()
        self.folder_btn.setToolTip("Choose where MP3s are saved")
        self.folder_btn.clicked.connect(self.choose_folder)
        open_folder = QPushButton("Open folder")
        open_folder.clicked.connect(self.open_output_folder)
        opts = QHBoxLayout()
        q_label = QLabel("Quality")
        q_label.setObjectName("muted")
        opts.addWidget(q_label)
        opts.addWidget(self.quality)
        opts.addSpacing(10)
        opts.addWidget(self.playlist)
        opts.addStretch()
        save_label = QLabel("Save to")
        save_label.setObjectName("muted")
        opts.addWidget(save_label)
        opts.addWidget(self.folder_btn)
        opts.addWidget(open_folder)
        lay.addLayout(opts)
        self._update_folder_btn()

        # queue
        self.list_host = QWidget()
        self.list_lay = QVBoxLayout(self.list_host)
        self.list_lay.setContentsMargins(0, 0, 4, 0)
        self.list_lay.setSpacing(10)
        self.empty = QLabel("Your converted tracks will show up here.")
        self.empty.setObjectName("muted")
        self.empty.setAlignment(Qt.AlignCenter)
        self.list_lay.addWidget(self.empty)
        self.list_lay.addStretch()
        self.scroll = QScrollArea()
        self.scroll.setWidgetResizable(True)
        self.scroll.setWidget(self.list_host)
        lay.addWidget(self.scroll, 1)

        # footer
        self.summary = QLabel()
        self.summary.setObjectName("muted")
        self.cancel_all_btn = QPushButton("Cancel all")
        self.cancel_all_btn.clicked.connect(self.cancel_all)
        clear = QPushButton("Clear finished")
        clear.clicked.connect(self.clear_finished)
        footer = QHBoxLayout()
        footer.addWidget(self.summary)
        footer.addStretch()
        footer.addWidget(self.cancel_all_btn)
        footer.addWidget(clear)
        lay.addLayout(footer)

        paste = QShortcut(QKeySequence.Paste, self)
        paste.setContext(Qt.WindowShortcut)
        paste.activated.connect(self._paste_shortcut)
        quit_action = QAction(self)
        quit_action.setShortcut(QKeySequence.Quit)
        quit_action.triggered.connect(self.close)
        self.addAction(quit_action)

        if QSystemTrayIcon.isSystemTrayAvailable():
            self.tray = QSystemTrayIcon(self.windowIcon(), self)
            self.tray.setToolTip(APP_NAME)
            self.tray.activated.connect(lambda *_: (self.showNormal(), self.raise_(), self.activateWindow()))

        self.update_summary()

    # ---------------------------------------------------------------- options
    def output_dir(self) -> str:
        return self.settings.value("output_dir", DEFAULT_DIR)

    def _update_folder_btn(self):
        path = self.output_dir()
        short = path.replace(str(Path.home()), "~", 1)
        fm = QFontMetrics(self.folder_btn.font())
        self.folder_btn.setText("📁 " + fm.elidedText(short, Qt.ElideMiddle, 220))
        self.folder_btn.setToolTip(f"Saving to {path}\nClick to change")

    def choose_folder(self):
        d = QFileDialog.getExistingDirectory(self, "Save MP3s to…", self.output_dir())
        if d:
            self.settings.setValue("output_dir", d)
            self._update_folder_btn()

    def open_output_folder(self):
        os.makedirs(self.output_dir(), exist_ok=True)
        QDesktopServices.openUrl(QUrl.fromLocalFile(self.output_dir()))

    def open_settings(self):
        if SettingsDialog(self.settings, self).exec():
            self.schedule()

    def job_options(self) -> JobOptions:
        s = self.settings
        return JobOptions(
            output_dir=self.output_dir(),
            quality=QUALITIES[self.quality.currentText()],
            name_template=NAME_TEMPLATES.get(s.value("template", "Title"), "%(title)s"),
            whole_playlist=self.playlist.isChecked(),
            playlist_subfolder=s.value("playlist_subfolder", True, type=bool),
            embed_thumbnail=s.value("embed_thumbnail", True, type=bool),
            embed_metadata=s.value("embed_metadata", True, type=bool),
            skip_existing=s.value("skip_existing", True, type=bool),
            cookies_browser=s.value("cookies", ""),
        )

    # ---------------------------------------------------------------- adding links
    def add_urls(self, urls: list[str]):
        added = 0
        active = {j.url for j in self.jobs if j.state in ("queued", "running")}
        for url in urls:
            if url in active:
                self.statusBar().showMessage("That link is already in the queue.", 3000)
                continue
            job = JobWidget(url, self)
            job.changed.connect(self.update_summary)
            self.jobs.append(job)
            self.list_lay.insertWidget(self.list_lay.count() - 1, job)
            active.add(url)
            added += 1
        if added:
            self.empty.hide()
            self._had_work = True
            self.schedule()
            QTimer.singleShot(50, lambda: self.scroll.verticalScrollBar().setValue(
                self.scroll.verticalScrollBar().maximum()))
        self.update_summary()
        return added

    def add_from_field(self):
        urls = URL_RE.findall(self.url_edit.text())
        if not urls:
            self.statusBar().showMessage("That doesn't look like a link (it should start with http:// or https://).", 4000)
            return
        if self.add_urls(urls):
            self.url_edit.clear()

    def paste_from_clipboard(self):
        mime = QApplication.clipboard().mimeData()
        urls = extract_urls(mime) if mime else []
        if urls:
            self.add_urls(urls)
        else:
            self.statusBar().showMessage("No link on the clipboard — copy a video URL first, or drag one in.", 4000)

    def _paste_shortcut(self):
        if self.url_edit.hasFocus():
            self.url_edit.paste()
        else:
            self.paste_from_clipboard()

    # ---------------------------------------------------------------- drag & drop in
    def dragEnterEvent(self, e):
        if not self.dragging_out and extract_urls(e.mimeData()):
            e.acceptProposedAction()
            self.drop.set_active(True)
        else:
            e.ignore()

    def dragMoveEvent(self, e):
        if self.drop.active:
            e.acceptProposedAction()

    def dragLeaveEvent(self, _):
        self.drop.set_active(False)

    def dropEvent(self, e):
        self.drop.set_active(False)
        urls = extract_urls(e.mimeData())
        if urls:
            e.acceptProposedAction()
            self.add_urls(urls)

    # ---------------------------------------------------------------- queue
    def schedule(self):
        limit = int(self.settings.value("concurrency", 2))
        running = sum(1 for j in self.jobs if j.state == "running" or j.is_busy())
        for job in self.jobs:
            if running >= limit:
                break
            if job.state == "queued" and not job.is_busy():
                job.start(self.job_options())
                running += 1
        self.update_summary()

    def update_summary(self):
        counts = {k: 0 for k in ("queued", "running", "done", "failed", "cancelled")}
        for j in self.jobs:
            counts[j.state] += 1
        parts = []
        if counts["running"]:
            parts.append(f"{counts['running']} converting")
        if counts["queued"]:
            parts.append(f"{counts['queued']} waiting")
        if counts["done"]:
            parts.append(f"{counts['done']} done")
        if counts["failed"]:
            parts.append(f"{counts['failed']} failed")
        self.summary.setText("  ·  ".join(parts) or "Ready")
        busy = counts["running"] + counts["queued"]
        self.cancel_all_btn.setVisible(busy > 1)
        self.setWindowTitle(f"{APP_NAME} — {busy} in progress" if busy else APP_NAME)
        if not busy and self._had_work and not any(j.is_busy() for j in self.jobs):
            self._had_work = False
            self._notify_finished(counts)

    def _notify_finished(self, counts):
        if not self.settings.value("notify", True, type=bool) or not (counts["done"] or counts["failed"]):
            return
        QApplication.alert(self)
        if self.tray and not self.isActiveWindow():
            msg = f"{counts['done']} MP3{'s' if counts['done'] != 1 else ''} ready"
            if counts["failed"]:
                msg += f", {counts['failed']} failed"
            self.tray.show()
            self.tray.showMessage(APP_NAME, msg, self.windowIcon(), 5000)
            QTimer.singleShot(8000, self.tray.hide)

    def remove_job(self, job: JobWidget):
        if job.is_busy():
            return
        self.jobs.remove(job)
        job.setParent(None)
        job.deleteLater()
        self.empty.setVisible(not self.jobs)
        self.update_summary()

    def clear_finished(self):
        for j in [j for j in self.jobs if j.state in ("done", "cancelled", "failed")]:
            self.remove_job(j)

    def cancel_all(self):
        for j in self.jobs:
            if j.state in ("queued", "running"):
                j.cancel()

    def load_thumbnail(self, job: JobWidget, url: str):
        req = QNetworkRequest(QUrl(url))
        req.setAttribute(QNetworkRequest.RedirectPolicyAttribute, QNetworkRequest.NoLessSafeRedirectPolicy)
        reply = self.nam.get(req)
        reply.setParent(job)  # if the card is removed first, the reply dies with it

        def done():
            if reply.error() == QNetworkReply.NoError:
                pm = QPixmap()
                if pm.loadFromData(reply.readAll()):
                    job.set_thumbnail(pm)
            reply.deleteLater()

        reply.finished.connect(done)

    # ---------------------------------------------------------------- shutdown
    def closeEvent(self, e):
        busy = [j for j in self.jobs if j.is_busy() or j.state == "queued"]
        if busy:
            answer = QMessageBox.question(
                self, "Quit?", f"{len(busy)} conversion(s) still in progress. Quit and cancel them?",
                QMessageBox.Yes | QMessageBox.No, QMessageBox.No)
            if answer != QMessageBox.Yes:
                e.ignore()
                return
        self.settings.setValue("size", self.size())
        self.settings.sync()
        stuck = False
        for j in self.jobs:
            if j.worker:
                j.worker.cancel()
        for j in self.jobs:
            if j.worker and not j.worker.wait(4000):
                stuck = True
        e.accept()
        if stuck:  # ffmpeg is mid-encode; don't let Qt abort on a live QThread
            os._exit(0)


def main():
    QApplication.setApplicationName(APP_NAME)
    QApplication.setDesktopFileName("snakes-mp3")
    app = QApplication(sys.argv)
    snake_theme.apply(app, icon_path=ICON_PATH)
    win = MainWindow()
    win.show()
    cli_urls = [u for a in sys.argv[1:] for u in URL_RE.findall(a)]
    if cli_urls:
        win.add_urls(cli_urls)
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
