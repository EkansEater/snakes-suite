"""Main window and tray icon."""

from pathlib import Path

from PyQt6.QtCore import QRect, QSettings, QStandardPaths, Qt, QTimer, QUrl
from PyQt6.QtGui import QAction, QDesktopServices, QGuiApplication, QIcon
from PyQt6.QtWidgets import (
    QApplication, QButtonGroup, QCheckBox, QComboBox, QFileDialog, QFormLayout,
    QGroupBox, QHBoxLayout, QLabel, QLineEdit, QListWidget, QListWidgetItem,
    QMenu, QMessageBox, QPushButton, QRadioButton, QSpinBox, QSystemTrayIcon,
    QVBoxLayout, QWidget,
)

from . import APP_ID, APP_NAME, audio, snake_theme
from .overlay import Hud, RegionPickerSession
from .platforms import KIND, SUPPORTS_WINDOW_CAPTURE, missing_tools
from .preview import PreviewPanel
from .recorder import Job, Recorder

ICON_PATH = Path(__file__).parent / "assets" / "icon.svg"
MODES = [("mp4", "Video (MP4)"), ("gif", "GIF"), ("mp3", "Audio (MP3)")]
DEFAULT_FPS = {"mp4": 30, "gif": 15}
MAX_RECENT = 30

def app_icon():
    icon = QIcon(str(ICON_PATH))
    return icon if not icon.isNull() else QIcon.fromTheme("media-record")


class MainWindow(QWidget):
    def __init__(self):
        super().__init__()
        self.settings = QSettings()
        self.recorder = Recorder(self)
        self.recorder.stateChanged.connect(self._on_state)
        self.recorder.prepared.connect(self._on_prepared)
        self.recorder.finished.connect(self._on_finished)
        self.recorder.failed.connect(self._on_failed)

        self.hud = None
        self._picker = None
        self._job_screen = None
        self._countdown_left = 0
        self._countdown = QTimer(self, interval=1000, timeout=self._countdown_tick)
        self._clock = QTimer(self, interval=250, timeout=self._update_clock)
        self._was_minimized = False
        self._quitting = False

        self.setWindowTitle(APP_NAME)
        self.setWindowIcon(app_icon())
        self.setObjectName("root")
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self._build()
        self._build_tray()
        self._load()
        self._on_state("idle")

    # -- construction -----------------------------------------------------
    def _build(self):
        column = QVBoxLayout(self)
        column.setContentsMargins(0, 0, 0, 0)
        column.setSpacing(0)
        self.header = snake_theme.HeaderBar(APP_NAME, "MP4  ·  GIF  ·  MP3", ICON_PATH)
        column.addWidget(self.header)
        # controls on the left, preview of the selected recording on the right
        self._body = outer = QHBoxLayout()
        outer.setContentsMargins(14, 10, 14, 12)
        column.addLayout(outer, 1)
        left = QWidget()
        left.setMinimumWidth(500)
        root = QVBoxLayout(left)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(8)
        outer.addWidget(left, 1)
        self.preview = PreviewPanel()
        self.preview.hide()
        self.preview.closed.connect(self._preview_closed)
        outer.addWidget(self.preview)

        # what to make
        row = QHBoxLayout()
        self.mode_group = QButtonGroup(self)
        for key, text in MODES:
            b = QPushButton(text, objectName="mode", checkable=True)
            b.setProperty("mode", key)
            self.mode_group.addButton(b)
            row.addWidget(b)
        self.mode_group.buttonClicked.connect(self._mode_changed)
        root.addLayout(row)

        # what to capture
        self.area_box = QGroupBox("Capture area")
        area = QVBoxLayout(self.area_box)
        radios = QHBoxLayout()
        self.src_screen = QRadioButton("Full screen")
        self.src_region = QRadioButton("Region")
        self.src_window = QRadioButton("Window")
        self.src_window.setVisible(SUPPORTS_WINDOW_CAPTURE)
        for r in (self.src_screen, self.src_region, self.src_window):
            radios.addWidget(r)
            r.toggled.connect(self._source_changed)
        radios.addStretch()
        area.addLayout(radios)
        region_row = QHBoxLayout()
        self.region_btn = QPushButton("Select region…")
        self.region_btn.clicked.connect(lambda: self.pick_region())
        self.region_label = QLabel(objectName="status")
        region_row.addWidget(self.region_btn)
        region_row.addWidget(self.region_label, 1)
        self.forget_btn = QPushButton("Ask which screen again")
        self.forget_btn.setToolTip("Forget the remembered screen/window choice so the "
                                   "system asks again on the next recording.")
        self.forget_btn.clicked.connect(self._forget_choice)
        self.forget_btn.setVisible(KIND == "portal")
        region_row.addWidget(self.forget_btn)
        area.addLayout(region_row)
        root.addWidget(self.area_box)

        # audio
        self.audio_box = QGroupBox("Audio")
        aform = QFormLayout(self.audio_box)
        self.sys_check = QCheckBox("System audio")
        self.sys_combo = QComboBox()
        self.mic_check = QCheckBox("Microphone")
        self.mic_combo = QComboBox()
        for check in (self.sys_check, self.mic_check):
            check.setMinimumWidth(check.sizeHint().width())  # QFormLayout clips styled check boxes otherwise
        aform.addRow(self.sys_check, self.sys_combo)
        aform.addRow(self.mic_check, self.mic_combo)
        self.sys_check.toggled.connect(self.sys_combo.setEnabled)
        self.mic_check.toggled.connect(self.mic_combo.setEnabled)
        root.addWidget(self.audio_box)

        # options
        box = QGroupBox("Options")
        self.form = form = QFormLayout(box)
        self.fps_combo = QComboBox()
        for fps in (10, 15, 24, 30, 60):
            self.fps_combo.addItem(f"{fps} fps", fps)
        self.quality_combo = QComboBox()
        for key in ("high", "medium", "low"):
            self.quality_combo.addItem(key.capitalize(), key)
        self.gif_combo = QComboBox()
        self.gif_combo.addItem("Original size", 0)
        for w in (1280, 960, 720, 480, 320):
            self.gif_combo.addItem(f"Max {w} px wide", w)
        self.countdown_spin = QSpinBox(minimum=0, maximum=30, suffix=" s")
        self.cursor_check = QCheckBox("Show mouse cursor")
        self.minimize_check = QCheckBox("Minimize this window while recording")
        self.border_check = QCheckBox("Always show a green outline around the selected region")
        self.border_check.setToolTip("Stays on top of every window, before and during recording. "
                                     "It never appears in the video.")
        self.border_check.toggled.connect(lambda _on: self._sync_hud())
        form.addRow("Frame rate", self.fps_combo)
        form.addRow("Quality", self.quality_combo)
        form.addRow("GIF size", self.gif_combo)
        form.addRow("Countdown", self.countdown_spin)
        form.addRow(self.cursor_check)
        form.addRow(self.minimize_check)
        form.addRow(self.border_check)
        out_row = QHBoxLayout()
        self.out_edit = QLineEdit()
        browse = QPushButton("Browse…")
        browse.clicked.connect(self._browse)
        out_row.addWidget(self.out_edit, 1)
        out_row.addWidget(browse)
        form.addRow("Save to", out_row)
        root.addWidget(box)

        # controls
        controls = QHBoxLayout()
        self.record_btn = QPushButton(objectName="record")
        self.record_btn.clicked.connect(self.toggle_recording)
        self.pause_btn = QPushButton("Pause")
        self.pause_btn.clicked.connect(self.recorder.toggle_pause)
        self.timer_label = QLabel("00:00", objectName="timer")
        controls.addWidget(self.record_btn, 1)
        controls.addWidget(self.pause_btn)
        controls.addSpacing(8)
        controls.addWidget(self.timer_label)
        root.addLayout(controls)
        self.status = QLabel(objectName="status", wordWrap=True)
        self.status.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        root.addWidget(self.status)

        # recordings
        rec_box = QGroupBox("Recordings")
        rec = QVBoxLayout(rec_box)
        self.recent = QListWidget()
        self.recent.setMinimumHeight(90)
        self.recent.itemDoubleClicked.connect(lambda _i: self._open_selected())
        self.recent.currentItemChanged.connect(lambda *_: self._show_preview())
        self.recent.itemClicked.connect(lambda _i: self._show_preview())
        rec.addWidget(self.recent)
        buttons = QHBoxLayout()
        for text, slot in (("Open", self._open_selected), ("Show in folder", self._open_folder),
                           ("Copy path", self._copy_path), ("Remove from list", self._remove_selected)):
            b = QPushButton(text, objectName="small")
            b.clicked.connect(slot)
            buttons.addWidget(b)
        buttons.addStretch(1)
        self.preview_btn = QPushButton("Show preview", objectName="small")
        self.preview_btn.clicked.connect(self._toggle_preview)
        buttons.addWidget(self.preview_btn)
        rec.addLayout(buttons)
        root.addWidget(rec_box, 1)

        hint = QLabel("Tip: bind a keyboard shortcut to the command  "
                      "<b>snakescreen --toggle</b>  to start/stop from anywhere.",
                      objectName="hint", wordWrap=True)
        root.addWidget(hint)
        self.resize(600, 800)

    def _build_tray(self):
        self.tray = QSystemTrayIcon(app_icon(), self)
        menu = QMenu()
        self.tray_record = QAction("Start recording", self, triggered=self.toggle_recording)
        self.tray_pause = QAction("Pause", self, triggered=self.recorder.toggle_pause)
        menu.addAction(self.tray_record)
        menu.addAction(self.tray_pause)
        menu.addSeparator()
        menu.addAction(QAction("Show window", self, triggered=self.show_window))
        menu.addAction(QAction("Quit", self, triggered=self.quit))
        self._tray_menu = menu
        self.tray.setContextMenu(menu)
        self.tray.activated.connect(self._tray_activated)
        if QSystemTrayIcon.isSystemTrayAvailable():
            self.tray.show()

    # -- settings ---------------------------------------------------------
    def _load(self):
        s = self.settings
        self._fill_audio()
        mode = s.value("mode", "mp4", str)
        for b in self.mode_group.buttons():
            b.setChecked(b.property("mode") == mode)
        source = s.value("source", "screen", str)
        if source == "window" and not SUPPORTS_WINDOW_CAPTURE:
            source = "screen"
        {"screen": self.src_screen, "region": self.src_region, "window": self.src_window}[source].setChecked(True)
        self._set_combo(self.quality_combo, s.value("quality", "high", str))
        self._set_combo(self.gif_combo, s.value("gif_width", 0, int))
        self.countdown_spin.setValue(s.value("countdown", 3, int))
        self.cursor_check.setChecked(s.value("cursor", True, bool))
        self.minimize_check.setChecked(s.value("minimize", True, bool))
        self.border_check.setChecked(s.value("border", True, bool))
        movies = QStandardPaths.writableLocation(QStandardPaths.StandardLocation.MoviesLocation)
        self.out_edit.setText(s.value("out_dir", str(Path(movies or Path.home()) / APP_ID), str))
        self.sys_check.setChecked(s.value("audio/system", True, bool) and self.sys_check.isEnabled())
        self.mic_check.setChecked(s.value("audio/mic", False, bool) and self.mic_check.isEnabled())
        self._set_combo(self.sys_combo, s.value("audio/system_device", "", str))
        self._set_combo(self.mic_combo, s.value("audio/mic_device", "", str))
        self.sys_combo.setEnabled(self.sys_check.isChecked())
        self.mic_combo.setEnabled(self.mic_check.isChecked())
        for path in s.value("recent", [], list) or []:
            if Path(path).exists():
                self._add_recent(path, top=False)
        if s.value("preview", False, bool):
            self._toggle_preview()
        self._apply_mode(mode)
        self._source_changed()

    def _save(self):
        s = self.settings
        mode = self._mode()
        s.setValue("mode", mode)
        s.setValue("source", self._source())
        if mode in DEFAULT_FPS:
            s.setValue(f"fps_{mode}", self.fps_combo.currentData())
        s.setValue("quality", self.quality_combo.currentData())
        s.setValue("gif_width", self.gif_combo.currentData())
        s.setValue("countdown", self.countdown_spin.value())
        s.setValue("cursor", self.cursor_check.isChecked())
        s.setValue("minimize", self.minimize_check.isChecked())
        s.setValue("border", self.border_check.isChecked())
        s.setValue("out_dir", self.out_edit.text().strip())
        s.setValue("preview", self.preview.isVisibleTo(self))
        if self.sys_check.isEnabled():
            s.setValue("audio/system", self.sys_check.isChecked())
        if self.mic_check.isEnabled():
            s.setValue("audio/mic", self.mic_check.isChecked())
        s.setValue("audio/system_device", self.sys_combo.currentData() or "")
        s.setValue("audio/mic_device", self.mic_combo.currentData() or "")
        s.setValue("recent", [self.recent.item(i).data(Qt.ItemDataRole.UserRole)
                              for i in range(self.recent.count())])

    def _fill_audio(self):
        linux = audio.LINUX
        for check, combo, devices, default_label, missing in (
            (self.sys_check, self.sys_combo, audio.outputs(), "Default output",
             "No loopback device found. To record system audio, enable \"Stereo Mix\" or "
             "install VB-CABLE (Windows) / BlackHole (macOS)."),
            (self.mic_check, self.mic_combo, audio.inputs(), "Default microphone",
             "No microphone found."),
        ):
            combo.clear()
            if linux:
                combo.addItem(default_label, "")  # resolved when recording starts
            for device, label in devices:
                combo.addItem(label, device)
            available = combo.count() > 0
            check.setEnabled(available)
            check.setToolTip("" if available else missing)
            if not available:
                check.setChecked(False)
                combo.addItem("Not available")
                combo.setEnabled(False)

    @staticmethod
    def _set_combo(combo, value):
        i = combo.findData(value)
        if i >= 0:
            combo.setCurrentIndex(i)

    # -- small state helpers ----------------------------------------------
    def _mode(self):
        b = self.mode_group.checkedButton()
        return b.property("mode") if b else "mp4"

    def _source(self):
        if self.src_region.isChecked():
            return "region"
        if self.src_window.isChecked() and SUPPORTS_WINDOW_CAPTURE:
            return "window"
        return "screen"

    def _mode_changed(self, _button):
        # remember the frame rate of the mode we are leaving
        previous = getattr(self, "_shown_mode", None)
        if previous in DEFAULT_FPS:
            self.settings.setValue(f"fps_{previous}", self.fps_combo.currentData())
        self._apply_mode(self._mode())

    def _apply_mode(self, mode):
        self._shown_mode = mode
        video = mode != "mp3"
        self.area_box.setVisible(video)
        self.audio_box.setVisible(mode != "gif")
        self.form.setRowVisible(self.fps_combo, video)
        self.form.setRowVisible(self.quality_combo, mode != "gif")
        self.form.setRowVisible(self.gif_combo, mode == "gif")
        self.form.setRowVisible(self.cursor_check, video)
        self.form.setRowVisible(self.minimize_check, video)
        self.form.setRowVisible(self.border_check, video)
        if mode in DEFAULT_FPS:
            self._set_combo(self.fps_combo, self.settings.value(f"fps_{mode}", DEFAULT_FPS[mode], int))
        self._sync_hud()

    def _source_changed(self, *_):
        self.region_btn.setEnabled(self.src_region.isChecked())
        self._update_region_label()
        self._sync_hud()

    def _saved_region(self):
        """(QScreen, QRect) for the stored region, or None."""
        s = self.settings
        rect = QRect(s.value("region/x", 0, int), s.value("region/y", 0, int),
                     s.value("region/w", 0, int), s.value("region/h", 0, int))
        if rect.isEmpty():
            return None
        name = s.value("region/screen", "", str)
        for screen in QGuiApplication.screens():
            if screen.name() == name and QRect(0, 0, screen.geometry().width(),
                                                screen.geometry().height()).contains(rect):
                return screen, rect
        return None

    def _update_region_label(self):
        saved = self._saved_region()
        if not self.src_region.isChecked():
            self.region_label.setText("")
        elif saved:
            screen, r = saved
            self.region_label.setText(f"{r.width()} × {r.height()} at {r.x()}, {r.y()} on {screen.name()}")
        else:
            self.region_label.setText("No region selected yet")

    # -- region picking ---------------------------------------------------
    def pick_region(self, then=None):
        if self.recorder.is_busy() or self._picker:
            return

        def picked(screen, rect):
            s = self.settings
            s.setValue("region/screen", screen.name())
            for key, value in zip("xywh", (rect.x(), rect.y(), rect.width(), rect.height())):
                s.setValue(f"region/{key}", value)
            self.src_region.setChecked(True)
            closed()
            if then:
                then()

        def closed():
            self._picker = None
            self._update_region_label()
            self._sync_hud()

        # The window is deliberately left where it is: the picker covers the
        # whole screen anyway, and on Wayland a window that is hidden and shown
        # again gets re-placed by the compositor instead of returning to its spot.
        self._close_hud()  # it would sit on top of the picker
        self._picker = RegionPickerSession(picked, closed)

    # -- recording flow ---------------------------------------------------
    def toggle_recording(self):
        if self.recorder.state == "idle":
            self.start()
        elif self.recorder.state != "processing":
            self.stop()

    def start(self):
        if self.recorder.is_busy() or self._picker:
            return
        missing = missing_tools()
        if missing:
            self._show_error(f"{APP_NAME} needs these to record:\n\n• " + "\n• ".join(missing))
            return
        mode, source = self._mode(), self._source()
        job = Job(
            mode=mode, source=source,
            fps=self.fps_combo.currentData(), quality=self.quality_combo.currentData(),
            cursor=self.cursor_check.isChecked(), gif_width=self.gif_combo.currentData(),
            out_dir=self.out_edit.text().strip() or str(Path.home()),
        )
        if mode != "mp3":
            screens = QGuiApplication.screens()
            screen = self.screen() or QGuiApplication.primaryScreen()
            if source == "region":
                saved = self._saved_region()
                if not saved:
                    self.pick_region(then=self.start)
                    return
                screen, rect = saved
                job.region = (rect.x(), rect.y(), rect.width(), rect.height())
            geo = screen.geometry()
            job.screen_geo = (geo.x(), geo.y(), geo.width(), geo.height())
            job.screen_name = screen.name()
            job.screen_index = screens.index(screen) if screen in screens else 0
            job.dpr = screen.devicePixelRatio()
            job.multi_screen = len(screens) > 1
            self._job_screen = screen
        if mode != "gif":
            for check, combo, default in ((self.sys_check, self.sys_combo, audio.default_output),
                                          (self.mic_check, self.mic_combo, audio.default_input)):
                if check.isChecked():
                    device = combo.currentData() or default()
                    if device and device not in job.audio:
                        job.audio.append(device)
        self._save()
        self.status.setText("Waiting for permission to capture the screen…"
                            if mode != "mp3" and KIND == "portal" else "")
        self.recorder.prepare(job)

    def stop(self):
        self._countdown.stop()
        self.recorder.stop()

    def _on_prepared(self):
        job = self.recorder.job
        video = job.mode != "mp3"
        self._was_minimized = False
        if video and self.minimize_check.isChecked() and self.isVisible():
            self._was_minimized = True
            self.showMinimized()
        self._countdown_left = self.countdown_spin.value()
        if self._countdown_left:
            self.status.setText(f"Recording starts in {self._countdown_left}…")
            self._countdown.start()
            self._sync_hud()
        else:
            self._begin()

    def _countdown_tick(self):
        self._countdown_left -= 1
        if self._countdown_left > 0:
            self.status.setText(f"Recording starts in {self._countdown_left}…")
            self._sync_hud()
            return
        self._countdown.stop()
        self._begin()

    def _begin(self):
        self._sync_hud()
        # let the countdown vanish from the screen before the first frame is grabbed
        QTimer.singleShot(150, self.recorder.begin)

    def _sync_hud(self):
        """Show, update or drop the overlay: the region outline and the countdown."""
        outline = None
        if (self.border_check.isChecked() and not self._picker
                and self._mode() != "mp3" and self._source() == "region"):
            outline = self._saved_region()
        job = self.recorder.job
        counting = self._countdown.isActive() and job is not None and job.mode != "mp3"
        screen = outline[0] if outline else self._job_screen if counting else None
        if self.hud and self.hud.target_screen is not screen:
            self._close_hud()
        if screen is None:
            return
        fresh = self.hud is None
        if fresh:
            self.hud = Hud(screen)
        self.hud.region = outline[1] if outline else None
        self.hud.count = self._countdown_left if counting else None
        self.hud.paused = self.recorder.state == "paused"
        if fresh:
            self.hud.present()
        else:
            self.hud.update()

    def _close_hud(self):
        if self.hud:
            self.hud.close()
            self.hud.deleteLater()
            self.hud = None

    # -- recorder events --------------------------------------------------
    def _on_state(self, state):
        idle = state == "idle"
        active = state in ("recording", "paused")
        for w in (self.area_box, self.audio_box, self.out_edit, self.fps_combo, self.quality_combo,
                  self.gif_combo, self.countdown_spin, *self.mode_group.buttons()):
            w.setEnabled(idle)
        self.record_btn.setText("●  Record" if idle else "Saving…" if state == "processing" else "■  Stop")
        self.record_btn.setEnabled(state != "processing")
        self.record_btn.setProperty("recording", not idle)
        self.record_btn.style().unpolish(self.record_btn)
        self.record_btn.style().polish(self.record_btn)
        self.pause_btn.setEnabled(active)
        self.pause_btn.setText("Resume" if state == "paused" else "Pause")
        self.tray_record.setText("Start recording" if idle else "Stop recording")
        self.tray_record.setEnabled(state != "processing")
        self.tray_pause.setEnabled(active)
        self.tray_pause.setText("Resume" if state == "paused" else "Pause")
        self.tray.setToolTip(f"{APP_NAME} – {state}")
        if not idle:
            self.preview.pause()
        if state == "recording":
            self.status.setText("Recording…")
            self._clock.start()
        elif state == "paused":
            self.status.setText("Paused")
        elif state == "processing":
            self._clock.stop()
            self.status.setText("Saving your recording…")
        elif idle:
            self._countdown.stop()
            self._clock.stop()
        self._sync_hud()
        self._update_clock()

    def _update_clock(self):
        t = int(self.recorder.elapsed()) if self.recorder.is_busy() else 0
        h, m, s = t // 3600, t % 3600 // 60, t % 60
        self.timer_label.setText(f"{h}:{m:02}:{s:02}" if h else f"{m:02}:{s:02}")

    def _restore(self):
        # On Wayland an app cannot un-minimize itself in place (see show_window),
        # so the window stays in the taskbar there rather than jumping around.
        if self._was_minimized and KIND != "portal":
            self.show_window()
        self._was_minimized = False

    def _on_finished(self, path, warning):
        self._add_recent(path)
        self._save()
        self.status.setText(f"Saved {path}" + (f"\nNote: {warning}" if warning else ""))
        self._restore()
        if self.tray.isVisible():
            self.tray.showMessage(APP_NAME, f"Saved {Path(path).name}", app_icon(), 4000)

    def _on_failed(self, message):
        self._restore()
        self.status.setText(message or "Cancelled.")
        if message:
            self._show_error(message)

    def _show_error(self, message):
        self.show_window()
        QMessageBox.warning(self, APP_NAME, message)

    def _forget_choice(self):
        self.recorder.forget_screen_choice()
        self.status.setText("The system will ask what to share on the next recording.")

    # -- recordings list --------------------------------------------------
    def _add_recent(self, path, top=True):
        item = QListWidgetItem(Path(path).name)
        item.setData(Qt.ItemDataRole.UserRole, path)
        item.setToolTip(path)
        if top:
            self.recent.insertItem(0, item)
            self.recent.setCurrentItem(item)
        else:
            self.recent.addItem(item)
        while self.recent.count() > MAX_RECENT:
            self.recent.takeItem(self.recent.count() - 1)

    def _selected_path(self):
        item = self.recent.currentItem()
        return item.data(Qt.ItemDataRole.UserRole) if item else None

    def _open_selected(self):
        if path := self._selected_path():
            QDesktopServices.openUrl(QUrl.fromLocalFile(path))

    def _open_folder(self):
        path = self._selected_path()
        folder = str(Path(path).parent) if path else self.out_edit.text().strip()
        if folder:
            QDesktopServices.openUrl(QUrl.fromLocalFile(folder))

    def _copy_path(self):
        if path := self._selected_path():
            QGuiApplication.clipboard().setText(path)

    def _toggle_preview(self):
        if self.preview.isVisibleTo(self):
            self.preview.close_preview()
            return
        self._resize_for_preview(+1)  # first, or the layout widens the window as well
        self.preview.show_file(self._selected_path())
        self.preview_btn.setText("Hide preview")
        if self.recorder.is_busy():
            self.preview.pause()

    def _show_preview(self):
        """Follow the selection while the panel is open."""
        if not self.preview.isVisibleTo(self):
            return
        self.preview.show_file(self._selected_path())
        if self.recorder.is_busy():
            self.preview.pause()

    def _preview_closed(self):
        self.preview_btn.setText("Show preview")
        self._resize_for_preview(-1)

    def _resize_for_preview(self, direction):
        if self.isMaximized() or self.isFullScreen():
            return
        extra = self.preview.width() + self._body.spacing()
        self.layout().activate()  # so the minimum width no longer counts a panel just hidden
        self.resize(max(self.width() + direction * extra, self.minimumSizeHint().width()), self.height())

    def _remove_selected(self):
        row = self.recent.currentRow()
        if row >= 0:
            self.recent.takeItem(row)  # the file itself is left alone

    def _browse(self):
        folder = QFileDialog.getExistingDirectory(self, "Save recordings to", self.out_edit.text())
        if folder:
            self.out_edit.setText(folder)

    # -- window / tray ----------------------------------------------------
    def show_window(self):
        handle = self.windowHandle()
        if self.isVisible() and handle and not handle.isExposed():
            # Minimized. Wayland has no "un-minimize" request, so map the window
            # afresh; the compositor then decides where it goes.
            self.hide()
        self.showNormal()
        self.raise_()
        self.activateWindow()

    def _tray_activated(self, reason):
        if reason == QSystemTrayIcon.ActivationReason.Trigger:
            if self.recorder.state in ("recording", "paused"):
                self.stop()
            else:
                self.show_window()

    def handle_command(self, command):
        """Commands sent by a second `snakescreen --toggle` style invocation."""
        if command == "toggle":
            self.toggle_recording()
        elif command == "stop":
            if self.recorder.is_busy():
                self.stop()
        elif command == "pause":
            self.recorder.toggle_pause()
        else:
            self.show_window()

    def quit(self):
        if self.recorder.state in ("recording", "paused", "processing"):
            self.show_window()
            QMessageBox.information(self, APP_NAME, "Stop the recording and let it finish saving first.")
            return
        self._quitting = True
        self.recorder.stop()
        self._save()
        self.tray.hide()
        QApplication.quit()

    def closeEvent(self, event):
        if self._quitting:
            event.accept()
        elif self.recorder.is_busy():
            # keep recording; the tray icon (or --toggle) stops it
            event.ignore()
            self.showMinimized()
        else:
            event.accept()
            self.quit()
