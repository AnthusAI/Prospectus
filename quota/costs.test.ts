import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  CostLedger,
  appOf,
  costDayPath,
  derivedOperationId,
  productOf,
  splitShared,
  spreadMonthly,
  type CostJournalEvent,
} from "./costs";
import { QuotaError, type QuotaWeek } from "./model";
import { journalPath, weekPath } from "./service";
import { WEEK_KEY, quotaFixture } from "./testing/quota-fixture";

// features/cost-ledger.feature and features/quota-real-cost.feature. Prices are made up.
const DAY = 20300320; // the fixture clock's UTC day
const PRODUCT = "papyrus-example";

function ledgerFixture() {
  const fixture = quotaFixture();
  fixture.entitlements[fixture.accountId][PRODUCT] = { status: "active" };
  const table = fixture.table.table as any;
  table.rates["openai.tokens.input"] = { units: 2, per: 1 };
  table.plans["example-basic"] = { weeklyAllowanceUnits: 10_000 };
  const accounts = async (id: string) =>
    fixture.entitlements[id] ? { entitlements: structuredClone(fixture.entitlements[id]) } : null;
  const ledger = new CostLedger(fixture.store, accounts, fixture.quota, fixture.table, () =>
    new Date(fixture.clock.ms).toISOString(),
  );
  const message = (overrides: Record<string, unknown> = {}) => ({
    version: 1,
    operationId: randomUUID(),
    accountId: fixture.accountId,
    app: "papyrus",
    deployment: "example",
    day: DAY,
    items: [{ itemKind: "openai.tokens.input", quantity: 1000 }],
    ...overrides,
  });
  const week = async () =>
    (await fixture.store.get<QuotaWeek>(weekPath(fixture.accountId, WEEK_KEY)))?.value ?? null;
  const entry = async (category: string) =>
    (await ledger.day(fixture.accountId, DAY))?.entries[`papyrus|example|${category}`];
  return { ...fixture, ledger, message, week, entry };
}
const refused = (status: number, code: string) => (error: any) =>
  error instanceof QuotaError && error.status === status && error.code === code;

test("a live report is priced, recorded as an estimate, journaled once and charged to the quota", async () => {
  const { ledger, message, entry, week, store, accountId } = ledgerFixture();
  const body = message();
  await ledger.recordUsage(PRODUCT, body);
  assert.deepEqual(await entry("openai.tokens.input"), {
    app: "papyrus",
    deployment: "example",
    category: "openai.tokens.input",
    quantity: 1000,
    estimatedMicros: 2000,
    actualMicros: null,
  });
  assert.equal((await week())?.usedUnits, 2000);
  assert.equal((await week())?.usedByProduct[PRODUCT], 2000);
  const journals = (await store.list("journal/")).length;
  assert.ok(journals >= 2, "the cost event and the quota charge are both journaled");
  assert.ok(await store.get(costDayPath(accountId, DAY)));
});

test("a repeated message is counted once; the same ID with different content is refused", async () => {
  const { ledger, message, entry, week } = ledgerFixture();
  const body = message();
  await ledger.recordUsage(PRODUCT, body);
  const replay = await ledger.recordUsage(PRODUCT, structuredClone(body));
  assert.equal(replay.replayed, true);
  assert.equal((await entry("openai.tokens.input"))?.estimatedMicros, 2000);
  assert.equal((await week())?.usedUnits, 2000);
  await assert.rejects(
    ledger.recordUsage(PRODUCT, { ...body, items: [{ itemKind: "openai.tokens.input", quantity: 1 }] }),
    refused(409, "idempotency_conflict"),
  );
});

test("an imported actual replaces the estimate and charges only the correction", async () => {
  const { ledger, message, entry, week, accountId } = ledgerFixture();
  await ledger.recordUsage(PRODUCT, message());
  const actual = (micros: number) =>
    ledger.recordActual({
      accountId,
      app: "papyrus",
      deployment: "example",
      day: DAY,
      costs: [{ category: "openai.tokens.input", micros }],
      source: "test",
    });
  await actual(1800);
  assert.equal((await entry("openai.tokens.input"))?.actualMicros, 1800);
  assert.equal((await week())?.usedUnits, 1800, "1800, not 3800");
  // Re-running with the same figures changes nothing.
  assert.equal((await actual(1800)).replayed, true);
  assert.equal((await week())?.usedUnits, 1800);
  // A later import corrects the day.
  await actual(1810);
  assert.equal((await week())?.usedUnits, 1810);
  // Estimates arriving after the actual do not change the day's effective amount.
  await ledger.recordUsage(PRODUCT, message());
  assert.equal((await entry("openai.tokens.input"))?.estimatedMicros, 4000);
  assert.equal((await week())?.usedUnits, 1810);
});

test("a cost that only comes from the import counts, even with no use", async () => {
  const { ledger, entry, week, accountId, percent } = ledgerFixture();
  await ledger.recordActual({
    accountId,
    app: "papyrus",
    deployment: "example",
    day: DAY,
    costs: [{ category: "aws.appsync", micros: 2500 }],
    source: "test",
  });
  assert.equal((await entry("aws.appsync"))?.actualMicros, 2500);
  assert.equal((await week())?.usedUnits, 2500);
  assert.equal(await percent(), 25);
});

test("a correction lowers usage but never below zero", async () => {
  const { ledger, store, week, accountId, quota } = ledgerFixture();
  await ledger.recordActual({
    accountId,
    app: "papyrus",
    deployment: "example",
    day: DAY,
    costs: [{ category: "aws.appsync", micros: 3000 }],
    source: "test",
  });
  await ledger.recordActual({
    accountId,
    app: "papyrus",
    deployment: "example",
    day: DAY,
    costs: [{ category: "aws.appsync", micros: 2500 }],
    source: "test",
  });
  assert.equal((await week())?.usedUnits, 2500);
  await quota.applyCost({
    accountId,
    operationId: randomUUID(),
    product: PRODUCT,
    units: -99_999,
    source: "test",
  });
  assert.equal((await week())?.usedUnits, 0);
  assert.equal((await week())?.usedByProduct[PRODUCT], 0);
  assert.ok(store);
});

test("the product comes from the queue, and the message must match it", async () => {
  const { ledger, message, entitlements, accountId } = ledgerFixture();
  await assert.rejects(ledger.recordUsage("papyrus-other", message()), refused(403, "wrong_product"));
  await assert.rejects(
    ledger.recordUsage(PRODUCT, message({ app: "cyclotron" })),
    refused(403, "wrong_product"),
  );
  await assert.rejects(
    ledger.recordUsage(PRODUCT, message({ deployment: "other" })),
    refused(403, "wrong_product"),
  );
  await assert.rejects(ledger.recordUsage("example-renderer", message()), refused(403, "wrong_product"));
  entitlements[accountId][PRODUCT] = { status: "disabled" };
  await assert.rejects(ledger.recordUsage(PRODUCT, message()), refused(403, "product_not_entitled"));
  await assert.rejects(
    ledger.recordUsage(PRODUCT, message({ accountId: randomUUID() })),
    refused(404, "account_missing"),
  );
});

test("malformed messages and unknown item kinds are refused and charge nothing", async () => {
  const { ledger, message, week, store, accountId } = ledgerFixture();
  await assert.rejects(ledger.recordUsage(PRODUCT, message({ extra: 1 })), refused(400, "unknown_fields"));
  await assert.rejects(ledger.recordUsage(PRODUCT, message({ version: 2 })), refused(400, "invalid_version"));
  await assert.rejects(ledger.recordUsage(PRODUCT, message({ day: 20300230 })), refused(400, "invalid_day"));
  await assert.rejects(ledger.recordUsage(PRODUCT, message({ day: 20300101 })), refused(400, "invalid_day"));
  await assert.rejects(ledger.recordUsage(PRODUCT, message({ day: 20300325 })), refused(400, "invalid_day"));
  await assert.rejects(
    ledger.recordUsage(PRODUCT, message({ deployment: "Bad Site" })),
    refused(400, "invalid_deployment"),
  );
  const unknown = message({ items: [{ itemKind: "jev.tokens", quantity: 5 }] });
  await assert.rejects(ledger.recordUsage(PRODUCT, unknown), refused(422, "unknown_item_kind"));
  assert.equal(await week(), null);
  assert.equal(await store.get(costDayPath(accountId, DAY)), null);
  const refusals = await Promise.all(
    (await store.list("journal/")).map(async (path) => (await store.get<CostJournalEvent>(path))?.value),
  );
  assert.ok(refusals.some((event) => event?.action === "cost.refused" && event.delta === 0));
});

test("the day document stays bounded however many messages arrive", async () => {
  const { ledger, message, accountId, store } = ledgerFixture();
  for (let index = 0; index < 120; index++) await ledger.recordUsage(PRODUCT, message());
  const document = (await ledger.day(accountId, DAY))!;
  assert.equal(Object.keys(document.entries).length, 1);
  assert.equal(document.audit.length, 64);
  assert.equal(document.entries["papyrus|example|openai.tokens.input"].estimatedMicros, 240_000);
  assert.ok(Buffer.byteLength(JSON.stringify(document)) < 32_768);
  assert.ok((await store.list("journal/")).length >= 240);
});

test("a crash between the day document and the quota charge is finished by the retry", async () => {
  const { ledger, message, week, store } = ledgerFixture();
  const body = message();
  const real = (ledger as any).quota;
  const original = real.applyCost.bind(real);
  let failOnce = true;
  (ledger as any).quota = {
    applyCost: async (input: any) => {
      if (failOnce) {
        failOnce = false;
        throw new QuotaError(503, "quota_unavailable", "down");
      }
      return original(input);
    },
  };
  await assert.rejects(ledger.recordUsage(PRODUCT, body), refused(503, "quota_unavailable"));
  assert.equal(await week(), null);
  await ledger.recordUsage(PRODUCT, body);
  assert.equal((await week())?.usedUnits, 2000);
  await ledger.recordUsage(PRODUCT, body);
  assert.equal((await week())?.usedUnits, 2000, "never twice");
  assert.ok(store);
});

test("products and apps map both ways, with every Papyrus site as app papyrus", () => {
  assert.equal(appOf("papyrus-dataparade"), "papyrus");
  assert.equal(appOf("cyclotron"), "cyclotron");
  assert.equal(appOf("example-renderer"), null);
  assert.equal(appOf("papyrus-"), null);
  assert.equal(productOf("papyrus", "dataparade"), "papyrus-dataparade");
  assert.equal(productOf("cyclotron", "lab"), "cyclotron");
});

test("monthly charges spread over the month to the exact total", () => {
  const november = spreadMonthly(500_000, 2026, 11);
  assert.equal(november.length, 30);
  assert.equal(
    november.reduce((sum, value) => sum + value, 0),
    500_000,
  );
  assert.ok(november.every((value) => value === 16_666 || value === 16_667));
  assert.equal(spreadMonthly(31, 2026, 12).length, 31);
  assert.equal(spreadMonthly(10, 2028, 2).length, 29);
});

test("shared costs split by usage to the exact total, or stay unattributed", () => {
  assert.deepEqual(splitShared(900, { a: 2000, b: 1000 }), { a: 600, b: 300 });
  const uneven = splitShared(100, { a: 1, b: 1, c: 1 })!;
  assert.equal(
    Object.values(uneven).reduce((sum, value) => sum + value, 0),
    100,
  );
  assert.equal(splitShared(900, {}), null);
  assert.equal(splitShared(900, { a: 0 }), null);
});

test("derived operation IDs are stable UUIDs", () => {
  const id = derivedOperationId("x", 1);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(id, derivedOperationId("x", 1));
  assert.notEqual(id, derivedOperationId("x", 2));
  assert.ok(journalPath(id));
});

test('a usage message for "owner" is charged to the deployment\'s one owning Account, or refused', async () => {
  const fixture = quotaFixture();
  fixture.entitlements[fixture.accountId][PRODUCT] = { status: "active" };
  (fixture.table.table as any).rates["openai.tokens.input"] = { units: 2, per: 1 };
  const accounts = async (id: string) =>
    fixture.entitlements[id] ? { entitlements: structuredClone(fixture.entitlements[id]) } : null;
  let holders: string[] = [fixture.accountId];
  const ledger = new CostLedger(
    fixture.store,
    accounts,
    fixture.quota,
    fixture.table,
    () => new Date(fixture.clock.ms).toISOString(),
    async (app, deployment) =>
      app === "papyrus" && deployment === "example" && holders.length === 1 ? holders[0] : null,
  );
  const body = (overrides = {}) => ({
    version: 1,
    operationId: randomUUID(),
    accountId: "owner",
    app: "papyrus",
    deployment: "example",
    day: DAY,
    items: [{ itemKind: "openai.tokens.input", quantity: 10 }],
    ...overrides,
  });
  await ledger.recordUsage(PRODUCT, body());
  assert.equal(
    (await ledger.day(fixture.accountId, DAY))?.entries["papyrus|example|openai.tokens.input"]
      .estimatedMicros,
    20,
  );
  holders = [];
  await assert.rejects(ledger.recordUsage(PRODUCT, body()), refused(422, "owner_unknown"));
  holders = [fixture.accountId, randomUUID()];
  await assert.rejects(ledger.recordUsage(PRODUCT, body()), refused(422, "owner_unknown"));
  await assert.rejects(
    ledger.recordUsage("cyclotron", body({ app: "cyclotron", deployment: undefined })),
    refused(400, "owner_needs_deployment"),
  );
});
