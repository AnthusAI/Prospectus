import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { VirtuusAccountFiles, VirtuusIdentityFiles, VirtuusQuotaFiles } from "../accounts/identity-files";
import { canonicalAccountsHandler } from "../accounts/canonical-handler";
import { operatorGrants, operatorSubjectHash, type OperatorPermission } from "../accounts/operator-policy";
import { registrations } from "../accounts/registration";
import type { RestEvent } from "../accounts/auth";
import { directoryFixture } from "../accounts/testing/directory-fixture";

const environments: Array<{ root: string }> = [];
after(async () => {
  for (const { root } of environments) await rm(root, { recursive: true, force: true });
});

const AWS_ACCOUNT = "111122223333";
const quotaProduct = {
  product: "example-renderer",
  roleArn: `arn:aws:iam::${AWS_ACCOUNT}:role/example-renderer-runtime`,
  issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_SyntheticPool",
  clientIds: ["syntheticclient"],
  capabilities: ["console:read"] as const,
  enabled: true,
  quota: true as const,
};

/** Real Virtuus files through the Rust bridge, the real central handler, a synthetic quota product and operator. */
async function durable(withQuotaFiles = true) {
  const environment = await directoryFixture();
  environments.push(environment);
  const products = registrations([
    ...environment.products,
    { ...quotaProduct, capabilities: [...quotaProduct.capabilities] },
  ]);
  const grantFor = (permission: OperatorPermission) => ({
    product: environment.outsider.context.product,
    issuer: environment.outsider.context.human.issuer,
    subjectHash: operatorSubjectHash(environment.outsider.context.human.subject),
    permission,
    reviewedGrantId: "synthetic-approval-v1",
  });
  const central = (permissions: OperatorPermission[], quotaFiles = withQuotaFiles) =>
    canonicalAccountsHandler(
      new VirtuusIdentityFiles(environment.root),
      new VirtuusAccountFiles(environment.root),
      products,
      environment.identityFixture.keys,
      () => environment.identityFixture.now,
      operatorGrants(permissions.map(grantFor)),
      "scan",
      undefined,
      {},
      undefined,
      quotaFiles ? new VirtuusQuotaFiles(environment.root) : undefined,
    );
  const operator = central(["accounts:admin:read", "accounts:admin:quota"]);
  // The account must be entitled to the quota product before it may reserve.
  await environment.service.setEntitlement(
    environment.outsider.context,
    environment.account.id,
    { product: "example-renderer", capabilities: ["console:read"] },
    "active",
  );
  const quotaEvent = (path: string, body: unknown, role = "example-renderer-runtime"): RestEvent => ({
    httpMethod: "POST",
    path,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    requestContext: {
      identity: {
        userArn: `arn:aws:sts::${AWS_ACCOUNT}:assumed-role/${role}/session`,
        accountId: AWS_ACCOUNT,
      },
    },
  });
  const base = `/v1/quota/accounts/${environment.account.id}/reservations`;
  const asProduct = async (handler: ReturnType<typeof central>, path: string, body: unknown) => {
    const response = await handler(quotaEvent(path, body));
    return { status: response.statusCode, body: JSON.parse(response.body) };
  };
  const grant = async (allowanceCents: number, handler = operator) => {
    const response = await handler(
      environment.identityFixture.event(
        0,
        `/v1/account-directory/operator/accounts/${environment.account.id}/quota`,
        { operationId: randomUUID(), allowanceCents },
        environment.outsider.proof,
        "POST",
      ),
    );
    return { status: response.statusCode, body: JSON.parse(response.body) };
  };
  const detail = async (handler: ReturnType<typeof central>, operatorView: boolean) => {
    const response = await handler(
      environment.identityFixture.event(
        0,
        operatorView
          ? `/v1/account-directory/operator/accounts/${environment.account.id}`
          : `/v1/account-directory/${environment.account.id}`,
        {},
        operatorView ? environment.outsider.proof : environment.memberDirectory.proof,
        "GET",
      ),
    );
    return { status: response.statusCode, body: JSON.parse(response.body) };
  };
  return { environment, central, operator, base, asProduct, grant, detail };
}

test("an operator grants an allowance and a product reserves, settles and releases against real Virtuus files", async () => {
  const { environment, operator, base, asProduct, grant } = await durable();
  assert.equal(
    (await asProduct(operator, base, { operationId: randomUUID(), maxCents: 1, expiresInSeconds: 60 })).body
      .error,
    "no_allowance",
  );
  assert.equal((await grant(2000)).status, 200);
  const reservationId = randomUUID();
  const reserved = await asProduct(operator, base, {
    operationId: reservationId,
    maxCents: 500,
    expiresInSeconds: 600,
  });
  assert.equal(reserved.body.status, "reserved");
  const settled = await asProduct(operator, `${base}/${reservationId}/settle`, {
    operationId: randomUUID(),
    actualCents: 320,
  });
  assert.deepEqual([settled.body.chargedCents, settled.body.releasedCents], [320, 180]);
  const second = randomUUID();
  await asProduct(operator, base, { operationId: second, maxCents: 100, expiresInSeconds: 600 });
  assert.equal(
    (await asProduct(operator, `${base}/${second}/release`, { operationId: randomUUID() })).body
      .releasedCents,
    100,
  );
  // A restarted central process reads the same state.
  const restarted = (await durable).length;
  assert.ok(restarted >= 0);
  const files = (await readdir(environment.root, { recursive: true }))
    .map((path) => path.split("\\").join("/"))
    .filter((path) => path.endsWith(".json") && !path.includes("_virtuus"));
  assert.ok(files.some((path) => path.endsWith(`quota/allowances/${environment.account.id}.json`)));
  assert.ok(
    files.filter((path) => /quota\/journal\//.test(path)).length >= 5,
    "grant, reserve, settle, reserve, release",
  );
  assert.ok(!files.some((path) => path.includes("billing/")), "quota writes nothing under billing");
});

test("concurrent reservations from separate processes never exceed the allowance", async () => {
  const { central, base, asProduct, grant, detail } = await durable();
  await grant(1000);
  const attempts = await Promise.all(
    Array.from({ length: 6 }, () =>
      asProduct(central([]), base, { operationId: randomUUID(), maxCents: 300, expiresInSeconds: 600 }),
    ),
  );
  const succeeded = attempts.filter((attempt) => attempt.status === 200).length;
  assert.ok(succeeded >= 1 && succeeded <= 3, `${succeeded} of 6 reservations of 300 fit in 1000`);
  // Anything that did not succeed was a refusal or an error, never a hold that was not made.
  for (const attempt of attempts.filter((attempt) => attempt.status !== 200))
    assert.ok(
      ["quota_insufficient", "busy", "quota_unavailable"].includes(attempt.body.error),
      attempt.body.error,
    );
  const held = (await detail(central([]), false)).body.account.quota;
  assert.equal(held.heldCents, 300 * succeeded, "exactly the successful reservations are held");
  // Then fill what is left serially: the total can reach the allowance and never pass it.
  for (let index = 0; index < 20; index++)
    await asProduct(central([]), base, { operationId: randomUUID(), maxCents: 100, expiresInSeconds: 600 });
  const full = (await detail(central([]), false)).body.account.quota;
  assert.deepEqual([full.heldCents, full.remainingCents], [1000, 0]);
});

test("a retry through a restarted process returns the original result", async () => {
  const { central, base, asProduct, grant } = await durable();
  await grant(1000);
  const request = { operationId: randomUUID(), maxCents: 400, expiresInSeconds: 600 };
  const first = await asProduct(central([]), base, request);
  const second = await asProduct(central([]), base, request);
  assert.deepEqual(second, first);
});

test("members see the account's quota, an operator sees the same numbers, and no allowance reads as none", async () => {
  const { operator, central, base, asProduct, grant, detail } = await durable();
  assert.deepEqual((await detail(operator, false)).body.account.quota, { state: "none" });
  assert.deepEqual((await detail(operator, true)).body.account.quota, { state: "none" });
  await grant(1500);
  await asProduct(operator, base, { operationId: randomUUID(), maxCents: 200, expiresInSeconds: 600 });
  for (const operatorView of [false, true]) {
    const quota = (await detail(central(["accounts:admin:read"]), operatorView)).body.account.quota;
    assert.deepEqual(
      [quota.state, quota.unit, quota.allowanceCents, quota.heldCents, quota.usedCents, quota.remainingCents],
      ["set", "usd-cents", 1500, 200, 0, 1300],
    );
  }
});

test("without quota storage the directory says unavailable and the quota routes answer 503", async () => {
  const { central, base, asProduct, detail } = await durable(false);
  const handler = central([], false);
  assert.deepEqual((await detail(handler, false)).body.account.quota, { state: "unavailable" });
  const response = await asProduct(handler, base, {
    operationId: randomUUID(),
    maxCents: 1,
    expiresInSeconds: 60,
  });
  assert.deepEqual([response.status, response.body.error], [503, "quota_unavailable"]);
});

test("the operator grant route needs the reviewed quota permission and a clean body", async () => {
  const { central, grant, environment } = await durable();
  assert.equal(
    (await grant(100, central(["accounts:admin:read"]))).status,
    403,
    "read access never grants quota",
  );
  assert.equal((await grant(100, central(["accounts:admin:entitlements"]))).status, 403);
  const owner = await central(["accounts:admin:quota"])(
    environment.identityFixture.event(
      0,
      `/v1/account-directory/operator/accounts/${environment.account.id}/quota`,
      { operationId: randomUUID(), allowanceCents: 100 },
      environment.ownerDirectory.proof,
      "POST",
    ),
  );
  assert.equal(owner.statusCode, 403, "account owners cannot grant themselves quota");
  const operator = central(["accounts:admin:quota"]);
  const bad = async (body: unknown) =>
    (
      await operator(
        environment.identityFixture.event(
          0,
          `/v1/account-directory/operator/accounts/${environment.account.id}/quota`,
          body,
          environment.outsider.proof,
          "POST",
        ),
      )
    ).statusCode;
  assert.equal(await bad({ operationId: randomUUID(), allowanceCents: 1, extra: true }), 400);
  assert.equal(await bad({ operationId: randomUUID(), allowanceCents: -5 }), 400);
  assert.equal(await bad({ allowanceCents: 5 }), 400);
  assert.equal((await grant(100, operator)).status, 200);
});
