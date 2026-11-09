"""Where the numbers come from, one module per operating system.

Every source gives the collector the same things:

- counters(): {interface: (bytes received, bytes sent)} since boot
- iface_state(name): (kind, up, link speed in Mb/s or None)
- slow(): (Wi-Fi details, addresses), polled every few seconds in a thread
- sockets(): (tcp, udp) lists of dicts with proto, state, laddr, lport, raddr, rport,
  pid, proc, key, recv, sent. `recv`/`sent` are byte counters since the socket
  opened, or None when this system can't count per socket; `key` identifies the
  socket between ticks.
- sniffer(): a packet counter thread (Linux with root), or raises OSError
"""

import sys


def load():
    if sys.platform.startswith("linux"):
        from .linux import Source
    elif sys.platform == "win32":
        from .windows import Source
    elif sys.platform == "darwin":
        from .macos import Source
    else:
        raise SystemExit(f"Snake's Net doesn't support {sys.platform} yet.")
    return Source()
