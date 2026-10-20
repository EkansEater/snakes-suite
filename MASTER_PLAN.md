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
| Snake's Terminal | terminal | Electron + xterm.js | iTerm2 style terminal, SSH between your devices |
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
- [x] v1.1.5 released (all four builds green, index signed and verified). Its macOS Studio packages have no ffmpeg: the link missed libiconv (fixed in build.sh with --extra-libs=-liconv). `.github/workflows/ffmpeg.yml` now builds and checks ffmpeg on all four systems when packaging/ffmpeg changes on main, and leaves it in a cache the release tags can use (caches saved under a tag are not shared with later tags)
- [x] v1.1.6 released (2026-10-16): ffmpeg workflow green on all four systems first; every Studio package now carries ffmpeg (macOS arm64 and x86_64 checked in the published archives); index signed and verified; Studio apps 1.0.1
- [x] Snake's Code's children (ripgrep, git, terminal shells, tasks) no longer inherit Chromium's descriptors: they start through the same close-everything-but-stdio wrapper (`clean()` in its src/main/main.js); a terminal shell went from ~80 open descriptors to 3
- [x] Publish (2026-10-16): secret SNAKE_INDEX_KEY set by the owner; versions raised (release v1.1.5, hub 1.1.3, Studio apps 1.0.0, other tools 1.0.1); Pages on (Source: GitHub Actions); main fast-forwarded to `master-suite`; tag v1.1.5 pushed to start the Release workflow

- [x] Pinch to zoom everywhere (2026-10-16), the wheel stays for mouse and keyboard. Studio: `pinch()` in kit/zoom.js zooms what is under the fingers (pages, pictures, the grid, video, the timeline, a selected title's size), a pinch over menus or panels resizes the interface, the browser's own page zoom is off (`touch-action: pan-x pan-y`), and a second finger cancels whatever the first one started (strokes, drags, taps). Qt tools: touchpad pinch (native gesture) and touch-screen pinch (QPinchGesture) in snake_ergo, plus one-finger kinetic scrolling of lists. Snake's Code: touch pinch for the editor font, terminal, Markdown preview or window. egui apps (Compressor, DAW) already had it through egui's zoom_delta. Android Compose apps: two fingers resize the interface (core's SnakeTheme), except where an area zooms itself (DAW timeline). Recompiler (SDL game window) has no zoomable interface.
- [x] Phones: below 720 px wide the Studio apps rearrange (kit/phone.js): menus fold into one ☰ button with drill-down submenus, side panels become drawers with title-bar buttons, start screens stack, dialogs and toolbars fit, bigger touch targets; long press opens right-click menus on iOS (Android does it natively); a finger scrolls lists and the grid, taps select. Movie Maker: tap a clip to select it, then drag it; Player: a tap in the playlist plays.
- [x] Website on phones: installable to the home screen on iPhone and Android (apple-touch-icon, safe areas), and an offline copy (dist/sw.js, made by build.mjs) so installed apps work without a connection.
- [x] Android in this repository (`android/`, from the old "Snake's Suite APK" folder, which is untouched): builds from `../suite.json` and the tools' own sources. New **Snake's Studio** APK: the seven Studio apps (one APK, seven launcher icons and tasks) on the website's own pages, with a bridge for the file picker, saving in place, recent files (persisted permissions), printing, Open with; tested page-side against a stand-in bridge (open, save, Save As .docx, back button with unsaved changes). Android hub: Studio apps listed (one shared download), the signed index is checked (Ed25519 in Kotlin, RFC 8032 tests), renamed Snake's Master Suite. All 13 release APKs build and are signed with the existing key (`cd android && ./build.sh`). Not done: trying them on a phone (no emulator here: no KVM).
- [x] iOS (`ios/`): Snake's Studio for iPhone and iPad (Swift, WKWebView, the same pages and the same bridge requests as Android), built by `.github/workflows/ios.yml` on GitHub's Macs into an unsigned .ipa. Not compiled yet (no Mac here; the workflow runs once pushed). Installing needs signing: free with your Apple ID through a sideloading tool (re-sign every 7 days) or $99/year for TestFlight/App Store; the website's Add to Home Screen works today.

- [x] Every app online (2026-10-16/17): the website is now Snake's Master Suite with every app, not only the Studio. Browser versions of SoundPad, Screen Recorder (with a GIF encoder in the kit), Converter (PDF writer, FLAC/Opus encoders), Compressor (.snake both ways with the desktop, and ZIP), Snake's Code, and the DAW (the desktop engine compiled to WebAssembly in an AudioWorklet: record, monitor, effects, loop station, tuner, export). The iPhone app is Snake's Master Suite too.
- [x] Fidelity and features (2026-10-17): Word comments and footnotes, .docx styles kept both ways; Spreadsheets reads and writes Excel charts, notes, conditional formats and validation, ~85 more functions and LAMBDA (`node test/functions.test.mjs`); Slides keeps PowerPoint looks (masters, layouts, themes) and real charts both ways; TIFF everywhere pictures open (and HEIC where the system decodes it); desktop Converter turns Word, spreadsheets and PowerPoint into PDF without LibreOffice; desktop Compressor opens ZIP, 7z, tar (.gz/.bz2/.xz/.zst) and makes ZIPs; Snake's Code talks to installed language servers (clangd, pyright/pylsp, rust-analyzer, gopls and ~20 more: completions, hover, problems, go to definition, references, rename, formatting, quick fixes, Ctrl+T symbols); Screen Recorder trims recordings; MP3 Converter saves M4A/Opus/FLAC/WAV and splits videos into tracks by chapter; SoundPad trims and loops sounds on a waveform
- [x] Build check (2026-10-17): every package built on Linux and started (CLIs, Qt apps offscreen, egui and Electron apps headless under gamescope), all 13 Android APKs, DAW and Compressor tests, Studio tests. Fixed on the way: the Studio build needed the repo's shared icons (now optional); Python packages built in a venv that saw the system's PySide6 missed libshiboken (build in a clean venv); SoundPad's Windows/macOS mode needs PySide6-Addons (Qt Multimedia), which it did not list; the DAW's effects panel cut off knobs; versions: every app changed since v1.1.6 but kept its version, so `--reuse` would have shipped old builds. Now suite 1.2.0, apps 1.1.0, hub 1.1.4, and `build.py` stops when an app's own version differs from suite.json
- [x] Snake's Terminal (2026-10-17, new): iTerm2-style terminal for Linux, Windows, macOS and Android. Desktop: Electron + xterm.js + node-pty (tabs, splits, profiles, 12 schemes and .itermcolors/Windows Terminal import, find, inline images, OSC 52 copy, broadcast, hotkey window, palette, restore). Devices panel: this computer's addresses and SSH status with a "turn it on" button (Linux/Windows/Mac), mDNS discovery (and it announces itself as `_snaketerm._tcp` while SSH is on), a port-22 network scan, Tailscale, saved hosts, ~/.ssh/config, one-click key login; SSH is the system's OpenSSH. Android: the same pages, Android's shell on the native pty, and `android/native/ssh` (snakessh, Rust + russh/ring) because phones have no ssh; NsdManager discovery, extra-keys row, a foreground service keeps sessions alive. Not built yet for iPhone (no shell; SSH would need a native client) or the website (browsers cannot open SSH connections): the site lists it as a download
- [x] Snake's Terminal menus (2026-10-20, from the idea inbox; shipped as 1.2.0): full menus (Shell, Edit, View, Session, Window, Help) behind a ☰ button (Ctrl+Shift+M) or as a menu bar, cascading submenus with arrow keys and letter jumps (`src/renderer/modules/menubar.js`, submenus in `ui.js`). Copy on select made visible (Edit → Selecting and copying), copies once the drag settles instead of on every mouse move, shows "Copied"; copy as one line, copy all output, save output as text (a save dialog in main), paste last selection, right-click = menu / paste / copy-or-paste (Shift+right-click always the menu), double-click word characters. Tested headless over CDP. Android falls back to the clipboard for "save output".
- [x] One Electron (v1.4.0, 2026-10-20): on the desktop Snake's Code and Snake's Terminal ship inside the Studio package (`"hosted"` in suite.json; `host_app()` in packaging/build.py copies their main process and pages to `hosted/<id>/`; Studio's `src/main/boot.js` starts them for `--app=code` / `--app=terminal` with their own name, window class, settings folder and lock). Linux: 3 packages of 381 MB became one of 123 MB. v1.4.1 fixed the index giving Code its Android APK's older version, which kept hubs from moving Code over. The nine apps share one version (ship.py raises them together). The hub moves a standalone Code/Terminal install into the shared package and deletes the old program (hub 1.1.6). Android keeps their own APKs (`studio_app` still means "in the Studio APK"). Studio's package now leaves Electron's file:// privileges on (the GrantFileProtocolExtraPrivileges fuse), because Code and Terminal load file:// pages as they always did; Studio's own pages are on snake://. Hardening left: move Code and Terminal to a custom protocol and turn the fuse off again
- [x] Projects/ shortcuts point at the Master Suite tools (they pointed at the old Snake's Suite)
- [x] Snapshot of all of Projects/ after the release: `../Projects Snapshot 2026-10-20` (read-only)

## Publishing the phone apps

- Android: `cd android && ./build.sh && python3 tools/release.py --publish` adds the APKs to the
  latest release and re-signs index.json with your index key (it stops if the key is missing);
  later desktop releases carry them over (`packaging/build.py android`).
- iOS: push to main (or run "iOS" from the Actions tab); the unsigned .ipa is attached to the run.

## Testing the Studio apps

- `node test/sheets.test.mjs` (in tools/Snake's Studio): spreadsheet engine tests.
- `npm run web` serves dist/ on http://localhost:5178 for the browser pane. With
  `SNAKE_TEST_DIR=<dir>` set, the page can `PUT /__save/<name>` to write test output.
- Desktop: `bin/snakes-studio --app=word --remote-debugging-port=9334 [file]`, then drive it
  over CDP (Runtime.evaluate on `window.snakeApp`). `SNAKE_TEST_PDF=<path>` makes PDF export
  write there without a dialog. Never `pkill -f` a pattern that appears in your own command.

## Where work stopped (2026-10-17)

Everything is built and tested locally on the `master-suite` branch: the Studio and its seven
apps, the overhaul of every tool, the hub, packaging with ffmpeg (a Linux Studio package was
built and played an AC3 MKV through its own ffmpeg), the signed index and the web mirror
workflow. v1.2.0 and v1.3.0 were released on 2026-10-17, v1.4.0 and v1.4.1 on 2026-10-20 (`main` = `master-suite`). Not yet done by hand: running the
packages on a real Windows PC or Mac (CI builds them, nobody has opened them there). Test helpers: `SNAKE_TEST_SAVEAS=<dir>` (Save As without a
dialog), `SNAKE_TEST_PDF=<path>`. Next releases: `python ship.py`.
