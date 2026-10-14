"""Application start-up."""

from __future__ import annotations

import sys
from pathlib import Path

from PySide6.QtWidgets import QApplication

from .. import APP_NAME, __version__
from .main_window import MainWindow
from . import snake_theme

ASSETS = Path(__file__).resolve().parent.parent / "assets"


def run() -> int:
    app = QApplication(sys.argv[:1])
    app.setApplicationName(APP_NAME)
    app.setApplicationDisplayName(APP_NAME)
    app.setApplicationVersion(__version__)
    app.setOrganizationName("Snake")
    app.setDesktopFileName("snakes-converter")
    snake_theme.apply(app, icon_path=ASSETS / "icon.svg")

    window = MainWindow(ASSETS)
    window.show()
    return app.exec()
