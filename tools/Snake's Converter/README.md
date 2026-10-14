# Snake's Converter

A desktop file converter for Linux, Windows and macOS. Drop files in, pick a
format, press Convert. It also works from the command line.

## What it converts

| Type | Reads | Writes |
|------|-------|--------|
| Audio | MP3, WAV, FLAC, OGG, Opus, M4A, AAC, WMA, AIFF, AC3, AMR and more | WAV, MP3, FLAC, OGG, Opus, M4A, AAC, AIFF, WMA |
| Video | MP4, MKV, WebM, MOV, AVI, FLV, WMV, MPG, TS, 3GP and more | MP4, MKV, WebM, MOV, AVI, GIF, or any audio format (extracts the soundtrack) |
| Images | PNG, JPG, WebP, BMP, TIFF, GIF, ICO, AVIF, SVG, TGA, PSD, HEIC* | PNG, JPG, WebP, PDF, GIF, BMP, TIFF, ICO, AVIF |
| Documents | DOCX, RTF, TXT, Markdown, HTML (DOC, ODT with LibreOffice) | PDF, DOCX, ODT, TXT, HTML, Markdown (RTF with LibreOffice) |
| PDF | PDF | DOCX (text only), TXT, PNG, JPG (one image per page) |
| Spreadsheets | XLSX, CSV, TSV, JSON (XLS, ODS with LibreOffice) | XLSX, CSV, TSV, JSON (PDF, ODS with LibreOffice) |
| Presentations | PPTX, PPT, ODP (LibreOffice required) | PDF, PPTX, ODP |

\* HEIC needs the optional extra: `pip install ".[heic]"`.

### About LibreOffice

Everything in the table works out of the box except the entries marked
"with LibreOffice". If [LibreOffice](https://www.libreoffice.org) is installed,
Snake's Converter finds it automatically and uses it for Word, spreadsheet and
presentation files, which gives output that matches the original layout.

Without it, a built-in engine converts DOCX to PDF and the other document
formats. That engine keeps headings, lists, bold/italic, tables and images but
not page layout details such as headers, footers, columns or exact fonts. For
documents where the layout matters, install LibreOffice.

ffmpeg is bundled, so audio and video need nothing extra. A system ffmpeg is
used instead when one is on the PATH.

## Install and run

Requires Python 3.10 or newer.

```bash
python -m venv .venv
```

Activate it (`source .venv/bin/activate`, on fish `source .venv/bin/activate.fish`,
on Windows `.venv\Scripts\activate`), then:

```bash
pip install .
```

```bash
snakes-converter
```

## Command line

Running with arguments skips the window:

```bash
snakes-converter song.mp3 -t wav
snakes-converter *.docx -t pdf -o converted/
snakes-converter movie.mkv -t mp4 --video-quality high
snakes-converter scan.pdf -t png --dpi 300
snakes-converter --formats report.docx     # what can this file become?
snakes-converter --doctor                  # which helper programs were found?
```

Existing files are never overwritten unless you pass `--overwrite`; a number is
added to the name instead.

## Standalone app (no Python needed)

```bash
pip install ".[build]"
```

```bash
python scripts/build.py
```

This writes a single executable to `dist/` (`Snake's Converter` on Linux,
`Snake's Converter.exe` on Windows, `Snake's Converter.app` on macOS) with
ffmpeg included. The build has to run on the system it targets; the workflow in
`.github/workflows/build.yml` builds all three on GitHub when you push a `v*` tag.

## Layout

```
snakes_converter/
  converters/   one module per file family, plus the registry in __init__.py
  gui/          the Qt window
  cli.py        command line
  tools.py      finds ffmpeg and LibreOffice
```
