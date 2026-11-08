"""The web view: the same live numbers as a page your phone or another computer can open.

By default it only listens on this computer's Tailscale address (and localhost), and only
answers devices on your tailnet. `--serve-on lan` also opens it to the local network.
It never changes anything: the page only reads.
"""

import ipaddress
import json
import os
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 7878
HIST_SENT = 300  # graph samples sent per interface

TAILNET = [ipaddress.ip_network("100.64.0.0/10"), ipaddress.ip_network("fd7a:115c:a1e0::/48")]
LOCAL = [ipaddress.ip_network("127.0.0.0/8"), ipaddress.ip_network("::1/128")]
LAN = [ipaddress.ip_network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
                                         "169.254.0.0/16", "fe80::/10", "fc00::/7")]


def _ip(text):
    try:
        ip = ipaddress.ip_address(text.split("%")[0])
    except ValueError:
        return None
    if ip.version == 6 and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip


def in_nets(text, nets):
    ip = _ip(text)
    return ip is not None and any(ip in n for n in nets if n.version == ip.version)


def tailnet_addresses(addrs_by_iface):
    return sorted({a for ips in addrs_by_iface.values() for a in ips if in_nets(a, TAILNET) and ":" not in a})


def export_state(col, host, interval, group_by_process, version):
    """Everything the page shows, as plain JSON-able data."""
    def iface(it):
        d = {"name": it.name, "kind": it.kind, "up": it.up, "rx": round(it.rx), "tx": round(it.tx),
             "rx_tot": it.rx_tot, "tx_tot": it.tx_tot, "rx_peak": round(it.rx_peak), "tx_peak": round(it.tx_peak),
             "speed": it.speed, "hist_rx": [round(v) for v in list(it.hist_rx)[-HIST_SENT:]],
             "hist_tx": [round(v) for v in list(it.hist_tx)[-HIST_SENT:]]}
        if it.name != "all":
            d["addrs"] = col.slow.addrs.get(it.name, [])
            if it.kind == "Wi-Fi":
                d["wifi"] = col.slow.wifi.get(it.name, {})
        return d

    order = {"Wi-Fi": 0, "Ethernet": 1, "VPN": 2}
    ifaces = [iface(col.all)] + [iface(i) for i in sorted(col.ifaces.values(),
                                                          key=lambda i: (order.get(i.kind, 3), i.name))]
    flows = [f for f in col.flows if not f["loop"]]
    speed = lambda r: -((r["down"] or 0) + (r["up"] or 0))
    apps = sorted(group_by_process(flows, host), key=lambda r: (speed(r), -(r["recv"] + r["sent"])))[:60]
    conns = sorted(flows, key=lambda r: (speed(r), -(r["recv"] + r["sent"])))[:150]
    types = [{"cat": k, "rate": round(sum(col.cat_rate[k])), "total": sum(col.cat_tot[k])}
             for k in col.cat_tot if sum(col.cat_tot[k]) > 0]
    types.sort(key=lambda t: -(t["rate"] * 1e6 + t["total"]))
    rnd = lambda v: None if v is None else round(v)
    return {
        "app": "Snake's Net", "version": version, "host": socket.gethostname(), "os": col.src.os_name,
        "time": time.time(), "interval": interval, "mode": col.src.mode(col.capturing),
        "per_app": col.per_app, "note": None if col.capturing else col.src.note(col.capture_error),
        "ifaces": ifaces,
        "apps": [{"proc": a["proc"] or "(system)", "pid": a["pid"], "conns": a["conns"], "down": rnd(a["down"]),
                  "up": rnd(a["up"]), "recv": a["recv"], "sent": a["sent"], "main": a["main"], "cat": a["cat"]}
                 for a in apps],
        "conns": [{"proc": f["proc"] or "(system)", "proto": f["proto"], "host": host(f["raddr"]),
                   "rport": f["rport"], "svc": f["svc"], "cat": f["cat"], "state": f["state"],
                   "down": rnd(f["down"]), "up": rnd(f["up"])} for f in conns],
        "types": types,
        "ports": [{"proto": p["proto"], "port": p["port"], "scope": p["scope"], "svc": p["svc"],
                   "proc": p["proc"] or "(system)"} for p in col.listening],
    }


class WebView:
    def __init__(self, addrs_by_iface, on="tailnet", port=PORT):
        self.state = b"{}"
        self.lock = threading.Lock()
        self.servers = []
        self.urls = []
        self.allowed = TAILNET + LOCAL + (LAN if on == "lan" else [])
        tail = tailnet_addresses(addrs_by_iface)
        if on == "lan":
            binds = ["0.0.0.0"]
            lan_ips = sorted({a for ips in addrs_by_iface.values() for a in ips
                              if in_nets(a, LAN) and ":" not in a})
            self.urls = [f"http://{a}:{port}" for a in tail + lan_ips]
        else:
            binds = tail + ["127.0.0.1"]
            self.urls = [f"http://{a}:{port}" for a in tail]
        handler = self._handler()
        errors = []
        for addr in binds:
            try:
                srv = ThreadingHTTPServer((addr, port), handler)
            except OSError as e:
                errors.append(f"{addr}: {e.strerror or e}")
                continue
            srv.daemon_threads = True
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            self.servers.append(srv)
        if not self.servers:
            raise OSError(f"port {port} busy" if any("in use" in e.lower() for e in errors) else "; ".join(errors))
        if not self.urls:
            self.urls = [f"http://localhost:{port}"]
            self.warning = "no Tailscale address: only this computer can open it"
        else:
            self.warning = None

    def publish(self, state):
        data = json.dumps(state, separators=(",", ":")).encode()
        with self.lock:
            self.state = data

    def close(self):
        for s in self.servers:
            threading.Thread(target=s.shutdown, daemon=True).start()
            s.server_close()
        self.servers = []

    def _handler(self):
        view = self

        class Handler(BaseHTTPRequestHandler):
            server_version = "SnakesNet"

            def log_message(self, *args):  # keep the terminal clean
                pass

            def _ok_host(self):
                h = (self.headers.get("Host") or "").strip().lower()
                if h.startswith("["):
                    h = h[1:h.find("]")] if "]" in h else h
                else:
                    h = h.rsplit(":", 1)[0] if h.count(":") == 1 else h
                # An address, localhost, a MagicDNS name or a bare machine name: not someone
                # else's domain pointed at this computer (DNS rebinding).
                return bool(h) and (_ip(h) is not None or h == "localhost" or h.endswith(".ts.net")
                                    or "." not in h)

            def _send(self, code, body, ctype, cache=False):
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "max-age=3600" if cache else "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Referrer-Policy", "no-referrer")
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                if not in_nets(self.client_address[0], view.allowed) or not self._ok_host():
                    return self._send(403, b"Not on this tailnet.\n", "text/plain")
                path = self.path.split("?")[0]
                if path in ("/", "/index.html"):
                    return self._send(200, page(), "text/html; charset=utf-8")
                if path == "/api/state":
                    with view.lock:
                        body = view.state
                    return self._send(200, body, "application/json")
                if path == "/manifest.webmanifest":
                    return self._send(200, MANIFEST, "application/manifest+json", cache=True)
                if path == "/icon.png":
                    icon = _icon()
                    if icon:
                        return self._send(200, icon, "image/png", cache=True)
                return self._send(404, b"Not found\n", "text/plain")

        return Handler


def _icon():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "icon.png")
    try:
        with open(path, "rb") as f:
            return f.read()
    except OSError:
        return None


MANIFEST = json.dumps({
    "name": "Snake's Net", "short_name": "Snake's Net", "start_url": "/", "display": "standalone",
    "background_color": "#0b0f0c", "theme_color": "#0b0f0c",
    "icons": [{"src": "/icon.png", "sizes": "256x256", "type": "image/png"}],
}).encode()


def page():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web.html")
    with open(path, "rb") as f:
        return f.read()
