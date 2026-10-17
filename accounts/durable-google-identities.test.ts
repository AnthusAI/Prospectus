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
import { VirtuusIdentityFiles, IdentityFileError, type IdentityFiles } from "./identity-files";
import { googleIdentityHandler, type GoogleAssociation, type LoginChallenge } from "./google-identity";
import { googleFixture } from "./testing/google-fixture";
import { MemoryAccountStore } from "./testing/memory-account-store";
import { googlePersonDirectory } from "./person-directory";
import { AccountsService } from "./service";
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
  const f = googleFixture();
  const binding = {
    product: f.products[0].product,
    principal: f.products[0].roleArn,
    issuer: f.products[0].issuer,
    clientId: f.products[0].clientIds[0],
    policyRevision: f.products[0].googleFederation!.reviewedPolicyId,
  };
  const challenge: LoginChallenge = {
    challengeId: randomUUID(),
    nonce: randomUUID(),
    issuedAt: f.now,
    expiresAt: f.now + 300,
    binding,
  };
  const proof: GoogleAssociation = {
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    binding,
    cognitoSubject: "synthetic-pool-person-0",
    googleSubject: "synthetic-google-a",
    authTime: f.now,
    lineageHash: hash("synthetic-family-0"),
    fingerprint: hash(randomUUID()),
    now: f.now,
  };
  const files = new VirtuusIdentityFiles(root);
  const repository = () => new DurableGoogleIdentities(new VirtuusIdentityFiles(root));
  return { root, f, challenge, proof, files, repository };
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
  const x = await fixture();
  await x.repository().issue(x.challenge);
  const first = await x.repository().associate(x.proof);
  const c = {
    ...x.challenge,
    challengeId: randomUUID(),
    binding: {
      ...x.challenge.binding,
      ...{
        product: x.f.products[1].product,
        principal: x.f.products[1].roleArn,
        issuer: x.f.products[1].issuer,
        clientId: x.f.products[1].clientIds[0],
      },
    },
  };
  await x.repository().issue(c);
  const second = await x.repository().associate({
    ...x.proof,
    challengeId: c.challengeId,
    binding: c.binding,
    cognitoSubject: "synthetic-pool-person-1",
    fingerprint: hash(randomUUID()),
  });
  assert.deepEqual(first, second);
  assert.deepEqual(await x.repository().getPerson(first.id), first);
  assert.equal((await x.repository().find(c.binding.issuer, "synthetic-pool-person-1"))?.person.id, first.id);
  const google = await x.files.get(`google/${googleIdentityKey(x.proof.googleSubject)}.json`);
  assert.equal(google?.value.person.id, first.id);
});
for (const phase of ["issue", "prepare", "google", "alias", "person", "session", "complete"] as const)
  for (const point of ["before", "after"] as const)
    test(`process crash ${point} ${phase} cannot authorize partial enrollment; restart resumes`, async () => {
      const x = await fixture();
      if (phase !== "issue") await x.repository().issue(x.challenge);
      const crash = await worker(
        x.root,
        phase === "issue" ? "issue" : "associate",
        phase === "issue" ? x.challenge : x.proof,
        { phase, point },
      );
      assert.equal(crash.code, 86);
      if (!(phase === "complete" && point === "after"))
        assert.equal(await x.repository().find(x.proof.binding.issuer, x.proof.cognitoSubject), null);
      if (phase === "issue") await x.repository().issue(x.challenge);
      const person = await retry(() => x.repository().associate(x.proof));
      assert.ok(person.id);
      assert.equal(
        (await x.repository().find(x.proof.binding.issuer, x.proof.cognitoSubject))?.person.id,
        person.id,
      );
      assert.deepEqual(await x.repository().recover(x.challenge.challengeId), person);
    });
test("lost journal response is recovered after restart without replacing the winning Person", async () => {
  const x = await fixture();
  await x.repository().issue(x.challenge);
  let lost = false;
  const uncertain: IdentityFiles = {
    get: x.files.get.bind(x.files),
    list: x.files.list.bind(x.files),
    commit: async (...args) => {
      const value = await x.files.commit(...args);
      if (!lost && args[0].startsWith("google/")) {
        lost = true;
        throw new IdentityFileError("uncertain");
      }
      return value;
    },
  };
  await assert.rejects(new DurableGoogleIdentities(uncertain).associate(x.proof));
  assert.equal(await x.repository().find(x.proof.binding.issuer, x.proof.cognitoSubject), null);
  const saved = (await x.files.get(`google/${googleIdentityKey(x.proof.googleSubject)}.json`))!.value.person;
  assert.deepEqual(await x.repository().recover(x.challenge.challengeId), saved);
  assert.deepEqual(await x.repository().associate(x.proof), saved);
});
test("prepared recovery after expiry does not make expired API evidence valid", async () => {
  const x = await fixture();
  await x.repository().issue(x.challenge);
  await worker(x.root, "associate", x.proof, { phase: "prepare", point: "after" });
  await assert.rejects(
    x.repository().associate({ ...x.proof, now: x.challenge.expiresAt + 1 }),
    (error) => (error as any).code === "challenge_invalid",
  );
  assert.equal(await x.repository().find(x.proof.binding.issuer, x.proof.cognitoSubject), null);
  assert.ok((await x.repository().recover(x.challenge.challengeId))?.id);
  const handler = googleIdentityHandler(x.repository(), x.f.products, x.f.keys, () => x.f.now + 4000);
  const response = await handler(
    x.f.event(0, "/v1/identities/me", {}, x.f.pair(0, x.challenge.nonce), "GET"),
  );
  assert.equal(response.statusCode, 401);
});
test("independent processes converge on one Google Person with different pool aliases", async () => {
  const x = await fixture();
  const proofs: GoogleAssociation[] = [];
  for (let index = 0; index < 8; index++) {
    const challenge = {
      ...x.challenge,
      challengeId: randomUUID(),
      binding: {
        ...x.challenge.binding,
        issuer: `https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Synthetic${index}`,
      },
    };
    await x.repository().issue(challenge);
    proofs.push({
      ...x.proof,
      challengeId: challenge.challengeId,
      binding: challenge.binding,
      cognitoSubject: `synthetic-${index}`,
      fingerprint: hash(index),
    });
  }
  await Promise.all(proofs.map((proof) => worker(x.root, "associate", proof)));
  const results = [];
  for (const proof of proofs) results.push(await retry(() => x.repository().associate(proof)));
  assert.equal(new Set(results.map((person) => person.id)).size, 1);
  for (const proof of proofs)
    assert.equal(
      (await x.repository().find(proof.binding.issuer, proof.cognitoSubject))?.person.id,
      results[0].id,
    );
});
test("concurrent identical login replays converge; conflicting proof and alias never merge", async () => {
  const x = await fixture();
  await x.repository().issue(x.challenge);
  await Promise.all(Array.from({ length: 6 }, () => worker(x.root, "associate", x.proof)));
  const first = await retry(() => x.repository().associate(x.proof));
  await assert.rejects(
    x.repository().associate({ ...x.proof, fingerprint: hash("changed") }),
    (error) => (error as any).code === "challenge_replay",
  );
  const c = { ...x.challenge, challengeId: randomUUID() };
  await x.repository().issue(c);
  await assert.rejects(
    x.repository().associate({
      ...x.proof,
      challengeId: c.challengeId,
      googleSubject: "another-google",
      fingerprint: hash("another"),
    }),
    (error) => (error as any).code === "identity_conflict",
  );
  assert.equal(
    (await x.repository().find(x.proof.binding.issuer, x.proof.cognitoSubject))?.person.id,
    first.id,
  );
  assert.equal(await x.repository().find(x.proof.binding.issuer, "unknown"), null);
});
test("real RSA HTTP-event contract uses durable repository and retains refresh-family checks", async () => {
  const x = await fixture();
  const handler = googleIdentityHandler(x.repository(), x.f.products, x.f.keys, () => x.f.now);
  const issued = JSON.parse((await handler(x.f.event(0, "/v1/identities/google/challenge"))).body);
  const proof = x.f.pair(0, issued.nonce);
  const resolved = await handler(
    x.f.event(0, "/v1/identities/google/resolve", { challengeId: issued.challengeId }, proof),
  );
  assert.equal(resolved.statusCode, 200);
  const fresh = googleIdentityHandler(x.repository(), x.f.products, x.f.keys, () => x.f.now);
  assert.equal((await fresh(x.f.event(0, "/v1/identities/me", {}, proof, "GET"))).body, resolved.body);
  const different = x.f.pair(0, issued.nonce, "synthetic-google-a", { origin_jti: "new-family" });
  assert.equal((await fresh(x.f.event(0, "/v1/identities/me", {}, different, "GET"))).statusCode, 401);
});
test("interrupted native publication recovers from surviving Virtuus operation metadata", async () => {
  const x = await fixture();
  await x.repository().issue(x.challenge);
  const files = new VirtuusIdentityFiles(x.root, undefined, {
    path: `google/${googleIdentityKey(x.proof.googleSubject)}.json`,
    point: "after_publication",
  });
  await assert.rejects(
    new DurableGoogleIdentities(files).associate(x.proof),
    (error) => (error as any).code === "uncertain",
  );
  assert.equal(await x.repository().find(x.proof.binding.issuer, x.proof.cognitoSubject), null);
  const person = await x.repository().recover(x.challenge.challengeId);
  assert.ok(person?.id);
  assert.deepEqual(await x.repository().associate(x.proof), person);
});
test("a crashed pre-publication execution claim stays fail-closed without unsafe automatic reset", async () => {
  const x = await fixture();
  await x.repository().issue(x.challenge);
  const files = new VirtuusIdentityFiles(x.root, undefined, {
    path: `google/${googleIdentityKey(x.proof.googleSubject)}.json`,
    point: "before_publication",
  });
  await assert.rejects(new DurableGoogleIdentities(files).associate(x.proof));
  await assert.rejects(
    x.repository().recover(x.challenge.challengeId),
    (error) => (error as any).code === "uncertain",
  );
  assert.equal(await x.repository().find(x.proof.binding.issuer, x.proof.cognitoSubject), null);
});
test("account services consume the same committed Person, preserving roles revocation and last owner", async () => {
  const x = await fixture();
  const operations = ["console:read", "console:write", "members:read", "members:write"] as const;
  const products = x.f.products.map((product) => ({ ...product, capabilities: [...operations] }));
  const handler = googleIdentityHandler(x.repository(), products, x.f.keys, () => x.f.now);
  const enroll = async (index: number, google: string) => {
    const c = JSON.parse((await handler(x.f.event(index, "/v1/identities/google/challenge"))).body);
    const pair = x.f.pair(index, c.nonce, google);
    const response = await handler(
      x.f.event(index, "/v1/identities/google/resolve", { challengeId: c.challengeId }, pair),
    );
    assert.equal(response.statusCode, 200);
    return {
      pair,
      person: JSON.parse(response.body).person,
      context: await context(x.f.event(index, "/v1/accounts", {}, pair), products, x.f.keys, x.f.now),
    };
  };
  const alice = await enroll(0, "google-alice"),
    sameAlice = await enroll(1, "google-alice");
  assert.equal(alice.person.id, sameAlice.person.id);
  const store = new MemoryAccountStore();
  const accounts = new AccountsService(store, undefined, googlePersonDirectory(x.repository(), products));
  assert.deepEqual(await accounts.resolve(alice.context), alice.person);
  assert.deepEqual(await accounts.list(alice.context), { person: alice.person, accounts: [] });
  assert.equal(store.count, 0);
  const transport = accountHandler(accounts, products, x.f.keys, () => x.f.now);
  const createEvent = x.f.event(0, "/v1/accounts", { name: "Synthetic continuity" }, alice.pair);
  createEvent.headers!["idempotency-key"] = randomUUID();
  const created = await transport(createEvent);
  assert.equal(created.statusCode, 200);
  const account = JSON.parse(created.body).account;
  const listed = await transport(x.f.event(0, "/v1/accounts", {}, alice.pair, "GET"));
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
  const viewerChallenge = JSON.parse((await handler(x.f.event(0, "/v1/identities/google/challenge"))).body);
  const viewerPair = x.f.pair(
    0,
    viewerChallenge.nonce,
    "google-viewer",
    { sub: "synthetic-viewer" },
    { sub: "synthetic-viewer" },
  );
  const viewerResult = await handler(
    x.f.event(0, "/v1/identities/google/resolve", { challengeId: viewerChallenge.challengeId }, viewerPair),
  );
  assert.equal(viewerResult.statusCode, 200);
  const viewer = JSON.parse(viewerResult.body).person;
  const viewerContext = await context(
    x.f.event(0, "/v1/accounts", {}, viewerPair),
    products,
    x.f.keys,
    x.f.now,
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
test("pending canonical Person/alias and conflicting legacy Person cannot trigger account side effects", async () => {
  const x = await fixture();
  await x.repository().issue(x.challenge);
  await worker(x.root, "associate", x.proof, { phase: "session", point: "after" });
  const store = new MemoryAccountStore();
  const accounts = new AccountsService(store, undefined, googlePersonDirectory(x.repository(), x.f.products));
  const proof = x.f.pair(0, x.challenge.nonce);
  const ctx = await context(x.f.event(0, "/v1/accounts", {}, proof), x.f.products, x.f.keys, x.f.now);
  await assert.rejects(
    accounts.create(ctx, "Must not create", randomUUID()),
    (error) => (error as any).code === "identity_enrollment_required",
  );
  assert.equal(store.count, 0);
  const pending = (await x.files.get(`google/${googleIdentityKey(x.proof.googleSubject)}.json`))!.value
    .person;
  assert.equal(await x.repository().getPerson(pending.id), null);
  await x.repository().recover(x.challenge.challengeId);
  await store.transact([
    {
      pk: `IDENTITY#${hash([ctx.human.issuer, ctx.human.subject])}`,
      sk: "META",
      version: null,
      value: {
        issuer: ctx.human.issuer,
        subject: ctx.human.subject,
        personId: randomUUID(),
        createdAt: pending.createdAt,
      },
    },
  ]);
  const before = store.count;
  await assert.rejects(
    accounts.create(ctx, "Conflicting Person", randomUUID()),
    (error) => (error as any).code === "person_conflict",
  );
  assert.equal(store.count, before);
});
test("a pending new pool alias cannot borrow another pool's committed Person access", async () => {
  const x = await fixture();
  await x.repository().issue(x.challenge);
  const person = await x.repository().associate(x.proof);
  const c = {
    ...x.challenge,
    challengeId: randomUUID(),
    binding: {
      ...x.challenge.binding,
      product: x.f.products[1].product,
      principal: x.f.products[1].roleArn,
      issuer: x.f.products[1].issuer,
      clientId: x.f.products[1].clientIds[0],
    },
  };
  const proof = {
    ...x.proof,
    challengeId: c.challengeId,
    binding: c.binding,
    cognitoSubject: "synthetic-pool-person-1",
    lineageHash: hash("synthetic-family-1"),
    fingerprint: hash("second-pool"),
  };
  await x.repository().issue(c);
  await worker(x.root, "associate", proof, { phase: "session", point: "after" });
  assert.deepEqual(await x.repository().getPerson(person.id), person);
  assert.equal(await x.repository().find(proof.binding.issuer, proof.cognitoSubject), null);
  const token = x.f.pair(1, c.nonce);
  const ctx = await context(x.f.event(1, "/v1/accounts", {}, token), x.f.products, x.f.keys, x.f.now);
  const store = new MemoryAccountStore();
  const accounts = new AccountsService(store, undefined, googlePersonDirectory(x.repository(), x.f.products));
  await assert.rejects(
    accounts.create(ctx, "Pending second pool", randomUUID()),
    (error) => (error as any).code === "identity_enrollment_required",
  );
  assert.equal(store.count, 0);
  await x.repository().recover(c.challengeId);
  assert.equal((await accounts.resolve(ctx)).id, person.id);
});
test("completed canonical files remain authoritative after a quiescent ordinary copy without journals", async () => {
  const x = await fixture();
  await x.repository().issue(x.challenge);
  const person = await x.repository().associate(x.proof);
  const destination = await mkdtemp(join(tmpdir(), "prospectus-identity-copy-"));
  roots.push(destination);
  await cp(join(x.root, "local"), join(destination, "local"), { recursive: true });
  const imported = new DurableGoogleIdentities(new VirtuusIdentityFiles(destination));
  assert.deepEqual(await imported.getPerson(person.id), person);
  assert.equal((await imported.find(x.proof.binding.issuer, x.proof.cognitoSubject))?.person.id, person.id);
  assert.deepEqual(await imported.associate(x.proof), person);
});
test("a conflicted new login family cannot use an older alias to cause account writes", async () => {
  const x = await fixture();
  await x.repository().issue(x.challenge);
  await x.repository().associate(x.proof);
  const challenge = { ...x.challenge, challengeId: randomUUID() };
  await x.repository().issue(challenge);
  const proof = {
    ...x.proof,
    challengeId: challenge.challengeId,
    googleSubject: "conflicting-google",
    lineageHash: hash("conflicted-family"),
    fingerprint: hash("conflicted-proof"),
  };
  await assert.rejects(
    x.repository().associate(proof),
    (error) => (error as any).code === "identity_conflict",
  );
  const pair = x.f.pair(
    0,
    challenge.nonce,
    "conflicting-google",
    { origin_jti: "conflicted-family" },
    { origin_jti: "conflicted-family" },
  );
  const ctx = await context(x.f.event(0, "/v1/accounts", {}, pair), x.f.products, x.f.keys, x.f.now);
  const store = new MemoryAccountStore();
  const service = new AccountsService(store, undefined, googlePersonDirectory(x.repository(), x.f.products));
  await assert.rejects(
    service.create(ctx, "Must not write", randomUUID()),
    (error) => (error as any).code === "identity_enrollment_required",
  );
  assert.equal(store.count, 0);
});
test("independent conflicting Google sign-ins cannot overwrite one pool alias", async () => {
  const x = await fixture();
  const second = { ...x.challenge, challengeId: randomUUID() };
  await x.repository().issue(x.challenge);
  await x.repository().issue(second);
  const competing = {
    ...x.proof,
    challengeId: second.challengeId,
    googleSubject: "competing-google",
    fingerprint: hash("competing"),
  };
  await Promise.all([worker(x.root, "associate", x.proof), worker(x.root, "associate", competing)]);
  const results = await Promise.allSettled([
    retry(() => x.repository().associate(x.proof)),
    retry(() => x.repository().associate(competing)),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const winner = results.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<{
    id: string;
  }>;
  assert.equal(
    (await x.repository().find(x.proof.binding.issuer, x.proof.cognitoSubject))?.person.id,
    winner.value.id,
  );
});
test("a committed receipt cannot authorize when any required canonical link is missing", async () => {
  const x = await fixture();
  await x.repository().issue(x.challenge);
  const person = await x.repository().associate(x.proof);
  for (const kind of ["google/", "aliases/", "people/", "logins/", "sessions/"]) {
    const missing: IdentityFiles = {
      get: async (path) => (path.startsWith(kind) ? null : x.files.get(path)),
      list: x.files.list.bind(x.files),
      commit: x.files.commit.bind(x.files),
    };
    const result = await new DurableGoogleIdentities(missing)
      .find(x.proof.binding.issuer, x.proof.cognitoSubject)
      .catch(() => null);
    assert.equal(result, null);
    const known = await new DurableGoogleIdentities(missing).getPerson(person.id).catch(() => null);
    assert.equal(known, null);
  }
});

test("repeated committed sessions share bounded reads only within one canonical lookup", async () => {
  const x = await fixture();
  await x.repository().issue(x.challenge);
  const person = await x.repository().associate(x.proof);
  for (let index = 1; index < 8; index++) {
    const challenge = { ...x.challenge, challengeId: randomUUID(), nonce: randomUUID() };
    await x.repository().issue(challenge);
    await x.repository().associate({
      ...x.proof,
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      authTime: x.f.now + index,
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
        return missingPerson && path.startsWith("people/") ? null : await x.files.get(path);
      } finally {
        active--;
      }
    },
    list: x.files.list.bind(x.files),
    commit: async () => {
      throw new Error("Lookup must never write");
    },
  };
  const repository = new DurableGoogleIdentities(files);
  const result = await repository.find(x.proof.binding.issuer, x.proof.cognitoSubject);
  assert.ok(result);
  assert.equal(result.person.id, person.id);
  assert.equal(result.alias.sessions.length, 8);
  assert.ok(
    [...counts.values()].every((count) => count === 1),
    "Each canonical record must be read once per lookup",
  );
  assert.ok(maximum > 1 && maximum <= 4, `Expected bounded overlap, observed ${maximum}`);
  counts.clear();
  missingPerson = true;
  await assert.rejects(
    repository.find(x.proof.binding.issuer, x.proof.cognitoSubject),
    (error) => (error as any).code === "identity_inconsistent",
  );
  assert.ok(
    [...counts.keys()].some((path) => path.startsWith("people/")),
    "A later lookup must reread canonical authority",
  );
});

test("person lookup reads session pointers in bounded batches and stops at the first committed login", async () => {
  const x = await fixture();
  await x.repository().issue(x.challenge);
  const person = await x.repository().associate(x.proof);
  for (let index = 1; index < 9; index++) {
    const challenge = { ...x.challenge, challengeId: randomUUID(), nonce: randomUUID() };
    await x.repository().issue(challenge);
    await x.repository().associate({
      ...x.proof,
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      authTime: x.f.now + index,
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
        return await x.files.get(path);
      } finally {
        active--;
      }
    },
    list: x.files.list.bind(x.files),
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
  assert.ok(maximum > 1 && maximum <= 4, `Expected bounded overlap, observed ${maximum}`);
});
