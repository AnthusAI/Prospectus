#!/usr/bin/env bash
set -euo pipefail
toolchain=1.98.1
export RUSTC="$(rustup which --toolchain "$toolchain" rustc)"
export RUSTDOC="$(rustup which --toolchain "$toolchain" rustdoc)"
export CARGO_TARGET_DIR="$PWD/.build/intake-control-target"
features=()
if [[ "${PROSPECTUS_BUILD_IDENTITY_S3:-}" == "true" ]]; then features=(--features aws); fi
rustup run "$toolchain" cargo build --offline --locked --manifest-path local-dependencies/intake-control/Cargo.toml --bin prospectus-identity-files "${features[@]}"
