"""Entry point: opens the app, or runs the command line when given arguments."""

from __future__ import annotations

import os
import sys


def use_system_libraries() -> None:
    """Start other programs with the system's libraries, not the bundled ones.

    The packaged app (PyInstaller) points LD_LIBRARY_PATH at its own bundled
    libraries, and every program it starts inherits that: ffmpeg, LibreOffice, and the file manager behind
    "Open folder". They load
    the bundled copies instead of their own and crash or quit once the system's
    are newer. This process keeps its libraries: the loader reads the variable
    only at start. PYINSTALLER_RESET_ENVIRONMENT makes a packaged app started
    from here unpack its own files instead of borrowing this one's.
    """
    if not getattr(sys, "frozen", False):
        return
    os.environ["PYINSTALLER_RESET_ENVIRONMENT"] = "1"
    original = os.environ.pop("LD_LIBRARY_PATH_ORIG", None)
    if original:
        os.environ["LD_LIBRARY_PATH"] = original
    else:
        os.environ.pop("LD_LIBRARY_PATH", None)


def main() -> int:
    use_system_libraries()
    if len(sys.argv) > 1:
        from .cli import main as cli_main

        return cli_main()
    return gui()


def gui() -> int:
    from .gui.app import run

    return run()


if __name__ == "__main__":
    sys.exit(main())
