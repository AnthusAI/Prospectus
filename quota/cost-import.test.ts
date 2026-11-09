import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  AwsCostExplorerSource,
  dollarsToMicros,
  importCostDay,
  importRecentCosts,
  serviceCategory,
  type CostExplorerDay,
  type CostExplorerSource,
} from "./cost-import";
import { CostLedger, costDayPath, OVERHEAD_ACCOUNT, type CostDay } from "./costs";
import type { QuotaWeek } from "./model";
import { weekPath } from "./service";
import { WEEK_KEY, quotaFixture } from "./testing/quota-fixture";

// features/cost-daily-import.feature, against a fake Cost Explorer. Amounts are made up.
const DAY = 20300319; // the day before the fixture clock (Wednesday 2030-03-20)

class FakeCostExplorer implements CostExplorerSource {
  days: Record<number, CostExplorerDay> = {};
  calls: number[] = [];
  failing = false;
  async day(day: number) {
    this.calls.push(day);
    if (this.failing) throw new Error("ThrottlingException: rate exceeded");
    return structuredClone(this.days[day] ?? { estimated: false, rows: [] });
  }
}

function importFixture() {
  const fixture = quotaFixture();
  const a = fixture.accountId,
    b = randomUUID();
  fixture.entitlements[b] = {};
  for (const id of [a, b]) {
    fixture.entitlements[id]["papyrus-example"] = { status: "active" };
    fixture.entitlements[id]["cyclotron"] = { status: "active" };
  }
  const table = fixture.table.table as any;
  table.rates["aws.lambda.gb_seconds"] = { units: 1, per: 10 };
  table.rates["aws.appsync.requests"] = { units: 1, per: 1 };
  table.plans["example-basic"] = { weeklyAllowanceUnits: 10_000_000 };
  const accounts = async (id: string) =>
    fixture.entitlements[id] ? { entitlements: structuredClone(fixture.entitlements[id]) } : null;
  const now = () => new Date(fixture.clock.ms).toISOString();
  const ledger = new CostLedger(fixture.store, accounts, fixture.quota, fixture.table, now);
  const source = new FakeCostExplorer();
  const logs: Record<string, unknown>[] = [];
  const run = (day = DAY) =>
    importCostDay({
      source,
      ledger,
      accountIds: async () => Object.keys(fixture.entitlements),
      day,
      log: (entry) => logs.push(entry),
    });
  const usage = (
    accountId: string,
    product: string,
    app: string,
    deployment: string | undefined,
    itemKind: string,
    quantity: number,
  ) =>
    ledger.recordUsage(product, {
      version: 1,
      operationId: randomUUID(),
      accountId,
      app,
      ...(deployment ? { deployment } : {}),
      day: DAY,
      items: [{ itemKind, quantity }],
    });
  const used = async (accountId: string, week = WEEK_KEY) =>
    (await fixture.store.get<QuotaWeek>(weekPath(accountId, week)))?.value.usedUnits ?? 0;
  const entry = async (accountId: string, key: string, day = DAY) =>
    (await ledger.day(accountId, day))?.entries[key];
  return { ...fixture, a, b, ledger, source, logs, run, usage, used, entry };
}

test("a tagged per-customer cost becomes that Account's actual and is charged to its current week", async () => {
  const { a, source, run, entry, used } = importFixture();
  source.days[DAY] = {
    estimated: false,
    rows: [{ costKey: `${a}/papyrus/example`, service: "AWS AppSync", micros: 350_000 }],
  };
  const result = await run();
  assert.equal(result.imported, true);
  assert.deepEqual(await entry(a, "papyrus|example|aws.appsync"), {
    app: "papyrus",
    deployment: "example",
    category: "aws.appsync",
    quantity: 0,
    estimatedMicros: 0,
    actualMicros: 350_000,
  });
  assert.equal(await used(a), 350_000);
});

test("the imported service cost replaces the app's live estimates for that service, never adds to them", async () => {
  const { a, source, run, entry, used, usage } = importFixture();
  await usage(a, "papyrus-example", "papyrus", "example", "aws.appsync.requests", 1000);
  assert.equal(await used(a), 1000);
  source.days[DAY] = {
    estimated: false,
    rows: [{ costKey: `${a}/papyrus/example`, service: "AWS AppSync", micros: 1200 }],
  };
  await run();
  assert.equal((await entry(a, "papyrus|example|aws.appsync.requests"))?.actualMicros, 0);
  assert.equal(await used(a), 1200, "the estimate is replaced by the real figure");
});

test("shared cost is split by reported usage, exactly, and replaces the usage estimates", async () => {
  const { a, b, source, run, entry, used, usage } = importFixture();
  await usage(a, "cyclotron", "cyclotron", undefined, "aws.lambda.gb_seconds", 2000);
  await usage(b, "cyclotron", "cyclotron", undefined, "aws.lambda.gb_seconds", 1000);
  source.days[DAY] = {
    estimated: false,
    rows: [{ costKey: "shared/cyclotron/", service: "AWS Lambda", micros: 900 }],
  };
  await run();
  assert.equal((await entry(a, "cyclotron||aws.lambda"))?.actualMicros, 600);
  assert.equal((await entry(b, "cyclotron||aws.lambda"))?.actualMicros, 300);
  assert.equal((await entry(a, "cyclotron||aws.lambda.gb_seconds"))?.actualMicros, 0);
  assert.equal(await used(a), 600);
  assert.equal(await used(b), 300);

  source.days[DAY].rows[0].micros = 1000;
  await run();
  const parts = [
    (await entry(a, "cyclotron||aws.lambda"))?.actualMicros,
    (await entry(b, "cyclotron||aws.lambda"))?.actualMicros,
  ];
  assert.deepEqual(parts, [667, 333], "largest remainder: the parts sum to the total");
});

test("shared cost with no reported usage, untagged cost, unknown Accounts and credits are overhead", async () => {
  const { a, source, run, ledger, used } = importFixture();
  const stranger = randomUUID();
  source.days[DAY] = {
    estimated: false,
    rows: [
      { costKey: "shared/cyclotron/", service: "AWS Lambda", micros: 500 },
      { costKey: null, service: "Amazon Route 53", micros: 40 },
      { costKey: null, service: "Amazon Route 53", micros: 2 },
      { costKey: `${stranger}/papyrus/gone`, service: "Amazon DynamoDB", micros: 70 },
      { costKey: `${a}/papyrus/example`, service: "AWS Amplify", micros: -30 },
    ],
  };
  await run();
  const overhead = await ledger.overheadDay(DAY);
  const amounts = Object.fromEntries(
    Object.entries(overhead!.entries).map(([key, value]) => [key, value.actualMicros]),
  );
  assert.deepEqual(amounts, {
    "unattributed|cyclotron|aws.lambda": 500,
    "untagged||aws.route_53": 42,
    "unknown_account|papyrus|aws.dynamodb": 70,
    "credit|papyrus|aws.amplify": -30,
  });
  assert.equal(await used(a), 0, "overhead and credits are charged to no Account");
  assert.equal(costDayPath(OVERHEAD_ACCOUNT, DAY), `costs/${OVERHEAD_ACCOUNT}/${DAY}.json`);
});

test("estimated figures are recorded, and a later import for the same day replaces them", async () => {
  const { a, source, run, entry, used } = importFixture();
  source.days[DAY] = {
    estimated: true,
    rows: [{ costKey: `${a}/papyrus/example`, service: "AWS AppSync", micros: 100 }],
  };
  assert.equal((await run()).estimated, true);
  source.days[DAY] = {
    estimated: false,
    rows: [{ costKey: `${a}/papyrus/example`, service: "AWS AppSync", micros: 130 }],
  };
  await run();
  assert.equal((await entry(a, "papyrus|example|aws.appsync"))?.actualMicros, 130);
  assert.equal(await used(a), 130);
});

test("re-running the import for the same day changes nothing", async () => {
  const { a, b, source, run, ledger, used, usage, store } = importFixture();
  await usage(a, "cyclotron", "cyclotron", undefined, "aws.lambda.gb_seconds", 10);
  source.days[DAY] = {
    estimated: false,
    rows: [
      { costKey: `${a}/papyrus/example`, service: "AWS AppSync", micros: 100 },
      { costKey: "shared/cyclotron/", service: "AWS Lambda", micros: 50 },
      { costKey: null, service: "Amazon Route 53", micros: 5 },
    ],
  };
  await run();
  const snapshot = async () => [
    (await ledger.day(a, DAY))?.revision,
    (await ledger.day(b, DAY))?.revision ?? null,
    (await ledger.overheadDay(DAY))?.revision,
    await used(a),
    (await store.list("journal/")).length,
  ];
  const before = await snapshot();
  await run();
  // The flipped estimated flag alone is not a change either.
  source.days[DAY].estimated = true;
  await run();
  assert.deepEqual(await snapshot(), before);
});

test("a cost incurred Friday and imported Sunday counts in the week that started Saturday", async () => {
  const { a, source, ledger, used, clock } = importFixture();
  clock.ms = Date.parse("2030-03-17T17:00:00Z"); // Sunday, in the week that began Saturday 2030-03-16
  source.days[20300315] = {
    estimated: false,
    rows: [{ costKey: `${a}/papyrus/example`, service: "AWS AppSync", micros: 250 }],
  };
  await importCostDay({ source, ledger, accountIds: async () => [a], day: 20300315 });
  assert.equal((await ledger.day(a, 20300315))?.entries["papyrus|example|aws.appsync"].actualMicros, 250);
  assert.equal(await used(a, WEEK_KEY), 250);
  assert.equal(await used(a, 20300309), 0, "past weeks are never rewritten");
});

test("a failed Cost Explorer call records nothing, logs a reason code and is retried on the next run", async () => {
  const { a, source, ledger, logs, store, clock } = importFixture();
  source.failing = true;
  const results = await importRecentCosts({
    source,
    ledger,
    accountIds: async () => [a],
    nowMs: clock.ms,
    log: (entry) => logs.push(entry),
  });
  assert.deepEqual(results, [{ day: 20300317, imported: false, reason: "cost_explorer_failed" }]);
  assert.deepEqual(logs, [{ event: "cost_import_failed", day: 20300317, reason: "cost_explorer_failed" }]);
  assert.equal(JSON.stringify(logs).includes("Throttling"), false, "no provider text in logs");
  assert.deepEqual(await store.list("costs/"), []);
  source.failing = false;
  source.calls = [];
  await importRecentCosts({ source, ledger, accountIds: async () => [a], nowMs: clock.ms });
  assert.deepEqual(
    source.calls,
    [20300317, 20300318, 20300319],
    "the last three complete days, oldest first",
  );
});

test("Cost Explorer amounts and services are read exactly", async () => {
  assert.equal(dollarsToMicros("0.3500000000"), 350_000);
  assert.equal(dollarsToMicros("12"), 12_000_000);
  assert.equal(dollarsToMicros("0.0000004999"), 0);
  assert.equal(dollarsToMicros("0.0000005"), 1);
  assert.equal(dollarsToMicros("-1.25"), -1_250_000);
  assert.throws(() => dollarsToMicros("1e-7"), /cost_amount_malformed/);
  assert.equal(serviceCategory("AWS AppSync"), "aws.appsync");
  assert.equal(serviceCategory("Amazon DynamoDB"), "aws.dynamodb");
  assert.equal(serviceCategory("Amazon Simple Storage Service"), "aws.simple_storage_service");
  assert.equal(serviceCategory("AWS Lambda"), "aws.lambda");
  assert.equal(serviceCategory("Tax"), "aws.tax");

  const requests: any[] = [];
  const pages = [
    {
      ResultsByTime: [
        {
          Estimated: true,
          Groups: [
            {
              Keys: ["anthus:cost-key$shared/cyclotron/", "AWS Lambda"],
              Metrics: { UnblendedCost: { Amount: "0.0009" } },
            },
            { Keys: ["anthus:cost-key$", "Amazon Route 53"], Metrics: { UnblendedCost: { Amount: "0.5" } } },
            {
              Keys: ["anthus:cost-key$", "AWS Key Management Service"],
              Metrics: { UnblendedCost: { Amount: "0" } },
            },
          ],
        },
      ],
      NextPageToken: "next",
    },
    { ResultsByTime: [{ Estimated: false, Groups: [] }] },
  ];
  class GetCostAndUsageCommand {
    constructor(public input: any) {}
  }
  const explorer = new AwsCostExplorerSource(
    async (command: any) => {
      requests.push(command.input);
      return pages[requests.length - 1];
    },
    { GetCostAndUsageCommand },
  );
  const day = await explorer.day(20301231);
  assert.deepEqual(day, {
    estimated: true,
    rows: [
      { costKey: "shared/cyclotron/", service: "AWS Lambda", micros: 900 },
      { costKey: null, service: "Amazon Route 53", micros: 500_000 },
    ],
  });
  assert.deepEqual(requests[0].TimePeriod, { Start: "2030-12-31", End: "2031-01-01" });
  assert.deepEqual(requests[0].GroupBy, [
    { Type: "TAG", Key: "anthus:cost-key" },
    { Type: "DIMENSION", Key: "SERVICE" },
  ]);
  assert.equal(requests[1].NextPageToken, "next");
});

test("the overhead document is never an Account", async () => {
  const { ledger } = importFixture();
  const document: CostDay | null = await ledger.overheadDay(DAY);
  assert.equal(document, null);
});

test("shared cost with usage of the app but not of that service is split by total reported usage", async () => {
  const { a, b, source, run, entry, usage, table } = importFixture();
  (table.table as any).rates["openai.tokens.input"] = { units: 1, per: 1 };
  await usage(a, "cyclotron", "cyclotron", undefined, "openai.tokens.input", 300);
  await usage(b, "cyclotron", "cyclotron", undefined, "openai.tokens.input", 100);
  source.days[DAY] = {
    estimated: false,
    rows: [{ costKey: "shared/cyclotron/", service: "Amazon DynamoDB", micros: 80 }],
  };
  await run();
  assert.equal((await entry(a, "cyclotron||aws.dynamodb"))?.actualMicros, 60);
  assert.equal((await entry(b, "cyclotron||aws.dynamodb"))?.actualMicros, 20);
  assert.equal(
    (await entry(a, "cyclotron||openai.tokens.input"))?.actualMicros,
    null,
    "model estimates are untouched",
  );
});
