#!/bin/sh
# Build the DAW's browser engine into the Studio's sources (committed, so the website build
# needs no Rust): tools/Snake's Studio/src/apps/daw/daw.wasm
set -e
cd "$(dirname "$0")"
rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true
cargo build --release --target wasm32-unknown-unknown
mkdir -p "../../Snake's Studio/src/apps/daw"
cp target/wasm32-unknown-unknown/release/snakedaw_web.wasm "../../Snake's Studio/src/apps/daw/daw.wasm"
ls -la "../../Snake's Studio/src/apps/daw/daw.wasm"
