import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ParameterStoreRateTable,
  convertItems,
  parseItems,
  parseRateTable,
  rateTableConfiguration,
  unconfiguredRateTable,
} from "./rate-table";
import { QuotaError } from "./model";
import { exampleTable } from "./testing/quota-fixture";

const refused = (status: number, code: string) => (error: any) =>
  error instanceof QuotaError && error.status === status && error.code === code;
const text = (change: (table: any) => void) => {
  const table: any = exampleTable();
  change(table);
  return JSON.stringify(table);
};

test("a valid table parses and converts items to whole units, rounding up per item", () => {
  const table = parseRateTable(JSON.stringify(exampleTable()));
  assert.equal(table.version, "example-1");
  const conversion = convertItems(table, [
    { itemKind: "example.tokens", quantity: 95 },
    { itemKind: "example.batch.seconds", quantity: 4 },
    { itemKind: "example.lambda.seconds", quantity: 0 },
  ]);
  assert.deepEqual(
    conversion.lines.map((line) => line.units),
    [10, 12, 0],
  );
  assert.equal(conversion.units, 22);
});

test("an unknown item kind is refused, and so is a quantity too large to sum", () => {
  const table = parseRateTable(JSON.stringify(exampleTable()));
  assert.throws(
    () => convertItems(table, [{ itemKind: "example.unknown", quantity: 1 }]),
    refused(422, "unknown_item_kind"),
  );
  assert.throws(
    () => convertItems(table, [{ itemKind: "example.batch.seconds", quantity: Number.MAX_SAFE_INTEGER }]),
    refused(400, "invalid_quantity"),
  );
});

test("an unparseable, placeholder or inconsistent table is unavailable and never free", () => {
  const broken = [
    "not json",
    "",
    '{"version":"unset"}',
    "[]",
    text((table) => (table.extra = 1)),
    text((table) => (table.version = "")),
    text((table) => (table.plans["example-basic"].weeklyAllowanceUnits = -1)),
    text((table) => (table.plans["example-basic"].weeklyAllowanceUnits = 1.5)),
    text((table) => (table.plans["Bad Plan"] = { weeklyAllowanceUnits: 1 })),
    text((table) => (table.rates["example.tokens"].per = 0)),
    text((table) => (table.rates["example.tokens"].units = "1")),
    text((table) => (table.rates["NoNamespace"] = { units: 1, per: 1 })),
    text((table) => (table.defaultPlan = "missing")),
    text(
      (table) => (table.plans["example-basic"] = { weeklyAllowanceUnits: 1, monthlyBudgetMicrodollars: 4 }),
    ),
    text((table) => (table.plans["example-basic"] = {})),
    text((table) => (table.plans["example-basic"] = { monthlyBudgetMicrodollars: -4 })),
    text((table) => (table.plans["example-basic"] = { monthlyBudgetMicrodollars: 4.5 })),
  ];
  for (const value of broken)
    assert.throws(() => parseRateTable(value), refused(503, "quota_unavailable"), value);
});

// features/quota-real-cost.feature: the weekly allowance is a quarter of the monthly budget, rounded down.
test("a monthly cost budget allows a quarter of itself each week, and weekly tables still parse", () => {
  const plans = (plan: Record<string, number>) =>
    parseRateTable(text((table) => (table.plans["example-basic"] = plan))).plans["example-basic"];
  assert.deepEqual(plans({ monthlyBudgetMicrodollars: 40_000_000 }), { weeklyAllowanceUnits: 10_000_000 });
  assert.deepEqual(plans({ monthlyBudgetMicrodollars: 10_000_001 }), { weeklyAllowanceUnits: 2_500_000 });
  assert.deepEqual(plans({ monthlyBudgetMicrodollars: 0 }), { weeklyAllowanceUnits: 0 });
  assert.deepEqual(plans({ weeklyAllowanceUnits: 7 }), { weeklyAllowanceUnits: 7 });
});

test("the Parameter Store source caches briefly, refreshes, and never caches a failure", async () => {
  let reads = 0,
    now = 0,
    value: string | undefined = JSON.stringify(exampleTable()),
    failing = false;
  const client = {
    send: async () => {
      reads++;
      if (failing) throw new Error("denied");
      return { Parameter: { Value: value } };
    },
  } as any;
  const source = new ParameterStoreRateTable(
    { version: "v1", parameterName: "/example/rates/v1" },
    client,
    1000,
    () => now,
  );
  await source.current();
  await source.current();
  assert.equal(reads, 1);
  now = 1001;
  value = text((table) => (table.version = "example-2"));
  assert.equal((await source.current()).version, "example-2");
  now = 5000;
  failing = true;
  await assert.rejects(source.current(), refused(503, "quota_unavailable"));
  failing = false;
  value = undefined;
  await assert.rejects(source.current(), refused(503, "quota_unavailable"));
  value = "just not a table";
  await assert.rejects(source.current(), refused(503, "quota_unavailable"));
  await assert.rejects(unconfiguredRateTable.current(), refused(503, "quota_unavailable"));
});

test("the table configuration is a reviewed v1 parameter name and nothing else", () => {
  assert.deepEqual(rateTableConfiguration({ version: "v1", parameterName: "/example/quota/rates/v1" }), {
    version: "v1",
    parameterName: "/example/quota/rates/v1",
  });
  for (const bad of [
    {},
    { version: "v2", parameterName: "/a/v1" },
    { version: "v1", parameterName: "/a/v2" },
    { version: "v1", parameterName: "/a/v1", extra: 1 },
  ])
    assert.throws(() => rateTableConfiguration(bad));
});

test("items from a caller are validated: shape, kind, whole non-negative quantities", () => {
  assert.deepEqual(parseItems([{ itemKind: "example.tokens", quantity: 5 }], 1), [
    { itemKind: "example.tokens", quantity: 5 },
  ]);
  assert.deepEqual(parseItems([], 0), []);
  assert.throws(() => parseItems([], 1), refused(400, "invalid_items"));
  assert.throws(() => parseItems("x", 0), refused(400, "invalid_items"));
  assert.throws(
    () => parseItems([{ itemKind: "example.tokens", quantity: 1, price: 3 }], 1),
    refused(400, "invalid_items"),
  );
  assert.throws(
    () => parseItems([{ itemKind: "Tokens", quantity: 1 }], 1),
    refused(400, "invalid_item_kind"),
  );
  for (const quantity of [-1, 1.5, "5", null, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(
      () => parseItems([{ itemKind: "example.tokens", quantity }], 1),
      refused(400, "invalid_quantity"),
    );
  assert.doesNotThrow(() => parseItems([{ itemKind: "aws.bedrock.tokens.example-model:0", quantity: 1 }], 1));
});
