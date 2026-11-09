"""Windows: psutil for interfaces and connections, netsh for Wi-Fi, and Windows' own
per-connection TCP statistics (GetPerTcpConnectionEStats) when run as administrator."""

import ctypes
import socket
import struct
import subprocess
from ctypes import wintypes

import psutil

from .common import STATE_NAMES, is_global, kind_from_name, norm_text

NO_WINDOW = 0x08000000  # CREATE_NO_WINDOW: helper programs don't flash a console


# --------------------------------------------------------------------------- TCP statistics
class MIB_TCPROW(ctypes.Structure):
    _fields_ = [("dwState", wintypes.DWORD), ("dwLocalAddr", wintypes.DWORD), ("dwLocalPort", wintypes.DWORD),
                ("dwRemoteAddr", wintypes.DWORD), ("dwRemotePort", wintypes.DWORD)]


class MIB_TCP6ROW(ctypes.Structure):
    _fields_ = [("State", wintypes.DWORD), ("LocalAddr", ctypes.c_ubyte * 16), ("dwLocalScopeId", wintypes.DWORD),
                ("dwLocalPort", wintypes.DWORD), ("RemoteAddr", ctypes.c_ubyte * 16),
                ("dwRemoteScopeId", wintypes.DWORD), ("dwRemotePort", wintypes.DWORD)]


class TCP_ESTATS_DATA_ROD_v0(ctypes.Structure):
    _fields_ = [("DataBytesOut", ctypes.c_uint64), ("DataSegsOut", ctypes.c_uint64),
                ("DataBytesIn", ctypes.c_uint64), ("DataSegsIn", ctypes.c_uint64),
                ("SegsOut", ctypes.c_uint64), ("SegsIn", ctypes.c_uint64),
                ("SoftErrors", wintypes.ULONG), ("SoftErrorReason", wintypes.ULONG),
                ("SndUna", wintypes.ULONG), ("SndNxt", wintypes.ULONG), ("SndMax", wintypes.ULONG),
                ("ThruBytesAcked", ctypes.c_uint64), ("RcvNxt", wintypes.ULONG),
                ("ThruBytesReceived", ctypes.c_uint64)]


class TCP_ESTATS_DATA_RW_v0(ctypes.Structure):
    _fields_ = [("EnableCollection", ctypes.c_ubyte)]


TcpConnectionEstatsData = 1
MIB_TCP_STATE_ESTAB = 5


class TcpStats:
    """Byte counts per TCP connection. Windows only counts once collection is switched on
    for a connection, and switching it on needs administrator rights."""

    def __init__(self):
        ip = ctypes.WinDLL("iphlpapi")
        self.set4, self.get4 = ip.SetPerTcpConnectionEStats, ip.GetPerTcpConnectionEStats
        self.set6, self.get6 = ip.SetPerTcp6ConnectionEStats, ip.GetPerTcp6ConnectionEStats
        self.enabled = set()

    @staticmethod
    def _row(laddr, lport, raddr, rport):
        if ":" in laddr or ":" in raddr:
            row = MIB_TCP6ROW()
            row.State = MIB_TCP_STATE_ESTAB
            row.LocalAddr[:] = socket.inet_pton(socket.AF_INET6, laddr if ":" in laddr else "::ffff:" + laddr)
            row.RemoteAddr[:] = socket.inet_pton(socket.AF_INET6, raddr if ":" in raddr else "::ffff:" + raddr)
            row.dwLocalPort, row.dwRemotePort = socket.htons(lport), socket.htons(rport)
            return row, True
        row = MIB_TCPROW()
        row.dwState = MIB_TCP_STATE_ESTAB
        row.dwLocalAddr = struct.unpack("<I", socket.inet_aton(laddr))[0]
        row.dwRemoteAddr = struct.unpack("<I", socket.inet_aton(raddr))[0]
        row.dwLocalPort, row.dwRemotePort = socket.htons(lport), socket.htons(rport)
        return row, False

    def read(self, key):
        """(received, sent) for an established connection, or None."""
        laddr, lport, raddr, rport = key
        try:
            row, v6 = self._row(laddr, lport, raddr, rport)
        except (OSError, ValueError):
            return None
        setf, getf = (self.set6, self.get6) if v6 else (self.set4, self.get4)
        if key not in self.enabled:
            rw = TCP_ESTATS_DATA_RW_v0(1)
            if setf(ctypes.byref(row), TcpConnectionEstatsData, ctypes.byref(rw), 0, ctypes.sizeof(rw), 0) != 0:
                return None
            self.enabled.add(key)
        rod = TCP_ESTATS_DATA_ROD_v0()
        if getf(ctypes.byref(row), TcpConnectionEstatsData, None, 0, 0, None, 0, 0,
                ctypes.byref(rod), 0, ctypes.sizeof(rod)) != 0:
            return None
        return rod.DataBytesIn, rod.DataBytesOut

    def forget(self, live):
        self.enabled &= live


# --------------------------------------------------------------------------- the source
def _run(cmd, timeout=5):
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=timeout, creationflags=NO_WINDOW)
        out = r.stdout
        for enc in ("utf-8", "mbcs"):
            try:
                return out.decode(enc)
            except (UnicodeDecodeError, LookupError):
                pass
        return out.decode("latin-1")
    except Exception:
        return ""


def _number(text):
    digits = "".join(ch for ch in text if ch.isdigit() or ch == ".")
    try:
        return float(digits)
    except ValueError:
        return None


class Source:
    os_name = "Windows"
    can_capture = False  # needs a capture driver (Npcap), which we don't ship
    counts_udp = False

    def __init__(self):
        self._admin = bool(ctypes.windll.shell32.IsUserAnAdmin())
        self.stats = TcpStats() if self._admin else None
        self.counts_tcp = self.stats is not None
        self._names = {}

    def elevated(self):
        return self._admin

    def sniffer(self):
        raise OSError("packet capture isn't available on Windows")

    def counters(self):
        return {n: (c.bytes_recv, c.bytes_sent) for n, c in psutil.net_io_counters(pernic=True).items()
                if kind_from_name(n) != "Loopback"}

    def iface_state(self, name):
        st = psutil.net_if_stats().get(name)
        kind = kind_from_name(name)
        if st is None:
            return kind, False, None
        return kind, st.isup, (st.speed or None) if kind == "Ethernet" else None

    def slow(self):
        addrs = {}
        for name, items in psutil.net_if_addrs().items():
            addrs[name] = [norm_text(a.address) for a in items
                           if a.family in (socket.AF_INET, socket.AF_INET6) and is_global(a.address)]
        wifi = {}
        info, name = {}, None
        for line in _run(["netsh", "wlan", "show", "interfaces"]).splitlines():
            k, sep, v = line.partition(":")
            if not sep:
                continue
            k, v = k.strip().lower(), v.strip()
            if k == "name":
                if name:
                    wifi[name] = info
                name, info = v, {}
            elif k == "ssid":
                info["ssid"] = v
            elif k == "signal":
                q = _number(v)
                if q is not None:
                    info["quality"] = int(q)
            elif k.startswith("receive rate"):
                info["rx_bitrate"] = _number(v)
            elif k.startswith("transmit rate"):
                info["tx_bitrate"] = _number(v)
            elif k == "state" and v.lower() != "connected":
                info["down"] = True
        if name:
            wifi[name] = info
        for n in wifi:
            wifi[n] = {k: v for k, v in wifi[n].items() if v is not None}
        return wifi, addrs

    def _proc(self, pid):
        if not pid:
            return "System" if pid == 0 else None
        name = self._names.get(pid)
        if name is None:
            try:
                name = psutil.Process(pid).name()
                if name.lower().endswith(".exe"):
                    name = name[:-4]
            except Exception:
                name = "?"
            self._names[pid] = name
        return name

    def sockets(self):
        tcp, udp = [], []
        live = set()
        try:
            conns = psutil.net_connections("inet")
        except Exception:
            conns = []
        pids = set()
        for c in conns:
            laddr, lport = (norm_text(c.laddr.ip), c.laddr.port) if c.laddr else ("", 0)
            raddr, rport = (norm_text(c.raddr.ip), c.raddr.port) if c.raddr else ("", 0)
            pids.add(c.pid)
            rec = {"laddr": laddr, "lport": lport, "raddr": raddr, "rport": rport, "pid": c.pid or None,
                   "proc": self._proc(c.pid), "key": None, "recv": None, "sent": None}
            if c.type == socket.SOCK_STREAM:
                rec["proto"] = "tcp"
                rec["state"] = STATE_NAMES.get(c.status, c.status)
                if self.stats and rec["state"] == "ESTAB" and raddr:
                    key = (laddr, lport, raddr, rport)
                    got = self.stats.read(key)
                    if got is not None:
                        live.add(key)
                        rec["key"] = key
                        rec["recv"], rec["sent"] = got
                tcp.append(rec)
            else:
                rec["proto"] = "udp"
                rec["state"] = ""
                udp.append(rec)
        if self.stats:
            self.stats.forget(live)
        for pid in list(self._names):
            if pid not in pids:
                del self._names[pid]
        return tcp, udp

    def mode(self, capturing):
        return "administrator: TCP speeds per app" if self._admin else "R: run as admin for app speeds"

    def note(self, capture_error):
        if not self._admin:
            return "per-app speeds need administrator: press R"
        return "UDP/QUIC per-app speeds aren't counted on Windows"

    def no_types_hint(self):
        if not self._admin:
            return ["Needs per-app speeds:", "press R to run as administrator."]
        return None
