/** Explicit synthetic cloud proof. Default is read-only; no cleanup or provisioning. */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { DurableGoogleIdentities, type EnrollmentPhase } from "../accounts/durable-google-identities";
import {
  VirtuusS3IdentityFiles,
  IdentityFileError,
  type IdentityFiles,
  type S3IdentityConfiguration,
} from "../accounts/identity-files";
import { googleFixture } from "../accounts/testing/google-fixture";
import {
  googleIdentityHandler,
  type LoginChallenge,
  type GoogleAssociation,
} from "../accounts/google-identity";
const exec = promisify(execFile);
const bucket = process.env.PROSPECTUS_IDENTITY_PROOF_BUCKET ?? "";
if (
  !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
  bucket.includes("cyclotron") ||
  bucket.startsWith("virtuus-store-proof-20261014-")
)
  throw new Error(
    "Set a reviewed existing private Papyrus synthetic proof bucket; the old Cyclotron target is disabled.",
  );
// Local profile configuration identifies this Papyrus account; STS must independently match.
const account = "712236451410",
  region = "us-east-1",
  profile = "papyrus-production";
const tenant = process.env.PROSPECTUS_IDENTITY_PROOF_TENANT ?? "";
const run = process.argv.slice(2);
if (run.some((arg) => arg !== "--run"))
  throw new Error("Only --run is supported; cleanup requires separate reviewed commands.");
if (!/^identity-proof-20261015-[a-f0-9]{16}$/.test(tenant))
  throw new Error(
    "Set PROSPECTUS_IDENTITY_PROOF_TENANT=identity-proof-20261015-<16 fresh lowercase random hex digits>.",
  );
const prefixes = [`${tenant}/identities/`, `_virtuus/${tenant}/identities/`];
if (
  run.includes("--run") &&
  process.env.PROSPECTUS_IDENTITY_S3_WRITE_APPROVAL !== `${account}/${bucket}/${tenant}`
)
  throw new Error(
    "Exact reviewed account/bucket/tenant write acknowledgment required before preflight or writes.",
  );
// Fix the provider to the existing approved profile; never synthesize credentials.
if (
  process.env.AWS_ACCESS_KEY_ID ||
  process.env.AWS_SECRET_ACCESS_KEY ||
  process.env.AWS_SESSION_TOKEN ||
  process.env.AWS_WEB_IDENTITY_TOKEN_FILE ||
  process.env.AWS_ROLE_ARN ||
  process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI ||
  process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
)
  throw new Error(
    "Run this proof with the existing SSO profile only, without credential environment overrides.",
  );
process.env.AWS_PROFILE = profile;
process.env.AWS_REGION = region;
process.env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS = "true";
async function aws(...args: string[]) {
  try {
    const { stdout } = await exec(
      "aws",
      [...args, "--profile", profile, "--region", region, "--output", "json", "--no-cli-pager"],
      {
        timeout: 30000,
        maxBuffer: 131072,
        env: {
          ...process.env,
          AWS_ENDPOINT_URL: undefined,
          AWS_ENDPOINT_URL_S3: undefined,
          AWS_ENDPOINT_URL_STS: undefined,
        },
      },
    );
    return stdout.trim() ? JSON.parse(stdout) : {};
  } catch {
    throw new Error(
      `Read-only AWS preflight failed (${args[0]} ${args[1]}). Check existing SSO session/access; no credential or permission changes are performed.`,
    );
  }
}
const identity = await aws("sts", "get-caller-identity");
assert.equal(identity.Account, account, "Wrong AWS account");
await aws("s3api", "head-bucket", "--bucket", bucket, "--expected-bucket-owner", account);
const location = await aws(
  "s3api",
  "get-bucket-location",
  "--bucket",
  bucket,
  "--expected-bucket-owner",
  account,
);
assert.ok(location.LocationConstraint === null || location.LocationConstraint === region);
const block = (
  await aws("s3api", "get-public-access-block", "--bucket", bucket, "--expected-bucket-owner", account)
).PublicAccessBlockConfiguration;
for (const key of ["BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets"])
  assert.equal(block?.[key], true, `Missing ${key}`);
assert.equal(
  (await aws("s3api", "get-bucket-versioning", "--bucket", bucket, "--expected-bucket-owner", account))
    .Status,
  "Enabled",
);
const encryption = await aws(
  "s3api",
  "get-bucket-encryption",
  "--bucket",
  bucket,
  "--expected-bucket-owner",
  account,
);
assert.ok(
  encryption.ServerSideEncryptionConfiguration?.Rules?.some(
    (rule: any) => rule.ApplyServerSideEncryptionByDefault?.SSEAlgorithm === "AES256",
  ),
  "Expected existing AES256 configuration",
);
for (const prefix of prefixes) {
  const listed = await aws(
    "s3api",
    "list-object-versions",
    "--bucket",
    bucket,
    "--expected-bucket-owner",
    account,
    "--prefix",
    prefix,
    "--max-keys",
    "1",
    "--no-paginate",
  );
  assert.equal(listed.Versions?.length ?? 0, 0, "Prefix already contains versions");
  assert.equal(listed.DeleteMarkers?.length ?? 0, 0, "Prefix contains delete markers");
  assert.ok(!listed.IsTruncated, "Prefix not empty");
}
console.log(
  JSON.stringify({
    mode: run.includes("--run") ? "approved-synthetic-write" : "read-only",
    account,
    bucket,
    region,
    prefixes,
    preflight: "PASS",
    cleanup: "not automatic; retain all versions until separately reviewed",
  }),
);
if (!run.includes("--run")) process.exit(0);
const config: S3IdentityConfiguration = {
  enabled: true,
  bucket,
  region,
  expectedOwner: account,
  tenant,
  project: "identities",
};
const files = () => new VirtuusS3IdentityFiles(config),
  repo = () => new DurableGoogleIdentities(files());
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const identityFixture = googleFixture();
function fixture() {
  const unique = randomUUID(),
    binding = {
      product: identityFixture.products[0].product,
      principal: identityFixture.products[0].roleArn,
      issuer: identityFixture.products[0].issuer,
      clientId: identityFixture.products[0].clientIds[0],
      policyRevision: identityFixture.products[0].googleFederation!.reviewedPolicyId,
    };
  const challenge: LoginChallenge = {
    challengeId: randomUUID(),
    nonce: randomUUID(),
    issuedAt: identityFixture.now,
    expiresAt: identityFixture.now + 300,
    binding,
  };
  const proof: GoogleAssociation = {
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    binding,
    cognitoSubject: `synthetic-${unique}`,
    googleSubject: `synthetic-${unique}`,
    authTime: identityFixture.now,
    lineageHash: hash(unique),
    fingerprint: hash(randomUUID()),
    now: identityFixture.now,
  };
  return { challenge, proof };
}
async function retry<T>(operation: () => Promise<T>): Promise<T> {
  // Only reconcile the same stable operation. Never reset execution claims.
  for (let attempt = 0; ; attempt++)
    try {
      return await operation();
    } catch (error) {
      if (
        !(error instanceof IdentityFileError && ["uncertain", "unavailable"].includes(error.code)) ||
        attempt >= 3
      )
        throw error;
    }
}
function worker(
  op: string,
  value: unknown,
  fault?: { phase: EnrollmentPhase; point: "before" | "after" },
): Promise<{ code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "accounts/testing/durable-worker.ts"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code }));
    child.stdin.end(JSON.stringify({ s3: config, op, value, fault }));
  });
}
let passed = 0;
// Each bridge operation is a fresh native process; no shared memory coordinates S3.
for (const phase of ["issue", "prepare", "google", "alias", "person", "session", "complete"] as const)
  for (const point of ["before", "after"] as const) {
    const fixtureValues = fixture();
    if (phase !== "issue") await repo().issue(fixtureValues.challenge);
    assert.equal(
      (
        await worker(
          phase === "issue" ? "issue" : "associate",
          phase === "issue" ? fixtureValues.challenge : fixtureValues.proof,
          {
            phase,
            point,
          },
        )
      ).code,
      86,
    );
    if (!(phase === "complete" && point === "after"))
      assert.equal(
        await repo().find(fixtureValues.proof.binding.issuer, fixtureValues.proof.cognitoSubject),
        null,
      );
    if (phase === "issue") await repo().issue(fixtureValues.challenge);
    const person = await retry(() => repo().associate(fixtureValues.proof));
    assert.deepEqual(await repo().recover(fixtureValues.challenge.challengeId), person);
    assert.equal(
      (await repo().find(fixtureValues.proof.binding.issuer, fixtureValues.proof.cognitoSubject))?.person.id,
      person.id,
    );
    passed++;
  }
const fixtureValues = fixture();
await repo().issue(fixtureValues.challenge);
let lost = false;
const inner = files();
const uncertain: IdentityFiles = {
  get: inner.get.bind(inner),
  list: inner.list.bind(inner),
  commit: async (...args) => {
    const result = await inner.commit(...args);
    if (!lost && args[0].startsWith("google/")) {
      lost = true;
      throw new IdentityFileError("uncertain");
    }
    return result;
  },
};
await assert.rejects(new DurableGoogleIdentities(uncertain).associate(fixtureValues.proof));
assert.equal(await repo().find(fixtureValues.proof.binding.issuer, fixtureValues.proof.cognitoSubject), null);
const recovered = await repo().recover(fixtureValues.challenge.challengeId);
assert.ok(recovered);
assert.deepEqual(await repo().associate(fixtureValues.proof), recovered);
await assert.rejects(
  repo().associate({ ...fixtureValues.proof, fingerprint: hash("changed") }),
  (error) => (error as any).code === "challenge_replay",
);
passed++;
const competing = { ...fixtureValues.challenge, challengeId: randomUUID() };
await repo().issue(competing);
await assert.rejects(
  repo().associate({
    ...fixtureValues.proof,
    challengeId: competing.challengeId,
    googleSubject: "synthetic-conflict",
    fingerprint: hash("conflict"),
  }),
  (error) => (error as any).code === "identity_conflict",
);
passed++;
const race = fixture(),
  proofs: GoogleAssociation[] = [];
for (let index = 0; index < 4; index++) {
  const challenge = {
    ...race.challenge,
    challengeId: randomUUID(),
    binding: {
      ...race.challenge.binding,
      issuer: `https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Synthetic${index}`,
    },
  };
  await repo().issue(challenge);
  proofs.push({
    ...race.proof,
    challengeId: challenge.challengeId,
    binding: challenge.binding,
    cognitoSubject: `synthetic-race-${index}`,
    fingerprint: hash(index),
  });
}
await Promise.all(proofs.map((proof) => worker("associate", proof)));
const people = [];
for (const proof of proofs) people.push(await retry(() => repo().associate(proof)));
assert.equal(new Set(people.map((person) => person.id)).size, 1);
passed++;
// Actual RSA handler at the storage boundary, not only trusted repository calls.
const handler = () =>
  googleIdentityHandler(repo(), identityFixture.products, identityFixture.keys, () => identityFixture.now);
const peopleFromPools = [];
for (let index = 0; index < 2; index++) {
  const issued = JSON.parse(
    (await handler()(identityFixture.event(index, "/v1/identities/google/challenge"))).body,
  );
  const pair = identityFixture.pair(index, issued.nonce);
  const response = await handler()(
    identityFixture.event(index, "/v1/identities/google/resolve", { challengeId: issued.challengeId }, pair),
  );
  assert.equal(response.statusCode, 200);
  peopleFromPools.push(JSON.parse(response.body).person);
  assert.equal(
    (await handler()(identityFixture.event(index, "/v1/identities/me", {}, pair, "GET"))).body,
    response.body,
  );
}
assert.deepEqual(peopleFromPools[0], peopleFromPools[1]);
passed++;
console.log(
  JSON.stringify({
    contract: "PASS",
    cases: passed,
    account,
    bucket,
    prefixes,
    cleanup: "not performed; retained synthetic versions and journal evidence",
    claims: "S3 identity only; no real Google/IAM gateway or durable membership proof",
  }),
);
