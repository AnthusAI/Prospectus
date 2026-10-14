import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import { finishSignIn, getAccessToken, signIn } from "../src/auth";

const configuration = {
  domain: "https://prospectus.auth.example.invalid",
  clientId: "public-client",
  redirectUri: "https://prospectus.example.invalid/",
  logoutUri: "https://prospectus.example.invalid/",
};

function browser(context: TestContext, search = "") {
  const values = new Map<string, string>();
  let destination = "";
  let cleaned = "";
  context.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected token exchange"); });
  const originals = ["sessionStorage", "window"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: { search, assign: (url: URL) => { destination = String(url); } },
    history: { replaceState: (_state: unknown, _title: string, url: string) => { cleaned = url; } },
  } });
  context.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return { values, destination: () => destination, cleaned: () => cleaned };
}

test("Google sign-in requests an authorization code with a verifiable S256 challenge", async (context) => {
  const environment = browser(context);
  await signIn(configuration);
  const url = new URL(environment.destination());
  const login = JSON.parse(environment.values.get("prospectus.login")!);
  assert.equal(url.origin, configuration.domain);
  assert.equal(url.pathname, "/oauth2/authorize");
  assert.equal(url.searchParams.get("identity_provider"), "Google");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), configuration.clientId);
  assert.equal(url.searchParams.get("redirect_uri"), configuration.redirectUri);
  assert.equal(url.searchParams.get("state"), login.state);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), createHash("sha256").update(login.verifier).digest("base64url"));
  assert.ok(login.verifier.length >= 43);
  assert.equal(url.searchParams.has("code_verifier"), false);
});

test("verified callback exchanges the saved verifier and retains the access token", async (context) => {
  const environment = browser(context, "?code=authorization-code&state=expected-state");
  environment.values.set("prospectus.login", JSON.stringify({ state: "expected-state", verifier: "saved-verifier" }));
  context.mock.method(globalThis, "fetch", async (input: URL, options: RequestInit) => {
    assert.equal(String(input), `${configuration.domain}/oauth2/token`);
    const body = options.body as URLSearchParams;
    assert.equal(body.get("code_verifier"), "saved-verifier");
    assert.equal(body.get("code"), "authorization-code");
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(body.get("client_id"), configuration.clientId);
    assert.equal(body.get("redirect_uri"), configuration.redirectUri);
    return Response.json({ access_token: "api-access-token", id_token: "unused-id-token", expires_in: 3600 });
  });
  assert.equal(await finishSignIn(configuration), true);
  assert.equal(getAccessToken(), "api-access-token");
  assert.equal(environment.values.has("prospectus.login"), false);
  assert.equal(environment.cleaned(), "/");
  await assert.rejects(finishSignIn(configuration), /could not be verified/);
});

for (const [name, saved, query, message] of [
  ["mismatched state", JSON.stringify({ state: "other", verifier: "saved" }), "?code=code&state=expected", /could not be verified/],
  ["missing verifier", JSON.stringify({ state: "expected" }), "?code=code&state=expected", /could not be verified/],
  ["malformed login", "{", "?code=code&state=expected", /could not be verified/],
  ["provider rejection", JSON.stringify({ state: "expected", verifier: "saved" }), "?error=access_denied&state=expected", /not completed/],
  ["empty code", JSON.stringify({ state: "expected", verifier: "saved" }), "?code=&state=expected", /Sign-in failed/],
] as const) {
  test(`callback rejects ${name} before exchanging a token`, async (context) => {
    const environment = browser(context, query);
    environment.values.set("prospectus.login", saved);
    await assert.rejects(finishSignIn(configuration), message);
    assert.equal(environment.values.has("prospectus.session"), false);
    assert.equal(environment.values.has("prospectus.login"), false);
    assert.equal(environment.cleaned(), "/");
  });
}

test("callback requires an access token rather than accepting only an ID token", async (context) => {
  const environment = browser(context, "?code=code&state=expected");
  environment.values.set("prospectus.login", JSON.stringify({ state: "expected", verifier: "saved" }));
  context.mock.method(globalThis, "fetch", async () => Response.json({ id_token: "id-token", expires_in: 3600 }));
  await assert.rejects(finishSignIn(configuration), /Sign-in failed/);
  assert.equal(getAccessToken(), null);
});
