#!/usr/bin/env bash
# Build a small ffmpeg executable for Android, shared by Converter, MP3 Converter
# and Screen Recorder. Only LGPL/BSD parts, so the result stays LGPL:
#   LAME (MP3), Opus, Vorbis, OpenH264 (H.264), libvpx (VP8/VP9 for WebM)
# plus everything built into ffmpeg (AAC, FLAC, ALAC, GIF, PNG, WMA, AC3...).
#
#   native/ffmpeg/build.sh            # every ABI
#   native/ffmpeg/build.sh arm64-v8a  # just one
#
# Output: media/src/main/jniLibs/<abi>/libffmpeg.so (an executable named like a
# library, so Android unpacks it into nativeLibraryDir where it may run).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# Autoconf refuses paths with an apostrophe (like "Snake's Suite APK"), so sources and
# builds live in a plain folder outside the project. Only the finished binary comes back.
WORK="${SNAKE_NATIVE_WORK:-$HOME/.cache/snakes-suite-native}/ffmpeg"
SRC="$WORK/src"
OUT="$WORK/out"
JNI="$ROOT/media/src/main/jniLibs"
API=29
NDK="${ANDROID_NDK_HOME:-$HOME/Android/Sdk/ndk/29.0.14206865}"
TC="$NDK/toolchains/llvm/prebuilt/linux-x86_64"
JOBS="$(nproc)"

FFMPEG=9.0.2
LAME=3.100
OPUS=1.6.1
OGG=1.3.6
VORBIS=1.3.7
OPENH264=2.6.0
VPX=1.17.0

fetch() { # url dir
    local url=$1 dir=$2
    [ -d "$SRC/$dir" ] && return
    mkdir -p "$SRC/dl"
    local file="$SRC/dl/$(basename "$url")"
    [ -f "$file" ] || curl -fsSL --retry 3 -o "$file" "$url"
    mkdir -p "$SRC/$dir"
    tar xf "$file" -C "$SRC/$dir" --strip-components=1
}

fetch "https://ffmpeg.org/releases/ffmpeg-$FFMPEG.tar.xz" ffmpeg
fetch "https://downloads.sourceforge.net/project/lame/lame/$LAME/lame-$LAME.tar.gz" lame
fetch "https://downloads.xiph.org/releases/opus/opus-$OPUS.tar.gz" opus
fetch "https://downloads.xiph.org/releases/ogg/libogg-$OGG.tar.xz" ogg
fetch "https://downloads.xiph.org/releases/vorbis/libvorbis-$VORBIS.tar.xz" vorbis
fetch "https://github.com/cisco/openh264/archive/refs/tags/v$OPENH264.tar.gz" openh264
fetch "https://github.com/webmproject/libvpx/archive/refs/tags/v$VPX.tar.gz" vpx

build_abi() {
    local abi=$1 triple clang_triple ff_arch ff_cpu vpx_target h264_arch extra_ff=()
    case $abi in
        arm64-v8a)   triple=aarch64-linux-android;   clang_triple=aarch64-linux-android;     ff_arch=aarch64; ff_cpu=armv8-a; vpx_target=arm64-android-gcc;  h264_arch=arm64 ;;
        armeabi-v7a) triple=arm-linux-androideabi;   clang_triple=armv7a-linux-androideabi;  ff_arch=arm;     ff_cpu=armv7-a; vpx_target=armv7-android-gcc;  h264_arch=arm
                     extra_ff=(--enable-neon) ;;
        x86_64)      triple=x86_64-linux-android;    clang_triple=x86_64-linux-android;      ff_arch=x86_64;  ff_cpu=x86-64;  vpx_target=generic-gnu; h264_arch=x86_64
                     extra_ff=(--disable-x86asm) ;;
        *) echo "unknown ABI $abi"; exit 1 ;;
    esac
    local P="$OUT/$abi" B="$OUT/build/$abi"
    mkdir -p "$P" "$B"
    export CC="$TC/bin/${clang_triple}${API}-clang" CXX="$TC/bin/${clang_triple}${API}-clang++"
    export AR="$TC/bin/llvm-ar" RANLIB="$TC/bin/llvm-ranlib" STRIP="$TC/bin/llvm-strip" NM="$TC/bin/llvm-nm"
    export CFLAGS="-O3 -fPIC" CXXFLAGS="-O3 -fPIC" LDFLAGS=""
    export PKG_CONFIG_LIBDIR="$P/lib/pkgconfig" PKG_CONFIG_PATH=""
    local host=(--host="$triple" --prefix="$P" --enable-static --disable-shared)

    echo "=== $abi: lame"
    if [ ! -f "$P/lib/libmp3lame.a" ]; then
        rm -rf "$B/lame" && cp -a "$SRC/lame" "$B/lame" && cd "$B/lame"
        # lame 3.100 lists a symbol that no longer exists.
        sed -i '/lame_init_old/d' include/libmp3lame.sym
        ./configure "${host[@]}" --disable-frontend --disable-decoder --with-pic >/dev/null
        make -j"$JOBS" >/dev/null && make install >/dev/null
    fi

    echo "=== $abi: opus"
    if [ ! -f "$P/lib/libopus.a" ]; then
        rm -rf "$B/opus" && cp -a "$SRC/opus" "$B/opus" && cd "$B/opus"
        ./configure "${host[@]}" --disable-doc --disable-extra-programs --with-pic >/dev/null
        make -j"$JOBS" >/dev/null && make install >/dev/null
    fi

    echo "=== $abi: ogg + vorbis"
    if [ ! -f "$P/lib/libvorbisenc.a" ]; then
        rm -rf "$B/ogg" && cp -a "$SRC/ogg" "$B/ogg" && cd "$B/ogg"
        ./configure "${host[@]}" --with-pic >/dev/null
        make -j"$JOBS" >/dev/null && make install >/dev/null
        rm -rf "$B/vorbis" && cp -a "$SRC/vorbis" "$B/vorbis" && cd "$B/vorbis"
        ./configure "${host[@]}" --with-pic --with-ogg="$P" --disable-docs --disable-examples >/dev/null
        make -j"$JOBS" >/dev/null && make install >/dev/null
    fi

    echo "=== $abi: openh264"
    if [ ! -f "$P/lib/libopenh264.a" ]; then
        rm -rf "$B/openh264" && cp -a "$SRC/openh264" "$B/openh264" && cd "$B/openh264"
        local asm=()
        [ "$abi" = x86_64 ] && asm=(USE_ASM=No)
        make -j"$JOBS" OS=android ARCH="$h264_arch" NDKROOT="$NDK" TARGET="android-$API" NDKLEVEL="$API" \
            CC="$CC" CXX="$CXX" AR="$AR" PREFIX="$P" "${asm[@]}" install-static >/dev/null
    fi

    echo "=== $abi: libvpx"
    if [ ! -f "$P/lib/libvpx.a" ]; then
        rm -rf "$B/vpx" && mkdir -p "$B/vpx" && cd "$B/vpx"
        # x86_64 (emulators only) is built as plain C: its assembly needs nasm.
        local vpx_asm=()
        CROSS="$TC/bin/llvm-" LD="$CC" AS="$CC" "$SRC/vpx/configure" --target="$vpx_target" --prefix="$P" \
            --disable-examples --disable-tools --disable-docs --disable-unit-tests --enable-pic \
            --enable-vp8 --enable-vp9 --disable-shared --enable-static "${vpx_asm[@]}" >/dev/null
        make -j"$JOBS" >/dev/null && make install >/dev/null
    fi

    echo "=== $abi: ffmpeg"
    rm -rf "$B/ffmpeg" && mkdir -p "$B/ffmpeg" && cd "$B/ffmpeg"
    "$SRC/ffmpeg/configure" \
        --prefix="$P" --target-os=android --arch="$ff_arch" --cpu="$ff_cpu" --enable-cross-compile \
        --cc="$CC" --cxx="$CXX" --ar="$AR" --ranlib="$RANLIB" --strip="$STRIP" --nm="$NM" \
        --pkg-config=pkg-config --pkg-config-flags=--static \
        --extra-cflags="-I$P/include -O3 -fPIC" \
        --extra-ldflags="-L$P/lib -static-libstdc++" --extra-libs="-lm -lc++_static -lc++abi" \
        --enable-static --disable-shared --enable-pic \
        --disable-doc --disable-debug --disable-ffplay --disable-ffprobe --disable-network \
        --disable-autodetect --enable-zlib \
        --enable-libmp3lame --enable-libopus --enable-libvorbis --enable-libopenh264 --enable-libvpx \
        "${extra_ff[@]}" >/dev/null
    make -j"$JOBS" ffmpeg >/dev/null
    "$STRIP" -o "$P/ffmpeg" ffmpeg
    mkdir -p "$JNI/$abi"
    cp "$P/ffmpeg" "$JNI/$abi/libffmpeg.so"
    echo "=== $abi: done ($(du -h "$JNI/$abi/libffmpeg.so" | cut -f1))"
}

ABIS=("$@")
[ ${#ABIS[@]} -eq 0 ] && ABIS=(arm64-v8a armeabi-v7a x86_64)
for abi in "${ABIS[@]}"; do build_abi "$abi"; done
