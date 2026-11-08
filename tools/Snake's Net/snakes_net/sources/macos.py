"""macOS: psutil for interfaces, and macOS's own `nettop` for every connection with its
app and byte counts (TCP and UDP, so QUIC too). With sudo, nettop also sees system
services. Wi-Fi details come from system_profiler."""

import json
import os
import socket
import subprocess
import threading
import time

import psutil

from .common import STATE_NAMES, is_global, kind_from_name, norm_text

NETTOP_STATES = {
    "established": "ESTAB", "listen": "LISTEN", "synsent": "SYN-S", "synreceived": "SYN-R",
    "finwait1": "FIN-W1", "finwait2": "FIN-W2", "timewait": "T-WAIT", "closewait": "C-WAIT",
    "lastack": "L-ACK", "closing": "CLOSNG", "closed": "CLOSE",
}


def _side(text, v6):
    """'192.168.1.5:443', 'fe80::1%en0.443', '*:*' or '*.*' -> (address, port)."""
    text = text.strip()
    if v6:
        dot, colon = text.rfind("."), text.rfind(":")
        cut = dot if dot > colon else colon
    else:
        cut = text.rfind(":")
    if cut < 0:
        return norm_text(text), 0
    addr, port = text[:cut], text[cut + 1:]
    if addr in ("*", ""):
        addr = "::" if v6 else "0.0.0.0"
    return norm_text(addr), int(port) if port.isdigit() else 0


def parse_connection(label):
    """'tcp4 192.168.1.5:52817<->17.57.146.20:5223' -> (proto, laddr, lport, raddr, rport)."""
    head, _, rest = label.partition(" ")
    if not head[:3] in ("tcp", "udp") or "<->" not in rest:
        return None
    v6 = head.endswith("6")
    left, _, right = rest.partition("<->")
    laddr, lport = _side(left, v6)
    raddr, rport = _side(right, v6)
    if raddr in ("0.0.0.0", "::"):
        raddr = ""
    return head[:3], laddr, lport, raddr, rport


class Nettop(threading.Thread):
    """Runs `nettop` once, in logging mode, and keeps its latest sample."""

    def __init__(self):
        super().__init__(daemon=True)
        self.rows = []      # latest complete sample
        self.error = None
        self.when = 0.0
        self.proc = None

    def run(self):
        cmd = ["nettop", "-L", "0", "-s", "1", "-n", "-x", "-J", "interface,state,bytes_in,bytes_out"]
        try:
            self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
                                         errors="replace", bufsize=1)
        except OSError as e:
            self.error = str(e)
            return
        cols, cur, owner = None, [], (None, None)
        for line in self.proc.stdout:
            line = line.rstrip("\n")
            if not line:
                continue
            fields = line.split(",")
            if fields[0] == "time":  # a header starts each sample
                if cols is not None:
                    self.rows, self.when = cur, time.monotonic()
                cols = {name: i for i, name in enumerate(fields) if name}
                cur, owner = [], (None, None)
                continue
            if cols is None or len(fields) < 2:
                continue

            def col(name):
                i = cols.get(name)
                return fields[i].strip() if i is not None and i < len(fields) else ""

            label = fields[1].strip()
            conn = parse_connection(label)
            if conn is None:
                # A process line: "Google Chrome H.1234"
                name, _, pid = label.rpartition(".")
                owner = (int(pid), name) if pid.isdigit() else (None, label)
                continue
            try:
                rin, rout = int(col("bytes_in") or 0), int(col("bytes_out") or 0)
            except ValueError:
                rin = rout = 0
            cur.append((conn, owner, col("state"), col("interface"), rin, rout))
        self.error = "nettop stopped"
        if cols is not None and cur:
            self.rows = cur


class Source:
    os_name = "macOS"
    can_capture = False  # nettop already counts every connection, TCP and UDP
    counts_udp = True

    def __init__(self):
        self._root = os.geteuid() == 0
        self.nettop = Nettop()
        self.nettop.start()
        self.counts_tcp = True
        self._ports = {}

    def elevated(self):
        return self._root

    def sniffer(self):
        raise OSError("not needed on macOS")

    def counters(self):
        return {n: (c.bytes_recv, c.bytes_sent) for n, c in psutil.net_io_counters(pernic=True).items()
                if not n.startswith("lo")}

    def _hardware_ports(self):
        """en0 -> 'Wi-Fi', en1 -> 'Thunderbolt Ethernet' ..., from networksetup."""
        if self._ports:
            return self._ports
        try:
            out = subprocess.run(["networksetup", "-listallhardwareports"], capture_output=True, text=True,
                                 timeout=5).stdout
        except Exception:
            out = ""
        port = None
        for line in out.splitlines():
            if line.startswith("Hardware Port:"):
                port = line.split(":", 1)[1].strip()
            elif line.startswith("Device:") and port:
                self._ports[line.split(":", 1)[1].strip()] = port
        return self._ports

    def iface_state(self, name):
        port = self._hardware_ports().get(name, "")
        if port:
            kind = "Wi-Fi" if "wi-fi" in port.lower() or "airport" in port.lower() else (
                "Ethernet" if any(w in port.lower() for w in ("ethernet", "lan", "thunderbolt e"))
                else "Virtual")
        else:
            kind = kind_from_name(name)
            if kind == "Ethernet" and name.startswith("en") and self._ports:
                kind = "Virtual"  # an en* with no hardware port is a bridge or virtual adapter
        st = psutil.net_if_stats().get(name)
        if st is None:
            return kind, False, None
        return kind, st.isup, (st.speed or None) if kind == "Ethernet" else None

    def slow(self):
        addrs = {}
        for name, items in psutil.net_if_addrs().items():
            addrs[name] = [norm_text(a.address) for a in items
                           if a.family in (socket.AF_INET, socket.AF_INET6) and is_global(a.address)]
        now = time.monotonic()
        if now - getattr(self, "_wifi_at", -99) > 20:  # system_profiler is slow; ask now and then
            self._wifi_at = now
            self._wifi = self._wifi_details()
        wifi = getattr(self, "_wifi", {})
        return wifi, addrs

    def _wifi_details(self):
        try:
            out = subprocess.run(["system_profiler", "SPAirPortDataType", "-json"], capture_output=True,
                                 text=True, timeout=20).stdout
            data = json.loads(out or "{}")
        except Exception:
            return {}
        wifi = {}
        for block in data.get("SPAirPortDataType", []):
            for itf in block.get("spairport_airport_interfaces", []):
                name = itf.get("_name")
                cur = itf.get("spairport_current_network_information") or {}
                info = {}
                if cur.get("_name") and cur["_name"] != "<redacted>":
                    info["ssid"] = cur["_name"]
                elif cur:
                    info["ssid"] = "connected"
                sn = str(cur.get("spairport_signal_noise", ""))
                if "dBm" in sn:
                    try:
                        info["signal"] = int(sn.split("dBm")[0].strip())
                    except ValueError:
                        pass
                rate = cur.get("spairport_network_rate")
                if isinstance(rate, (int, float)):
                    info["rx_bitrate"] = info["tx_bitrate"] = float(rate)
                if name:
                    wifi[name] = info
        return wifi

    def sockets(self):
        rows = self.nettop.rows
        if not rows and self.nettop.error:
            return self._psutil_sockets()
        tcp, udp = [], []
        for (proto, laddr, lport, raddr, rport), (pid, name), state, _itf, rin, rout in rows:
            st = NETTOP_STATES.get(state.lower().replace(" ", "").replace("_", ""), "") if proto == "tcp" else ""
            rec = {"proto": proto, "state": st, "laddr": laddr, "lport": lport, "raddr": raddr, "rport": rport,
                   "pid": pid, "proc": name, "key": (proto, pid, laddr, lport, raddr, rport),
                   "recv": rin, "sent": rout}
            if proto == "tcp" and st == "LISTEN":
                rec["recv"] = rec["sent"] = None
            (tcp if proto == "tcp" else udp).append(rec)
        return tcp, udp

    def _psutil_sockets(self):
        """Fallback without nettop: connections only (all of them as root)."""
        self.counts_tcp = False
        tcp, udp = [], []
        try:
            conns = psutil.net_connections("inet")
        except Exception:
            conns = []
        for c in conns:
            laddr, lport = (norm_text(c.laddr.ip), c.laddr.port) if c.laddr else ("", 0)
            raddr, rport = (norm_text(c.raddr.ip), c.raddr.port) if c.raddr else ("", 0)
            try:
                name = psutil.Process(c.pid).name() if c.pid else None
            except Exception:
                name = None
            rec = {"laddr": laddr, "lport": lport, "raddr": raddr, "rport": rport, "pid": c.pid, "proc": name,
                   "key": None, "recv": None, "sent": None}
            if c.type == socket.SOCK_STREAM:
                rec.update(proto="tcp", state=STATE_NAMES.get(c.status, c.status))
                tcp.append(rec)
            else:
                rec.update(proto="udp", state="")
                udp.append(rec)
        return tcp, udp

    def mode(self, capturing):
        return "every app (sudo)" if self._root else "R: sudo to include system services"

    def note(self, capture_error):
        if self.nettop.error and not self.nettop.rows:
            return f"per-app speeds off: {self.nettop.error}"
        return None if self._root else "system services show with sudo: press R"

    def no_types_hint(self):
        if self.nettop.error and not self.nettop.rows:
            return ["Needs per-app speeds:", "nettop didn't start."]
        return None
