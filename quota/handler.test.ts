import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { RestEvent } from "../accounts/auth";
import { IdentityFileError } from "../accounts/identity-files";
import { loggedRoute } from "../accounts/refusal-log";
import { registrations } from "../accounts/registration";
import { quotaHandler } from "./handler";
import { quotaFixture } from "./testing/quota-fixture";

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
  registration("example-renderer", { quota: true }),
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
  await fixture.grantAllowance(1000);
  const handler = quotaHandler(fixture.quota, products);
  const call = async (role: string | null, method: string, path: string, body?: unknown) => {
    const response = await handler(event(role, method, path, body));
    return { status: response.statusCode, body: JSON.parse(response.body) };
  };
  const base = `/v1/quota/accounts/${fixture.accountId}/reservations`;
  return { ...fixture, handler, call, base };
}

test("a quota product reserves, settles and releases through the signed routes", async () => {
  const { call, base, accountId, quota } = await harness();
  const operationId = randomUUID();
  const reserved = await call("example-renderer", "POST", base, {
    operationId,
    maxCents: 300,
    expiresInSeconds: 900,
  });
  assert.equal(reserved.status, 200);
  assert.equal(reserved.body.reservationId, operationId);
  assert.equal(reserved.body.status, "reserved");
  const settled = await call("example-renderer", "POST", `${base}/${operationId}/settle`, {
    operationId: randomUUID(),
    actualCents: 120,
  });
  assert.deepEqual([settled.status, settled.body.chargedCents, settled.body.releasedCents], [200, 120, 180]);
  const second = randomUUID();
  await call("example-renderer", "POST", base, { operationId: second, maxCents: 50, expiresInSeconds: 900 });
  const released = await call("example-renderer", "POST", `${base}/${second}/release`, {
    operationId: randomUUID(),
  });
  assert.deepEqual([released.status, released.body.releasedCents], [200, 50]);
  assert.equal((await quota.summary(accountId))?.usedCents, 120);
});

test("a retried request over the wire returns the identical body", async () => {
  const { call, base } = await harness();
  const request = { operationId: randomUUID(), maxCents: 300, expiresInSeconds: 900 };
  const first = await call("example-renderer", "POST", base, request);
  const second = await call("example-renderer", "POST", base, request);
  assert.deepEqual(second, first);
});

test("a request with no verified role, an unregistered role or a product without the quota flag is refused", async () => {
  const { call, base } = await harness();
  const request = { operationId: randomUUID(), maxCents: 1, expiresInSeconds: 60 };
  assert.equal((await call(null, "POST", base, request)).body.error, "caller_forbidden");
  assert.equal((await call("example-stranger", "POST", base, request)).body.error, "caller_forbidden");
  const plain = await call("example-plain", "POST", base, request);
  assert.deepEqual([plain.status, plain.body.error], [403, "quota_forbidden"]);
  const paused = await call("example-paused", "POST", base, request);
  assert.equal(paused.status, 403, "a disabled registration is not a caller");
  const user = event("example-renderer", "POST", base, request);
  user.requestContext!.identity!.userArn = `arn:aws:iam::${AWS_ACCOUNT}:user/someone`;
  assert.equal((await quotaHandler(undefined, products)(user)).statusCode, 403);
});

test("another product cannot touch the reservation", async () => {
  const { call, base, quota, accountId } = await harness();
  const operationId = randomUUID();
  await call("example-renderer", "POST", base, { operationId, maxCents: 300, expiresInSeconds: 900 });
  const settle = await call("example-narrator", "POST", `${base}/${operationId}/settle`, {
    operationId: randomUUID(),
    actualCents: 1,
  });
  assert.deepEqual([settle.status, settle.body.error], [403, "wrong_product"]);
  const release = await call("example-narrator", "POST", `${base}/${operationId}/release`, {
    operationId: randomUUID(),
  });
  assert.equal(release.body.error, "wrong_product");
  assert.equal((await quota.summary(accountId))?.heldCents, 300);
});

test("refusals carry a code and never success: over quota, unknown account, no allowance", async () => {
  const { call, base, files } = await harness();
  const over = await call("example-renderer", "POST", base, {
    operationId: randomUUID(),
    maxCents: 1001,
    expiresInSeconds: 60,
  });
  assert.deepEqual([over.status, over.body.error], [402, "quota_insufficient"]);
  const unknown = await call("example-renderer", "POST", `/v1/quota/accounts/${randomUUID()}/reservations`, {
    operationId: randomUUID(),
    maxCents: 1,
    expiresInSeconds: 60,
  });
  assert.deepEqual([unknown.status, unknown.body.error], [404, "account_missing"]);
  files.objects.clear();
  const none = await call("example-renderer", "POST", base, {
    operationId: randomUUID(),
    maxCents: 1,
    expiresInSeconds: 60,
  });
  assert.deepEqual([none.status, none.body.error], [403, "no_allowance"]);
});

test("malformed input, unknown fields, wrong methods and unknown routes are refused", async () => {
  const { call, base, handler } = await harness();
  const operationId = randomUUID();
  assert.equal(
    (
      await call("example-renderer", "POST", base, {
        operationId,
        maxCents: 1,
        expiresInSeconds: 60,
        extra: 1,
      })
    ).body.error,
    "unknown_fields",
  );
  assert.equal(
    (await call("example-renderer", "POST", base, { operationId, maxCents: "1", expiresInSeconds: 60 })).body
      .error,
    "invalid_amount",
  );
  assert.equal((await call("example-renderer", "GET", base)).status, 405);
  assert.equal((await call("example-renderer", "POST", `${base}/${operationId}/refund`, {})).status, 404);
  const garbled = event("example-renderer", "POST", base);
  garbled.body = "{not json";
  assert.equal((await handler(garbled)).statusCode, 400);
});

test("an unavailable store answers 503 with a do-not-spend message and no detail", async () => {
  const { call, base, files } = await harness();
  files.get = async () => {
    throw new IdentityFileError("unavailable");
  };
  const response = await call("example-renderer", "POST", base, {
    operationId: randomUUID(),
    maxCents: 1,
    expiresInSeconds: 60,
  });
  assert.deepEqual([response.status, response.body.error], [503, "quota_unavailable"]);
  assert.doesNotMatch(JSON.stringify(response.body), /Identity|unavailable\.$/);
});

test("without quota storage configured every quota route answers 503", async () => {
  const handler = quotaHandler(undefined, products);
  const response = await handler(
    event("example-renderer", "POST", `/v1/quota/accounts/${randomUUID()}/reservations`, {
      operationId: randomUUID(),
      maxCents: 1,
      expiresInSeconds: 60,
    }),
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
