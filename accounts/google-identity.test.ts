import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { googleFixture } from "./testing/google-fixture";
import { googleIdentityHandler } from "./google-identity";
import { registrations } from "./registration";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

test("same Google account across two pools resolves one person with provenance and no memberships", async () => {
  const f = googleFixture();
  const a = await f.challenge(0),
    b = await f.challenge(1);
  const first = await f.resolve(0, a.challengeId, f.pair(0, a.nonce));
  const second = await f.resolve(1, b.challengeId, f.pair(1, b.nonce));
  assert.equal(first.status, 200);
  assert.deepEqual(second, first);
  assert.deepEqual(f.repository.counts, { people: 1, googleIdentities: 1, aliases: 2, associations: 2 });
  const alias = await f.repository.find(f.products[1].issuer, "synthetic-pool-person-1");
  assert.equal(alias?.alias.googleIssuer, "https://accounts.google.com");
  assert.equal(alias?.alias.provenance[0].product, "papyrus");
  assert.deepEqual(Object.keys(first.body), ["person"]);
});
test("different Google subjects and matching email remain distinct", async () => {
  const f = googleFixture();
  const a = await f.challenge(0),
    b = await f.challenge(1);
  const one = await f.resolve(0, a.challengeId, f.pair(0, a.nonce, "synthetic-a"));
  const two = await f.resolve(1, b.challengeId, f.pair(1, b.nonce, "synthetic-b"));
  assert.equal(one.status, 200);
  assert.equal(two.status, 200);
  assert.notEqual(one.body.person.id, two.body.person.id);
});
test("concurrent handlers and identical lost-response retries consume once; changed replay denies", async () => {
  const f = googleFixture();
  const c = await f.challenge();
  const proof = f.pair(0, c.nonce);
  const handlers = Array.from({ length: 16 }, () =>
    googleIdentityHandler(f.repository, f.products, f.keys, () => f.now),
  );
  const results = await Promise.all(
    handlers.map((handler) =>
      handler(f.event(0, "/v1/identities/google/resolve", { challengeId: c.challengeId }, proof)),
    ),
  );
  assert.ok(results.every((result) => result.statusCode === 200));
  assert.equal(new Set(results.map((result) => result.body)).size, 1);
  assert.equal(f.repository.counts.associations, 1);
  const replay = await f.resolve(0, c.challengeId, proof);
  assert.equal(replay.status, 200);
  const changed = await f.resolve(0, c.challengeId, f.pair(0, c.nonce));
  assert.equal(changed.status, 409);
  assert.equal(changed.body.error, "challenge_replay");
});
test("same Google enrollment races in different pools reserve one canonical person", async () => {
  const f = googleFixture();
  const a = await f.challenge(0),
    b = await f.challenge(1);
  const result = await Promise.all([
    f.resolve(0, a.challengeId, f.pair(0, a.nonce)),
    f.resolve(1, b.challengeId, f.pair(1, b.nonce)),
  ]);
  assert.ok(result.every((r) => r.status === 200));
  assert.equal(result[0].body.person.id, result[1].body.person.id);
});
test("an existing Cognito alias cannot switch Google identity or silently merge existing people", async () => {
  const f = googleFixture();
  const a = await f.challenge(0),
    b = await f.challenge(1);
  await f.resolve(0, a.challengeId, f.pair(0, a.nonce, "google-a"));
  await f.resolve(1, b.challengeId, f.pair(1, b.nonce, "google-b"));
  const c = await f.challenge(0);
  const denied = await f.resolve(0, c.challengeId, f.pair(0, c.nonce, "google-b"));
  assert.equal(denied.status, 409);
  assert.equal(denied.body.error, "identity_conflict");
  assert.equal(f.repository.counts.people, 2);
  const corrected = await f.resolve(0, c.challengeId, f.pair(0, c.nonce, "google-a"));
  assert.equal(corrected.status, 200);
});
const invalidPairs: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
  ["wrong ID audience", {}, { aud: "otherclient" }],
  ["wrong access client", { client_id: "otherclient" }, {}],
  ["wrong issuer", {}, { iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Untrusted" }],
  ["wrong token purpose", {}, { token_use: "access" }],
  ["expired ID", {}, { exp: 1 }],
  ["expired access", { exp: 1 }, {}],
  ["future ID", {}, { iat: 2000000000 }],
  ["wrong subject", {}, { sub: "someone-else" }],
  ["wrong lineage", {}, { origin_jti: "another-family" }],
  ["missing lineage", { origin_jti: null }, {}],
  ["different auth time", {}, { auth_time: 1899999999 }],
  ["stale login", { auth_time: 1899999600 }, { auth_time: 1899999600 }],
  ["wrong nonce", {}, { nonce: "not-the-challenge" }],
  [
    "multiple linked Google profiles",
    {},
    {
      identities: [
        { providerName: "Google", providerType: "Google", userId: "a", primary: "true" },
        { providerName: "Google", providerType: "Google", userId: "b" },
      ],
    },
  ],
  [
    "non-Google linked profile",
    {},
    {
      identities: [
        { providerName: "Google", providerType: "Google", userId: "a" },
        { providerName: "Other", providerType: "OIDC", userId: "b" },
      ],
    },
  ],
  [
    "wrong provider type",
    {},
    { identities: [{ providerName: "Google", providerType: "OIDC", userId: "a" }] },
  ],
  ["missing identities", {}, { identities: null }],
];
for (const [name, access, id] of invalidPairs)
  test(`${name} fails without identity side effects`, async () => {
    const f = googleFixture();
    const c = await f.challenge();
    const denied = await f.resolve(0, c.challengeId, f.pair(0, c.nonce, "synthetic-google", access, id));
    assert.equal(denied.status, 401);
    assert.equal(f.repository.counts.people, 0);
    assert.equal((await f.resolve(0, c.challengeId, f.pair(0, c.nonce))).status, 200);
  });
test("forged signatures fail independently for both JWT purposes", async () => {
  const f = googleFixture();
  const c = await f.challenge();
  for (const field of ["id", "access"] as const) {
    const proof = f.pair(0, c.nonce);
    const parts = proof[field].split(".");
    parts[2] = Buffer.alloc(256).toString("base64url");
    proof[field] = parts.join(".");
    assert.equal((await f.resolve(0, c.challengeId, proof)).status, 401);
  }
  assert.equal(f.repository.counts.people, 0);
});
test("wrong caller, cross-product challenge, unreviewed policy and expired challenge deny", async () => {
  const f = googleFixture();
  const event = f.event(0, "/v1/identities/google/challenge");
  event.requestContext!.identity!.userArn = "arn:aws:sts::111111111111:assumed-role/Unknown/synthetic";
  assert.equal((await f.handler(event)).statusCode, 403);
  const c = await f.challenge();
  assert.equal((await f.resolve(1, c.challengeId, f.pair(1, c.nonce))).status, 403);
  const disabled = googleIdentityHandler(
    f.repository,
    registrations(f.products.map((p) => ({ ...p, enabled: false }))),
    f.keys,
    () => f.now,
  );
  assert.equal((await disabled(f.event(0, "/v1/identities/google/challenge"))).statusCode, 403);
  const noPolicy = googleIdentityHandler(
    f.repository,
    registrations(f.products.map((p) => ({ ...p, googleFederation: undefined }))),
    f.keys,
    () => f.now,
  );
  assert.equal((await noPolicy(f.event(0, "/v1/identities/google/challenge"))).statusCode, 403);
  f.advance(301);
  assert.equal((await f.resolve(0, c.challengeId, f.pair(0, c.nonce))).status, 401);
});
test("me continues only an enrolled refresh family, unknown remains null and policy changes deny", async () => {
  const f = googleFixture();
  const c = await f.challenge();
  const proof = f.pair(0, c.nonce);
  assert.deepEqual((await f.request(0, "/v1/identities/me", {}, proof, "GET")).body, { person: null });
  const resolved = await f.resolve(0, c.challengeId, proof);
  f.advance(600);
  const refresh = f.pair(0, c.nonce, "synthetic-google-a", { auth_time: f.now - 600 });
  assert.deepEqual(await f.request(0, "/v1/identities/me", {}, refresh, "GET"), resolved);
  assert.equal(
    (
      await f.request(
        0,
        "/v1/identities/me",
        {},
        f.pair(0, c.nonce, "synthetic-google-a", { origin_jti: "new-login" }),
        "GET",
      )
    ).status,
    401,
  );
  const updated = googleIdentityHandler(
    f.repository,
    registrations(
      f.products.map((p) => ({
        ...p,
        googleFederation: { ...p.googleFederation!, reviewedPolicyId: "new-review" },
      })),
    ),
    f.keys,
    () => f.now,
  );
  assert.equal((await updated(f.event(0, "/v1/identities/me", {}, refresh, "GET"))).statusCode, 403);
  assert.equal(f.repository.counts.associations, 1);
});
test("registry rejects forged policy fields and request rejects raw subject authority", async () => {
  const f = googleFixture();
  assert.throws(() =>
    registrations(
      f.products.map((p) => ({ ...p, googleFederation: { ...p.googleFederation!, clientId: "outside" } })),
    ),
  );
  assert.throws(() =>
    registrations(
      f.products.map((p) => ({
        ...p,
        googleFederation: { ...p.googleFederation!, acceptLinkedProfiles: true },
      })),
    ),
  );
  const c = await f.challenge();
  assert.equal(
    (
      await f.request(
        0,
        "/v1/identities/google/resolve",
        { challengeId: c.challengeId, googleSubject: "raw" },
        f.pair(0, c.nonce),
      )
    ).status,
    400,
  );
});
test("JSON-lines real central harness resolves two pools with externally supplied public RSA keys", async () => {
  const f = googleFixture();
  const child = spawn(process.execPath, ["--import", "tsx", "accounts/testing/google-harness.ts"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  const send = async (message: unknown) => {
    child.stdin.write(JSON.stringify(message) + "\n");
    const line = await iterator.next();
    assert.equal(line.done, false);
    return JSON.parse(line.value!);
  };
  try {
    const keys: Record<string, Record<string, unknown>> = {};
    for (const product of f.products)
      keys[product.issuer] = {
        "synthetic-access": await f.keys(product.issuer, "synthetic-access"),
        "synthetic-id": await f.keys(product.issuer, "synthetic-id"),
      };
    assert.deepEqual(await send({ op: "configure", nowSeconds: f.now, products: f.products, keys }), {
      configured: true,
    });
    const people = [];
    for (const index of [0, 1]) {
      const challenge = JSON.parse(
        (await send({ op: "request", event: f.event(index, "/v1/identities/google/challenge") })).body,
      );
      const proof = f.pair(index, challenge.nonce);
      const resolved = await send({
        op: "request",
        event: f.event(index, "/v1/identities/google/resolve", { challengeId: challenge.challengeId }, proof),
      });
      assert.equal(resolved.statusCode, 200);
      people.push(JSON.parse(resolved.body).person.id);
    }
    assert.equal(people[0], people[1]);
  } finally {
    child.stdin.end();
    lines.close();
    child.kill();
  }
});
const loginState = "synthetic-login-state-0123456789abcdefghijklmnop";
const loginStateDigest = createHash("sha256").update(loginState).digest("hex");
async function boundChallenge(f: ReturnType<typeof googleFixture>, digest: unknown = loginStateDigest) {
  const issued = await f.request(0, "/v1/identities/google/challenge", { loginStateDigest: digest });
  assert.equal(issued.status, 200);
  return issued.body as { challengeId: string; nonce: string; expiresAt: number };
}
test("a challenge issued before sign-in resolves only with the original login state and keeps its lifetime", async () => {
  const f = googleFixture();
  const c = await boundChallenge(f);
  assert.deepEqual(Object.keys(c).sort(), ["challengeId", "expiresAt", "nonce"]);
  assert.equal(c.expiresAt, f.now + 300);
  const proof = f.pair(0, c.nonce);
  const resolve = (state?: unknown) =>
    f.request(
      0,
      "/v1/identities/google/resolve",
      { challengeId: c.challengeId, ...(state === undefined ? {} : { loginState: state }) },
      proof,
    );
  for (const rejected of [undefined, "another-login-state-0123456789abcdefghij"])
    assert.equal((await resolve(rejected)).status, 401);
  assert.equal(f.repository.counts.people, 0);
  const accepted = await resolve(loginState);
  assert.equal(accepted.status, 200);
  assert.deepEqual(await resolve(loginState), accepted);
  assert.equal(f.repository.counts.associations, 1);
});
test("a bound challenge still enforces the 300 second freshness and its own nonce", async () => {
  const f = googleFixture();
  const expiring = await boundChallenge(f);
  const stale = f.pair(0, expiring.nonce);
  f.advance(301);
  const expired = await f.request(
    0,
    "/v1/identities/google/resolve",
    { challengeId: expiring.challengeId, loginState },
    stale,
  );
  assert.equal(expired.status, 401);
  const fresh = await boundChallenge(f);
  const oldAuthentication = f.pair(
    0,
    fresh.nonce,
    "synthetic-google-a",
    { auth_time: f.now - 301 },
    { auth_time: f.now - 301 },
  );
  const denied = await f.request(
    0,
    "/v1/identities/google/resolve",
    { challengeId: fresh.challengeId, loginState },
    oldAuthentication,
  );
  assert.equal(denied.status, 401);
  assert.equal(denied.body.error, "session_binding");
  const wrongNonce = await f.request(
    0,
    "/v1/identities/google/resolve",
    { challengeId: fresh.challengeId, loginState },
    f.pair(0, "another-challenge-nonce"),
  );
  assert.equal(wrongNonce.status, 401);
  assert.equal(f.repository.counts.people, 0);
});
test("a challenge issued without a digest rejects any supplied login state", async () => {
  const f = googleFixture();
  const c = await f.challenge();
  const proof = f.pair(0, c.nonce);
  const rejected = await f.request(
    0,
    "/v1/identities/google/resolve",
    { challengeId: c.challengeId, loginState },
    proof,
  );
  assert.equal(rejected.status, 401);
  assert.equal((await f.resolve(0, c.challengeId, proof)).status, 200);
});
test("malformed login state fields fail before a challenge is stored or consumed", async () => {
  const f = googleFixture();
  for (const digest of ["", "ABC", loginStateDigest.toUpperCase(), loginStateDigest + "0", 7, null, {}]) {
    const response = await f.request(0, "/v1/identities/google/challenge", { loginStateDigest: digest });
    assert.equal(response.status, 400, JSON.stringify(digest));
  }
  assert.equal(
    (await f.request(0, "/v1/identities/google/challenge", { loginStateDigest, extra: "x" })).status,
    400,
  );
  const c = await boundChallenge(f);
  for (const state of ["", "has space", "x".repeat(129), 7, null, {}]) {
    const response = await f.request(
      0,
      "/v1/identities/google/resolve",
      { challengeId: c.challengeId, loginState: state },
      f.pair(0, c.nonce),
    );
    assert.equal(response.status, 400, JSON.stringify(state));
  }
  assert.equal(
    (
      await f.request(
        0,
        "/v1/identities/google/resolve",
        { challengeId: c.challengeId, loginState, googleSubject: "raw" },
        f.pair(0, c.nonce),
      )
    ).status,
    400,
  );
  assert.equal(f.repository.counts.people, 0);
});
