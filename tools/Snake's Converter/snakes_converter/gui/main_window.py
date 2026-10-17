"""The main window."""

from __future__ import annotations

import os
import threading
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

from PySide6.QtCore import Qt, QThread, QUrl, Signal
from PySide6.QtGui import QColor, QDesktopServices
from PySide6.QtWidgets import (
    QAbstractItemView, QComboBox, QFileDialog, QFrame, QHBoxLayout, QHeaderView, QLabel,
    QLineEdit, QMainWindow, QProgressBar, QPushButton, QSpinBox, QStackedWidget,
    QTableWidget, QTableWidgetItem, QVBoxLayout, QWidget,
)

from .. import APP_NAME
from ..converters import CATEGORY_LABELS, category_of, convert_file, missing_tool, targets_for
from ..core import Cancelled, Options
from ..tools import find_ffmpeg, find_libreoffice
from . import snake_theme

COL_NAME, COL_TYPE, COL_SIZE, COL_TARGET, COL_STATUS = range(5)
_MUTED, _ERROR, _DONE = QColor(snake_theme.FG2), QColor(snake_theme.ERROR_SOFT), QColor(snake_theme.HIGHLIGHT)


@dataclass
class Item:
    path: Path
    combo: QComboBox
    state: str = "ready"  # ready | unavailable | working | done | failed
    outputs: list[Path] = field(default_factory=list)


def _human_size(size: int) -> str:
    value = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return ""


class ConvertWorker(QThread):
    job_started = Signal(int)
    job_progress = Signal(int, float)
    job_done = Signal(int, list)
    job_failed = Signal(int, str)

    def __init__(self, jobs: list[tuple[int, Path, str]], outdir: Path | None, opts: Options):
        super().__init__()
        self.jobs, self.outdir, self.opts = jobs, outdir, opts
        self.cancel = threading.Event()

    def run(self) -> None:
        for index, src, target in self.jobs:
            if self.cancel.is_set():
                break
            self.job_started.emit(index)
            try:
                outputs = convert_file(
                    src, target, self.outdir, self.opts,
                    progress=lambda fraction, i=index: self.job_progress.emit(i, fraction),
                    cancel=self.cancel,
                )
            except Cancelled:
                self.job_failed.emit(index, "Cancelled")
                break
            except Exception as exc:  # keep going with the remaining files
                self.job_failed.emit(index, str(exc) or exc.__class__.__name__)
            else:
                self.job_done.emit(index, [str(p) for p in outputs])


class MainWindow(QMainWindow):
    def __init__(self, assets: Path):
        super().__init__()
        self.items: list[Item] = []
        self.worker: ConvertWorker | None = None
        self.custom_outdir: Path | None = None
        self.last_outdir: Path | None = None
        self._finished_jobs = 0

        self.setWindowTitle(APP_NAME)
        self.setAcceptDrops(True)
        self.resize(940, 640)
        self.setMinimumSize(720, 480)

        root = QWidget(objectName="root")
        self.setCentralWidget(root)
        outer = QVBoxLayout(root)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)
        outer.addWidget(snake_theme.HeaderBar(
            APP_NAME, "Audio  ·  Video  ·  Images  ·  Documents  ·  Spreadsheets  ·  PDF", assets / "icon.svg"))
        layout = QVBoxLayout()
        layout.setContentsMargins(16, 14, 16, 14)
        layout.setSpacing(12)
        outer.addLayout(layout, 1)

        layout.addLayout(self._build_toolbar())
        layout.addWidget(self._build_file_area(), 1)
        layout.addWidget(self._build_options())
        layout.addLayout(self._build_footer())
        self._refresh()

    # --- construction ------------------------------------------------------

    def _build_toolbar(self) -> QHBoxLayout:
        row = QHBoxLayout()
        row.setSpacing(8)
        self.add_files_btn = QPushButton("Add files…", clicked=self._choose_files)
        self.add_folder_btn = QPushButton("Add folder…", clicked=self._choose_folder)
        self.remove_btn = QPushButton("Remove", clicked=self._remove_selected)
        self.clear_btn = QPushButton("Clear", clicked=self._clear)
        row.addWidget(self.add_files_btn)
        row.addWidget(self.add_folder_btn)
        row.addStretch()
        row.addWidget(self.remove_btn)
        row.addWidget(self.clear_btn)
        return row

    def _build_file_area(self) -> QStackedWidget:
        self.stack = QStackedWidget()
        self.drop_hint = QLabel("Drop files or folders here\n\nor use “Add files…”", objectName="dropzone")
        self.drop_hint.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.stack.addWidget(self.drop_hint)

        self.table = QTableWidget(0, 5)
        self.table.setHorizontalHeaderLabels(["File", "Type", "Size", "Convert to", "Status"])
        self.table.verticalHeader().setVisible(False)
        self.table.verticalHeader().setDefaultSectionSize(44)
        self.table.setShowGrid(False)
        self.table.setAlternatingRowColors(True)
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.setTextElideMode(Qt.TextElideMode.ElideMiddle)
        self.table.itemSelectionChanged.connect(self._refresh)
        header = self.table.horizontalHeader()
        header.setHighlightSections(False)
        header.setDefaultAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter)
        header.setSectionResizeMode(COL_NAME, QHeaderView.ResizeMode.Stretch)
        for column, width in ((COL_TYPE, 170), (COL_SIZE, 90), (COL_TARGET, 120), (COL_STATUS, 190)):
            header.setSectionResizeMode(column, QHeaderView.ResizeMode.Fixed)
            self.table.setColumnWidth(column, width)
        self.stack.addWidget(self.table)
        return self.stack

    def _build_options(self) -> QFrame:
        card = QFrame(objectName="card")
        outer = QVBoxLayout(card)
        outer.setContentsMargins(14, 12, 14, 12)
        outer.setSpacing(10)

        def labelled(text: str, widget: QWidget, row: QHBoxLayout) -> None:
            row.addWidget(QLabel(text, objectName="fieldLabel"))
            row.addWidget(widget)
            row.addSpacing(14)

        top = QHBoxLayout()
        top.setSpacing(8)
        self.all_combo = QComboBox()
        self.all_combo.setMinimumWidth(110)
        self.all_combo.activated.connect(self._apply_to_all)
        labelled("Convert all to", self.all_combo, top)

        self.bitrate_combo = QComboBox()
        for rate in ("128k", "192k", "256k", "320k"):
            self.bitrate_combo.addItem(rate.replace("k", " kbps"), rate)
        self.bitrate_combo.setCurrentIndex(1)
        self.bitrate_combo.setToolTip("Used for MP3, OGG, Opus, M4A, AAC and WMA. WAV, FLAC and AIFF are lossless.")
        labelled("Audio bitrate", self.bitrate_combo, top)

        self.video_combo = QComboBox()
        for label, value in (("High quality", "high"), ("Balanced", "balanced"), ("Small file", "small")):
            self.video_combo.addItem(label, value)
        self.video_combo.setCurrentIndex(1)
        labelled("Video", self.video_combo, top)

        self.quality_spin = QSpinBox(minimum=10, maximum=100, value=90, suffix=" %")
        self.quality_spin.setToolTip("JPEG / WebP / AVIF quality")
        labelled("Image quality", self.quality_spin, top)
        top.addStretch()
        outer.addLayout(top)

        bottom = QHBoxLayout()
        bottom.setSpacing(8)
        bottom.addWidget(QLabel("Save to", objectName="fieldLabel"))
        self.dest_combo = QComboBox()
        self.dest_combo.addItems(["Same folder as the original", "Choose a folder…"])
        self.dest_combo.activated.connect(self._destination_changed)
        bottom.addWidget(self.dest_combo)
        self.dest_edit = QLineEdit(readOnly=True, placeholderText="Converted files are saved next to the originals")
        bottom.addWidget(self.dest_edit, 1)
        outer.addLayout(bottom)
        return card

    def _build_footer(self) -> QHBoxLayout:
        row = QHBoxLayout()
        row.setSpacing(12)
        left = QVBoxLayout()
        left.setSpacing(6)
        self.status = QLabel(objectName="status")
        self.progress = QProgressBar(textVisible=False, maximum=1000)
        left.addWidget(self.status)
        left.addWidget(self.progress)
        row.addLayout(left, 1)
        self.open_btn = QPushButton("Open folder", clicked=self._open_output)
        self.convert_btn = QPushButton("Convert", clicked=self._convert_or_cancel)
        row.addWidget(self.open_btn)
        row.addWidget(self.convert_btn)
        return row

    # --- adding and removing files -----------------------------------------

    def _choose_files(self) -> None:
        files, _ = QFileDialog.getOpenFileNames(self, "Add files")
        self.add_paths(Path(f) for f in files)

    def _choose_folder(self) -> None:
        folder = QFileDialog.getExistingDirectory(self, "Add folder")
        if folder:
            self.add_paths([Path(folder)])

    def add_paths(self, paths) -> None:
        known = {item.path for item in self.items}
        skipped = 0
        for path in paths:
            if path.is_dir():
                files = sorted(p for p in path.rglob("*") if p.is_file() and category_of(p))
            else:
                files = [path]
            for file in files:
                file = file.resolve()
                if file in known or not file.is_file():
                    continue
                if category_of(file) is None:
                    skipped += 1
                    continue
                known.add(file)
                self._add_row(file)
        self._refresh()
        if skipped:
            self.status.setText(f"{skipped} unsupported file{'s' if skipped != 1 else ''} skipped.")

    def _add_row(self, path: Path) -> None:
        row = self.table.rowCount()
        self.table.insertRow(row)

        name = QTableWidgetItem(path.name)
        name.setToolTip(str(path))
        self.table.setItem(row, COL_NAME, name)
        kind = f"{CATEGORY_LABELS[category_of(path)]} · {path.suffix.lstrip('.').upper()}"
        self.table.setItem(row, COL_TYPE, QTableWidgetItem(kind))
        self.table.setItem(row, COL_SIZE, QTableWidgetItem(_human_size(path.stat().st_size)))
        for column in (COL_TYPE, COL_SIZE):
            self.table.item(row, column).setForeground(_MUTED)
        self.table.setItem(row, COL_STATUS, QTableWidgetItem())

        combo = QComboBox()
        for target in targets_for(path):
            combo.addItem(target.upper(), target)
        holder = QWidget()
        box = QHBoxLayout(holder)
        box.setContentsMargins(6, 6, 10, 6)
        box.addWidget(combo)
        self.table.setCellWidget(row, COL_TARGET, holder)

        item = Item(path, combo)
        self.items.append(item)
        if combo.count():
            self._set_status(item, "Ready")
            combo.currentIndexChanged.connect(lambda _=0, it=item: self._target_changed(it))
        else:
            item.state = "unavailable"
            combo.setEnabled(False)
            tool = missing_tool(path) or "an extra component"
            self._set_status(item, f"Needs {tool}", error=True,
                             tip=f"Install {tool} and restart {APP_NAME} to convert this file.")

    def _target_changed(self, item: Item) -> None:
        if item.state in ("done", "failed"):
            item.state = "ready"
            self._set_status(item, "Ready")
            self._refresh()

    def _remove_selected(self) -> None:
        rows = sorted({index.row() for index in self.table.selectedIndexes()}, reverse=True)
        for row in rows:
            self.table.removeRow(row)
            del self.items[row]
        self._refresh()

    def _clear(self) -> None:
        self.table.setRowCount(0)
        self.items.clear()
        self._refresh()

    def dragEnterEvent(self, event) -> None:
        if event.mimeData().hasUrls() and self.worker is None:
            event.acceptProposedAction()
            self._set_drop_active(True)

    def dragLeaveEvent(self, event) -> None:
        self._set_drop_active(False)

    def dropEvent(self, event) -> None:
        self._set_drop_active(False)
        self.add_paths(Path(url.toLocalFile()) for url in event.mimeData().urls() if url.isLocalFile())
        event.acceptProposedAction()

    def _set_drop_active(self, active: bool) -> None:
        self.drop_hint.setProperty("active", active)
        self.drop_hint.style().unpolish(self.drop_hint)
        self.drop_hint.style().polish(self.drop_hint)

    # --- options -----------------------------------------------------------

    def _apply_to_all(self, index: int) -> None:
        target = self.all_combo.itemData(index)
        if target:
            for item in self.items:
                found = item.combo.findData(target)
                if found >= 0:
                    item.combo.setCurrentIndex(found)
        self.all_combo.setCurrentIndex(0)

    def _destination_changed(self, index: int) -> None:
        if index == 1:
            start = str(self.custom_outdir or (self.items[0].path.parent if self.items else Path.home()))
            folder = QFileDialog.getExistingDirectory(self, "Save converted files to", start)
            if folder:
                self.custom_outdir = Path(folder)
            elif self.custom_outdir is None:
                self.dest_combo.setCurrentIndex(0)
        self.dest_edit.setText(str(self.custom_outdir) if self.dest_combo.currentIndex() == 1 else "")

    def _options(self) -> Options:
        return Options(
            audio_bitrate=self.bitrate_combo.currentData(),
            video_quality=self.video_combo.currentData(),
            image_quality=self.quality_spin.value(),
        )

    # --- converting --------------------------------------------------------

    def _pending(self) -> list[int]:
        return [i for i, item in enumerate(self.items) if item.state in ("ready", "failed")]

    def _convert_or_cancel(self) -> None:
        if self.worker is not None:
            self.worker.cancel.set()
            self.convert_btn.setEnabled(False)
            self.status.setText("Cancelling…")
            return
        jobs = [(i, self.items[i].path, self.items[i].combo.currentData()) for i in self._pending()]
        if not jobs:
            return
        for index, _, _ in jobs:
            self.items[index].state = "ready"
            self._set_status(self.items[index], "Waiting")
        outdir = self.custom_outdir if self.dest_combo.currentIndex() == 1 else None
        self._finished_jobs = 0
        self.progress.setValue(0)
        self.worker = ConvertWorker(jobs, outdir, self._options())
        self.worker.job_started.connect(self._job_started)
        self.worker.job_progress.connect(self._job_progress)
        self.worker.job_done.connect(self._job_done)
        self.worker.job_failed.connect(self._job_failed)
        self.worker.finished.connect(self._all_finished)
        self.worker.start()
        self._refresh()

    def _job_started(self, index: int) -> None:
        item = self.items[index]
        item.state = "working"
        self._set_status(item, "Converting…")
        self.table.scrollToItem(self.table.item(index, COL_NAME))
        total = len(self.worker.jobs)
        self.status.setText(f"Converting {self._finished_jobs + 1} of {total}: {item.path.name}")

    def _job_progress(self, index: int, fraction: float) -> None:
        if self.worker is None or self.items[index].state != "working":
            return
        self._set_status(self.items[index], f"Converting… {fraction * 100:.0f}%")
        self.progress.setValue(int((self._finished_jobs + fraction) / len(self.worker.jobs) * 1000))

    def _job_done(self, index: int, outputs: list) -> None:
        item = self.items[index]
        item.state = "done"
        item.outputs = [Path(p) for p in outputs]
        self.last_outdir = item.outputs[0].parent
        text = "Done" if len(outputs) == 1 else f"Done · {len(outputs)} files"
        self._set_status(item, text, done=True, tip="\n".join(outputs[:20]))
        self._advance()

    def _job_failed(self, index: int, message: str) -> None:
        item = self.items[index]
        item.state = "failed"
        first_line = message.strip().splitlines()[0] if message.strip() else "Failed"
        self._set_status(item, first_line if message == "Cancelled" else f"Failed: {first_line}",
                         error=True, tip=message)
        self._advance()

    def _advance(self) -> None:
        self._finished_jobs += 1
        self.progress.setValue(int(self._finished_jobs / len(self.worker.jobs) * 1000))

    def _all_finished(self) -> None:
        cancelled = self.worker.cancel.is_set()
        total = len(self.worker.jobs)
        self.worker.deleteLater()
        self.worker = None
        for item in self.items:  # jobs that never started after a cancel
            if item.state == "ready":
                self._set_status(item, "Ready")
        done = sum(1 for item in self.items if item.state == "done")
        failed = sum(1 for item in self.items if item.state == "failed")
        if cancelled:
            summary = "Cancelled."
        elif failed:
            summary = f"Finished with {failed} of {total} failed. Hover over a failed row for details."
        else:
            summary = f"All done. {done} file{'s' if done != 1 else ''} converted."
            self.progress.setValue(1000)
        self._refresh()
        self.status.setText(summary)

    def _open_output(self) -> None:
        if self.last_outdir:
            QDesktopServices.openUrl(QUrl.fromLocalFile(str(self.last_outdir)))

    # --- state -------------------------------------------------------------

    def _set_status(self, item: Item, text: str, *, error: bool = False, done: bool = False,
                    tip: str = "") -> None:
        cell = self.table.item(self.items.index(item), COL_STATUS)
        cell.setText(text)
        cell.setToolTip(tip)
        cell.setForeground(_ERROR if error else _DONE if done else _MUTED)

    def _refresh(self) -> None:
        """Bring every control in line with the current state."""
        running = self.worker is not None
        self.stack.setCurrentIndex(1 if self.items else 0)

        counts = Counter(item.combo.itemData(i) for item in self.items for i in range(item.combo.count()))
        self.all_combo.clear()
        self.all_combo.addItem("Choose…", None)
        for target, _ in counts.most_common():
            self.all_combo.addItem(target.upper(), target)

        for widget in (self.add_files_btn, self.add_folder_btn, self.dest_combo,
                       self.bitrate_combo, self.video_combo, self.quality_spin):
            widget.setEnabled(not running)
        self.all_combo.setEnabled(not running and bool(counts))
        self.remove_btn.setEnabled(not running and bool(self.table.selectedIndexes()))
        self.clear_btn.setEnabled(not running and bool(self.items))
        for item in self.items:
            item.combo.setEnabled(not running and item.combo.count() > 0)
        self.open_btn.setEnabled(self.last_outdir is not None)

        pending = len(self._pending())
        self.convert_btn.setObjectName("danger" if running else "primary")
        self.convert_btn.setText("Cancel" if running else f"Convert {pending} file{'s' if pending != 1 else ''}"
                                 if pending else "Convert")
        self.convert_btn.setEnabled(running or pending > 0)
        self.convert_btn.style().unpolish(self.convert_btn)
        self.convert_btn.style().polish(self.convert_btn)

        if not running:
            if not self.items:
                self.progress.setValue(0)
                self.status.setText(self._tools_summary())
            else:
                self.status.setText(f"{len(self.items)} file{'s' if len(self.items) != 1 else ''} in the list.")

    @staticmethod
    def _tools_summary() -> str:
        if not find_ffmpeg():
            return "ffmpeg was not found, so audio and video conversion is unavailable."
        if not find_libreoffice():
            return ("Ready. Tip: installing LibreOffice adds old Office files (DOC, XLS, PPT), "
                    "ODT and ODS, and PowerPoint to PPTX or ODP.")
        return "Ready."

    def closeEvent(self, event) -> None:
        if self.worker is not None:
            self.worker.cancel.set()
            self.worker.wait(5000)
        event.accept()
