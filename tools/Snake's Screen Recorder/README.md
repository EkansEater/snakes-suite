# Snake's Screen Recorder

A simple screen and audio recorder.

- **Video → MP4**, **GIF**, or **audio only → MP3**
- Record the **full screen**, a **region** you drag out, or (on Wayland) a single **window**
- System audio and/or microphone, mixed into the recording
- Pause / resume, countdown, optional mouse cursor, quality and frame-rate presets
- Optional green outline around the selected region, always on top (never appears in the video)
- Recordings list with a built-in preview player (MP4, GIF and MP3)
- Tray icon and `snakescreen --toggle` for a global hotkey

## Run

```
python -m snakescreen
```

Requires Python 3.10+ and PyQt6, plus:

| OS | Needs | Notes |
| --- | --- | --- |
| Linux (Wayland) | ffmpeg, GStreamer with the PipeWire and x264 plugins, PyGObject | The desktop asks once which screen to share, then remembers it. Keeping the region outline above other windows needs `layer-shell-qt` (KDE and wlroots desktops). |
| Linux (X11) | ffmpeg | |
| Windows | `pip install PyQt6 imageio-ffmpeg` (or ffmpeg on PATH) | System audio needs a loopback device: enable "Stereo Mix" or install VB-CABLE. |
| macOS | `pip install PyQt6 imageio-ffmpeg` (or `brew install ffmpeg`) | Allow Screen Recording and Microphone in System Settings → Privacy & Security. System audio needs a loopback device such as BlackHole. |

To install it as a normal command on any OS: `pip install .` then run `snakescreen`.
On Linux, `./install-linux.sh` adds it to the application menu without pip.

## Using it

1. Pick **Video (MP4)**, **GIF** or **Audio (MP3)**.
2. For video/GIF choose the capture area. With **Region**, click *Select region…* and drag a rectangle; it is remembered.
3. Press **Record**. Stop from the window, the tray icon, or `snakescreen --toggle`.

Recordings are saved as `SnakeScreen_<date>_<time>.<ext>` in the *Save to* folder.

**Global hotkey:** bind `snakescreen --toggle` (also `--pause`, `--stop`) to a key in your
desktop's shortcut settings.

## How it works

`snakescreen/recorder.py` captures segments (a new one after each pause) and ffmpeg joins them
into the final file. Capture is per OS (`platforms.py`): the xdg-desktop-portal + PipeWire on
Wayland, and ffmpeg's `x11grab`, `gdigrab` and `avfoundation` elsewhere.

Status: developed and tested on Linux (KDE Plasma, Wayland). The X11, Windows and macOS
capture paths are implemented but have not been run on those systems yet.
