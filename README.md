# Snake's Suite

Every Snake tool in one place: a hub app that opens them, and an installer
that puts each one on your computer as a normal app, alone or as a whole kit.

| Tool | What it is | Linux | Windows | macOS |
|---|---|:-:|:-:|:-:|
| Snake's Code | Code editor (Electron, Monaco) | ✓ | ✓ | ✓ |
| Snake's Compressor | Lossless `.snake` archiver | ✓ | ✓ | ✓ |
| Snake's Converter | Audio, video, image, document converter | ✓ | ✓ | ✓ |
| Snake's Decompiler | N64 recompiler | ✓ | – | – |
| Snake's SoundPad | Soundboard through a virtual mic | ✓ | – | – |
| Snake's MP3 Converter | Video links to tagged MP3s (was Snake's Sounds) | ✓ | ✓ | ✓ |
| Snake's DAW | Amp, effects, looper, recording | ✓ | ✓ | ✓ |
| Snake's Screen Recorder | Screen to MP4 / GIF, audio to MP3 | ✓ | ✓ | ✓ |

SoundPad depends on PipeWire and the Decompiler's launcher on Unix process
handling, so both are Linux only for now. The hub shows them as "Linux only"
elsewhere.

## Install

You need Python 3.10 or newer. From this folder:

```bash
python install.py --all             # the whole kit, plus the hub
python install.py converter daw     # just these
python install.py                   # pick from a list
python install.py --list            # what is installed
python install.py --uninstall daw   # remove one (--uninstall --all removes everything)
```

Add `--desktop` for desktop shortcuts. Building the Compressor and the DAW
needs [Rust](https://rustup.rs); Snake's Code needs [Node.js](https://nodejs.org).
If one is missing, that tool is skipped with a note and the rest still install.

What "installed" means on each system:

- **Linux:** an entry in the application menu with its icon, a command in
  `~/.local/bin` (`snakes-converter`, `snakepad`, `snakescreen`, `snakedaw`, `snake`…),
  and optionally a desktop launcher.
- **Windows:** a Start menu folder "Snake's Suite", an entry under
  Settings › Apps › Installed apps with an Uninstall button, and optionally a desktop shortcut.
- **macOS:** an app bundle in `~/Applications` (with its icon, so it is in Launchpad
  and Spotlight), and optionally an alias on the desktop.

Programs and the shared Python environment live in the suite's data folder
(`~/.local/share/snakes-suite`, `%LOCALAPPDATA%\SnakesSuite`, or
`~/Library/Application Support/SnakesSuite`). Uninstalling removes all of that,
but never your own files (projects, recordings, settings).

Snake's Code and the Decompiler run from their source folders: Electron needs its
`node_modules` beside it, and the Decompiler builds games next to itself.

## The hub

**Snake's Suite** opens with a grid of every tool. Click one to open it. A tool
that is not installed yet shows "Click to install" and installs from the kit
with its progress in a window. Right-click a tile to reinstall, add a desktop
shortcut, or uninstall. `Ctrl+K` searches, and Enter opens the first match.

## The look

Every tool uses the **Snake Dark** theme of Snake's Code and an icon from the
same family: the Snake's Code tile and snake, with a glyph of its own in place
of the `< >` brackets.

```
shared/
  icons/make_icons.py    makes every icon (svg, png, ico) from one template
  qt/snake_theme.py      the Qt theme: palette, stylesheet, HeaderBar (PySide6 and PyQt6)
  egui/snake_theme.rs    the same for the Rust/egui tools
  sync.py                copies the theme, icons and palette into every tool
```

Each tool keeps its own copy, so it still builds and runs on its own. After
changing anything in `shared/`, run:

```bash
python shared/icons/make_icons.py   # only if the icons changed (needs rsvg-convert and ImageMagick)
python shared/sync.py
```

## Adding a new tool

1. Give it an entry in `suite.json`: its `id`, `name`, `tagline`, `folder`, `kind`
   (`python`, `cargo`, `electron` or `script`), `platforms`, and what it needs.
   A Python tool needs a `pyproject.toml` and its `module`; a Rust tool its `binary`.
2. Add its glyph to `GLYPHS` in `shared/icons/make_icons.py` and run it.
3. Say where its theme copy goes (`qt_theme` or `egui_theme`) and its asset folder,
   then run `python shared/sync.py`.
4. In the tool, use the theme: `snake_theme.apply(app)` and a `HeaderBar` for Qt,
   or `snake_theme::apply(ctx)` with `header_frame()` for egui.

The installer and the hub read `suite.json`, so the new tool appears in both
with no further changes.

## Backups

`backups/pre-overhaul-2026-10-14/` holds the source of every tool from before
the suite overhaul.
