"""The hub window: a grid of every Snake tool. Click one to open it."""

from __future__ import annotations

import sys
from pathlib import Path

from PySide6.QtCore import QProcess, QProcessEnvironment, QSize, Qt, QTimer, QUrl, Signal
from PySide6.QtGui import QDesktopServices, QIcon, QKeySequence, QShortcut
from PySide6.QtWidgets import (
    QApplication, QCheckBox, QDialog, QFrame, QGridLayout, QHBoxLayout, QLabel, QLineEdit, QMainWindow,
    QMenu, QMessageBox, QPlainTextEdit, QPushButton, QScrollArea, QSizePolicy, QVBoxLayout, QWidget,
)

from . import APP_NAME, __version__, snake_theme
from .registry import OS, Tool, installer_python, kit_root, load_tools, pid_alive

ASSETS = Path(__file__).resolve().parent / "assets"
ICON_PATH = ASSETS / "icon.svg"
TILE_W, TILE_H = 212, 196
OS_NAMES = {"linux": "Linux", "windows": "Windows", "macos": "macOS"}

T = snake_theme
HUB_STYLE = f"""
QFrame#titleBar {{ background: {T.TITLE}; border-bottom: 1px solid {T.BORDER}; }}
QLabel#titleName {{ color: {T.FG2}; font-size: 9.5pt; }}
QLineEdit#commandCenter {{
    background: {T.BUTTON2}; border: 1px solid {T.BORDER}; border-radius: 6px; color: {T.FG};
    padding: 3px 10px; min-height: 18px; font-size: 9.5pt;
}}
QLineEdit#commandCenter:focus {{ border-color: {T.ACCENT}; background: {T.INPUT}; }}
QLabel#heroTitle {{ font-size: 28pt; font-weight: 300; color: {T.FG}; }}
QLabel#heroSub {{ font-size: 12pt; color: {T.FG2}; }}
QLabel#section {{ color: {T.FG2}; font-size: 8.5pt; font-weight: 700; letter-spacing: 1px; }}
QFrame#tile {{ background: {T.SIDE}; border: 1px solid {T.BORDER}; border-radius: 10px; }}
QFrame#tile:hover {{ background: {T.HOVER}; border-color: {T.BORDER2}; }}
QFrame#tile[installed="false"] QLabel#tileName {{ color: {T.FG2}; }}
QFrame#tile:focus {{ border-color: {T.ACCENT}; }}
QLabel#tileName {{ font-size: 11pt; font-weight: 600; color: {T.FG}; }}
QLabel#tileTag {{ color: {T.FG2}; font-size: 9pt; }}
QLabel#pill {{ border-radius: 8px; padding: 1px 8px; font-size: 8pt; font-weight: 600; }}
QLabel#pill[kind="running"] {{ background: {T.SELECTION}; color: {T.HIGHLIGHT}; }}
QLabel#pill[kind="installed"] {{ background: transparent; color: {T.FG3}; }}
QLabel#pill[kind="available"] {{ background: {T.BUTTON2}; color: {T.FG2}; }}
QLabel#pill[kind="unsupported"] {{ background: transparent; color: {T.FG3}; }}
QFrame#statusBar {{ background: {T.TITLE}; border-top: 1px solid {T.BORDER}; }}
QLabel#statusAccent {{ background: {T.ACCENT}; color: #ffffff; padding: 0 10px; }}
QLabel#statusText {{ color: {T.FG2}; padding: 0 8px; font-size: 9pt; }}
QPlainTextEdit#log {{ font-family: 'JetBrains Mono', 'Cascadia Code', 'DejaVu Sans Mono', monospace; font-size: 9pt; }}
"""


class Tile(QFrame):
    """One tool: its icon, name and state. Click to open; right-click for more."""

    activated = Signal(object)
    menu_requested = Signal(object, object)

    def __init__(self, tool: Tool):
        super().__init__()
        self.tool = tool
        self.setObjectName("tile")
        self.setFixedSize(TILE_W, TILE_H)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setToolTip(tool.description)

        lay = QVBoxLayout(self)
        lay.setContentsMargins(14, 16, 14, 12)
        lay.setSpacing(4)
        self.icon = QLabel(alignment=Qt.AlignmentFlag.AlignCenter)
        if tool.icon:
            self.icon.setPixmap(QIcon(str(tool.icon)).pixmap(QSize(76, 76)))
        lay.addWidget(self.icon)
        lay.addSpacing(6)
        name = QLabel(tool.name.replace("Snake's ", ""), objectName="tileName", alignment=Qt.AlignmentFlag.AlignCenter)
        lay.addWidget(name)
        tag = QLabel(tool.tagline, objectName="tileTag", alignment=Qt.AlignmentFlag.AlignCenter)
        lay.addWidget(tag)
        lay.addStretch(1)
        self.pill = QLabel(objectName="pill", alignment=Qt.AlignmentFlag.AlignCenter)
        row = QHBoxLayout()
        row.addStretch(1)
        row.addWidget(self.pill)
        row.addStretch(1)
        lay.addLayout(row)
        self.set_running(False)

    def set_running(self, running: bool) -> None:
        t = self.tool
        if running:
            kind, text = "running", "● Running"
        elif t.installed:
            kind, text = "installed", "Installed"
        elif not t.supported:
            kind, text = "unsupported", f"{' / '.join(OS_NAMES.get(p, p) for p in t.platforms)} only"
        elif t.installable:
            kind, text = "available", "Click to install"
        else:
            kind, text = "unsupported", "Not in this kit"
        self.setProperty("installed", "true" if t.installed else "false")
        self.pill.setProperty("kind", kind)
        self.pill.setText(text)
        snake_theme.repolish(self)
        snake_theme.repolish(self.pill)
        if not t.installed and t.icon:
            # Not installed: the icon is shown faded, like a disabled item.
            self.icon.setPixmap(QIcon(str(t.icon)).pixmap(QSize(76, 76), QIcon.Mode.Disabled))

    def mouseReleaseEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton and self.rect().contains(e.position().toPoint()):
            self.activated.emit(self.tool)
        super().mouseReleaseEvent(e)

    def keyPressEvent(self, e):
        if e.key() in (Qt.Key.Key_Return, Qt.Key.Key_Enter, Qt.Key.Key_Space):
            self.activated.emit(self.tool)
        else:
            super().keyPressEvent(e)

    def contextMenuEvent(self, e):
        self.menu_requested.emit(self.tool, e.globalPos())


class InstallDialog(QDialog):
    """Runs install.py and shows what it says."""

    def __init__(self, parent, title: str, args: list[str]):
        super().__init__(parent)
        self.setWindowTitle(title)
        self.resize(720, 460)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(16, 14, 16, 14)
        head = QLabel(title, objectName="heading")
        lay.addWidget(head)
        self.log = QPlainTextEdit(objectName="log", readOnly=True)
        self.log.setLineWrapMode(QPlainTextEdit.LineWrapMode.NoWrap)
        lay.addWidget(self.log, 1)
        row = QHBoxLayout()
        self.status = QLabel("Working…", objectName="status")
        row.addWidget(self.status, 1)
        self.close_btn = QPushButton("Close", objectName="primary")
        self.close_btn.setEnabled(False)
        self.close_btn.clicked.connect(self.accept)
        row.addWidget(self.close_btn)
        lay.addLayout(row)

        self.proc = QProcess(self)
        self.proc.setProcessChannelMode(QProcess.ProcessChannelMode.MergedChannels)
        self.proc.readyReadStandardOutput.connect(self._read)
        self.proc.finished.connect(self._done)
        self.proc.errorOccurred.connect(lambda _e: self._done(-1, None))
        root = kit_root()
        env = QProcessEnvironment.systemEnvironment()
        env.insert("PYTHONUNBUFFERED", "1")
        self.proc.setProcessEnvironment(env)
        self.proc.setWorkingDirectory(str(root))
        self.proc.start(installer_python(), [str(root / "install.py"), *args, "--yes"])

    def _read(self):
        text = bytes(self.proc.readAllStandardOutput()).decode(errors="replace")
        self.log.moveCursor(self.log.textCursor().MoveOperation.End)
        self.log.insertPlainText(text)
        self.log.ensureCursorVisible()

    def _done(self, code, _status):
        self._read()
        self.close_btn.setEnabled(True)
        ok = code == 0
        self.status.setText("Done." if ok else "Finished with problems. The log above says what went wrong.")
        self.status.setProperty("state", "done" if ok else "failed")
        snake_theme.repolish(self.status)

    def reject(self):
        if self.proc.state() != QProcess.ProcessState.NotRunning:
            return  # let it finish; stopping a build halfway leaves a mess
        super().reject()


class Hub(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle(APP_NAME)
        self.setWindowIcon(QIcon(str(ICON_PATH)))
        self.resize(1000, 720)
        self.setMinimumSize(560, 460)
        self.setStyleSheet(HUB_STYLE)
        self.running: dict[str, int] = {}
        self.tiles: list[Tile] = []

        root = QWidget(objectName="root")
        self.setCentralWidget(root)
        outer = QVBoxLayout(root)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)
        outer.addWidget(self._title_bar())

        self.scroll = QScrollArea(widgetResizable=True)
        self.scroll.setFrameShape(QFrame.Shape.NoFrame)
        page = QWidget()
        self.page_lay = QVBoxLayout(page)
        self.page_lay.setContentsMargins(48, 36, 48, 36)
        self.page_lay.setSpacing(0)
        self.page_lay.addLayout(self._hero())
        self.page_lay.addSpacing(30)
        section = QHBoxLayout()
        self.section_label = QLabel("TOOLS", objectName="section")
        section.addWidget(self.section_label)
        section.addStretch(1)
        self.install_all_btn = QPushButton("Install the whole kit", objectName="primary")
        self.install_all_btn.clicked.connect(self.install_all)
        section.addWidget(self.install_all_btn)
        self.page_lay.addLayout(section)
        self.page_lay.addSpacing(12)
        self.grid_host = QWidget()
        self.grid = QGridLayout(self.grid_host)
        self.grid.setContentsMargins(0, 0, 0, 0)
        self.grid.setSpacing(16)
        self.grid.setAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignTop)
        self.page_lay.addWidget(self.grid_host)
        self.empty = QLabel(objectName="muted", wordWrap=True)
        self.empty.hide()
        self.page_lay.addWidget(self.empty)
        self.page_lay.addStretch(1)
        self.scroll.setWidget(page)
        outer.addWidget(self.scroll, 1)
        outer.addWidget(self._status_bar())

        QShortcut(QKeySequence("Ctrl+K"), self, activated=lambda: (self.search.setFocus(), self.search.selectAll()))
        QShortcut(QKeySequence("Ctrl+F"), self, activated=lambda: (self.search.setFocus(), self.search.selectAll()))
        QShortcut(QKeySequence("F5"), self, activated=self.reload)
        QShortcut(QKeySequence.StandardKey.Quit, self, activated=self.close)
        self.poll = QTimer(self, interval=1500, timeout=self._poll_running)
        self.poll.start()
        self.reload()

    # ---- chrome, after Snake's Code -------------------------------------------------
    def _title_bar(self) -> QFrame:
        bar = QFrame(objectName="titleBar")
        bar.setFixedHeight(38)
        lay = QHBoxLayout(bar)
        lay.setContentsMargins(12, 0, 12, 0)
        lay.setSpacing(8)
        logo = QLabel()
        logo.setPixmap(QIcon(str(ICON_PATH)).pixmap(QSize(20, 20)))
        lay.addWidget(logo)
        lay.addWidget(QLabel(APP_NAME, objectName="titleName"))
        lay.addStretch(1)
        self.search = QLineEdit(objectName="commandCenter", placeholderText="Search tools   (Ctrl+K)")
        self.search.setClearButtonEnabled(True)
        self.search.setFixedWidth(380)
        self.search.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.search.textChanged.connect(self._layout_tiles)
        self.search.returnPressed.connect(self._open_first_match)
        lay.addWidget(self.search)
        lay.addStretch(1)
        refresh = QPushButton("↻", objectName="flat", toolTip="Refresh (F5)")
        refresh.clicked.connect(self.reload)
        lay.addWidget(refresh)
        return bar

    def _hero(self) -> QHBoxLayout:
        row = QHBoxLayout()
        row.setSpacing(22)
        logo = QLabel()
        logo.setPixmap(QIcon(str(ICON_PATH)).pixmap(QSize(88, 88)))
        row.addWidget(logo)
        text = QVBoxLayout()
        text.setSpacing(2)
        text.addStretch(1)
        text.addWidget(QLabel(APP_NAME, objectName="heroTitle"))
        text.addWidget(QLabel("Every Snake tool in one place. Pick one to get started.", objectName="heroSub"))
        text.addStretch(1)
        row.addLayout(text, 1)
        return row

    def _status_bar(self) -> QFrame:
        bar = QFrame(objectName="statusBar")
        bar.setFixedHeight(24)
        lay = QHBoxLayout(bar)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(0)
        accent = QLabel(f"  {OS_NAMES[OS]}", objectName="statusAccent")
        accent.setSizePolicy(QSizePolicy.Policy.Fixed, QSizePolicy.Policy.Expanding)
        lay.addWidget(accent)
        self.status = QLabel(objectName="statusText")
        lay.addWidget(self.status, 1)
        lay.addWidget(QLabel(f"v{__version__}", objectName="statusText"))
        return bar

    # ---- tools -----------------------------------------------------------------------
    def reload(self) -> None:
        self.tools = load_tools()
        for tile in self.tiles:
            tile.deleteLater()
        self.tiles = []
        for tool in self.tools:
            tile = Tile(tool)
            tile.activated.connect(self.activate)
            tile.menu_requested.connect(self.tool_menu)
            self.tiles.append(tile)
        installed = sum(t.installed for t in self.tools)
        supported = sum(t.supported for t in self.tools)
        self.status.setText(f"{installed} of {supported} tools installed")
        missing = [t for t in self.tools if t.installable and not t.installed]
        self.install_all_btn.setVisible(bool(missing))
        self.install_all_btn.setText(f"Install the whole kit ({len(missing)} more)" if installed else "Install the whole kit")
        self._layout_tiles()
        self._poll_running()

    def _visible_tiles(self) -> list[Tile]:
        words = self.search.text().lower().split()
        def match(t: Tool) -> bool:
            hay = f"{t.name} {t.tagline} {t.description} {t.id}".lower()
            return all(w in hay for w in words)
        return [tile for tile in self.tiles if match(tile.tool)]

    def _layout_tiles(self) -> None:
        while self.grid.count():
            item = self.grid.takeAt(0)
            if item.widget():
                item.widget().hide()
        tiles = self._visible_tiles()
        width = self.scroll.viewport().width() - 96
        columns = max(1, (width + 16) // (TILE_W + 16))
        for i, tile in enumerate(tiles):
            self.grid.addWidget(tile, i // columns, i % columns)
            tile.show()
        if not self.tools:
            self.empty.setText("No tools found. Run install.py from the Snake's Suite kit to install some.")
        elif not tiles:
            self.empty.setText(f"No tool matches “{self.search.text()}”.")
        self.empty.setVisible(not tiles)

    def resizeEvent(self, e):
        super().resizeEvent(e)
        QTimer.singleShot(0, self._layout_tiles)

    def _open_first_match(self) -> None:
        tiles = self._visible_tiles()
        if tiles:
            self.activate(tiles[0].tool)

    def activate(self, tool: Tool) -> None:
        if tool.installed:
            self.launch(tool)
        elif tool.installable:
            self.install(tool)
        elif not tool.supported:
            QMessageBox.information(self, tool.name, f"{tool.name} runs on "
                                    f"{', '.join(OS_NAMES.get(p, p) for p in tool.platforms)} only.")

    def launch(self, tool: Tool) -> None:
        m = tool.manifest or {}
        argv = m.get("launch") or []
        if not argv:
            return
        ok, pid = QProcess.startDetached(argv[0], argv[1:], m.get("cwd") or "")
        if ok:
            self.running[tool.id] = pid
            self._poll_running()
            self.status.setText(f"Opened {tool.name}")
        else:
            QMessageBox.warning(self, tool.name, f"{tool.name} could not be started.\n\n{argv[0]}\n\n"
                                "Try reinstalling it (right-click the tile).")

    def _poll_running(self) -> None:
        for tool_id, pid in list(self.running.items()):
            if not pid_alive(pid):
                del self.running[tool_id]
        for tile in self.tiles:
            tile.set_running(tile.tool.id in self.running)

    # ---- installing ------------------------------------------------------------------
    def _run_installer(self, title: str, args: list[str]) -> None:
        if not kit_root():
            QMessageBox.information(self, APP_NAME, "The Snake's Suite kit folder (with install.py) "
                                    "was not found, so tools cannot be installed from here.")
            return
        InstallDialog(self, title, args).exec()
        self.reload()

    def install(self, tool: Tool, desktop: bool = False) -> None:
        needs = "\n".join(f"  • {n}" for n in tool.needs)
        box = QMessageBox(self)
        box.setWindowTitle(f"Install {tool.name}")
        if tool.icon:
            box.setIconPixmap(QIcon(str(tool.icon)).pixmap(QSize(56, 56)))
        box.setText(f"Install {tool.name}?")
        box.setInformativeText(f"{tool.description}\n\nIt needs:\n{needs}" if needs else tool.description)
        shortcut = QCheckBox("Also put a shortcut on the desktop")
        shortcut.setChecked(desktop)
        box.setCheckBox(shortcut)
        box.setStandardButtons(QMessageBox.StandardButton.Cancel)
        go = box.addButton("Install", QMessageBox.ButtonRole.AcceptRole)
        go.setObjectName("primary")
        box.exec()
        if box.clickedButton() is go:
            self._run_installer(f"Installing {tool.name}", [tool.id] + (["--desktop"] if shortcut.isChecked() else []))

    def install_all(self) -> None:
        answer = QMessageBox.question(
            self, APP_NAME, "Install every tool this computer supports?\n\n"
            "Tools that need Rust or Node.js are skipped with a note if those are missing.")
        if answer == QMessageBox.StandardButton.Yes:
            self._run_installer("Installing the Snake's Suite kit", ["--all"])

    def uninstall(self, tool: Tool) -> None:
        answer = QMessageBox.question(self, tool.name, f"Remove {tool.name} from this computer?\n\n"
                                      "Your own files (projects, recordings, settings) are kept.")
        if answer == QMessageBox.StandardButton.Yes:
            self._run_installer(f"Removing {tool.name}", ["--uninstall", tool.id])

    def tool_menu(self, tool: Tool, pos) -> None:
        menu = QMenu(self)
        if tool.installed:
            menu.addAction("Open", lambda: self.launch(tool))
            menu.addSeparator()
            if tool.installable:
                menu.addAction("Reinstall / update", lambda: self.install(tool, (tool.manifest or {}).get("desktop_shortcut", False)))
                if not (tool.manifest or {}).get("desktop_shortcut"):
                    menu.addAction("Add a desktop shortcut", lambda: self._run_installer(
                        f"Adding a shortcut for {tool.name}", [tool.id, "--desktop"]))
            menu.addAction("Uninstall…", lambda: self.uninstall(tool))
        elif tool.installable:
            menu.addAction("Install…", lambda: self.install(tool))
        if tool.source and tool.source.is_dir():
            menu.addSeparator()
            menu.addAction("Show source folder", lambda: QDesktopServices.openUrl(QUrl.fromLocalFile(str(tool.source))))
        if menu.actions():
            menu.exec(pos)


def main() -> int:
    QApplication.setDesktopFileName("snakes-suite")
    app = QApplication(sys.argv)
    app.setApplicationName(APP_NAME)
    app.setApplicationVersion(__version__)
    snake_theme.apply(app, icon_path=ICON_PATH)
    hub = Hub()
    hub.show()
    return app.exec()
