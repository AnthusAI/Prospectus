#!/usr/bin/env bash
set -euo pipefail
toolchain=1.98.1
export RUSTC="$(rustup which --toolchain "$toolchain" rustc)"
export RUSTDOC="$(rustup which --toolchain "$toolchain" rustdoc)"
export CARGO_TARGET_DIR="$PWD/.build/intake-control-target"
rustup run "$toolchain" cargo test --offline --locked --features aws --manifest-path local-dependencies/intake-control/Cargo.toml
