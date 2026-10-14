#!/usr/bin/env bash
set -euo pipefail

# Runs only on Linux builders. Source revisions are validated before compilation.
test "$(uname -s)" = Linux || { echo 'Build Lambda on the Linux package workflow or reviewed Amplify Debian build image.' >&2; exit 1; }
node infra/scripts/checkout-kanbus.mjs
if command -v apt-get >/dev/null 2>&1; then
  if [ "$(id -u)" = 0 ]; then
    apt-get update -qq
    apt-get install -y --no-install-recommends musl-tools cmake make perl pkg-config zip ca-certificates curl
  else
    sudo apt-get update -qq
    sudo apt-get install -y --no-install-recommends musl-tools cmake make perl pkg-config zip ca-certificates curl
  fi
elif ! command -v musl-gcc >/dev/null 2>&1; then
  echo 'This Linux image must provide musl-gcc; use the reviewed pinned Debian Node build image.' >&2
  exit 1
fi
if ! command -v rustup >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain none
fi
export PATH="$HOME/.cargo/bin:$PATH"
toolchain_file=.build/kanbus/services/kanbus-api/rust-toolchain.toml
test -f "$toolchain_file" || { echo "Pinned Kanbus API source must include services/kanbus-api/rust-toolchain.toml" >&2; exit 1; }
rust_toolchain=$(node -e 'const fs=require("fs"); const match=fs.readFileSync(process.argv[1],"utf8").match(/channel\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"/); if(!match) throw Error("The pinned Kanbus source must declare an exact Rust toolchain"); process.stdout.write(match[1]);' "$toolchain_file")
rustup toolchain install "$rust_toolchain" --profile minimal
rustup target add x86_64-unknown-linux-musl --toolchain "$rust_toolchain"
export CARGO_TARGET_DIR="$PWD/.build/target"
cargo "+$rust_toolchain" build --locked --release --target x86_64-unknown-linux-musl \
  --manifest-path .build/kanbus/services/kanbus-api/Cargo.toml --bin kanbus-api-lambda --features aws
mkdir -p .artifacts/backend
install -m 755 .build/target/x86_64-unknown-linux-musl/release/kanbus-api-lambda .artifacts/backend/bootstrap
(cd .artifacts/backend && zip -X bootstrap.zip bootstrap && sha256sum bootstrap.zip > bootstrap.zip.sha256)
node -e 'const fs=require("fs"); const {execFileSync}=require("child_process"); const sources=JSON.parse(fs.readFileSync("source-lock.json","utf8")); const revision=process.env.CODEBUILD_RESOLVED_SOURCE_VERSION || process.env.GITHUB_SHA || execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(); if(!/^[a-f0-9]{40}$/.test(revision)) throw Error("Prospectus source revision must be a full commit SHA"); fs.writeFileSync(".artifacts/backend/provenance.json",JSON.stringify({sources,rust:process.argv[1],target:"x86_64-unknown-linux-musl",prospectus:revision},null,2)+"\n");' "$rust_toolchain"
