import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { serverQuotaClient } from "../packages/accounts-client/src/server";
import { QuotaClient } from "../packages/accounts-client/src/quota";
import { AccountsClientError } from "../packages/accounts-client/src/client";

const ACCOUNT = randomUUID();
const RESERVATION = randomUUID();
const credentials = async () => ({
  accessKeyId: "synthetic-access",
  secretAccessKey: "synthetic-secret",
  sessionToken: "synthetic-session",
  expiration: new Date(Date.now() + 600000),
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

test("the server quota client signs reserve, settle and release with SigV4 and sends no person or token", async () => {
  const requests: Array<{ url: string; headers: Headers; body: any }> = [];
  const responses = [
    json(200, {
      reservationId: RESERVATION,
      accountId: ACCOUNT,
      status: "reserved",
      maxCents: 250,
      expiresAt: "2030-01-01T00:00:00.000Z",
    }),
    json(200, {
      reservationId: RESERVATION,
      accountId: ACCOUNT,
      status: "settled",
      chargedCents: 100,
      releasedCents: 150,
      overageCents: 0,
    }),
    json(200, { reservationId: RESERVATION, accountId: ACCOUNT, status: "released", releasedCents: 250 }),
  ];
  const client = serverQuotaClient({
    endpoint: "https://accounts.example.invalid/api",
    region: "us-east-1",
    credentials,
    fetcher: async (url, init) => {
      requests.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      });
      return responses.shift()!;
    },
  });
  const reservation = await client.reserve(ACCOUNT, {
    operationId: RESERVATION,
    maxCents: 250,
    expiresInSeconds: 600,
  });
  assert.equal(reservation.status, "reserved");
  await client.settle(ACCOUNT, RESERVATION, {
    operationId: randomUUID(),
    actualCents: 100,
  });
  await client.release(ACCOUNT, RESERVATION, { operationId: randomUUID() });
  assert.deepEqual(
    requests.map((request) => request.url),
    [
      `https://accounts.example.invalid/api/v1/quota/accounts/${ACCOUNT}/reservations`,
      `https://accounts.example.invalid/api/v1/quota/accounts/${ACCOUNT}/reservations/${RESERVATION}/settle`,
      `https://accounts.example.invalid/api/v1/quota/accounts/${ACCOUNT}/reservations/${RESERVATION}/release`,
    ],
  );
  for (const request of requests) {
    assert.equal(request.headers.get("x-amz-security-token"), "synthetic-session");
    assert.match(
      request.headers.get("authorization")!,
      /^AWS4-HMAC-SHA256 .*Credential=synthetic-access\/.*\/us-east-1\/execute-api\/aws4_request/,
    );
    assert.equal(request.headers.get("x-prospectus-human-token"), null);
  }
  assert.deepEqual(requests[0].body, { operationId: RESERVATION, maxCents: 250, expiresInSeconds: 600 });
});

test("static and expired credentials are refused before anything is transmitted", async () => {
  for (const source of [
    { accessKeyId: "synthetic", secretAccessKey: "synthetic" },
    {
      accessKeyId: "synthetic",
      secretAccessKey: "synthetic",
      sessionToken: "synthetic",
      expiration: new Date(0),
    },
  ]) {
    const client = serverQuotaClient({
      endpoint: "https://accounts.example.invalid",
      region: "us-east-1",
      credentials: async () => source,
      fetcher: async () => {
        throw Error("Must not transmit");
      },
    });
    await assert.rejects(
      client.reserve(ACCOUNT, { operationId: RESERVATION, maxCents: 1, expiresInSeconds: 60 }),
      /temporary credentials/,
    );
  }
  for (const endpoint of [
    "http://accounts.example.invalid",
    "https://user:pass@accounts.example.invalid",
    "https://accounts.example.invalid/?a=1",
  ])
    assert.throws(() => serverQuotaClient({ endpoint, region: "us-east-1" }), /HTTPS/);
});

test("a refusal, a store failure, a network error or an unexpected 200 all throw, so none reads as permission to spend", async () => {
  const request = { operationId: RESERVATION, maxCents: 1, expiresInSeconds: 60 };
  const attempt = (fetcher: typeof fetch) =>
    serverQuotaClient({
      endpoint: "https://accounts.example.invalid",
      region: "us-east-1",
      credentials,
      fetcher,
    }).reserve(ACCOUNT, request);
  await assert.rejects(
    attempt(async () => json(402, { error: "quota_insufficient", message: "no" })),
    (error: any) =>
      error instanceof AccountsClientError && error.status === 402 && error.code === "quota_insufficient",
  );
  await assert.rejects(
    attempt(async () => json(503, { error: "quota_unavailable", message: "no" })),
    AccountsClientError,
  );
  await assert.rejects(
    attempt(async () => {
      throw new TypeError("network");
    }),
    TypeError,
  );
  await assert.rejects(
    attempt(async () => new Response("<html>gateway</html>", { status: 200 })),
    AccountsClientError,
  );
  await assert.rejects(
    attempt(async () => json(200, {})),
    (error: any) => error.code === "quota_response",
  );
  await assert.rejects(
    attempt(async () =>
      json(200, { reservationId: RESERVATION, status: "settled", maxCents: 1, expiresAt: "x" }),
    ),
    (error: any) => error.code === "quota_response",
  );
  await assert.rejects(
    attempt(async () =>
      json(200, { reservationId: RESERVATION, status: "reserved", maxCents: 1.5, expiresAt: "x" }),
    ),
    (error: any) => error.code === "quota_response",
  );
});

test("the quota client uses the routes it is given and nothing else", async () => {
  const paths: string[] = [];
  const client = new QuotaClient(async (path, method) => {
    paths.push(`${method} ${path}`);
    return { reservationId: RESERVATION, accountId: ACCOUNT, status: "released", releasedCents: 0 };
  });
  await client.release(ACCOUNT, RESERVATION, { operationId: RESERVATION });
  assert.deepEqual(paths, [`POST /v1/quota/accounts/${ACCOUNT}/reservations/${RESERVATION}/release`]);
});
