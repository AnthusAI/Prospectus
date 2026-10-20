import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import {
  AccountsConfirmationError,
  finishSignIn,
  getAccessToken,
  hasAttemptedAccountsConfirmation,
  signIn,
} from "../src/auth";

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
  context.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected token exchange");
  });
  const originals = ["sessionStorage", "window"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        search,
        assign: (url: URL) => {
          destination = String(url);
        },
      },
      history: {
        replaceState: (_state: unknown, _title: string, url: string) => {
          cleaned = url;
        },
      },
    },
  });
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
  assert.equal(
    url.searchParams.get("code_challenge"),
    createHash("sha256").update(login.verifier).digest("base64url"),
  );
  assert.ok(login.verifier.length >= 43);
  assert.equal(url.searchParams.has("code_verifier"), false);
});

test("verified callback exchanges the saved verifier and retains the access token", async (context) => {
  const environment = browser(context, "?code=authorization-code&state=expected-state");
  environment.values.set(
    "prospectus.login",
    JSON.stringify({ state: "expected-state", verifier: "saved-verifier" }),
  );
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
  [
    "mismatched state",
    JSON.stringify({ state: "other", verifier: "saved" }),
    "?code=code&state=expected",
    /could not be verified/,
  ],
  [
    "missing verifier",
    JSON.stringify({ state: "expected" }),
    "?code=code&state=expected",
    /could not be verified/,
  ],
  ["malformed login", "{", "?code=code&state=expected", /could not be verified/],
  [
    "provider rejection",
    JSON.stringify({ state: "expected", verifier: "saved" }),
    "?error=access_denied&state=expected",
    /not completed/,
  ],
  [
    "empty code",
    JSON.stringify({ state: "expected", verifier: "saved" }),
    "?code=&state=expected",
    /Sign-in failed/,
  ],
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
  context.mock.method(globalThis, "fetch", async () =>
    Response.json({ id_token: "id-token", expires_in: 3600 }),
  );
  await assert.rejects(finishSignIn(configuration), /Sign-in failed/);
  assert.equal(getAccessToken(), null);
});

test("Accounts sign-in binds central nonce and forwards ID evidence transiently through BFF", async (context) => {
  const environment = browser(context, "?code=fresh-code&state=expected");
  environment.values.set(
    "prospectus.login",
    JSON.stringify({
      state: "expected",
      verifier: "saved",
      accounts: { challengeId: "11111111-1111-4111-8111-111111111111", nonce: "central-nonce" },
    }),
  );
  let forwarded = false;
  context.mock.method(globalThis, "fetch", async (input: any, init: any) => {
    if (String(input).includes("oauth2/token"))
      return new Response(
        JSON.stringify({
          access_token: "synthetic-access",
          id_token: "synthetic-id-evidence",
          expires_in: 3600,
        }),
      );
    assert.equal(String(input), "https://bff.invalid/api/saas/identity/resolve");
    assert.equal(init.headers.authorization, "Bearer synthetic-access");
    assert.deepEqual(JSON.parse(init.body), {
      challengeId: "11111111-1111-4111-8111-111111111111",
      idToken: "synthetic-id-evidence",
    });
    forwarded = true;
    return new Response("{}");
  });
  assert.equal(
    await finishSignIn({ ...configuration, accountsBffUrl: "https://bff.invalid/api/saas" }),
    true,
  );
  assert.ok(forwarded);
  assert.equal(environment.cleaned(), "/?view=accounts");
  assert.ok(!JSON.stringify([...environment.values]).includes("synthetic-id-evidence"));
});
test("Accounts authorization URL includes the centrally issued nonce without changing CRM flow", async (context) => {
  const environment = browser(context);
  await signIn(
    { ...configuration, accountsBffUrl: "https://bff.invalid" },
    { challengeId: "synthetic-challenge", nonce: "central-nonce" },
  );
  const url = new URL(environment.destination());
  assert.equal(url.searchParams.get("nonce"), "central-nonce");
  assert.equal(url.searchParams.get("prompt"), "login");
});

test("Accounts resolve failure keeps the Google session and reports an Accounts-specific error", async (context) => {
  const environment = browser(context, "?code=fresh-code&state=expected");
  environment.values.set(
    "prospectus.login",
    JSON.stringify({
      state: "expected",
      verifier: "saved",
      accounts: { challengeId: "11111111-1111-4111-8111-111111111111", nonce: "central-nonce" },
    }),
  );
  environment.values.set("prospectus.accounts-confirmation-attempted", "true");
  context.mock.method(globalThis, "fetch", async (input: any) => {
    if (String(input).includes("oauth2/token"))
      return Response.json({ access_token: "synthetic-access", id_token: "synthetic-id", expires_in: 3600 });
    return new Response("{}", { status: 500 });
  });
  await assert.rejects(
    finishSignIn({ ...configuration, accountsBffUrl: "https://bff.invalid/api/saas" }),
    AccountsConfirmationError,
  );
  assert.equal(getAccessToken(), "synthetic-access");
  assert.equal(environment.cleaned(), "/?view=accounts");
  assert.equal(hasAttemptedAccountsConfirmation(), true);
});

test("successful Accounts confirmation clears the attempted marker so a later session may confirm again", async (context) => {
  const environment = browser(context, "?code=fresh-code&state=expected");
  environment.values.set(
    "prospectus.login",
    JSON.stringify({ state: "expected", verifier: "saved", accounts: { challengeId: "c", nonce: "n" } }),
  );
  environment.values.set("prospectus.accounts-confirmation-attempted", "true");
  context.mock.method(globalThis, "fetch", async (input: any) =>
    String(input).includes("oauth2/token")
      ? Response.json({ access_token: "a", id_token: "i", expires_in: 3600 })
      : new Response("{}"),
  );
  await finishSignIn({ ...configuration, accountsBffUrl: "https://bff.invalid/api/saas" });
  assert.equal(hasAttemptedAccountsConfirmation(), false);
});

test("starting Accounts confirmation records the attempt so it is never launched automatically twice", async (context) => {
  browser(context);
  assert.equal(hasAttemptedAccountsConfirmation(), false);
  await signIn(configuration, { challengeId: "c", nonce: "n" });
  assert.equal(hasAttemptedAccountsConfirmation(), true);
});

const bffConfiguration = { ...configuration, accountsBffUrl: "https://bff.invalid/api/saas" };

test("sign-in requests a pre-sign-in challenge bound to the digest of the login state and attaches its nonce", async (context) => {
  const environment = browser(context);
  const requests: Array<{ url: string; init: any }> = [];
  context.mock.method(globalThis, "fetch", async (input: any, init: any) => {
    requests.push({ url: String(input), init });
    return Response.json({ challengeId: "11111111-1111-4111-8111-111111111111", nonce: "central-nonce" });
  });
  await signIn(bffConfiguration);
  const login = JSON.parse(environment.values.get("prospectus.login")!);
  const url = new URL(environment.destination());
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://bff.invalid/api/saas/identity/login-challenge");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers.authorization, undefined);
  assert.equal(requests[0].init.credentials, "omit");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    loginStateDigest: createHash("sha256").update(login.state).digest("hex"),
  });
  assert.equal(url.searchParams.get("nonce"), "central-nonce");
  assert.equal(url.searchParams.get("prompt"), "login");
  assert.equal(login.accountsChallengeBoundToLoginState, true);
  assert.deepEqual(login.accounts, {
    challengeId: "11111111-1111-4111-8111-111111111111",
    nonce: "central-nonce",
  });
});

for (const [name, failure] of [
  ["is throttled", async () => new Response('{"message":"Too Many Requests"}', { status: 429 })],
  ["fails", async () => new Response("{}", { status: 503 })],
  [
    "is unreachable",
    async () => {
      throw new TypeError("network down");
    },
  ],
  ["returns malformed evidence", async () => Response.json({ nonce: 7 })],
] as const) {
  test(`sign-in falls back to a plain login when the challenge request ${name}`, async (context) => {
    const environment = browser(context);
    context.mock.method(globalThis, "fetch", failure);
    await signIn(bffConfiguration);
    const login = JSON.parse(environment.values.get("prospectus.login")!);
    const url = new URL(environment.destination());
    assert.equal(url.pathname, "/oauth2/authorize");
    assert.equal(url.searchParams.has("nonce"), false);
    assert.equal(url.searchParams.has("prompt"), false);
    assert.equal(login.accounts, undefined);
    assert.equal(login.accountsChallengeBoundToLoginState, undefined);
    assert.equal(hasAttemptedAccountsConfirmation(), false);
  });
}

test("a bound sign-in sends the raw login state to resolve; an authenticated challenge sends none", async (context) => {
  for (const [bound, expected] of [
    [true, "expected"],
    [false, undefined],
  ] as const) {
    const environment = browser(context, "?code=fresh-code&state=expected");
    environment.values.set(
      "prospectus.login",
      JSON.stringify({
        state: "expected",
        verifier: "saved",
        accounts: { challengeId: "11111111-1111-4111-8111-111111111111", nonce: "central-nonce" },
        ...(bound ? { accountsChallengeBoundToLoginState: true } : {}),
      }),
    );
    let resolved: any;
    context.mock.method(globalThis, "fetch", async (input: any, init: any) => {
      if (String(input).includes("oauth2/token"))
        return Response.json({ access_token: "access", id_token: "id", expires_in: 3600 });
      resolved = JSON.parse(init.body);
      return new Response("{}");
    });
    await finishSignIn(bffConfiguration);
    assert.equal(resolved.loginState, expected);
    assert.equal(resolved.idToken, "id");
  }
});

test("sign-in falls back to a plain login when the challenge request hangs past its timeout", async (context) => {
  const environment = browser(context);
  const timeouts: number[] = [];
  const controller = new AbortController();
  context.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    timeouts.push(milliseconds);
    setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), 0);
    return controller.signal;
  });
  context.mock.method(
    globalThis,
    "fetch",
    (_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      }),
  );
  await signIn(bffConfiguration);
  const url = new URL(environment.destination());
  assert.deepEqual(timeouts, [5000]);
  assert.equal(url.searchParams.has("nonce"), false);
  assert.equal(url.searchParams.has("prompt"), false);
  assert.equal(hasAttemptedAccountsConfirmation(), false);
});

test("a signed challenge token is kept for the redirect and sent instead of the challenge ID", async (context) => {
  const environment = browser(context);
  context.mock.method(globalThis, "fetch", async () =>
    Response.json({
      challengeId: "11111111-1111-4111-8111-111111111111",
      nonce: "central-nonce",
      challengeToken: "v1.payload.mac",
    }),
  );
  await signIn(bffConfiguration);
  const login = JSON.parse(environment.values.get("prospectus.login")!);
  assert.equal(login.accounts.challengeToken, "v1.payload.mac");
  const completed = browser(context, `?code=fresh-code&state=${login.state}`);
  completed.values.set("prospectus.login", JSON.stringify(login));
  let resolved: any;
  context.mock.method(globalThis, "fetch", async (input: any, init: any) => {
    if (String(input).includes("oauth2/token"))
      return Response.json({ access_token: "access", id_token: "id", expires_in: 3600 });
    resolved = JSON.parse(init.body);
    return new Response("{}");
  });
  await finishSignIn(bffConfiguration);
  assert.equal(resolved.challengeToken, "v1.payload.mac");
  assert.equal(resolved.challengeId, undefined);
  assert.equal(resolved.loginState, login.state);
});

test("an ordinary sign-in stores the session before Accounts confirmation and stays on the CRM", async (context) => {
  for (const confirmation of [200, 500]) {
    const environment = browser(context, "?code=fresh-code&state=expected");
    environment.values.set(
      "prospectus.login",
      JSON.stringify({
        state: "expected",
        verifier: "saved",
        accounts: { challengeId: "11111111-1111-4111-8111-111111111111", nonce: "central-nonce" },
        accountsChallengeBoundToLoginState: true,
      }),
    );
    const order: string[] = [];
    context.mock.method(globalThis, "fetch", async (input: any) => {
      if (String(input).includes("oauth2/token"))
        return Response.json({ access_token: "access", id_token: "id", expires_in: 3600 });
      order.push("resolve");
      return new Response("{}", { status: confirmation });
    });
    assert.equal(await finishSignIn(bffConfiguration, () => order.push(`session:${getAccessToken()}`)), true);
    assert.deepEqual(order, ["session:access", "resolve"]);
    assert.equal(environment.cleaned(), "/");
  }
});
