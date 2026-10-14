"""The Snake's Suite window: a grid of every Snake tool. Click one to open it, or to install it.

Run from the one-file download, it installs itself on first use and downloads
ready-made tool packages from the release. Run from the source kit with no
release reachable, it builds tools with install.py instead.

    snakes-suite                     open the window
    snakes-suite --uninstall daw     remove a tool (what Windows' "Uninstall" button runs)
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

from PySide6.QtCore import (
    QObject, QProcess, QProcessEnvironment, QSize, Qt, QThread, QTimer, QUrl, Signal,
)
from PySide6.QtGui import QDesktopServices, QIcon, QImage, QKeySequence, QPainter, QPixmap, QShortcut
from PySide6.QtNetwork import QNetworkAccessManager, QNetworkReply, QNetworkRequest
from PySide6.QtWidgets import (
    QApplication, QCheckBox, QDialog, QFrame, QGridLayout, QHBoxLayout, QLabel, QLineEdit, QMainWindow,
    QMenu, QMessageBox, QPlainTextEdit, QProgressBar, QPushButton, QScrollArea, QSizePolicy, QStackedWidget,
    QVBoxLayout, QWidget,
)

from . import APP_NAME, __version__, packages, snake_theme
from . import integrate as ig
from .registry import OS, Tool, installer_python, kit_root, load_tools, pid_alive, remove_legacy

ASSETS = Path(__file__).resolve().parent / "assets"
ICON_PATH = ASSETS / "icon.svg"
TILE_W, TILE_H = 212, 196
OS_NAMES = {"linux": "Linux", "windows": "Windows", "macos": "macOS"}


def human_size(n: int) -> str:
    return f"{n / 1e6:.0f} MB" if n >= 1e6 else f"{max(n, 1) / 1e3:.0f} KB"


def greyed(pix: QPixmap) -> QPixmap:
    """A faded, colourless copy of an icon: how a tool that is not installed yet looks."""
    image = pix.toImage().convertToFormat(QImage.Format.Format_ARGB32)
    grey = image.convertToFormat(QImage.Format.Format_Grayscale8).convertToFormat(QImage.Format.Format_ARGB32)
    grey.setAlphaChannel(image.convertToFormat(QImage.Format.Format_Alpha8))
    out = QPixmap(pix.size())
    out.setDevicePixelRatio(pix.devicePixelRatio())
    out.fill(Qt.GlobalColor.transparent)
    painter = QPainter(out)
    painter.setOpacity(0.45)
    painter.drawImage(0, 0, grey)
    painter.end()
    return out


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
QFrame#banner {{ background: #18241b; border: 1px solid #2d5a3a; border-radius: 8px; }}
QFrame#oldBanner {{ background: #2a2414; border: 1px solid #5a4a22; border-radius: 8px; }}
QFrame#tile {{ background: {T.SIDE}; border: 1px solid {T.BORDER}; border-radius: 10px; }}
QFrame#tile:hover {{ background: {T.HOVER}; border-color: {T.BORDER2}; }}
QFrame#tile[installed="false"] QLabel#tileName {{ color: {T.FG2}; }}
QFrame#tile:focus {{ border-color: {T.ACCENT}; }}
QLabel#tileName {{ font-size: 11pt; font-weight: 600; color: {T.FG}; }}
QLabel#tileTag {{ color: {T.FG2}; font-size: 9pt; }}
QLabel#pill {{ border-radius: 8px; padding: 1px 8px; font-size: 8pt; font-weight: 600; }}
QLabel#pill[kind="running"] {{ background: {T.SELECTION}; color: {T.HIGHLIGHT}; }}
QLabel#pill[kind="installed"] {{ background: transparent; color: {T.FG3}; }}
QLabel#pill[kind="update"] {{ background: {T.SELECTION}; color: {T.HIGHLIGHT}; }}
QLabel#pill[kind="available"] {{ background: {T.BUTTON2}; color: {T.FG2}; }}
QLabel#pill[kind="unsupported"] {{ background: transparent; color: {T.FG3}; }}
QFrame#statusBar {{ background: {T.TITLE}; border-top: 1px solid {T.BORDER}; }}
QLabel#statusAccent {{ background: {T.ACCENT}; color: #ffffff; padding: 0 10px; }}
QLabel#statusText {{ color: {T.FG2}; padding: 0 8px; font-size: 9pt; }}
QPushButton#statusButton {{ background: {T.SELECTION}; color: {T.HIGHLIGHT}; border: none; border-radius: 0;
                            padding: 0 10px; font-size: 9pt; }}
QPushButton#statusButton:hover {{ background: {T.ACCENT}; color: #ffffff; }}
QPlainTextEdit#log {{ font-family: 'JetBrains Mono', 'Cascadia Code', 'DejaVu Sans Mono', monospace; font-size: 9pt; }}
QFrame#row {{ background: {T.SIDE}; border: 1px solid {T.BORDER}; border-radius: 8px; }}
"""


# =========================================================================== tiles
class Tile(QFrame):
    """One tool: its icon, name and state. Click to open; right-click for more."""

    activated = Signal(object)
    install_requested = Signal(object)
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
        lay.addWidget(self.icon)
        lay.addSpacing(6)
        lay.addWidget(QLabel(tool.name.replace("Snake's ", ""), objectName="tileName",
                             alignment=Qt.AlignmentFlag.AlignCenter))
        lay.addWidget(QLabel(tool.tagline, objectName="tileTag", alignment=Qt.AlignmentFlag.AlignCenter))
        lay.addStretch(1)
        self.pill = QLabel(objectName="pill", alignment=Qt.AlignmentFlag.AlignCenter)
        self.button = QPushButton(objectName="primary")  # Install / Update, for tools that need it
        self.button.setCursor(Qt.CursorShape.PointingHandCursor)
        self.button.setFocusPolicy(Qt.FocusPolicy.NoFocus)  # the tile itself takes Enter
        self.button.clicked.connect(lambda: self.install_requested.emit(self.tool))
        row = QHBoxLayout()
        row.addStretch(1)
        row.addWidget(self.pill)
        row.addWidget(self.button)
        row.addStretch(1)
        lay.addLayout(row)
        self.set_running(False)

    def set_running(self, running: bool) -> None:
        t = self.tool
        button = ""
        if running:
            kind, text = "running", "● Running"
        elif t.update_available:
            kind, text, button = "update", "Update available", "Update"
        elif t.installed:
            kind, text = "installed", "Installed"
        elif t.legacy:
            kind, text = "update", "Old version installed"
        elif not t.supported:
            kind, text = "unsupported", f"{' / '.join(OS_NAMES.get(p, p) for p in t.platforms)} only"
        elif t.downloadable:
            kind, text, button = "available", "", f"Install · {human_size(t.package.get('size', 0))}"
        elif t.buildable:
            kind, text, button = "available", "", "Install"
        else:
            kind, text = "unsupported", "Not available yet"
        self.setProperty("installed", "true" if t.installed or t.legacy else "false")
        self.pill.setProperty("kind", kind)
        self.pill.setText(text)
        self.pill.setVisible(not button)
        self.button.setText(button)
        self.button.setVisible(bool(button))
        snake_theme.repolish(self)
        snake_theme.repolish(self.pill)
        if t.icon and getattr(self, "_icon_state", None) != (t.installed or bool(t.legacy)):
            self._icon_state = t.installed or bool(t.legacy)
            pix = QIcon(str(t.icon)).pixmap(QSize(76, 76))
            self.icon.setPixmap(pix if self._icon_state else greyed(pix))  # not installed: grey until it is

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


# =========================================================================== downloading
class Download(QObject):
    """One file from the release into a temporary file, with progress."""

    progress = Signal(object, object)  # bytes so far, bytes in all (64-bit, so not int)
    done = Signal(str)  # empty on success, else what went wrong

    def __init__(self, nam: QNetworkAccessManager, url: str, dest: Path):
        super().__init__()
        self.dest = dest
        self.fh = open(dest, "wb")
        req = QNetworkRequest(QUrl(url))
        req.setAttribute(QNetworkRequest.Attribute.RedirectPolicyAttribute,
                         QNetworkRequest.RedirectPolicy.NoLessSafeRedirectPolicy)
        req.setHeader(QNetworkRequest.KnownHeaders.UserAgentHeader, f"SnakesSuite/{__version__}")
        self.reply = nam.get(req)
        self.reply.readyRead.connect(lambda: self.fh.write(bytes(self.reply.readAll())))
        self.reply.downloadProgress.connect(lambda got, total: self.progress.emit(got, total))
        self.reply.finished.connect(self._finished)

    def _finished(self):
        self.fh.write(bytes(self.reply.readAll()))
        self.fh.close()
        error = ""
        if self.reply.error() != QNetworkReply.NetworkError.NoError:
            error = self.reply.errorString()
        self.reply.deleteLater()
        self.done.emit(error)

    def abort(self):
        self.reply.abort()


class Job(QThread):
    """Runs a blocking install step (unpacking, registering) away from the window."""

    ok = Signal(list)
    failed = Signal(str)

    def __init__(self, work):
        super().__init__()
        self.work = work

    def run(self):
        try:
            self.ok.emit(list(self.work() or []))
        except Exception as e:  # noqa: BLE001 - shown to the user
            self.failed.emit(str(e) or e.__class__.__name__)


class ProgressRow(QFrame):
    def __init__(self, tool: Tool):
        super().__init__(objectName="row")
        lay = QHBoxLayout(self)
        lay.setContentsMargins(10, 8, 12, 8)
        lay.setSpacing(10)
        icon = QLabel()
        if tool.icon:
            icon.setPixmap(QIcon(str(tool.icon)).pixmap(QSize(36, 36)))
        lay.addWidget(icon)
        col = QVBoxLayout()
        col.setSpacing(4)
        top = QHBoxLayout()
        top.addWidget(QLabel(tool.name, objectName="heading"))
        top.addStretch(1)
        self.status = QLabel("Waiting", objectName="status")
        top.addWidget(self.status)
        col.addLayout(top)
        self.bar = QProgressBar(textVisible=False, maximum=1000)
        col.addWidget(self.bar)
        lay.addLayout(col, 1)

    def set(self, text: str, state: str = "", fraction: float | None = None):
        self.status.setText(text)
        self.status.setProperty("state", state)
        snake_theme.repolish(self.status)
        if fraction is None:
            self.bar.setRange(0, 0)  # busy
        else:
            self.bar.setRange(0, 1000)
            self.bar.setValue(int(fraction * 1000))


class InstallDialog(QDialog):
    """Pick tools, then download and install them one after another."""

    def __init__(self, parent, tools: list[Tool], chosen: set[str], *, desktop: bool = False, auto: bool = False):
        super().__init__(parent)
        self.setWindowTitle("Updating Snake tools" if auto else "Install Snake tools")
        self.auto = auto  # updating by itself: start at once, keep each tool's shortcuts, close when done
        self.resize(560, 520)
        self.tools = tools
        self.nam = QNetworkAccessManager(self)
        self.queue: list[Tool] = []
        self.rows: dict[str, ProgressRow] = {}
        self.failures = 0
        self.notes: list[str] = []
        self.current = None
        self.tmp = Path(tempfile.mkdtemp(prefix="snakes-suite-"))

        self.stack = QStackedWidget()
        outer = QVBoxLayout(self)
        outer.setContentsMargins(18, 16, 18, 14)
        outer.addWidget(self.stack, 1)

        # -- page 1: choose
        choose = QWidget()
        lay = QVBoxLayout(choose)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.addWidget(QLabel("Which tools would you like?", objectName="heading"))
        lay.addWidget(QLabel("Each one installs as a normal app with its own icon. You can add or remove "
                             "tools later from Snake's Suite.", objectName="muted", wordWrap=True))
        lay.addSpacing(6)
        self.checks: dict[str, QCheckBox] = {}
        box = QFrame(objectName="card")
        grid = QVBoxLayout(box)
        grid.setSpacing(8)
        for tool in tools:
            row = QHBoxLayout()
            check = QCheckBox(tool.name + ("  (update)" if tool.update_available else ""))
            check.setChecked(tool.id in chosen)
            check.toggled.connect(self._update_total)
            self.checks[tool.id] = check
            if tool.icon:
                icon = QLabel()
                icon.setPixmap(QIcon(str(tool.icon)).pixmap(QSize(22, 22)))
                row.addWidget(icon)
            row.addWidget(check, 1)
            row.addWidget(QLabel(human_size(tool.package["size"]), objectName="muted"))
            grid.addLayout(row)
        lay.addWidget(box)
        all_row = QHBoxLayout()
        select_all = QPushButton("Select all (the whole kit)", objectName="flat")
        select_all.clicked.connect(lambda: [c.setChecked(True) for c in self.checks.values()])
        all_row.addWidget(select_all)
        all_row.addStretch(1)
        self.total = QLabel(objectName="muted")
        all_row.addWidget(self.total)
        lay.addLayout(all_row)
        lay.addStretch(1)
        self.desktop = QCheckBox("Put shortcuts on the desktop")
        self.desktop.setChecked(desktop)
        lay.addWidget(self.desktop)
        buttons = QHBoxLayout()
        buttons.addStretch(1)
        cancel = QPushButton("Cancel")
        cancel.clicked.connect(self.reject)
        buttons.addWidget(cancel)
        self.go = QPushButton("Install", objectName="primary")
        self.go.clicked.connect(self.start)
        buttons.addWidget(self.go)
        lay.addLayout(buttons)
        self.stack.addWidget(choose)

        # -- page 2: progress
        progress = QWidget()
        plo = QVBoxLayout(progress)
        plo.setContentsMargins(0, 0, 0, 0)
        self.heading = QLabel("Installing…", objectName="heading")
        plo.addWidget(self.heading)
        self.rows_box = QVBoxLayout()
        self.rows_box.setSpacing(8)
        plo.addLayout(self.rows_box)
        plo.addStretch(1)
        self.summary = QLabel(objectName="muted", wordWrap=True)
        plo.addWidget(self.summary)
        end = QHBoxLayout()
        end.addStretch(1)
        self.close_btn = QPushButton("Cancel")
        self.close_btn.clicked.connect(self._close_or_cancel)
        end.addWidget(self.close_btn)
        plo.addLayout(end)
        self.stack.addWidget(progress)
        self._update_total()
        if auto:
            self.heading.setText("Updating…")
            QTimer.singleShot(0, self.start)

    def _update_total(self):
        picked = [t for t in self.tools if self.checks[t.id].isChecked()]
        size = sum(t.package["size"] for t in picked)
        self.total.setText(f"{len(picked)} selected · {human_size(size)} to download" if picked else "Nothing selected")
        self.go.setEnabled(bool(picked))

    def start(self):
        self.queue = [t for t in self.tools if self.checks[t.id].isChecked()]
        for tool in self.queue:
            row = ProgressRow(tool)
            self.rows[tool.id] = row
            self.rows_box.addWidget(row)
        self.stack.setCurrentIndex(1)
        if packages.FROZEN and not ig.read_manifest("suite"):
            # Install this app first, so the tools' uninstall entries point at an installed copy.
            self._run_job(lambda: packages.self_install(desktop=self.desktop.isChecked()), self._next)
        else:
            self._next()

    def _run_job(self, work, then):
        job = Job(work)
        job.ok.connect(lambda notes: (self.notes.extend(notes), then()))
        job.failed.connect(lambda msg: (self.notes.append(msg), then()))
        job.finished.connect(job.deleteLater)
        self._job = job
        job.start()

    def _next(self):
        if not self.queue:
            return self._all_done()
        tool = self.queue.pop(0)
        row = self.rows[tool.id]
        row.set("Downloading…", fraction=0)
        dest = self.tmp / tool.package["file"]
        self.current = Download(self.nam, tool.package["url"], dest)
        size = tool.package["size"] or 1

        def progress(got: int, total: int):
            total = total if total > 0 else size  # -1 when the server does not say
            row.set(f"Downloading… {human_size(got)} of {human_size(total)}", fraction=min(got / total, 1))

        self.current.progress.connect(progress)
        self.current.done.connect(lambda error: self._downloaded(tool, dest, error))

    def _downloaded(self, tool: Tool, archive: Path, error: str):
        self.current = None
        row = self.rows[tool.id]
        if error:
            self.failures += 1
            row.set(f"Download failed: {error}", "failed", 0)
            return self._next()
        row.set("Installing…")
        entry = tool.entry
        desktop = (tool.manifest or {}).get("desktop_shortcut", False) if self.auto else self.desktop.isChecked()

        def work():
            try:
                return packages.install_package(entry, tool.package, archive, desktop=desktop)
            finally:
                archive.unlink(missing_ok=True)

        job = Job(work)
        job.ok.connect(lambda notes: (self.notes.extend(notes), row.set("Updated" if self.auto else "Installed", "done", 1),
                                      self._next()))
        job.failed.connect(lambda msg: (self._fail(row, msg), self._next()))
        job.finished.connect(job.deleteLater)
        self._job = job
        job.start()

    def _fail(self, row: ProgressRow, msg: str):
        self.failures += 1
        row.set(f"Failed: {msg}", "failed", 0)

    def _all_done(self):
        done = len(self.rows) - self.failures
        self.heading.setText("All done" if not self.failures else "Finished, with problems")
        lines = [f"{'Updated' if self.auto else 'Installed'} {done} of {len(self.rows)}."]
        where = {"linux": "your application menu", "windows": "the Start menu", "macos": "your Applications folder"}[OS]
        if done and not self.auto:
            lines.append(f"Find them in {where}, or open them from here.")
        lines += sorted(set(self.notes))
        self.summary.setText("\n".join(lines))
        self.close_btn.setText("Close")
        self.close_btn.setObjectName("primary")
        snake_theme.repolish(self.close_btn)
        if self.auto and not self.failures:
            QTimer.singleShot(2500, self.accept)

    def _close_or_cancel(self):
        if self.close_btn.text() == "Close":
            self.accept()
            return
        self.queue.clear()
        if self.current:
            self.current.abort()
        if not (getattr(self, "_job", None) and self._job.isRunning()):
            self.reject()

    def reject(self):
        if getattr(self, "_job", None) and self._job.isRunning():
            return  # let the current step finish; stopping halfway leaves a mess
        super().reject()


class SourceInstallDialog(QDialog):
    """From the source kit: runs install.py and shows what it says (for developers)."""

    def __init__(self, parent, title: str, args: list[str]):
        super().__init__(parent)
        self.setWindowTitle(title)
        self.resize(720, 460)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(16, 14, 16, 14)
        lay.addWidget(QLabel(title, objectName="heading"))
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
        env = QProcessEnvironment.systemEnvironment()
        env.insert("PYTHONUNBUFFERED", "1")
        self.proc.setProcessEnvironment(env)
        root = kit_root()
        self.proc.setWorkingDirectory(str(root))
        self.proc.start(installer_python(), [str(root / "install.py"), *args, "--yes"])

    def _read(self):
        self.log.moveCursor(self.log.textCursor().MoveOperation.End)
        self.log.insertPlainText(bytes(self.proc.readAllStandardOutput()).decode(errors="replace"))
        self.log.ensureCursorVisible()

    def _done(self, code, _status):
        self._read()
        self.close_btn.setEnabled(True)
        self.status.setText("Done." if code == 0 else "Finished with problems. The log above says what went wrong.")
        self.status.setProperty("state", "done" if code == 0 else "failed")
        snake_theme.repolish(self.status)

    def reject(self):
        if self.proc.state() == QProcess.ProcessState.NotRunning:
            super().reject()


class UninstallDialog(QDialog):
    """Everything installed, old copies included: tick what to remove."""

    def __init__(self, parent, tools: list[Tool], *, old_only: bool = False, everything: bool = False):
        super().__init__(parent)
        self.setWindowTitle("Uninstall all Snake tools" if everything else "Uninstall Snake tools")
        self.resize(560, 420)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(18, 16, 18, 14)
        lay.addWidget(QLabel("What would you like to remove?", objectName="heading"))
        lay.addWidget(QLabel("Old versions were installed by a tool's own install script, before Snake's Suite; "
                             "they cannot be updated. Your own files (projects, recordings, settings) are kept.",
                             objectName="muted", wordWrap=True))
        lay.addSpacing(6)
        box = QFrame(objectName="card")
        rows = QVBoxLayout(box)
        rows.setSpacing(8)
        self.checks: list[tuple[QCheckBox, Tool, str]] = []  # (box, tool, "old" or "current")
        for tool in tools:
            for what in ("old", "current"):
                if what == "old" and not tool.legacy or what == "current" and not tool.installed:
                    continue
                row = QHBoxLayout()
                if tool.icon:
                    icon = QLabel()
                    icon.setPixmap(QIcon(str(tool.icon)).pixmap(QSize(22, 22)))
                    row.addWidget(icon)
                check = QCheckBox(tool.name + ("  (old version)" if what == "old" else ""))
                check.setChecked(what == "old" or not old_only)
                if what == "old":
                    check.setToolTip("\n".join(str(p) for p in tool.legacy))
                check.toggled.connect(self._update)
                row.addWidget(check, 1)
                rows.addLayout(row)
                self.checks.append((check, tool, what))
        if not self.checks:
            rows.addWidget(QLabel("No Snake tools are installed.", objectName="muted"))
        lay.addWidget(box)
        lay.addStretch(1)
        self.replace = QCheckBox("Install the Snake's Suite version of removed old versions")
        self.replace.setChecked(not everything)
        self.replace.setVisible(any(t.legacy and t.installable and not t.installed for t in tools))
        lay.addWidget(self.replace)
        buttons = QHBoxLayout()
        buttons.addStretch(1)
        cancel = QPushButton("Cancel")
        cancel.clicked.connect(self.reject)
        buttons.addWidget(cancel)
        self.go = QPushButton("Uninstall", objectName="danger")
        self.go.clicked.connect(self.accept)
        buttons.addWidget(self.go)
        lay.addLayout(buttons)
        self._update()

    def _update(self):
        self.go.setEnabled(any(check.isChecked() for check, _t, _w in self.checks))

    def chosen(self) -> list[tuple[Tool, str]]:
        return [(tool, what) for check, tool, what in self.checks if check.isChecked()]


# =========================================================================== the window
class Hub(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle(APP_NAME)
        self.setWindowIcon(QIcon(str(ICON_PATH)))
        self.resize(1000, 740)
        self.setMinimumSize(560, 460)
        self.setStyleSheet(HUB_STYLE)
        self.running: dict[str, int] = {}
        self.tiles: list[Tile] = []
        self.tools: list[Tool] = []
        self.index: dict | None = None
        self.index_state = "checking"
        self.nam = QNetworkAccessManager(self)
        self.updating = False  # an update (of this app or of tools) is under way
        self.hub_update: dict | None = None  # a newer Snake's Suite, when there is one
        self.just_updated = False  # started by an update of itself

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
        self.page_lay.addSpacing(22)
        self.banner = self._banner()
        self.page_lay.addWidget(self.banner)
        self.page_lay.addSpacing(10)
        self.old_banner = self._old_banner()
        self.page_lay.addWidget(self.old_banner)
        self.page_lay.addSpacing(18)
        section = QHBoxLayout()
        section.setSpacing(8)
        section.addWidget(QLabel("TOOLS", objectName="section"))
        section.addStretch(1)
        self.install_all_btn = QPushButton("Install the whole kit", objectName="primary")
        self.install_all_btn.clicked.connect(self.install_all)
        section.addWidget(self.install_all_btn)
        self.uninstall_all_btn = QPushButton("Uninstall all", objectName="danger",
                                             toolTip="Remove every installed tool (Snake's Suite itself stays)")
        self.uninstall_all_btn.clicked.connect(self.uninstall_all)
        section.addWidget(self.uninstall_all_btn)
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
        QShortcut(QKeySequence("F5"), self, activated=self.refresh)
        QShortcut(QKeySequence.StandardKey.Quit, self, activated=self.close)
        self.poll = QTimer(self, interval=1500, timeout=self._poll_running)
        self.poll.start()
        # Look for updates again now and then, for a window left open for days.
        self.recheck = QTimer(self, interval=6 * 3600 * 1000, timeout=self.fetch_index)
        self.recheck.start()
        self.reload()
        self.fetch_index()

    # ---- chrome, after Snake's Code -------------------------------------------------
    def _title_bar(self) -> QFrame:
        bar = QFrame(objectName="titleBar")
        bar.setFixedHeight(38)
        lay = QHBoxLayout(bar)
        lay.setContentsMargins(12, 0, 8, 0)
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
        refresh = QPushButton("↻", objectName="flat", toolTip="Check for tools and updates (F5)")
        refresh.clicked.connect(self.refresh)
        lay.addWidget(refresh)
        more = QPushButton("⋯", objectName="flat", toolTip="More")
        menu = QMenu(more)
        menu.addAction("Open the suite's folder", lambda: QDesktopServices.openUrl(QUrl.fromLocalFile(str(ig.DATA))))
        menu.addAction("Uninstall tools…", self.uninstall_many)
        menu.addSeparator()
        auto = menu.addAction("Update automatically")
        auto.setCheckable(True)
        auto.setChecked(packages.settings()["auto_update"])
        auto.toggled.connect(self.set_auto_update)
        menu.addSeparator()
        menu.addAction("Uninstall Snake's Suite…", self.uninstall_everything)
        more.setMenu(menu)
        lay.addWidget(more)
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

    def _banner(self) -> QFrame:
        """Shown when this one-file app runs from a download and is not installed yet."""
        banner = QFrame(objectName="banner")
        lay = QHBoxLayout(banner)
        lay.setContentsMargins(16, 12, 12, 12)
        lay.setSpacing(12)
        text = QVBoxLayout()
        text.setSpacing(2)
        text.addWidget(QLabel("Install Snake's Suite on this computer", objectName="heading"))
        text.addWidget(QLabel("It gets its own icon in your app list, so you can come back to add, update or "
                              "remove tools.", objectName="muted", wordWrap=True))
        lay.addLayout(text, 1)
        self.banner_desktop = QCheckBox("Desktop shortcut")
        self.banner_desktop.setChecked(True)
        lay.addWidget(self.banner_desktop)
        go = QPushButton("Install", objectName="primary")
        go.clicked.connect(self.install_self)
        lay.addWidget(go)
        banner.setVisible(packages.FROZEN and not ig.read_manifest("suite"))
        return banner

    def _old_banner(self) -> QFrame:
        """Shown when tools installed before Snake's Suite (by their own scripts) are still around."""
        banner = QFrame(objectName="oldBanner")
        lay = QHBoxLayout(banner)
        lay.setContentsMargins(16, 12, 12, 12)
        lay.setSpacing(12)
        text = QVBoxLayout()
        text.setSpacing(2)
        self.old_title = QLabel(objectName="heading")
        text.addWidget(self.old_title)
        self.old_text = QLabel(objectName="muted", wordWrap=True)
        text.addWidget(self.old_text)
        lay.addLayout(text, 1)
        later = QPushButton("Not now", objectName="flat")
        later.clicked.connect(lambda: (setattr(self, "old_dismissed", True), banner.hide()))
        lay.addWidget(later)
        go = QPushButton("Review…", objectName="primary")
        go.clicked.connect(lambda: self.uninstall_many(old_only=True))
        lay.addWidget(go)
        self.old_dismissed = False
        banner.hide()
        return banner

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
        self.hub_update_btn = QPushButton(objectName="statusButton")
        self.hub_update_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self.hub_update_btn.clicked.connect(lambda: self.update_hub(self.hub_update))
        self.hub_update_btn.hide()
        lay.addWidget(self.hub_update_btn)
        lay.addWidget(QLabel(f"v{__version__}", objectName="statusText"))
        return bar

    # ---- the release index -------------------------------------------------------------
    def fetch_index(self) -> None:
        url = packages.index_url()
        if not url:
            self.index_state = "none"
            return self._update_status()
        self.index_state = "checking"
        self._update_status()
        req = QNetworkRequest(QUrl(url))
        req.setAttribute(QNetworkRequest.Attribute.RedirectPolicyAttribute,
                         QNetworkRequest.RedirectPolicy.NoLessSafeRedirectPolicy)
        req.setAttribute(QNetworkRequest.Attribute.CacheLoadControlAttribute,
                         QNetworkRequest.CacheLoadControl.AlwaysNetwork)
        req.setTransferTimeout(15000)
        reply = self.nam.get(req)

        def done():
            try:
                if reply.error() == QNetworkReply.NetworkError.NoError:
                    self.index = json.loads(bytes(reply.readAll()).decode("utf-8"))
                    self.index_state = "ok"
                else:
                    self.index_state = "offline"
            except ValueError:
                self.index_state = "offline"
            reply.deleteLater()
            self.reload()
            if self.index_state == "ok":
                self.auto_update()

        reply.finished.connect(done)

    def refresh(self) -> None:
        self.reload()
        self.fetch_index()

    # ---- updating ----------------------------------------------------------------------
    def set_auto_update(self, on: bool) -> None:
        packages.save_setting("auto_update", on)
        if on and self.index_state == "ok":
            self.auto_update()

    def auto_update(self) -> None:
        """With a fresh index: update this app first (it restarts), then every tool that is not running."""
        if self.updating or not packages.settings()["auto_update"]:
            return
        if self.hub_update:
            return self.update_hub(self.hub_update)
        due = [t for t in self.tools if t.update_available and t.downloadable
               and t.id not in self.running and not packages.tool_in_use(t.id, t.manifest)]
        if not due:
            return
        self.updating = True
        dialog = InstallDialog(self, due, {t.id for t in due}, auto=True)
        dialog.finished.connect(lambda _: (setattr(self, "updating", False), self.reload()))
        dialog.open()

    def update_hub(self, pkg: dict | None) -> None:
        """Download the new Snake's Suite, put it in place of this one, and start it."""
        if not pkg or self.updating:
            return
        self.updating = True
        self.hub_update_btn.setEnabled(False)
        tmp = Path(tempfile.mkdtemp(prefix="snakes-suite-"))
        download = tmp / pkg["file"]
        self._hub_download = Download(self.nam, pkg["url"], download)
        size = pkg.get("size") or 1
        self._hub_download.progress.connect(lambda got, total: self.status.setText(
            f"Updating Snake's Suite to v{pkg['version']}… {human_size(got)} of {human_size(total if total > 0 else size)}"))

        def failed(msg: str):
            self.updating = False
            self.hub_update_btn.setEnabled(True)
            download.unlink(missing_ok=True)
            self.status.setText(f"Snake's Suite could not be updated: {msg}")

        def restart(start: list):
            download.unlink(missing_ok=True)
            if QProcess.startDetached(start[0], [*start[1:], "--updated"])[0]:
                QApplication.quit()
            else:
                failed("the new version is in place but did not start; open Snake's Suite again")

        def downloaded(error: str):
            if error:
                return failed(error)
            self.status.setText(f"Installing Snake's Suite v{pkg['version']}…")
            job = Job(lambda: packages.replace_hub(pkg, download))
            job.ok.connect(restart)
            job.failed.connect(failed)
            job.finished.connect(job.deleteLater)
            self._hub_job = job
            job.start()

        self._hub_download.done.connect(downloaded)

    # ---- tools -----------------------------------------------------------------------
    def reload(self) -> None:
        self.tools = load_tools(self.index)
        self.hub_update = packages.hub_package(self.index)
        if self.hub_update:
            self.hub_update_btn.setText(f"Update Snake's Suite to v{self.hub_update['version']}  ")
        self.hub_update_btn.setVisible(bool(self.hub_update))
        for tile in self.tiles:
            tile.deleteLater()
        self.tiles = []
        for tool in self.tools:
            tile = Tile(tool)
            tile.activated.connect(self.activate)
            tile.install_requested.connect(lambda t: self.install([t]))
            tile.menu_requested.connect(self.tool_menu)
            self.tiles.append(tile)
        missing = [t for t in self.tools if t.installable and not t.installed]
        self.install_all_btn.setVisible(bool(missing))
        installed = sum(t.installed for t in self.tools)
        self.install_all_btn.setText(f"Install the whole kit ({len(missing)} more)" if installed else "Install the whole kit")
        self.uninstall_all_btn.setVisible(any(t.installed or t.legacy for t in self.tools))
        self.banner.setVisible(packages.FROZEN and not ig.read_manifest("suite"))
        old = [t for t in self.tools if t.legacy]
        if old:
            self.old_title.setText("Older version found" if len(old) == 1 else f"{len(old)} older versions found")
            self.old_text.setText(", ".join(t.name for t in old) + (" was" if len(old) == 1 else " were")
                                  + " installed before Snake's Suite and cannot be updated from here. "
                                  "Remove them, and install the new versions if you like.")
        self.old_banner.setVisible(bool(old) and not self.old_dismissed)
        self._layout_tiles()
        self._poll_running()
        self._update_status()

    def _update_status(self) -> None:
        if self.updating and self.hub_update:
            return  # the download's progress is shown there
        installed = sum(t.installed for t in self.tools)
        supported = sum(t.supported for t in self.tools)
        text = f"{installed} of {supported} tools installed"
        updates = sum(t.update_available for t in self.tools)
        if updates:
            text += f" · {updates} update{'s' if updates != 1 else ''} available"
        extra = {"checking": "checking for downloads…",
                 "offline": "could not reach the download server; showing what is installed"}.get(self.index_state)
        if self.just_updated:
            text = f"Updated to v{__version__} · " + text
        self.status.setText(text + (f" · {extra}" if extra else ""))

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
            self.empty.setText("No tools are known to this copy of Snake's Suite.")
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
        elif tool.legacy:
            self.handle_legacy(tool)
        elif tool.installable:
            self.install([tool])
        elif not tool.supported:
            QMessageBox.information(self, tool.name, f"{tool.name} runs on "
                                    f"{', '.join(OS_NAMES.get(p, p) for p in tool.platforms)} only.")
        else:
            QMessageBox.information(self, tool.name, f"{tool.name} has no download for {OS_NAMES[OS]} yet."
                                    + (" Check your internet connection and press ↻." if self.index_state == "offline" else ""))

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
                                "Try reinstalling it (right-click its tile).")

    def _poll_running(self) -> None:
        for tool_id, pid in list(self.running.items()):
            # macOS starts apps through `open`, which returns at once: nothing to follow there.
            if not pid_alive(pid):
                del self.running[tool_id]
        for tile in self.tiles:
            tile.set_running(tile.tool.id in self.running)

    # ---- installing ------------------------------------------------------------------
    def install(self, chosen: list[Tool], desktop: bool | None = None) -> None:
        if any(t.downloadable for t in chosen):
            chosen_ids = {t.id for t in chosen}
            offer = [t for t in self.tools
                     if t.downloadable and (not t.installed or t.update_available or t.id in chosen_ids)]
            if desktop is None:
                desktop = any((t.manifest or {}).get("desktop_shortcut") for t in chosen)
            InstallDialog(self, offer, {t.id for t in chosen}, desktop=desktop).exec()
            self.reload()
            return
        # No release reachable: build from the source kit (developers).
        ids = [t.id for t in chosen if t.buildable]
        if not ids or not kit_root():
            QMessageBox.information(self, APP_NAME, "These tools cannot be downloaded right now. "
                                    "Check your internet connection and press ↻.")
            return
        SourceInstallDialog(self, f"Installing {', '.join(t.name for t in chosen)} from source",
                            ids + (["--desktop"] if desktop else [])).exec()
        self.reload()

    def install_all(self) -> None:
        self.install([t for t in self.tools if t.installable and (not t.installed or t.update_available)])

    def install_self(self) -> None:
        try:
            notes = packages.self_install(desktop=self.banner_desktop.isChecked())
        except Exception as e:  # noqa: BLE001
            QMessageBox.warning(self, APP_NAME, f"Snake's Suite could not be installed:\n\n{e}")
            return
        where = {"linux": "your application menu", "windows": "the Start menu", "macos": "your Applications folder"}[OS]
        QMessageBox.information(self, APP_NAME, f"Snake's Suite is installed. You will find it in {where}.\n\n"
                                "You can delete the file you downloaded." + ("\n\n" + "\n".join(notes) if notes else ""))
        self.reload()

    def uninstall(self, tool: Tool) -> None:
        answer = QMessageBox.question(self, tool.name, f"Remove {tool.name} from this computer?\n\n"
                                      "Your own files (projects, recordings, settings) are kept.")
        if answer != QMessageBox.StandardButton.Yes:
            return
        if (tool.manifest or {}).get("source_build") and kit_root():
            SourceInstallDialog(self, f"Removing {tool.name}", ["--uninstall", tool.id]).exec()
        else:
            packages.uninstall(tool.id)
        self.reload()

    def uninstall_all(self) -> None:
        self.uninstall_many(everything=True)

    def uninstall_many(self, old_only: bool = False, everything: bool = False) -> None:
        self.reload()  # look again: something may have changed since the window opened
        tools = [t for t in self.tools if t.installed or t.legacy]
        if old_only and not any(t.legacy for t in tools):
            return
        dialog = UninstallDialog(self, tools, old_only=old_only, everything=everything)
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return
        chosen = dialog.chosen()
        removed_old = [t for t, what in chosen if what == "old"]
        for tool in removed_old:
            remove_legacy(tool.legacy)
        current = [t for t, what in chosen if what == "current"]
        built = [t.id for t in current if (t.manifest or {}).get("source_build")]
        if built and kit_root():
            SourceInstallDialog(self, "Removing " + ", ".join(t.name for t in current if t.id in built),
                                ["--uninstall", *built]).exec()
        for tool in current:
            if tool.id not in built or not kit_root():
                packages.uninstall(tool.id)
        names = [t.name + (" (old version)" if what == "old" else "") for t, what in chosen]
        self.status.setText("Removed " + ", ".join(names))
        self.reload()
        if not dialog.replace.isHidden() and dialog.replace.isChecked():
            old_ids = {t.id for t in removed_old}
            wanted = [t for t in self.tools if t.id in old_ids and t.installable and not t.installed]
            if wanted:
                self.install(wanted, desktop=False)

    def handle_legacy(self, tool: Tool) -> None:
        """A tool installed by its old install script, before the suite: replace it, or remove it."""
        box = QMessageBox(self)
        box.setWindowTitle(tool.name)
        if tool.icon:
            box.setIconPixmap(QIcon(str(tool.icon)).pixmap(QSize(56, 56)))
        box.setText(f"{tool.name} was installed by its old install script.")
        box.setInformativeText("Snake's Suite cannot update or uninstall that copy. Replace it with the Snake's "
                               "Suite version (which you can uninstall from here or by right-clicking it in your "
                               "app menu), or just remove it.")
        replace = box.addButton("Replace", QMessageBox.ButtonRole.AcceptRole) if tool.installable else None
        if replace:
            replace.setObjectName("primary")
        remove = box.addButton("Remove", QMessageBox.ButtonRole.DestructiveRole)
        box.addButton(QMessageBox.StandardButton.Cancel)
        box.exec()
        if box.clickedButton() is remove:
            removed = remove_legacy(tool.legacy)
            self.status.setText(f"Removed the old {tool.name} ({len(removed)} files)")
            self.reload()
        elif replace and box.clickedButton() is replace:
            self.install([tool], desktop=False)  # installing removes the old menu entry

    def uninstall_everything(self) -> None:
        installed = [t for t in self.tools if t.installed]
        names = "\n".join(f"  • {t.name}" for t in installed)
        text = "Remove Snake's Suite" + (f" and every tool installed with it?\n\n{names}" if installed else "?")
        if QMessageBox.question(self, APP_NAME, text + "\n\nYour own files are kept.") != QMessageBox.StandardButton.Yes:
            return
        for tool_id in [t.id for t in installed] + ["suite"]:
            packages.uninstall(tool_id)
        QMessageBox.information(self, APP_NAME, "Snake's Suite has been removed.")
        QApplication.quit()

    def tool_menu(self, tool: Tool, pos) -> None:
        menu = QMenu(self)
        if tool.installed:
            menu.addAction("Open", lambda: self.launch(tool))
            menu.addSeparator()
            if tool.update_available:
                menu.addAction("Update", lambda: self.install([tool]))
            elif tool.installable:
                menu.addAction("Reinstall", lambda: self.install([tool]))
            if tool.installable and not (tool.manifest or {}).get("desktop_shortcut"):
                menu.addAction("Add a desktop shortcut", lambda: self.install([tool], desktop=True))
            menu.addAction("Uninstall…", lambda: self.uninstall(tool))
        elif tool.legacy:
            if tool.installable:
                menu.addAction("Replace with the Snake's Suite version", lambda: self.install([tool]))
            menu.addAction("Remove old version", lambda: (remove_legacy(tool.legacy), self.reload()))
        elif tool.installable:
            menu.addAction("Install…", lambda: self.install([tool]))
        if tool.source and tool.source.is_dir():
            menu.addSeparator()
            menu.addAction("Show source folder", lambda: QDesktopServices.openUrl(QUrl.fromLocalFile(str(tool.source))))
        if menu.actions():
            menu.exec(pos)


# =========================================================================== command line
def uninstall_from_command_line(tool_id: str, yes: bool) -> int:
    """What the system's uninstall button runs: remove a tool (or everything, for "suite")."""
    tools = {t["id"]: t for t in packages.catalogue().get("tools", [])}
    if tool_id == "suite":
        ids = [t for t in ig.installed_ids() if t != "suite"] + ["suite"]
        what = "Snake's Suite and every tool installed with it"
    else:
        ids = [tool_id]
        what = tools.get(tool_id, {}).get("name", tool_id)
    if not ig.read_manifest(tool_id):
        if not yes:
            QMessageBox.information(None, APP_NAME, f"{what} is not installed.")
        return 0
    if not yes and QMessageBox.question(None, APP_NAME, f"Remove {what}?\n\nYour own files are kept.") \
            != QMessageBox.StandardButton.Yes:
        return 1
    for one in ids:
        packages.uninstall(one)
    if not yes:
        QMessageBox.information(None, APP_NAME, f"{what} has been removed.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="snakes-suite", description="Every Snake tool in one place.")
    parser.add_argument("--uninstall", metavar="TOOL", help="remove a tool, or 'suite' for everything")
    parser.add_argument("--yes", action="store_true", help="do not ask first")
    parser.add_argument("--updated", action="store_true", help=argparse.SUPPRESS)  # started by an update of itself
    args, _qt_args = parser.parse_known_args()

    QApplication.setDesktopFileName("snakes-suite")
    app = QApplication(sys.argv)
    app.setApplicationName(APP_NAME)
    app.setApplicationVersion(__version__)
    snake_theme.apply(app, icon_path=ICON_PATH)
    if args.uninstall:
        return uninstall_from_command_line(args.uninstall, args.yes)
    packages.clean_up_after_update()
    hub = Hub()
    hub.just_updated = args.updated
    hub._update_status()
    hub.show()
    return app.exec()
