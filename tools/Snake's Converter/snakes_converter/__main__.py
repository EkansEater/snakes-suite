"""Entry point: opens the app, or runs the command line when given arguments."""

from __future__ import annotations

import sys


def main() -> int:
    if len(sys.argv) > 1:
        from .cli import main as cli_main

        return cli_main()
    return gui()


def gui() -> int:
    from .gui.app import run

    return run()


if __name__ == "__main__":
    sys.exit(main())
