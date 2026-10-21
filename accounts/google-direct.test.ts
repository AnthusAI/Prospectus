import { generateKeyPairSync, sign, randomUUID, type JsonWebKey } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { googleFixture } from "./testing/google-fixture";
import { FakeChallengeSigner } from "./testing/fake-challenge-signer";
import { googleIdentityHandler } from "./google-identity";
import { registrations } from "./registration";
import { context, cognitoClaims, type ProductRegistration, type RestEvent } from "./auth";
import { GOOGLE_ISSUER, GoogleKeys, googleIdTokenClaims } from "./google-direct";
import { googlePersonDirectory } from "./person-directory";
import { accountDirectoryHandler } from "./directory-handler";
import { accountsBffHandler } from "./bff";
import { operatorGrants } from "./operator-policy";
import { AccountsClient, AccountsClientError, decode } from "../packages/accounts-client/src/client";

const CLIENT = "123456789012-syntheticportalclient.apps.googleusercontent.com";
const PORTAL_ROLE = "arn:aws:iam::111111111111:role/Synthetic2";
const googleKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const strangerKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = (pair: typeof googleKeys, kid: string): JsonWebKey => ({
  ...pair.publicKey.export({ format: "jwk" }),
  kid,
  use: "sig",
  alg: "RS256",
});

/** A Google-direct portal beside two Cognito-backed products, all with synthetic keys and one in-memory repository. */
function portal(signer?: FakeChallengeSigner) {
  const fixture = googleFixture(signer);
  const portalRegistration = {
    product: "anthus-one",
    roleArn: PORTAL_ROLE,
    issuer: GOOGLE_ISSUER,
    clientIds: [CLIENT],
    capabilities: ["console:read", "members:read"],
    enabled: true,
    accountDirectory: true,
    googleFederation: {
      policy: "google-direct-v1",
      reviewedPolicyId: "synthetic-google-direct-v1",
      clientId: CLIENT,
    },
  };
  const products = registrations([...fixture.products, portalRegistration]);
  const registration = products.find((product) => product.product === "anthus-one")!;
  const keys = async (issuer: string, kid: string): Promise<JsonWebKey> => {
    if (issuer === GOOGLE_ISSUER) {
      if (kid !== "google-1") throw new Error("Unknown synthetic Google key");
      return publicJwk(googleKeys, kid);
    }
    return fixture.keys(issuer, kid);
  };
  const handler = googleIdentityHandler(fixture.repository, products, keys, () => fixture.now, signer);
  const token = (
    sub: string,
    nonce: string,
    claims: Record<string, unknown> = {},
    header: Record<string, unknown> = {},
    signingKey = googleKeys.privateKey,
  ) => {
    const encodedHeader = Buffer.from(
      JSON.stringify({ alg: "RS256", kid: "google-1", typ: "JWT", ...header }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: GOOGLE_ISSUER,
        aud: CLIENT,
        azp: CLIENT,
        sub,
        email: "person@example.com",
        email_verified: true,
        nonce,
        iat: fixture.now,
        exp: fixture.now + 3600,
        ...claims,
      }),
    ).toString("base64url");
    const signature = sign("RSA-SHA256", Buffer.from(`${encodedHeader}.${payload}`), signingKey).toString(
      "base64url",
    );
    return `${encodedHeader}.${payload}.${signature}`;
  };
  const event = (path: string, body: unknown = {}, bearer?: string, method = "POST"): RestEvent => {
    const base = fixture.event(2, path, body, undefined, method);
    if (bearer) base.headers!["x-prospectus-human-token"] = bearer;
    return base;
  };
  const request = async (path: string, body: unknown = {}, bearer?: string, method = "POST") => {
    const response = await handler(event(path, body, bearer, method));
    return { status: response.statusCode, body: JSON.parse(response.body) };
  };
  const challenge = async (body: unknown = {}) =>
    (await request("/v1/identities/google/challenge", body)).body as {
      challengeId: string;
      nonce: string;
      challengeToken?: string;
    };
  const enroll = async (sub: string, claims: Record<string, unknown> = {}, loginState?: string) => {
    const issued = await challenge(
      loginState
        ? {
            loginStateDigest: (await import("node:crypto"))
              .createHash("sha256")
              .update(loginState)
              .digest("hex"),
          }
        : {},
    );
    const result = await request(
      "/v1/identities/google/resolve",
      {
        ...(issued.challengeToken
          ? { challengeToken: issued.challengeToken }
          : { challengeId: issued.challengeId }),
        ...(loginState ? { loginState } : {}),
      },
      token(sub, issued.nonce, claims),
    );
    return { ...result, issued };
  };
  return { fixture, products, registration, keys, handler, token, event, request, challenge, enroll };
}

test("a Google ID token for the same Google account resolves the same Person as the Cognito path", async () => {
  const environment = portal();
  const { fixture } = environment;
  const cognitoChallenge = await fixture.challenge(0);
  const crm = await fixture.resolve(
    0,
    cognitoChallenge.challengeId,
    fixture.pair(0, cognitoChallenge.nonce, "synthetic-google-same"),
  );
  assert.equal(crm.status, 200);
  const direct = await environment.enroll("synthetic-google-same");
  assert.equal(direct.status, 200);
  assert.equal(
    direct.body.person.id,
    crm.body.person.id,
    "one human, one Person, with no Cognito sub involved",
  );
  assert.deepEqual(fixture.repository.counts, {
    people: 1,
    googleIdentities: 1,
    aliases: 2,
    associations: 2,
  });
  // The alias is keyed on the Google subject under the Google issuer, not on any Cognito subject.
  const alias = await fixture.repository.find(GOOGLE_ISSUER, "synthetic-google-same");
  assert.equal(alias?.alias.provenance[0].product, "anthus-one");
  assert.equal(alias?.alias.provenance[0].clientId, CLIENT);
  // A later, different, unexpired token needs no new challenge: the Person resolves from enrollment alone.
  fixture.advance(1800);
  const later = environment.token("synthetic-google-same", "later-nonce-0123456789abcdef");
  const me = await environment.request("/v1/identities/me", {}, later, "GET");
  assert.equal(me.body.person.id, crm.body.person.id);
  const resolved = await googlePersonDirectory(fixture.repository, environment.products).resolve(
    await context(
      environment.event("/v1/accounts", {}, later, "GET"),
      environment.products,
      environment.keys,
      fixture.now,
    ),
  );
  assert.equal(resolved?.id, crm.body.person.id);
});

test("a first Google sign-in enrolls a new Person and creates nothing else; unenrolled tokens resolve to no Person", async () => {
  const environment = portal();
  const unenrolled = environment.token("synthetic-google-new", "unenrolled-nonce-0123456789");
  const before = await googlePersonDirectory(environment.fixture.repository, environment.products).resolve(
    await context(
      environment.event("/v1/accounts", {}, unenrolled, "GET"),
      environment.products,
      environment.keys,
      environment.fixture.now,
    ),
  );
  assert.equal(before, null);
  const result = await environment.enroll("synthetic-google-new");
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body), ["person"]);
  assert.deepEqual(environment.fixture.repository.counts, {
    people: 1,
    googleIdentities: 1,
    aliases: 1,
    associations: 1,
  });
  const other = await environment.enroll("synthetic-google-other");
  assert.notEqual(
    other.body.person.id,
    result.body.person.id,
    "a different Google subject is a different Person",
  );
});

test("enrollment is idempotent for identical retries and refuses changed evidence on a consumed challenge", async () => {
  const environment = portal();
  const issued = await environment.challenge();
  const evidence = environment.token("synthetic-google-retry", issued.nonce);
  const body = { challengeId: issued.challengeId };
  const first = await environment.request("/v1/identities/google/resolve", body, evidence);
  const again = await environment.request("/v1/identities/google/resolve", body, evidence);
  assert.deepEqual(again, first);
  const changed = await environment.request(
    "/v1/identities/google/resolve",
    body,
    environment.token("synthetic-google-retry", issued.nonce, { iat: environment.fixture.now - 1 }),
  );
  assert.equal(changed.status, 409);
  assert.equal(environment.fixture.repository.counts.associations, 1);
});

test("enrollment needs the server challenge: wrong nonce, stale token, wrong login state and expiry all write nothing", async () => {
  const environment = portal();
  const { fixture } = environment;
  const nothingWritten = () =>
    assert.deepEqual(fixture.repository.counts, {
      people: 0,
      googleIdentities: 0,
      aliases: 0,
      associations: 0,
    });
  const issued = await environment.challenge();
  const resolve = (bearer: string, extra: Record<string, unknown> = {}) =>
    environment.request(
      "/v1/identities/google/resolve",
      { challengeId: issued.challengeId, ...extra },
      bearer,
    );
  assert.equal(
    (await resolve(environment.token("synthetic-google-x", "a-different-nonce-0123456789"))).status,
    401,
  );
  nothingWritten();
  assert.equal(
    (await resolve(environment.token("synthetic-google-x", issued.nonce, { iat: fixture.now - 400 }))).status,
    401,
  );
  nothingWritten();
  const bound = await environment.challenge({ loginStateDigest: "a".repeat(64) });
  const wrongState = await environment.request(
    "/v1/identities/google/resolve",
    { challengeId: bound.challengeId, loginState: "another-browsers-state" },
    environment.token("synthetic-google-x", bound.nonce),
  );
  assert.equal(wrongState.status, 401);
  nothingWritten();
  const missingState = await environment.request(
    "/v1/identities/google/resolve",
    { challengeId: bound.challengeId },
    environment.token("synthetic-google-x", bound.nonce),
  );
  assert.equal(missingState.status, 401);
  nothingWritten();
  fixture.advance(301);
  assert.equal((await resolve(environment.token("synthetic-google-x", issued.nonce))).status, 401);
  nothingWritten();
});

test("signed stateless challenges bind the browser's login state for Google-direct enrollment", async () => {
  const environment = portal(new FakeChallengeSigner());
  const state = "browser-login-state-0123456789";
  const ok = await environment.enroll("synthetic-google-signed", {}, state);
  assert.equal(ok.status, 200);
  assert.ok(ok.issued.challengeToken);
  const stolen = await environment.challenge({
    loginStateDigest: (await import("node:crypto"))
      .createHash("sha256")
      .update("victim-state-0123456789")
      .digest("hex"),
  });
  const replayedElsewhere = await environment.request(
    "/v1/identities/google/resolve",
    { challengeToken: stolen.challengeToken, loginState: "attacker-state-0123456789" },
    environment.token("synthetic-google-attacker", stolen.nonce),
  );
  assert.equal(replayedElsewhere.status, 401);
});

const claimsFor = (
  environment: ReturnType<typeof portal>,
  token: string,
  registration: ProductRegistration = environment.registration,
) => googleIdTokenClaims(token, registration, environment.keys, environment.fixture.now);

test("invalid Google evidence is refused as invalid identity evidence", async () => {
  const environment = portal();
  const nonce = "valid-nonce-0123456789abcdef";
  const now = environment.fixture.now;
  const good = await claimsFor(environment, environment.token("synthetic-google-ok", nonce));
  assert.equal(good.sub, "synthetic-google-ok");
  assert.equal(
    (
      await claimsFor(
        environment,
        environment.token("synthetic-google-ok", nonce, { iss: "accounts.google.com" }),
      )
    ).sub,
    "synthetic-google-ok",
    "both Google issuer spellings are accepted",
  );
  const refused: Record<string, string> = {
    "wrong issuer": environment.token("s", nonce, { iss: "https://accounts.google.com.evil.example" }),
    "cognito issuer": environment.token("s", nonce, {
      iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Synthetic2",
    }),
    "wrong audience": environment.token("s", nonce, { aud: "999999999999-other.apps.googleusercontent.com" }),
    "audience list": environment.token("s", nonce, {
      aud: [CLIENT, "999999999999-other.apps.googleusercontent.com"],
    }),
    "authorized party mismatch": environment.token("s", nonce, {
      azp: "999999999999-other.apps.googleusercontent.com",
    }),
    expired: environment.token("s", nonce, { iat: now - 7200, exp: now - 1 }),
    "issued in the future": environment.token("s", nonce, { iat: now + 600, exp: now + 4200 }),
    "not yet valid": environment.token("s", nonce, { nbf: now + 600 }),
    "absurd lifetime": environment.token("s", nonce, { exp: now + 86400 * 30 }),
    "email not verified": environment.token("s", nonce, { email_verified: false }),
    "email verified as a string": environment.token("s", nonce, { email_verified: "true" }),
    "email verification missing": environment.token("s", nonce, { email_verified: undefined }),
    "missing nonce": environment.token("s", nonce, { nonce: undefined }),
    "short nonce": environment.token("s", "short"),
    "nonce that is not a string": environment.token("s", nonce, { nonce: 12345678901234567890 }),
    "missing subject": environment.token("s", nonce, { sub: undefined }),
    "oversized subject": environment.token("s", nonce, { sub: "x".repeat(256) }),
    "signed by a key Google does not publish": environment.token("s", nonce, {}, {}, strangerKeys.privateKey),
    "unknown key ID": environment.token("s", nonce, {}, { kid: "unknown" }),
    "algorithm none": environment.token("s", nonce, {}, { alg: "none" }),
    "symmetric algorithm": environment.token("s", nonce, {}, { alg: "HS256" }),
    "embedded key": environment.token("s", nonce, {}, { jwk: publicJwk(strangerKeys, "x") }),
    "key URL": environment.token("s", nonce, {}, { jku: "https://attacker.example/keys" }),
    garbage: "not.a.jwt",
    "empty signature": environment.token("s", nonce).replace(/\.[^.]+$/, "."),
  };
  for (const [name, bearer] of Object.entries(refused))
    await assert.rejects(claimsFor(environment, bearer), { status: 401, code: "invalid_human" }, name);
  await assert.rejects(claimsFor(environment, undefined as unknown as string), { status: 401 });
  await assert.rejects(claimsFor(environment, "a".repeat(20000)), { status: 401 });
});

test("a Cognito token never works for the portal, and a Google token never works for a Cognito product", async () => {
  const environment = portal();
  const { fixture } = environment;
  const challenge = await fixture.challenge(0);
  const cognito = fixture.pair(0, challenge.nonce, "synthetic-google-mix");
  await assert.rejects(claimsFor(environment, cognito.access), { status: 401 });
  await assert.rejects(claimsFor(environment, cognito.id), { status: 401 });
  const google = environment.token("synthetic-google-mix", "mixed-nonce-0123456789abcdef");
  const crm = environment.products.find((product) => product.product === "cyclotron")!;
  await assert.rejects(cognitoClaims(google, crm, environment.keys, "access", fixture.now), { status: 401 });
  await assert.rejects(cognitoClaims(google, crm, environment.keys, "id", fixture.now), { status: 401 });
  // The Cognito role cannot present a Google token to enroll, and the portal role cannot present a Cognito pair.
  const asCrm = await environment.handler({
    ...environment.event("/v1/identities/google/resolve", { challengeId: challenge.challengeId }, google),
    requestContext: fixture.event(0, "/x").requestContext,
  });
  assert.equal(asCrm.statusCode, 401);
  const asPortal = await environment.request(
    "/v1/identities/google/resolve",
    { challengeId: challenge.challengeId },
    cognito.access,
  );
  assert.equal(asPortal.status, 401);
  assert.equal(fixture.repository.counts.associations, 0);
});

test("a google-direct registration is a read-only directory principal with exactly one Google client", () => {
  const base = {
    product: "anthus-one",
    roleArn: PORTAL_ROLE,
    issuer: GOOGLE_ISSUER,
    clientIds: [CLIENT],
    capabilities: ["console:read", "members:read"],
    enabled: true,
    accountDirectory: true,
    googleFederation: { policy: "google-direct-v1", reviewedPolicyId: "synthetic-review", clientId: CLIENT },
  };
  assert.equal(registrations([base]).length, 1);
  const variants: Array<[string, Record<string, unknown>]> = [
    ["cognito issuer", { issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Synthetic2" }],
    ["lookalike issuer", { issuer: "https://accounts.google.com.evil.example" }],
    ["not a directory principal", { accountDirectory: undefined }],
    ["a write capability", { capabilities: ["console:read", "members:write"] }],
    ["two clients", { clientIds: [CLIENT, "123456789012-other.apps.googleusercontent.com"] }],
    [
      "a non-Google client ID",
      { clientIds: ["abcdefg"], googleFederation: { ...base.googleFederation, clientId: "abcdefg" } },
    ],
    [
      "an execution delegation",
      {
        executionDelegation: {
          roleArn: "arn:aws:iam::111111111111:role/Other",
          enrollmentRoleArn: PORTAL_ROLE,
          issuer: GOOGLE_ISSUER,
          clientId: CLIENT,
          enrollmentPolicyRevision: "synthetic-review",
          reviewedPolicyId: "synthetic-pair",
        },
      },
    ],
  ];
  for (const [name, change] of variants)
    assert.throws(() => registrations([{ ...base, ...change }]), Error, name);
  // A Cognito product still cannot name Google as its issuer, and Google identities can never be operators.
  assert.throws(() =>
    registrations([
      { ...base, googleFederation: { ...base.googleFederation, policy: "google-only-unlinked-v1" } },
    ]),
  );
  assert.throws(() =>
    operatorGrants([
      {
        product: "anthus-one",
        issuer: GOOGLE_ISSUER,
        subjectHash: "a".repeat(64),
        permission: "accounts:admin:read",
        reviewedGrantId: "synthetic-grant",
      },
    ]),
  );
});

test("central Accounts refuses operator routes for a google-direct product before reading anything", async () => {
  const environment = portal();
  await environment.enroll("synthetic-google-operator");
  let reads = 0;
  const service = new Proxy({}, { get: () => (reads++, () => undefined) }) as never;
  const directory = accountDirectoryHandler(
    service,
    environment.products,
    environment.keys,
    () => environment.fixture.now,
    [],
  );
  const bearer = environment.token("synthetic-google-operator", "directory-nonce-0123456789");
  for (const path of [
    "/v1/account-directory/operator/accounts",
    `/v1/account-directory/operator/accounts/${randomUUID()}`,
    `/v1/account-directory/operator/accounts/${randomUUID()}/entitlements/cyclotron`,
  ]) {
    const response = await directory(
      environment.event(
        path,
        path.endsWith("cyclotron") ? { status: "active" } : {},
        bearer,
        path.endsWith("cyclotron") ? "POST" : "GET",
      ),
    );
    assert.equal(response.statusCode, 403, path);
    assert.equal(JSON.parse(response.body).error, "operator_forbidden");
  }
  assert.equal(reads, 0);
});

/** A BFF whose central transport is the real identity handler plus a directory stub that resolves the real Person. */
function customerBff(environment: ReturnType<typeof portal>, surface: "customer" | "staff" = "customer") {
  const calls: string[] = [];
  const central = async (path: string, method: string, body: unknown, access: string, key?: string) => {
    calls.push(`${method} ${path}`);
    if (path.startsWith("/v1/account-directory")) {
      const person = await googlePersonDirectory(
        environment.fixture.repository,
        environment.products,
      ).resolve(
        await context(
          environment.event(path, {}, access, method),
          environment.products,
          environment.keys,
          environment.fixture.now,
        ),
      );
      return decode(
        new Response(JSON.stringify({ person, accounts: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    const event = environment.event(path, body ?? {}, access, method);
    if (key) event.headers!["idempotency-key"] = key;
    const response = await environment.handler(event);
    return decode(new Response(response.body, { status: response.statusCode }));
  };
  const bff = accountsBffHandler({
    surface,
    origins: ["https://one.anth.us"],
    registration: surface === "customer" ? environment.registration : environment.products[0],
    keys: environment.keys,
    nowSeconds: () => environment.fixture.now,
    client: (access) =>
      new AccountsClient((path, method, body, key) => central(path, method, body, access ?? "", key)),
  });
  return { bff, calls };
}
const get = (path: string, bearer?: string) => ({
  rawPath: path,
  requestContext: { http: { method: "GET" } },
  headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
});
const post = (path: string, body: unknown, bearer: string, origin = "https://one.anth.us") => ({
  rawPath: path,
  requestContext: { http: { method: "POST" } },
  headers: { authorization: `Bearer ${bearer}`, origin, "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("the customer BFF enrolls with a Google bearer and resolves the same Person as the Cognito path", async () => {
  const environment = portal();
  const { fixture } = environment;
  const cognitoChallenge = await fixture.challenge(0);
  const crm = await fixture.resolve(
    0,
    cognitoChallenge.challengeId,
    fixture.pair(0, cognitoChallenge.nonce, "synthetic-google-bff"),
  );
  const { bff, calls } = customerBff(environment);
  const nonce = "bff-nonce-0123456789abcdefghij";
  const bearer = environment.token("synthetic-google-bff", nonce);
  // Before enrollment the list is empty with no Person; the portal then asks for a challenge.
  const unenrolled = await bff(get("/api/saas/accounts", bearer));
  assert.equal(unenrolled.statusCode, 200);
  assert.equal(JSON.parse(unenrolled.body).person, null);
  const challenge = await bff({
    rawPath: "/api/saas/identity/login-challenge",
    requestContext: { http: { method: "POST" } },
    headers: { origin: "https://one.anth.us", "content-type": "application/json" },
    body: JSON.stringify({ loginStateDigest: "b".repeat(64) }),
  });
  assert.equal(challenge.statusCode, 200);
  // A fresh credential carries the challenge nonce; a CRM-style idToken field is refused outright.
  const issued = JSON.parse(challenge.body);
  const fresh = environment.token("synthetic-google-bff", issued.nonce);
  const refusedBody = await bff(
    post("/api/saas/identity/resolve", { challengeId: issued.challengeId, idToken: fresh }, fresh),
  );
  assert.equal(refusedBody.statusCode, 400);
  const enrolled = await bff(
    post("/api/saas/identity/resolve", { challengeId: issued.challengeId, loginState: "x".repeat(8) }, fresh),
  );
  assert.equal(enrolled.statusCode, 401, "the challenge was bound to another login state");
  const challenge2 = JSON.parse(
    (
      await bff({
        rawPath: "/api/saas/identity/login-challenge",
        requestContext: { http: { method: "POST" } },
        headers: { origin: "https://one.anth.us", "content-type": "application/json" },
        body: JSON.stringify({
          loginStateDigest: (await import("node:crypto"))
            .createHash("sha256")
            .update("state-123456")
            .digest("hex"),
        }),
      })
    ).body,
  );
  const fresh2 = environment.token("synthetic-google-bff", challenge2.nonce);
  const done = await bff(
    post(
      "/api/saas/identity/resolve",
      { challengeId: challenge2.challengeId, loginState: "state-123456" },
      fresh2,
    ),
  );
  assert.equal(done.statusCode, 200);
  assert.equal(JSON.parse(done.body).person.id, crm.body.person.id);
  // Any later token for the same Google subject lists accounts for that same Person.
  const listed = await bff(
    get("/api/saas/accounts", environment.token("synthetic-google-bff", "another-nonce-0123456789abc")),
  );
  assert.equal(JSON.parse(listed.body).person.id, crm.body.person.id);
  assert.ok(calls.length > 0);
});

test("the customer BFF refuses operator routes, entitlement writes, other tokens and other origins before calling central", async () => {
  const environment = portal();
  await environment.enroll("synthetic-google-routes");
  const { bff, calls } = customerBff(environment);
  const bearer = environment.token("synthetic-google-routes", "routes-nonce-0123456789abcd");
  const id = randomUUID();
  for (const path of [
    "/api/saas/operator/accounts",
    `/api/saas/operator/accounts/${id}`,
    `/api/saas/operator/accounts/${id}/entitlements/cyclotron`,
    `/api/saas/accounts/${id}/memberships`,
    "/api/saas/unknown",
  ])
    assert.equal((await bff(get(path, bearer))).statusCode, 404, path);
  assert.equal(
    (
      await bff(
        post(`/api/saas/operator/accounts/${id}/entitlements/cyclotron`, { status: "active" }, bearer),
      )
    ).statusCode,
    404,
  );
  assert.equal(calls.length, 0, "central was never called");
  assert.equal((await bff(get("/api/saas/accounts"))).statusCode, 401);
  assert.equal(
    (
      await bff(
        post(
          "/api/saas/accounts",
          { name: "Workspace", requestKey: randomUUID() },
          bearer,
          "https://prospectus.anth.us",
        ),
      )
    ).statusCode,
    403,
    "the CRM origin is not a portal origin",
  );
  const { fixture } = environment;
  const cognito = fixture.pair(0, "n".repeat(20), "synthetic-google-routes");
  for (const wrong of [
    cognito.access,
    cognito.id,
    environment.token("synthetic-google-routes", "n".repeat(20), {
      aud: "999999999999-x.apps.googleusercontent.com",
    }),
    environment.token("synthetic-google-routes", "n".repeat(20), { email_verified: false }),
    environment.token("synthetic-google-routes", "n".repeat(20), { nonce: undefined }),
    environment.token("synthetic-google-routes", "n".repeat(20), {}, {}, strangerKeys.privateKey),
  ])
    assert.equal((await bff(get("/api/saas/accounts", wrong))).statusCode, 401);
  assert.equal(calls.length, 0);
  assert.equal((await bff(get("/api/saas/accounts", bearer))).statusCode, 200);
});

test("a Google token is refused by the CRM's staff BFF, and the surfaces cannot be mixed", async () => {
  const environment = portal();
  const { bff, calls } = customerBff(environment, "staff");
  const bearer = environment.token("synthetic-google-crm", "crm-nonce-0123456789abcdefgh");
  assert.equal((await bff(get("/api/saas/accounts", bearer))).statusCode, 401);
  assert.equal((await bff(get("/api/saas/operator/accounts", bearer))).statusCode, 401);
  assert.equal(calls.length, 0);
  const options = {
    origins: ["https://one.anth.us"],
    keys: environment.keys,
    client: () => new AccountsClient(async () => decode(new Response("{}"))),
  };
  assert.throws(() =>
    accountsBffHandler({ ...options, surface: "customer", registration: environment.products[0] }),
  );
  assert.throws(() => accountsBffHandler({ ...options, registration: environment.registration }));
});

test("Google's published keys are cached for their stated lifetime and refetched at most once a minute", async () => {
  let fetches = 0;
  let body = JSON.stringify({ keys: [publicJwk(googleKeys, "google-1")] });
  let status = 200;
  let now = 1_000_000;
  const fetcher = (async () => {
    fetches++;
    return new Response(body, { status, headers: { "cache-control": "public, max-age=3600" } });
  }) as unknown as typeof fetch;
  const keys = new GoogleKeys(fetcher, () => now);
  assert.equal((await keys.resolve(GOOGLE_ISSUER, "google-1")).kid, "google-1");
  assert.equal((await keys.resolve(GOOGLE_ISSUER, "google-1")).kid, "google-1");
  assert.equal(fetches, 1, "cached");
  await assert.rejects(keys.resolve(GOOGLE_ISSUER, "rotated"), { status: 401 });
  assert.equal(fetches, 1, "an unknown key ID within a minute does not refetch");
  now += 61_000;
  body = JSON.stringify({ keys: [publicJwk(googleKeys, "google-1"), publicJwk(strangerKeys, "rotated")] });
  assert.equal((await keys.resolve(GOOGLE_ISSUER, "rotated")).kid, "rotated");
  assert.equal(fetches, 2);
  now += 3_601_000;
  await keys.resolve(GOOGLE_ISSUER, "rotated");
  assert.equal(fetches, 3, "refetched after max-age");
  await assert.rejects(keys.resolve("https://evil.example", "google-1"), { status: 401 });
  // Google becomes unreachable once the keys are stale: serve the last good keys, back off, then fail closed.
  now += 3_700_000;
  status = 503;
  const before = fetches;
  assert.equal((await keys.resolve(GOOGLE_ISSUER, "google-1")).kid, "google-1");
  assert.equal(fetches, before + 1, "one attempt");
  assert.equal((await keys.resolve(GOOGLE_ISSUER, "google-1")).kid, "google-1");
  assert.equal(fetches, before + 1, "no second attempt inside the 30 second back-off");
  now += 31_000;
  assert.equal((await keys.resolve(GOOGLE_ISSUER, "google-1")).kid, "google-1");
  assert.equal(fetches, before + 2, "retried after the back-off");
  await assert.rejects(keys.resolve(GOOGLE_ISSUER, "never-seen"), { status: 401 });
  now += 6 * 3600_000;
  await assert.rejects(
    keys.resolve(GOOGLE_ISSUER, "google-1"),
    { status: 401 },
    "fails closed after 6 hours",
  );
  // Recovery: once Google answers again the next attempt after the back-off restores service.
  status = 200;
  now += 31_000;
  assert.equal((await keys.resolve(GOOGLE_ISSUER, "google-1")).kid, "google-1");
  // A bad key set never replaces a good one, and a never-fetched cache fails closed.
  body = JSON.stringify({ keys: [{ ...publicJwk(googleKeys, "weak"), alg: "HS256" }] });
  now += 61_000;
  await assert.rejects(keys.resolve(GOOGLE_ISSUER, "weak"), { status: 401 });
  body = JSON.stringify({
    keys: Array.from({ length: 11 }, (_, index) => publicJwk(googleKeys, `k${index}`)),
  });
  now += 3_700_000;
  await assert.rejects(keys.resolve(GOOGLE_ISSUER, "k1"), { status: 401 });
  status = 503;
  await assert.rejects(new GoogleKeys(fetcher, () => now).resolve(GOOGLE_ISSUER, "google-1"), {
    status: 401,
  });
});

test("the customer BFF turns the account limit into a clear 409 and a second-key conflict into a different message", async () => {
  const environment = portal();
  const bearer = environment.token("synthetic-google-limit", "limit-nonce-0123456789abcdef");
  const bffFor = (error: AccountsClientError) =>
    accountsBffHandler({
      surface: "customer",
      origins: ["https://one.anth.us"],
      registration: environment.registration,
      keys: environment.keys,
      nowSeconds: () => environment.fixture.now,
      client: () =>
        new AccountsClient(async () => {
          throw error;
        }),
    });
  const create = (bff: ReturnType<typeof bffFor>) =>
    bff(post("/api/saas/accounts", { name: "Workspace", requestKey: randomUUID() }, bearer));
  const limited = await create(bffFor(new AccountsClientError(409, "account_limit", "internal")));
  assert.equal(limited.statusCode, 409);
  assert.equal(JSON.parse(limited.body).error, "account_limit");
  assert.match(JSON.parse(limited.body).message, /account limit; contact us/);
  const conflict = await create(bffFor(new AccountsClientError(409, "idempotency_conflict", "internal")));
  assert.match(JSON.parse(conflict.body).message, /already used/);
});
