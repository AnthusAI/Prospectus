import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("../scripts/write-quota-rate-table.sh", import.meta.url).pathname;
const example = new URL("../scripts/quota-rate-table.example.json", import.meta.url).pathname;
const SIGNED_IN = "111111111111";
const validTable = JSON.stringify({
  version: "synthetic-v1",
  defaultPlan: "synthetic",
  plans: { synthetic: { weeklyAllowanceUnits: 1234 } },
  rates: { "example.tokens": { units: 7, per: 1000 } },
});

function run(args: string[], table: string | undefined = validTable) {
  const dir = mkdtempSync(join(tmpdir(), "rate-table-script-"));
  const log = join(dir, "aws.log");
  writeFileSync(
    join(dir, "aws"),
    `#!/usr/bin/env bash\necho "$*" >> "${log}"\n` +
      `case "$1 $2" in\n"sts get-caller-identity") echo ${SIGNED_IN} ;;\n"ssm put-parameter") echo 7 ;;\nesac\n`,
  );
  chmodSync(join(dir, "aws"), 0o755);
  const values = join(dir, "values.json");
  if (table !== undefined) writeFileSync(values, table);
  const result = spawnSync("bash", [script, ...args.map((arg) => (arg === "VALUES" ? values : arg))], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
  return { result, calls };
}

test("a valid table is written to the one parameter and only the version is printed", () => {
  const { result, calls } = run(["--account", SIGNED_IN, "--values", "VALUES"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "7\n");
  assert.match(
    calls,
    /ssm put-parameter --name \/prospectus\/central-accounts\/quota-rate-table\/v1 --type SecureString --tier Advanced --overwrite --value file:\/\//,
  );
  assert.doesNotMatch(result.stdout + result.stderr, /1234|synthetic|example\.tokens/);
});

test("the wrong signed-in account is refused and nothing is written", () => {
  const { result, calls } = run(["--account", "222222222222", "--values", "VALUES"]);
  assert.equal(result.status, 2);
  assert.doesNotMatch(calls, /put-parameter/);
});

test("a table the rate table parser rejects is refused before AWS is touched", () => {
  for (const table of ["not json", JSON.stringify({ version: "synthetic-v1" }), '{"version":"unset"}']) {
    const { result, calls } = run(["--account", SIGNED_IN, "--values", "VALUES"], table);
    assert.equal(result.status, 2, table);
    assert.equal(calls, "", "no aws call is made");
  }
});

test("the placeholder example is refused", () => {
  const { result, calls } = run(["--account", SIGNED_IN, "--values", example]);
  assert.equal(result.status, 2);
  assert.doesNotMatch(calls, /put-parameter/);
});

test("malformed arguments are refused", () => {
  for (const args of [
    ["--account", "123", "--values", "VALUES"],
    ["--account", SIGNED_IN, "--values", "/nonexistent/values.json"],
    ["--account", SIGNED_IN],
    ["--account", SIGNED_IN, "--values", "VALUES", "--extra"],
  ]) {
    const { result, calls } = run(args);
    assert.equal(result.status, 2, args.join(" "));
    assert.equal(calls, "");
  }
});
