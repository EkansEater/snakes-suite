"""Snake's Suite look for Qt apps: the "Snake Dark" theme of Snake's Code.

This file is shared by every Qt tool in the suite. The master copy lives in
Snake's Suite/shared/qt/; `python shared/sync.py` copies it into each tool, so
edit it there, not in a tool.

Works with PySide6 and PyQt6: it uses whichever the app has already imported.

    import snake_theme
    snake_theme.apply(app)                       # palette, stylesheet, font
    header = snake_theme.HeaderBar("Snake's Converter", "Audio · Video", icon_path)

Object names the stylesheet knows (set with widget.setObjectName):
    QPushButton  primary, danger, record, flat
    QLabel       title, subtitle, muted, heading, status, hint, timer, accent, error
    QFrame       card, dropzone (property active=true while dragging over it)
"""

from __future__ import annotations

import sys

# --- the palette: Snake Dark from Snake's Code (src/renderer/modules/themes.js) ---
BG = "#1a1e1b"          # editor background, main window
SIDE = "#151916"        # side bar, panels, cards
TITLE = "#111412"       # title bar, status bar
FG = "#d5ddd7"
FG2 = "#8a978e"         # secondary text
FG3 = "#5d6a62"         # disabled text
ACCENT = "#3fb950"      # buttons, focus, progress
ACCENT_HOVER = "#4cc75d"
ACCENT_FG = "#ffffff"
HIGHLIGHT = "#7ee787"   # links, highlights, the snake
BORDER = "#252b27"
BORDER2 = "#323a34"     # borders that need to show on SIDE
SELECTION = "#2b4a35"
HOVER = "#222823"
WIDGET = "#1f2420"      # menus, popups
INPUT = "#121513"
BUTTON2 = "#2a2f2b"     # secondary buttons
BUTTON2_HOVER = "#333a35"
ERROR = "#f14c4c"
ERROR_SOFT = "#ff8a8a"
WARNING = "#cca700"
INFO = "#3794ff"
RECORD = "#e5484d"
SCROLL = "#3d443f"
SCROLL_HOVER = "#525a54"

RADIUS = 6
FONT_PT = 10


def _qt():
    """(QtCore, QtGui, QtWidgets) of whichever binding the app uses."""
    if "PyQt6.QtWidgets" in sys.modules or ("PyQt6" in sys.modules and "PySide6" not in sys.modules):
        from PyQt6 import QtCore, QtGui, QtWidgets
    else:
        from PySide6 import QtCore, QtGui, QtWidgets
    return QtCore, QtGui, QtWidgets


STYLESHEET = f"""
* {{ font-size: {FONT_PT}pt; }}
QMainWindow, QDialog, QWidget#root {{ background: {BG}; }}
QWidget {{ color: {FG}; }}
QToolTip {{ background: {WIDGET}; color: {FG}; border: 1px solid {BORDER2}; padding: 5px 7px; border-radius: 4px; }}

/* ---- text ---- */
QLabel#title {{ font-size: 18pt; font-weight: 300; color: {FG}; }}
QLabel#heading {{ font-size: 11pt; font-weight: 600; color: {FG}; }}
QLabel#subtitle, QLabel#muted, QLabel#status, QLabel#fieldLabel {{ color: {FG2}; }}
QLabel#hint {{ color: {FG2}; font-size: 9pt; }}
QLabel#accent {{ color: {HIGHLIGHT}; }}
QLabel#error {{ color: {ERROR_SOFT}; }}
QLabel#timer {{ font-size: 22pt; font-weight: 300; color: {FG}; }}
QLabel[state="done"], QLabel#status[state="done"], QLabel#muted[state="done"] {{ color: {HIGHLIGHT}; }}
QLabel[state="failed"], QLabel#status[state="failed"], QLabel#muted[state="failed"] {{ color: {ERROR_SOFT}; }}
QLabel[state="cancelled"], QLabel#status[state="cancelled"], QLabel#muted[state="cancelled"] {{ color: {WARNING}; }}
QLabel a {{ color: {HIGHLIGHT}; }}

/* ---- the header bar every tool has, like the Snake's Code title bar ---- */
QFrame#headerBar {{ background: {TITLE}; border: none; border-bottom: 1px solid {BORDER}; }}
QFrame#headerBar QLabel#headerTitle {{ font-size: 12pt; font-weight: 600; color: {FG}; }}
QFrame#headerBar QLabel#headerSubtitle {{ color: {FG2}; }}
QFrame#statusBar, QStatusBar {{ background: {TITLE}; color: {FG2}; border-top: 1px solid {BORDER}; }}
QStatusBar::item {{ border: none; }}
QStatusBar QLabel {{ color: {FG2}; padding: 0 6px; }}

/* ---- surfaces ---- */
QFrame#card {{ background: {SIDE}; border: 1px solid {BORDER}; border-radius: 8px; }}
QFrame#card[state="done"] {{ border-color: #2d5a3a; }}
QFrame#card[state="failed"] {{ border-color: #6a2c33; }}
QFrame#dropzone {{ background: {SIDE}; border: 2px dashed {BORDER2}; border-radius: 10px; }}
QFrame#dropzone[active="true"] {{ border-color: {ACCENT}; background: #18241b; }}
QLabel#dropzone {{ color: {FG2}; font-size: 12pt; background: {SIDE}; border: 2px dashed {BORDER2}; border-radius: 10px; }}
QLabel#dropzone[active="true"] {{ border-color: {ACCENT}; color: {HIGHLIGHT}; background: #18241b; }}
QGroupBox {{ background: {SIDE}; border: 1px solid {BORDER}; border-radius: 8px; margin-top: 22px; padding: 12px 10px 10px 10px; }}
QGroupBox::title {{ subcontrol-origin: margin; subcontrol-position: top left; left: 4px; top: 2px; padding: 0 2px;
    color: {FG2}; font-size: 8.5pt; font-weight: 700; }}
QScrollArea {{ background: transparent; border: none; }}
QScrollArea > QWidget > QWidget {{ background: transparent; }}

/* ---- buttons ---- */
QPushButton, QToolButton {{
    background: {BUTTON2}; color: {FG}; border: 1px solid transparent; border-radius: 4px;
    padding: 5px 12px; min-height: 18px;
}}
QPushButton:hover, QToolButton:hover {{ background: {BUTTON2_HOVER}; }}
QPushButton:pressed, QToolButton:pressed {{ background: {HOVER}; }}
QPushButton:focus, QToolButton:focus {{ border-color: {ACCENT}; }}
QPushButton:disabled, QToolButton:disabled {{ color: {FG3}; background: {HOVER}; }}
QPushButton:checked, QToolButton:checked {{ background: {SELECTION}; color: {FG}; }}
QPushButton#primary {{ background: {ACCENT}; color: {ACCENT_FG}; font-weight: 600; padding: 6px 20px; }}
QPushButton#primary:hover {{ background: {ACCENT_HOVER}; }}
QPushButton#primary:disabled {{ background: #23402c; color: #6f8a77; }}
QPushButton#danger {{ background: #3a2224; color: {ERROR_SOFT}; padding: 6px 20px; }}
QPushButton#danger:hover {{ background: #4a2a2d; }}
QPushButton#flat {{ background: transparent; padding: 4px 8px; }}
QPushButton#flat:hover {{ background: {HOVER}; }}
QPushButton#small, QPushButton#smallDanger {{ padding: 3px 9px; font-size: 9pt; }}
QPushButton#smallDanger:hover {{ background: #3a2224; color: {ERROR_SOFT}; }}
QPushButton#record {{ background: {RECORD}; color: #ffffff; font-size: 12pt; font-weight: 600; padding: 10px; }}
QPushButton#record:hover {{ background: #f2555a; }}
QPushButton#record[recording="true"] {{ background: {BUTTON2}; border: 2px solid {RECORD}; }}
QPushButton#mode {{ padding: 9px; font-weight: 600; }}
QPushButton#mode:checked {{ background: {ACCENT}; color: {ACCENT_FG}; }}
QToolButton::menu-indicator {{ image: none; }}

/* ---- tool bars ---- */
QToolBar {{ background: {TITLE}; border: none; border-bottom: 1px solid {BORDER}; padding: 4px 6px; spacing: 4px; }}
QToolBar QToolButton {{ background: transparent; padding: 4px 8px; }}
QToolBar QToolButton:hover {{ background: {HOVER}; }}
QToolBar::separator {{ background: {BORDER}; width: 1px; margin: 4px 6px; }}

/* ---- inputs ---- */
QLineEdit, QComboBox, QSpinBox, QDoubleSpinBox, QTextEdit, QPlainTextEdit {{
    background: {INPUT}; color: {FG}; border: 1px solid {BORDER}; border-radius: 4px;
    padding: 4px 7px; min-height: 18px;
    selection-background-color: {SELECTION}; selection-color: {FG};
}}
QLineEdit:focus, QComboBox:focus, QSpinBox:focus, QDoubleSpinBox:focus, QTextEdit:focus, QPlainTextEdit:focus {{
    border-color: {ACCENT};
}}
QLineEdit:disabled, QComboBox:disabled, QSpinBox:disabled {{ color: {FG3}; }}
QComboBox:hover {{ border-color: {BORDER2}; }}
QComboBox::drop-down {{ border: none; width: 22px; }}
QComboBox::down-arrow {{ image: url(@DOWN@); width: 10px; height: 10px; margin-right: 8px; }}
QComboBox QAbstractItemView {{
    background: {WIDGET}; border: 1px solid {BORDER2}; outline: none; padding: 2px;
    selection-background-color: {SELECTION}; selection-color: {FG};
}}
QSpinBox::up-button, QSpinBox::down-button, QDoubleSpinBox::up-button, QDoubleSpinBox::down-button {{
    background: transparent; border: none; width: 16px;
}}
QSpinBox::up-arrow, QDoubleSpinBox::up-arrow {{ image: url(@UP@); width: 8px; height: 8px; }}
QSpinBox::down-arrow, QDoubleSpinBox::down-arrow {{ image: url(@DOWN@); width: 8px; height: 8px; }}

QCheckBox, QRadioButton {{ spacing: 8px; background: transparent; }}
QCheckBox::indicator, QRadioButton::indicator {{
    width: 15px; height: 15px; background: {INPUT}; border: 1px solid {BORDER2}; border-radius: 3px;
}}
QRadioButton::indicator {{ border-radius: 8px; }}
QCheckBox::indicator:hover, QRadioButton::indicator:hover {{ border-color: {ACCENT}; }}
QCheckBox::indicator:checked {{ background: {ACCENT}; border-color: {ACCENT}; image: url(@CHECK@); }}
QRadioButton::indicator:checked {{ background: {INPUT}; border-color: {ACCENT}; image: url(@RADIO@); }}
QCheckBox::indicator:disabled, QRadioButton::indicator:disabled {{ background: {HOVER}; border-color: {BORDER}; }}
QCheckBox:disabled, QRadioButton:disabled {{ color: {FG3}; }}

QSlider::groove:horizontal {{ height: 4px; background: {BUTTON2}; border-radius: 2px; }}
QSlider::sub-page:horizontal {{ background: {ACCENT}; border-radius: 2px; }}
QSlider::handle:horizontal {{ background: {HIGHLIGHT}; width: 14px; height: 14px; margin: -5px 0; border-radius: 7px; }}
QSlider::handle:horizontal:hover {{ background: #a2f0a9; }}
QSlider::sub-page:horizontal:disabled {{ background: {FG3}; }}
QSlider::handle:horizontal:disabled {{ background: {FG3}; }}

QProgressBar {{ background: {BUTTON2}; border: none; border-radius: 3px; min-height: 6px; max-height: 6px; }}
QProgressBar::chunk {{ background: {ACCENT}; border-radius: 3px; }}

/* ---- lists and tables, like the Snake's Code explorer ---- */
QListWidget, QListView, QTreeView, QTableWidget, QTableView {{
    background: {SIDE}; alternate-background-color: #171b18; border: 1px solid {BORDER}; border-radius: 6px;
    outline: none; gridline-color: transparent;
    selection-background-color: {SELECTION}; selection-color: {FG};
}}
QListWidget::item, QListView::item {{ padding: 5px 6px; border-radius: 4px; }}
QListWidget::item:hover, QListView::item:hover, QTreeView::item:hover {{ background: {HOVER}; }}
QListWidget::item:selected, QListView::item:selected, QTreeView::item:selected {{ background: {SELECTION}; color: {FG}; }}
QTableWidget::item, QTableView::item {{ padding: 4px 8px; border: none; }}
QTableWidget::item:selected, QTableView::item:selected {{ background: {SELECTION}; color: {FG}; }}
QHeaderView {{ background: transparent; }}
QHeaderView::section {{
    background: {SIDE}; color: {FG2}; border: none; border-bottom: 1px solid {BORDER};
    padding: 6px 8px; font-size: 8.5pt; font-weight: 700;
}}
QTableCornerButton::section {{ background: {SIDE}; border: none; }}

/* ---- menus ---- */
QMenu {{ background: {WIDGET}; border: 1px solid {BORDER2}; border-radius: 6px; padding: 4px; }}
QMenu::item {{ padding: 5px 22px 5px 12px; border-radius: 4px; }}
QMenu::item:selected {{ background: {SELECTION}; }}
QMenu::item:disabled {{ color: {FG3}; }}
QMenu::separator {{ height: 1px; background: {BORDER2}; margin: 4px 6px; }}
QMenuBar {{ background: {TITLE}; }}
QMenuBar::item {{ padding: 4px 8px; border-radius: 4px; background: transparent; }}
QMenuBar::item:selected {{ background: {HOVER}; }}

/* ---- scroll bars, thin like Snake's Code ---- */
QScrollBar:vertical {{ background: transparent; width: 10px; margin: 0; }}
QScrollBar:horizontal {{ background: transparent; height: 10px; margin: 0; }}
QScrollBar::handle:vertical {{ background: {SCROLL}; min-height: 28px; border-radius: 3px; margin: 2px; }}
QScrollBar::handle:horizontal {{ background: {SCROLL}; min-width: 28px; border-radius: 3px; margin: 2px; }}
QScrollBar::handle:hover {{ background: {SCROLL_HOVER}; }}
QScrollBar::add-line, QScrollBar::sub-line {{ width: 0; height: 0; }}
QScrollBar::add-page, QScrollBar::sub-page {{ background: transparent; }}

QTabWidget::pane {{ border: 1px solid {BORDER}; border-radius: 6px; top: -1px; background: {SIDE}; }}
QTabBar::tab {{ background: transparent; color: {FG2}; padding: 7px 14px; border: none; border-bottom: 2px solid transparent; }}
QTabBar::tab:selected {{ color: {FG}; border-bottom-color: {ACCENT}; }}
QTabBar::tab:hover {{ color: {FG}; }}
QDialogButtonBox QPushButton {{ min-width: 72px; }}
"""


# Small images the stylesheet needs (Qt draws no arrows once a combo box is styled).
_IMAGES = {
    "DOWN": f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M1.5 3.5 L5 7 L8.5 3.5" '
            f'fill="none" stroke="{FG2}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    "UP": f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M1.5 6.5 L5 3 L8.5 6.5" '
          f'fill="none" stroke="{FG2}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    "RADIO": f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="4.5" fill="{ACCENT}"/></svg>',
    "CHECK": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M3.5 8.5 L6.5 11.5 L12.5 4.5" '
             'fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
}


def stylesheet() -> str:
    """STYLESHEET with its image placeholders pointing at real files."""
    import tempfile
    import zlib
    from pathlib import Path

    folder = Path(tempfile.gettempdir()) / "snake-theme-images"
    sheet = STYLESHEET
    for name, svg in _IMAGES.items():
        path = folder / f"{name.lower()}-{zlib.crc32(svg.encode()):08x}.svg"
        try:
            if not path.exists():
                folder.mkdir(parents=True, exist_ok=True)
                path.write_text(svg)
        except OSError:
            pass  # without the file the arrow is simply not drawn
        sheet = sheet.replace(f"@{name}@", path.as_posix())
    return sheet


def palette():
    """Colours for the parts the stylesheet leaves to the Fusion style."""
    _, QtGui, _ = _qt()
    QColor, QPalette = QtGui.QColor, QtGui.QPalette
    pal = QPalette()
    role, group = QPalette.ColorRole, QPalette.ColorGroup
    for r, colour in (
        (role.Window, BG), (role.WindowText, FG), (role.Base, INPUT), (role.AlternateBase, SIDE),
        (role.Text, FG), (role.Button, BUTTON2), (role.ButtonText, FG), (role.BrightText, "#ffffff"),
        (role.ToolTipBase, WIDGET), (role.ToolTipText, FG), (role.Highlight, SELECTION),
        (role.HighlightedText, FG), (role.Link, HIGHLIGHT), (role.LinkVisited, HIGHLIGHT),
        (role.PlaceholderText, FG3), (role.Mid, BORDER2), (role.Dark, TITLE), (role.Shadow, "#000000"),
    ):
        pal.setColor(r, QColor(colour))
    for r in (role.Text, role.ButtonText, role.WindowText):
        pal.setColor(group.Disabled, r, QColor(FG3))
    return pal


def apply(app, *, icon_path=None) -> None:
    """Give a QApplication the suite look. Call once, before showing windows."""
    _, QtGui, _ = _qt()
    app.setStyle("Fusion")
    app.setPalette(palette())
    app.setStyleSheet(stylesheet())
    if icon_path:
        app.setWindowIcon(QtGui.QIcon(str(icon_path)))
    if sys.platform.startswith("win"):
        # Without its own id Windows files the app under python.exe and shows Python's icon
        # on the taskbar instead of the window icon.
        name = app.desktopFileName() or app.applicationName() or "app"
        try:
            import ctypes

            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(f"Snake.Suite.{name}")
        except (AttributeError, OSError):
            pass


def repolish(widget) -> None:
    """Re-read the stylesheet after changing a property it selects on."""
    widget.style().unpolish(widget)
    widget.style().polish(widget)
    widget.update()


def color(name: str):
    """A QColor of one of the palette constants, e.g. color(HIGHLIGHT)."""
    _, QtGui, _ = _qt()
    return QtGui.QColor(name)


def _header_bar_class():
    QtCore, QtGui, QtWidgets = _qt()

    class HeaderBar(QtWidgets.QFrame):
        """The strip along the top of every tool: logo, name, a subtitle and actions.

        Matches the Snake's Code title bar. Add buttons on the right with add_action().
        """

        def __init__(self, title: str, subtitle: str = "", icon_path=None, parent=None):
            super().__init__(parent)
            self.setObjectName("headerBar")
            self.setFixedHeight(52)
            lay = QtWidgets.QHBoxLayout(self)
            lay.setContentsMargins(14, 0, 12, 0)
            lay.setSpacing(10)
            if icon_path:
                logo = QtWidgets.QLabel()
                logo.setPixmap(QtGui.QIcon(str(icon_path)).pixmap(QtCore.QSize(32, 32)))
                lay.addWidget(logo)
            text = QtWidgets.QVBoxLayout()
            text.setSpacing(0)
            text.setContentsMargins(0, 0, 0, 0)
            name = QtWidgets.QLabel(title)
            name.setObjectName("headerTitle")
            text.addWidget(name)
            self.subtitle = QtWidgets.QLabel(subtitle)
            self.subtitle.setObjectName("headerSubtitle")
            self.subtitle.setVisible(bool(subtitle))
            text.addWidget(self.subtitle)
            lay.addLayout(text)
            lay.addStretch(1)
            self._actions = QtWidgets.QHBoxLayout()
            self._actions.setSpacing(6)
            lay.addLayout(self._actions)

        def add_widget(self, widget):
            self._actions.addWidget(widget)
            return widget

        def add_action(self, text: str, slot=None, *, tooltip: str = "", object_name: str = ""):
            button = QtWidgets.QPushButton(text)
            if object_name:
                button.setObjectName(object_name)
            if tooltip:
                button.setToolTip(tooltip)
            if slot is not None:
                button.clicked.connect(slot)
            button.setCursor(QtCore.Qt.CursorShape.PointingHandCursor)
            return self.add_widget(button)

    return HeaderBar


def __getattr__(name):
    # HeaderBar is built on first use so that importing this module never picks a Qt binding.
    if name == "HeaderBar":
        cls = _header_bar_class()
        globals()["HeaderBar"] = cls
        return cls
    raise AttributeError(name)
