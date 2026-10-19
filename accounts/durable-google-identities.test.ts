import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  DurableGoogleIdentities,
  googleIdentityKey,
  type EnrollmentPhase,
} from "./durable-google-identities";
import {
  VirtuusAccountFiles,
  VirtuusIdentityFiles,
  IdentityFileError,
  type IdentityFiles,
} from "./identity-files";
import { googleIdentityHandler, type GoogleAssociation, type LoginChallenge } from "./google-identity";
import { googleFixture } from "./testing/google-fixture";
import { googlePersonDirectory } from "./person-directory";
import { DurableAccountsService } from "./durable-accounts";
import { registrations } from "./registration";
import { context } from "./auth";
import { accountHandler } from "./handler";

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "prospectus-identity-files-"));
  roots.push(root);
  const identityFixture = googleFixture();
  const binding = {
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
    cognitoSubject: "synthetic-pool-person-0",
    googleSubject: "synthetic-google-a",
    authTime: identityFixture.now,
    lineageHash: hash("synthetic-family-0"),
    fingerprint: hash(randomUUID()),
    now: identityFixture.now,
  };
  const files = new VirtuusIdentityFiles(root);
  const repository = () => new DurableGoogleIdentities(new VirtuusIdentityFiles(root));
  return { root, identityFixture, challenge, proof, files, repository };
}
function worker(
  root: string,
  op: string,
  value: unknown,
  fault?: { phase: EnrollmentPhase; point: "before" | "after" },
): Promise<{ code: number | null; result: any }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "accounts/testing/durable-worker.ts"], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let text = "";
    child.stdout.on("data", (chunk) => {
      text += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        resolve({ code, result: text ? JSON.parse(text) : null });
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify({ root, op, value, fault }));
  });
}
async function retry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++)
    try {
      return await run();
    } catch (error) {
      if (
        !(error instanceof IdentityFileError && ["uncertain", "unavailable"].includes(error.code)) ||
        attempt >= 40
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

test("actual Virtuus files preserve a canonical Person across pool enrollments and process restart", async () => {
  const environment = await fixture();
  await environment.repository().issue(environment.challenge);
  const first = await environment.repository().associate(environment.proof);
  const challenge = {
    ...environment.challenge,
    challengeId: randomUUID(),
    binding: {
      ...environment.challenge.binding,
      ...{
        product: environment.identityFixture.products[1].product,
        principal: environment.identityFixture.products[1].roleArn,
        issuer: environment.identityFixture.products[1].issuer,
        clientId: environment.identityFixture.products[1].clientIds[0],
      },
    },
  };
  await environment.repository().issue(challenge);
  const second = await environment.repository().associate({
    ...environment.proof,
    challengeId: challenge.challengeId,
    binding: challenge.binding,
    cognitoSubject: "synthetic-pool-person-1",
    fingerprint: hash(randomUUID()),
  });
  assert.deepEqual(first, second);
  assert.deepEqual(await environment.repository().getPerson(first.id), first);
  assert.equal(
    (await environment.repository().find(challenge.binding.issuer, "synthetic-pool-person-1"))?.person.id,
    first.id,
  );
  const google = await environment.files.get(
    `google/${googleIdentityKey(environment.proof.googleSubject)}.json`,
  );
  assert.equal(google?.value.person.id, first.id);
});
for (const phase of ["issue", "prepare", "google", "alias", "person", "session", "complete"] as const)
  for (const point of ["before", "after"] as const)
    test(`process crash ${point} ${phase} cannot authorize partial enrollment; restart resumes`, async () => {
      const environment = await fixture();
      if (phase !== "issue") await environment.repository().issue(environment.challenge);
      const crash = await worker(
        environment.root,
        phase === "issue" ? "issue" : "associate",
        phase === "issue" ? environment.challenge : environment.proof,
        { phase, point },
      );
      assert.equal(crash.code, 86);
      if (!(phase === "complete" && point === "after"))
        assert.equal(
          await environment
            .repository()
            .find(environment.proof.binding.issuer, environment.proof.cognitoSubject),
          null,
        );
      if (phase === "issue") await environment.repository().issue(environment.challenge);
      const person = await retry(() => environment.repository().associate(environment.proof));
      assert.ok(person.id);
      assert.equal(
        (
          await environment
            .repository()
            .find(environment.proof.binding.issuer, environment.proof.cognitoSubject)
        )?.person.id,
        person.id,
      );
      assert.deepEqual(await environment.repository().recover(environment.challenge.challengeId), person);
    });
test("lost journal response is recovered after restart without replacing the winning Person", async () => {
  const environment = await fixture();
  await environment.repository().issue(environment.challenge);
  let lost = false;
  const uncertain: IdentityFiles = {
    get: environment.files.get.bind(environment.files),
    list: environment.files.list.bind(environment.files),
    commit: async (...args) => {
      const value = await environment.files.commit(...args);
      if (!lost && args[0].startsWith("google/")) {
        lost = true;
        throw new IdentityFileError("uncertain");
      }
      return value;
    },
  };
  await assert.rejects(new DurableGoogleIdentities(uncertain).associate(environment.proof));
  assert.equal(
    await environment.repository().find(environment.proof.binding.issuer, environment.proof.cognitoSubject),
    null,
  );
  const saved = (await environment.files.get(
    `google/${googleIdentityKey(environment.proof.googleSubject)}.json`,
  ))!.value.person;
  assert.deepEqual(await environment.repository().recover(environment.challenge.challengeId), saved);
  assert.deepEqual(await environment.repository().associate(environment.proof), saved);
});
test("prepared recovery after expiry does not make expired API evidence valid", async () => {
  const environment = await fixture();
  await environment.repository().issue(environment.challenge);
  await worker(environment.root, "associate", environment.proof, { phase: "prepare", point: "after" });
  await assert.rejects(
    environment.repository().associate({ ...environment.proof, now: environment.challenge.expiresAt + 1 }),
    (error) => (error as any).code === "challenge_invalid",
  );
  assert.equal(
    await environment.repository().find(environment.proof.binding.issuer, environment.proof.cognitoSubject),
    null,
  );
  assert.ok((await environment.repository().recover(environment.challenge.challengeId))?.id);
  const handler = googleIdentityHandler(
    environment.repository(),
    environment.identityFixture.products,
    environment.identityFixture.keys,
    () => environment.identityFixture.now + 4000,
  );
  const response = await handler(
    environment.identityFixture.event(
      0,
      "/v1/identities/me",
      {},
      environment.identityFixture.pair(0, environment.challenge.nonce),
      "GET",
    ),
  );
  assert.equal(response.statusCode, 401);
});
test("independent processes converge on one Google Person with different pool aliases", async () => {
  const environment = await fixture();
  const proofs: GoogleAssociation[] = [];
  for (let index = 0; index < 8; index++) {
    const challenge = {
      ...environment.challenge,
      challengeId: randomUUID(),
      binding: {
        ...environment.challenge.binding,
        issuer: `https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Synthetic${index}`,
      },
    };
    await environment.repository().issue(challenge);
    proofs.push({
      ...environment.proof,
      challengeId: challenge.challengeId,
      binding: challenge.binding,
      cognitoSubject: `synthetic-${index}`,
      fingerprint: hash(index),
    });
  }
  await Promise.all(proofs.map((proof) => worker(environment.root, "associate", proof)));
  const results = [];
  for (const proof of proofs) results.push(await retry(() => environment.repository().associate(proof)));
  assert.equal(new Set(results.map((person) => person.id)).size, 1);
  for (const proof of proofs)
    assert.equal(
      (await environment.repository().find(proof.binding.issuer, proof.cognitoSubject))?.person.id,
      results[0].id,
    );
});
test("concurrent identical login replays converge; conflicting proof and alias never merge", async () => {
  const environment = await fixture();
  await environment.repository().issue(environment.challenge);
  await Promise.all(
    Array.from({ length: 6 }, () => worker(environment.root, "associate", environment.proof)),
  );
  const first = await retry(() => environment.repository().associate(environment.proof));
  await assert.rejects(
    environment.repository().associate({ ...environment.proof, fingerprint: hash("changed") }),
    (error) => (error as any).code === "challenge_replay",
  );
  const challenge = { ...environment.challenge, challengeId: randomUUID() };
  await environment.repository().issue(challenge);
  await assert.rejects(
    environment.repository().associate({
      ...environment.proof,
      challengeId: challenge.challengeId,
      googleSubject: "another-google",
      fingerprint: hash("another"),
    }),
    (error) => (error as any).code === "identity_conflict",
  );
  assert.equal(
    (await environment.repository().find(environment.proof.binding.issuer, environment.proof.cognitoSubject))
      ?.person.id,
    first.id,
  );
  assert.equal(await environment.repository().find(environment.proof.binding.issuer, "unknown"), null);
});
test("real RSA HTTP-event contract uses durable repository and retains refresh-family checks", async () => {
  const environment = await fixture();
  const handler = googleIdentityHandler(
    environment.repository(),
    environment.identityFixture.products,
    environment.identityFixture.keys,
    () => environment.identityFixture.now,
  );
  const issued = JSON.parse(
    (await handler(environment.identityFixture.event(0, "/v1/identities/google/challenge"))).body,
  );
  const proof = environment.identityFixture.pair(0, issued.nonce);
  const resolved = await handler(
    environment.identityFixture.event(
      0,
      "/v1/identities/google/resolve",
      { challengeId: issued.challengeId },
      proof,
    ),
  );
  assert.equal(resolved.statusCode, 200);
  const fresh = googleIdentityHandler(
    environment.repository(),
    environment.identityFixture.products,
    environment.identityFixture.keys,
    () => environment.identityFixture.now,
  );
  assert.equal(
    (await fresh(environment.identityFixture.event(0, "/v1/identities/me", {}, proof, "GET"))).body,
    resolved.body,
  );
  const different = environment.identityFixture.pair(0, issued.nonce, "synthetic-google-a", {
    origin_jti: "new-family",
  });
  assert.equal(
    (await fresh(environment.identityFixture.event(0, "/v1/identities/me", {}, different, "GET"))).statusCode,
    401,
  );
});
test("interrupted native publication recovers from surviving Virtuus operation metadata", async () => {
  const environment = await fixture();
  await environment.repository().issue(environment.challenge);
  const files = new VirtuusIdentityFiles(environment.root, undefined, {
    path: `google/${googleIdentityKey(environment.proof.googleSubject)}.json`,
    point: "after_publication",
  });
  await assert.rejects(
    new DurableGoogleIdentities(files).associate(environment.proof),
    (error) => (error as any).code === "uncertain",
  );
  assert.equal(
    await environment.repository().find(environment.proof.binding.issuer, environment.proof.cognitoSubject),
    null,
  );
  const person = await environment.repository().recover(environment.challenge.challengeId);
  assert.ok(person?.id);
  assert.deepEqual(await environment.repository().associate(environment.proof), person);
});
test("a crashed pre-publication execution claim stays fail-closed without unsafe automatic reset", async () => {
  const environment = await fixture();
  await environment.repository().issue(environment.challenge);
  const files = new VirtuusIdentityFiles(environment.root, undefined, {
    path: `google/${googleIdentityKey(environment.proof.googleSubject)}.json`,
    point: "before_publication",
  });
  await assert.rejects(new DurableGoogleIdentities(files).associate(environment.proof));
  await assert.rejects(
    environment.repository().recover(environment.challenge.challengeId),
    (error) => (error as any).code === "uncertain",
  );
  assert.equal(
    await environment.repository().find(environment.proof.binding.issuer, environment.proof.cognitoSubject),
    null,
  );
});
test("account services consume the same committed Person, preserving roles revocation and last owner", async () => {
  const environment = await fixture();
  const operations = ["console:read", "console:write", "members:read", "members:write"] as const;
  const products = registrations(
    environment.identityFixture.products.map((product) => ({ ...product, capabilities: [...operations] })),
  );
  const handler = googleIdentityHandler(
    environment.repository(),
    products,
    environment.identityFixture.keys,
    () => environment.identityFixture.now,
  );
  const enroll = async (index: number, google: string) => {
    const challenge = JSON.parse(
      (await handler(environment.identityFixture.event(index, "/v1/identities/google/challenge"))).body,
    );
    const pair = environment.identityFixture.pair(index, challenge.nonce, google);
    const response = await handler(
      environment.identityFixture.event(
        index,
        "/v1/identities/google/resolve",
        { challengeId: challenge.challengeId },
        pair,
      ),
    );
    assert.equal(response.statusCode, 200);
    return {
      pair,
      person: JSON.parse(response.body).person,
      context: await context(
        environment.identityFixture.event(index, "/v1/accounts", {}, pair),
        products,
        environment.identityFixture.keys,
        environment.identityFixture.now,
      ),
    };
  };
  const alice = await enroll(0, "google-alice"),
    sameAlice = await enroll(1, "google-alice");
  assert.equal(alice.person.id, sameAlice.person.id);
  const accountFiles = new VirtuusAccountFiles(environment.root);
  const accounts = new DurableAccountsService(
    accountFiles,
    googlePersonDirectory(environment.repository(), products),
  );
  assert.deepEqual(await accounts.resolve(alice.context), alice.person);
  assert.deepEqual(await accounts.list(alice.context), { person: alice.person, accounts: [] });
  assert.deepEqual(await accountFiles.list("accounts/"), []);
  const transport = accountHandler(
    accounts,
    products,
    environment.identityFixture.keys,
    () => environment.identityFixture.now,
  );
  const createEvent = environment.identityFixture.event(
    0,
    "/v1/accounts",
    { name: "Synthetic continuity" },
    alice.pair,
  );
  createEvent.headers!["idempotency-key"] = randomUUID();
  const created = await transport(createEvent);
  assert.equal(created.statusCode, 200);
  const account = JSON.parse(created.body).account;
  const listed = await transport(environment.identityFixture.event(0, "/v1/accounts", {}, alice.pair, "GET"));
  assert.equal(JSON.parse(listed.body).person.id, alice.person.id);
  assert.equal(
    (await accounts.authorize(alice.context, account.id, "console:write")).personId,
    alice.person.id,
  );
  assert.equal((await accounts.resolve(sameAlice.context)).id, alice.person.id);
  await assert.rejects(
    accounts.get(sameAlice.context, account.id),
    (error) => (error as any).code === "forbidden",
  );
  await assert.rejects(
    accounts.setMembership(alice.context, account.id, alice.person.id, "member", "active"),
    (error) => (error as any).code === "last_owner",
  );
  const viewerChallenge = JSON.parse(
    (await handler(environment.identityFixture.event(0, "/v1/identities/google/challenge"))).body,
  );
  const viewerPair = environment.identityFixture.pair(
    0,
    viewerChallenge.nonce,
    "google-viewer",
    { sub: "synthetic-viewer" },
    { sub: "synthetic-viewer" },
  );
  const viewerResult = await handler(
    environment.identityFixture.event(
      0,
      "/v1/identities/google/resolve",
      { challengeId: viewerChallenge.challengeId },
      viewerPair,
    ),
  );
  assert.equal(viewerResult.statusCode, 200);
  const viewer = JSON.parse(viewerResult.body).person;
  const viewerContext = await context(
    environment.identityFixture.event(0, "/v1/accounts", {}, viewerPair),
    products,
    environment.identityFixture.keys,
    environment.identityFixture.now,
  );
  await accounts.setMembership(alice.context, account.id, viewer.id, "viewer", "active");
  assert.equal((await accounts.authorize(viewerContext, account.id, "console:read")).personId, viewer.id);
  await assert.rejects(
    accounts.authorize(viewerContext, account.id, "console:write"),
    (error) => (error as any).code === "forbidden",
  );
  await accounts.setMembership(alice.context, account.id, viewer.id, "viewer", "revoked");
  await assert.rejects(
    accounts.get(viewerContext, account.id),
    (error) => (error as any).code === "forbidden",
  );
});
test("pending canonical Person/alias cannot trigger account side effects", async () => {
  const environment = await fixture();
  await environment.repository().issue(environment.challenge);
  await worker(environment.root, "associate", environment.proof, { phase: "session", point: "after" });
  const accountFiles = new VirtuusAccountFiles(environment.root);
  const accounts = new DurableAccountsService(
    accountFiles,
    googlePersonDirectory(environment.repository(), environment.identityFixture.products),
  );
  const proof = environment.identityFixture.pair(0, environment.challenge.nonce);
  const ctx = await context(
    environment.identityFixture.event(0, "/v1/accounts", {}, proof),
    environment.identityFixture.products,
    environment.identityFixture.keys,
    environment.identityFixture.now,
  );
  await assert.rejects(
    accounts.create(ctx, "Must not create", randomUUID()),
    (error) => (error as any).code === "identity_enrollment_required",
  );
  assert.deepEqual(await accountFiles.list("accounts/"), []);
  const pending = (await environment.files.get(
    `google/${googleIdentityKey(environment.proof.googleSubject)}.json`,
  ))!.value.person;
  assert.equal(await environment.repository().getPerson(pending.id), null);
  await environment.repository().recover(environment.challenge.challengeId);
});
test("a pending new pool alias cannot borrow another pool's committed Person access", async () => {
  const environment = await fixture();
  await environment.repository().issue(environment.challenge);
  const person = await environment.repository().associate(environment.proof);
  const challenge = {
    ...environment.challenge,
    challengeId: randomUUID(),
    binding: {
      ...environment.challenge.binding,
      product: environment.identityFixture.products[1].product,
      principal: environment.identityFixture.products[1].roleArn,
      issuer: environment.identityFixture.products[1].issuer,
      clientId: environment.identityFixture.products[1].clientIds[0],
    },
  };
  const proof = {
    ...environment.proof,
    challengeId: challenge.challengeId,
    binding: challenge.binding,
    cognitoSubject: "synthetic-pool-person-1",
    lineageHash: hash("synthetic-family-1"),
    fingerprint: hash("second-pool"),
  };
  await environment.repository().issue(challenge);
  await worker(environment.root, "associate", proof, { phase: "session", point: "after" });
  assert.deepEqual(await environment.repository().getPerson(person.id), person);
  assert.equal(await environment.repository().find(proof.binding.issuer, proof.cognitoSubject), null);
  const token = environment.identityFixture.pair(1, challenge.nonce);
  const ctx = await context(
    environment.identityFixture.event(1, "/v1/accounts", {}, token),
    environment.identityFixture.products,
    environment.identityFixture.keys,
    environment.identityFixture.now,
  );
  const accountFiles = new VirtuusAccountFiles(environment.root);
  const accounts = new DurableAccountsService(
    accountFiles,
    googlePersonDirectory(environment.repository(), environment.identityFixture.products),
  );
  await assert.rejects(
    accounts.create(ctx, "Pending second pool", randomUUID()),
    (error) => (error as any).code === "identity_enrollment_required",
  );
  assert.deepEqual(await accountFiles.list("accounts/"), []);
  await environment.repository().recover(challenge.challengeId);
  assert.equal((await accounts.resolve(ctx)).id, person.id);
});
test("completed canonical files remain authoritative after a quiescent ordinary copy without journals", async () => {
  const environment = await fixture();
  await environment.repository().issue(environment.challenge);
  const person = await environment.repository().associate(environment.proof);
  const destination = await mkdtemp(join(tmpdir(), "prospectus-identity-copy-"));
  roots.push(destination);
  await cp(join(environment.root, "local"), join(destination, "local"), { recursive: true });
  const imported = new DurableGoogleIdentities(new VirtuusIdentityFiles(destination));
  assert.deepEqual(await imported.getPerson(person.id), person);
  assert.equal(
    (await imported.find(environment.proof.binding.issuer, environment.proof.cognitoSubject))?.person.id,
    person.id,
  );
  assert.deepEqual(await imported.associate(environment.proof), person);
});
test("a conflicted new login family cannot use an older alias to cause account writes", async () => {
  const environment = await fixture();
  await environment.repository().issue(environment.challenge);
  await environment.repository().associate(environment.proof);
  const challenge = { ...environment.challenge, challengeId: randomUUID() };
  await environment.repository().issue(challenge);
  const proof = {
    ...environment.proof,
    challengeId: challenge.challengeId,
    googleSubject: "conflicting-google",
    lineageHash: hash("conflicted-family"),
    fingerprint: hash("conflicted-proof"),
  };
  await assert.rejects(
    environment.repository().associate(proof),
    (error) => (error as any).code === "identity_conflict",
  );
  const pair = environment.identityFixture.pair(
    0,
    challenge.nonce,
    "conflicting-google",
    { origin_jti: "conflicted-family" },
    { origin_jti: "conflicted-family" },
  );
  const ctx = await context(
    environment.identityFixture.event(0, "/v1/accounts", {}, pair),
    environment.identityFixture.products,
    environment.identityFixture.keys,
    environment.identityFixture.now,
  );
  const accountFiles = new VirtuusAccountFiles(environment.root);
  const service = new DurableAccountsService(
    accountFiles,
    googlePersonDirectory(environment.repository(), environment.identityFixture.products),
  );
  await assert.rejects(
    service.create(ctx, "Must not write", randomUUID()),
    (error) => (error as any).code === "identity_enrollment_required",
  );
  assert.deepEqual(await accountFiles.list("accounts/"), []);
});
test("independent conflicting Google sign-ins cannot overwrite one pool alias", async () => {
  const environment = await fixture();
  const second = { ...environment.challenge, challengeId: randomUUID() };
  await environment.repository().issue(environment.challenge);
  await environment.repository().issue(second);
  const competing = {
    ...environment.proof,
    challengeId: second.challengeId,
    googleSubject: "competing-google",
    fingerprint: hash("competing"),
  };
  await Promise.all([
    worker(environment.root, "associate", environment.proof),
    worker(environment.root, "associate", competing),
  ]);
  const results = await Promise.allSettled([
    retry(() => environment.repository().associate(environment.proof)),
    retry(() => environment.repository().associate(competing)),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const winner = results.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<{
    id: string;
  }>;
  assert.equal(
    (await environment.repository().find(environment.proof.binding.issuer, environment.proof.cognitoSubject))
      ?.person.id,
    winner.value.id,
  );
});
test("a committed receipt cannot authorize when any required canonical link is missing", async () => {
  const environment = await fixture();
  await environment.repository().issue(environment.challenge);
  const person = await environment.repository().associate(environment.proof);
  for (const kind of ["google/", "aliases/", "people/", "logins/", "sessions/"]) {
    const missing: IdentityFiles = {
      get: async (path) => (path.startsWith(kind) ? null : environment.files.get(path)),
      list: environment.files.list.bind(environment.files),
      commit: environment.files.commit.bind(environment.files),
    };
    const result = await new DurableGoogleIdentities(missing)
      .find(environment.proof.binding.issuer, environment.proof.cognitoSubject)
      .catch(() => null);
    assert.equal(result, null);
    const known = await new DurableGoogleIdentities(missing).getPerson(person.id).catch(() => null);
    assert.equal(known, null);
  }
});

test("repeated committed sessions share bounded reads only within one canonical lookup", async () => {
  const environment = await fixture();
  await environment.repository().issue(environment.challenge);
  const person = await environment.repository().associate(environment.proof);
  for (let index = 1; index < 8; index++) {
    const challenge = { ...environment.challenge, challengeId: randomUUID(), nonce: randomUUID() };
    await environment.repository().issue(challenge);
    await environment.repository().associate({
      ...environment.proof,
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      authTime: environment.identityFixture.now + index,
      lineageHash: hash(["family", index]),
      fingerprint: hash(["proof", index]),
    });
  }
  const counts = new Map<string, number>();
  let active = 0,
    maximum = 0,
    missingPerson = false;
  const files: IdentityFiles = {
    get: async (path) => {
      counts.set(path, (counts.get(path) ?? 0) + 1);
      active++;
      maximum = Math.max(maximum, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return missingPerson && path.startsWith("people/") ? null : await environment.files.get(path);
      } finally {
        active--;
      }
    },
    list: environment.files.list.bind(environment.files),
    commit: async () => {
      throw new Error("Lookup must never write");
    },
  };
  const repository = new DurableGoogleIdentities(files);
  const result = await repository.find(environment.proof.binding.issuer, environment.proof.cognitoSubject);
  assert.ok(result);
  assert.equal(result.person.id, person.id);
  assert.equal(result.alias.sessions.length, 8);
  assert.ok(
    [...counts.values()].every((count) => count === 1),
    "Each canonical record must be read once per lookup",
  );
  assert.ok(maximum > 1, `Expected overlapping reads, observed ${maximum}`);
  assert.ok(maximum <= 4, `Expected bounded overlap, observed ${maximum}`);
  counts.clear();
  missingPerson = true;
  await assert.rejects(
    repository.find(environment.proof.binding.issuer, environment.proof.cognitoSubject),
    (error) => (error as any).code === "identity_inconsistent",
  );
  assert.ok(
    [...counts.keys()].some((path) => path.startsWith("people/")),
    "A later lookup must reread canonical authority",
  );
});

test("person lookup reads session pointers in bounded batches and stops at the first committed login", async () => {
  const environment = await fixture();
  await environment.repository().issue(environment.challenge);
  const person = await environment.repository().associate(environment.proof);
  for (let index = 1; index < 9; index++) {
    const challenge = { ...environment.challenge, challengeId: randomUUID(), nonce: randomUUID() };
    await environment.repository().issue(challenge);
    await environment.repository().associate({
      ...environment.proof,
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      authTime: environment.identityFixture.now + index,
      lineageHash: hash(["family", index]),
      fingerprint: hash(["proof", index]),
    });
  }
  const readCounts = new Map<string, number>();
  let active = 0,
    maximum = 0;
  const files: IdentityFiles = {
    get: async (path) => {
      readCounts.set(path, (readCounts.get(path) ?? 0) + 1);
      active++;
      maximum = Math.max(maximum, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return await environment.files.get(path);
      } finally {
        active--;
      }
    },
    list: environment.files.list.bind(environment.files),
    commit: async () => {
      throw new Error("Lookup must never write");
    },
  };
  const found = await new DurableGoogleIdentities(files).getPerson(person.id);
  assert.deepEqual(found, person);
  const sessionPointerReads = [...readCounts.keys()].filter((path) => path.startsWith("sessions/"));
  assert.ok(sessionPointerReads.length <= 4, `Expected one batch, read ${sessionPointerReads.length}`);
  assert.ok(
    [...readCounts.values()].every((count) => count === 1),
    "Each canonical record must be read once per lookup",
  );
  assert.ok(maximum > 1, `Expected overlapping reads, observed ${maximum}`);
  assert.ok(maximum <= 4, `Expected bounded overlap, observed ${maximum}`);
});
test("durable canonical files keep the login state digest and reject a different login state without consuming", async () => {
  const environment = await fixture();
  const handler = googleIdentityHandler(
    environment.repository(),
    environment.identityFixture.products,
    environment.identityFixture.keys,
    () => environment.identityFixture.now,
  );
  const loginState = "synthetic-login-state-0123456789abcdefghijklmnop";
  const issued = JSON.parse(
    (
      await handler(
        environment.identityFixture.event(0, "/v1/identities/google/challenge", {
          loginStateDigest: createHash("sha256").update(loginState).digest("hex"),
        }),
      )
    ).body,
  );
  const proof = environment.identityFixture.pair(0, issued.nonce);
  const resolve = (state: string | undefined, repositoryHandler = handler) =>
    repositoryHandler(
      environment.identityFixture.event(
        0,
        "/v1/identities/google/resolve",
        { challengeId: issued.challengeId, ...(state ? { loginState: state } : {}) },
        proof,
      ),
    );
  assert.equal((await resolve(undefined)).statusCode, 401);
  assert.equal((await resolve("another-login-state-0123456789abcdefghij")).statusCode, 401);
  const restarted = googleIdentityHandler(
    environment.repository(),
    environment.identityFixture.products,
    environment.identityFixture.keys,
    () => environment.identityFixture.now,
  );
  const accepted = await resolve(loginState, restarted);
  assert.equal(accepted.statusCode, 200);
  assert.equal((await resolve(loginState)).body, accepted.body);
});

test("a signed challenge writes nothing until resolved, then creates the login receipt once at the existing path", async () => {
  const environment = await fixture();
  const repository = environment.repository();
  const path = `logins/${environment.challenge.challengeId}.json`;
  const signed = { ...environment.proof, challenge: environment.challenge };
  assert.deepEqual(await environment.files.list("logins/"), []);
  await assert.rejects(
    repository.associate({ ...signed, nonce: "another-nonce" }),
    (error: any) => error.status === 401,
  );
  await assert.rejects(
    repository.associate({ ...signed, now: environment.challenge.expiresAt }),
    (error: any) => error.status === 401,
  );
  assert.deepEqual(await environment.files.list("logins/"), [], "rejected evidence leaves no file");
  const person = await repository.associate(signed);
  const record = await environment.files.get(path);
  assert.deepEqual(await environment.files.list("logins/"), [path]);
  assert.equal(record!.value.version, 1);
  assert.equal(record!.value.kind, "login");
  assert.equal(record!.value.state, "committed");
  assert.deepEqual(record!.value.challenge, environment.challenge);
  assert.deepEqual(await environment.repository().associate(signed), person);
  await assert.rejects(
    environment.repository().associate({ ...signed, fingerprint: hash("another evidence") }),
    (error: any) => error.status === 409 && error.code === "challenge_replay",
  );
  assert.deepEqual(await environment.files.list("logins/"), [path]);
});

test("a signed challenge cannot take over a stored login record whose challenge differs", async () => {
  const environment = await fixture();
  await environment.repository().issue(environment.challenge);
  await assert.rejects(
    environment.repository().associate({
      ...environment.proof,
      challenge: { ...environment.challenge, nonce: "forged" },
    }),
    (error: any) => error.status === 401,
  );
  const person = await environment
    .repository()
    .associate({ ...environment.proof, challenge: environment.challenge });
  assert.ok(person.id);
});

test("concurrent first resolves of one signed challenge converge on one login record", async () => {
  const environment = await fixture();
  const signed = { ...environment.proof, challenge: environment.challenge };
  const results = await Promise.allSettled([
    retry(() => environment.repository().associate(signed)),
    retry(() => environment.repository().associate(signed)),
    retry(() => environment.repository().associate({ ...signed, fingerprint: hash("rival evidence") })),
  ]);
  const people = results
    .filter((result) => result.status === "fulfilled")
    .map((result: any) => result.value.id);
  assert.ok(people.length >= 1);
  assert.equal(new Set(people).size, 1);
  for (const result of results.filter((result) => result.status === "rejected"))
    assert.equal((result as any).reason.status, 409);
  assert.equal((await environment.files.list("logins/")).length, 1);
});
