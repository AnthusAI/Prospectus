#!/usr/bin/env bash
set -euo pipefail
test "$(uname -s)" = Linux || { echo 'Package the evaluation bridge on the existing Linux build pipeline.' >&2; exit 1; }
node scripts/build-evaluation.mjs
intake_toolchain=$(node -e 'const fs=require("fs");const m=fs.readFileSync("local-dependencies/intake-control/rust-toolchain.toml","utf8").match(/channel\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"/);if(!m)throw Error("Exact intake Rust toolchain required");process.stdout.write(m[1]);')
rustup toolchain install "$intake_toolchain" --profile minimal
rustup target add x86_64-unknown-linux-musl --toolchain "$intake_toolchain"
export CARGO_TARGET_DIR="$PWD/.build/target"
cargo "+$intake_toolchain" build --locked --release --target x86_64-unknown-linux-musl --features aws --manifest-path local-dependencies/intake-control/Cargo.toml --bin prospectus-s3-controls
install -m 755 .build/intake-control-target/x86_64-unknown-linux-musl/release/prospectus-s3-controls .artifacts/intake-evaluation/prospectus-s3-controls
