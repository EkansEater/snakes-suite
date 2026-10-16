"""Snake's Master Suite ergonomics for Qt apps: the same habits as the Studio apps.

The master copy lives in Snake's Master Suite/shared/qt/; `python shared/sync.py`
copies it next to each tool's snake_theme.py, so edit it there, not in a tool.

Works with PySide6 and PyQt6 (whichever the app has already imported).

    import snake_ergo
    snake_ergo.install(window)                      # after the window is built
    snake_ergo.command(window, "Open files", open_files, "Ctrl+O")   # extra palette entries

What it adds to a window:
  * Ctrl+wheel makes what is under the pointer bigger or smaller: lists, tables and
    text boxes on their own, anything else the whole interface (Ctrl+0 resets).
    Pinching does the same, on a touchpad or a touch screen.
  * On a touch screen one finger scrolls lists and text boxes.
  * Turning the wheel while scrolling a page no longer grabs drop-downs, number boxes
    and sliders that pass under the pointer.
  * A command palette (Ctrl+Shift+P or F1): every menu item and button, searchable.
  * The keyboard shortcuts list (Ctrl+/).
  * Right-click menus where Qt has none: copy from lists, tables and labels.
  * The window opens where and as big as it was last time.
"""

from __future__ import annotations

import math
import re
import sys
import time

_installed: dict[int, object] = {}


def _qt():
    """(QtCore, QtGui, QtWidgets) of whichever binding the app uses."""
    if "PyQt6.QtWidgets" in sys.modules or ("PyQt6" in sys.modules and "PySide6" not in sys.modules):
        from PyQt6 import QtCore, QtGui, QtWidgets
    else:
        from PySide6 import QtCore, QtGui, QtWidgets
    return QtCore, QtGui, QtWidgets


def _scaled_sheet(sheet: str, factor: float) -> str:
    """The stylesheet with every point size multiplied (the interface zoom)."""
    return re.sub(r"(\d+(?:\.\d+)?)pt", lambda m: f"{float(m.group(1)) * factor:.2f}pt", sheet)


def _fuzzy(query: str, text: str) -> int | None:
    """A score when every letter of the query appears in order in the text, else None."""
    q = query.lower().strip()
    t = text.lower()
    if not q:
        return 0
    if q in t:
        return 1000 - t.index(q) * 2 - len(t)
    pos = 0
    score = 0
    for ch in q:
        i = t.find(ch, pos)
        if i < 0:
            return None
        score += 10 - min(9, i - pos)
        pos = i + 1
    return score - len(t)


def _overrides(obj, method: str) -> bool:
    """Whether the app's own Python class (not Qt) defines this method."""
    for cls in type(obj).__mro__:
        if cls.__module__.split(".")[0] in ("PySide6", "PyQt6", "shiboken6", "sip", "builtins"):
            continue
        if method in vars(cls):
            return True
    return False


def command(window, title: str, run, shortcut: str | None = None) -> None:
    """Add an entry to the window's command palette (and its shortcut, if given)."""
    ergo = _installed.get(id(window))
    if ergo is None:
        raise RuntimeError("snake_ergo.install(window) first")
    ergo.extra.append((title, shortcut or "", run))
    if shortcut:
        ergo.add_shortcut(shortcut, run)


def install(window, *, name: str | None = None, remember_geometry: bool = True):
    """Give a top-level window the suite's ergonomics. Returns the helper object."""
    if id(window) in _installed:
        return _installed[id(window)]
    QtCore, QtGui, QtWidgets = _qt()
    E = QtCore.QEvent.Type
    Mod = QtCore.Qt.KeyboardModifier
    app = QtWidgets.QApplication.instance()
    key = name or window.objectName() or type(window).__name__

    class Ergo(QtCore.QObject):
        def __init__(self):
            super().__init__(window)
            self.settings = QtCore.QSettings("Snakes Master Suite", f"ergo-{app.applicationName() or key}")
            self.extra: list[tuple[str, str, object]] = []
            self.base_sheet = None
            self.ui_zoom = float(self.settings.value("uiZoom", 1.0) or 1.0)
            self.last_scroll = 0.0
            self.pinch = None  # the gesture going on: what it zooms and by how much so far
            self.taken = self._existing_shortcuts()
            # Touch-screen pinches anywhere in the window come here (see on_gesture).
            window.grabGesture(QtCore.Qt.GestureType.PinchGesture)
            for area in window.findChildren(QtWidgets.QAbstractScrollArea):
                self.touch_scroll(area)
            if self.ui_zoom != 1.0:
                self.set_ui_zoom(self.ui_zoom, announce=False)
            # Our shortcuts, unless the app already uses those keys.
            self.add_shortcut("Ctrl+Shift+P", self.open_palette)
            self.add_shortcut("F1", self.open_palette)
            self.add_shortcut("Ctrl+/", self.show_shortcuts)
            self.add_shortcut("Ctrl+0", lambda: self.set_ui_zoom(1.0))
            self.add_shortcut("Ctrl+=", lambda: self.set_ui_zoom(self.ui_zoom * 1.1))
            self.add_shortcut("Ctrl++", lambda: self.set_ui_zoom(self.ui_zoom * 1.1))
            self.add_shortcut("Ctrl+-", lambda: self.set_ui_zoom(self.ui_zoom / 1.1))
            if remember_geometry:
                geo = self.settings.value(f"geometry/{key}")
                if geo is not None:
                    window.restoreGeometry(geo)

        # ---- shortcuts ----
        def _existing_shortcuts(self) -> set[str]:
            keys = set()
            for a in window.findChildren(QtGui.QAction):
                for s in a.shortcuts():
                    keys.add(s.toString())
            for s in window.findChildren(QtGui.QShortcut):
                keys.add(s.key().toString())
            return keys

        def add_shortcut(self, seq: str, run) -> None:
            ks = QtGui.QKeySequence(seq)
            if ks.toString() in self.taken:
                return
            self.taken.add(ks.toString())
            sc = QtGui.QShortcut(ks, window)
            sc.setContext(QtCore.Qt.ShortcutContext.WindowShortcut)
            sc.activated.connect(run)

        # ---- zoom ----
        def set_ui_zoom(self, factor: float, announce: bool = True) -> None:
            factor = max(0.6, min(2.5, factor))
            if self.base_sheet is None:
                self.base_sheet = app.styleSheet()
            self.ui_zoom = factor
            app.setStyleSheet(_scaled_sheet(self.base_sheet, factor) if factor != 1.0 else self.base_sheet)
            self.settings.setValue("uiZoom", factor)
            if announce:
                self.flash(f"Interface {round(factor * 100)}%")

        def zoom_widget(self, w, steps: int) -> None:
            """Bigger or smaller text in one list, table or text box (its own stylesheet line)."""
            own = w.property("snakeErgoSheet")
            if own is None:
                own = w.styleSheet() or ""
                w.setProperty("snakeErgoSheet", own)
            base = w.property("snakeErgoPt") or w.font().pointSizeF() or 10.0
            if w.property("snakeErgoPt") is None:
                w.setProperty("snakeErgoPt", base)
            cur = float(w.property("snakeErgoNow") or base)
            new = max(6.0, min(48.0, cur + steps))
            w.setProperty("snakeErgoNow", new)
            w.setStyleSheet(f"{own}\nfont-size: {new:.1f}pt;" if abs(new - base) > 0.01 else own)
            if isinstance(w, QtWidgets.QTableView) and w.model() is not None and w.model().rowCount() < 3000:
                w.resizeRowsToContents()
            self.flash(f"{round(new / base * 100)}%")

        # ---- pinch (touchpad or touch screen) ----
        def pinch_begin(self, global_pos) -> None:
            w = QtWidgets.QApplication.widgetAt(global_pos)
            target = None
            while w is not None and w is not window:
                if isinstance(w, (QtWidgets.QAbstractItemView, QtWidgets.QTextEdit, QtWidgets.QPlainTextEdit)):
                    target = w
                    break
                w = w.parentWidget()
            self.pinch = {"target": target, "scale": 1.0, "steps": 0}

        def pinch_change(self, factor: float) -> None:
            """The fingers moved apart (factor > 1) or together since last time."""
            p = self.pinch
            if p is None or factor <= 0:
                return
            p["scale"] = max(0.2, min(5.0, p["scale"] * factor))
            if p["target"] is not None:
                # A list or text box: one point of text per 15% of pinch.
                want = round(math.log(p["scale"]) / math.log(1.15))
                if want != p["steps"]:
                    self.zoom_widget(p["target"], want - p["steps"])
                    p["steps"] = want
            else:
                # The whole interface is redrawn once, when the fingers stop.
                self.flash(f"Interface {round(max(0.6, min(2.5, self.ui_zoom * p['scale'])) * 100)}%")

        def pinch_end(self) -> None:
            p, self.pinch = self.pinch, None
            if p is not None and p["target"] is None and abs(math.log(p["scale"])) > 0.04:
                self.set_ui_zoom(round(self.ui_zoom * p["scale"] * 20) / 20)

        def on_native_gesture(self, ev) -> bool:
            G = QtCore.Qt.NativeGestureType
            kind = ev.gestureType()
            if kind == G.BeginNativeGesture:
                self.pinch = None
                return False
            if kind == G.ZoomNativeGesture:
                if self.pinch is None:
                    self.pinch_begin(ev.globalPosition().toPoint())
                self.pinch_change(1.0 + ev.value())
                ev.accept()  # or Qt offers it to every parent too
                return True
            if kind == G.EndNativeGesture:
                self.pinch_end()
            return False

        def on_gesture(self, ev) -> bool:
            g = ev.gesture(QtCore.Qt.GestureType.PinchGesture)
            if g is None:
                return False
            S = QtCore.Qt.GestureState
            state = g.state()
            if state == S.GestureStarted:
                self.pinch_begin(g.centerPoint().toPoint())
            elif state == S.GestureUpdated:
                if self.pinch is None:
                    self.pinch_begin(g.centerPoint().toPoint())
                # Qt can hand over the same finger movement twice (its total then
                # counts it twice too): take each movement once.
                step = (round(g.scaleFactor(), 6), g.centerPoint().x(), g.centerPoint().y())
                if step != self.pinch.get("last"):
                    self.pinch["last"] = step
                    self.pinch_change(g.scaleFactor())
            elif state == S.GestureFinished:
                self.pinch_end()
            elif state == S.GestureCanceled:
                self.pinch = None
            ev.accept(g)
            return True

        def touch_scroll(self, area) -> None:
            """One finger on a touch screen scrolls (and flicks) this list or text box."""
            if area.property("snakeErgoTouch"):
                return
            area.setProperty("snakeErgoTouch", True)
            QtWidgets.QScroller.grabGesture(area.viewport(), QtWidgets.QScroller.ScrollerGestureType.TouchGesture)

        def flash(self, text: str) -> None:
            QtWidgets.QToolTip.showText(QtGui.QCursor.pos(), text, window, window.rect(), 900)

        # ---- events ----
        def eventFilter(self, obj, ev):  # noqa: N802 (Qt's name)
            t = ev.type()
            if t == E.Wheel and isinstance(obj, QtWidgets.QWidget) and obj.window() is window:
                return self.on_wheel(obj, ev)
            if t == E.ContextMenu and isinstance(obj, QtWidgets.QWidget) and obj.window() is window:
                return self.on_context(obj, ev)
            if t == E.NativeGesture and isinstance(obj, QtWidgets.QWidget) and obj.window() is window:
                return self.on_native_gesture(ev)
            if t == E.Gesture and obj is window:
                return self.on_gesture(ev)
            if t == E.Polish and isinstance(obj, QtWidgets.QAbstractScrollArea) and obj.window() is window:
                self.touch_scroll(obj)
            if t == E.Close and obj is window and remember_geometry:
                self.settings.setValue(f"geometry/{key}", window.saveGeometry())
            return False

        def on_wheel(self, obj, ev) -> bool:
            mods = ev.modifiers()
            dy = ev.angleDelta().y()
            if mods & Mod.ControlModifier and dy:
                steps = 1 if dy > 0 else -1
                w = obj
                while w is not None and w is not window:
                    if isinstance(w, (QtWidgets.QAbstractItemView, QtWidgets.QTextEdit, QtWidgets.QPlainTextEdit)):
                        self.zoom_widget(w, steps)
                        return True
                    w = w.parentWidget()
                self.set_ui_zoom(self.ui_zoom * (1.1 if steps > 0 else 1 / 1.1))
                return True
            # Scrolling a page: drop-downs, number boxes and sliders passing under the
            # pointer do not grab the wheel unless they have the focus.
            adjustable = (QtWidgets.QComboBox, QtWidgets.QAbstractSpinBox, QtWidgets.QAbstractSlider)
            target = obj
            while target is not None and not isinstance(target, adjustable):
                if isinstance(target, QtWidgets.QAbstractScrollArea):
                    break
                target = target.parentWidget()
            area = obj
            while area is not None and not isinstance(area, QtWidgets.QAbstractScrollArea):
                area = area.parentWidget()
            now = time.monotonic()
            if isinstance(target, adjustable):
                if area is not None and not target.hasFocus() and now - self.last_scroll < 0.4:
                    bar = area.verticalScrollBar()
                    bar.setValue(bar.value() - int(dy / 120 * bar.singleStep() * 3))
                    self.last_scroll = now
                    return True
            elif area is not None:
                self.last_scroll = now
            return False

        def on_context(self, obj, ev) -> bool:
            view = obj
            while view is not None and not isinstance(view, QtWidgets.QAbstractItemView):
                if isinstance(view, (QtWidgets.QLineEdit, QtWidgets.QTextEdit, QtWidgets.QPlainTextEdit)):
                    return False  # these have their own menus
                view = view.parentWidget()
            Policy = QtCore.Qt.ContextMenuPolicy
            if view is not None:
                if view.contextMenuPolicy() != Policy.DefaultContextMenu or _overrides(view, "contextMenuEvent"):
                    return False  # the app has its own menu here
                menu = QtWidgets.QMenu(view)
                copy = menu.addAction("Copy", lambda: self.copy_view(view))
                copy.setEnabled(bool(view.selectionModel() and view.selectionModel().selectedIndexes()))
                if view.selectionMode() != QtWidgets.QAbstractItemView.SelectionMode.NoSelection:
                    menu.addAction("Select all", view.selectAll)
                menu.addSeparator()
                menu.addAction("Bigger text", lambda: self.zoom_widget(view, 1))
                menu.addAction("Smaller text", lambda: self.zoom_widget(view, -1))
                menu.exec(ev.globalPos())
                return True
            if isinstance(obj, QtWidgets.QLabel) and obj.text() and obj.contextMenuPolicy() == Policy.DefaultContextMenu:
                plain = QtGui.QTextDocumentFragment.fromHtml(obj.text()).toPlainText() if obj.textFormat() != QtCore.Qt.TextFormat.PlainText else obj.text()
                menu = QtWidgets.QMenu(obj)
                menu.addAction("Copy text", lambda: QtWidgets.QApplication.clipboard().setText(plain))
                menu.exec(ev.globalPos())
                return True
            return False

        def copy_view(self, view) -> None:
            idx = sorted(view.selectionModel().selectedIndexes(), key=lambda i: (i.row(), i.column()))
            rows: dict[int, list[str]] = {}
            for i in idx:
                rows.setdefault(i.row(), []).append(str(i.data() or ""))
            QtWidgets.QApplication.clipboard().setText("\n".join("\t".join(cells) for cells in rows.values()))

        # ---- palette and shortcuts ----
        def entries(self) -> list[tuple[str, str, object]]:
            out = list(self.extra)
            seen = {e[0] for e in out}
            for a in window.findChildren(QtGui.QAction):
                text = a.text().replace("&", "").strip()
                if not text or a.isSeparator() or not a.isEnabled() or text in seen:
                    continue
                seen.add(text)
                out.append((text, a.shortcut().toString(QtGui.QKeySequence.SequenceFormat.NativeText), a.trigger))
            # In these small tools the buttons are the commands.
            for b in window.findChildren(QtWidgets.QAbstractButton):
                text = b.text().replace("&", "").strip() or b.toolTip().strip()
                if not text or not b.isVisibleTo(window) or not b.isEnabled() or text in seen or len(text) > 60:
                    continue
                seen.add(text)
                out.append((text, "", b.click))
            out.append(("Bigger interface", "Ctrl+=", lambda: self.set_ui_zoom(self.ui_zoom * 1.1)))
            out.append(("Smaller interface", "Ctrl+-", lambda: self.set_ui_zoom(self.ui_zoom / 1.1)))
            out.append(("Reset the interface size", "Ctrl+0", lambda: self.set_ui_zoom(1.0)))
            out.append(("Keyboard shortcuts", "Ctrl+/", self.show_shortcuts))
            return out

        def open_palette(self) -> None:
            dlg = QtWidgets.QDialog(window, QtCore.Qt.WindowType.Popup)
            dlg.setObjectName("palette")
            dlg.setMinimumWidth(min(560, max(380, window.width() - 80)))
            lay = QtWidgets.QVBoxLayout(dlg)
            lay.setContentsMargins(6, 6, 6, 6)
            edit = QtWidgets.QLineEdit()
            edit.setPlaceholderText("Type a command…")
            lst = QtWidgets.QListWidget()
            lst.setMinimumHeight(260)
            lay.addWidget(edit)
            lay.addWidget(lst)
            all_entries = self.entries()

            def fill():
                lst.clear()
                scored = []
                for e in all_entries:
                    s = _fuzzy(edit.text(), e[0])
                    if s is not None:
                        scored.append((s, e))
                scored.sort(key=lambda x: -x[0])
                for _, (title, keys, run) in scored[:200]:
                    item = QtWidgets.QListWidgetItem(f"{title}    {keys}" if keys else title)
                    item.setData(QtCore.Qt.ItemDataRole.UserRole, run)
                    lst.addItem(item)
                if lst.count():
                    lst.setCurrentRow(0)

            def go(item=None):
                item = item or lst.currentItem()
                if item is None:
                    return
                run = item.data(QtCore.Qt.ItemDataRole.UserRole)
                dlg.accept()
                QtCore.QTimer.singleShot(0, run)

            class Keys(QtCore.QObject):
                def eventFilter(self, o, e):  # noqa: N802
                    if e.type() == E.KeyPress:
                        k = e.key()
                        if k in (QtCore.Qt.Key.Key_Down, QtCore.Qt.Key.Key_Up):
                            lst.setCurrentRow(max(0, min(lst.count() - 1, lst.currentRow() + (1 if k == QtCore.Qt.Key.Key_Down else -1))))
                            return True
                        if k in (QtCore.Qt.Key.Key_Return, QtCore.Qt.Key.Key_Enter):
                            go()
                            return True
                    return False

            keys = Keys(dlg)
            edit.installEventFilter(keys)
            edit.textChanged.connect(fill)
            lst.itemActivated.connect(go)
            fill()
            g = window.geometry()
            dlg.adjustSize()
            dlg.move(g.x() + (g.width() - dlg.width()) // 2, g.y() + 60)
            edit.setFocus()
            dlg.exec()

        def show_shortcuts(self) -> None:
            rows = [(t, k) for t, k, _ in self.entries() if k]
            dlg = QtWidgets.QDialog(window)
            dlg.setWindowTitle("Keyboard shortcuts")
            lay = QtWidgets.QVBoxLayout(dlg)
            table = QtWidgets.QTableWidget(len(rows), 2)
            table.setHorizontalHeaderLabels(["Command", "Keys"])
            table.verticalHeader().setVisible(False)
            table.setEditTriggers(QtWidgets.QAbstractItemView.EditTrigger.NoEditTriggers)
            for r, (t, k) in enumerate(sorted(rows)):
                table.setItem(r, 0, QtWidgets.QTableWidgetItem(t))
                table.setItem(r, 1, QtWidgets.QTableWidgetItem(k))
            table.horizontalHeader().setSectionResizeMode(0, QtWidgets.QHeaderView.ResizeMode.Stretch)
            table.resizeColumnToContents(1)
            hint = QtWidgets.QLabel("Ctrl+wheel or a pinch over a list or text box makes its text bigger or smaller; anywhere else, the whole window.")
            hint.setObjectName("hint")
            hint.setWordWrap(True)
            lay.addWidget(table)
            lay.addWidget(hint)
            dlg.resize(480, 420)
            dlg.exec()

    ergo = Ergo()
    app.installEventFilter(ergo)
    _installed[id(window)] = ergo
    return ergo
