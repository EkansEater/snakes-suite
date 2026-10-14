"""Tiny local-socket protocol so `snakepad play 3` can control the running GUI.

This is how global hotkeys work on Wayland: bind a command in your desktop's
shortcut settings (KDE: System Settings > Shortcuts > Add Command).
"""

from __future__ import annotations

from PySide6.QtCore import QObject, Signal
from PySide6.QtNetwork import QLocalServer, QLocalSocket

SERVER_NAME = "snakepad-ipc"


def send_command(cmd: str, timeout_ms: int = 1000) -> str | None:
    """Send a command to a running instance. Returns its reply, or None if none is running."""
    sock = QLocalSocket()
    sock.connectToServer(SERVER_NAME)
    if not sock.waitForConnected(timeout_ms):
        return None
    sock.write(cmd.encode() + b"\n")
    sock.flush()
    sock.waitForBytesWritten(timeout_ms)
    reply = b""
    if sock.waitForReadyRead(timeout_ms):
        reply = bytes(sock.readAll())
    sock.disconnectFromServer()
    return reply.decode(errors="replace").strip()


class CommandServer(QObject):
    """Emits `command(text, reply_fn)` for each line received."""

    command = Signal(str, object)

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self.server = QLocalServer(self)
        QLocalServer.removeServer(SERVER_NAME)  # stale socket from a crash
        if not self.server.listen(SERVER_NAME):
            raise RuntimeError(f"IPC listen failed: {self.server.errorString()}")
        self.server.newConnection.connect(self._on_conn)

    def _on_conn(self) -> None:
        while self.server.hasPendingConnections():
            sock = self.server.nextPendingConnection()
            sock.readyRead.connect(lambda s=sock: self._on_ready(s))
            sock.disconnected.connect(sock.deleteLater)

    def _on_ready(self, sock: QLocalSocket) -> None:
        while sock.canReadLine():
            line = bytes(sock.readLine()).decode(errors="replace").strip()
            if line:
                def reply(msg: str, s=sock) -> None:
                    s.write(msg.encode() + b"\n")
                    s.flush()
                self.command.emit(line, reply)
