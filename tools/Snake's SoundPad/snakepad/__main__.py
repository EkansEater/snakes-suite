"""Entry point.

    snakepad                 launch the GUI (or raise the running one)
    snakepad play <n|name>   play sound by 1-based index or name
    snakepad toggle <n|name> play, or stop if something is already playing
    snakepad random          play a random sound
    snakepad stop            stop all sounds
    snakepad list            print the sound list
    snakepad show | quit
"""

from __future__ import annotations

import signal
import sys

COMMANDS = {"play", "toggle", "random", "stop", "list", "show", "quit"}


def run_cli(args: list[str]) -> int:
    from PySide6.QtCore import QCoreApplication

    from .ipc import send_command

    QCoreApplication(sys.argv[:1])
    reply = send_command(" ".join(args))
    if reply is None:
        print("Snake's SoundPad is not running. Start it with: snakepad", file=sys.stderr)
        return 1
    print(reply)
    return 1 if reply.startswith("error") else 0


def run_gui() -> int:
    from PySide6.QtWidgets import QApplication, QMessageBox

    from .audio import AudioError, Player, VirtualDevices
    from .gui import MainWindow
    from .ipc import send_command
    from .library import Library

    from . import snake_ergo, snake_theme
    from .gui import ICON_PATH

    app = QApplication(sys.argv)
    app.setApplicationName("Snake's SoundPad")
    snake_theme.apply(app, icon_path=ICON_PATH)
    app.setDesktopFileName("snakepad")
    app.setQuitOnLastWindowClosed(False)

    # Single instance: if one is already running, just raise it.
    if send_command("show", timeout_ms=300) is not None:
        return 0

    # Linux with PipeWire: our own virtual microphone. Anywhere else (or if that
    # fails): a virtual cable the person installed, through Qt's own audio.
    devices = player = None
    if sys.platform.startswith("linux"):
        devices = VirtualDevices()
        try:
            player = Player()
            devices.setup()
        except AudioError as e:
            devices.teardown()
            devices = None
            print(f"Virtual microphone unavailable ({e}); using virtual-cable mode.", file=sys.stderr)
    if devices is None:
        from .cable import CableDevices, QtPlayer
        devices = CableDevices()
        devices.setup()
        player = QtPlayer(devices)

    # Always remove the virtual devices, however we exit.
    def _cleanup() -> None:
        player.stop()
        devices.teardown()

    app.aboutToQuit.connect(_cleanup)
    for sig in [s for s in (getattr(signal, n, None) for n in ('SIGINT', 'SIGTERM', 'SIGHUP')) if s is not None]:
        signal.signal(sig, lambda *_: app.quit())
    # Let Python see signals while Qt's loop runs
    from PySide6.QtCore import QTimer
    tick = QTimer(interval=250, timeout=lambda: None)
    tick.start()

    win = MainWindow(devices, player, Library.load())
    snake_ergo.install(win)
    win.show()
    try:
        return app.exec()
    finally:
        _cleanup()


def main() -> int:
    args = sys.argv[1:]
    if args and args[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    if args:
        if args[0] not in COMMANDS:
            print(f"Unknown command '{args[0]}'.\n{__doc__}", file=sys.stderr)
            return 2
        return run_cli(args)
    return run_gui()


if __name__ == "__main__":
    sys.exit(main())
