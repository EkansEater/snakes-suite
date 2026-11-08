# Snake's Net

A live network monitor in the style of btop, for Linux. It runs in a terminal window; opened
from the menu or Snake's Master Suite, it opens one for itself (Konsole, GNOME Terminal, kitty,
Alacritty, foot, xterm and others, or whatever `$TERMINAL` names).

- **Speed graph**: download and upload over time, for all traffic or one interface (Tab).
- **Interfaces**: Wi-Fi (network name, signal, link speed), Ethernet (link speed), VPNs such as
  Tailscale; speed, history and totals for each.
- **Apps using the network**: download and upload speed per app, connections, what it talks to.
  Press `v` for every connection with its remote host, type and state.
- **Traffic by type**: web, streaming, calls, gaming, P2P, sync, DNS, VPN and more.
- **Open ports**: what is listening, and whether the network can reach it or only this computer.

## Normal user or sudo

As a normal user it reads TCP byte counts from the kernel (the `tcp_diag` module), for your
own apps. Press `R` (or run `sudo snakes-net`) to capture packets instead: then it sees UDP
too (QUIC, which browsers use for YouTube and Google, games, calls) and every app on the system.

If per-app speeds say `tcp_diag can't load`, the kernel was updated and not yet rebooted into.

## Keys

Tab / ← → interface · `v` apps or connections · `s` sort · `b` bits or bytes · `n` host names ·
`l` loopback · `p` pause · `+` `-` update speed · ↑ ↓ PgUp PgDn scroll · `R` restart with sudo ·
`q` quit

## Running

    ./snakes-net                  # from this folder, needs only Python 3.10+
    ./snakes-net --snapshot 5     # measure 5 seconds, print a text report
    ./snakes-net --help
