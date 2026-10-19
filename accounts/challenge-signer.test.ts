import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KmsChallengeSigner,
  ParameterStoreChallengeSigner,
  challengeSignerFromConfiguration,
  hmacSha256,
  loginChallengeSignerConfiguration,
  macsAreEqual,
  type ChallengeSigner,
  type LoginChallengeSignerConfiguration,
} from "./challenge-signer";
import { issueChallengeToken, verifyChallengeToken } from "./challenge-token";
import { googleFixture } from "./testing/google-fixture";
import { FakeChallengeSigner } from "./testing/fake-challenge-signer";
import type { LoginChallenge } from "./google-identity";

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
};
const secrets: Record<string, string | undefined> = {
  v1: Buffer.alloc(48, 1).toString("base64"),
  v2: Buffer.alloc(48, 2).toString("base64"),
  v3: Buffer.alloc(48, 3).toString("base64"),
};
const prefix = "/prospectus/central-accounts/login-challenge-mac/";
const parameterConfiguration = (currentKeyId: string, previousKeyId?: string) =>
  ({
    kind: "parameter-store",
    parameterPrefix: prefix,
    currentKeyId,
    ...(previousKeyId ? { previousKeyId } : {}),
  }) as Extract<LoginChallengeSignerConfiguration, { kind: "parameter-store" }>;

function fakeParameterStore(values: Record<string, string | undefined> = secrets) {
  const requests: Array<{ Name: string; WithDecryption: boolean }> = [];
  return {
    requests,
    client: {
      send: async (command: any) => {
        requests.push(command.input);
        const value = values[command.input.Name.slice(prefix.length)];
        if (value === undefined) throw Object.assign(new Error("not found"), { name: "ParameterNotFound" });
        return { Parameter: { Value: value } };
      },
    } as any,
  };
}
function fakeKms(secret = Buffer.alloc(48, 9)) {
  const commands: Array<{ name: string; input: any }> = [];
  return {
    commands,
    client: {
      send: async (command: any) => {
        commands.push({ name: command.constructor.name, input: command.input });
        const expected = createHmac("sha256", secret).update(command.input.Message).digest();
        if (command.constructor.name === "GenerateMacCommand") return { Mac: expected };
        if (!expected.equals(Buffer.from(command.input.Mac)))
          throw Object.assign(new Error("invalid"), { name: "KMSInvalidMacException" });
        return { MacValid: true };
      },
    } as any,
  };
}
const kmsKeyArn = "arn:aws:kms:us-east-1:111111111111:key/11111111-1111-4111-8111-111111111111";

const implementations: Array<[string, () => { signer: ChallengeSigner; other: () => ChallengeSigner }]> = [
  [
    "parameter-store",
    () => ({
      signer: new ParameterStoreChallengeSigner(parameterConfiguration("v1"), fakeParameterStore().client),
      other: () =>
        new ParameterStoreChallengeSigner(
          parameterConfiguration("v1"),
          fakeParameterStore({ v1: Buffer.alloc(48, 7).toString("base64") }).client,
        ),
    }),
  ],
  [
    "kms",
    () => ({
      signer: new KmsChallengeSigner(kmsKeyArn, fakeKms().client),
      other: () => new KmsChallengeSigner(kmsKeyArn, fakeKms(Buffer.alloc(48, 8)).client),
    }),
  ],
  [
    "fake",
    () => ({
      signer: new FakeChallengeSigner(),
      other: () => new FakeChallengeSigner("t1", { t1: "another-secret-0123456789abcdef0123456789" }),
    }),
  ],
];
const rejects = (promise: Promise<unknown>) =>
  assert.rejects(promise, (error: any) => error.status === 401 && error.code === "challenge_invalid");
const swapKeyId = (token: string, keyId: string) =>
  token
    .split(".")
    .map((part, index) => (index === 1 ? keyId : part))
    .join(".");

for (const [name, create] of implementations) {
  test(`${name} signer: tokens round trip and any tampering, a foreign key or a changed key ID is rejected`, async () => {
    const { signer, other } = create();
    const token = await issueChallengeToken(signer, challenge);
    assert.equal(token.split(".")[1], signer.currentKeyId);
    assert.deepEqual(await verifyChallengeToken(signer, token), challenge);
    const parts = token.split(".");
    await rejects(
      verifyChallengeToken(signer, [parts[0], parts[1], parts[2], parts[3].replace(/.$/, "A")].join(".")),
    );
    await rejects(
      verifyChallengeToken(
        signer,
        [
          parts[0],
          parts[1],
          Buffer.from(
            JSON.stringify([...JSON.parse(Buffer.from(parts[2], "base64url").toString()).slice(0, 4), 1]),
          ).toString("base64url"),
          parts[3],
        ].join("."),
      ),
    );
    await rejects(verifyChallengeToken(signer, swapKeyId(token, "zz")));
    await rejects(verifyChallengeToken(other(), token));
  });
}

test("a signer rejects a token that has expired when it is resolved", async () => {
  for (const [, create] of implementations) {
    const { signer } = create();
    const f = googleFixture(signer);
    const issued = await f.challenge(0);
    const token = { challengeToken: issued.challengeToken! };
    f.advance(300);
    assert.equal((await f.resolve(0, token, f.pair(0, issued.nonce))).status, 401);
  }
});

test("parameter-store signer: GetParameter asks for decryption by exact name and the secret is cached", async () => {
  const store = fakeParameterStore();
  let now = 1_000_000;
  const signer = new ParameterStoreChallengeSigner(
    parameterConfiguration("v1"),
    store.client,
    () => now,
    15 * 60 * 1000,
  );
  const token = await issueChallengeToken(signer, challenge);
  await verifyChallengeToken(signer, token);
  await issueChallengeToken(signer, challenge);
  assert.deepEqual(store.requests, [{ Name: `${prefix}v1`, WithDecryption: true }]);
  now += 15 * 60 * 1000 - 1;
  await issueChallengeToken(signer, challenge);
  assert.equal(store.requests.length, 1, "still cached just before the time limit");
  now += 1;
  secrets.v1 = Buffer.alloc(48, 5).toString("base64");
  try {
    await rejects(verifyChallengeToken(signer, token));
    assert.equal(store.requests.length, 2, "reloaded after the time limit, so a rotated secret takes effect");
  } finally {
    secrets.v1 = Buffer.alloc(48, 1).toString("base64");
  }
});

test("parameter-store signer: the previous key verifies, new tokens use the current key and unknown IDs read nothing", async () => {
  const oldSigner = new ParameterStoreChallengeSigner(
    parameterConfiguration("v1"),
    fakeParameterStore().client,
  );
  const inFlight = await issueChallengeToken(oldSigner, challenge);
  const store = fakeParameterStore();
  const rotated = new ParameterStoreChallengeSigner(parameterConfiguration("v2", "v1"), store.client);
  assert.deepEqual(await verifyChallengeToken(rotated, inFlight), challenge);
  const fresh = await issueChallengeToken(rotated, challenge);
  assert.equal(fresh.split(".")[1], "v2");
  const before = store.requests.length;
  const unknown = await issueChallengeToken(
    new ParameterStoreChallengeSigner(parameterConfiguration("v3"), fakeParameterStore().client),
    challenge,
  );
  await rejects(verifyChallengeToken(rotated, unknown));
  assert.equal(store.requests.length, before, "an unconfigured key ID never reaches Parameter Store");
  const afterRetirement = new ParameterStoreChallengeSigner(
    parameterConfiguration("v2"),
    fakeParameterStore().client,
  );
  await rejects(verifyChallengeToken(afterRetirement, inFlight));
});

test("parameter-store signer fails closed for a missing, short or malformed secret and never reveals it", async () => {
  const secretValue = Buffer.alloc(31, 4).toString("base64");
  for (const value of [
    undefined,
    secretValue,
    "not base64!!",
    "",
    Buffer.alloc(32, 4).toString("hex") + "%",
  ]) {
    const signer = new ParameterStoreChallengeSigner(
      parameterConfiguration("v1"),
      fakeParameterStore({ v1: value }).client,
    );
    await assert.rejects(issueChallengeToken(signer, challenge), (error: any) => {
      assert.ok(!String(error.message).includes(secretValue));
      return !error.status;
    });
    await assert.rejects(signer.verify("v1", Uint8Array.from([1]), Uint8Array.from([1])));
  }
  const exact = new ParameterStoreChallengeSigner(
    parameterConfiguration("v1"),
    fakeParameterStore({ v1: Buffer.alloc(32, 4).toString("base64") }).client,
  );
  assert.ok(await issueChallengeToken(exact, challenge));
});

test("a signer outage returns 503 at issue so the browser falls back, and a recovered signer works again", async () => {
  for (const values of [{}, { v1: Buffer.alloc(8).toString("base64") }]) {
    const f = googleFixture(
      new ParameterStoreChallengeSigner(parameterConfiguration("v1"), fakeParameterStore(values).client),
    );
    const response = await f.request(0, "/v1/identities/google/challenge");
    assert.equal(response.status, 503);
    assert.equal(response.body.error, "identity_unavailable");
    assert.ok(!JSON.stringify(response.body).includes("Value"));
  }
});

test("MACs are compared in constant time over equal lengths only", () => {
  const mac = hmacSha256(Buffer.alloc(32, 1), Uint8Array.from([1, 2, 3]));
  assert.equal(macsAreEqual(mac, Buffer.from(mac)), true);
  assert.equal(macsAreEqual(mac, hmacSha256(Buffer.alloc(32, 2), Uint8Array.from([1, 2, 3]))), false);
  assert.equal(macsAreEqual(mac, mac.subarray(0, 31)), false);
  assert.equal(macsAreEqual(mac, Buffer.alloc(0)), false);
  assert.match(readFileSync(new URL("./challenge-signer.ts", import.meta.url), "utf8"), /timingSafeEqual\(/);
});

test("the KMS signer sends only GenerateMac and VerifyMac with HMAC_SHA_256 and treats an invalid MAC as false", async () => {
  const kms = fakeKms();
  const signer = new KmsChallengeSigner(kmsKeyArn, kms.client);
  assert.equal(signer.currentKeyId, "kms");
  const mac = await signer.sign(Uint8Array.from([7]));
  assert.equal(await signer.verify("kms", Uint8Array.from([7]), mac), true);
  assert.equal(await signer.verify("kms", Uint8Array.from([7]), Buffer.alloc(32)), false);
  assert.equal(
    await signer.verify("v1", Uint8Array.from([7]), mac),
    false,
    "another key ID never reaches KMS",
  );
  assert.deepEqual(
    kms.commands.map((command) => command.name),
    ["GenerateMacCommand", "VerifyMacCommand", "VerifyMacCommand"],
  );
  assert.ok(
    kms.commands.every(
      (command) => command.input.KeyId === kmsKeyArn && command.input.MacAlgorithm === "HMAC_SHA_256",
    ),
  );
  const outage = new KmsChallengeSigner(kmsKeyArn, {
    send: async () => {
      throw Object.assign(new Error("outage"), { name: "KMSInternalException" });
    },
  } as any);
  await assert.rejects(outage.verify("kms", Uint8Array.from([7]), mac));
});

test("signer configuration is validated and selects the implementation", () => {
  assert.deepEqual(loginChallengeSignerConfiguration({ kind: "kms" }), { kind: "kms" });
  assert.deepEqual(
    loginChallengeSignerConfiguration(parameterConfiguration("v2", "v1")),
    parameterConfiguration("v2", "v1"),
  );
  for (const bad of [
    null,
    [],
    "kms",
    { kind: "other" },
    { kind: "kms", extra: 1 },
    { kind: "parameter-store" },
    { ...parameterConfiguration("v1"), parameterPrefix: "no-leading-slash/" },
    { ...parameterConfiguration("v1"), parameterPrefix: ["/a/"] },
    { ...parameterConfiguration("v1"), currentKeyId: ["v1"] },
    { ...parameterConfiguration("v1"), currentKeyId: 1 },
    { ...parameterConfiguration("v1"), currentKeyId: "V1" },
    { ...parameterConfiguration("v1"), previousKeyId: "v1" },
    { ...parameterConfiguration("v1"), previousKeyId: 2 },
    { ...parameterConfiguration("v1"), secret: "inline" },
  ])
    assert.throws(() => loginChallengeSignerConfiguration(bad), /reviewed kms or parameter-store/);
  assert.ok(
    challengeSignerFromConfiguration(parameterConfiguration("v1")) instanceof ParameterStoreChallengeSigner,
  );
  assert.ok(challengeSignerFromConfiguration({ kind: "kms" }, kmsKeyArn) instanceof KmsChallengeSigner);
  assert.throws(() => challengeSignerFromConfiguration({ kind: "kms" }), /key ARN/);
  assert.throws(() => challengeSignerFromConfiguration({ kind: "kms" }, "arn:aws:kms:bad"), /key ARN/);
});
