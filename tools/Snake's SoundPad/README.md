# Snake's SoundPad

A Soundpad clone for Linux (PipeWire). Play sound clips through a virtual microphone
so people in Discord or in-game voice chat hear them, mixed with your real mic.

## How it works

```
real mic ──loopback──┐
                     ├─> "Snake Soundpad Sink" ──monitor──> "Snake Soundpad Mic"  ← pick this in Discord/games
sound clip (mpv) ────┘
sound clip (mpv) ──> your headphones (optional, so you hear it too)
```

The virtual devices are created when the app starts and removed when it quits.
Your normal audio setup isn't changed.

## Requirements

`python3`, `pyside6`, `mpv`, `pipewire-pulse` (provides `pactl`). On Arch/CachyOS:

```bash
sudo pacman -S pyside6 mpv pipewire-pulse
```

mpv plays nearly any audio format (mp3, wav, ogg, opus, flac, m4a, …).

## Run

```bash
./install.sh     # optional: adds `snakepad` to ~/.local/bin and an app-menu entry
snakepad         # or ./snakepad.sh
```

Then in **Discord → Settings → Voice & Video → Input Device**, choose **Snake Soundpad Mic**.

**Games with no input device setting:** by default, Snake Soundpad Mic becomes your system's
default microphone while the app runs, so any game that uses "the mic" picks it up automatically.
Start the app *before* the game, or restart the game. Your real mic is restored as the default
when you quit. You can turn this off with the *Make Snake Soundpad Mic the system default* checkbox.
Turn off Discord's *Noise Suppression* and *Echo Cancellation*, and consider setting
*Input Sensitivity* manually, or your clips may get filtered out or cut off.

## Using it

- **Add sounds:** toolbar buttons, Ctrl+O, or drag files or folders onto the window
- **Play:** double-click, Enter, or type in search and press Enter to play the first match
- **Stop:** Esc
- **Rename / per-sound volume:** F2 on a cell, or right-click
- **Trim and loop:** double-click a sound's *Plays* cell, press Ctrl+T, or right-click → *Trim and loop…*: drag the marks on its waveform to choose where it starts and ends, listen to the result, and tick *Loop* to repeat it until you press Esc
- **Volume others hear / Hear sounds myself:** global sliders (per-sound volume multiplies them)
- **Pass my mic through:** mixes your real mic into the virtual mic. Turn it off to send only the sounds.
- Closing the window keeps the app in the tray. Quit from the tray menu.

## Global hotkeys (Wayland)

Wayland doesn't let apps capture keys globally, so bind commands in your desktop instead.
On KDE: **System Settings → Keyboard → Shortcuts → Add New → Command or Script**.

```
snakepad play 3          # by number (as shown in the # column)
snakepad play airhorn    # by name or name prefix
snakepad toggle 3        # play, or stop if something's playing
snakepad random
snakepad stop
snakepad list
```

Right-click a sound and choose **Copy hotkey command** to get its command.

## Files

- `snakepad/audio.py`: virtual device setup (pactl modules) and mpv playback
- `snakepad/gui.py`: the window
- `snakepad/ipc.py`: local socket that the `snakepad <command>` CLI uses
- `snakepad/library.py`: sound list and settings, saved to `~/.config/snakepad/library.json`
