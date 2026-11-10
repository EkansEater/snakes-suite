# Snake's Net

A live network monitor in the style of btop, for Linux, Windows and macOS. It runs in a
terminal window; opened from the menu or Snake's Master Suite, it opens one for itself (on
Linux: Konsole, GNOME Terminal, kitty, Alacritty, foot, xterm and others, or whatever
`$TERMINAL` names; on Windows a console window; on macOS Terminal).

- **Speed graph**: download and upload over time, for all traffic or one interface (Tab).
- **Interfaces**: Wi-Fi (network name, signal, link speed), Ethernet (link speed), VPNs such as
  Tailscale; speed, history and totals for each.
- **Apps using the network**: download and upload speed per app, connections, what it talks to.
  Press `v` for every connection with its remote host, type and state.
- **Traffic by type**: web, streaming, calls, gaming, P2P, sync, DNS, VPN and more.
- **Open ports**: what is listening, and whether the network can reach it or only this computer.
- **Web view** (`w`): the same numbers as a live page your phone, tablet or another computer
  opens over Tailscale.

## Per-app speeds on each system

| | Normal user | `R`: sudo / administrator |
|---|---|---|
| **Linux** | TCP per app, from the kernel (`tcp_diag`), for your own apps | Captures packets: UDP too (QUIC, games, calls) and every app |
| **Windows** | Interfaces, connections and ports; per-app speeds show `n/a` | Windows' own per-connection counters: TCP per app (not UDP) |
| **macOS** | TCP and UDP per app, from macOS's `nettop` | The same, including system services |

If Linux says `tcp_diag can't load`, the kernel was updated and not yet rebooted into.

## Web view

Press `w`, or start with `--serve`. The header shows the address, such as
`http://100.101.102.103:7878`: open it on your phone (with Tailscale on) and add it to the
home screen. It listens only on this computer's Tailscale address and answers only devices on
your tailnet; it can only read, never change anything. `--serve-on lan` also lets devices on
the local network in.

For a computer you only watch from elsewhere, `snakes-net --headless` runs the web view
without a screen.

The Snake's Net phone apps open the same page under *Computers*.

## Keys

Tab / ← → interface · `v` apps or connections · `s` sort · `b` bits or bytes · `n` host names ·
`l` loopback · `w` web view · `p` pause · `+` `-` update speed · ↑ ↓ PgUp PgDn scroll · `[` `]` scroll open ports ·
mouse wheel scrolls the panel under the pointer ·
`R` restart with sudo / as administrator · `q` quit

## Running from source

    ./snakes-net                  # Linux and macOS: Python 3.10+ (macOS also needs psutil)
    snakes-net.cmd                # Windows: Python 3.10+ with psutil and windows-curses
    ./snakes-net --snapshot 5     # measure 5 seconds, print a text report
    ./snakes-net --headless       # only the web view
    ./snakes-net --help

The suite ships Linux as these source files, and Windows and macOS as one program built
with PyInstaller (`python packaging/build.py tool net`), which needs no Python.

## Layout

    snakes_net/app.py         the screen, the collector, start-up
    snakes_net/sources/       where the numbers come from: linux.py, windows.py, macos.py
    snakes_net/system.py      restarting as administrator, opening a terminal
    snakes_net/web.py         the web view's server; web.html is its page
