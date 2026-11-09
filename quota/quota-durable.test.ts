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
import { FakeTable, batch, exampleTable, tokens } from "./testing/quota-fixture";

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
  const table = new FakeTable();
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
      table,
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
  const grant = async (body: Record<string, unknown>, handler = operator) => {
    const response = await handler(
      environment.identityFixture.event(
        0,
        `/v1/account-directory/operator/accounts/${environment.account.id}/quota`,
        { operationId: randomUUID(), ...body },
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
  return { environment, central, operator, base, asProduct, grant, detail, table };
}

const reserveBody = (items = batch(100)) => ({ operationId: randomUUID(), items, expiresInSeconds: 600 });

test("an operator sets a plan and a product reserves, settles, releases, records and checks against real Virtuus files", async () => {
  const { environment, operator, base, asProduct, grant } = await durable();
  assert.equal((await grant({ plan: "example-large" })).status, 200);
  const reservationId = randomUUID();
  const reserved = await asProduct(operator, base, {
    ...reserveBody(batch(100)),
    operationId: reservationId,
  });
  assert.equal(reserved.body.status, "reserved");
  const settled = await asProduct(operator, `${base}/${reservationId}/settle`, {
    operationId: randomUUID(),
    items: batch(60),
  });
  assert.equal(settled.body.status, "settled");
  const second = randomUUID();
  await asProduct(operator, base, { ...reserveBody(), operationId: second });
  assert.equal(
    (await asProduct(operator, `${base}/${second}/release`, { operationId: randomUUID() })).body.status,
    "released",
  );
  const usage = environment.account.id;
  const recorded = await asProduct(operator, base.replace("/reservations", "/usage"), {
    operationId: randomUUID(),
    items: tokens(5000),
  });
  assert.equal(recorded.body.status, "recorded");
  const check = await asProduct(operator, base.replace("/reservations", "/check"), {});
  assert.deepEqual([check.status, check.body.allowed, check.body.percentUsed], [200, true, 13]);
  const files = (await readdir(environment.root, { recursive: true }))
    .map((path) => path.split("\\").join("/"))
    .filter((path) => path.endsWith(".json") && !path.includes("_virtuus"));
  assert.ok(files.some((path) => path.endsWith(`quota/settings/${usage}.json`)));
  assert.ok(files.some((path) => new RegExp(`quota/weeks/${usage}/[0-9]+\\.json$`).test(path)));
  assert.ok(files.filter((path) => /quota\/journal\//.test(path)).length >= 5);
  assert.ok(!files.some((path) => path.includes("billing/")), "quota writes nothing under billing");
});

test("concurrent reservations from separate processes never exceed this week's allowance", async () => {
  const { central, base, asProduct, grant, detail } = await durable();
  await grant({ allowanceOverrideUnits: 1000 });
  const attempts = await Promise.all(
    Array.from({ length: 6 }, () => asProduct(central([]), base, reserveBody(batch(100)))), // 300 units each
  );
  const succeeded = attempts.filter((attempt) => attempt.status === 200).length;
  assert.ok(succeeded >= 1 && succeeded <= 3, `${succeeded} of 6 reservations fit`);
  for (const attempt of attempts.filter((attempt) => attempt.status !== 200))
    assert.ok(
      ["quota_insufficient", "busy", "quota_unavailable"].includes(attempt.body.error),
      attempt.body.error,
    );
  assert.equal((await detail(central([]), false)).body.account.quota.percentUsed, 30 * succeeded);
  for (let index = 0; index < 20; index++) await asProduct(central([]), base, reserveBody(batch(10)));
  const full = (await detail(central([]), false)).body.account.quota;
  assert.ok(full.percentUsed >= 99 && full.percentUsed <= 100, "it fills up and never passes 100%");
});

test("a retry through a restarted process returns the original result", async () => {
  const { central, base, asProduct, grant } = await durable();
  await grant({ plan: "example-large" });
  const input = reserveBody();
  const first = await asProduct(central([]), base, input);
  assert.deepEqual(await asProduct(central([]), base, input), first);
  const usage = { operationId: randomUUID(), items: tokens(100) };
  const path = base.replace("/reservations", "/usage");
  assert.deepEqual(await asProduct(central([]), path, usage), await asProduct(central([]), path, usage));
});

test("members see only a percentage and a reset time; staff also see internal units; no allowance reads as none", async () => {
  const { operator, central, base, asProduct, grant, detail, table } = await durable();
  const noDefault = exampleTable();
  delete noDefault.defaultPlan;
  table.table = noDefault;
  assert.deepEqual((await detail(operator, false)).body.account.quota, { state: "none" });
  assert.equal((await detail(operator, true)).body.account.quota.state, "none");
  await grant({ allowanceOverrideUnits: 1500 });
  await asProduct(operator, base, reserveBody(batch(100)));
  const customer = (await detail(central(["accounts:admin:read"]), false)).body.account.quota;
  assert.deepEqual(Object.keys(customer).sort(), ["byProduct", "percentUsed", "resetsAt", "state"]);
  assert.equal(customer.percentUsed, 20);
  const staff = (await detail(central(["accounts:admin:read"]), true)).body.account.quota;
  assert.deepEqual(
    [staff.state, staff.allowanceUnits, staff.heldUnits, staff.percentUsed],
    ["set", 1500, 300, 20],
  );
  assert.doesNotMatch(JSON.stringify(staff), /example\./, "the rate table's contents are never shown");
});

test("without quota storage the directory says unavailable and the quota routes answer 503", async () => {
  const { central, base, asProduct, detail } = await durable(false);
  const handler = central([], false);
  assert.deepEqual((await detail(handler, false)).body.account.quota, { state: "unavailable" });
  const response = await asProduct(handler, base, reserveBody());
  assert.deepEqual([response.status, response.body.error], [503, "quota_unavailable"]);
});

test("an unusable rate table refuses quota calls and shows unavailable", async () => {
  const { operator, base, asProduct, grant, detail, table } = await durable();
  await grant({ plan: "example-large" });
  table.table = '{"version":"unset"}';
  const response = await asProduct(operator, base, reserveBody());
  assert.deepEqual([response.status, response.body.error], [503, "quota_unavailable"]);
  assert.deepEqual((await detail(operator, false)).body.account.quota, { state: "unavailable" });
});

test("the operator route needs the reviewed quota permission and a clean body", async () => {
  const { central, grant, environment } = await durable();
  assert.equal((await grant({ plan: "example-large" }, central(["accounts:admin:read"]))).status, 403);
  assert.equal(
    (await grant({ plan: "example-large" }, central(["accounts:admin:entitlements"]))).status,
    403,
  );
  const owner = await central(["accounts:admin:quota"])(
    environment.identityFixture.event(
      0,
      `/v1/account-directory/operator/accounts/${environment.account.id}/quota`,
      { operationId: randomUUID(), plan: "example-large" },
      environment.ownerDirectory.proof,
      "POST",
    ),
  );
  assert.equal(owner.statusCode, 403, "account owners cannot grant themselves quota");
  const operator = central(["accounts:admin:quota"]);
  assert.equal((await grant({ plan: "example-large", extra: true }, operator)).status, 400);
  assert.equal((await grant({ allowanceOverrideUnits: -5 }, operator)).status, 400);
  assert.equal((await grant({ plan: "example-missing" }, operator)).status, 400);
  assert.equal((await grant({}, operator)).status, 400);
  assert.equal((await grant({ plan: "example-large" }, operator)).status, 200);
});

// features/cost-ledger.feature: the ledger's costs kind through the real Rust bridge, in the quota project.
test("the cost ledger records, replays and corrects through real Virtuus files", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Quota, weekPath } = await import("./service");
  const { CostLedger, costDayPath, utcDay } = await import("./costs");
  const root = await mkdtemp(join(tmpdir(), "quota-costs-"));
  environments.push({ root });
  const files = new VirtuusQuotaFiles(root);
  const accountId = randomUUID();
  const accounts = async (id: string) =>
    id === accountId ? { entitlements: { "papyrus-example": { status: "active" } } } : null;
  const table = new FakeTable();
  (table.table as any).rates["openai.tokens.input"] = { units: 2, per: 1 };
  const now = () => new Date().toISOString();
  const quota = new Quota(files, accounts, [], now, table);
  const ledger = new CostLedger(files, accounts, quota, table, now);
  const day = utcDay(Date.now());
  const message = {
    version: 1,
    operationId: randomUUID(),
    accountId,
    app: "papyrus",
    deployment: "example",
    day,
    items: [{ itemKind: "openai.tokens.input", quantity: 500 }],
  };
  await ledger.recordUsage("papyrus-example", message);
  assert.equal((await ledger.recordUsage("papyrus-example", structuredClone(message))).replayed, true);
  await ledger.recordActual({
    accountId,
    app: "papyrus",
    deployment: "example",
    day,
    costs: [{ category: "openai.tokens.input", micros: 900 }],
    source: "durable-test",
  });
  const document = (await files.get<any>(costDayPath(accountId, day)))!.value;
  assert.equal(document.entries["papyrus|example|openai.tokens.input"].estimatedMicros, 1000);
  assert.equal(document.entries["papyrus|example|openai.tokens.input"].actualMicros, 900);
  const weeks = await files.list(`weeks/${accountId}/`);
  assert.equal(weeks.length, 1);
  const week = (await files.get<any>(weeks[0]))!.value;
  assert.equal(week.usedUnits, 900);
  assert.ok(weekPath);
});
