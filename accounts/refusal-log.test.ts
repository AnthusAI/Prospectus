import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loggedRoute } from "./refusal-log";
import { googleFixture } from "./testing/google-fixture";
import { googleIdentityHandler, type GoogleIdentityRepository } from "./google-identity";
import { DurableGoogleIdentities } from "./durable-google-identities";
import { MemoryIdentityFiles } from "./testing/memory-identity-files";
import { IdentityFileError } from "./identity-files";
import { accountHandler, type AccountsApi } from "./handler";
import { accountDirectoryHandler } from "./directory-handler";
import type { DurableAccountsService } from "./durable-accounts";
import { publicReaderHandler, RETIRED_SITE_SUBJECTS_PATH } from "./site-subjects";

/** Captures the JSON lines written while `run` executes. */
async function loggedLines(run: () => Promise<unknown>) {
  const lines: any[] = [];
  const info = mock.method(console, "info", (line: string) => lines.push(JSON.parse(line)));
  try {
    await run();
  } finally {
    info.mock.restore();
  }
  return lines;
}

const accountId = randomUUID();

test("routes are logged as templates with account IDs and products replaced", () => {
  const cases: Array<[string, string, string]> = [
    ["POST", "/v1/identities/google/resolve", "POST /v1/identities/google/resolve"],
    ["GET", "/v1/identities/me", "GET /v1/identities/me"],
    ["POST", `/v1/accounts/${accountId}/authorize`, "POST /v1/accounts/{account}/authorize"],
    ["GET", `/v1/account-directory/${accountId}`, "GET /v1/account-directory/{account}"],
    [
      "GET",
      `/v1/account-directory/operator/accounts/${accountId}`,
      "GET /v1/account-directory/operator/accounts/{account}",
    ],
    [
      "POST",
      `/v1/account-directory/operator/accounts/${accountId}/entitlements/cyclotron`,
      "POST /v1/account-directory/operator/accounts/{account}/entitlements/{product}",
    ],
    ["GET", "/v1/anything-else/someone@example.com", "GET {unrecognized}"],
    ["GET", "/v1/accounts/someone", "GET {unrecognized}"],
    ["get me", "/v1/accounts", "{method} /v1/accounts"],
  ];
  for (const [httpMethod, path, route] of cases) assert.equal(loggedRoute({ httpMethod, path }), route, path);
  assert.equal(loggedRoute({}), "{method} {unrecognized}");
});

test("a refused sign-in logs its status, code and static message once, with nothing personal", async () => {
  const identityFixture = googleFixture();
  const handler = googleIdentityHandler(
    new DurableGoogleIdentities(new MemoryIdentityFiles()),
    identityFixture.products,
    identityFixture.keys,
    () => identityFixture.now,
  );
  const pair = identityFixture.pair(0, "synthetic-nonce");
  let response: Awaited<ReturnType<typeof handler>> | undefined;
  const lines = await loggedLines(async () => {
    response = await handler(
      identityFixture.event(0, "/v1/identities/google/resolve", { challengeId: randomUUID() }, pair),
    );
  });
  assert.equal(response!.statusCode, 401);
  assert.deepEqual(JSON.parse(response!.body), {
    error: "challenge_invalid",
    message: "Challenge does not exist.",
  });
  assert.deepEqual(lines, [
    {
      event: "accounts.refusal",
      route: "POST /v1/identities/google/resolve",
      status: 401,
      code: "challenge_invalid",
      message: "Challenge does not exist.",
    },
  ]);
  const text = JSON.stringify(lines);
  for (const secret of [pair.access, pair.id, "synthetic-pool-person", "synthetic-google", "example"])
    assert.ok(!text.includes(secret), `The log line must not carry ${secret.slice(0, 24)}`);
});

test("an unexpected failure logs only its class name and code, never its message", async () => {
  const identityFixture = googleFixture();
  const failing = (error: unknown): GoogleIdentityRepository => ({
    issue: async () => {},
    associate: async () => {
      throw error;
    },
    find: async () => {
      throw error;
    },
    getPerson: async () => null,
  });
  const meWith = (error: unknown) =>
    loggedLines(() =>
      googleIdentityHandler(
        failing(error),
        identityFixture.products,
        identityFixture.keys,
        () => identityFixture.now,
      )(identityFixture.event(0, "/v1/identities/me", {}, identityFixture.pair(0, "nonce"), "GET")),
    );
  assert.deepEqual(await meWith(new IdentityFileError("uncertain")), [
    {
      event: "accounts.unavailable",
      route: "GET /v1/identities/me",
      errorName: "IdentityFileError",
      errorCode: "uncertain",
    },
  ]);
  const leaky = Object.assign(new TypeError("lookup failed for someone@example.com"), {
    code: "someone@example.com",
  });
  const lines = await meWith(leaky);
  assert.deepEqual(lines, [
    { event: "accounts.unavailable", route: "GET /v1/identities/me", errorName: "TypeError" },
  ]);
});

test("account, directory and reader refusals each log one line; successes log none", async () => {
  const identityFixture = googleFixture();
  const accounts = accountHandler({} as AccountsApi, identityFixture.products, identityFixture.keys);
  const unsigned = {
    httpMethod: "POST",
    path: `/v1/accounts/${accountId}/authorize`,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation: "console:read" }),
  };
  const accountLines = await loggedLines(() => accounts(unsigned));
  assert.deepEqual(accountLines, [
    {
      event: "accounts.refusal",
      route: "POST /v1/accounts/{account}/authorize",
      status: 403,
      code: "caller_forbidden",
      message: "A registered temporary runtime role is required.",
    },
  ]);
  const directory = accountDirectoryHandler(
    {} as DurableAccountsService,
    identityFixture.products,
    identityFixture.keys,
  );
  const directoryLines = await loggedLines(() =>
    directory({
      ...unsigned,
      path: `/v1/account-directory/operator/accounts/${accountId}`,
      httpMethod: "GET",
    }),
  );
  assert.equal(directoryLines.length, 1);
  assert.equal(directoryLines[0].route, "GET /v1/account-directory/operator/accounts/{account}");
  assert.equal(directoryLines[0].event, "accounts.refusal");
  const reader = publicReaderHandler(
    async () => {
      throw new Error("inner must not be reached");
    },
    identityFixture.products,
    undefined,
  );
  const readerLines = await loggedLines(() =>
    reader({ ...identityFixture.event(0, RETIRED_SITE_SUBJECTS_PATH), httpMethod: "GET" }),
  );
  assert.deepEqual(readerLines, [
    {
      event: "accounts.refusal",
      route: "GET /v1/accounts/site-subjects/retired",
      status: 403,
      code: "reader_route_forbidden",
      message: "Only public-reader sites list retired site subjects.",
    },
  ]);
  const successLines = await loggedLines(() => identityFixture.challenge(0));
  assert.deepEqual(successLines, []);
});
