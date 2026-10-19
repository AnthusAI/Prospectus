import { test } from "node:test";
import assert from "node:assert/strict";
import { googleFixture } from "./testing/google-fixture";
import { googleIdentityHandler } from "./google-identity";
import { registrations } from "./registration";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

test("same Google account across two pools resolves one person with provenance and no memberships", async () => {
  const identityFixture = googleFixture();
  const firstChallenge = await identityFixture.challenge(0),
    secondChallenge = await identityFixture.challenge(1);
  const first = await identityFixture.resolve(
    0,
    firstChallenge.challengeId,
    identityFixture.pair(0, firstChallenge.nonce),
  );
  const second = await identityFixture.resolve(
    1,
    secondChallenge.challengeId,
    identityFixture.pair(1, secondChallenge.nonce),
  );
  assert.equal(first.status, 200);
  assert.deepEqual(second, first);
  assert.deepEqual(identityFixture.repository.counts, {
    people: 1,
    googleIdentities: 1,
    aliases: 2,
    associations: 2,
  });
  const alias = await identityFixture.repository.find(
    identityFixture.products[1].issuer,
    "synthetic-pool-person-1",
  );
  assert.equal(alias?.alias.googleIssuer, "https://accounts.google.com");
  assert.equal(alias?.alias.provenance[0].product, "papyrus");
  assert.deepEqual(Object.keys(first.body), ["person"]);
});
test("different Google subjects and matching email remain distinct", async () => {
  const identityFixture = googleFixture();
  const firstChallenge = await identityFixture.challenge(0),
    secondChallenge = await identityFixture.challenge(1);
  const one = await identityFixture.resolve(
    0,
    firstChallenge.challengeId,
    identityFixture.pair(0, firstChallenge.nonce, "synthetic-a"),
  );
  const two = await identityFixture.resolve(
    1,
    secondChallenge.challengeId,
    identityFixture.pair(1, secondChallenge.nonce, "synthetic-b"),
  );
  assert.equal(one.status, 200);
  assert.equal(two.status, 200);
  assert.notEqual(one.body.person.id, two.body.person.id);
});
test("concurrent handlers and identical lost-response retries consume once; changed replay denies", async () => {
  const identityFixture = googleFixture();
  const challenge = await identityFixture.challenge();
  const proof = identityFixture.pair(0, challenge.nonce);
  const handlers = Array.from({ length: 16 }, () =>
    googleIdentityHandler(
      identityFixture.repository,
      identityFixture.products,
      identityFixture.keys,
      () => identityFixture.now,
    ),
  );
  const results = await Promise.all(
    handlers.map((handler) =>
      handler(
        identityFixture.event(
          0,
          "/v1/identities/google/resolve",
          { challengeId: challenge.challengeId },
          proof,
        ),
      ),
    ),
  );
  assert.ok(results.every((result) => result.statusCode === 200));
  assert.equal(new Set(results.map((result) => result.body)).size, 1);
  assert.equal(identityFixture.repository.counts.associations, 1);
  const replay = await identityFixture.resolve(0, challenge.challengeId, proof);
  assert.equal(replay.status, 200);
  const changed = await identityFixture.resolve(
    0,
    challenge.challengeId,
    identityFixture.pair(0, challenge.nonce),
  );
  assert.equal(changed.status, 409);
  assert.equal(changed.body.error, "challenge_replay");
});
test("same Google enrollment races in different pools reserve one canonical person", async () => {
  const identityFixture = googleFixture();
  const firstChallenge = await identityFixture.challenge(0),
    secondChallenge = await identityFixture.challenge(1);
  const result = await Promise.all([
    identityFixture.resolve(0, firstChallenge.challengeId, identityFixture.pair(0, firstChallenge.nonce)),
    identityFixture.resolve(1, secondChallenge.challengeId, identityFixture.pair(1, secondChallenge.nonce)),
  ]);
  assert.ok(result.every((result) => result.status === 200));
  assert.equal(result[0].body.person.id, result[1].body.person.id);
});
test("an existing Cognito alias cannot switch Google identity or silently merge existing people", async () => {
  const identityFixture = googleFixture();
  const firstChallenge = await identityFixture.challenge(0),
    secondChallenge = await identityFixture.challenge(1);
  await identityFixture.resolve(
    0,
    firstChallenge.challengeId,
    identityFixture.pair(0, firstChallenge.nonce, "google-a"),
  );
  await identityFixture.resolve(
    1,
    secondChallenge.challengeId,
    identityFixture.pair(1, secondChallenge.nonce, "google-b"),
  );
  const challenge = await identityFixture.challenge(0);
  const denied = await identityFixture.resolve(
    0,
    challenge.challengeId,
    identityFixture.pair(0, challenge.nonce, "google-b"),
  );
  assert.equal(denied.status, 409);
  assert.equal(denied.body.error, "identity_conflict");
  assert.equal(identityFixture.repository.counts.people, 2);
  const corrected = await identityFixture.resolve(
    0,
    challenge.challengeId,
    identityFixture.pair(0, challenge.nonce, "google-a"),
  );
  assert.equal(corrected.status, 200);
});
const invalidPairs: Array<[string, Record<string, unknown>, Record<string, unknown>, string?]> = [
  ["wrong ID audience", {}, { aud: "otherclient" }],
  ["wrong access client", { client_id: "otherclient" }, {}],
  ["wrong issuer", {}, { iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Untrusted" }],
  ["wrong token purpose", {}, { token_use: "access" }],
  ["expired ID", {}, { exp: 1 }],
  ["expired access", { exp: 1 }, {}],
  ["future ID", {}, { iat: 2000000000 }],
  ["wrong subject", {}, { sub: "someone-else" }, "The access and ID tokens must belong to the same subject."],
  [
    "wrong lineage",
    {},
    { origin_jti: "another-family" },
    "The access and ID tokens must share one origin token ID.",
  ],
  ["missing lineage", { origin_jti: null }, {}, "The access token must carry an origin token ID."],
  [
    "different auth time",
    {},
    { auth_time: 1899999999 },
    "The access and ID tokens must carry the same login time.",
  ],
  [
    "stale login",
    { auth_time: 1899999600 },
    { auth_time: 1899999600 },
    "The login is older than the challenge window.",
  ],
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
    "Exactly one linked identity is required.",
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
    "Exactly one linked identity is required.",
  ],
  [
    "wrong provider type",
    {},
    { identities: [{ providerName: "Google", providerType: "OIDC", userId: "a" }] },
    "The linked identity provider type must be Google.",
  ],
  ["missing identities", {}, { identities: null }, "The ID token must list its linked identities."],
];
for (const [name, access, id, expectedMessage] of invalidPairs)
  test(`${name} fails without identity side effects`, async () => {
    const identityFixture = googleFixture();
    const challenge = await identityFixture.challenge();
    const denied = await identityFixture.resolve(
      0,
      challenge.challengeId,
      identityFixture.pair(0, challenge.nonce, "synthetic-google", access, id),
    );
    assert.equal(denied.status, 401);
    if (expectedMessage) assert.ok(denied.body.message.includes(expectedMessage));
    assert.equal(identityFixture.repository.counts.people, 0);
    assert.equal(
      (await identityFixture.resolve(0, challenge.challengeId, identityFixture.pair(0, challenge.nonce)))
        .status,
      200,
    );
  });
test("forged signatures fail independently for both JWT purposes", async () => {
  const identityFixture = googleFixture();
  const challenge = await identityFixture.challenge();
  for (const field of ["id", "access"] as const) {
    const proof = identityFixture.pair(0, challenge.nonce);
    const parts = proof[field].split(".");
    parts[2] = Buffer.alloc(256).toString("base64url");
    proof[field] = parts.join(".");
    assert.equal((await identityFixture.resolve(0, challenge.challengeId, proof)).status, 401);
  }
  assert.equal(identityFixture.repository.counts.people, 0);
});
test("wrong caller, cross-product challenge, unreviewed policy and expired challenge deny", async () => {
  const identityFixture = googleFixture();
  const event = identityFixture.event(0, "/v1/identities/google/challenge");
  event.requestContext!.identity!.userArn = "arn:aws:sts::111111111111:assumed-role/Unknown/synthetic";
  assert.equal((await identityFixture.handler(event)).statusCode, 403);
  const challenge = await identityFixture.challenge();
  assert.equal(
    (await identityFixture.resolve(1, challenge.challengeId, identityFixture.pair(1, challenge.nonce)))
      .status,
    403,
  );
  const disabled = googleIdentityHandler(
    identityFixture.repository,
    registrations(identityFixture.products.map((product) => ({ ...product, enabled: false }))),
    identityFixture.keys,
    () => identityFixture.now,
  );
  assert.equal((await disabled(identityFixture.event(0, "/v1/identities/google/challenge"))).statusCode, 403);
  const noPolicy = googleIdentityHandler(
    identityFixture.repository,
    registrations(identityFixture.products.map((product) => ({ ...product, googleFederation: undefined }))),
    identityFixture.keys,
    () => identityFixture.now,
  );
  assert.equal((await noPolicy(identityFixture.event(0, "/v1/identities/google/challenge"))).statusCode, 403);
  identityFixture.advance(301);
  assert.equal(
    (await identityFixture.resolve(0, challenge.challengeId, identityFixture.pair(0, challenge.nonce)))
      .status,
    401,
  );
});
test("me continues only an enrolled refresh family, unknown remains null and policy changes deny", async () => {
  const identityFixture = googleFixture();
  const challenge = await identityFixture.challenge();
  const proof = identityFixture.pair(0, challenge.nonce);
  assert.deepEqual((await identityFixture.request(0, "/v1/identities/me", {}, proof, "GET")).body, {
    person: null,
  });
  const resolved = await identityFixture.resolve(0, challenge.challengeId, proof);
  identityFixture.advance(600);
  const refresh = identityFixture.pair(0, challenge.nonce, "synthetic-google-a", {
    auth_time: identityFixture.now - 600,
  });
  assert.deepEqual(await identityFixture.request(0, "/v1/identities/me", {}, refresh, "GET"), resolved);
  assert.equal(
    (
      await identityFixture.request(
        0,
        "/v1/identities/me",
        {},
        identityFixture.pair(0, challenge.nonce, "synthetic-google-a", { origin_jti: "new-login" }),
        "GET",
      )
    ).status,
    401,
  );
  const updated = googleIdentityHandler(
    identityFixture.repository,
    registrations(
      identityFixture.products.map((product) => ({
        ...product,
        googleFederation: { ...product.googleFederation!, reviewedPolicyId: "new-review" },
      })),
    ),
    identityFixture.keys,
    () => identityFixture.now,
  );
  assert.equal(
    (await updated(identityFixture.event(0, "/v1/identities/me", {}, refresh, "GET"))).statusCode,
    403,
  );
  assert.equal(identityFixture.repository.counts.associations, 1);
});
test("registry rejects forged policy fields and request rejects raw subject authority", async () => {
  const identityFixture = googleFixture();
  assert.throws(() =>
    registrations(
      identityFixture.products.map((product) => ({
        ...product,
        googleFederation: { ...product.googleFederation!, clientId: "outside" },
      })),
    ),
  );
  assert.throws(() =>
    registrations(
      identityFixture.products.map((product) => ({
        ...product,
        googleFederation: { ...product.googleFederation!, acceptLinkedProfiles: true },
      })),
    ),
  );
  const challenge = await identityFixture.challenge();
  assert.equal(
    (
      await identityFixture.request(
        0,
        "/v1/identities/google/resolve",
        { challengeId: challenge.challengeId, googleSubject: "raw" },
        identityFixture.pair(0, challenge.nonce),
      )
    ).status,
    400,
  );
});
test("JSON-lines real central harness resolves two pools with externally supplied public RSA keys", async () => {
  const identityFixture = googleFixture();
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
    for (const product of identityFixture.products)
      keys[product.issuer] = {
        "synthetic-access": await identityFixture.keys(product.issuer, "synthetic-access"),
        "synthetic-id": await identityFixture.keys(product.issuer, "synthetic-id"),
      };
    assert.deepEqual(
      await send({
        op: "configure",
        nowSeconds: identityFixture.now,
        products: identityFixture.products,
        keys,
      }),
      {
        configured: true,
      },
    );
    const people = [];
    for (const index of [0, 1]) {
      const challenge = JSON.parse(
        (
          await send({
            op: "request",
            event: identityFixture.event(index, "/v1/identities/google/challenge"),
          })
        ).body,
      );
      const proof = identityFixture.pair(index, challenge.nonce);
      const resolved = await send({
        op: "request",
        event: identityFixture.event(
          index,
          "/v1/identities/google/resolve",
          { challengeId: challenge.challengeId },
          proof,
        ),
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
