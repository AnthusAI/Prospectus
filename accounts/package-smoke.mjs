/** Run only against completed Linux assets, with disposable files and no credentials. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, copyFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
assert.equal(process.platform, "linux", "Verify deployment assets on Linux");
assert.equal(process.arch, "x64", "Verify the Lambda x86_64 architecture");
const nodeMajor = Number(process.versions.node.split(".")[0]);
assert.ok(nodeMajor >= 22, "Use a supported Node build runtime");
if (process.env.PROSPECTUS_PACKAGE_NODE_MAJOR)
  assert.equal(
    nodeMajor,
    Number(process.env.PROSPECTUS_PACKAGE_NODE_MAJOR),
    "Verify the requested deployment runtime",
  );
const central = resolve(".artifacts/canonical-accounts"),
  bff = resolve(".artifacts/accounts-bff"),
  native = join(central, "identity-files");
const bytes = readFileSync(native);
assert.deepEqual([...bytes.subarray(0, 5)], [127, 69, 76, 70, 2], "Native bridge must be ELF64");
assert.equal(bytes.readUInt16LE(18), 62, "Native bridge must target x86_64");
const programOffset = Number(bytes.readBigUInt64LE(32)),
  programSize = bytes.readUInt16LE(54),
  programCount = bytes.readUInt16LE(56);
for (let index = 0; index < programCount; index++)
  assert.notEqual(
    bytes.readUInt32LE(programOffset + index * programSize),
    3,
    "The musl bridge must not require a dynamic interpreter",
  );
assert.ok(statSync(native).mode & 0o111, "Native bridge must be executable");
assert.ok(
  bytes.length + statSync(join(central, "index.js")).size < 200 * 1024 * 1024,
  "Keep the central deployment package within Lambda limits",
);
const root = mkdtempSync(join(tmpdir(), "accounts-package-smoke-"));
const environment = {
  PATH: process.env.PATH,
  PROSPECTUS_IDENTITY_FILES_ROOT: root,
  PROSPECTUS_IDENTITY_PROJECT: "accounts",
};
function nativeRequest(value) {
  const result = spawnSync(native, [], {
    input: JSON.stringify(value),
    encoding: "utf8",
    env: environment,
    timeout: 15000,
    maxBuffer: 131072,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
try {
  const path = "accounts/11111111-1111-4111-8111-111111111111.json",
    value = { synthetic: true, purpose: "Linux package verification" };
  assert.deepEqual(nativeRequest({ action: "get", path }), { result: null });
  const create = {
    action: "commit",
    path,
    value,
    revision: null,
    operation_id: "synthetic-package-create",
    request_hash: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
  };
  const stored = nativeRequest(create);
  assert.deepEqual(stored.result?.value, value);
  assert.equal(typeof stored.result.revision, "string");
  assert.deepEqual(nativeRequest(create), stored, "Identical creation replay must preserve the receipt");
  assert.deepEqual(
    nativeRequest({ action: "get", path }),
    stored,
    "A fresh native process must read the persisted value",
  );
  assert.equal(nativeRequest({ ...create, operation_id: "synthetic-package-conflict" }).error, "conflict");
  assert.equal(
    nativeRequest({ action: "get", path: "people/11111111-1111-4111-8111-111111111111.json" }).error,
    "invalid",
  );
  const registration = {
    product: "synthetic-directory",
    roleArn: "arn:aws:iam::111111111111:role/SyntheticDirectory",
    issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Synthetic",
    clientIds: ["syntheticclient"],
    capabilities: ["console:read", "members:read"],
    enabled: true,
    accountDirectory: true,
  };
  function bundle(name, directory, event, settings) {
    const path = join(root, `${name}.cjs`);
    copyFileSync(join(directory, "index.js"), path);
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        "require(process.argv[1]).handler(JSON.parse(process.argv[2])).then(value=>process.stdout.write(\"\\n\"+JSON.stringify(value)))",
        path,
        JSON.stringify(event),
      ],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH, AWS_EC2_METADATA_DISABLED: "true", ...settings },
        timeout: 15000,
        maxBuffer: 131072,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    // Handler log lines share stdout; the result is the last line.
    return JSON.parse(result.stdout.trimEnd().split("\n").at(-1));
  }
  const denied = bundle(
    "central",
    central,
    { httpMethod: "GET", path: "/v1/account-directory" },
    {
      LAMBDA_TASK_ROOT: central,
      PROSPECTUS_CANONICAL_ACCOUNTS: "enabled",
      PROSPECTUS_ACCOUNTS_BUCKET: "synthetic-package.invalid",
      PROSPECTUS_ACCOUNTS_OWNER: "111111111111",
      PROSPECTUS_PRODUCTS: JSON.stringify([registration]),
    },
  );
  assert.equal(denied.statusCode, 403, "Packaged central handler must refuse an unregistered caller");
  const anonymous = bundle(
    "bff",
    bff,
    { rawPath: "/api/saas/accounts", requestContext: { http: { method: "GET" } } },
    {
      PROSPECTUS_DIRECTORY_REGISTRATION: JSON.stringify(registration),
      PROSPECTUS_CENTRAL_ENDPOINT: "https://synthetic.invalid/api",
    },
  );
  assert.equal(anonymous.statusCode, 401, "Packaged BFF must refuse an anonymous browser");
  console.log(
    JSON.stringify({
      packaging: "PASS",
      node: process.versions.node,
      architecture: process.arch,
      nativeBytes: bytes.length,
      checks: [
        "static ELF64",
        "filesystem persistence",
        "creation replay",
        "revision conflict",
        "scope refusal",
        "central caller refusal",
        "BFF anonymous refusal",
      ],
      cloudCalls: 0,
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
