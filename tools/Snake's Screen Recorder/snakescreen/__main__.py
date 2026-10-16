"""Entry point: `python -m snakescreen` or the `snakescreen` command."""

import argparse
import getpass
import signal
import sys

from PyQt6.QtCore import QAbstractEventDispatcher, QTimer
from PyQt6.QtNetwork import QLocalServer, QLocalSocket
from PyQt6.QtWidgets import QApplication

from . import APP_ID, APP_NAME, __version__
from .platforms import KIND

SOCKET = f"snakescreen-{getpass.getuser()}"


def send_to_running_instance(command):
    sock = QLocalSocket()
    sock.connectToServer(SOCKET)
    if not sock.waitForConnected(300):
        return False
    sock.write(command.encode())
    sock.waitForBytesWritten(1000)
    sock.disconnectFromServer()
    return True


def main():
    parser = argparse.ArgumentParser(prog="snakescreen", description="Screen and audio recorder.")
    parser.add_argument("--version", action="version", version=f"{APP_NAME} {__version__}")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--toggle", action="store_const", const="toggle", dest="command",
                       help="start a recording, or stop the one in progress")
    group.add_argument("--stop", action="store_const", const="stop", dest="command",
                       help="stop the recording in progress")
    group.add_argument("--pause", action="store_const", const="pause", dest="command",
                       help="pause or resume the recording in progress")
    args = parser.parse_args()

    app = QApplication(sys.argv)
    app.setApplicationName(APP_ID)
    app.setOrganizationName(APP_ID)
    app.setApplicationDisplayName(APP_NAME)
    app.setDesktopFileName("snakescreen")
    app.setQuitOnLastWindowClosed(False)
    from . import snake_theme
    from .ui import ICON_PATH
    snake_theme.apply(app, icon_path=ICON_PATH)

    # Only one instance runs at a time; later invocations just pass a command on.
    if send_to_running_instance(args.command or "show"):
        return 0
    if args.command in ("stop", "pause"):
        print(f"{APP_NAME} is not running.", file=sys.stderr)
        return 1

    from .ui import MainWindow

    window = MainWindow()
    QLocalServer.removeServer(SOCKET)
    server = QLocalServer(app)

    def on_connection():
        conn = server.nextPendingConnection()
        conn.readyRead.connect(lambda: window.handle_command(bytes(conn.readAll()).decode().strip()))
        conn.disconnected.connect(conn.deleteLater)

    server.newConnection.connect(on_connection)
    server.listen(SOCKET)

    if KIND == "portal":
        # The portal's D-Bus replies arrive on the GLib main loop. Qt normally
        # runs on it already; if this Qt build does not, pump it by hand.
        dispatcher = QAbstractEventDispatcher.instance().metaObject().className()
        if "Glib" not in dispatcher:
            from gi.repository import GLib
            context = GLib.MainContext.default()
            pump = QTimer(app, interval=20)
            pump.timeout.connect(lambda: [None for _ in iter(lambda: context.iteration(False), False)])
            pump.start()

    signal.signal(signal.SIGINT, signal.SIG_DFL)  # let Ctrl+C in a terminal quit
    from . import snake_ergo
    snake_ergo.install(window)
    window.show()
    if args.command == "toggle":
        QTimer.singleShot(300, window.toggle_recording)
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
