import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { RestEvent } from "../accounts/auth";
import { IdentityFileError } from "../accounts/identity-files";
import { loggedRoute } from "../accounts/refusal-log";
import { registrations } from "../accounts/registration";
import { quotaHandler } from "./handler";
import { batch, quotaFixture, tokens } from "./testing/quota-fixture";

const AWS_ACCOUNT = "111122223333";
const ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_SyntheticPool";
const registration = (product: string, extra: Record<string, unknown> = {}) => ({
  product,
  roleArn: `arn:aws:iam::${AWS_ACCOUNT}:role/${product}-runtime`,
  issuer: ISSUER,
  clientIds: ["syntheticclient"],
  capabilities: ["console:read"],
  enabled: true,
  ...extra,
});
const products = registrations([
  registration("example-renderer", {
    quota: true,
    quotaCaller: { roleArn: `arn:aws:iam::${AWS_ACCOUNT}:role/example-gate-runtime` },
  }),
  registration("example-narrator", { quota: true }),
  registration("example-plain"),
  registration("example-paused", { quota: true, enabled: false }),
]);

function event(role: string | null, method: string, path: string, body?: unknown): RestEvent {
  return {
    httpMethod: method,
    path,
    headers: { "content-type": "application/json" },
    body: body === undefined ? null : JSON.stringify(body),
    requestContext: role
      ? {
          identity: {
            userArn: `arn:aws:sts::${AWS_ACCOUNT}:assumed-role/${role}-runtime/session`,
            accountId: AWS_ACCOUNT,
          },
        }
      : { identity: {} },
  };
}
async function harness() {
  const fixture = quotaFixture();
  const handler = quotaHandler(fixture.quota, products);
  const call = async (role: string | null, method: string, path: string, body?: unknown) => {
    const response = await handler(event(role, method, path, body));
    return { status: response.statusCode, body: JSON.parse(response.body) };
  };
  const base = `/v1/quota/accounts/${fixture.accountId}`;
  return { ...fixture, handler, call, base };
}
const request = (items = batch(100)) => ({ operationId: randomUUID(), items, expiresInSeconds: 900 });

test("a quota product reserves, settles, releases, records and checks through the signed routes", async () => {
  const { call, base } = await harness();
  const operationId = randomUUID();
  const reserved = await call("example-renderer", "POST", `${base}/reservations`, {
    ...request(),
    operationId,
  });
  assert.deepEqual(
    [reserved.status, reserved.body.reservationId, reserved.body.status],
    [200, operationId, "reserved"],
  );
  const settled = await call("example-renderer", "POST", `${base}/reservations/${operationId}/settle`, {
    operationId: randomUUID(),
    items: batch(40),
  });
  assert.deepEqual([settled.status, settled.body.status], [200, "settled"]);
  const second = randomUUID();
  await call("example-renderer", "POST", `${base}/reservations`, {
    ...request(batch(10)),
    operationId: second,
  });
  const released = await call("example-renderer", "POST", `${base}/reservations/${second}/release`, {
    operationId: randomUUID(),
  });
  assert.deepEqual([released.status, released.body.status], [200, "released"]);
  const recorded = await call("example-renderer", "POST", `${base}/usage`, {
    operationId: randomUUID(),
    items: tokens(500),
  });
  assert.deepEqual([recorded.status, recorded.body.status], [200, "recorded"]);
  const checked = await call("example-renderer", "POST", `${base}/check`, {});
  assert.deepEqual([checked.status, checked.body.allowed, checked.body.percentUsed], [200, true, 17]);
});

test("nothing a product receives mentions units, rates, plans or money", async () => {
  const { call, base } = await harness();
  const operationId = randomUUID();
  const bodies = [
    await call("example-renderer", "POST", `${base}/reservations`, { ...request(), operationId }),
    await call("example-renderer", "POST", `${base}/usage`, {
      operationId: randomUUID(),
      items: tokens(500),
    }),
    await call("example-renderer", "POST", `${base}/check`, {}),
    await call("example-renderer", "POST", `${base}/reservations`, request(batch(100_000))),
    await call("example-renderer", "POST", `${base}/usage`, {
      operationId: randomUUID(),
      items: [{ itemKind: "example.mystery", quantity: 1 }],
    }),
  ];
  assert.deepEqual(
    bodies.map((body) => body.status),
    [200, 200, 200, 402, 422],
  );
  for (const { body } of bodies)
    assert.doesNotMatch(JSON.stringify(body), /units|rate|plan|cents|dollar|\$|tableVersion|allowance/i);
});

test("a retried request over the wire returns the identical body", async () => {
  const { call, base } = await harness();
  const input = request();
  const first = await call("example-renderer", "POST", `${base}/reservations`, input);
  const second = await call("example-renderer", "POST", `${base}/reservations`, input);
  assert.deepEqual(second, first);
  const usage = { operationId: randomUUID(), items: tokens(100) };
  assert.deepEqual(
    await call("example-renderer", "POST", `${base}/usage`, usage),
    await call("example-renderer", "POST", `${base}/usage`, usage),
  );
});

test("a request with no verified role, an unregistered role or a product without the quota flag is refused", async () => {
  const { call, base } = await harness();
  assert.equal((await call(null, "POST", `${base}/check`, {})).body.error, "caller_forbidden");
  assert.equal((await call("example-stranger", "POST", `${base}/check`, {})).body.error, "caller_forbidden");
  const plain = await call("example-plain", "POST", `${base}/usage`, {
    operationId: randomUUID(),
    items: tokens(1),
  });
  assert.deepEqual([plain.status, plain.body.error], [403, "quota_forbidden"]);
  assert.equal(
    (await call("example-paused", "POST", `${base}/check`, {})).status,
    403,
    "a disabled registration is not a caller",
  );
  const user = event("example-renderer", "POST", `${base}/check`, {});
  user.requestContext!.identity!.userArn = `arn:aws:iam::${AWS_ACCOUNT}:user/someone`;
  assert.equal((await quotaHandler(undefined, products)(user)).statusCode, 403);
});

test("another product cannot touch the reservation", async () => {
  const { call, base } = await harness();
  const operationId = randomUUID();
  await call("example-renderer", "POST", `${base}/reservations`, { ...request(), operationId });
  const settle = await call("example-narrator", "POST", `${base}/reservations/${operationId}/settle`, {
    operationId: randomUUID(),
    items: [],
  });
  assert.deepEqual([settle.status, settle.body.error], [403, "wrong_product"]);
  const release = await call("example-narrator", "POST", `${base}/reservations/${operationId}/release`, {
    operationId: randomUUID(),
  });
  assert.equal(release.body.error, "wrong_product");
});

test("refusals carry a code and never success: over quota, unknown item, unknown account", async () => {
  const { call, base } = await harness();
  const over = await call("example-renderer", "POST", `${base}/reservations`, request(batch(100_000)));
  assert.deepEqual([over.status, over.body.error], [402, "quota_insufficient"]);
  const unknownItem = await call("example-renderer", "POST", `${base}/usage`, {
    operationId: randomUUID(),
    items: [{ itemKind: "example.mystery", quantity: 1 }],
  });
  assert.deepEqual([unknownItem.status, unknownItem.body.error], [422, "unknown_item_kind"]);
  const unknown = await call("example-renderer", "POST", `/v1/quota/accounts/${randomUUID()}/check`, {});
  assert.deepEqual([unknown.status, unknown.body.error], [404, "account_missing"]);
});

test("malformed input, unknown fields, wrong methods and unknown routes are refused", async () => {
  const { call, base, handler } = await harness();
  assert.equal(
    (await call("example-renderer", "POST", `${base}/reservations`, { ...request(), extra: 1 })).body.error,
    "unknown_fields",
  );
  assert.equal(
    (await call("example-renderer", "POST", `${base}/reservations`, { ...request(), items: "x" })).body.error,
    "invalid_items",
  );
  assert.equal(
    (
      await call("example-renderer", "POST", `${base}/usage`, {
        operationId: randomUUID(),
        items: [{ itemKind: "example.tokens", quantity: 1, price: 2 }],
      })
    ).body.error,
    "invalid_items",
  );
  assert.equal(
    (await call("example-renderer", "POST", `${base}/check`, { extra: 1 })).body.error,
    "unknown_fields",
  );
  assert.equal((await call("example-renderer", "GET", `${base}/check`)).status, 405);
  assert.equal(
    (await call("example-renderer", "POST", `${base}/reservations/${randomUUID()}/refund`, {})).status,
    404,
  );
  const garbled = event("example-renderer", "POST", `${base}/check`);
  garbled.body = "{not json";
  assert.equal((await handler(garbled)).statusCode, 400);
});

test("an unavailable store or rate table answers 503 with a do-not-spend message and no detail", async () => {
  const { call, base, files, table } = await harness();
  table.broken = true;
  const noTable = await call("example-renderer", "POST", `${base}/check`, {});
  assert.deepEqual([noTable.status, noTable.body.error], [503, "quota_unavailable"]);
  table.broken = false;
  files.get = async () => {
    throw new IdentityFileError("unavailable");
  };
  const response = await call("example-renderer", "POST", `${base}/reservations`, request());
  assert.deepEqual([response.status, response.body.error], [503, "quota_unavailable"]);
  assert.doesNotMatch(JSON.stringify(response.body), /Identity/);
});

test("without quota storage configured every quota route answers 503", async () => {
  const handler = quotaHandler(undefined, products);
  const response = await handler(
    event("example-renderer", "POST", `/v1/quota/accounts/${randomUUID()}/check`, {}),
  );
  assert.equal(response.statusCode, 503);
});

test("the refusal log names the route template and never an account or reservation ID", () => {
  const id = randomUUID();
  assert.equal(
    loggedRoute({ httpMethod: "POST", path: `/v1/quota/accounts/${id}/reservations/${randomUUID()}/settle` }),
    "POST /v1/quota/accounts/{account}/reservations/{account}/settle",
  );
});

test("only a plain server product may carry the quota flag", () => {
  assert.throws(
    () => registrations([registration("example-renderer", { quota: false })]),
    /explicitly true or absent/,
  );
  assert.throws(
    () =>
      registrations([
        registration("papyrus-example", {
          quota: true,
          audience: "public-reader",
          capabilities: [],
          googleFederation: {
            policy: "google-only-unlinked-v1",
            reviewedPolicyId: "synthetic",
            clientId: "syntheticclient",
          },
        }),
      ]),
    /Only a server product/,
  );
});

test("a quota caller role may use each of the five quota routes as its product", async () => {
  const { call, base } = await harness();
  const operationId = randomUUID();
  const reserved = await call("example-gate", "POST", `${base}/reservations`, { ...request(), operationId });
  assert.deepEqual([reserved.status, reserved.body.status], [200, "reserved"]);
  const settled = await call("example-gate", "POST", `${base}/reservations/${operationId}/settle`, {
    operationId: randomUUID(),
    items: batch(40),
  });
  assert.deepEqual([settled.status, settled.body.status], [200, "settled"]);
  const second = randomUUID();
  await call("example-gate", "POST", `${base}/reservations`, { ...request(batch(10)), operationId: second });
  const released = await call("example-gate", "POST", `${base}/reservations/${second}/release`, {
    operationId: randomUUID(),
  });
  assert.deepEqual([released.status, released.body.status], [200, "released"]);
  const recorded = await call("example-gate", "POST", `${base}/usage`, {
    operationId: randomUUID(),
    items: tokens(500),
  });
  assert.deepEqual([recorded.status, recorded.body.status], [200, "recorded"]);
  assert.equal((await call("example-gate", "POST", `${base}/check`, {})).body.allowed, true);
});

test("a quota caller role is refused on identity and account routes and on a non-POST quota call", async () => {
  const { call, base } = await harness();
  const account = randomUUID();
  for (const [method, path] of [
    ["GET", "/v1/identities/me"],
    ["POST", `/v1/accounts/${account}/authorize`],
    ["GET", "/v1/accounts"],
    ["POST", "/v1/accounts"],
    ["GET", `${base}/check`],
    ["POST", `${base}/reservations/${randomUUID()}/refund`],
  ] as const) {
    const refused = await call("example-gate", method, path, {});
    assert.deepEqual(
      [refused.status, refused.body.error],
      [403, "quota_route_forbidden"],
      `${method} ${path}`,
    );
  }
});

test("a quota caller role that is not configured, or whose product is paused, is not a caller", async () => {
  const plainProducts = registrations([registration("example-renderer", { quota: true })]);
  const fixture = quotaFixture();
  const handler = quotaHandler(fixture.quota, plainProducts);
  const unconfigured = await handler(
    event("example-gate", "POST", `/v1/quota/accounts/${fixture.accountId}/check`, {}),
  );
  assert.deepEqual([unconfigured.statusCode, JSON.parse(unconfigured.body).error], [403, "caller_forbidden"]);
  const paused = registrations([
    registration("example-renderer", {
      quota: true,
      enabled: false,
      quotaCaller: { roleArn: `arn:aws:iam::${AWS_ACCOUNT}:role/example-gate-runtime` },
    }),
  ]);
  const refused = await quotaHandler(
    fixture.quota,
    paused,
  )(event("example-gate", "POST", `/v1/quota/accounts/${fixture.accountId}/check`, {}));
  assert.equal(JSON.parse(refused.body).error, "caller_forbidden");
});

test("a quota caller needs the quota flag and a role no other principal uses", () => {
  const gate = { roleArn: `arn:aws:iam::${AWS_ACCOUNT}:role/example-gate-runtime` };
  assert.throws(
    () => registrations([registration("example-renderer", { quotaCaller: gate })]),
    /quota caller needs the quota flag/,
  );
  assert.throws(
    () =>
      registrations([
        registration("example-renderer", {
          quota: true,
          quotaCaller: { roleArn: `arn:aws:iam::${AWS_ACCOUNT}:role/example-renderer-runtime` },
        }),
      ]),
    /unique/,
  );
  assert.throws(
    () =>
      registrations([
        registration("example-renderer", { quota: true, quotaCaller: gate }),
        registration("example-narrator", { quota: true, quotaCaller: gate }),
      ]),
    /unique/,
  );
  assert.throws(
    () =>
      registrations([registration("example-renderer", { quota: true, quotaCaller: { roleArn: "nope" } })]),
    /IAM role ARN/,
  );
  assert.throws(
    () =>
      registrations([
        registration("example-renderer", { quota: true, quotaCaller: { ...gate, extra: "x" } }),
      ]),
    /IAM role ARN/,
  );
});
