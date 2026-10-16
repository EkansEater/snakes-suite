#!/usr/bin/env bash
# Builds the ffmpeg and ffprobe that ship inside Snake's Studio (Linux and macOS),
# from pinned sources only: every tarball is checked against its SHA-256 and every
# git checkout against its commit. Windows takes a ready build instead (build.py).
#
#   packaging/ffmpeg/build.sh <out-dir>
#
# Needs a C compiler, make, nasm (on x86_64), meson, ninja, pkg-config, git and curl.
# Takes about ten minutes; the release workflow caches the result.
#
# What is in it: everything Player and Movie Maker use (H.264/x264, VP9/libvpx,
# Opus, MP3/LAME, AV1 decoding/dav1d and FFmpeg's own codecs), and nothing that
# talks to the network: only the file and pipe protocols are built, so a crafted
# media file cannot make ffmpeg fetch or send anything. Licence: GPL v3 (the
# FFmpeg configure flags --enable-gpl --enable-version3); see the README.txt it writes.
set -euo pipefail

FFMPEG_VERSION=9.0.2
FFMPEG_URL=https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz
FFMPEG_SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
X264_GIT=https://code.videolan.org/videolan/x264.git
X264_COMMIT=b35605ace3ddf7c1a5d67a2eb553f034aef41d55        # the stable branch, 2025-06-08
VPX_GIT=https://chromium.googlesource.com/webm/libvpx
VPX_COMMIT=6df3ec34557879fff673706f4a1d9fbd0f3a6f0e         # v1.17.0
OPUS_URL=https://downloads.xiph.org/releases/opus/opus-1.6.1.tar.gz
OPUS_SHA256=6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1
LAME_URL=https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz
LAME_SHA256=ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e
DAV1D_URL=https://downloads.videolan.org/pub/videolan/dav1d/1.5.4/dav1d-1.5.4.tar.xz
DAV1D_SHA256=686616b7c69eb88d44459391ab25cac13b6647a3b288835c5784e71c1514a5c5

[ $# -eq 1 ] || { echo "usage: $0 <out-dir>" >&2; exit 2; }
mkdir -p "$1"
OUT=$(cd "$1" && pwd)
WORK=${SNAKE_FFMPEG_WORK:-$(mktemp -d)}
mkdir -p "$WORK"
WORK=$(cd "$WORK" && pwd)
P=$WORK/prefix
mkdir -p "$P"
OS=$(uname -s)
JOBS=$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu)
if [ "$OS" = Darwin ]; then
  export MACOSX_DEPLOYMENT_TARGET=12.0   # Electron's own minimum
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
fi
# Only our own libraries: nothing from Homebrew or the system's pkg-config folders.
export PKG_CONFIG_LIBDIR=$P/lib/pkgconfig
export PKG_CONFIG_PATH=
export CFLAGS="-O2 -fPIC" CXXFLAGS="-O2 -fPIC"

say() { printf '\n=== %s\n' "$*"; }

fetch() { # url sha256 -> unpacks into $WORK/src/<name> and prints that folder
  local url=$1 want=$2 file
  file=$WORK/dl/$(basename "$url")
  mkdir -p "$WORK/dl" "$WORK/src"
  [ -f "$file" ] || curl -fsSL --retry 3 --retry-delay 5 -o "$file" "$url"
  local got
  got=$(sha256 "$file")
  if [ "$got" != "$want" ]; then
    echo "$(basename "$url"): checksum $got, expected $want" >&2
    rm -f "$file"
    exit 1
  fi
  local dir=$WORK/src/$(basename "$url" | sed -E 's/\.tar\.(gz|xz|bz2)$//')
  rm -rf "$dir"
  tar -xf "$file" -C "$WORK/src"
  echo "$dir"
}

checkout() { # git-url commit name -> prints the folder
  local url=$1 commit=$2 dir=$WORK/src/$3
  rm -rf "$dir"
  mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" fetch -q --depth 1 "$url" "$commit"
  git -C "$dir" -c advice.detachedHead=false checkout -q FETCH_HEAD
  [ "$(git -C "$dir" rev-parse HEAD)" = "$commit" ] || { echo "$3: not at $commit" >&2; exit 1; }
  echo "$dir"
}

say x264
src=$(checkout "$X264_GIT" "$X264_COMMIT" x264)
(cd "$src" && ./configure --prefix="$P" --enable-static --enable-pic --disable-cli --disable-opencl \
  && make -j"$JOBS" && make install-lib-static)

say libvpx
src=$(checkout "$VPX_GIT" "$VPX_COMMIT" libvpx)
vpx_target=()
if [ "$OS" = Darwin ] && [ "$(uname -m)" = arm64 ]; then vpx_target=(--target=arm64-darwin24-gcc); fi
(cd "$src" && ./configure --prefix="$P" ${vpx_target[@]+"${vpx_target[@]}"} --enable-pic --enable-vp9-highbitdepth \
  --disable-examples --disable-tools --disable-docs --disable-unit-tests \
  && make -j"$JOBS" && make install)

say opus
src=$(fetch "$OPUS_URL" "$OPUS_SHA256")
(cd "$src" && ./configure --prefix="$P" --disable-shared --enable-static --with-pic \
  --disable-doc --disable-extra-programs && make -j"$JOBS" && make install)

say lame
src=$(fetch "$LAME_URL" "$LAME_SHA256")
(cd "$src" && ./configure --prefix="$P" --disable-shared --enable-static --with-pic \
  --disable-frontend --disable-decoder --disable-gtktest && make -j"$JOBS" && make install)

say dav1d
src=$(fetch "$DAV1D_URL" "$DAV1D_SHA256")
(cd "$src" && meson setup build --prefix="$P" --libdir=lib --default-library=static --buildtype=release \
  -Denable_tools=false -Denable_tests=false && ninja -C build && ninja -C build install)

say ffmpeg
src=$(fetch "$FFMPEG_URL" "$FFMPEG_SHA256")
platform=()
if [ "$OS" = Darwin ]; then platform=(--enable-videotoolbox --enable-audiotoolbox); fi
CONFIGURE=(--prefix="$P" --pkg-config-flags=--static --extra-cflags="-I$P/include" --extra-ldflags="-L$P/lib"
  --extra-version=snake --enable-gpl --enable-version3 --disable-autodetect --disable-debug
  --disable-doc --disable-ffplay --disable-network --disable-protocols --enable-protocol=file,pipe
  --enable-zlib --enable-iconv ${platform[@]+"${platform[@]}"}
  --enable-libx264 --enable-libvpx --enable-libopus --enable-libmp3lame --enable-libdav1d)
(cd "$src" && ./configure "${CONFIGURE[@]}" && make -j"$JOBS")

# The two programs, and nothing they load from outside the system.
cp "$src/ffmpeg" "$src/ffprobe" "$OUT/"
if [ "$OS" = Darwin ]; then
  if otool -L "$OUT/ffmpeg" "$OUT/ffprobe" | grep -E '/opt/homebrew|/usr/local|'"$WORK"; then
    echo "ffmpeg links a library that is not part of macOS" >&2; exit 1
  fi
else
  if ldd "$OUT/ffmpeg" "$OUT/ffprobe" | grep -E 'not found|/usr/local|'"$WORK"; then
    echo "ffmpeg links a library that is not part of the system" >&2; exit 1
  fi
fi
encoders=$("$OUT/ffmpeg" -hide_banner -encoders)
for enc in libx264 libvpx-vp9 libopus libmp3lame; do
  grep -q " $enc " <<<"$encoders" || { echo "ffmpeg has no $enc encoder" >&2; exit 1; }
done

cp "$src/COPYING.GPLv3" "$OUT/LICENSE.txt"
cat > "$OUT/README.txt" <<EOF
ffmpeg and ffprobe in this folder are FFmpeg $FFMPEG_VERSION, built for Snake's Studio
by packaging/ffmpeg/build.sh in https://github.com/EkansEater/snakes-suite
(the script fetches and checks every source below and holds the exact build steps).

Licence: GNU General Public License version 3 (LICENSE.txt). You may copy, change and
share these programs under its terms. Corresponding source:
  FFmpeg   $FFMPEG_URL
           (sha256 $FFMPEG_SHA256)
  x264     $X264_GIT, commit $X264_COMMIT
  libvpx   $VPX_GIT, commit $VPX_COMMIT
  Opus     $OPUS_URL
  LAME     $LAME_URL
  dav1d    $DAV1D_URL

FFmpeg configuration:
 $(printf ' %s' "${CONFIGURE[@]}" | sed -E 's/ --(prefix|extra-cflags|extra-ldflags)=[^ ]*//g')
EOF
say "done: $OUT"
