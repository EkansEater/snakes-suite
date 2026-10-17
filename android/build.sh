#!/usr/bin/env bash
# Build every Snake's Master Suite APK: native parts (once), then all apps, then dist/.
#
#   ./build.sh            release APKs into dist/ with dist/index-android.json
#   ./build.sh debug      debug APKs only (no signing key needed)
#   ./build.sh natives    rebuild the native parts (ffmpeg takes a while)
set -euo pipefail
cd "$(dirname "$0")"
source ./env.sh

ABIS=(-t arm64-v8a -t armeabi-v7a -t x86_64)

natives() {
    echo "== Rust: Compressor engine, DAW engine, terminal pty"
    (cd native/compressor && cargo ndk "${ABIS[@]}" -P 29 -o ../../apps/compressor/src/main/jniLibs build --release)
    (cd native/daw && cargo ndk "${ABIS[@]}" -P 29 -o ../../apps/daw/src/main/jniLibs build --release)
    (cd native/pty && cargo ndk "${ABIS[@]}" -P 29 -o ../../apps/code/src/main/jniLibs build --release)
    echo "== Rust: Snake's Terminal (its pty, and snakessh: phones have no ssh program)"
    (cd native/pty && cargo ndk "${ABIS[@]}" -P 29 -o ../../apps/terminal/src/main/jniLibs build --release)
    (cd native/ssh && cargo ndk "${ABIS[@]}" -P 30 build --release)
    # A program in jniLibs, named like a library, is unpacked where Android lets it run.
    for pair in arm64-v8a:aarch64-linux-android armeabi-v7a:armv7-linux-androideabi x86_64:x86_64-linux-android; do
        abi=${pair%%:*}; triple=${pair#*:}
        mkdir -p "apps/terminal/src/main/jniLibs/$abi"
        cp "native/ssh/target/$triple/release/snakessh" "apps/terminal/src/main/jniLibs/$abi/libsnakessh.so"
    done
    echo "== QuickJS (MP3 Converter)"
    native/quickjs/build.sh
    echo "== ffmpeg (Converter, Screen Recorder, MP3 Converter)"
    native/ffmpeg/build.sh
}

missing_natives() {
    for f in apps/compressor/src/main/jniLibs/arm64-v8a/libsnake_android.so \
             apps/daw/src/main/jniLibs/arm64-v8a/libsnakedaw_android.so \
             apps/code/src/main/jniLibs/arm64-v8a/libsnakepty.so \
             apps/terminal/src/main/jniLibs/arm64-v8a/libsnakepty.so \
             apps/terminal/src/main/jniLibs/arm64-v8a/libsnakessh.so \
             apps/mp3/src/main/jniLibs/arm64-v8a/libqjs.so \
             media/src/main/jniLibs/arm64-v8a/libffmpeg.so; do
        [ -f "$f" ] || return 0
    done
    return 1
}

case "${1:-release}" in
    natives) natives ;;
    debug)
        missing_natives && natives
        ./gradlew assembleDebug
        find apps -path '*outputs/apk/debug/*.apk' ;;
    release)
        missing_natives && natives
        [ -f keystore.properties ] || echo "note: no keystore.properties, release APKs get the debug key"
        ./gradlew assembleRelease
        python3 tools/release.py ;;
    *) echo "usage: $0 [release|debug|natives]"; exit 1 ;;
esac
