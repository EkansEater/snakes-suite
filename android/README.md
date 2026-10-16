# Snake's Master Suite for Android

Every Snake app on Android, plus the Snake's Master Suite hub that installs,
opens and updates them, like the desktop hub does. This folder is part of the
Snake's Master Suite repository; it builds from the desktop apps' own sources.

| APK | What it is on Android | Built from |
|---|---|---|
| Snake's Master Suite | Hub: installs, opens, updates every app from the GitHub release (the list must carry the suite's signature) | Kotlin + Compose |
| Snake's Studio | One APK with seven launcher icons: Word, Spreadsheets, Slides, Paint, Photo, Player, Movie Maker | The desktop Studio's own pages (`tools/Snake's Studio/dist`, the same files as the website) in a WebView + a Kotlin bridge for files and printing |
| Snake's Code | The desktop editor's own renderer (Monaco, explorer, search, terminal, settings) in a WebView | `Snake's Code/dist` + a Kotlin bridge + a Rust pty |
| Snake's Compressor | Pack / unpack / test `.snake` archives, compatible both ways with the desktop | Rust engine (the desktop crate's format) via JNI |
| Snake's Converter | Audio, video, images, documents, spreadsheets, PDF | ffmpeg + Android APIs + Kotlin |
| Snake's Screen Recorder | Screen to MP4 / GIF, sound to MP3, with system sound and mic | MediaProjection + MediaCodec, ffmpeg |
| Snake's MP3 Converter | Share a video link, get a tagged MP3 | yt-dlp on Python (Chaquopy), QuickJS, ffmpeg |
| Snake's SoundPad | A grid of sound clips, one tap to play | Kotlin + Compose |
| Snake's DAW | Amp, effects, loop station, tuner, multitrack recording | The desktop DAW's own engine and controller (Rust, AAudio) + a Compose UI |

The Recompiler stays desktop only; the hub shows it as such.

Everywhere, two fingers zoom: in the Studio apps what is under them (the page, the
picture, the timeline), in the other apps the whole interface (remembered per app).

## What is different from the desktop

- **Studio apps** open and save through Android's file picker, and remember recent
  files. Player plays what Android itself can (no bundled ffmpeg); Movie Maker exports
  WebM. Printing goes to Android's print screen (which can save a PDF).

- **SoundPad** is a plain soundboard. Android does not let an app feed audio into
  another app's microphone (Discord, games) without root.
- **Snake's Code** asks for *All files access* so it can edit files where they are.
  Without it, it works in its own folder. Android has no git, so Source Control
  shows no repository; the terminal is Android's own `sh` (toybox).
  Deleting moves things to `.snakes-code-trash` on the phone's storage.
- **Converter**: presentations and the "with LibreOffice" formats are not there
  (no LibreOffice on Android). Documents use the built-in engine (headings,
  lists, bold/italic, tables, code). H.264 is OpenH264 (no CRF, quality is a
  bitrate). Reading text out of a PDF needs Android 15.
- **MP3 Converter** is 64-bit only (Chaquopy's Python 3.14). Cookies come from an
  exported `cookies.txt` instead of a browser.
- **DAW**: no JACK, LV2 or desktop-audio routing; audio is Android's AAudio.
  Projects live in the app's folder; exports are copied to Music/Snake's DAW.
- Everything needs Android 11 or newer.

Output goes where Android's own apps look: Music, Movies, Pictures or Download,
in a folder named after the tool.

## Building

```bash
./build.sh            # release APKs in dist/, plus dist/index-android.json
./build.sh debug      # debug APKs
./build.sh natives    # rebuild the native parts
```

`env.sh` points at the toolchain in `~/Android` (JDK 21, SDK, NDK r29). The first
build also needs Rust with the Android targets and `cargo-ndk`, `cmake`, and
Python 3.14 (Chaquopy builds the MP3 Converter's Python packages with it).

Versions come from `../suite.json`, so a tool's Android and desktop builds share their
number (Snake's Studio takes the newest of its seven apps). Snake's Code packs
`../tools/Snake's Code/dist` and Snake's Studio `../tools/Snake's Studio/dist`, so build
those first (`npm run build`, `node build.mjs`). The DAW and Compressor engines compile
the desktop tools' Rust sources in `../tools`.

### Signing

Release APKs are signed with the key named in `keystore.properties` (not in git):

```
storeFile=/home/you/.config/snakes-suite/android-release.jks
storePassword=...
keyAlias=snakes-suite
keyPassword=...
```

**Back up the keystore and its passwords.** Android only installs an update
signed with the same key, so a lost key means everyone has to uninstall first.

### Publishing

```bash
python3 tools/release.py --publish
```

adds the APKs to the latest GitHub release and its `index.json` (as `android` or
`android-<abi>` packages next to `linux-x86_64`), signs the changed index again with
your index key (`~/.config/snakes-suite/index-signing-key` or `SNAKE_INDEX_KEY`) and
uploads it with its `.sig`, so the same release serves both hubs. Later desktop
releases carry the APKs over by themselves (`packaging/build.py android`).
`--merge ../dist/index.json` does the same into a local desktop build instead.

## Layout

```
core/            Snake Dark theme, shared components, tool list, file helpers
media/           ffmpeg runner (the binary ships as libffmpeg.so)
apps/<tool>/     one Android app per tool; apps/suite is the hub, apps/studio the seven Studio apps
native/
  compressor/    Rust JNI bridge over the desktop Compressor's archive format
  daw/           the desktop DAW's sources compiled for Android + a JNI facade
  pty/           pseudo-terminals for Snake's Code
  ffmpeg/        build.sh: ffmpeg + LAME, Opus, Vorbis, OpenH264, libvpx (LGPL/BSD only)
  quickjs/       build.sh: QuickJS-ng, yt-dlp's JavaScript runtime
tools/
  make_icons.py  the suite's SVG icons as Android vector and adaptive icons
  release.py     dist/ and the release index entries
```

Native build work (ffmpeg, QuickJS) happens in `~/.cache/snakes-suite-native`,
because autoconf refuses paths with an apostrophe like this folder's.
