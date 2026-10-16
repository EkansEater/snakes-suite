#!/usr/bin/env bash
# QuickJS-ng for Android: the JavaScript runtime yt-dlp uses to solve YouTube's
# signatures (deno on the desktop). Built as an executable named libqjs.so so
# Android unpacks it where the app may run it.
#
#   native/quickjs/build.sh
#
# Output: apps/mp3/src/main/jniLibs/<abi>/libqjs.so
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
WORK="${SNAKE_NATIVE_WORK:-$HOME/.cache/snakes-suite-native}/quickjs"
NDK="${ANDROID_NDK_HOME:-$HOME/Android/Sdk/ndk/29.0.14206865}"
VERSION=0.16.2

mkdir -p "$WORK"
if [ ! -d "$WORK/src" ]; then
    curl -fsSL -o "$WORK/quickjs.tar.gz" "https://github.com/quickjs-ng/quickjs/archive/refs/tags/v$VERSION.tar.gz"
    mkdir -p "$WORK/src" && tar xzf "$WORK/quickjs.tar.gz" -C "$WORK/src" --strip-components=1
fi

for abi in arm64-v8a x86_64; do   # the MP3 Converter is 64-bit only (Python 3.14)
    b="$WORK/build/$abi"
    cmake -S "$WORK/src" -B "$b" -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_TOOLCHAIN_FILE="$NDK/build/cmake/android.toolchain.cmake" \
        -DANDROID_ABI="$abi" -DANDROID_PLATFORM=android-29 \
        -DQJS_BUILD_EXAMPLES=OFF -DBUILD_SHARED_LIBS=OFF >/dev/null
    cmake --build "$b" --target qjs_exe -j"$(nproc)" >/dev/null
    mkdir -p "$ROOT/apps/mp3/src/main/jniLibs/$abi"
    "$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-strip" -o "$ROOT/apps/mp3/src/main/jniLibs/$abi/libqjs.so" "$b/qjs"
    echo "$abi: $(du -h "$ROOT/apps/mp3/src/main/jniLibs/$abi/libqjs.so" | cut -f1)"
done
