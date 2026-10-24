import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  cognitoAliasKey,
  DurableGoogleIdentities,
  googleIdentityKey,
  sessionLookupPath,
} from "./durable-google-identities";
import { IdentityFileError, VirtuusIdentityFiles, type IdentityFiles } from "./identity-files";
import {
  googleIdentityHandler,
  type GoogleAssociation,
  type GoogleIdentityRepository,
  type IdentityBinding,
  type LoginChallenge,
} from "./google-identity";
import { googleFixture } from "./testing/google-fixture";
import { googlePersonDirectory } from "./person-directory";
import { registrations } from "./registration";
import { context } from "./auth";

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function virtuusRoot() {
  const root = await mkdtemp(join(tmpdir(), "prospectus-session-lookup-"));
  roots.push(root);
  return root;
}

/** Counts every read and listing so a test can prove how much canonical storage one lookup touches. */
function counted(inner: IdentityFiles, hide: (path: string) => boolean = () => false) {
  const reads: string[] = [];
  const listings: string[] = [];
  const files: IdentityFiles = {
    get: async (path) => {
      reads.push(path);
      return hide(path) ? null : inner.get(path);
    },
    list: async (prefix) => {
      listings.push(prefix);
      return inner.list(prefix);
    },
    commit: (path, operationId, requestHash, value, revision) =>
      inner.commit(path, operationId, requestHash, value, revision),
  };
  return { files, reads, listings };
}

/** The lookup as it behaved before session lookup files: every hint ignored, every stored session scanned. */
const fullScan = (repository: GoogleIdentityRepository): GoogleIdentityRepository => ({
  issue: (challenge) => repository.issue(challenge),
  associate: (proof) => repository.associate(proof),
  find: (issuer, subject) => repository.find(issuer, subject),
  getPerson: (id) => repository.getPerson(id),
});

const withoutSessionLookups = (path: string) => path.startsWith("session-lookups/");

/** Enrolls synthetic sign-ins for pool person 0 through the real HTTP-event contract on real Virtuus files. */
async function enrolledThroughHandler(sessionCount: number) {
  const root = await virtuusRoot();
  const identityFixture = googleFixture();
  const handler = googleIdentityHandler(
    new DurableGoogleIdentities(new VirtuusIdentityFiles(root)),
    identityFixture.products,
    identityFixture.keys,
    () => identityFixture.now,
  );
  const signIns: Array<{ family: string; challengeId: string; pair: { access: string; id: string } }> = [];
  for (let index = 0; index < sessionCount; index++) {
    const family = `synthetic-family-${index}`;
    const issued = JSON.parse(
      (await handler(identityFixture.event(0, "/v1/identities/google/challenge"))).body,
    );
    const pair = identityFixture.pair(
      0,
      issued.nonce,
      "synthetic-google-a",
      { origin_jti: family },
      { origin_jti: family },
    );
    const resolved = await handler(
      identityFixture.event(0, "/v1/identities/google/resolve", { challengeId: issued.challengeId }, pair),
    );
    assert.equal(resolved.statusCode, 200, resolved.body);
    signIns.push({ family, challengeId: issued.challengeId, pair });
  }
  return { root, identityFixture, signIns };
}

function me(
  repository: GoogleIdentityRepository,
  identityFixture: ReturnType<typeof googleFixture>,
  pair: { access: string; id: string },
  products = identityFixture.products,
) {
  return googleIdentityHandler(
    repository,
    products,
    identityFixture.keys,
    () => identityFixture.now,
  )(identityFixture.event(0, "/v1/identities/me", {}, pair, "GET"));
}

test("enrollment writes one immutable session lookup file and leaves every existing path as before", async () => {
  const { root, signIns } = await enrolledThroughHandler(2);
  const files = new VirtuusIdentityFiles(root);
  const lookups = await files.list("session-lookups/");
  assert.equal(lookups.length, 2);
  const aliasKey = cognitoAliasKey(
    "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Synthetic0",
    "synthetic-pool-person-0",
  );
  for (const path of lookups) {
    assert.match(path, new RegExp(`^session-lookups/${aliasKey}/[a-f0-9]{64}\\.json$`));
    const lookup = (await files.get(path))!.value;
    assert.deepEqual(Object.keys(lookup).sort(), [
      "aliasKey",
      "challengeId",
      "googleKey",
      "kind",
      "personId",
      "version",
    ]);
    assert.equal(lookup.kind, "session-lookup");
    assert.equal(lookup.googleKey, googleIdentityKey("synthetic-google-a"));
    assert.ok(signIns.some((signIn) => signIn.challengeId === lookup.challengeId));
    assert.ok(await files.get(`sessions/${lookup.googleKey}/${aliasKey}/${lookup.challengeId}.json`));
  }
  for (const signIn of signIns) {
    const login = (await files.get(`logins/${signIn.challengeId}.json`))!.value;
    assert.deepEqual(Object.keys(login).sort(), [
      "candidate",
      "challenge",
      "kind",
      "person",
      "proof",
      "state",
      "version",
    ]);
  }
});

test("a hinted /identities/me reads at most six files however many sessions the alias has", async () => {
  const observed: number[] = [];
  for (const sessionCount of [1, 12]) {
    const { root, identityFixture, signIns } = await enrolledThroughHandler(sessionCount);
    for (const signIn of [signIns[0], signIns[signIns.length - 1]]) {
      const { files, reads, listings } = counted(new VirtuusIdentityFiles(root));
      const response = await me(new DurableGoogleIdentities(files), identityFixture, signIn.pair);
      const before = await me(
        fullScan(new DurableGoogleIdentities(new VirtuusIdentityFiles(root))),
        identityFixture,
        signIn.pair,
      );
      assert.equal(response.statusCode, 200);
      assert.equal(response.body, before.body, "the hinted answer equals a full scan");
      assert.ok(JSON.parse(response.body).person.id);
      assert.deepEqual(listings, [], "a hinted lookup lists no sessions");
      assert.ok(reads.length <= 6, `Expected at most six reads, read ${reads.length}: ${reads}`);
      observed.push(reads.length);
    }
  }
  assert.equal(new Set(observed).size, 1, `Read count must not depend on session count: ${observed}`);
});

test("sessions committed before lookup files existed fall back to the scan and stop at the first match", async () => {
  const { root, identityFixture, signIns } = await enrolledThroughHandler(9);
  const googleKey = googleIdentityKey("synthetic-google-a");
  const aliasKey = cognitoAliasKey(identityFixture.products[0].issuer, "synthetic-pool-person-0");
  const sessionPaths = await new VirtuusIdentityFiles(root).list(`sessions/${googleKey}/${aliasKey}/`);
  assert.equal(sessionPaths.length, 9);
  for (const signIn of signIns) {
    const { files, reads, listings } = counted(new VirtuusIdentityFiles(root), withoutSessionLookups);
    const response = await me(new DurableGoogleIdentities(files), identityFixture, signIn.pair);
    const before = await me(
      fullScan(new DurableGoogleIdentities(new VirtuusIdentityFiles(root))),
      identityFixture,
      signIn.pair,
    );
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, before.body);
    assert.equal(listings.length, 1);
    const position = sessionPaths.indexOf(`sessions/${googleKey}/${aliasKey}/${signIn.challengeId}.json`);
    const pointerReads = reads.filter((path) => path.startsWith("sessions/")).length;
    assert.equal(pointerReads, Math.min(sessionPaths.length, Math.ceil((position + 1) / 4) * 4));
  }
});

test("a hinted lookup refuses exactly as a full scan does, with or without lookup files", async () => {
  const { root, identityFixture, signIns } = await enrolledThroughHandler(3);
  const otherPolicy = registrations(
    identityFixture.products.map((product) => ({
      ...product,
      googleFederation: { ...product.googleFederation!, reviewedPolicyId: "synthetic-review-v2" },
    })),
  );
  const cases = [
    { name: "an enrolled sign-in", pair: signIns[1].pair, products: identityFixture.products, status: 200 },
    {
      name: "a sign-in that was never enrolled",
      pair: identityFixture.pair(0, "unused", "synthetic-google-a", { origin_jti: "never-enrolled" }),
      products: identityFixture.products,
      status: 401,
      code: "reenrollment_required",
    },
    {
      name: "an alias enrolled only under another binding",
      pair: signIns[1].pair,
      products: otherPolicy,
      status: 403,
      code: "reenrollment_required",
    },
    {
      name: "an alias that was never enrolled",
      pair: identityFixture.pair(0, "unused", "synthetic-google-a", {
        sub: "synthetic-never-enrolled",
      }),
      products: identityFixture.products,
      status: 200,
      person: null,
    },
  ];
  for (const hide of [() => false, withoutSessionLookups])
    for (const scenario of cases) {
      const hinted = await me(
        new DurableGoogleIdentities(counted(new VirtuusIdentityFiles(root), hide).files),
        identityFixture,
        scenario.pair,
        scenario.products,
      );
      const before = await me(
        fullScan(new DurableGoogleIdentities(new VirtuusIdentityFiles(root))),
        identityFixture,
        scenario.pair,
        scenario.products,
      );
      assert.equal(hinted.statusCode, scenario.status, scenario.name);
      assert.equal(hinted.statusCode, before.statusCode, scenario.name);
      assert.equal(hinted.body, before.body, scenario.name);
      if (scenario.code) assert.equal(JSON.parse(hinted.body).error, scenario.code, scenario.name);
      if ("person" in scenario) assert.equal(JSON.parse(hinted.body).person, null, scenario.name);
    }
  for (const scenario of cases.filter((item) => item.products === identityFixture.products)) {
    const event = identityFixture.event(0, "/v1/accounts", {}, scenario.pair, "GET");
    const caller = await context(event, identityFixture.products, identityFixture.keys, identityFixture.now);
    const hinted = await googlePersonDirectory(
      new DurableGoogleIdentities(new VirtuusIdentityFiles(root)),
      identityFixture.products,
    ).resolve(caller);
    const before = await googlePersonDirectory(
      fullScan(new DurableGoogleIdentities(new VirtuusIdentityFiles(root))),
      identityFixture.products,
    ).resolve(caller);
    assert.deepEqual(hinted, before, scenario.name);
  }
});

/** Repository-level sign-ins for one alias under chosen bindings, written directly through the enrollment protocol. */
async function enrolledSessions(bindings: IdentityBinding[]) {
  const root = await virtuusRoot();
  const repository = new DurableGoogleIdentities(new VirtuusIdentityFiles(root));
  const now = 1900000000;
  const proofs: GoogleAssociation[] = [];
  for (const [index, binding] of bindings.entries()) {
    const challenge: LoginChallenge = {
      challengeId: randomUUID(),
      nonce: randomUUID(),
      issuedAt: now,
      expiresAt: now + 300,
      binding,
    };
    await repository.issue(challenge);
    const proof: GoogleAssociation = {
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      binding,
      cognitoSubject: "synthetic-pool-person-0",
      googleSubject: "synthetic-google-a",
      authTime: now,
      lineageHash: hash(["family", index]),
      fingerprint: hash(["proof", index]),
      now,
    };
    await repository.associate(proof);
    proofs.push(proof);
  }
  return { root, proofs };
}

const bindingWithPolicy = (policyRevision: string): IdentityBinding => ({
  product: "cyclotron",
  principal: "arn:aws:iam::111111111111:role/Synthetic0",
  issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Synthetic0",
  clientId: "synthetic0",
  policyRevision,
});

test("a binding-only lookup stops at the first committed session under that binding", async () => {
  const current = bindingWithPolicy("synthetic-review-v1");
  const retired = bindingWithPolicy("synthetic-review-v0");
  const { root } = await enrolledSessions([retired, ...Array.from({ length: 8 }, () => current)]);
  const issuer = current.issuer,
    subject = "synthetic-pool-person-0";
  const everything = await new DurableGoogleIdentities(new VirtuusIdentityFiles(root)).find(issuer, subject);
  assert.equal(everything?.alias.sessions.length, 9);
  const { files, reads } = counted(new VirtuusIdentityFiles(root));
  const found = await new DurableGoogleIdentities(files).find(issuer, subject, { binding: current });
  assert.equal(found?.person.id, everything!.person.id);
  assert.ok(found!.alias.provenance.some((binding) => binding.policyRevision === current.policyRevision));
  assert.equal(
    reads.filter((path) => path.startsWith("sessions/")).length,
    4,
    "the scan stops after one batch",
  );
  assert.ok(
    !reads.some((path) => path.startsWith("session-lookups/")),
    "a binding-only lookup needs no file",
  );
  const never = await new DurableGoogleIdentities(new VirtuusIdentityFiles(root)).find(issuer, subject, {
    binding: bindingWithPolicy("synthetic-review-never"),
  });
  assert.deepEqual(never, everything, "a binding that never enrolled scans every session as before");
});

test("a second challenge for the same sign-in keeps the first lookup file and still resolves", async () => {
  const binding = bindingWithPolicy("synthetic-review-v1");
  const { root, proofs } = await enrolledSessions([binding]);
  const repository = new DurableGoogleIdentities(new VirtuusIdentityFiles(root));
  const challenge: LoginChallenge = {
    challengeId: randomUUID(),
    nonce: randomUUID(),
    issuedAt: proofs[0].now,
    expiresAt: proofs[0].now + 300,
    binding,
  };
  await repository.issue(challenge);
  const again = await repository.associate({
    ...proofs[0],
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    fingerprint: hash("second challenge"),
  });
  const files = new VirtuusIdentityFiles(root);
  const aliasKey = cognitoAliasKey(binding.issuer, proofs[0].cognitoSubject);
  const lookup = await files.get(sessionLookupPath(aliasKey, proofs[0]));
  assert.equal(lookup?.value.challengeId, proofs[0].challengeId);
  const found = await repository.find(binding.issuer, proofs[0].cognitoSubject, proofs[0]);
  assert.equal(found?.person.id, again.id);
});

test("a lookup file naming a sign-in that never committed falls back and never authorizes", async () => {
  const root = await virtuusRoot();
  const binding = bindingWithPolicy("synthetic-review-v1");
  const now = 1900000000;
  const challenge: LoginChallenge = {
    challengeId: randomUUID(),
    nonce: randomUUID(),
    issuedAt: now,
    expiresAt: now + 300,
    binding,
  };
  const proof: GoogleAssociation = {
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    binding,
    cognitoSubject: "synthetic-pool-person-0",
    googleSubject: "synthetic-google-a",
    authTime: now,
    lineageHash: hash("family"),
    fingerprint: hash("proof"),
    now,
  };
  const interrupted = new DurableGoogleIdentities(new VirtuusIdentityFiles(root), (phase, point) => {
    if (phase === "complete" && point === "before") throw new Error("synthetic interruption");
  });
  await interrupted.issue(challenge);
  await assert.rejects(interrupted.associate(proof));
  const files = new VirtuusIdentityFiles(root);
  const aliasKey = cognitoAliasKey(binding.issuer, proof.cognitoSubject);
  assert.ok(await files.get(sessionLookupPath(aliasKey, proof)), "the lookup file exists before commit");
  const repository = new DurableGoogleIdentities(files);
  assert.equal(await repository.find(binding.issuer, proof.cognitoSubject, proof), null);
  const person = await repository.associate(proof);
  assert.equal((await repository.find(binding.issuer, proof.cognitoSubject, proof))?.person.id, person.id);
});

/** Identical concurrent resolutions in independent native processes, with no caller-side retry. */
test("concurrent identical resolutions converge on one Person without a 503", async () => {
  const binding = bindingWithPolicy("synthetic-review-v1");
  const root = await virtuusRoot();
  const now = 1900000000;
  const challenge: LoginChallenge = {
    challengeId: randomUUID(),
    nonce: randomUUID(),
    issuedAt: now,
    expiresAt: now + 300,
    binding,
  };
  await new DurableGoogleIdentities(new VirtuusIdentityFiles(root)).issue(challenge);
  const proof: GoogleAssociation = {
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    binding,
    cognitoSubject: "synthetic-pool-person-0",
    googleSubject: "synthetic-google-a",
    authTime: now,
    lineageHash: hash("family"),
    fingerprint: hash("proof"),
    now,
  };
  const results = await Promise.allSettled(
    Array.from({ length: 4 }, () =>
      new DurableGoogleIdentities(new VirtuusIdentityFiles(root)).associate(proof),
    ),
  );
  const rejected = results.filter((result) => result.status === "rejected") as PromiseRejectedResult[];
  assert.deepEqual(
    rejected.map((result) => (result.reason as any).code),
    [],
  );
  const people = results.map((result) => (result as PromiseFulfilledResult<{ id: string }>).value.id);
  assert.equal(new Set(people).size, 1);
});

/** Wraps real files so chosen commits report that another execution owns the operation. */
function contended(inner: IdentityFiles, failures: (path: string, attempt: number) => string | undefined) {
  const attempts = new Map<string, number>();
  const files: IdentityFiles = {
    get: (path) => inner.get(path),
    list: (prefix) => inner.list(prefix),
    commit: async (path, operationId, requestHash, value, revision) => {
      const attempt = (attempts.get(path) ?? 0) + 1;
      attempts.set(path, attempt);
      const code = failures(path, attempt);
      if (code) throw new IdentityFileError(code);
      return inner.commit(path, operationId, requestHash, value, revision);
    },
  };
  return { files, attempts };
}

test("a write owned by another execution is retried with the same operation and then succeeds", async () => {
  const root = await virtuusRoot();
  const binding = bindingWithPolicy("synthetic-review-v1");
  const now = 1900000000;
  const challenge: LoginChallenge = {
    challengeId: randomUUID(),
    nonce: randomUUID(),
    issuedAt: now,
    expiresAt: now + 300,
    binding,
  };
  const { files, attempts } = contended(new VirtuusIdentityFiles(root), (_path, attempt) =>
    attempt === 1 ? "uncertain" : attempt === 2 ? "unavailable" : undefined,
  );
  const repository = new DurableGoogleIdentities(files);
  await repository.issue(challenge);
  const person = await repository.associate({
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    binding,
    cognitoSubject: "synthetic-pool-person-0",
    googleSubject: "synthetic-google-a",
    authTime: now,
    lineageHash: hash("family"),
    fingerprint: hash("proof"),
    now,
  });
  assert.ok(person.id);
  for (const [path, count] of attempts) if (!path.startsWith("logins/")) assert.equal(count, 3, path);
});

test("a write still contended after three attempts returns 503 identity_unavailable", async () => {
  const root = await virtuusRoot();
  const identityFixture = googleFixture();
  const { files, attempts } = contended(new VirtuusIdentityFiles(root), (path) =>
    path.startsWith("google/") ? "uncertain" : undefined,
  );
  const handler = googleIdentityHandler(
    new DurableGoogleIdentities(files),
    identityFixture.products,
    identityFixture.keys,
    () => identityFixture.now,
  );
  const issued = JSON.parse(
    (await handler(identityFixture.event(0, "/v1/identities/google/challenge"))).body,
  );
  const resolved = await handler(
    identityFixture.event(
      0,
      "/v1/identities/google/resolve",
      { challengeId: issued.challengeId },
      identityFixture.pair(0, issued.nonce),
    ),
  );
  assert.equal(resolved.statusCode, 503);
  assert.equal(JSON.parse(resolved.body).error, "identity_unavailable");
  assert.equal(attempts.get(`google/${googleIdentityKey("synthetic-google-a")}.json`), 3);
});

test("conflicts, replays and identity conflicts are decided once and never retried", async () => {
  const root = await virtuusRoot();
  const binding = bindingWithPolicy("synthetic-review-v1");
  const now = 1900000000;
  const commits: string[] = [];
  const recording: IdentityFiles = (() => {
    const inner = new VirtuusIdentityFiles(root);
    return {
      get: (path) => inner.get(path),
      list: (prefix) => inner.list(prefix),
      commit: (path, operationId, requestHash, value, revision) => {
        commits.push(operationId);
        return inner.commit(path, operationId, requestHash, value, revision);
      },
    };
  })();
  const repository = new DurableGoogleIdentities(recording);
  const challenge: LoginChallenge = {
    challengeId: randomUUID(),
    nonce: randomUUID(),
    issuedAt: now,
    expiresAt: now + 300,
    binding,
  };
  await repository.issue(challenge);
  const proof: GoogleAssociation = {
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    binding,
    cognitoSubject: "synthetic-pool-person-0",
    googleSubject: "synthetic-google-a",
    authTime: now,
    lineageHash: hash("family"),
    fingerprint: hash("proof"),
    now,
  };
  const signed = { ...proof, challengeId: randomUUID() };
  const signedChallenge = { ...challenge, challengeId: signed.challengeId };
  await repository.associate({ ...signed, challenge: signedChallenge });
  commits.length = 0;
  // A signed challenge claimed with different evidence is an operation mismatch: one attempt, then a replay refusal.
  await assert.rejects(
    repository.associate({ ...signed, challenge: signedChallenge, fingerprint: hash("rival") }),
    (error: any) => error.status === 409 && error.code === "challenge_replay",
  );
  assert.deepEqual(commits, [`identity:${signed.challengeId}:prepare`]);
  // A revision conflict on the login record is a decision, not contention: it surfaces after one attempt.
  commits.length = 0;
  const conflicting: IdentityFiles = {
    ...recording,
    commit: async (path, operationId, requestHash, value, revision) => {
      commits.push(operationId);
      if (operationId.endsWith(":prepare")) throw new IdentityFileError("conflict");
      return recording.commit(path, operationId, requestHash, value, revision);
    },
  };
  await assert.rejects(
    new DurableGoogleIdentities(conflicting).associate(proof),
    (error: any) => error instanceof IdentityFileError && error.code === "conflict",
  );
  assert.deepEqual(commits, [`identity:${proof.challengeId}:prepare`]);
  // A different Google account for an existing alias is an identity conflict, never merged or retried.
  const rival: LoginChallenge = { ...challenge, challengeId: randomUUID(), nonce: randomUUID() };
  await repository.issue(rival);
  commits.length = 0;
  await assert.rejects(
    repository.associate({
      ...proof,
      challengeId: rival.challengeId,
      nonce: rival.nonce,
      googleSubject: "synthetic-google-other",
      fingerprint: hash("other google"),
    }),
    (error: any) => error.status === 409 && error.code === "identity_conflict",
  );
  assert.equal(commits.filter((operation) => operation.endsWith(":alias")).length, 1);
});
