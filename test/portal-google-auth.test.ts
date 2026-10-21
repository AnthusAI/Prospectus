import assert from "node:assert/strict";
import test from "node:test";

const store = new Map<string, string>();
Object.assign(globalThis, {
  sessionStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
});
const { acceptCredential, enrollIfFresh, getIdToken, clearPortalSession, decodeClaims } = await import(
  "../src/portal/google-auth"
);

const CLIENT = "123456789012-syntheticportalclient.apps.googleusercontent.com";
const NONCE = "n".repeat(32);
const jwt = (claims: Record<string, unknown>) =>
  `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
const claims = (now: number, overrides: Record<string, unknown> = {}) => ({
  aud: CLIENT,
  nonce: NONCE,
  email_verified: true,
  exp: Math.floor(now / 1000) + 3600,
  ...overrides,
});

test("the browser keeps only credentials for this client, this challenge nonce and a verified email", () => {
  const now = 1_900_000_000_000;
  clearPortalSession();
  for (const overrides of [
    { aud: "999999999999-other.apps.googleusercontent.com" },
    { nonce: "another-nonce-0123456789abcdef" },
    { nonce: undefined },
    { email_verified: false },
    { exp: Math.floor(now / 1000) - 1 },
  ])
    assert.equal(acceptCredential(jwt(claims(now, overrides)), NONCE, CLIENT, now), false);
  assert.equal(acceptCredential("not-a-jwt", NONCE, CLIENT, now), false);
  assert.equal(acceptCredential(undefined, NONCE, CLIENT, now), false);
  assert.equal(getIdToken(now), null);
  const good = jwt(claims(now));
  assert.equal(acceptCredential(good, NONCE, CLIENT, now), true);
  assert.equal(getIdToken(now), good);
  assert.equal(getIdToken(now + 3_600_000), null, "an expired credential is never offered");
  assert.equal(decodeClaims(good)?.aud, CLIENT);
});

test("a credential confirms itself once, only while its challenge is fresh, and sends no ID token in the body", async () => {
  const now = 1_900_000_000_000;
  clearPortalSession();
  const good = jwt(claims(now));
  acceptCredential(good, NONCE, CLIENT, now);
  const request: { url?: string; init?: RequestInit } = {};
  const fetcher = (async (url: string, init: RequestInit) => {
    Object.assign(request, { url, init });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const challenge = {
    challengeId: "11111111-1111-4111-8111-111111111111",
    nonce: NONCE,
    challengeToken: "v1.k.p.m",
  };
  const remember = (issuedAt: number) =>
    store.set("anthus-one.login", JSON.stringify({ state: "login-state-123", challenge, issuedAt }));

  assert.equal(await enrollIfFresh("https://api.example/api/saas", fetcher, now), false, "no login recorded");
  remember(now - 300_000);
  assert.equal(await enrollIfFresh("https://api.example/api/saas", fetcher, now), false, "challenge too old");
  remember(now - 1_000);
  assert.equal(await enrollIfFresh("https://api.example/api/saas/", fetcher, now), true);
  assert.equal(request.url, "https://api.example/api/saas/identity/resolve");
  assert.equal((request.init!.headers as Record<string, string>).authorization, `Bearer ${good}`);
  assert.deepEqual(JSON.parse(request.init!.body as string), {
    challengeToken: "v1.k.p.m",
    loginState: "login-state-123",
  });
  assert.equal(await enrollIfFresh("https://api.example/api/saas", fetcher, now), false, "used only once");
  // A credential for some other nonce cannot answer this challenge.
  clearPortalSession();
  acceptCredential(jwt(claims(now, { nonce: "o".repeat(32) })), "o".repeat(32), CLIENT, now);
  remember(now - 1_000);
  assert.equal(await enrollIfFresh("https://api.example/api/saas", fetcher, now), false);
});
