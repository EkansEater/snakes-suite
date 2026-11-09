"""Main window and tray icon."""

import time
from pathlib import Path

from PyQt6.QtCore import QFile, QFileSystemWatcher, QRect, QSettings, QStandardPaths, Qt, QTimer, QUrl
from PyQt6.QtGui import QAction, QDesktopServices, QGuiApplication, QIcon, QKeySequence, QShortcut
from PyQt6.QtWidgets import (
    QAbstractItemView, QApplication, QButtonGroup, QCheckBox, QComboBox, QFileDialog, QFormLayout,
    QGridLayout, QGroupBox, QHBoxLayout, QLabel, QLineEdit, QListWidget, QListWidgetItem, QMenu,
    QMessageBox, QPushButton, QSpinBox, QSystemTrayIcon, QVBoxLayout, QWidget,
)

from . import APP_ID, APP_NAME, audio, snake_theme
from .overlay import Hud, RegionPickerSession
from .platforms import KIND, SUPPORTS_WINDOW_CAPTURE, missing_tools
from .preview import PreviewPanel
from .recorder import Job, Recorder

ICON_PATH = Path(__file__).parent / "assets" / "icon.svg"
MODES = [("mp4", "Video (MP4)"), ("gif", "GIF"), ("mp3", "Audio (MP3)")]
SOURCES = [("screen", "Full screen"), ("region", "Region"), ("window", "Window")]
DEFAULT_FPS = {"mp4": 30, "gif": 15}
MEDIA_SUFFIXES = {".mp4", ".gif", ".mp3"}
MAX_LISTED = 300
HOTKEY_TIP = ("Tip: bind a keyboard shortcut to the command  snakescreen --toggle  "
              "to start and stop from anywhere (also --pause and --stop).")


def app_icon():
    icon = QIcon(str(ICON_PATH))
    return icon if not icon.isNull() else QIcon.fromTheme("media-record")


def _size(n):
    for unit in ("bytes", "KB", "MB"):
        if n < 1024:
            return f"{n:.0f} {unit}" if unit == "bytes" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} GB"


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
        self._source_before_pick = "screen"

        # the recordings list mirrors the save folder
        self._watcher = QFileSystemWatcher(self)
        self._watcher.directoryChanged.connect(lambda _p: self._rescan_soon.start())
        self._rescan_soon = QTimer(self, singleShot=True, interval=400, timeout=self._rescan)

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
        self.header = snake_theme.HeaderBar(APP_NAME, "Screen and audio recorder", ICON_PATH)
        help_btn = self.header.add_action("?", self._show_help, tooltip="How to use it, and the global hotkey")
        help_btn.setFixedWidth(34)
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
        self.preview.trimmed.connect(self._on_trimmed)
        self.preview.trimStarted.connect(lambda: self._rescan_soon.stop())
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

        # what to capture: one choice, and right under it what that choice needs
        self.area_box = QGroupBox("Capture")
        area = QVBoxLayout(self.area_box)
        seg = QHBoxLayout()
        seg.setSpacing(6)
        self.source_group = QButtonGroup(self)
        self.source_buttons = {}
        for key, text in SOURCES:
            b = QPushButton(text, checkable=True)
            b.setProperty("source", key)
            if key == "window":
                b.setVisible(SUPPORTS_WINDOW_CAPTURE)
                b.setToolTip("The desktop asks which window to record when you press Record.")
            self.source_group.addButton(b)
            self.source_buttons[key] = b
            seg.addWidget(b, 1)
        self.source_group.buttonClicked.connect(self._source_clicked)
        area.addLayout(seg)

        self.region_row = QWidget()
        region_row = QHBoxLayout(self.region_row)
        region_row.setContentsMargins(0, 2, 0, 0)
        self.region_label = QLabel(objectName="status")
        self.region_btn = QPushButton("Change region…", objectName="small")
        self.region_btn.clicked.connect(lambda: self.pick_region())
        self.border_check = QCheckBox("Show outline")
        self.border_check.setToolTip("A green outline around the region, on top of every window, "
                                     "before and during recording. It never appears in the video.")
        self.border_check.toggled.connect(lambda _on: self._sync_hud())
        region_row.addWidget(self.region_label, 1)
        region_row.addWidget(self.border_check)
        region_row.addWidget(self.region_btn)
        area.addWidget(self.region_row)

        self.portal_row = QWidget()
        portal_row = QHBoxLayout(self.portal_row)
        portal_row.setContentsMargins(0, 2, 0, 0)
        self.portal_label = QLabel(objectName="hint", wordWrap=True)
        self.forget_btn = QPushButton("Choose again", objectName="small")
        self.forget_btn.setToolTip("Forget the remembered choice, so the desktop asks again on the next recording.")
        self.forget_btn.clicked.connect(self._forget_choice)
        portal_row.addWidget(self.portal_label, 1)
        portal_row.addWidget(self.forget_btn)
        area.addWidget(self.portal_row)
        root.addWidget(self.area_box)

        # audio
        self.audio_box = QGroupBox("Audio")
        agrid = QGridLayout(self.audio_box)
        agrid.setColumnStretch(1, 1)
        agrid.setHorizontalSpacing(10)
        self.sys_check = QCheckBox("System audio")
        self.sys_check.setToolTip("What the computer is playing")
        self.sys_combo = QComboBox()
        self.mic_check = QCheckBox("Microphone")
        self.mic_combo = QComboBox()
        for combo in (self.sys_combo, self.mic_combo):
            combo.setSizeAdjustPolicy(QComboBox.SizeAdjustPolicy.AdjustToMinimumContentsLengthWithIcon)
            combo.setMinimumContentsLength(18)
        refresh = QPushButton("↻", objectName="small")
        refresh.setToolTip("Look for audio devices again")
        refresh.setFixedWidth(30)
        refresh.clicked.connect(self._refresh_audio)
        agrid.addWidget(self.sys_check, 0, 0)
        agrid.addWidget(self.sys_combo, 0, 1)
        agrid.addWidget(refresh, 0, 2)
        agrid.addWidget(self.mic_check, 1, 0)
        agrid.addWidget(self.mic_combo, 1, 1)
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
        self.countdown_spin.setSpecialValueText("Off")
        self.cursor_check = QCheckBox("Show mouse cursor")
        self.minimize_check = QCheckBox("Minimize this window while recording")
        if KIND == "portal":
            self.minimize_check.setToolTip("Wayland does not let an app un-minimize itself, so the "
                                           "window stays in the taskbar afterwards.")
        form.addRow("Frame rate", self.fps_combo)
        form.addRow("Quality", self.quality_combo)
        form.addRow("GIF size", self.gif_combo)
        form.addRow("Countdown", self.countdown_spin)
        form.addRow(self.cursor_check)
        form.addRow(self.minimize_check)
        out_row = QHBoxLayout()
        self.out_edit = QLineEdit()
        self.out_edit.editingFinished.connect(self._folder_changed)
        browse = QPushButton("Browse…")
        browse.clicked.connect(self._browse)
        out_row.addWidget(self.out_edit, 1)
        out_row.addWidget(browse)
        form.addRow("Save to", out_row)
        root.addWidget(box)

        # controls
        controls = QHBoxLayout()
        self.record_btn = QPushButton(objectName="record")
        self.record_btn.setToolTip(HOTKEY_TIP)
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

        # recordings: everything in the save folder, newest first
        rec_box = QGroupBox("Recordings")
        rec = QVBoxLayout(rec_box)
        self.recent = QListWidget()
        self.recent.setMinimumHeight(110)
        self.recent.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.recent.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.recent.customContextMenuRequested.connect(self._list_menu)
        self.recent.itemDoubleClicked.connect(lambda _i: self._open_preview())
        self.recent.itemActivated.connect(lambda _i: self._open_preview())
        self.recent.currentItemChanged.connect(lambda *_: self._selection_changed())
        rec.addWidget(self.recent)
        self.empty_label = QLabel("No recordings in this folder yet.", objectName="hint")
        rec.addWidget(self.empty_label)
        buttons = QHBoxLayout()
        self.open_btn = QPushButton("Open", objectName="small")
        self.open_btn.setToolTip("Open in your default player")
        self.open_btn.clicked.connect(self._open_selected)
        self.folder_btn = QPushButton("Show in folder", objectName="small")
        self.folder_btn.clicked.connect(self._open_folder)
        self.delete_btn = QPushButton("Delete", objectName="smallDanger")
        self.delete_btn.setToolTip("Move the file to the trash (Delete)")
        self.delete_btn.clicked.connect(self._delete_selected)
        for b in (self.open_btn, self.folder_btn):
            buttons.addWidget(b)
        buttons.addStretch(1)
        buttons.addWidget(self.delete_btn)
        rec.addLayout(buttons)
        root.addWidget(rec_box, 1)
        QShortcut(QKeySequence(QKeySequence.StandardKey.Delete), self.recent, self._delete_selected,
                  context=Qt.ShortcutContext.WidgetShortcut)
        self.resize(600, 820)

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
        if source not in self.source_buttons or (source == "window" and not SUPPORTS_WINDOW_CAPTURE):
            source = "screen"
        self.source_buttons[source].setChecked(True)
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
        self._preview_wanted = s.value("preview", True, bool)
        self._apply_mode(mode)
        self._source_changed()
        self._folder_changed()

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
        s.setValue("preview", self._preview_wanted)
        if self.sys_check.isEnabled():
            s.setValue("audio/system", self.sys_check.isChecked())
        if self.mic_check.isEnabled():
            s.setValue("audio/mic", self.mic_check.isChecked())
        s.setValue("audio/system_device", self.sys_combo.currentData() or "")
        s.setValue("audio/mic_device", self.mic_combo.currentData() or "")
        s.remove("recent")  # the list now comes from the save folder

    def _fill_audio(self):
        linux = audio.LINUX
        outputs, inputs = audio.outputs(), audio.inputs()
        for check, combo, devices, default_id, default_label, missing in (
            (self.sys_check, self.sys_combo, outputs, audio.default_output if linux else None,
             "Default output",
             "No loopback device found. To record system audio, enable \"Stereo Mix\" or "
             "install VB-CABLE (Windows) / BlackHole (macOS)."),
            (self.mic_check, self.mic_combo, inputs, audio.default_input if linux else None,
             "Default microphone", "No microphone found."),
        ):
            chosen = combo.currentData()
            combo.clear()
            if linux:
                # resolved again when recording starts; show which device it is today
                current = default_id()
                name = next((label for dev, label in devices if dev == current), "")
                combo.addItem(f"{default_label} ({name})" if name else default_label, "")
            for device, label in devices:
                combo.addItem(label, device)
            available = combo.count() > 0
            check.setEnabled(available)
            check.setToolTip(check.toolTip() if available else missing)
            if not available:
                check.setChecked(False)
                combo.addItem("Not available")
                combo.setEnabled(False)
            else:
                if chosen is not None:
                    self._set_combo(combo, chosen)
                combo.setEnabled(check.isChecked())

    def _refresh_audio(self):
        self._fill_audio()
        self.status.setText("Audio devices updated.")

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
        b = self.source_group.checkedButton()
        source = b.property("source") if b else "screen"
        return "screen" if source == "window" and not SUPPORTS_WINDOW_CAPTURE else source

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
        if mode in DEFAULT_FPS:
            self._set_combo(self.fps_combo, self.settings.value(f"fps_{mode}", DEFAULT_FPS[mode], int))
        self._sync_hud()

    def _source_clicked(self, button):
        source = button.property("source")
        if source == "region" and not self._saved_region():
            # nothing to record yet: draw it now, and go back if that is cancelled
            self.pick_region(cancel_to=self._source_before_pick)
        self._source_changed()

    def _source_changed(self, *_):
        source = self._source()
        self._source_before_pick = source
        self.region_row.setVisible(source == "region")
        self._update_region_label()
        self._update_portal_row()
        self._sync_hud()

    def _update_portal_row(self):
        if KIND != "portal":
            self.portal_row.hide()
            return
        source = self._source()
        key = "portal/window" if source == "window" else "portal/monitor"
        remembered = bool(self.settings.value(key, "", str))
        what = "window" if source == "window" else "screen"
        if remembered:
            self.portal_label.setText(f"Uses the {what} you shared last time.")
        else:
            self.portal_label.setText(f"Your desktop asks which {what} to share when you press Record.")
        self.forget_btn.setVisible(remembered)
        self.portal_row.show()

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
        if saved:
            screen, r = saved
            self.region_label.setText(f"{r.width()} × {r.height()} at {r.x()}, {r.y()} on {screen.name()}")
            self.region_btn.setText("Change region…")
        else:
            self.region_label.setText("No region drawn yet")
            self.region_btn.setText("Draw region…")
        self.border_check.setEnabled(saved is not None)

    # -- region picking ---------------------------------------------------
    def pick_region(self, then=None, cancel_to=None):
        if self.recorder.is_busy() or self._picker:
            return

        def picked(screen, rect):
            s = self.settings
            s.setValue("region/screen", screen.name())
            for key, value in zip("xywh", (rect.x(), rect.y(), rect.width(), rect.height())):
                s.setValue(f"region/{key}", value)
            self.source_buttons["region"].setChecked(True)
            self._picker = None
            self._source_changed()
            if then:
                then()

        def cancelled():
            self._picker = None
            if cancel_to and not self._saved_region():
                self.source_buttons[cancel_to].setChecked(True)
            self._source_changed()

        # The window is deliberately left where it is: the picker covers the
        # whole screen anyway, and on Wayland a window that is hidden and shown
        # again gets re-placed by the compositor instead of returning to its spot.
        self._close_hud()  # it would sit on top of the picker
        self.status.setText("Drag a rectangle over what to record. Esc cancels.")
        self._picker = RegionPickerSession(picked, cancelled)

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
        if mode == "mp3" and not (self.sys_check.isChecked() or self.mic_check.isChecked()):
            self._show_error("Tick System audio or Microphone (or both) to record audio.")
            return
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
        self._update_portal_row()  # a choice may have been remembered just now
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
                  self.gif_combo, self.countdown_spin, self.cursor_check, self.minimize_check,
                  *self.mode_group.buttons()):
            w.setEnabled(idle)
        if idle:
            self.sys_combo.setEnabled(self.sys_check.isChecked() and self.sys_check.isEnabled())
            self.mic_combo.setEnabled(self.mic_check.isChecked() and self.mic_check.isEnabled())
        labels = {"idle": "●  Record", "preparing": "Cancel", "armed": "Cancel", "processing": "Saving…"}
        self.record_btn.setText(labels.get(state, "■  Stop"))
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
        self.delete_btn.setEnabled(idle and self._selected_path() is not None)
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
        self._save()
        self._rescan(select=path)
        self.status.setText(f"Saved {path}" + (f"\nNote: {warning}" if warning else ""))
        self._restore()
        if self.tray.isVisible():
            self.tray.showMessage(APP_NAME, f"Saved {Path(path).name}", app_icon(), 4000)

    def _on_trimmed(self, path):
        self._rescan(select=path)
        self.status.setText(f"Saved {path}")

    def _on_failed(self, message):
        self._restore()
        self._update_portal_row()
        self._rescan()
        self.status.setText(message or "Cancelled.")
        if message:
            self._show_error(message)

    def _show_error(self, message):
        self.show_window()
        QMessageBox.warning(self, APP_NAME, message)

    def _forget_choice(self):
        self.recorder.forget_screen_choice()
        self._update_portal_row()
        self.status.setText("Your desktop will ask what to share on the next recording.")

    def _show_help(self):
        QMessageBox.information(self, APP_NAME, (
            "1. Pick Video (MP4), GIF or Audio (MP3).\n"
            "2. Choose what to capture. Region asks you to drag a rectangle; it is remembered.\n"
            "3. Press Record. Stop from this window, the tray icon, or the hotkey.\n\n"
            "Recordings are saved in the Save to folder and listed at the bottom. Click one to "
            "watch it on the right; there you can also trim it (I and O mark the start and end) and crop it (C, then drag a rectangle on the picture).\n\n"
            + HOTKEY_TIP))

    # -- recordings list --------------------------------------------------
    def _folder(self):
        text = self.out_edit.text().strip()
        return Path(text).expanduser() if text else None

    def _folder_changed(self):
        if self._watcher.directories():
            self._watcher.removePaths(self._watcher.directories())
        folder = self._folder()
        if folder and folder.is_dir():
            self._watcher.addPath(str(folder))
        self._rescan()

    def _rescan(self, select=None):
        """Fill the list from the save folder, keeping (or moving to) the selection."""
        if self.recorder.state == "processing" or self.preview.trimming():
            return  # a file is still being written; we rescan when it is done
        folder = self._folder()
        if folder and folder.is_dir() and str(folder) not in self._watcher.directories():
            self._watcher.addPath(str(folder))
        keep = select or self._selected_path()
        files = []
        if folder and folder.is_dir():
            try:
                for p in folder.iterdir():
                    if p.suffix.lower() in MEDIA_SUFFIXES and p.is_file():
                        st = p.stat()
                        files.append((st.st_mtime, p, st.st_size))
            except OSError:
                pass
        files.sort(key=lambda f: f[0], reverse=True)
        self.recent.blockSignals(True)
        self.recent.clear()
        for mtime, p, size in files[:MAX_LISTED]:
            when = time.strftime("%b %d, %H:%M", time.localtime(mtime))
            item = QListWidgetItem(f"{p.name}\n{_size(size)}  ·  {when}")
            item.setData(Qt.ItemDataRole.UserRole, str(p))
            item.setToolTip(str(p))
            self.recent.addItem(item)
            if keep and str(p) == keep:
                self.recent.setCurrentItem(item)
        self.recent.blockSignals(False)
        self.empty_label.setVisible(not files)
        self.recent.setVisible(bool(files))
        self._selection_changed()

    def _selected_path(self):
        item = self.recent.currentItem()
        return item.data(Qt.ItemDataRole.UserRole) if item else None

    def _selection_changed(self, force=False):
        path = self._selected_path()
        self.open_btn.setEnabled(path is not None)
        self.delete_btn.setEnabled(path is not None and not self.recorder.is_busy())
        if path is None:
            if self.preview.isVisibleTo(self):
                self.preview.close_preview(user=False)
            return
        if self._preview_wanted or force:
            self._show_in_preview(path)

    def _open_preview(self):
        if path := self._selected_path():
            self._preview_wanted = True
            self._show_in_preview(path)

    def _show_in_preview(self, path):
        if not self.preview.isVisibleTo(self):
            self._resize_for_preview(+1)  # first, or the layout widens the window as well
        self.preview.show_file(path)
        if self.recorder.is_busy():
            self.preview.pause()

    def _preview_closed(self, by_user):
        if by_user:
            self._preview_wanted = False
        self._resize_for_preview(-1)

    def _resize_for_preview(self, direction):
        if self.isMaximized() or self.isFullScreen():
            return
        extra = self.preview.width() + self._body.spacing()
        self.layout().activate()  # so the minimum width no longer counts a panel just hidden
        self.resize(max(self.width() + direction * extra, self.minimumSizeHint().width()), self.height())

    def _list_menu(self, pos):
        item = self.recent.itemAt(pos)
        if not item:
            return
        self.recent.setCurrentItem(item)
        menu = QMenu(self)
        menu.addAction("Watch here", self._open_preview)
        menu.addAction("Open in default player", self._open_selected)
        menu.addAction("Show in folder", self._open_folder)
        menu.addAction("Copy path", self._copy_path)
        menu.addSeparator()
        delete = menu.addAction("Move to trash", self._delete_selected)
        delete.setEnabled(not self.recorder.is_busy())
        menu.exec(self.recent.viewport().mapToGlobal(pos))

    def _open_selected(self):
        if path := self._selected_path():
            self.preview.pause()
            QDesktopServices.openUrl(QUrl.fromLocalFile(path))

    def _open_folder(self):
        folder = self._folder()
        if folder:
            folder.mkdir(parents=True, exist_ok=True)
            QDesktopServices.openUrl(QUrl.fromLocalFile(str(folder)))

    def _copy_path(self):
        if path := self._selected_path():
            QGuiApplication.clipboard().setText(path)
            self.status.setText("Path copied.")

    def _delete_selected(self):
        path = self._selected_path()
        if not path or self.recorder.is_busy():
            return
        name = Path(path).name
        answer = QMessageBox.question(self, APP_NAME, f"Move {name} to the trash?")
        if answer != QMessageBox.StandardButton.Yes:
            return
        row = self.recent.currentRow()
        if self.preview.path == path:
            self.preview.close_preview(user=False)
        if QFile.moveToTrash(path):
            self.status.setText(f"Moved {name} to the trash.")
        else:
            self.status.setText(f"Could not move {name} to the trash.")
            return
        self._rescan()
        if self.recent.count():
            self.recent.setCurrentRow(min(row, self.recent.count() - 1))

    def _browse(self):
        folder = QFileDialog.getExistingDirectory(self, "Save recordings to", self.out_edit.text())
        if folder:
            self.out_edit.setText(folder)
            self._folder_changed()
            self._save()

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
