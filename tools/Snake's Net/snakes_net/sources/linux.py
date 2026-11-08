"""Linux: /proc and /sys, per-socket TCP byte counts over netlink, packet capture as root."""

import json
import os
import socket
import struct
import subprocess
import threading

from .common import norm_addr

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
            out[name.strip()] = (int(v[0]), int(v[8]))
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


class Source:
    os_name = "Linux"
    can_capture = True
    counts_udp = False  # per-socket UDP bytes only by capturing

    def __init__(self):
        self.counts_tcp = True  # netlink tcp_diag works
        self._kinds = {}

    def elevated(self):
        return os.geteuid() == 0

    def sniffer(self):
        return Sniffer()

    def counters(self):
        return {n: v for n, v in read_net_dev().items() if n != "lo"}

    def iface_state(self, name):
        kind = self._kinds.get(name) or self._kinds.setdefault(name, iface_kind(name))
        up = read_file(f"/sys/class/net/{name}/operstate") in ("up", "unknown")
        speed = None
        if kind == "Ethernet":
            sp = read_file(f"/sys/class/net/{name}/speed", "-1")
            speed = int(sp) if sp.lstrip("-").isdigit() and int(sp) > 0 else None
        return kind, up, speed

    def slow(self):
        addrs = {}
        try:
            r = subprocess.run(["ip", "-j", "addr"], capture_output=True, text=True, timeout=3)
            for d in json.loads(r.stdout or "[]"):
                addrs[d["ifname"]] = [a["local"] for a in d.get("addr_info", [])
                                      if a.get("scope") == "global" and "local" in a]
        except Exception:
            pass
        wifi = {}
        for name in os.listdir("/sys/class/net"):
            if iface_kind(name) != "Wi-Fi":
                continue
            info = {}
            try:
                r = subprocess.run(["iw", "dev", name, "link"], capture_output=True, text=True, timeout=3)
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
        return wifi, addrs

    def sockets(self):
        owners = inode_owners()
        try:
            tcp = tcp_sockets()
            self.counts_tcp = True
        except OSError:
            tcp = proc_net_sockets("tcp")
            self.counts_tcp = False
        udp = proc_net_sockets("udp")
        out_tcp, out_udp = [], []
        for s in tcp + udp:  # "no remote end" is an empty address, as on the other systems
            if not s["rport"] and s["raddr"] in ("0.0.0.0", "::"):
                s["raddr"] = ""
        for s in tcp:
            pid, name = owners.get(s["inode"], (None, None)) if s["inode"] else (None, None)
            out_tcp.append({"proto": "tcp", "state": TCP_STATES.get(s["state"], ""), "laddr": s["laddr"],
                            "lport": s["lport"], "raddr": s["raddr"], "rport": s["rport"], "pid": pid,
                            "proc": name, "key": s["cookie"], "recv": s["recv"], "sent": s["sent"]})
        for s in udp:
            pid, name = owners.get(s["inode"], (None, None)) if s["inode"] else (None, None)
            out_udp.append({"proto": "udp", "state": "", "laddr": s["laddr"], "lport": s["lport"],
                            "raddr": s["raddr"], "rport": s["rport"], "pid": pid, "proc": name,
                            "key": None, "recv": None, "sent": None})
        return out_tcp, out_udp

    # Text for the screen
    def mode(self, capturing):
        return "capturing all traffic" if capturing else "TCP only, R for sudo"

    def note(self, capture_error):
        if not self.counts_tcp:
            return "per-app speeds off: tcp_diag can't load (reboot?) · R: sudo"
        if capture_error:
            return capture_error
        return "UDP/QUIC speeds need sudo: press R"

    def no_types_hint(self):
        if not self.counts_tcp:
            return ["Needs per-app speeds:", "reboot, or press R for sudo."]
        return None
