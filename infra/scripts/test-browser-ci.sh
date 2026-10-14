#!/usr/bin/env bash
set -euo pipefail
set +x
# CI proof uses only a disposable ordinary Kanbus folder and loopback credentials.
node infra/scripts/checkout-kanbus.mjs
toolchain_file=.build/kanbus/services/kanbus-api/rust-toolchain.toml
test -f "$toolchain_file" || { echo 'The pinned API must declare its exact Rust toolchain.' >&2; exit 1; }
rust_toolchain=$(node -e 'const fs=require("fs");const m=fs.readFileSync(process.argv[1],"utf8").match(/channel\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"/);if(!m)throw Error("An exact numeric API Rust toolchain is required");process.stdout.write(m[1]);' "$toolchain_file")
rustup toolchain install "$rust_toolchain" --profile minimal
export CARGO_TARGET_DIR="$PWD/.build/target"
cargo "+$rust_toolchain" build --locked --release --manifest-path .build/kanbus/services/kanbus-api/Cargo.toml --bin kanbus-api-local
npm exec -- playwright install --with-deps chromium
proof_fixture=$(mktemp -d "${TMPDIR:-/tmp}/prospectus-e2e.XXXXXX")
proof_api_pid=''
cleanup() {
  if [ -n "$proof_api_pid" ]; then
    kill "$proof_api_pid" >/dev/null 2>&1 || true
    wait "$proof_api_pid" >/dev/null 2>&1 || true
  fi
  unset PROSPECTUS_TEST_TOKEN KANBUS_LOCAL_TOKEN
  rm -rf "$proof_fixture"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$proof_fixture/kanbus/project/issues" "$proof_fixture/kanbus/project/events"
cp config/prospectus.kanbus.yml "$proof_fixture/kanbus/.kanbus.yml"
proof_token=$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')
export KANBUS_BACKEND=file KANBUS_ROOT="$proof_fixture/kanbus" KANBUS_NAMESPACE=cyclotron/prospectus KANBUS_PORT=5418
export KANBUS_LOCAL_TOKEN="$proof_token" PROSPECTUS_TEST_TOKEN="$proof_token"
export VITE_KANBUS_API_URL='' CI=1
unset VITE_COGNITO_CLIENT_ID VITE_COGNITO_DOMAIN_URL VITE_COGNITO_REDIRECT_URI VITE_COGNITO_LOGOUT_URI
.build/target/release/kanbus-api-local >"$proof_fixture/api.log" 2>&1 &
proof_api_pid=$!
proof_ready=false
for attempt in $(seq 1 120); do
  kill -0 "$proof_api_pid" 2>/dev/null || { echo 'The owned loopback API failed to start.' >&2; exit 1; }
  proof_status=$(curl --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1:5418/api/issues || true)
  if [ "$proof_status" = 401 ]; then proof_ready=true; break; fi
  sleep 0.25
done
[ "$proof_ready" = true ] || { echo 'The owned loopback API was not ready.' >&2; exit 1; }
# Disable traces and HTML reports so authorization headers and form input never
# become published test artifacts. Fixture/log/output directories are removed.
if npm run test:e2e -- --trace=off --reporter=line --output="$proof_fixture/playwright" >"$proof_fixture/playwright.log" 2>&1; then
  proof_result=0
else
  proof_result=$?
fi
# Even action failure diagnostics are redacted before reaching CI output.
node -e 'const fs=require("fs");process.stdout.write(fs.readFileSync(process.argv[1],"utf8").split(process.env.PROSPECTUS_TEST_TOKEN).join("[redacted]"));' "$proof_fixture/playwright.log"
exit "$proof_result"
