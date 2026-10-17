#!/bin/sh
# Build the browser engine into the Studio's sources (committed, so the website build
# needs no Rust): tools/Snake's Studio/src/apps/compressor/snake.wasm
set -e
cd "$(dirname "$0")"
rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true
cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/snake_wasm.wasm "../../Snake's Studio/src/apps/compressor/snake.wasm"
ls -la "../../Snake's Studio/src/apps/compressor/snake.wasm"
