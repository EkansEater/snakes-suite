"""xdg-desktop-portal ScreenCast client.

On Wayland an app cannot grab the screen directly; it has to ask the desktop
portal, which shows the "share your screen" dialog and hands back a PipeWire
stream. Gio's D-Bus callbacks are dispatched by Qt's GLib event loop.
"""

import secrets

from gi.repository import Gio, GLib
from PyQt6.QtCore import QObject, pyqtSignal

BUS = "org.freedesktop.portal.Desktop"
PATH = "/org/freedesktop/portal/desktop"
IFACE = "org.freedesktop.portal.ScreenCast"

SOURCE_MONITOR = 1
SOURCE_WINDOW = 2
CURSOR_HIDDEN = 1
CURSOR_EMBEDDED = 2
PERSIST_UNTIL_REVOKED = 2


class ScreenCast(QObject):
    # {"node": int, "size": (w, h) | None, "position": (x, y) | None, "restore_token": str}
    ready = pyqtSignal(dict)
    failed = pyqtSignal(str)
    closed = pyqtSignal()  # the desktop ended the session (e.g. "stop sharing")

    def __init__(self, parent=None):
        super().__init__(parent)
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.sender = self.bus.get_unique_name()[1:].replace(".", "_")
        self.session = None
        self._closed_sub = None
        self._done = False

    # -- public -----------------------------------------------------------
    def open(self, source_type, show_cursor, restore_token=""):
        self._source_type = source_type
        self._cursor = CURSOR_EMBEDDED if show_cursor else CURSOR_HIDDEN
        self._restore_token = restore_token or ""
        self._request(
            "CreateSession",
            lambda opts: GLib.Variant("(a{sv})", (opts,)),
            self._on_session,
            {"session_handle_token": GLib.Variant("s", "snakescreen_" + secrets.token_hex(6))},
        )

    def open_remote(self):
        """Return a new PipeWire fd for the session. The caller owns it."""
        _, fds = self.bus.call_with_unix_fd_list_sync(
            BUS, PATH, IFACE, "OpenPipeWireRemote",
            GLib.Variant("(oa{sv})", (self.session, {})),
            GLib.VariantType("(h)"), Gio.DBusCallFlags.NONE, -1, None, None,
        )
        return fds.get(0)

    def close(self):
        self._done = True
        if self._closed_sub is not None:
            self.bus.signal_unsubscribe(self._closed_sub)
            self._closed_sub = None
        if self.session:
            self.bus.call(
                BUS, self.session, "org.freedesktop.portal.Session", "Close",
                None, None, Gio.DBusCallFlags.NONE, -1, None, None,
            )
            self.session = None

    # -- steps ------------------------------------------------------------
    def _on_session(self, results):
        self.session = results["session_handle"]
        self._closed_sub = self.bus.signal_subscribe(
            BUS, "org.freedesktop.portal.Session", "Closed", self.session, None,
            Gio.DBusSignalFlags.NONE, self._on_closed,
        )
        opts = {
            "types": GLib.Variant("u", self._source_type),
            "multiple": GLib.Variant("b", False),
            "cursor_mode": GLib.Variant("u", self._cursor),
            "persist_mode": GLib.Variant("u", PERSIST_UNTIL_REVOKED),
        }
        if self._restore_token:
            opts["restore_token"] = GLib.Variant("s", self._restore_token)
        self._request(
            "SelectSources",
            lambda o: GLib.Variant("(oa{sv})", (self.session, o)),
            self._on_sources,
            opts,
        )

    def _on_sources(self, _results):
        self._request(
            "Start",
            lambda o: GLib.Variant("(osa{sv})", (self.session, "", o)),
            self._on_started,
        )

    def _on_started(self, results):
        streams = results.get("streams") or []
        if not streams:
            self._fail("The desktop did not provide a screen stream.")
            return
        node, props = streams[0]
        self.ready.emit({
            "node": node,
            "size": tuple(props["size"]) if "size" in props else None,
            "position": tuple(props["position"]) if "position" in props else None,
            "restore_token": results.get("restore_token", ""),
        })

    def _on_closed(self, *_):
        if not self._done:
            self.session = None
            self.closed.emit()

    # -- plumbing ---------------------------------------------------------
    def _request(self, method, build_params, on_ok, options=None):
        token = "snakescreen_" + secrets.token_hex(6)
        request_path = f"{PATH}/request/{self.sender}/{token}"
        sub = []

        def on_response(_conn, _sender, _path, _iface, _signal, params):
            self.bus.signal_unsubscribe(sub[0])
            if self._done:
                return
            code, results = params.unpack()
            if code == 0:
                on_ok(results)
            elif code == 1:
                self._fail("cancelled")
            else:
                self._fail(f"The screen share request was refused ({method}).")

        def on_call_done(bus, res):
            try:
                bus.call_finish(res)
            except GLib.Error as e:
                self.bus.signal_unsubscribe(sub[0])
                self._fail(f"Screen capture portal error: {e.message}")

        sub.append(self.bus.signal_subscribe(
            BUS, "org.freedesktop.portal.Request", "Response", request_path, None,
            Gio.DBusSignalFlags.NONE, on_response,
        ))
        opts = dict(options or {})
        opts["handle_token"] = GLib.Variant("s", token)
        self.bus.call(
            BUS, PATH, IFACE, method, build_params(opts), None,
            Gio.DBusCallFlags.NONE, -1, None, on_call_done,
        )

    def _fail(self, message):
        if not self._done:
            self.close()
            self.failed.emit(message)
