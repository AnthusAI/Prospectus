import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, randomUUID, sign, type JsonWebKey } from "node:crypto";
import { canonicalAccountsHandler } from "./canonical-handler";
import { VirtuusIdentityFiles, VirtuusAccountFiles, type IdentityFiles } from "./identity-files";
import { DurableGoogleIdentities } from "./durable-google-identities";
import { DurableAccountsService } from "./durable-accounts";
import { googlePersonDirectory } from "./person-directory";
import { registrations } from "./registration";
import { context, type ProductRegistration, type RestEvent } from "./auth";
import { editorSiteRegistrations, papyrusSiteRegistrations } from "./papyrus-sites";
import { labVerifier } from "./lab-verifier";

// Synthetic only: one throwaway RSA key signs every token, and every ARN, pool and client is invented.
const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});
const NOW = 1900000000;
const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicKey = keyPair.publicKey.export({ format: "jwk" });
const pool = (name: string) => `https://cognito-idp.us-east-1.amazonaws.com/us-east-1_${name}`;
const siteEntry = (letter: string) => ({
  product: `papyrus-synth-${letter}`,
  roleArn: `arn:aws:iam::111111111111:role/SynthSite${letter.toUpperCase()}`,
  issuer: pool(`Site${letter.toUpperCase()}`),
  clientId: `site${letter}client`,
  federationReviewId: `synth-federation-${letter}`,
  siteReviewId: `synth-site-${letter}`,
});
const sites = papyrusSiteRegistrations([siteEntry("a"), siteEntry("b")]);
const [siteA, siteB] = sites;
const [reader] = papyrusSiteRegistrations([{ ...siteEntry("r"), audience: "public-reader" }]);
const cyclotron: ProductRegistration = {
  product: "cyclotron",
  roleArn: "arn:aws:iam::111111111111:role/SynthCyclotronBff",
  issuer: pool("Console"),
  clientIds: ["consoleclient"],
  capabilities: ["console:read", "console:write", "members:read", "members:write"],
  enabled: true,
  googleFederation: {
    policy: "google-only-unlinked-v1",
    reviewedPolicyId: "synth-console-federation",
    clientId: "consoleclient",
  },
};
const crm: ProductRegistration = {
  product: "prospectus-directory",
  roleArn: "arn:aws:iam::111111111111:role/SynthCrm",
  issuer: pool("Crm"),
  clientIds: ["crmclient"],
  capabilities: ["console:read", "members:read"],
  enabled: true,
  accountDirectory: true,
  googleFederation: {
    policy: "google-only-unlinked-v1",
    reviewedPolicyId: "synth-crm-federation",
    clientId: "crmclient",
  },
};
const VERIFIER_ROLE = "arn:aws:iam::222222222222:role/SynthLabVerifier";
const verifierConfiguration = (registered: readonly ProductRegistration[] = sites) =>
  labVerifier({ roleArn: VERIFIER_ROLE, reviewId: "synth-verifier-v1" }, registered);
const registry = (extra: ProductRegistration[] = [], withVerifier = true) =>
  registrations(
    [cyclotron, crm, ...sites, ...extra],
    withVerifier ? { labVerifier: verifierConfiguration([...sites, ...extra]) } : {},
  );
const knownPools = [cyclotron, crm, ...sites, reader].map((product) => product.issuer).concat(pool("SiteC"));
const keys = async (issuer: string, kid: string): Promise<JsonWebKey> => {
  if (!knownPools.includes(issuer) || kid !== "synthetic") throw new Error("Unknown synthetic key");
  return publicKey;
};

interface Tokens {
  access: string;
  id: string;
}
function sign_(claims: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "synthetic" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), keyPair.privateKey);
  return `${header}.${payload}.${signature.toString("base64url")}`;
}
function mint(
  registration: Pick<ProductRegistration, "issuer" | "clientIds">,
  subject: string,
  googleSubject: string,
  nonce = "unused",
  overrides: Record<string, unknown> = {},
): Tokens {
  const shared = {
    iss: registration.issuer,
    sub: subject,
    auth_time: NOW,
    origin_jti: `family-${subject}`,
    iat: NOW,
    exp: NOW + 3600,
  };
  return {
    access: sign_({
      ...shared,
      client_id: registration.clientIds[0],
      token_use: "access",
      jti: randomUUID(),
      ...overrides,
    }),
    id: sign_({
      ...shared,
      aud: registration.clientIds[0],
      token_use: "id",
      jti: randomUUID(),
      nonce,
      email: "editor@example.com",
      identities: [
        { providerName: "Google", providerType: "Google", userId: googleSubject, primary: "true" },
      ],
    }),
  };
}
const sessionFor = (roleArn: string) => {
  const [, , , , accountId, role] = roleArn.split(":");
  return {
    accountId,
    userArn: `arn:aws:sts::${accountId}:assumed-role/${role.split("/").pop()}/synthetic-session`,
  };
};
function event(
  roleArn: string,
  path: string,
  method = "POST",
  body: unknown = {},
  tokens?: Partial<Tokens>,
): RestEvent {
  return {
    httpMethod: method,
    path,
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(tokens?.access ? { "x-prospectus-human-token": tokens.access } : {}),
      ...(tokens?.id ? { "x-prospectus-identity-token": tokens.id } : {}),
    },
    requestContext: { identity: sessionFor(roleArn) },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "prospectus-lab-verifier-"));
  roots.push(root);
  const identities = new VirtuusIdentityFiles(root),
    accounts = new VirtuusAccountFiles(root);
  const products = registry();
  const make = (
    registered = products,
    identityFiles: IdentityFiles = identities,
    accountFiles: IdentityFiles = accounts,
  ) => canonicalAccountsHandler(identityFiles, accountFiles, registered, keys, () => NOW);
  const run = async (request: RestEvent, target = make()) => {
    const result = await target(request);
    return { status: result.statusCode, body: JSON.parse(result.body) };
  };
  async function enroll(registration: ProductRegistration, subject: string, googleSubject: string) {
    const challenge = (await run(event(registration.roleArn, "/v1/identities/google/challenge"))).body;
    const tokens = mint(registration, subject, googleSubject, challenge.nonce);
    const resolved = await run(
      event(
        registration.roleArn,
        "/v1/identities/google/resolve",
        "POST",
        { challengeId: challenge.challengeId },
        tokens,
      ),
    );
    assert.equal(resolved.status, 200);
    return { tokens, person: resolved.body.person as { id: string } };
  }
  // The same Google person signs in to the console (cyclotron) and, separately, at a Papyrus site.
  const alice = {
    console: await enroll(cyclotron, "console-alice", "google-alice"),
    site: await enroll(siteA, "a-alice", "google-alice"),
  };
  const people = {
    alice,
    bob: { site: await enroll(siteA, "a-bob", "google-bob") },
    carol: { site: await enroll(siteB, "b-carol", "google-carol") },
    erin: { site: await enroll(siteB, "b-erin", "google-erin") },
    dave: { site: await enroll(siteA, "a-dave", "google-dave") },
    frank: { site: await enroll(siteA, "a-frank", "google-frank") },
  };
  assert.equal(alice.console.person.id, alice.site.person.id, "one Person across pools");
  const create = event(
    cyclotron.roleArn,
    "/v1/accounts",
    "POST",
    { name: "Synthetic lab" },
    alice.console.tokens,
  );
  create.headers!["idempotency-key"] = randomUUID();
  const created = await run(create);
  assert.equal(created.status, 200);
  const labAccount = created.body.account.id as string;
  const member = async (account: string, personId: string, role: string, status = "active") =>
    assert.equal(
      (
        await run(
          event(
            cyclotron.roleArn,
            `/v1/accounts/${account}/memberships`,
            "POST",
            { personId, role, status },
            alice.console.tokens,
          ),
        )
      ).status,
      200,
    );
  await member(labAccount, people.bob.site.person.id, "viewer");
  await member(labAccount, people.carol.site.person.id, "member");
  await member(labAccount, people.erin.site.person.id, "admin");
  await member(labAccount, people.frank.site.person.id, "member");
  await member(labAccount, people.frank.site.person.id, "member", "revoked");
  // An account the person owns that never had the cyclotron product, created through a Papyrus site.
  const papyrusOnly = event(
    siteA.roleArn,
    "/v1/accounts",
    "POST",
    { name: "Synthetic newsroom" },
    alice.site.tokens,
  );
  papyrusOnly.headers!["idempotency-key"] = randomUUID();
  const newsroom = (await run(papyrusOnly)).body.account.id as string;
  // An account whose cyclotron entitlement was later disabled.
  const second = event(
    cyclotron.roleArn,
    "/v1/accounts",
    "POST",
    { name: "Synthetic disabled lab" },
    alice.console.tokens,
  );
  second.headers!["idempotency-key"] = randomUUID();
  const disabledLab = (await run(second)).body.account.id as string;
  const operator = await context(
    event(cyclotron.roleArn, "/v1/accounts", "GET", {}, alice.console.tokens),
    products,
    keys,
    NOW,
  );
  await new DurableAccountsService(
    accounts,
    googlePersonDirectory(new DurableGoogleIdentities(identities), products),
  ).setEntitlement(
    operator,
    disabledLab,
    { product: "cyclotron", capabilities: ["console:read", "console:write"] },
    "disabled",
  );
  const asVerifier = (path: string, method = "GET", body: unknown = {}, tokens?: Partial<Tokens>) =>
    event(VERIFIER_ROLE, path, method, body, tokens);
  const me = (tokens: Partial<Tokens>, target = make()) =>
    run(asVerifier("/v1/identities/me", "GET", {}, tokens), target);
  const authorize = (account: string, operation: string, tokens: Partial<Tokens>, target = make()) =>
    run(asVerifier(`/v1/accounts/${account}/authorize`, "POST", { operation }, tokens), target);
  return {
    root,
    identities,
    accounts,
    products,
    make,
    run,
    enroll,
    people,
    labAccount,
    newsroom,
    disabledLab,
    asVerifier,
    me,
    authorize,
  };
}
const generic = { error: "forbidden", message: "Account operation is not permitted." };

test("a registered Papyrus site token is accepted on identities/me and accounts/authorize", async () => {
  const env = await fixture();
  const identified = await env.me(env.people.alice.site.tokens);
  assert.equal(identified.status, 200);
  assert.deepEqual(identified.body, { person: env.people.alice.site.person });
  const stored = await env.accounts.get(`accounts/${env.labAccount}.json`);
  const authorized = await env.authorize(env.labAccount, "console:read", env.people.alice.site.tokens);
  assert.equal(authorized.status, 200);
  assert.deepEqual(authorized.body, {
    allowed: true,
    accountId: env.labAccount,
    personId: env.people.alice.site.person.id,
    product: "cyclotron",
    role: "owner",
    operation: "console:read",
    revision: (stored!.value as any).account.revision,
  });
  // A token from the other registered site works the same way: the registry, not a copy, decides.
  const other = await env.authorize(env.labAccount, "console:write", env.people.carol.site.tokens);
  assert.equal(other.status, 200);
  assert.equal(other.body.role, "member");
});

test("role caps capabilities: the verifier never grants more than the Prospectus membership and cyclotron entitlement", async (testContext) => {
  const env = await fixture();
  const cases: Array<[keyof typeof env.people, string, number]> = [
    ["alice", "console:read", 200],
    ["alice", "console:write", 200],
    ["erin", "console:write", 200],
    ["carol", "console:write", 200],
    ["bob", "console:read", 200],
    ["bob", "console:write", 403],
    // The verifier never carries member management, even for an owner or admin.
    ["alice", "members:read", 403],
    ["alice", "members:write", 403],
    ["erin", "members:write", 403],
  ];
  for (const [name, operation, status] of cases)
    await testContext.test(`${name} ${operation}`, async () => {
      const result = await env.authorize(env.labAccount, operation, env.people[name].site.tokens);
      assert.equal(result.status, status);
      assert.equal(result.body.allowed === true, status === 200);
    });
  assert.equal(
    (await env.authorize(env.labAccount, "console:read", env.people.bob.site.tokens)).body.role,
    "viewer",
  );
  assert.equal((await env.authorize(env.labAccount, "nonsense", env.people.alice.site.tokens)).status, 403);
});

test("a site registration's capabilities are a ceiling on what the verifier can authorize", async () => {
  const env = await fixture();
  const readOnlySite = { ...siteB, capabilities: ["console:read" as const] };
  const products = registrations([cyclotron, crm, siteA, readOnlySite], {
    labVerifier: verifierConfiguration([siteA, readOnlySite]),
  });
  const target = env.make(products);
  assert.equal(
    (await env.authorize(env.labAccount, "console:read", env.people.carol.site.tokens, target)).status,
    200,
  );
  assert.equal(
    (await env.authorize(env.labAccount, "console:write", env.people.carol.site.tokens, target)).status,
    403,
  );
});

test("only an access token of a registered Papyrus site is accepted, and every other token fails identically", async (testContext) => {
  const env = await fixture();
  const real = env.people.alice.site.tokens;
  const decode = (token: string) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  const claims = decode(real.access);
  const tampered = real.access.slice(0, -4) + (real.access.endsWith("AAAA") ? "BBBB" : "AAAA");
  const google = sign_({
    iss: "https://accounts.google.com",
    aud: "712526614578-example.apps.googleusercontent.com",
    sub: "google-alice",
    iat: NOW,
    exp: NOW + 3600,
  });
  const cases: Array<[string, string]> = [
    ["CRM pool", mint(crm, "crm-alice", "google-alice").access],
    ["console pool and client", mint(cyclotron, "console-alice", "google-alice").access],
    ["Google ID token", google],
    [
      "unregistered pool",
      mint({ issuer: pool("Elsewhere"), clientIds: ["elsewhereclient"] }, "x", "google-alice").access,
    ],
    [
      "registered pool, unregistered client",
      mint({ issuer: siteA.issuer, clientIds: ["otherclient"] }, "x", "google-alice").access,
    ],
    [
      "site A client on site B pool",
      mint({ issuer: siteB.issuer, clientIds: siteA.clientIds }, "x", "google-alice").access,
    ],
    ["tampered signature", tampered],
    ["expired", mint(siteA, claims.sub, "google-alice", "unused", { iat: NOW - 7200, exp: NOW - 10 }).access],
    ["ID token", real.id],
    ["not a JWT", "not-a-token"],
  ];
  let first: unknown;
  for (const [name, access] of cases)
    await testContext.test(name, async () => {
      const result = await env.me({ access });
      assert.equal(result.status, 401);
      first ??= result.body;
      assert.deepEqual(result.body, first, "no oracle for which issuers or clients are registered");
      const authorized = await env.authorize(env.labAccount, "console:read", { access });
      assert.equal(authorized.status, 401);
      assert.equal(authorized.body.allowed, undefined);
    });
  assert.equal((await env.me({})).status, 401);
});

test("the verifier reaches nothing but the two routes, and denial happens before any side effect", async (testContext) => {
  const env = await fixture();
  const before = await env.accounts.get(`accounts/${env.labAccount}.json`);
  let writes = 0;
  const observe = (files: IdentityFiles): IdentityFiles => ({
    get: (path) => files.get(path),
    list: (prefix) => files.list(prefix),
    commit: async (...args) => {
      writes++;
      return files.commit(...args);
    },
  });
  const target = env.make(env.products, observe(env.identities), observe(env.accounts));
  const tokens = env.people.alice.site.tokens;
  const calls: Array<[string, string, unknown]> = [
    ["/v1/identities/google/challenge", "POST", {}],
    ["/v1/identities/google/resolve", "POST", { challengeId: randomUUID() }],
    ["/v1/identities/resolve", "POST", {}],
    ["/v1/identities/link", "POST", {}],
    ["/v1/accounts", "GET", {}],
    ["/v1/accounts", "POST", { name: "Denied" }],
    [`/v1/accounts/${env.labAccount}`, "GET", {}],
    [
      `/v1/accounts/${env.labAccount}/memberships`,
      "POST",
      { personId: env.people.bob.site.person.id, role: "owner", status: "active" },
    ],
    ["/v1/account-directory", "GET", {}],
    [`/v1/account-directory/${env.labAccount}`, "GET", {}],
    [`/v1/account-directory/operator/accounts/${env.labAccount}/entitlements/cyclotron`, "POST", {}],
    ["/v1/identities/me", "POST", {}],
    ["/v1/identities/me/", "GET", {}],
    [`/v1/accounts/${env.labAccount}/authorize`, "GET", {}],
    [`/v1/accounts/${env.labAccount}/authorize/extra`, "POST", {}],
  ];
  for (const [path, method, body] of calls)
    await testContext.test(`${method} ${path}`, async () => {
      const result = await env.run(env.asVerifier(path, method, body, tokens), target);
      assert.equal(result.status, 403);
      assert.equal(result.body.error, "verifier_route_forbidden");
    });
  assert.equal(writes, 0);
  assert.deepEqual(await env.accounts.get(`accounts/${env.labAccount}.json`), before);
});

test("without both a current membership and an active cyclotron entitlement the answer is one generic refusal", async (testContext) => {
  const env = await fixture();
  const cases: Array<[string, string, Partial<Tokens>]> = [
    ["not a member", env.labAccount, env.people.dave.site.tokens],
    ["membership revoked", env.labAccount, env.people.frank.site.tokens],
    ["only the Papyrus product is entitled", env.newsroom, env.people.alice.site.tokens],
    ["cyclotron entitlement disabled", env.disabledLab, env.people.alice.site.tokens],
    ["account does not exist", randomUUID(), env.people.alice.site.tokens],
  ];
  for (const [name, account, tokens] of cases)
    await testContext.test(name, async () => {
      const result = await env.authorize(account, "console:read", tokens);
      assert.equal(result.status, 403);
      assert.deepEqual(result.body, generic);
    });
});

test("the verifier cannot enumerate accounts or people", async () => {
  const env = await fixture();
  const dave = env.people.dave.site;
  // A person with no memberships learns nothing: real, papyrus-only, disabled and invented accounts look identical.
  const probes = [env.labAccount, env.newsroom, env.disabledLab, randomUUID(), randomUUID()];
  const answers = await Promise.all(
    probes.map((account) => env.authorize(account, "console:read", dave.tokens)),
  );
  for (const answer of answers) assert.deepEqual(answer, { status: 403, body: generic });
  // identities/me answers only for the token holder and takes no person selector.
  const mine = await env.me(dave.tokens);
  assert.deepEqual(mine.body, { person: dave.person });
  assert.notEqual(mine.body.person.id, env.people.alice.site.person.id);
  const selector = await env.run(
    env.asVerifier("/v1/identities/me", "GET", { personId: env.people.alice.site.person.id }, dave.tokens),
  );
  assert.equal(selector.status, 400);
  const personProbe = await env.run(
    env.asVerifier(
      `/v1/accounts/${env.labAccount}/authorize`,
      "POST",
      { operation: "console:read", personId: env.people.alice.site.person.id },
      dave.tokens,
    ),
  );
  assert.equal(personProbe.status, 400);
  assert.equal(personProbe.body.person, undefined);
  // A valid token for a person Prospectus has never enrolled through the site is told only about itself.
  const stranger = mint(siteA, "a-stranger", "google-stranger");
  assert.deepEqual((await env.me(stranger)).body, { person: null });
  assert.equal((await env.authorize(env.labAccount, "console:read", stranger)).status, 403);
});

test("the registry is the only list: a site added to it is accepted and an absent one is not", async () => {
  const env = await fixture();
  const extra = papyrusSiteRegistrations([siteEntry("c")])[0];
  const withC = env.make(registry([extra]));
  const tokenC = mint(extra, "c-newcomer", "google-newcomer");
  assert.deepEqual((await env.me(tokenC, withC)).body, { person: null });
  assert.equal((await env.me(tokenC)).status, 401);
});

test("the verifier is unregistered when disabled and cannot weaken the existing registrations", async () => {
  const env = await fixture();
  const disabled = env.make(registry([], false));
  assert.equal((await env.me(env.people.alice.site.tokens, disabled)).status, 403);
  // Role names stay unique across every registration, the verifier included, even across accounts' paths.
  const verifier = verifierConfiguration();
  for (const roleArn of [cyclotron.roleArn, siteA.roleArn, crm.roleArn])
    assert.throws(() => registrations([cyclotron, crm, ...sites], { labVerifier: { ...verifier, roleArn } }));
  assert.throws(() =>
    registrations([cyclotron, crm, ...sites], {
      labVerifier: { ...verifier, roleArn: "arn:aws:iam::111111111111:role/some/path/SynthCrm" },
    }),
  );
  // It trusts registered sites exactly as reviewed, nothing else.
  assert.throws(() => registrations([cyclotron, crm, siteA], { labVerifier: verifier }));
  assert.throws(() =>
    registrations([cyclotron, crm, ...sites], {
      labVerifier: { ...verifier, sites: [{ ...siteA, clientIds: ["other"] }] },
    }),
  );
  assert.throws(() => verifierConfiguration([cyclotron]));
  assert.throws(() => verifierConfiguration([]));
  assert.throws(() => verifierConfiguration([{ ...siteA, googleFederation: undefined }]));
  assert.throws(() => labVerifier({ roleArn: "not-an-arn", reviewId: "x" }, sites));
  assert.throws(() => labVerifier({ roleArn: VERIFIER_ROLE, reviewId: "x", extra: true }, sites));
  // Existing callers keep exactly their routes and the verifier's session is not theirs.
  const stillWorks = await env.run(
    event(siteA.roleArn, "/v1/identities/me", "GET", {}, env.people.alice.site.tokens),
  );
  assert.equal(stillWorks.status, 200);
  assert.equal(
    (await env.run(event("arn:aws:iam::222222222222:role/Unknown", "/v1/identities/me", "GET"))).status,
    403,
  );
  const staticRole = event(VERIFIER_ROLE, "/v1/identities/me", "GET", {}, env.people.alice.site.tokens);
  staticRole.requestContext!.identity!.userArn = VERIFIER_ROLE;
  assert.equal((await env.run(staticRole)).status, 403);
});

test("a public-reader site is a real caller that signs in and sees nothing: no accounts, no authority, no directory, no writes", async (testContext) => {
  const env = await fixture();
  // Registered the way the Lambda does it: the verifier is built from the editor sites only.
  const withReader = registrations([cyclotron, crm, ...sites, reader], {
    labVerifier: verifierConfiguration(editorSiteRegistrations([...sites, reader])),
  });
  const target = env.make(withReader);
  // Alice owns real accounts; the same Person signs in at the reader site.
  const challenge = (await env.run(event(reader.roleArn, "/v1/identities/google/challenge"), target)).body;
  const tokens = mint(reader, "r-alice", "google-alice", challenge.nonce);
  const resolved = await env.run(
    event(
      reader.roleArn,
      "/v1/identities/google/resolve",
      "POST",
      { challengeId: challenge.challengeId },
      tokens,
    ),
    target,
  );
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.person.id, env.people.alice.site.person.id);
  const asReader = (path: string, method = "GET", body: unknown = {}) =>
    env.run(event(reader.roleArn, path, method, body, tokens), target);
  const before = await env.accounts.get(`accounts/${env.labAccount}.json`);

  const me = await asReader("/v1/identities/me");
  assert.equal(me.status, 200);
  assert.equal(me.body.person.id, env.people.alice.site.person.id);

  const list = await asReader("/v1/accounts");
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.accounts, []);

  const forbidden: Array<[string, string, string, unknown]> = [
    [
      "authorize on an account she owns",
      `/v1/accounts/${env.labAccount}/authorize`,
      "POST",
      { operation: "console:read" },
    ],
    [
      "authorize on an unknown account",
      `/v1/accounts/${randomUUID()}/authorize`,
      "POST",
      { operation: "console:read" },
    ],
    ["create an account", "/v1/accounts", "POST", { name: "Reader account" }],
    [
      "change a membership",
      `/v1/accounts/${env.labAccount}/memberships`,
      "POST",
      { personId: env.people.bob.site.person.id, role: "owner", status: "active" },
    ],
    ["the directory list", "/v1/account-directory", "GET", {}],
    ["the directory detail of an existing account", `/v1/account-directory/${env.labAccount}`, "GET", {}],
    ["the directory detail of an invented account", `/v1/account-directory/${randomUUID()}`, "GET", {}],
    ["the account detail of an existing account", `/v1/accounts/${env.labAccount}`, "GET", {}],
    ["the account detail of an invented account", `/v1/accounts/${randomUUID()}`, "GET", {}],
  ];
  const answers: Record<string, { status: number; body: any }> = {};
  for (const [name, path, method, body] of forbidden)
    await testContext.test(name, async () => {
      const request = event(reader.roleArn, path, method, body, tokens);
      if (method === "POST") request.headers!["idempotency-key"] = randomUUID();
      const result = await env.run(request, target);
      assert.equal(result.status, 403);
      answers[name] = result;
    });
  // Existence is not observable: the same refusal whether or not the account exists.
  assert.deepEqual(
    answers["the directory detail of an existing account"],
    answers["the directory detail of an invented account"],
  );
  assert.deepEqual(
    answers["the account detail of an existing account"],
    answers["the account detail of an invented account"],
  );
  assert.deepEqual(answers["authorize on an account she owns"], answers["authorize on an unknown account"]);
  // Nothing was written by any of it.
  assert.deepEqual(await env.accounts.get(`accounts/${env.labAccount}.json`), before);
});

test("the lab verifier does not accept a reader site's token and refuses to be built with a reader", async () => {
  const env = await fixture();
  const readerTokens = mint(reader, "r-alice", "google-alice");
  const verifier = verifierConfiguration(editorSiteRegistrations([...sites, reader]));
  assert.deepEqual(
    verifier.sites.map((site) => site.product),
    sites.map((site) => site.product),
  );
  const target = env.make(registrations([cyclotron, crm, ...sites, reader], { labVerifier: verifier }));
  const refused = await env.me(readerTokens, target);
  assert.equal(refused.status, 401);
  assert.deepEqual(
    refused,
    await env.me(mint(siteA, "forged", "google-x", "unused", { client_id: "nope" }), target),
  );
  assert.throws(() => verifierConfiguration([...sites, reader]), /never trusts a public-reader/);
  assert.throws(() => verifierConfiguration([reader]), /never trusts a public-reader/);
  assert.throws(
    () => verifierConfiguration([{ ...siteA, capabilities: [] }]),
    /never trusts a public-reader/,
  );
});
