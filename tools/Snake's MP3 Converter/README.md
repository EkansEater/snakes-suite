# Snake's MP3 Converter

(Formerly Snake's Sounds.) Part of Snake's Suite.

Drag a video link in, get an MP3 out.

## Run

```
./snakes-mp3
```

To install it as an app (menu entry, `snakes-mp3` command) on Linux, Windows or macOS, use the
Snake's Suite installer: `python install.py mp3`. On Linux, `./install.sh` still adds a menu entry
that runs it from this folder.

You can also pass links on the command line: `./snakes-mp3 https://youtu.be/...`

## Features

- **Drag & drop** links from your browser (address bar, a link on a page, or a tab) anywhere onto the window
- Paste with **Ctrl+V**, click the drop zone to grab the clipboard, or type a link and press Enter
- Works with YouTube, SoundCloud, Bandcamp, Vimeo, TikTok and [1000+ other sites](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md)
- Quality: 320 / 256 / 192 / 128 kbps CBR, or VBR V0
- **Formats**: MP3 (plays everywhere), M4A (AAC) and Opus (smaller at the same quality), FLAC and WAV (lossless)
- **Split by chapters**: a video with chapters (an album, a DJ mix, a podcast) becomes one track per chapter, numbered and tagged as an album (title, album, artist, track number, cover art) in a folder named after the video
- Embeds the video thumbnail as **album art** and writes title / artist / date tags
- **Playlists**: tick "Whole playlist" to grab every track, saved into a numbered subfolder
- Queue with live progress, speed and ETA; several downloads at once (configurable)
- Cancel (cleans up partial files), retry, play, show in file manager
- **Drag a finished card** out of the window to drop the MP3 into another app
- Skips files you've already converted
- Optional browser cookies for age-restricted / members-only videos
- Desktop notification when the queue is finished

Files are saved to `~/Music/Snake's MP3 Converter` by default (or `~/Music/Snake's Sounds` if that
folder already exists from before the rename) (change it with the "Save to" button).

## Requirements

Python 3.10+, PySide6, yt-dlp, ffmpeg, and deno (yt-dlp uses it for YouTube). The Snake's Suite
installer fetches the Python parts; if ffmpeg is not installed, the copy bundled with
imageio-ffmpeg is used. On Arch/CachyOS, to run from this folder:

```
sudo pacman -S pyside6 yt-dlp ffmpeg deno
```

If YouTube downloads start failing, update yt-dlp first — sites change often.
