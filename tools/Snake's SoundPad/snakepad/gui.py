"""PySide6 main window."""

from __future__ import annotations

import random
from pathlib import Path

from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QAction, QIcon, QKeySequence
from PySide6.QtWidgets import (
    QAbstractItemView, QApplication, QCheckBox, QComboBox, QFileDialog, QGridLayout,
    QGroupBox, QHBoxLayout, QHeaderView, QLabel, QLineEdit, QMainWindow, QMenu,
    QMessageBox, QPushButton, QSlider, QSystemTrayIcon, QTableWidget, QTableWidgetItem,
    QToolBar, QVBoxLayout, QWidget,
)

from . import snake_theme
from .audio import MIC_DESC, AudioError, Player, VirtualDevices, default_source, list_input_sources
from .ipc import CommandServer
from .library import AUDIO_EXTS, Library, is_audio_file

COL_NUM, COL_NAME, COL_VOL, COL_PATH = range(4)
ICON_PATH = Path(__file__).resolve().parent / "assets" / "icon.svg"


class MainWindow(QMainWindow):
    def __init__(self, devices: VirtualDevices, player: Player, library: Library) -> None:
        super().__init__()
        self.devices = devices
        self.player = player
        self.lib = library
        self.s = library.settings
        self._really_quit = False
        self._populating = False

        self.setWindowTitle("Snake's SoundPad")
        self.setWindowIcon(QIcon(str(ICON_PATH)))
        self.setMenuWidget(snake_theme.HeaderBar(
            "Snake's SoundPad", f"Plays through “{MIC_DESC}” so voice chat hears it", ICON_PATH))
        self.resize(820, 560)
        self.setAcceptDrops(True)

        self._build_toolbar()
        self._build_body()
        self._build_tray()

        self.server = CommandServer(self)
        self.server.command.connect(self.handle_command)

        self.refresh_table()
        self.refresh_mics()
        self.apply_passthrough()
        self.apply_default_mic()

        # Keep the play/stop indicator honest
        self.poll = QTimer(self, interval=300, timeout=self._update_status)
        self.poll.start()

    # ---------- UI construction ----------

    def _build_toolbar(self) -> None:
        tb = QToolBar("Main", self)
        tb.setMovable(False)
        tb.setToolButtonStyle(Qt.ToolButtonTextBesideIcon)
        self.addToolBar(tb)

        def act(text, icon, slot, shortcut=None):
            a = QAction(QIcon.fromTheme(icon), text, self)
            a.triggered.connect(slot)
            if shortcut:
                a.setShortcut(QKeySequence(shortcut))
            tb.addAction(a)
            return a

        act("Add files", "list-add", self.add_files, "Ctrl+O")
        act("Add folder", "folder-open", self.add_folder, "Ctrl+Shift+O")
        act("Remove", "list-remove", self.remove_selected, "Delete")
        tb.addSeparator()
        act("Move up", "go-up", lambda: self.move_selected(-1), "Ctrl+Up")
        act("Move down", "go-down", lambda: self.move_selected(1), "Ctrl+Down")
        tb.addSeparator()
        self.search = QLineEdit(placeholderText="Search sounds…  (Ctrl+F)")
        self.search.setClearButtonEnabled(True)
        self.search.textChanged.connect(self.apply_filter)
        self.search.returnPressed.connect(self.play_first_visible)
        tb.addWidget(self.search)
        f = QAction(self, shortcut=QKeySequence("Ctrl+F"))
        f.triggered.connect(lambda: (self.search.setFocus(), self.search.selectAll()))
        self.addAction(f)

    def _build_body(self) -> None:
        central = QWidget(objectName="root")
        root = QVBoxLayout(central)
        root.setContentsMargins(14, 12, 14, 12)
        root.setSpacing(10)

        self.table = QTableWidget(0, 4)
        self.table.setHorizontalHeaderLabels(["#", "Name", "Vol %", "File"])
        self.table.verticalHeader().hide()
        self.table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.ExtendedSelection)
        self.table.setEditTriggers(QAbstractItemView.EditKeyPressed | QAbstractItemView.SelectedClicked)
        self.table.setAlternatingRowColors(True)
        h = self.table.horizontalHeader()
        h.setSectionResizeMode(COL_NUM, QHeaderView.ResizeToContents)
        h.setSectionResizeMode(COL_NAME, QHeaderView.Stretch)
        h.setSectionResizeMode(COL_VOL, QHeaderView.ResizeToContents)
        h.setSectionResizeMode(COL_PATH, QHeaderView.Stretch)
        self.table.cellDoubleClicked.connect(lambda r, c: self.play_index(r))
        self.table.itemChanged.connect(self._on_item_changed)
        self.table.setContextMenuPolicy(Qt.CustomContextMenu)
        self.table.customContextMenuRequested.connect(self._context_menu)
        enter = QAction(self.table, shortcut=QKeySequence(Qt.Key_Return))
        enter.setShortcutContext(Qt.WidgetShortcut)
        enter.triggered.connect(self.play_selected)
        self.table.addAction(enter)
        root.addWidget(self.table, 1)

        # Transport
        row = QHBoxLayout()
        self.play_btn = QPushButton(QIcon.fromTheme("media-playback-start"), "Play", objectName="primary")
        self.play_btn.clicked.connect(self.play_selected)
        self.stop_btn = QPushButton(QIcon.fromTheme("media-playback-stop"), "Stop  (Esc)")
        self.stop_btn.clicked.connect(self.stop)
        esc = QAction(self, shortcut=QKeySequence(Qt.Key_Escape))
        esc.triggered.connect(self.stop)
        self.addAction(esc)
        self.rand_btn = QPushButton(QIcon.fromTheme("media-playlist-shuffle"), "Random")
        self.rand_btn.clicked.connect(self.play_random)
        self.status = QLabel(objectName="accent")
        row.addWidget(self.play_btn)
        row.addWidget(self.stop_btn)
        row.addWidget(self.rand_btn)
        row.addSpacing(12)
        row.addWidget(self.status, 1)
        root.addLayout(row)

        # Settings
        box = QGroupBox("Output")
        g = QGridLayout(box)

        g.addWidget(QLabel("Volume others hear:"), 0, 0)
        self.mic_vol = self._slider(self.s.mic_volume, 200)
        self.mic_vol_lbl = QLabel()
        self.mic_vol.valueChanged.connect(self._on_mic_vol)
        g.addWidget(self.mic_vol, 0, 1)
        g.addWidget(self.mic_vol_lbl, 0, 2)

        self.mon_chk = QCheckBox("Hear sounds myself:")
        self.mon_chk.setChecked(self.s.monitor_enabled)
        self.mon_chk.toggled.connect(self._on_mon_toggle)
        g.addWidget(self.mon_chk, 1, 0)
        self.mon_vol = self._slider(self.s.monitor_volume, 200)
        self.mon_vol_lbl = QLabel()
        self.mon_vol.valueChanged.connect(self._on_mon_vol)
        g.addWidget(self.mon_vol, 1, 1)
        g.addWidget(self.mon_vol_lbl, 1, 2)

        self.pass_chk = QCheckBox("Pass my mic through:")
        self.pass_chk.setChecked(self.s.mic_passthrough)
        self.pass_chk.toggled.connect(self._on_pass_toggle)
        g.addWidget(self.pass_chk, 2, 0)
        self.mic_combo = QComboBox()
        self.mic_combo.currentIndexChanged.connect(self._on_mic_changed)
        g.addWidget(self.mic_combo, 2, 1)
        refresh = QPushButton(QIcon.fromTheme("view-refresh"), "" if QIcon.hasThemeIcon("view-refresh") else "↻")
        refresh.setToolTip("Refresh input devices")
        refresh.clicked.connect(self.refresh_mics)
        g.addWidget(refresh, 2, 2)

        self.overlap_chk = QCheckBox("Allow overlapping sounds (don't stop the previous one)")
        self.overlap_chk.setChecked(self.s.overlap)
        self.overlap_chk.toggled.connect(lambda v: self._set("overlap", v))
        g.addWidget(self.overlap_chk, 3, 0, 1, 3)

        self.default_chk = QCheckBox(f"Make {MIC_DESC} the system default microphone while running "
                                     "(for games with no input device setting)")
        self.default_chk.setChecked(self.s.make_default_mic)
        self.default_chk.toggled.connect(self._on_default_toggle)
        g.addWidget(self.default_chk, 4, 0, 1, 3)

        hint = QLabel(f"In Discord / your game, set the input device to <b>{MIC_DESC}</b> "
                      "(or leave it on <i>Default</i> with the option above). Restart the game if it "
                      "was already running. Tip: disable Discord's noise suppression &amp; echo "
                      "cancellation for sounds, or they may get filtered out.")
        hint.setWordWrap(True)
        hint.setObjectName("hint")
        g.addWidget(hint, 5, 0, 1, 3)
        root.addWidget(box)

        self._on_mic_vol(self.mic_vol.value())
        self._on_mon_vol(self.mon_vol.value())
        self.mon_vol.setEnabled(self.s.monitor_enabled)
        self.mic_combo.setEnabled(self.s.mic_passthrough)

        self.setCentralWidget(central)

    def _slider(self, value: int, maximum: int) -> QSlider:
        sl = QSlider(Qt.Horizontal)
        sl.setRange(0, maximum)
        sl.setValue(value)
        return sl

    def _build_tray(self) -> None:
        self.tray = None
        if not QSystemTrayIcon.isSystemTrayAvailable():
            return
        self.tray = QSystemTrayIcon(self.windowIcon(), self)
        self.tray.setToolTip("Snake's SoundPad")
        menu = QMenu()
        menu.addAction("Show", self.show_window)
        menu.addAction("Stop sound", self.stop)
        menu.addSeparator()
        menu.addAction("Quit", self.quit)
        self.tray.setContextMenu(menu)
        self.tray.activated.connect(
            lambda reason: self.toggle_window() if reason == QSystemTrayIcon.Trigger else None)
        self.tray.show()

    # ---------- table ----------

    def refresh_table(self) -> None:
        self._populating = True
        self.table.setRowCount(len(self.lib.sounds))
        for i, snd in enumerate(self.lib.sounds):
            num = QTableWidgetItem(str(i + 1))
            num.setFlags(num.flags() & ~Qt.ItemIsEditable)
            num.setTextAlignment(Qt.AlignCenter)
            name = QTableWidgetItem(snd.name)
            vol = QTableWidgetItem(str(snd.volume))
            vol.setTextAlignment(Qt.AlignCenter)
            path = QTableWidgetItem(snd.path)
            path.setFlags(path.flags() & ~Qt.ItemIsEditable)
            path.setToolTip(snd.path)
            if not Path(snd.path).exists():
                path.setForeground(snake_theme.color(snake_theme.ERROR_SOFT))
                path.setToolTip("File not found: " + snd.path)
            for c, it in enumerate((num, name, vol, path)):
                self.table.setItem(i, c, it)
        self._populating = False
        self.apply_filter(self.search.text())

    def _on_item_changed(self, item: QTableWidgetItem) -> None:
        if self._populating:
            return
        snd = self.lib.sounds[item.row()]
        if item.column() == COL_NAME:
            snd.name = item.text().strip() or Path(snd.path).stem
        elif item.column() == COL_VOL:
            try:
                snd.volume = max(0, min(200, int(item.text())))
            except ValueError:
                pass
        self.lib.save()
        self.refresh_table()

    def apply_filter(self, text: str) -> None:
        t = text.lower()
        for i, snd in enumerate(self.lib.sounds):
            self.table.setRowHidden(i, bool(t) and t not in snd.name.lower())

    def selected_rows(self) -> list[int]:
        return sorted({i.row() for i in self.table.selectedIndexes()})

    def _context_menu(self, pos) -> None:
        row = self.table.rowAt(pos.y())
        if row < 0:
            return
        m = QMenu(self)
        m.addAction("Play", lambda: self.play_index(row))
        m.addAction("Rename", lambda: self.table.editItem(self.table.item(row, COL_NAME)))
        m.addAction("Set volume", lambda: self.table.editItem(self.table.item(row, COL_VOL)))
        m.addAction("Copy hotkey command",
                    lambda: QApplication.clipboard().setText(f"snakepad play {row + 1}"))
        m.addSeparator()
        m.addAction("Remove", self.remove_selected)
        m.exec(self.table.viewport().mapToGlobal(pos))

    # ---------- adding / removing ----------

    def add_paths(self, paths: list[str]) -> int:
        added = 0
        for p in paths:
            pp = Path(p)
            if pp.is_dir():
                for f in sorted(pp.rglob("*")):
                    if f.is_file() and is_audio_file(f):
                        added += self.lib.add(str(f))
            elif pp.is_file():
                added += self.lib.add(str(pp))
        if added:
            self.lib.save()
            self.refresh_table()
        return added

    def add_files(self) -> None:
        exts = " ".join("*" + e for e in sorted(AUDIO_EXTS))
        files, _ = QFileDialog.getOpenFileNames(
            self, "Add sounds", str(Path.home()), f"Audio files ({exts});;All files (*)")
        self.add_paths(files)

    def add_folder(self) -> None:
        d = QFileDialog.getExistingDirectory(self, "Add folder (recursive)", str(Path.home()))
        if d:
            n = self.add_paths([d])
            self.status.setText(f"Added {n} sound(s)")

    def remove_selected(self) -> None:
        rows = self.selected_rows()
        if not rows:
            return
        for r in reversed(rows):
            del self.lib.sounds[r]
        self.lib.save()
        self.refresh_table()

    def move_selected(self, delta: int) -> None:
        rows = self.selected_rows()
        if len(rows) != 1:
            return
        r, n = rows[0], rows[0] + delta
        if not 0 <= n < len(self.lib.sounds):
            return
        s = self.lib.sounds
        s[r], s[n] = s[n], s[r]
        self.lib.save()
        self.refresh_table()
        self.table.selectRow(n)

    def dragEnterEvent(self, e) -> None:
        if e.mimeData().hasUrls():
            e.acceptProposedAction()

    def dropEvent(self, e) -> None:
        paths = [u.toLocalFile() for u in e.mimeData().urls() if u.isLocalFile()]
        n = self.add_paths(paths)
        self.status.setText(f"Added {n} sound(s)")

    # ---------- playback ----------

    def play_index(self, i: int) -> bool:
        if not 0 <= i < len(self.lib.sounds):
            return False
        snd = self.lib.sounds[i]
        if not Path(snd.path).exists():
            self.status.setText(f"Missing file: {snd.path}")
            return False
        self.player.play(
            snd.path,
            mic_volume=round(self.s.mic_volume * snd.volume / 100),
            monitor_volume=round(self.s.monitor_volume * snd.volume / 100),
            monitor=self.s.monitor_enabled,
            overlap=self.s.overlap,
        )
        self._now = snd.name
        self.status.setText(f"▶ {snd.name}")
        return True

    def play_selected(self) -> None:
        rows = self.selected_rows()
        if rows:
            self.play_index(rows[0])

    def play_first_visible(self) -> None:
        for i in range(self.table.rowCount()):
            if not self.table.isRowHidden(i):
                self.play_index(i)
                return

    def play_random(self) -> bool:
        if not self.lib.sounds:
            return False
        return self.play_index(random.randrange(len(self.lib.sounds)))

    def stop(self) -> None:
        self.player.stop()
        self.status.setText("Stopped")

    def _update_status(self) -> None:
        if self.status.text().startswith("▶") and not self.player.is_playing():
            self.status.setText("")

    # ---------- settings ----------

    def _set(self, key: str, value) -> None:
        setattr(self.s, key, value)
        self.lib.save()

    def _on_mic_vol(self, v: int) -> None:
        self.mic_vol_lbl.setText(f"{v}%")
        self._set("mic_volume", v)

    def _on_mon_vol(self, v: int) -> None:
        self.mon_vol_lbl.setText(f"{v}%")
        self._set("monitor_volume", v)

    def _on_mon_toggle(self, v: bool) -> None:
        self.mon_vol.setEnabled(v)
        self._set("monitor_enabled", v)

    def _on_pass_toggle(self, v: bool) -> None:
        self.mic_combo.setEnabled(v)
        self._set("mic_passthrough", v)
        self.apply_passthrough()

    def _on_default_toggle(self, v: bool) -> None:
        self._set("make_default_mic", v)
        self.apply_default_mic()

    def apply_default_mic(self) -> None:
        try:
            self.devices.set_as_default(self.s.make_default_mic)
        except AudioError as e:
            QMessageBox.warning(self, "Default microphone", str(e))

    def _on_mic_changed(self, idx: int) -> None:
        if self._populating or idx < 0:
            return
        self._set("mic_source", self.mic_combo.itemData(idx))
        self.apply_passthrough()

    def refresh_mics(self) -> None:
        try:
            sources = list_input_sources()
            # Once our mic is the default, the real one is whatever was default before
            default = self.devices.original_default or default_source()
        except AudioError as e:
            self.status.setText(str(e))
            return
        wanted = self.s.mic_source or default
        self._populating = True
        self.mic_combo.clear()
        for src in sources:
            self.mic_combo.addItem(src.description, src.name)
        idx = self.mic_combo.findData(wanted)
        self.mic_combo.setCurrentIndex(idx if idx >= 0 else 0)
        self._populating = False

    def apply_passthrough(self) -> None:
        src = self.mic_combo.currentData() if self.s.mic_passthrough else None
        try:
            self.devices.set_mic_passthrough(src)
        except AudioError as e:
            QMessageBox.warning(self, "Mic passthrough", str(e))

    # ---------- IPC ----------

    def handle_command(self, line: str, reply) -> None:
        cmd, _, arg = line.partition(" ")
        cmd, arg = cmd.lower(), arg.strip()
        if cmd == "play":
            i = self.lib.find(arg) if arg else None
            reply("ok" if i is not None and self.play_index(i) else f"error: no sound '{arg}'")
        elif cmd == "random":
            reply("ok" if self.play_random() else "error: library empty")
        elif cmd == "stop":
            self.stop()
            reply("ok")
        elif cmd == "toggle":
            # play arg, or stop if anything is playing
            if self.player.is_playing():
                self.stop()
                reply("ok")
            else:
                i = self.lib.find(arg) if arg else None
                reply("ok" if i is not None and self.play_index(i) else f"error: no sound '{arg}'")
        elif cmd == "list":
            reply("\n".join(f"{i + 1}\t{s.name}" for i, s in enumerate(self.lib.sounds)) or "(empty)")
        elif cmd == "show":
            self.show_window()
            reply("ok")
        elif cmd == "quit":
            reply("ok")
            QTimer.singleShot(0, self.quit)
        else:
            reply(f"error: unknown command '{cmd}'")

    # ---------- window lifecycle ----------

    def show_window(self) -> None:
        self.showNormal()
        self.raise_()
        self.activateWindow()

    def toggle_window(self) -> None:
        if self.isVisible():
            self.hide()
        else:
            self.show_window()

    def quit(self) -> None:
        self._really_quit = True
        self.close()
        QApplication.quit()

    def closeEvent(self, e) -> None:
        if self.tray and not self._really_quit:
            # Keep running in the tray so hotkeys keep working
            self.hide()
            if not getattr(self, "_tray_hint_shown", False):
                self.tray.showMessage("Snake's SoundPad", "Still running in the tray. Right-click it to quit.")
                self._tray_hint_shown = True
            e.ignore()
            return
        e.accept()
        QApplication.quit()
