#!/usr/bin/env bash
# Actual SDK to synthetic loopback only. No AWS provider or cloud mutation.
set -euo pipefail
toolchain=1.98.1
export RUSTC="$(rustup which --toolchain "$toolchain" rustc)"
export RUSTDOC="$(rustup which --toolchain "$toolchain" rustdoc)"
export CARGO_TARGET_DIR="$PWD/.build/intake-control-target"
rustup run "$toolchain" cargo test --offline --locked --manifest-path local-dependencies/intake-control/Cargo.toml --features aws --bin prospectus-identity-files --test identity_config
