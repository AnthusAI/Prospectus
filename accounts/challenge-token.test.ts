import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { googleFixture } from "./testing/google-fixture";
import { FakeChallengeMacSigner } from "./testing/fake-challenge-signer";
import { issueChallengeToken, verifyChallengeToken, KmsChallengeMacSigner } from "./challenge-token";
import { googleIdentityHandler, type LoginChallenge } from "./google-identity";

const loginState = "synthetic-login-state-0123456789abcdefghijklmnop";
const loginStateDigest = createHash("sha256").update(loginState).digest("hex");
const challenge: LoginChallenge = {
  challengeId: "11111111-1111-4111-8111-111111111111",
  nonce: "synthetic-nonce",
  issuedAt: 1900000000,
  expiresAt: 1900000300,
  binding: {
    product: "cyclotron",
    principal: "arn:aws:iam::111111111111:role/Synthetic0",
    issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Synthetic0",
    clientId: "synthetic0",
    policyRevision: "synthetic-review-v1",
  },
  loginStateDigest,
};
const alter = (token: string, part: number, replacement: (value: string) => string) =>
  token
    .split(".")
    .map((value, index) => (index === part ? replacement(value) : value))
    .join(".");
const rejects = (promise: Promise<unknown>) =>
  assert.rejects(promise, (error: any) => error.status === 401 && error.code === "challenge_invalid");

test("a challenge token round-trips every field and carries a version prefix", async () => {
  const signer = new FakeChallengeMacSigner();
  const token = await issueChallengeToken(signer, challenge);
  assert.match(token, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.ok(token.length < 1024);
  assert.deepEqual(await verifyChallengeToken(signer, token), challenge);
  const { loginStateDigest: _omitted, ...unbound } = challenge;
  assert.deepEqual(await verifyChallengeToken(signer, await issueChallengeToken(signer, unbound)), unbound);
});

test("a challenge token is rejected when any part is altered, truncated, re-versioned or foreign", async () => {
  const signer = new FakeChallengeMacSigner();
  const token = await issueChallengeToken(signer, challenge);
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  for (let index = 1; index < payload.length; index++) {
    const changed = [...payload];
    changed[index] = typeof changed[index] === "number" ? changed[index] + 1 : `${changed[index]}x`;
    const forged = alter(token, 1, () => Buffer.from(JSON.stringify(changed)).toString("base64url"));
    await rejects(verifyChallengeToken(signer, forged));
  }
  await rejects(
    verifyChallengeToken(
      signer,
      alter(token, 2, (mac) => mac.slice(0, -4)),
    ),
  );
  await rejects(
    verifyChallengeToken(
      signer,
      alter(token, 2, () => "AAAA"),
    ),
  );
  await rejects(
    verifyChallengeToken(
      signer,
      alter(token, 0, () => "v2"),
    ),
  );
  await rejects(verifyChallengeToken(signer, `${token}.extra`));
  await rejects(verifyChallengeToken(signer, token.split(".").slice(0, 2).join(".")));
  await rejects(verifyChallengeToken(signer, "not a token"));
  await rejects(verifyChallengeToken(signer, "v1.!!!.???"));
  await rejects(verifyChallengeToken(signer, "v1." + "A".repeat(3000) + ".AAAA"));
  await rejects(verifyChallengeToken(new FakeChallengeMacSigner("another-key"), token));
});

test("a correctly signed but malformed payload is rejected after the MAC verifies", async () => {
  const signer = new FakeChallengeMacSigner();
  for (const payload of [
    "not json",
    "{}",
    JSON.stringify(["wrong-domain", "x"]),
    JSON.stringify(["prospectus-login-challenge-v1", "not-a-uuid", "n", 1, 2, "", "a", "b", "c", "d", "e"]),
    JSON.stringify([
      "prospectus-login-challenge-v1",
      challenge.challengeId,
      "n",
      "1",
      2,
      "",
      "a",
      "b",
      "c",
      "d",
      "e",
    ]),
    JSON.stringify([
      "prospectus-login-challenge-v1",
      challenge.challengeId,
      "n",
      1,
      2,
      "ABC",
      "a",
      "b",
      "c",
      "d",
      "e",
    ]),
    JSON.stringify([
      "prospectus-login-challenge-v1",
      challenge.challengeId,
      "n",
      1,
      2,
      "",
      "",
      "b",
      "c",
      "d",
      "e",
    ]),
  ]) {
    const bytes = new TextEncoder().encode(payload);
    const token = `v1.${Buffer.from(bytes).toString("base64url")}.${Buffer.from(await signer.generate(bytes)).toString("base64url")}`;
    await rejects(verifyChallengeToken(signer, token));
  }
});

test("the KMS signer sends only GenerateMac and VerifyMac and treats an invalid MAC as false", async () => {
  const commands: Array<{ name: string; input: any }> = [];
  const client = {
    send: async (command: any) => {
      commands.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === "GenerateMacCommand") return { Mac: Uint8Array.from([1, 2, 3]) };
      if (command.input.Mac[0] === 9)
        throw Object.assign(new Error("invalid"), { name: "KMSInvalidMacException" });
      if (command.input.Mac[0] === 8)
        throw Object.assign(new Error("outage"), { name: "KMSInternalException" });
      return { MacValid: true };
    },
  };
  const signer = new KmsChallengeMacSigner("arn:aws:kms:us-east-1:111111111111:key/synthetic", client as any);
  assert.deepEqual([...(await signer.generate(Uint8Array.from([7])))], [1, 2, 3]);
  assert.equal(await signer.verify(Uint8Array.from([7]), Uint8Array.from([1])), true);
  assert.equal(await signer.verify(Uint8Array.from([7]), Uint8Array.from([9])), false);
  await assert.rejects(signer.verify(Uint8Array.from([7]), Uint8Array.from([8])));
  assert.deepEqual(
    commands.map((command) => command.name),
    ["GenerateMacCommand", "VerifyMacCommand", "VerifyMacCommand", "VerifyMacCommand"],
  );
  assert.ok(
    commands.every(
      (command) =>
        command.input.KeyId === "arn:aws:kms:us-east-1:111111111111:key/synthetic" &&
        command.input.MacAlgorithm === "HMAC_SHA_256",
    ),
  );
});

test("a signed challenge is not stored, resolves once, replays idempotently and rejects changed evidence", async () => {
  const signer = new FakeChallengeMacSigner();
  const f = googleFixture(signer);
  const issued = await f.challenge(0, { loginStateDigest });
  assert.match(issued.challengeToken!, /^v1\./);
  assert.equal(f.repository.counts.associations, 0);
  const proof = f.pair(0, issued.nonce);
  const missing = await f.resolve(0, { challengeToken: issued.challengeToken! }, proof);
  assert.equal(missing.status, 401, "login state is required for a bound token");
  const resolve = (token: string, evidence = proof, state: string | undefined = loginState) =>
    f.request(0, "/v1/identities/google/resolve", { challengeToken: token, loginState: state }, evidence);
  assert.equal(
    (await resolve(issued.challengeToken!, proof, "another-login-state-0123456789abcdefghij")).status,
    401,
  );
  const first = await resolve(issued.challengeToken!);
  assert.equal(first.status, 200);
  const again = await resolve(issued.challengeToken!);
  assert.deepEqual(again, first);
  const changed = await resolve(issued.challengeToken!, f.pair(0, issued.nonce));
  assert.equal(changed.status, 409);
  assert.equal(changed.body.error, "challenge_replay");
  assert.equal(f.repository.counts.people, 1);
});

test("a signed challenge fails on a wrong nonce, expiry, another product, a foreign key and a plain service", async () => {
  const signer = new FakeChallengeMacSigner();
  const f = googleFixture(signer);
  const issued = await f.challenge(0);
  const token = { challengeToken: issued.challengeToken! };
  assert.equal((await f.resolve(0, token, f.pair(0, "another-challenge-nonce"))).status, 401);
  const other = await f.resolve(1, token, f.pair(1, issued.nonce));
  assert.equal(other.status, 403);
  assert.equal(other.body.error, "challenge_binding");
  const foreign = googleFixture(new FakeChallengeMacSigner("another-key"));
  assert.equal((await foreign.resolve(0, token, foreign.pair(0, issued.nonce))).status, 401);
  const plain = googleFixture();
  const refused = await plain.resolve(0, token, plain.pair(0, issued.nonce));
  assert.equal(refused.status, 401);
  assert.equal(refused.body.error, "challenge_invalid");
  f.advance(300);
  assert.equal((await f.resolve(0, token, f.pair(0, issued.nonce))).status, 401);
  assert.equal(f.repository.counts.people, 0);
});

test("a challenge reference must be exactly one of an ID or a token", async () => {
  const f = googleFixture(new FakeChallengeMacSigner());
  const issued = await f.challenge(0);
  const proof = f.pair(0, issued.nonce);
  for (const body of [
    {},
    { challengeId: issued.challengeId, challengeToken: issued.challengeToken },
    { challengeToken: 7 },
    { challengeToken: issued.challengeToken, extra: "x" },
  ])
    assert.equal((await f.request(0, "/v1/identities/google/resolve", body, proof)).status, 400);
});

test("a key service outage fails challenge issue and resolve as unavailable without storing anything", async () => {
  const signer = new FakeChallengeMacSigner();
  const f = googleFixture(signer);
  const issued = await f.challenge(0);
  signer.unavailable = true;
  const unavailable = await f.request(0, "/v1/identities/google/challenge");
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.error, "identity_unavailable");
  const resolved = await f.resolve(0, { challengeToken: issued.challengeToken! }, f.pair(0, issued.nonce));
  assert.equal(resolved.status, 503);
  signer.unavailable = false;
  assert.equal(
    (await f.resolve(0, { challengeToken: issued.challengeToken! }, f.pair(0, issued.nonce))).status,
    200,
  );
});

test("unauthenticated junk never reaches the key service", async () => {
  const signer = new FakeChallengeMacSigner();
  const f = googleFixture(signer);
  await f.request(
    0,
    "/v1/identities/google/resolve",
    { challengeToken: "v1.AAAA.AAAA" },
    { access: "bad", id: "bad" },
  );
  assert.equal(signer.verified, 0);
});

test("stored challenges issued before the rollout still resolve alongside signed ones", async () => {
  const f = googleFixture();
  const legacy = await f.challenge(0);
  assert.equal(legacy.challengeToken, undefined);
  assert.equal((await f.resolve(0, legacy.challengeId, f.pair(0, legacy.nonce))).status, 200);
});

test("a stored challenge issued before the rollout still resolves by ID on a service that signs new challenges", async () => {
  const f = googleFixture();
  const legacy = await f.challenge(0);
  assert.equal(legacy.challengeToken, undefined);
  const upgraded = googleIdentityHandler(
    f.repository,
    f.products,
    f.keys,
    () => f.now,
    new FakeChallengeMacSigner(),
  );
  const response = await upgraded(
    f.event(0, "/v1/identities/google/resolve", { challengeId: legacy.challengeId }, f.pair(0, legacy.nonce)),
  );
  assert.equal(response.statusCode, 200);
});
