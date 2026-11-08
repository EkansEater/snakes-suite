"""Snake's Net: a btop-style live network monitor for Linux.

No extra packages needed. Run as a normal user to see interface speeds and
per-connection TCP speeds for your own apps. Run with sudo to also capture
UDP/QUIC traffic and see every process.
"""

import argparse
import curses
import json
import locale
import os
import queue
import socket
import struct
import subprocess
import sys
import threading
import time
from collections import deque, defaultdict

from . import __version__ as VERSION

APP = "Snake's Net"
HIST = 2000  # samples kept per graph

# --------------------------------------------------------------------------
# Formatting
# --------------------------------------------------------------------------


def fmt_rate(v, bits):
    """v is bytes per second."""
    if bits:
        v *= 8
        units = ["b/s", "Kb/s", "Mb/s", "Gb/s", "Tb/s"]
    else:
        units = ["B/s", "KB/s", "MB/s", "GB/s", "TB/s"]
    i = 0
    while v >= 1000 and i < len(units) - 1:
        v /= 1000
        i += 1
    if i == 0:
        return f"{v:.0f} {units[i]}"
    return f"{v:.1f} {units[i]}" if v < 100 else f"{v:.0f} {units[i]}"


def fmt_bytes(n):
    units = ["B", "KB", "MB", "GB", "TB"]
    v = float(n)
    i = 0
    while v >= 1000 and i < len(units) - 1:
        v /= 1000
        i += 1
    if i == 0:
        return f"{v:.0f} {units[i]}"
    return f"{v:.1f} {units[i]}" if v < 100 else f"{v:.0f} {units[i]}"


def nice_max(v):
    """Round a graph maximum up to 1, 2 or 5 times a power of ten."""
    v = max(v, 1000.0)
    p = 1.0
    while p * 10 <= v:
        p *= 10
    for m in (1, 2, 5, 10):
        if m * p >= v:
            return m * p
    return 10 * p


def trunc(s, w):
    if w <= 0:
        return ""
    return s if len(s) <= w else s[: max(0, w - 1)] + "…"


def trunc_left(s, w):
    """Cut from the left, keeping the end (the domain is the useful part)."""
    if w <= 0:
        return ""
    return s if len(s) <= w else "…" + s[len(s) - w + 1:]


# --------------------------------------------------------------------------
# Services and traffic types
# --------------------------------------------------------------------------

_SERVICES = {
    ("tcp", 80): ("HTTP", "Web"), ("tcp", 443): ("HTTPS", "Web"),
    ("udp", 443): ("QUIC", "Web"), ("tcp", 8080): ("HTTP-alt", "Web"),
    ("tcp", 8443): ("HTTPS-alt", "Web"), ("tcp", 8000): ("HTTP-dev", "Web"),
    ("tcp", 3000): ("HTTP-dev", "Web"), ("tcp", 5173): ("Vite", "Web"),
    ("udp", 53): ("DNS", "DNS"), ("tcp", 53): ("DNS", "DNS"),
    ("tcp", 853): ("DNS-TLS", "DNS"), ("udp", 853): ("DNS-QUIC", "DNS"),
    ("udp", 5353): ("mDNS", "Local net"), ("udp", 5355): ("LLMNR", "Local net"),
    ("udp", 1900): ("SSDP/UPnP", "Local net"), ("tcp", 631): ("Printing", "Local net"),
    ("udp", 631): ("Printing", "Local net"), ("tcp", 8009): ("Chromecast", "Local net"),
    ("udp", 137): ("NetBIOS", "Files"), ("udp", 138): ("NetBIOS", "Files"),
    ("tcp", 139): ("NetBIOS", "Files"), ("tcp", 445): ("SMB", "Files"),
    ("tcp", 2049): ("NFS", "Files"), ("tcp", 21): ("FTP", "Files"),
    ("tcp", 873): ("rsync", "Files"),
    ("tcp", 22): ("SSH", "Remote"), ("tcp", 3389): ("RDP", "Remote"),
    ("tcp", 5900): ("VNC", "Remote"),
    ("tcp", 25): ("SMTP", "Mail"), ("tcp", 465): ("SMTPS", "Mail"),
    ("tcp", 587): ("SMTP", "Mail"), ("tcp", 143): ("IMAP", "Mail"),
    ("tcp", 993): ("IMAPS", "Mail"), ("tcp", 995): ("POP3S", "Mail"),
    ("udp", 123): ("NTP", "System"), ("udp", 67): ("DHCP", "System"),
    ("udp", 68): ("DHCP", "System"), ("udp", 546): ("DHCPv6", "System"),
    ("udp", 547): ("DHCPv6", "System"),
    ("tcp", 22000): ("Syncthing", "Sync"), ("udp", 22000): ("Syncthing", "Sync"),
    ("udp", 21027): ("Syncthing", "Sync"), ("tcp", 8384): ("Syncthing UI", "Sync"),
    ("udp", 41641): ("Tailscale", "VPN"), ("udp", 51820): ("WireGuard", "VPN"),
    ("udp", 1194): ("OpenVPN", "VPN"), ("tcp", 1194): ("OpenVPN", "VPN"),
    ("udp", 500): ("IPsec", "VPN"), ("udp", 4500): ("IPsec", "VPN"),
    ("udp", 3478): ("STUN", "Calls"), ("udp", 3479): ("STUN", "Calls"),
    ("tcp", 1935): ("RTMP", "Streaming"), ("tcp", 554): ("RTSP", "Streaming"),
    ("tcp", 3306): ("MySQL", "Database"), ("tcp", 5432): ("Postgres", "Database"),
    ("tcp", 6379): ("Redis", "Database"), ("tcp", 27017): ("MongoDB", "Database"),
    ("tcp", 9418): ("git", "Dev"), ("tcp", 11434): ("Ollama", "Dev"),
    ("tcp", 5222): ("XMPP", "Chat"), ("tcp", 6697): ("IRC", "Chat"),
}

_RANGES = [
    ("tcp", 6881, 6889, "BitTorrent", "P2P"), ("udp", 6881, 6889, "BitTorrent", "P2P"),
    ("udp", 27000, 27100, "Steam", "Gaming"), ("tcp", 27015, 27050, "Steam", "Gaming"),
    ("udp", 3074, 3074, "Xbox Live", "Gaming"), ("udp", 3478, 3480, "STUN", "Calls"),
    ("udp", 19302, 19309, "Google Meet", "Calls"), ("udp", 50000, 50100, "Discord", "Calls"),
    ("tcp", 47984, 48010, "Moonlight", "Streaming"),
    ("udp", 47998, 48010, "Moonlight", "Streaming"),
]


def lookup_port(proto, port):
    hit = _SERVICES.get((proto, port))
    if hit:
        return hit
    for p, lo, hi, name, cat in _RANGES:
        if p == proto and lo <= port <= hi:
            return (name, cat)
    return None


def classify(proto, lport, rport, listening_ports):
    if proto == "icmp":
        return ("ICMP", "Other")
    # The remote port tells us most for outgoing connections.
    hit = lookup_port(proto, rport)
    if hit:
        return hit
    hit = lookup_port(proto, lport)
    if hit:
        return hit
    if (proto, lport) in listening_ports:
        return (f"{lport} (in)", "Other")
    if rport and rport < 1024:
        try:
            return (socket.getservbyport(rport, proto).upper(), "Other")
        except OSError:
            pass
    return ("—", "Other")


CATEGORY_ORDER = ["Web", "Streaming", "Calls", "Gaming", "P2P", "Sync", "Files",
                  "Remote", "VPN", "DNS", "Mail", "Chat", "Dev", "Database",
                  "Local net", "System", "Other"]

# --------------------------------------------------------------------------
# Kernel readers
# --------------------------------------------------------------------------

TCP_STATES = {1: "ESTAB", 2: "SYN-S", 3: "SYN-R", 4: "FIN-W1", 5: "FIN-W2",
              6: "T-WAIT", 7: "CLOSE", 8: "C-WAIT", 9: "L-ACK", 10: "LISTEN",
              11: "CLOSNG"}


def read_file(path, default=""):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return default


def read_net_dev():
    out = {}
    try:
        with open("/proc/net/dev") as f:
            lines = f.readlines()[2:]
    except OSError:
        return out
    for line in lines:
        name, _, rest = line.partition(":")
        v = rest.split()
        if len(v) >= 16:
            out[name.strip()] = (int(v[0]), int(v[8]), int(v[1]), int(v[9]))
    return out


def iface_kind(name):
    p = f"/sys/class/net/{name}"
    if os.path.isdir(p + "/wireless") or os.path.exists(p + "/phy80211"):
        return "Wi-Fi"
    t = read_file(p + "/type", "0")
    if t == "772":
        return "Loopback"
    if t == "65534" or name.startswith(("tun", "tailscale", "wg", "tap", "ppp", "zt")):
        return "VPN"
    if name.startswith(("docker", "br-", "virbr", "veth", "vnet", "lxc", "podman")):
        return "Virtual"
    if os.path.exists(p + "/device"):
        return "Ethernet"
    return "Virtual"


def norm_addr(b):
    if len(b) == 4:
        return socket.inet_ntop(socket.AF_INET, b)
    if b[:12] == b"\0" * 10 + b"\xff\xff":
        return socket.inet_ntop(socket.AF_INET, b[12:16])
    return socket.inet_ntop(socket.AF_INET6, b)


def tcp_sockets():
    """All TCP sockets with byte counters, read from the kernel via netlink."""
    out = []
    for fam in (socket.AF_INET, socket.AF_INET6):
        s = socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, 4)  # NETLINK_SOCK_DIAG
        try:
            # inet_diag_req_v2: family, protocol, ext (INET_DIAG_INFO), pad, states, sockid
            req = struct.pack("=BBBxI", fam, socket.IPPROTO_TCP, 1 << 1, 0xFFFFFFFF) + b"\0" * 48
            # nlmsghdr: len, SOCK_DIAG_BY_FAMILY, NLM_F_REQUEST|NLM_F_DUMP, seq, pid
            s.send(struct.pack("=IHHII", 16 + len(req), 20, 0x301, 1, 0) + req)
            done = False
            while not done:
                data = s.recv(1 << 20)
                if not data:
                    break
                off = 0
                while off + 16 <= len(data):
                    ln, typ = struct.unpack_from("=IH", data, off)
                    if ln < 16 or typ == 3:  # NLMSG_DONE
                        done = True
                        break
                    if typ == 2:  # NLMSG_ERROR
                        raise OSError("sock_diag error")
                    out.append(_parse_diag(data, off + 16, off + ln, fam))
                    off += (ln + 3) & ~3
        finally:
            s.close()
    return out


def _parse_diag(data, p, end, fam):
    state = data[p + 1]
    sport, dport = struct.unpack_from(">HH", data, p + 4)
    alen = 4 if fam == socket.AF_INET else 16
    src = norm_addr(bytes(data[p + 8:p + 8 + alen]))
    dst = norm_addr(bytes(data[p + 24:p + 24 + alen]))
    cookie = bytes(data[p + 44:p + 52])
    uid, inode = struct.unpack_from("=II", data, p + 64)
    acked = received = None
    a = p + 72
    while a + 4 <= end:
        l, t = struct.unpack_from("=HH", data, a)
        if l < 4:
            break
        if t == 2 and l - 4 >= 136:  # INET_DIAG_INFO -> struct tcp_info
            acked, received = struct.unpack_from("=QQ", data, a + 4 + 120)
        a += (l + 3) & ~3
    return {"state": state, "laddr": src, "lport": sport, "raddr": dst, "rport": dport,
            "cookie": cookie, "uid": uid, "inode": inode, "sent": acked, "recv": received}


def _hex_addr(h):
    ip, port = h.split(":")
    b = bytes.fromhex(ip)
    if len(b) == 4:
        b = b[::-1]
    else:
        b = b"".join(b[i:i + 4][::-1] for i in range(0, 16, 4))
    return norm_addr(b), int(port, 16)


def proc_net_sockets(proto):
    """Parse /proc/net/{udp,udp6,tcp,tcp6}."""
    out = []
    for path in (f"/proc/net/{proto}", f"/proc/net/{proto}6"):
        try:
            with open(path) as f:
                lines = f.readlines()[1:]
        except OSError:
            continue
        for line in lines:
            v = line.split()
            if len(v) < 10:
                continue
            laddr, lport = _hex_addr(v[1])
            raddr, rport = _hex_addr(v[2])
            out.append({"state": int(v[3], 16), "laddr": laddr, "lport": lport,
                        "raddr": raddr, "rport": rport, "inode": int(v[9]),
                        "cookie": None, "sent": None, "recv": None})
    return out


def inode_owners():
    """Map socket inode -> (pid, process name). Without root, only your own."""
    m = {}
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        fdd = f"/proc/{pid}/fd"
        try:
            fds = os.listdir(fdd)
        except OSError:
            continue
        name = None
        for fd in fds:
            try:
                link = os.readlink(f"{fdd}/{fd}")
            except OSError:
                continue
            if link.startswith("socket:["):
                if name is None:
                    name = read_file(f"/proc/{pid}/comm", "?")
                m[int(link[8:-1])] = (int(pid), name)
    return m


def is_loopback(addr):
    return addr.startswith("127.") or addr == "::1"


# --------------------------------------------------------------------------
# Background workers
# --------------------------------------------------------------------------


class Sniffer(threading.Thread):
    """Counts bytes per flow from raw packets (needs root). Sees TCP and UDP."""

    def __init__(self):
        super().__init__(daemon=True)
        self.sock = socket.socket(socket.AF_PACKET, socket.SOCK_DGRAM, socket.htons(3))
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 16 << 20)
        self.flows = {}
        self.error = None

    def take(self):
        d, self.flows = self.flows, {}
        return d

    def run(self):
        buf = bytearray(80)
        recv = self.sock.recvfrom_into
        trunc_flag = socket.MSG_TRUNC
        try:
            while True:
                n, addr = recv(buf, 80, trunc_flag)
                if addr[0] == "lo" or addr[2] == 3:  # loopback / not for us
                    continue
                out = addr[2] == 4  # PACKET_OUTGOING
                eth = addr[1]
                if eth == 0x0800:
                    ihl = (buf[0] & 15) * 4
                    proto = buf[9]
                    src, dst = bytes(buf[12:16]), bytes(buf[16:20])
                    ph = ihl
                elif eth == 0x86DD:
                    proto = buf[6]
                    src, dst = bytes(buf[8:24]), bytes(buf[24:40])
                    ph = 40
                else:
                    continue
                if proto in (6, 17) and ph + 4 <= 80:
                    sp = (buf[ph] << 8) | buf[ph + 1]
                    dp = (buf[ph + 2] << 8) | buf[ph + 3]
                else:
                    sp = dp = 0
                if out:
                    key = (proto, src, sp, dst, dp)
                else:
                    key = (proto, dst, dp, src, sp)
                d = self.flows
                f = d.get(key)
                if f is None:
                    d[key] = f = [0, 0]
                f[out] += n
        except Exception as e:  # keep the UI alive, report the problem
            self.error = str(e)


class Resolver:
    """Reverse DNS in the background, with a cache."""

    def __init__(self, workers=4):
        self.cache = {}
        self.pending = set()
        self.q = queue.Queue()
        for _ in range(workers):
            threading.Thread(target=self._work, daemon=True).start()

    def name(self, ip):
        if ip in self.cache:
            return self.cache[ip] or ip
        if ip not in self.pending:
            self.pending.add(ip)
            self.q.put(ip)
        return ip

    def _work(self):
        while True:
            ip = self.q.get()
            try:
                n = socket.gethostbyaddr(ip)[0]
            except Exception:
                n = None
            self.cache[ip] = n
            self.pending.discard(ip)


class SlowPoller(threading.Thread):
    """Wi-Fi link details and IP addresses, every few seconds."""

    def __init__(self):
        super().__init__(daemon=True)
        self.wifi = {}
        self.addrs = {}

    def run(self):
        while True:
            try:
                self.poll()
            except Exception:
                pass
            time.sleep(3)

    def poll(self):
        try:
            r = subprocess.run(["ip", "-j", "addr"], capture_output=True, text=True, timeout=3)
            addrs = {}
            for d in json.loads(r.stdout or "[]"):
                ips = [a["local"] for a in d.get("addr_info", [])
                       if a.get("scope") == "global" and "local" in a]
                addrs[d["ifname"]] = ips
            self.addrs = addrs
        except Exception:
            pass
        wifi = {}
        for name in os.listdir("/sys/class/net"):
            if iface_kind(name) != "Wi-Fi":
                continue
            info = {}
            try:
                r = subprocess.run(["iw", "dev", name, "link"], capture_output=True,
                                   text=True, timeout=3)
                for line in r.stdout.splitlines():
                    k, _, v = line.strip().partition(":")
                    v = v.strip()
                    if k == "SSID":
                        info["ssid"] = v
                    elif k == "signal":
                        info["signal"] = int(v.split()[0])
                    elif k == "freq":
                        info["freq"] = float(v.split()[0])
                    elif k == "rx bitrate":
                        info["rx_bitrate"] = float(v.split()[0])
                    elif k == "tx bitrate":
                        info["tx_bitrate"] = float(v.split()[0])
            except Exception:
                pass
            wifi[name] = info
        self.wifi = wifi


# --------------------------------------------------------------------------
# Collector: everything the screen shows
# --------------------------------------------------------------------------


class Iface:
    def __init__(self, name):
        self.name = name
        self.kind = iface_kind(name)
        self.rx = self.tx = 0.0  # bytes/s now
        self.rx_tot = self.tx_tot = 0  # since start
        self.rx_peak = self.tx_peak = 0.0
        self.hist_rx = deque([0.0] * HIST, maxlen=HIST)
        self.hist_tx = deque([0.0] * HIST, maxlen=HIST)
        self.up = False
        self.speed = None  # Ethernet link speed, Mb/s

    @property
    def physical(self):
        return self.kind in ("Wi-Fi", "Ethernet")


class Collector:
    def __init__(self, capture, resolver):
        self.resolver = resolver
        self.sniffer = None
        self.capture_error = None
        if capture:
            try:
                self.sniffer = Sniffer()
                self.sniffer.start()
            except PermissionError:
                self.capture_error = "packet capture needs root"
            except OSError as e:
                self.capture_error = str(e)
        self.slow = SlowPoller()
        self.slow.start()
        self.t_prev = None
        self.first = True
        self.dev_prev = {}
        self.ifaces = {}
        self.all = Iface("all")
        self.all.kind = "All"
        self.tcp_prev = {}
        self.cap = {}  # flow key -> record
        self.flows = []
        self.listening = []
        self.cat_tot = defaultdict(lambda: [0, 0])
        self.cat_rate = defaultdict(lambda: [0.0, 0.0])
        self.diag_ok = True

    @property
    def capturing(self):
        return self.sniffer is not None and self.sniffer.error is None

    def update(self):
        now = time.monotonic()
        dt = (now - self.t_prev) if self.t_prev else 0
        self.t_prev = now
        self._update_ifaces(dt)
        self._update_sockets(dt, now)
        self.first = False

    # ---- interfaces
    def _update_ifaces(self, dt):
        dev = read_net_dev()
        tot_rx = tot_tx = 0.0
        for name, (rx, tx, _, _) in dev.items():
            if name == "lo":
                continue
            it = self.ifaces.get(name)
            if it is None:
                it = self.ifaces[name] = Iface(name)
            prev = self.dev_prev.get(name)
            if prev and dt > 0:
                drx, dtx = max(0, rx - prev[0]), max(0, tx - prev[1])
                it.rx, it.tx = drx / dt, dtx / dt
                it.rx_tot += drx
                it.tx_tot += dtx
            it.rx_peak = max(it.rx_peak, it.rx)
            it.tx_peak = max(it.tx_peak, it.tx)
            it.hist_rx.append(it.rx)
            it.hist_tx.append(it.tx)
            it.up = read_file(f"/sys/class/net/{name}/operstate") in ("up", "unknown")
            if it.kind == "Ethernet":
                sp = read_file(f"/sys/class/net/{name}/speed", "-1")
                it.speed = int(sp) if sp.lstrip("-").isdigit() and int(sp) > 0 else None
            if it.physical:
                tot_rx += it.rx
                tot_tx += it.tx
                if prev and dt > 0:
                    self.all.rx_tot += max(0, rx - prev[0])
                    self.all.tx_tot += max(0, tx - prev[1])
            self.dev_prev[name] = (rx, tx)
        for name in list(self.ifaces):
            if name not in dev:
                del self.ifaces[name]
        a = self.all
        a.rx, a.tx = tot_rx, tot_tx
        a.rx_peak, a.tx_peak = max(a.rx_peak, a.rx), max(a.tx_peak, a.tx)
        a.hist_rx.append(a.rx)
        a.hist_tx.append(a.tx)
        a.up = True

    # ---- sockets, flows, listening ports
    def _update_sockets(self, dt, now):
        owners = inode_owners()
        try:
            tcp = tcp_sockets()
            self.diag_ok = True
        except OSError:
            tcp = proc_net_sockets("tcp")
            self.diag_ok = False
        udp = proc_net_sockets("udp")

        def owner(inode):
            return owners.get(inode, (None, None)) if inode else (None, None)

        # Listening ports
        listening = {}
        lports = set()
        for s in tcp:
            if s["state"] == 10:
                lports.add(("tcp", s["lport"]))
                key = ("tcp", s["lport"], s["laddr"])
                listening[key] = ("tcp", s, owner(s["inode"]))
        for s in udp:
            if s["state"] == 7 and s["rport"] == 0 and s["lport"]:
                lports.add(("udp", s["lport"]))
                key = ("udp", s["lport"], s["laddr"])
                listening[key] = ("udp", s, owner(s["inode"]))
        self.listening = self._merge_listening(listening.values(), lports)

        # Indexes for matching captured packets to processes
        tcp_idx = {}
        for s in tcp:
            if s["state"] != 10:
                tcp_idx[(s["lport"], s["raddr"], s["rport"])] = s
        udp_conn = {(s["lport"], s["raddr"], s["rport"]): s for s in udp if s["rport"]}
        udp_port = {s["lport"]: s for s in udp if not s["rport"]}
        tcp_listen = {s["lport"]: s for s in tcp if s["state"] == 10}

        flows = []
        cat_delta = defaultdict(lambda: [0, 0])
        if self.capturing:
            delta = self.sniffer.take()
            seen = set()
            for (pn, lip, lport, rip, rport), (bin_, bout) in delta.items():
                proto = {6: "tcp", 17: "udp", 1: "icmp", 58: "icmp"}.get(pn, f"ip{pn}")
                key = (proto, norm_addr(lip), lport, norm_addr(rip), rport)
                rec = self.cap.get(key)
                if rec is None:
                    rec = self.cap[key] = {"proto": proto, "laddr": key[1], "lport": lport,
                                           "raddr": key[3], "rport": rport, "recv": 0,
                                           "sent": 0, "last": now}
                rec["recv"] += bin_
                rec["sent"] += bout
                rec["down"] = bin_ / dt if dt else 0
                rec["up"] = bout / dt if dt else 0
                rec["last"] = now
                seen.add(key)
                svc, cat = classify(proto, lport, rport, lports)
                cat_delta[cat][0] += bin_
                cat_delta[cat][1] += bout
            for key, rec in list(self.cap.items()):
                if key not in seen:
                    rec["down"] = rec["up"] = 0.0
                    if now - rec["last"] > 30 and (key[2], key[3], key[4]) not in tcp_idx:
                        del self.cap[key]
            # Established TCP connections that sent nothing lately still appear.
            for s in tcp:
                if s["state"] in (10, 6):
                    continue
                key = ("tcp", s["laddr"], s["lport"], s["raddr"], s["rport"])
                if key not in self.cap:
                    self.cap[key] = {"proto": "tcp", "laddr": s["laddr"], "lport": s["lport"],
                                     "raddr": s["raddr"], "rport": s["rport"], "recv": 0,
                                     "sent": 0, "down": 0.0, "up": 0.0, "last": now}
            for key, rec in self.cap.items():
                proto, lport, raddr, rport = rec["proto"], rec["lport"], rec["raddr"], rec["rport"]
                sock = None
                if proto == "tcp":
                    sock = tcp_idx.get((lport, raddr, rport)) or tcp_listen.get(lport)
                elif proto == "udp":
                    sock = udp_conn.get((lport, raddr, rport)) or udp_port.get(lport)
                pid, name = owner(sock["inode"]) if sock else (None, None)
                state = TCP_STATES.get(sock["state"], "") if (sock and proto == "tcp") else ""
                flows.append(self._flow(rec, pid, name, state, lports))
        else:
            new_prev = {}
            for s in tcp:
                if s["state"] == 10 or s["state"] == 6:
                    continue
                down = up = None
                if s["recv"] is not None and s["cookie"]:
                    down = up = 0.0
                    prev = self.tcp_prev.get(s["cookie"])
                    if prev is not None:
                        drecv, dsent = s["recv"] - prev[0], s["sent"] - prev[1]
                    elif not self.first:
                        drecv, dsent = s["recv"], s["sent"]  # new since last tick
                    else:
                        drecv = dsent = 0
                    drecv, dsent = max(0, drecv), max(0, dsent)
                    if dt:
                        down, up = drecv / dt, dsent / dt
                    new_prev[s["cookie"]] = (s["recv"], s["sent"])
                    svc, cat = classify("tcp", s["lport"], s["rport"], lports)
                    cat_delta[cat][0] += drecv
                    cat_delta[cat][1] += dsent
                rec = {"proto": "tcp", "laddr": s["laddr"], "lport": s["lport"],
                       "raddr": s["raddr"], "rport": s["rport"], "recv": s["recv"] or 0,
                       "sent": s["sent"] or 0, "down": down, "up": up}
                pid, name = owner(s["inode"])
                flows.append(self._flow(rec, pid, name, TCP_STATES.get(s["state"], ""), lports))
            self.tcp_prev = new_prev
            for s in udp:
                if s["rport"]:  # connected UDP socket: no byte counters without root
                    rec = {"proto": "udp", "laddr": s["laddr"], "lport": s["lport"],
                           "raddr": s["raddr"], "rport": s["rport"], "recv": 0, "sent": 0,
                           "down": None, "up": None}
                    pid, name = owner(s["inode"])
                    flows.append(self._flow(rec, pid, name, "", lports))
        self.flows = flows

        for cat in list(self.cat_rate):
            self.cat_rate[cat] = [0.0, 0.0]
        for cat, (bi, bo) in cat_delta.items():
            self.cat_tot[cat][0] += bi
            self.cat_tot[cat][1] += bo
            if dt:
                self.cat_rate[cat] = [bi / dt, bo / dt]

    def _flow(self, rec, pid, name, state, lports):
        svc, cat = classify(rec["proto"], rec["lport"], rec["rport"], lports)
        return {"proto": rec["proto"], "laddr": rec["laddr"], "lport": rec["lport"],
                "raddr": rec["raddr"], "rport": rec["rport"], "down": rec["down"],
                "up": rec["up"], "recv": rec["recv"], "sent": rec["sent"],
                "pid": pid, "proc": name, "state": state, "svc": svc, "cat": cat,
                "loop": is_loopback(rec["raddr"]) or is_loopback(rec["laddr"])}

    @staticmethod
    def _merge_listening(items, lports):
        merged = {}
        for proto, s, (pid, name) in items:
            addr = s["laddr"]
            if addr in ("0.0.0.0", "::"):
                scope = "all"
            elif is_loopback(addr):
                scope = "local"
            elif addr.startswith("100.") or addr.startswith("fd7a:115c"):
                scope = "tailnet"
            else:
                scope = "lan"
            key = (proto, s["lport"], pid, scope)
            if key in merged:
                continue
            svc, _ = classify(proto, s["lport"], 0, set())
            merged[key] = {"proto": proto, "port": s["lport"], "addr": addr, "scope": scope,
                           "pid": pid, "proc": name, "svc": "" if svc == "—" else svc}
        rank = {"all": 0, "lan": 1, "tailnet": 2, "local": 3}
        return sorted(merged.values(), key=lambda r: (rank[r["scope"]], r["port"], r["proto"]))


# --------------------------------------------------------------------------
# Drawing
# --------------------------------------------------------------------------

LEFT_BITS = [0x01, 0x02, 0x04, 0x40]   # braille dots, top to bottom, left column
RIGHT_BITS = [0x08, 0x10, 0x20, 0x80]  # right column
FILL_UP_L = [sum(LEFT_BITS[4 - k:]) for k in range(5)]
FILL_UP_R = [sum(RIGHT_BITS[4 - k:]) for k in range(5)]
FILL_DN_L = [sum(LEFT_BITS[:k]) for k in range(5)]
FILL_DN_R = [sum(RIGHT_BITS[:k]) for k in range(5)]
SPARK = " ▁▂▃▄▅▆▇█"

C_BORDER, C_TITLE, C_TEXT, C_DIM, C_DOWN, C_UP, C_WARN, C_BAD, C_HEAD, C_SEL, C_ACCENT, C_GOOD = range(1, 13)
G_DOWN = 20
G_UP = 40
G_STEPS = 10
C_CAT = 60

CAT_COLORS = {"Web": 75, "Streaming": 213, "Calls": 141, "Gaming": 203, "P2P": 208,
              "Sync": 114, "Files": 180, "Remote": 221, "VPN": 81, "DNS": 150, "Mail": 223,
              "Chat": 177, "Dev": 110, "Database": 137, "Local net": 109, "System": 246,
              "Other": 244}


class UI:
    def __init__(self, scr, col, args):
        self.scr = scr
        self.col = col
        self.bits = not args.bytes
        self.interval = args.interval
        self.view = "process"
        self.sort = "speed"
        self.names = not args.no_dns
        self.show_loop = False
        self.paused = False
        self.scroll = 0
        self.sel = 0  # selected interface index (0 = all)
        self.order = []
        self.start = time.time()
        if args.iface:
            self.want_iface = args.iface
        else:
            self.want_iface = None
        self.colors = False
        self.restart_as_root = False
        self._init_colors()

    # ---- colours
    def _init_colors(self):
        if not curses.has_colors():
            return
        curses.start_color()
        try:
            curses.use_default_colors()
            bg = -1
        except curses.error:
            bg = curses.COLOR_BLACK
        self.colors = True
        rich = curses.COLORS >= 256
        base = {
            C_BORDER: (240 if rich else curses.COLOR_BLUE),
            C_TITLE: (120 if rich else curses.COLOR_GREEN),
            C_TEXT: (252 if rich else curses.COLOR_WHITE),
            C_DIM: (243 if rich else curses.COLOR_WHITE),
            C_DOWN: (114 if rich else curses.COLOR_GREEN),
            C_UP: (211 if rich else curses.COLOR_MAGENTA),
            C_WARN: (221 if rich else curses.COLOR_YELLOW),
            C_BAD: (203 if rich else curses.COLOR_RED),
            C_ACCENT: (75 if rich else curses.COLOR_BLUE),
            C_GOOD: (120 if rich else curses.COLOR_GREEN),
        }
        for pair, fg in base.items():
            curses.init_pair(pair, fg, bg)
        curses.init_pair(C_HEAD, 16 if rich else curses.COLOR_BLACK, 114 if rich else curses.COLOR_GREEN)
        curses.init_pair(C_SEL, 255 if rich else curses.COLOR_WHITE, 237 if rich else curses.COLOR_BLUE)
        down = [22, 28, 34, 35, 41, 77, 113, 149, 185, 221] if rich else [curses.COLOR_GREEN] * 10
        up = [53, 89, 90, 126, 162, 168, 204, 210, 211, 217] if rich else [curses.COLOR_MAGENTA] * 10
        for i in range(G_STEPS):
            curses.init_pair(G_DOWN + i, down[i], bg)
            curses.init_pair(G_UP + i, up[i], bg)
        for i, cat in enumerate(CATEGORY_ORDER):
            curses.init_pair(C_CAT + i, CAT_COLORS[cat] if rich else curses.COLOR_CYAN, bg)

    def cp(self, n, extra=0):
        return (curses.color_pair(n) if self.colors else 0) | extra

    # ---- primitives
    def put(self, y, x, s, attr=0, maxw=None):
        h, w = self.scr.getmaxyx()
        if y < 0 or y >= h or x >= w:
            return
        lim = w - x if maxw is None else min(maxw, w - x)
        if lim <= 0:
            return
        try:
            self.scr.addstr(y, x, s[:lim], attr)
        except curses.error:
            pass

    def box(self, y, x, h, w, title, right=""):
        if h < 2 or w < 4:
            return
        b = self.cp(C_BORDER)
        self.put(y, x, "╭" + "─" * (w - 2) + "╮", b)
        for r in range(1, h - 1):
            self.put(y + r, x, "│", b)
            self.put(y + r, x + w - 1, "│", b)
        self.put(y + h - 1, x, "╰" + "─" * (w - 2) + "╯", b)
        if title:
            t = trunc(title, w - 6)
            self.put(y, x + 2, "┤", b)
            self.put(y, x + 3, t, self.cp(C_TITLE, curses.A_BOLD))
            self.put(y, x + 3 + len(t), "├", b)
        if right:
            r = trunc(right, max(0, w - len(title) - 12))
            if r:
                self.put(y, x + w - 3 - len(r), "┤", b)
                self.put(y, x + w - 2 - len(r), r, self.cp(C_DIM))
                self.put(y, x + w - 2, "├", b)

    def graph(self, y, x, h, w, samples, vmax, upward, gbase):
        """Braille graph: 2 samples per cell, 4 dots high per row."""
        if h <= 0 or w <= 0:
            return
        need = w * 2
        data = list(samples)[-need:]
        if len(data) < need:
            data = [0.0] * (need - len(data)) + data
        dots = h * 4
        fl, fr = (FILL_UP_L, FILL_UP_R) if upward else (FILL_DN_L, FILL_DN_R)
        for c in range(w):
            a, bv = data[2 * c], data[2 * c + 1]
            da = min(dots, int(round(a / vmax * dots))) if vmax else 0
            db = min(dots, int(round(bv / vmax * dots))) if vmax else 0
            if a > 0 and da == 0:
                da = 1
            if bv > 0 and db == 0:
                db = 1
            for r in range(h):
                ka = min(4, max(0, da - r * 4))
                kb = min(4, max(0, db - r * 4))
                if not ka and not kb:
                    break
                ch = chr(0x2800 | fl[ka] | fr[kb])
                yy = y + h - 1 - r if upward else y + r
                step = min(G_STEPS - 1, r * G_STEPS // h)
                self.put(yy, x + c, ch, self.cp(gbase + step))

    def spark(self, y, x, w, samples, vmax, color):
        data = list(samples)[-w:]
        s = "".join(SPARK[min(8, int(round(v / vmax * 8))) if vmax else 0] for v in data)
        self.put(y, x, s, self.cp(color))

    def rate_attr(self, v, color):
        if v is None or v <= 0:
            return self.cp(C_DIM)
        if v >= 1_000_000:
            return self.cp(color, curses.A_BOLD)
        return self.cp(color)

    def rate_str(self, v):
        if v is None:
            return "n/a"
        if v <= 0:
            return "·"
        return fmt_rate(v, self.bits)

    # ---- screen
    def draw(self, c):
        self.scr.erase()
        H, W = self.scr.getmaxyx()
        if H < 20 or W < 70:
            self.put(0, 0, f"{APP} needs a terminal of at least 70x20.", self.cp(C_WARN))
            self.put(1, 0, f"Current size: {W}x{H}. Press q to quit.", self.cp(C_DIM))
            self.scr.refresh()
            return
        self.order = [c.all] + sorted(
            c.ifaces.values(),
            key=lambda i: ({"Wi-Fi": 0, "Ethernet": 1, "VPN": 2}.get(i.kind, 3), i.name))
        if self.want_iface:
            for n, it in enumerate(self.order):
                if it.name == self.want_iface:
                    self.sel = n
            self.want_iface = None
        self.sel = min(self.sel, len(self.order) - 1)

        self.draw_header(c, W)
        top_h = max(11, int((H - 1) * 0.44))
        side_w = min(50, max(36, W // 3))
        self.draw_graph_box(c, 1, 0, top_h, W - side_w)
        self.draw_ifaces(c, 1, W - side_w, top_h, side_w)
        bot_y = 1 + top_h
        bot_h = H - bot_y
        right_w = min(52, max(40, int(W * 0.36)))
        self.draw_flows(c, bot_y, 0, bot_h, W - right_w)
        cat_h = max(6, min(len(CATEGORY_ORDER) + 2, bot_h // 2))
        self.draw_categories(c, bot_y, W - right_w, cat_h, right_w)
        self.draw_listening(c, bot_y + cat_h, W - right_w, bot_h - cat_h, right_w)
        self.scr.refresh()

    def draw_header(self, c, W):
        self.put(0, 0, " " * W, self.cp(C_HEAD))
        up = int(time.time() - self.start)
        mode = "capturing all traffic" if c.capturing else "TCP only, R for sudo"
        left = f" {APP}  {socket.gethostname()}  {time.strftime('%H:%M:%S')}  up {up // 3600:d}:{up // 60 % 60:02d}:{up % 60:02d}  {mode}"
        if self.paused:
            left += "  [PAUSED]"
        self.put(0, 0, left, self.cp(C_HEAD, curses.A_BOLD))
        for keys in (f"tab iface  v view  s sort  b bits/bytes  n names  l loopback  p pause  +/- {self.interval:g}s  q quit ",
                     f"tab iface  v view  s sort  b units  n names  l lo  p pause  +/- {self.interval:g}s  q quit ",
                     "tab iface  v view  s sort  q quit "):
            if len(left) + len(keys) + 2 <= W:
                self.put(0, W - len(keys), keys, self.cp(C_HEAD))
                break

    def draw_graph_box(self, c, y, x, h, w):
        it = self.order[self.sel]
        label = "All physical (Wi-Fi + Ethernet)" if it.name == "all" else f"{it.name} · {it.kind}"
        self.box(y, x, h, w, f"Speed · {label}", "tab: switch interface")
        gx, gw = x + 1, w - 2
        gy, gh = y + 1, h - 2
        half_dn = gh // 2
        half_up = gh - half_dn
        cols = gw * 2
        vis_rx = list(it.hist_rx)[-cols:]
        vis_tx = list(it.hist_tx)[-cols:]
        mx_rx = nice_max(max(vis_rx) if vis_rx else 0)
        mx_tx = nice_max(max(vis_tx) if vis_tx else 0)
        self.graph(gy, gx, half_dn, gw, vis_rx, mx_rx, True, G_DOWN)
        self.graph(gy + half_dn, gx, half_up, gw, vis_tx, mx_tx, False, G_UP)
        # mid line marks
        self.put(gy + half_dn - 1, gx + gw - 1, "", 0)
        # labels on top of the graph
        dl = f" ▼ Download {fmt_rate(it.rx, self.bits):>10}  peak {fmt_rate(it.rx_peak, self.bits)}  total {fmt_bytes(it.rx_tot)} "
        ul = f" ▲ Upload   {fmt_rate(it.tx, self.bits):>10}  peak {fmt_rate(it.tx_peak, self.bits)}  total {fmt_bytes(it.tx_tot)} "
        self.put(gy, gx, dl, self.cp(C_DOWN, curses.A_BOLD))
        self.put(gy + gh - 1, gx, ul, self.cp(C_UP, curses.A_BOLD))
        sd = f" scale {fmt_rate(mx_rx, self.bits)} "
        su = f" scale {fmt_rate(mx_tx, self.bits)} "
        self.put(gy, gx + gw - len(sd), sd, self.cp(C_DIM))
        self.put(gy + gh - 1, gx + gw - len(su), su, self.cp(C_DIM))
        span = cols * self.interval
        sp = f" {span / 60:.0f} min shown " if span >= 120 else f" {span:.0f} s shown "
        self.put(gy + half_dn, gx + gw - len(sp), sp, self.cp(C_DIM))

    def draw_ifaces(self, c, y, x, h, w):
        self.box(y, x, h, w, "Interfaces")
        row = y + 1
        iw_ = w - 2
        for n, it in enumerate(self.order):
            if row + 2 > y + h - 1:
                break
            sel = n == self.sel
            mark = "▶" if sel else " "
            name_attr = self.cp(C_TITLE, curses.A_BOLD) if sel else self.cp(C_TEXT, curses.A_BOLD)
            if it.name == "all":
                self.put(row, x + 1, f"{mark} all", name_attr)
                self.put(row, x + 8, "Wi-Fi + Ethernet", self.cp(C_DIM))
            else:
                state_attr = self.cp(C_GOOD) if it.up else self.cp(C_BAD)
                self.put(row, x + 1, f"{mark} {it.name}", name_attr)
                nx = x + 3 + len(it.name) + 1
                self.put(row, nx, it.kind, self.cp(C_ACCENT))
                nx += len(it.kind) + 1
                self.put(row, nx, "●" if it.up else "○", state_attr)
                nx += 2
                extra = ""
                if it.kind == "Wi-Fi":
                    wi = c.slow.wifi.get(it.name, {})
                    if wi.get("ssid"):
                        extra = wi["ssid"]
                        if "signal" in wi:
                            q = min(100, max(0, 2 * (wi["signal"] + 100)))
                            extra += f" {wi['signal']}dBm {q}%"
                        if "rx_bitrate" in wi:
                            extra += f" link {wi['rx_bitrate']:.0f}/{wi.get('tx_bitrate', 0):.0f}Mb"
                    elif it.up:
                        extra = "not associated"
                    else:
                        extra = "down"
                elif it.kind == "Ethernet":
                    extra = f"{it.speed} Mb/s link" if (it.up and it.speed) else ("cable unplugged" if not it.up else "")
                self.put(row, nx, trunc(extra, x + w - 1 - nx), self.cp(C_DIM))
            row += 1
            rx_s = f"▼{fmt_rate(it.rx, self.bits):>10}"
            tx_s = f"▲{fmt_rate(it.tx, self.bits):>10}"
            self.put(row, x + 3, rx_s, self.rate_attr(it.rx, C_DOWN))
            self.put(row, x + 3 + len(rx_s) + 1, tx_s, self.rate_attr(it.tx, C_UP))
            sx = x + 3 + len(rx_s) + len(tx_s) + 3
            sw = x + w - 2 - sx
            if sw > 3:
                mx = nice_max(max(list(it.hist_rx)[-sw:] + list(it.hist_tx)[-sw:]))
                self.spark(row, sx, sw, it.hist_rx, mx, C_DOWN)
            row += 1
            if it.name != "all":
                ips = c.slow.addrs.get(it.name, [])
                info = ", ".join(ips[:2]) if ips else "no address"
                tot = f"  ↓{fmt_bytes(it.rx_tot)} ↑{fmt_bytes(it.tx_tot)}"
                self.put(row, x + 3, trunc(info, iw_ - 3 - len(tot)), self.cp(C_DIM))
                self.put(row, x + w - 1 - len(tot), tot, self.cp(C_DIM))
                row += 1
            else:
                tot = f"session  ↓{fmt_bytes(it.rx_tot)}  ↑{fmt_bytes(it.tx_tot)}"
                self.put(row, x + 3, tot, self.cp(C_DIM))
                row += 1
            row += 0

    def visible_flows(self, c):
        flows = [f for f in c.flows if self.show_loop or not f["loop"]]
        return flows

    def draw_flows(self, c, y, x, h, w):
        flows = self.visible_flows(c)
        active = sum(1 for f in flows if (f["down"] or 0) >= 50_000 or (f["up"] or 0) >= 50_000)
        if self.view == "process":
            rows = self.group_by_process(flows)
            title = f"Apps using the network ({len(rows)})"
        else:
            rows = flows
            title = f"Connections ({len(rows)})"
        title += f" · {active} active transfer{'s' if active != 1 else ''}"
        right = f"v: {'connections' if self.view == 'process' else 'apps'} · sort: {self.sort}"
        self.box(y, x, h, w, title, right)
        key = {
            "speed": lambda r: -((r["down"] or 0) + (r["up"] or 0)),
            "total": lambda r: -(r["recv"] + r["sent"]),
            "name": lambda r: ((r["proc"] or "~").lower(), -((r["down"] or 0) + (r["up"] or 0))),
        }[self.sort]
        if self.sort == "speed":
            rows.sort(key=lambda r: (key(r), -(r["recv"] + r["sent"])))
        else:
            rows.sort(key=key)
        inner = w - 2
        body_h = h - 3
        self.scroll = max(0, min(self.scroll, max(0, len(rows) - body_h)))
        hy = y + 1
        if self.view == "process":
            cols = [("App", 18), ("PID", 7), ("Conns", 6), ("▼ Down", 11), ("▲ Up", 11),
                    ("Received", 10), ("Sent", 10), ("Main traffic", 0)]
        else:
            cols = [("App", 15), ("Proto", 6), ("Port", 6), ("Remote host", 0), ("Type", 11),
                    ("State", 7), ("▼ Down", 11), ("▲ Up", 11)]
            if inner < 100:
                cols = [cl for cl in cols if cl[0] not in ("Port", "State")]
        fixed = sum(cw for _, cw in cols)
        flex = max(8, inner - fixed - 1)
        cols = [(n, cw if cw else flex) for n, cw in cols]
        cx = x + 1
        for n, cw in cols:
            al = n.startswith(("▼", "▲", "Received", "Sent", "Conns", "PID"))
            self.put(hy, cx, (n.rjust(cw - 1) if al else n.ljust(cw)), self.cp(C_DIM, curses.A_BOLD), cw)
            cx += cw
        if not rows:
            msg = "No connections yet." if c.flows else "Waiting for data…"
            self.put(hy + 1, x + 2, msg, self.cp(C_DIM))
        for i, r in enumerate(rows[self.scroll:self.scroll + body_h]):
            ry = hy + 1 + i
            cx = x + 1
            for n, cw in cols:
                txt, attr = self.cell(n, r, cw)
                right = n.startswith(("▼", "▲", "Received", "Sent", "Conns", "PID"))
                s = txt.rjust(cw - 1) if right else trunc(txt, cw - 1).ljust(cw)
                self.put(ry, cx, s, attr, cw)
                cx += cw
        if len(rows) > body_h:
            more = f" {self.scroll + 1}-{min(len(rows), self.scroll + body_h)} of {len(rows)} ↑↓ "
            self.put(y + h - 1, x + w - 2 - len(more), more, self.cp(C_DIM))
        if not c.capturing:
            if not c.diag_ok:
                note = " per-app speeds off: tcp_diag can't load (reboot?) · R: sudo "
            elif c.capture_error:
                note = f" {c.capture_error} "
            else:
                note = " UDP/QUIC speeds need sudo: press R "
            self.put(y + h - 1, x + 2, note, self.cp(C_WARN))

    def cell(self, n, r, cw):
        proc = r["proc"] or ("(system)" if r.get("pid") is None else "?")
        if n == "App":
            return proc, self.cp(C_TEXT, curses.A_BOLD) if r["proc"] else self.cp(C_DIM)
        if n == "PID":
            return str(r["pid"] or ""), self.cp(C_DIM)
        if n == "Conns":
            return str(r["conns"]), self.cp(C_TEXT)
        if n == "Proto":
            return r["proto"].upper(), self.cp(C_ACCENT)
        if n == "Port":
            return str(r["lport"]), self.cp(C_DIM)
        if n == "Remote host":
            host = self.host(r["raddr"])
            if ":" in host:
                host = f"[{host}]"
            return trunc_left(f"{host}:{r['rport']}" if r["rport"] else host, cw - 1), self.cp(C_TEXT)
        if n == "Type":
            return r["svc"], self.cp(C_CAT + CATEGORY_ORDER.index(r["cat"]))
        if n == "State":
            return r["state"], self.cp(C_GOOD if r["state"] == "ESTAB" else C_DIM)
        if n == "▼ Down":
            return self.rate_str(r["down"]), self.rate_attr(r["down"], C_DOWN)
        if n == "▲ Up":
            return self.rate_str(r["up"]), self.rate_attr(r["up"], C_UP)
        if n == "Received":
            return fmt_bytes(r["recv"]) if r["recv"] else "·", self.cp(C_DIM)
        if n == "Sent":
            return fmt_bytes(r["sent"]) if r["sent"] else "·", self.cp(C_DIM)
        if n == "Main traffic":
            return r["main"], self.cp(C_CAT + CATEGORY_ORDER.index(r["cat"]))
        return "", 0

    def host(self, ip):
        return c_resolver.name(ip) if self.names else ip

    def group_by_process(self, flows):
        g = {}
        for f in flows:
            key = (f["pid"], f["proc"]) if f["proc"] else (None, None)
            r = g.get(key)
            if r is None:
                r = g[key] = {"pid": f["pid"], "proc": f["proc"], "conns": 0, "down": 0.0,
                              "up": 0.0, "recv": 0, "sent": 0, "_svc": defaultdict(float),
                              "_hosts": defaultdict(float), "na": True}
            r["conns"] += 1
            if f["down"] is not None:
                r["na"] = False
                r["down"] += f["down"]
                r["up"] += f["up"]
            r["recv"] += f["recv"]
            r["sent"] += f["sent"]
            weight = (f["down"] or 0) + (f["up"] or 0) + (f["recv"] + f["sent"]) * 1e-6 + 1e-9
            r["_svc"][(f["svc"], f["cat"])] += weight
            r["_hosts"][f["raddr"]] += weight
        out = []
        for r in g.values():
            (svc, cat) = max(r["_svc"].items(), key=lambda kv: kv[1])[0]
            top_ip = max(r["_hosts"].items(), key=lambda kv: kv[1])[0]
            r["cat"] = cat
            r["main"] = f"{svc} → {self.host(top_ip)}"
            if r["na"]:
                r["down"] = r["up"] = None
            out.append(r)
        return out

    def draw_categories(self, c, y, x, h, w):
        self.box(y, x, h, w, "Traffic by type", "session")
        cats = [cat for cat in CATEGORY_ORDER if sum(c.cat_tot[cat]) > 0]
        cats.sort(key=lambda k: -(sum(c.cat_rate[k]) * 1e6 + sum(c.cat_tot[k])))
        total = sum(sum(c.cat_tot[k]) for k in cats) or 1
        if not cats:
            if not c.capturing and not c.diag_ok:
                self.put(y + 1, x + 2, "Needs per-app speeds:", self.cp(C_DIM))
                self.put(y + 2, x + 2, "reboot, or press R for sudo.", self.cp(C_DIM))
            else:
                self.put(y + 1, x + 2, "Measuring…", self.cp(C_DIM))
            return
        bar_w = max(4, w - 2 - 10 - 11 - 9 - 3)
        for i, cat in enumerate(cats[: h - 2]):
            ry = y + 1 + i
            share = sum(c.cat_tot[cat]) / total
            fill = share * bar_w
            full = int(fill)
            part = " ▏▎▍▌▋▊▉"[int((fill - full) * 8)]
            bar = ("█" * full + (part if full < bar_w else "")).ljust(bar_w)
            ci = C_CAT + CATEGORY_ORDER.index(cat)
            self.put(ry, x + 2, cat[:9].ljust(10), self.cp(ci, curses.A_BOLD))
            self.put(ry, x + 12, bar, self.cp(ci))
            rate = sum(c.cat_rate[cat])
            self.put(ry, x + 13 + bar_w, f"{self.rate_str(rate):>10}", self.rate_attr(rate, C_DOWN))
            self.put(ry, x + 24 + bar_w, f"{fmt_bytes(sum(c.cat_tot[cat])):>8}", self.cp(C_DIM))

    def draw_listening(self, c, y, x, h, w):
        rows = c.listening
        public = sum(1 for r in rows if r["scope"] in ("all", "lan"))
        self.box(y, x, h, w, f"Open ports ({len(rows)})", f"{public} reachable from network")
        if h < 4:
            return
        self.put(y + 1, x + 2, "Proto Port   Open to  Service     App", self.cp(C_DIM, curses.A_BOLD))
        for i, r in enumerate(rows[: h - 3]):
            ry = y + 2 + i
            scope_col = {"all": C_WARN, "lan": C_WARN, "tailnet": C_ACCENT, "local": C_DIM}[r["scope"]]
            scope_txt = {"all": "network", "lan": "LAN", "tailnet": "tailnet", "local": "this PC"}[r["scope"]]
            self.put(ry, x + 2, r["proto"].upper().ljust(6), self.cp(C_ACCENT))
            self.put(ry, x + 8, str(r["port"]).ljust(7), self.cp(C_TEXT, curses.A_BOLD))
            self.put(ry, x + 15, scope_txt.ljust(9), self.cp(scope_col))
            self.put(ry, x + 24, trunc(r["svc"], 11).ljust(12), self.cp(C_TEXT))
            app = r["proc"] or "(system)"
            self.put(ry, x + 36, trunc(app, w - 38), self.cp(C_TEXT) if r["proc"] else self.cp(C_DIM))
        if len(rows) > h - 3:
            self.put(y + h - 1, x + 2, f" +{len(rows) - (h - 3)} more ", self.cp(C_DIM))

    # ---- input
    def key(self, k):
        if k in (ord("q"), ord("Q"), 27):
            return False
        if k == ord("R") and os.geteuid() != 0:
            self.restart_as_root = True
            return False
        n = len(self.order) or 1
        if k in (9, curses.KEY_RIGHT):
            self.sel = (self.sel + 1) % n
        elif k in (curses.KEY_BTAB, curses.KEY_LEFT):
            self.sel = (self.sel - 1) % n
        elif k == ord("v"):
            self.view = "connections" if self.view == "process" else "process"
            self.scroll = 0
        elif k == ord("s"):
            self.sort = {"speed": "total", "total": "name", "name": "speed"}[self.sort]
        elif k == ord("b"):
            self.bits = not self.bits
        elif k == ord("n"):
            self.names = not self.names
        elif k == ord("l"):
            self.show_loop = not self.show_loop
        elif k == ord("p"):
            self.paused = not self.paused
        elif k in (ord("+"), ord("=")):
            self.interval = min(5.0, self.interval + 0.5)
        elif k in (ord("-"), ord("_")):
            self.interval = max(0.5, self.interval - 0.5)
        elif k == curses.KEY_DOWN:
            self.scroll += 1
        elif k == curses.KEY_UP:
            self.scroll = max(0, self.scroll - 1)
        elif k == curses.KEY_NPAGE:
            self.scroll += 10
        elif k == curses.KEY_PPAGE:
            self.scroll = max(0, self.scroll - 10)
        elif k == curses.KEY_HOME:
            self.scroll = 0
        return True


c_resolver = None


def run_tui(scr, args):
    global c_resolver
    curses.curs_set(0)
    scr.keypad(True)
    scr.timeout(100)
    c_resolver = Resolver()
    col = Collector(capture=os.geteuid() == 0 and not args.no_capture, resolver=c_resolver)
    ui = UI(scr, col, args)
    col.update()
    next_t = time.monotonic() + ui.interval
    ui.draw(col)
    last_draw = time.monotonic()
    while True:
        k = scr.getch()
        if k != -1:
            if not ui.key(k):
                return ui.restart_as_root
            ui.draw(col)
            last_draw = time.monotonic()
        now = time.monotonic()
        if now >= next_t:
            if not ui.paused:
                col.update()
            next_t = now + ui.interval
            ui.draw(col)
            last_draw = now
        elif now - last_draw > 1.0:  # pick up resolved names while paused
            ui.draw(col)
            last_draw = now


def snapshot(args):
    """Plain-text report, for scripts and testing."""
    res = Resolver()
    col = Collector(capture=os.geteuid() == 0 and not args.no_capture, resolver=res)
    col.update()
    steps = max(1, int(args.snapshot / args.interval))
    for _ in range(steps):
        time.sleep(args.interval)
        col.update()
    bits = not args.bytes
    if not col.diag_ok and not col.capturing:
        print("note: tcp_diag kernel module unavailable, so per-connection speeds are off")
    print(f"mode: {'capture (all traffic)' if col.capturing else 'TCP only'}"
          f"{' - ' + col.capture_error if col.capture_error else ''}")
    print("\nINTERFACES")
    for it in [col.all] + list(col.ifaces.values()):
        extra = ""
        if it.kind == "Wi-Fi":
            extra = str(col.slow.wifi.get(it.name, {}))
        print(f"  {it.name:12} {it.kind:9} down {fmt_rate(it.rx, bits):>11}  up {fmt_rate(it.tx, bits):>11}"
              f"  total down {fmt_bytes(it.rx_tot):>9} up {fmt_bytes(it.tx_tot):>9}  {extra}")
    print("\nCONNECTIONS (busiest first)")
    flows = sorted([f for f in col.flows if not f["loop"]],
                   key=lambda f: -((f["down"] or 0) + (f["up"] or 0)))
    for f in flows[:25]:
        d = "n/a" if f["down"] is None else fmt_rate(f["down"], bits)
        u = "n/a" if f["up"] is None else fmt_rate(f["up"], bits)
        print(f"  {(f['proc'] or '?'):15} {f['proto']:4} {res.name(f['raddr'])[:40]:40}:{f['rport']:<5}"
              f" {f['svc']:10} {f['state']:6} down {d:>11} up {u:>11}")
    print("\nTRAFFIC BY TYPE")
    for cat in CATEGORY_ORDER:
        if sum(col.cat_tot[cat]):
            print(f"  {cat:10} {fmt_bytes(sum(col.cat_tot[cat])):>9}")
    print("\nOPEN PORTS")
    for r in col.listening:
        print(f"  {r['proto']:3} {r['port']:<6} {r['scope']:8} {r['svc']:12} {r['proc'] or '(system)'}")


def self_command():
    """How to start this app again: the launcher script when there is one."""
    launcher = os.environ.get("SNAKES_NET_LAUNCHER")
    if launcher and os.path.isfile(launcher):
        return [launcher]
    pkg_parent = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return ["env", f"PYTHONPATH={pkg_parent}", sys.executable, "-m", "snakes_net"]


def restart_with_sudo(argv):
    print("Restarting Snake's Net with sudo, to capture all traffic (UDP/QUIC and every app)...")
    try:
        os.execvp("sudo", ["sudo", "--", *self_command(), *argv])
    except OSError as e:
        sys.exit(f"Could not run sudo: {e}")


# Terminal apps and how each one runs a command.
TERMINALS = [
    ("konsole", ["--separate", "-e"]), ("kgx", ["--"]), ("gnome-terminal", ["--"]),
    ("ptyxis", ["--"]), ("kitty", []), ("alacritty", ["-e"]), ("foot", []),
    ("wezterm", ["start", "--"]), ("ghostty", ["-e"]), ("xfce4-terminal", ["-x"]),
    ("mate-terminal", ["-x"]), ("tilix", ["-e"]), ("terminator", ["-x"]),
    ("lxterminal", ["-e"]), ("x-terminal-emulator", ["-e"]), ("xterm", ["-e"]),
]


def open_in_terminal(argv):
    import shutil
    if os.environ.get("SNAKES_NET_SPAWNED"):
        sys.exit("Snake's Net needs a terminal.")
    cmd = self_command() + list(argv)
    env = dict(os.environ, SNAKES_NET_SPAWNED="1")
    wanted = os.environ.get("TERMINAL")
    choices = ([(wanted, dict(TERMINALS).get(os.path.basename(wanted), ["-e"]))] if wanted else []) + TERMINALS
    for name, flags in choices:
        exe = shutil.which(name)
        if exe:
            subprocess.Popen([exe, *flags, *cmd], env=env, start_new_session=True,
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return
    msg = "Snake's Net runs in a terminal, and no terminal app was found. Install Konsole or GNOME Terminal."
    if shutil.which("notify-send"):
        subprocess.run(["notify-send", "-i", "network-wired", "Snake's Net", msg])
    sys.exit(msg)


def main():
    ap = argparse.ArgumentParser(prog="snakes-net", description=f"{APP}: a btop-style live network monitor")
    ap.add_argument("-i", "--interval", type=float, default=1.0, help="seconds between updates (default 1)")
    ap.add_argument("--bytes", action="store_true", help="show speeds in bytes/s instead of bits/s")
    ap.add_argument("--no-dns", action="store_true", help="don't look up host names")
    ap.add_argument("--no-capture", action="store_true", help="don't capture packets even as root")
    ap.add_argument("--iface", help="interface to graph at start (e.g. wlan0)")
    ap.add_argument("--snapshot", type=float, metavar="SECS",
                    help="measure for SECS seconds, print a text report and exit")
    ap.add_argument("--version", action="version", version=f"{APP} {VERSION}")
    args = ap.parse_args()
    args.interval = min(5.0, max(0.25, args.interval))
    if args.snapshot:
        snapshot(args)
        return
    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        # Started from the menu or the hub: open a terminal window to run in.
        open_in_terminal(sys.argv[1:])
        return
    locale.setlocale(locale.LC_ALL, "")
    os.environ.setdefault("ESCDELAY", "25")
    sys.stdout.write("\033]0;Snake's Net\007")  # window title
    sys.stdout.flush()
    restart = False
    try:
        restart = curses.wrapper(run_tui, args)
    except KeyboardInterrupt:
        pass
    if restart:
        restart_with_sudo(sys.argv[1:])


if __name__ == "__main__":
    main()
