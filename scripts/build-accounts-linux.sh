#!/usr/bin/env bash
set -euo pipefail
[[ "$(uname -s)" == Linux ]] || { echo 'Accounts native package must be built on Linux.' >&2; exit 1; }
export PATH="$HOME/.cargo/bin:$PATH"
[[ "$(uname -m)" == x86_64 ]] || { echo 'Use the reviewed Linux x86_64 build image.' >&2; exit 1; }
toolchain=1.98.1
rustup toolchain install "$toolchain" --profile minimal
rustup target add x86_64-unknown-linux-musl --toolchain "$toolchain"
export RUSTC="$(rustup which --toolchain "$toolchain" rustc)"
export CARGO_TARGET_DIR="$PWD/.build/accounts-linux-target"
rustup run "$toolchain" cargo build --locked --jobs "${CARGO_BUILD_JOBS:-2}" --release --manifest-path local-dependencies/intake-control/Cargo.toml --features aws --target x86_64-unknown-linux-musl --bin prospectus-identity-files
install -m755 "$CARGO_TARGET_DIR/x86_64-unknown-linux-musl/release/prospectus-identity-files" .artifacts/canonical-accounts/identity-files
