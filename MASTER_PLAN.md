# Snake's Master Suite: the plan

Snake's Master Suite is the successor of Snake's Suite (`../Snake's Suite`, kept
untouched as a fallback). It holds every Snake app in one folder and one git
repository, mirrored on GitHub (`EkansEater/snakes-suite`: source, releases and
the index the hub updates from).

## The apps

| App | id | Stack | What it is |
|---|---|---|---|
| Snake's Master Suite (hub) | suite | PySide6 | Opens, installs and updates every app |
| Snake's Word | word | Studio (web) | Word processor: pages, styles, tables, images, .docx/.pdf |
| Snake's Spreadsheets | sheets | Studio (web) | Spreadsheet: formulas, charts, filters, .xlsx/.csv |
| Snake's Slides | slides | Studio (web) | Presentations: shapes, themes, presenter view, .pptx/.pdf |
| Snake's Paint | paint | Studio (web) | MS Paint style drawing |
| Snake's Photo | photo | Studio (web) | Photoshop style editor: layers, selections, adjustments |
| Snake's Player | player | Studio (web) | VLC style media player: playlist, EQ, subtitles |
| Snake's Movie Maker | movie | Studio (web) | Video editor: timeline, titles, transitions, export |
| Snake's Code | code | Electron + Monaco | VS Code style code editor |
| Snake's Compressor | compressor | Rust egui | Lossless .snake archiver |
| Snake's Converter | converter | PySide6 | Audio/video/image/document converter |
| Snake's MP3 Converter | mp3 | PySide6 | Video links to tagged MP3 |
| Snake's SoundPad | soundpad | PySide6 | Soundboard through a virtual mic |
| Snake's DAW | daw | Rust egui | Amp, effects, looper, recording |
| Snake's Screen Recorder | screen | PyQt6 | Screen to MP4/GIF, audio to MP3 |
| Snake's Recompiler | recompiler | Python + C | N64 recompiler (Linux) |

### Snake's Studio: one runtime for the new apps

The seven new apps share one hardened Electron runtime, `tools/Snake's Studio`,
so they cost one download and behave the same on Linux, Windows and macOS. Each
app has its own name, icon, menu entry and window (`snakes-studio --app word`).
The renderer code is plain ES modules with no framework and no runtime
dependencies, so `dist/` also runs as a static website: the online mirror.

```
tools/Snake's Studio/
  src/main/        Electron main process, preload bridge, security
  src/kit/         shared UI kit: theme, menus, context menus, hover zoom, dialogs,
                   command palette, host adapter (Electron or browser), zip, xml
  src/apps/<id>/   one folder per app
```

## Ergonomics (every app)

- **Hover zoom.** Ctrl+wheel zooms whatever is under the pointer, anchored at
  the pointer. Canvas apps (Paint, Photo, Slides, Movie timeline) also zoom on a
  plain wheel unless set otherwise; documents scroll on a plain wheel. Ctrl+0
  resets. The zoom level sits in the status bar and is clickable.
- **Wheel adjusts values.** Hovering a slider, number box or volume control and
  turning the wheel changes it (Alt = fine steps). Shift+wheel scrolls sideways.
- **Right-click everywhere** opens a context menu of what applies there, with
  shortcuts shown.
- **Visible scroll bars** that widen on hover, on everything that scrolls.
- **Command palette** (Ctrl+Shift+P / F1) searches every command.
- **Tooltips** name the command and its shortcut.
- Windows remember size, position, recent files and settings. Drop files on any
  window to open them.

## Security (free measures)

- Studio and Code: context isolation, sandboxed renderers, no Node in pages,
  strict Content-Security-Policy, a custom `snake://` protocol instead of
  `file://`, navigation and new windows locked, every permission denied unless
  needed (microphone for Movie Maker voice-over, asked first), IPC checks the
  sender, Electron fuses (no RunAsNode, no NODE_OPTIONS, no inspector flags,
  asar integrity).
- File access by capability: a page can only read or write a file the user
  picked, dropped or opened with the app. Recent files reopen by id.
- Pasted and imported documents are sanitised (allow-list of tags and
  attributes) before they reach the page.
- Subprocesses (ffmpeg, yt-dlp, ...) always get argument lists, never a shell.
- Hub: HTTPS only, SHA-256 required for every download, release index signed
  with Ed25519 and checked against the key built into the hub, archives
  extracted with path checks.

## Status

- [x] Master Suite repo cloned from Snake's Suite with history
- [x] Studio runtime + UI kit (hardened Electron, snake:// protocol, file grants, kit/)
- [x] Overhaul: Qt ergonomics module (`shared/qt/snake_ergo.py`, synced next to each tool's theme): Ctrl+wheel zoom of the hovered list/text or the whole UI, scroll guard, command palette (Ctrl+Shift+P/F1), shortcuts (Ctrl+/), copy menus, remembered geometry; in Converter, MP3, SoundPad, Screen Recorder, hub. SoundPad now cross-platform (virtual-cable mode via Qt Multimedia)
- [x] Overhaul: egui ergonomics (`snake_theme::ergonomics`: Ctrl+wheel zoom, remembered) in Compressor and DAW
- [x] Overhaul: Snake's Code (sandbox on, IPC only from its own window, web/mail-only external links, no permissions/downloads/webviews, allowlist Markdown sanitizer, fuses; Ctrl+wheel zoom of terminal/preview/UI)
- [x] Overhaul: hub becomes Snake's Master Suite (Studio apps in suite.json as `studio_app` entries sharing tools/Snake's Studio; Linux MimeType for Open with)
- [x] Word (pages, styles, tables, pictures, find, outline, docx/odt/md/html/rtf in, docx/pdf/md/html/txt out)
- [x] Spreadsheets (~250 functions, spills, charts, filters, CF, validation, xlsx/csv; tests: node test/sheets.test.mjs)
- [x] Slides (themes, layouts, smart guides, animations, transitions, presenter view + audience window, pptx in/out, pdf)
- [x] Paint (brushes, pencil/pixel art, mirror and kaleidoscope painting, shapes, curve, text, fill, gradient, stickers, select/lasso with move/resize, image menu, png/jpg/webp/bmp)
- [x] Photo (layers, masks, blend modes, effects, adjustment layers, selections incl. wand/colour range/subject, clone/heal/spot-heal/dodge/burn/smudge brushes with pen pressure, 13 adjustments, 18 filters, crop, free transform, text, shapes, before/after; PSD and ORA in/out)
- [x] Player (direct play, or on-the-fly remux/transcode via ffmpeg for MKV/AVI/WMV/AC3/HEVC…; playlists M3U/PLS resolved safely in the main process; SRT/VTT/ASS + embedded subtitles with delay/size; audio tracks; 10-band EQ, boost, balance, night mode; visualiser + cover art; speed, A-B loop, frame step, chapters, resume, sleep timer, snapshots, PiP, mini player, media keys, convert)
- [x] Movie Maker (timeline: tracks, move/trim/split/ripple/snap, fades, speed, titles with animations, cross-fade/black/slide transitions, looks, Ken Burns, picture-in-picture, detach audio, voice-over, editing copies for MKV/AVI…, projects with safe media relinking; export through one ffmpeg graph (src/main/movie-export.js) that matches the preview frame for frame; MP4/WebM/GIF/MP3/M4A/WAV; browser fallback records the preview)
- [x] Catalogue, icons, packaging, signed index (Studio built once per platform as a shared package listed under each app; optional bundled ffmpeg via SNAKE_FFMPEG_DIR; sha256 now mandatory; Ed25519-signed index.json, verified by the hub when suite.json has release.index_pubkey: run `python packaging/build.py keygen`, add the secret SNAKE_INDEX_KEY, put the public key in suite.json)
- [x] ffmpeg inside the Studio packages: Linux and macOS build it from pinned, checksum-checked sources (`packaging/ffmpeg/build.sh`: x264, libvpx, Opus, LAME, dav1d; GPL v3; no network protocols, only file and pipe); Windows uses gyan.dev's GPL essentials build pinned in `packaging/ffmpeg/windows.json`. The release workflow caches it. (Martin Riedl's builds were ruled out: built with --enable-nonfree, not redistributable.)
- [x] Index signing key made (`~/.config/snakes-suite/index-signing-key`, 0600); public key in suite.json; `build.py index` refuses to write an index the app would reject
- [x] Online mirror built: `.github/workflows/pages.yml` deploys Studio `dist/` to https://ekanseater.github.io/snakes-suite/ on pushes to main; per-app web manifests (installable), frame guard, desktop download link
- [x] Fixes found while finishing: Studio children (ffmpeg, ffprobe, app launches) inherited ~90 Chromium descriptors on Linux (IPC sockets, shared memory, GPU device); they now start through `clean()` in src/main/media.js, which closes all but stdio. Player and the Studio home could not close (main waited for a close answer only guarded pages send); now only pages that register a guard are asked. Slides template thumbnails and table header colours (CSS custom properties set through Object.assign). Long window titles no longer cover the menus.
- [ ] Follow-up: Snake's Code's children (rg, git, terminal shells) inherit the same descriptors
- [x] Publish (2026-10-16): secret SNAKE_INDEX_KEY set by the owner; versions raised (release v1.1.5, hub 1.1.3, Studio apps 1.0.0, other tools 1.0.1); Pages on (Source: GitHub Actions); main fast-forwarded to `master-suite`; tag v1.1.5 pushed to start the Release workflow

## Testing the Studio apps

- `node test/sheets.test.mjs` (in tools/Snake's Studio): spreadsheet engine tests.
- `npm run web` serves dist/ on http://localhost:5178 for the browser pane. With
  `SNAKE_TEST_DIR=<dir>` set, the page can `PUT /__save/<name>` to write test output.
- Desktop: `bin/snakes-studio --app=word --remote-debugging-port=9334 [file]`, then drive it
  over CDP (Runtime.evaluate on `window.snakeApp`). `SNAKE_TEST_PDF=<path>` makes PDF export
  write there without a dialog. Never `pkill -f` a pattern that appears in your own command.

## Where work stopped (2026-10-16)

Everything is built and tested locally on the `master-suite` branch: the Studio and its seven
apps, the overhaul of every tool, the hub, packaging with ffmpeg (a Linux Studio package was
built and played an AC3 MKV through its own ffmpeg), the signed index and the web mirror
workflow. All of it is on main and released as v1.1.5 (the first release built by the new
workflow: check its run in the Actions tab, macOS and Windows were not built locally). Test helpers: `SNAKE_TEST_SAVEAS=<dir>` (Save As without a
dialog), `SNAKE_TEST_PDF=<path>`. Next releases: `python ship.py`.
