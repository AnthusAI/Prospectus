import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { googleFixture } from "./testing/google-fixture";
import { canonicalAccountsHandler } from "./canonical-handler";
import { VirtuusAccountFiles, VirtuusIdentityFiles } from "./identity-files";
import { registrations } from "./registration";
import { GOOGLE_ISSUER } from "./google-direct";

const CLIENT = "123456789012-syntheticportalclient.apps.googleusercontent.com";
const googleKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });

/** Real Virtuus files in a disposable directory: the production identity and account storage code, with synthetic keys. */
test("persisted: a Google-direct portal lists the accounts of the Person a Cognito sign-in created", async () => {
  const root = await mkdtemp(join(tmpdir(), "google-direct-"));
  try {
    const fixture = googleFixture();
    const crm = {
      ...fixture.products[0],
      product: "prospectus-directory",
      accountDirectory: true as const,
      capabilities: ["console:read", "console:write", "members:read", "members:write"],
    };
    const portalRole = "arn:aws:iam::111111111111:role/Synthetic2";
    const products = registrations([
      crm,
      {
        product: "anthus-one",
        roleArn: portalRole,
        issuer: GOOGLE_ISSUER,
        clientIds: [CLIENT],
        capabilities: ["console:read", "members:read"],
        enabled: true,
        accountDirectory: true,
        googleFederation: {
          policy: "google-direct-v1",
          reviewedPolicyId: "synthetic-review",
          clientId: CLIENT,
        },
      },
    ]);
    const keys = async (issuer: string, kid: string) =>
      issuer === GOOGLE_ISSUER
        ? { ...googleKeys.publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" }
        : fixture.keys(issuer, kid);
    const handler = () =>
      canonicalAccountsHandler(
        new VirtuusIdentityFiles(root),
        new VirtuusAccountFiles(root),
        products,
        keys,
        () => fixture.now,
      );
    const token = (sub: string, nonce: string, claims: Record<string, unknown> = {}) => {
      const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "google-1" })).toString("base64url");
      const payload = Buffer.from(
        JSON.stringify({
          iss: GOOGLE_ISSUER,
          aud: CLIENT,
          sub,
          email: "person@example.com",
          email_verified: true,
          nonce,
          iat: fixture.now,
          exp: fixture.now + 3600,
          ...claims,
        }),
      ).toString("base64url");
      return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), googleKeys.privateKey).toString("base64url")}`;
    };
    const portalEvent = (path: string, bearer: string, body: unknown = {}, method = "GET") => {
      const event = fixture.event(2, path, body, undefined, method);
      event.headers!["x-prospectus-human-token"] = bearer;
      return event;
    };
    const subject = "synthetic-google-persisted";
    // The Cognito-backed directory product enrolls the Google subject and creates the account.
    const challenge = JSON.parse((await handler()(fixture.event(0, "/v1/identities/google/challenge"))).body);
    const proof = fixture.pair(0, challenge.nonce, subject);
    const enrolled = await handler()(
      fixture.event(0, "/v1/identities/google/resolve", { challengeId: challenge.challengeId }, proof),
    );
    assert.equal(enrolled.statusCode, 200);
    const personId = JSON.parse(enrolled.body).person.id;
    const createEvent = fixture.event(0, "/v1/accounts", { name: "Persisted workspace" }, proof);
    createEvent.headers!["x-prospectus-human-token"] = proof.access;
    createEvent.headers!["idempotency-key"] = randomUUID();
    const created = await handler()(createEvent);
    assert.equal(created.statusCode, 200, created.body);
    const accountId = JSON.parse(created.body).account.id;

    // The portal has not enrolled yet: a valid Google token resolves to nobody and sees no accounts.
    const before = await handler()(
      portalEvent("/v1/account-directory", token(subject, "portal-nonce-0123456789abcdef")),
    );
    assert.equal(before.statusCode, 200);
    assert.deepEqual(JSON.parse(before.body), { person: null, accounts: [] });

    // Enrollment with a fresh challenge links the Google-issuer alias to the same Google record and Person.
    const portalChallenge = JSON.parse(
      (await handler()(portalEvent("/v1/identities/google/challenge", "", {}, "POST"))).body,
    );
    const direct = await handler()(
      portalEvent(
        "/v1/identities/google/resolve",
        token(subject, portalChallenge.nonce),
        { challengeId: portalChallenge.challengeId },
        "POST",
      ),
    );
    assert.equal(direct.statusCode, 200, direct.body);
    assert.equal(JSON.parse(direct.body).person.id, personId);

    // Later, with a brand new token (different nonce, later issue time) and a new handler, the accounts appear.
    fixture.advance(2400);
    const later = token(subject, "a-later-nonce-0123456789abc");
    const listed = JSON.parse((await handler()(portalEvent("/v1/account-directory", later))).body);
    assert.equal(listed.person.id, personId);
    assert.deepEqual(
      listed.accounts.map((account: { id: string; role: string }) => [account.id, account.role]),
      [[accountId, "owner"]],
    );
    const detail = await handler()(portalEvent(`/v1/account-directory/${accountId}`, later));
    assert.equal(detail.statusCode, 200);
    assert.equal(JSON.parse(detail.body).account.membershipsVisible, true);

    // Another Google account sees nothing, and the portal can never reach operator or product routes.
    const stranger = token("synthetic-google-stranger", "stranger-nonce-0123456789abc");
    assert.deepEqual(
      JSON.parse((await handler()(portalEvent("/v1/account-directory", stranger))).body).accounts,
      [],
    );
    assert.equal(
      (await handler()(portalEvent(`/v1/account-directory/${accountId}`, stranger))).statusCode,
      403,
    );
    assert.equal(
      (await handler()(portalEvent("/v1/account-directory/operator/accounts", later))).statusCode,
      403,
    );
    // Directory visibility is not product use: the portal has no entitlement on the account.
    assert.equal(
      (
        await handler()(
          portalEvent(`/v1/accounts/${accountId}/authorize`, later, { operation: "console:read" }, "POST"),
        )
      ).statusCode,
      403,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
