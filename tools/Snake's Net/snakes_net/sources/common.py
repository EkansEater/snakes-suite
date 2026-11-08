"""Small helpers every source shares."""

import ipaddress
import socket

# One short name per TCP state, whatever the system calls it.
STATE_NAMES = {
    "ESTABLISHED": "ESTAB", "SYN_SENT": "SYN-S", "SYN_RECV": "SYN-R", "FIN_WAIT1": "FIN-W1",
    "FIN_WAIT2": "FIN-W2", "TIME_WAIT": "T-WAIT", "CLOSE": "CLOSE", "CLOSE_WAIT": "C-WAIT",
    "LAST_ACK": "L-ACK", "LISTEN": "LISTEN", "CLOSING": "CLOSNG", "NONE": "",
    "DELETE_TCB": "CLOSE", "SYN_RECEIVED": "SYN-R", "CLOSED": "CLOSE",
}


def norm_addr(b):
    """Packed address bytes -> text; IPv4-mapped IPv6 becomes plain IPv4."""
    if len(b) == 4:
        return socket.inet_ntop(socket.AF_INET, b)
    if b[:12] == b"\0" * 10 + b"\xff\xff":
        return socket.inet_ntop(socket.AF_INET, b[12:16])
    return socket.inet_ntop(socket.AF_INET6, b)


def norm_text(addr):
    """Text address -> the same form norm_addr gives (no scope, IPv4 unmapped)."""
    addr = (addr or "").split("%")[0]
    if addr.startswith("::ffff:") and "." in addr:
        return addr[7:]
    return addr


def is_loopback(addr):
    return addr.startswith("127.") or addr == "::1"


def is_global(addr):
    """An address worth showing for an interface (not link-local)."""
    try:
        ip = ipaddress.ip_address(norm_text(addr))
    except ValueError:
        return False
    return not (ip.is_link_local or ip.is_loopback or ip.is_unspecified)


def kind_from_name(name):
    """Guess an interface's kind from its name (Windows and macOS names)."""
    n = name.lower()
    if "loopback" in n or n == "lo" or (n.startswith("lo") and n[2:].isdigit()):
        return "Loopback"
    if n.startswith(("tun", "utun", "ipsec", "ppp", "wg", "tap", "zt")) or any(
            w in n for w in ("tailscale", "wireguard", "vpn", "openvpn", "zerotier", "nordlynx", "proton")):
        return "VPN"
    if any(w in n for w in ("vethernet", "virtual", "vmware", "virtualbox", "hyper-v", "wsl", "docker",
                            "bluetooth", "npcap", "isatap", "teredo", "6to4", "pseudo")) or "*" in n:
        return "Virtual"
    if n.startswith(("bridge", "awdl", "llw", "anpi", "ap", "gif", "stf", "vmnet", "vnic")):
        return "Virtual"
    if any(w in n for w in ("wi-fi", "wifi", "wlan", "wireless", "802.11")):
        return "Wi-Fi"
    if any(w in n for w in ("ethernet", "local area connection", "lan")) or n.startswith("en"):
        return "Ethernet"
    return "Virtual"
