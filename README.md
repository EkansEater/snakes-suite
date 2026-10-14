# Snake's Suite

Every Snake tool in one place: a hub app that opens them, and an installer
that puts each one on your computer as a normal app, alone or as a whole kit.

| Tool | What it is | Linux | Windows | macOS |
|---|---|:-:|:-:|:-:|
| Snake's Code | Code editor (Electron, Monaco) | ✓ | ✓ | ✓ |
| Snake's Compressor | Lossless `.snake` archiver | ✓ | ✓ | ✓ |
| Snake's Converter | Audio, video, image, document converter | ✓ | ✓ | ✓ |
| Snake's Recompiler | N64 recompiler | ✓ | – | – |
| Snake's SoundPad | Soundboard through a virtual mic | ✓ | – | – |
| Snake's MP3 Converter | Video links to tagged MP3s (was Snake's Sounds) | ✓ | ✓ | ✓ |
| Snake's DAW | Amp, effects, looper, recording | ✓ | ✓ | ✓ |
| Snake's Screen Recorder | Screen to MP4 / GIF, audio to MP3 | ✓ | ✓ | ✓ |

SoundPad depends on PipeWire and the Recompiler's launcher on Unix process
handling, so both are Linux only for now. The hub shows them as "Linux only"
elsewhere.

## Download

Get **Snake's Suite** for your system from the
[latest release](https://github.com/EkansEater/snakes-suite/releases/latest). It is one file:

| System | File |
|---|---|
| Windows | `Snakes-Suite-windows-x86_64.exe` |
| macOS (Apple silicon / Intel) | `Snakes-Suite-macos-arm64.dmg` / `Snakes-Suite-macos-x86_64.dmg` |
| Linux | `Snakes-Suite-linux-x86_64` (make it executable: `chmod +x`) |

Open it and it offers to install itself, with its own icon in your app list and
on the desktop. Then pick any tool, or the whole kit: each downloads ready to
run (no Python, Rust or Node.js needed) and installs as a normal app with its
own snake icon, in the application menu, the Start menu or ~/Applications, and
optionally on the desktop. Come back to Snake's Suite to update or remove tools.

The apps are not signed by Microsoft or Apple, so the first time: on Windows
choose *More info → Run anyway* if SmartScreen warns; on macOS right-click the
app and choose *Open*.

## Releasing

The easy way: `python ship.py`. It shows what changed since the last release,
raises those versions for you, and asks whether to **update locally** (build
and install the changed tools on this computer), **update GitHub** (commit,
push and publish the release), or both. `--dry-run` only shows the plan.

By hand: push a tag (`git tag v1.0.1 && git push --tags`) or run the **Release** workflow
from the Actions tab. GitHub builds every tool and the one-file app on Linux,
Windows and macOS (`packaging/build.py`) and publishes them with `index.json`,
which the app reads to know what it can download. Raise the changed tool's
`version` in `suite.json` so installed copies update themselves; when the app
itself changed, raise the hub's `version` and `__version__` in
`hub/snakes_suite/__init__.py` together.

To build for this computer only: `python packaging/build.py tools`, `... hub`,
then `... index release/`. Set `SNAKES_SUITE_INDEX` to another index URL to
test the app against your own build.

## Installing from source (for developing the tools)

`install.py` builds tools from this folder instead of downloading them:

```bash
python install.py --all             # every tool, plus the hub
python install.py converter daw     # just these
python install.py --list            # what is installed
python install.py --uninstall daw   # remove one
```

Building needs Python 3.10+, Rust for the Compressor and the DAW, and Node.js
for Snake's Code.

## The hub

**Snake's Suite** opens with a grid of every tool. Click one to open it. A tool
that is not installed yet shows "Click to install" and installs from the kit
with its progress in a window. Right-click a tile to reinstall, add a desktop
shortcut, or uninstall. `Ctrl+K` searches, and Enter opens the first match.

**Updates come by themselves.** Each time it opens (and every six hours while
open) the app checks the latest release. A newer Snake's Suite downloads,
replaces the installed one and restarts; then every tool with a newer version
updates in a small window that closes itself. A tool that is running is left
until the next check. Turn this off with *⋯ → Update automatically*; updates
then wait for the tile's Update button (and the status bar's, for the app).

A tool that used to keep your files inside its own folder can list them as
`user_data` in `suite.json` (the folder they go to, and the names to move), and
an update moves them out before replacing the program. The Recompiler does
this: saves, states, settings and ROMs go to `~/.local/share/snakes-recompiler/`.

A tool that is renamed lists its old id as `formerly` (and an old data folder
as `user_data.formerly`). The app then treats a copy installed under the old
id as an older version of the renamed tool: updating it removes the old menu
entries and program, and moves the old data folder to the new one.

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

1. Put it in `tools/` and give it an entry in `suite.json`: its `id`, `name`, `tagline`, `folder`, `kind`
   (`python`, `cargo`, `electron` or `script`), `platforms`, and what it needs.
   A Python tool needs a `pyproject.toml` and its `module`; a Rust tool its `binary`.
2. Add its glyph to `GLYPHS` in `shared/icons/make_icons.py` and run it.
3. Say where its theme copy goes (`qt_theme` or `egui_theme`) and its asset folder,
   then run `python shared/sync.py`.
4. In the tool, use the theme: `snake_theme.apply(app)` and a `HeaderBar` for Qt,
   or `snake_theme::apply(ctx)` with `header_frame()` for egui.

The installer, the release build and the app all read `suite.json`, so the new
tool appears everywhere with no further changes. For a Python tool, add a
`package` entry (its `entry` function, `exe` name and Qt binding) so it can be
frozen; see the existing tools.
