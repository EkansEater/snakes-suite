# Snake's Terminal

A terminal for Linux, Windows and macOS in the spirit of iTerm2: tabs, split panes,
profiles and colour schemes, and SSH between your own devices without the fuss.

## What it does

**Terminal**
- Tabs (drag to reorder, double-click to rename, right-click for a colour) and split panes
  side by side or stacked, as deep as you like; drag the dividers, double-click one to even
  them out; maximize a pane and back
- New tabs and splits open in the folder you are in (Linux and macOS)
- Profiles: the program (any shell, WSL, Git Bash…), its folder, colours, font, size,
  cursor and scrollback
- 12 colour schemes (Snake, Solarized, Dracula, Nord, Gruvbox, One Dark, Tokyo Night,
  Catppuccin, Monokai, a classic iTerm look…) and **import your own**: iTerm2
  `.itermcolors` files and Windows Terminal schemes
- Find in the scrollback (case, whole word, regular expressions), clickable links
  (Ctrl/Cmd+click), copy on select, middle-click paste on Linux, a warning before pasting
  several lines
- Pictures in the terminal: iTerm2's protocol (`imgcat`) and Sixel
- Programs may copy to your clipboard (OSC 52: tmux, vim, also over SSH) but never read it
- Notifications from programs (OSC 9 and 777), bell as a flash or a beep
- Broadcast typing to every pane of a tab (one command on many servers at once)
- A hotkey that brings the terminal forward from any app and puts it away again
  (`snakes-terminal --toggle` for systems that keep shortcuts for themselves)
- Command palette (Ctrl+Shift+P, Cmd+Shift+P), every shortcut can be changed
- Remembers your tabs, splits and folders; connections come back paused (Enter reconnects)
- Text size with Ctrl+wheel, a touchpad pinch, or Ctrl/Cmd + and −

**Devices** (Ctrl+Shift+O, Cmd+Shift+O)
- *This computer*: its addresses as ready-to-type `ssh user@address` commands, whether
  other devices can connect to it, and a button that turns its SSH server on (Linux:
  installs and starts OpenSSH; Windows: installs and starts OpenSSH Server, firewall rule
  included; Mac: opens Sharing → Remote Login)
- *Nearby*: Macs with Remote Login on, Linux machines that announce SSH, and other copies
  of Snake's Terminal show up by themselves; **Scan network** finds every computer with
  SSH on, Windows ones included
- *Tailscale*: your devices anywhere, when you use Tailscale
- *Saved* devices with a name, a colour and options (port, key file, jump host), and the
  hosts of your `~/.ssh/config`
- **Set up key login**: makes a key if you have none and puts it on the other device after
  you type its password once; after that it never asks again (Windows targets too)
- Quick connect: type a name, `user@host` or an address and press Enter

SSH itself is your computer's own OpenSSH (built into macOS, Windows 10/11 and Linux), so
your keys, agent, `~/.ssh/config` and known hosts work as they always do. No password is
ever stored.

## Keys

| | Linux and Windows | Mac |
|---|---|---|
| New tab / window | Ctrl+Shift+T / Ctrl+Shift+N | ⌘T / ⌘N |
| Split right / down | Ctrl+Shift+D / Ctrl+Shift+E | ⌘D / ⇧⌘D |
| Close pane | Ctrl+Shift+W | ⌘W |
| Move between panes | Ctrl+Alt+arrows | ⌥⌘arrows |
| Maximize pane | Ctrl+Shift+Enter | ⇧⌘Enter |
| Next / previous tab | Ctrl+PageDown / Ctrl+PageUp | ⇧⌘] / ⇧⌘[ |
| Copy / paste | Ctrl+Shift+C / Ctrl+Shift+V | ⌘C / ⌘V |
| Find | Ctrl+Shift+F | ⌘F |
| Devices | Ctrl+Shift+O | ⇧⌘O |
| Command palette | Ctrl+Shift+P | ⇧⌘P |

Plain Ctrl+letter keys always go to the shell (Ctrl+C, Ctrl+D, Ctrl+R…).

## Run it from this folder

```bash
npm install
npm start
```

`bin/snakes-terminal [folder] [--toggle] [-e command…]` starts it (or, when it is already
running, opens a window in that folder, runs that command, or shows and hides it).

## Files

```
src/main/main.js      windows, terminals (node-pty), settings, the hotkey, the Mac menu
src/main/devices.js   SSH helpers: ~/.ssh/config, keys, this computer, Tailscale, the scan,
                      mDNS (finding devices and announcing this one)
src/main/preload.js   the narrow bridge the page gets
src/renderer/         the page: tabs and splits (layout), one terminal (session), devices,
                      settings, command palette, find bar, keys, colour schemes
```
