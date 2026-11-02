import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { IdentityFileError } from "../accounts/identity-files";
import { QuotaError } from "./model";
import {
  NARRATOR,
  RENDERER,
  START,
  WEEK,
  batch,
  exampleTable,
  operator,
  quotaFixture,
  tokens,
} from "./testing/quota-fixture";

const refusedWith = (status: number, code: string) => (error: any) =>
  error instanceof QuotaError && error.status === status && error.code === code;
const journal = (files: { objects: Map<string, { value: any }> }) =>
  [...files.objects.entries()]
    .filter(([path]) => path.startsWith("journal/"))
    .map(([, object]) => object.value);
const week = (files: { objects: Map<string, { value: any }> }, accountId: string, index = 0) =>
  files.objects.get(`weeks/${accountId}/${index}.json`)?.value;

// With the made-up table: the default plan allows 1000 units a week, a batch second is 3 units, 10 tokens is 1 unit.

test("a reservation within this week's remaining quota succeeds and the account's percent reflects the hold", async () => {
  const { reserve, percent } = quotaFixture();
  const { result, replayed } = await reserve(batch(100)); // 300 units
  assert.equal(replayed, false);
  assert.equal(result.status, "reserved");
  assert.equal(await percent(), 30);
});

test("a reservation that does not fit is refused and nothing is written", async () => {
  const { files, reserve, percent } = quotaFixture();
  await reserve(batch(200)); // 600
  const commitsBefore = files.commits.length;
  await assert.rejects(reserve(batch(134)), refusedWith(402, "quota_insufficient")); // 402 > 400
  assert.equal(files.commits.length, commitsBefore);
  assert.equal(await percent(), 60);
  assert.equal((await reserve(batch(133))).result.status, "reserved"); // 399 fits
});

test("at 100% every new reservation is refused, even a free one, and check says no", async () => {
  const { quota, accountId, reserve, settle } = quotaFixture();
  const { result } = await reserve(batch(100));
  await settle(result.reservationId, batch(334)); // 1002 units: past the allowance
  assert.deepEqual((await quota.check(RENDERER, accountId)).result.allowed, false);
  await assert.rejects(reserve(tokens(1)), refusedWith(402, "quota_exhausted"));
  await assert.rejects(
    reserve([{ itemKind: "example.tokens", quantity: 0 }]),
    refusedWith(402, "quota_exhausted"),
  );
  assert.equal((await quota.check(RENDERER, accountId)).result.percentUsed, 100);
});

test("concurrent reservations cannot together exceed the allowance", async () => {
  const { quota, accountId, reserve } = quotaFixture();
  const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => reserve(batch(100)))); // 300 each
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 3);
  for (const outcome of outcomes)
    if (outcome.status === "rejected")
      assert.ok(["quota_insufficient", "busy"].includes(outcome.reason.code));
  assert.ok((await quota.check(RENDERER, accountId)).result.percentUsed <= 100);
});

test("a lost race is re-evaluated against what the winner held", async () => {
  const { files, reserve, percent } = quotaFixture();
  let raced = false;
  files.beforeCommit = async (path) => {
    if (raced || !path.startsWith("weeks/")) return;
    raced = true;
    await reserve(batch(200));
  };
  await assert.rejects(reserve(batch(200)), refusedWith(402, "quota_insufficient"));
  assert.equal(await percent(), 60);
});

test("repeating a reserve with the same operation ID returns the same result and holds quota once", async () => {
  const { quota, accountId, percent } = quotaFixture();
  const input = { operationId: randomUUID(), items: batch(100), expiresInSeconds: 600 };
  const first = await quota.reserve(RENDERER, accountId, input);
  const second = await quota.reserve(RENDERER, accountId, input);
  assert.deepEqual(second.result, first.result);
  assert.equal(second.replayed, true);
  assert.equal(await percent(), 30);
});

test("a retry gets the original answer even after the quota it would now need is gone", async () => {
  const { quota, accountId, reserve, settle } = quotaFixture();
  const input = { operationId: randomUUID(), items: batch(100), expiresInSeconds: 600 };
  const first = await quota.reserve(RENDERER, accountId, input);
  await settle(first.result.reservationId, batch(334));
  await assert.rejects(reserve(batch(100)), refusedWith(402, "quota_exhausted"));
  assert.deepEqual((await quota.reserve(RENDERER, accountId, input)).result, first.result);
});

test("the same operation ID with a different request, or from another product, is an idempotency conflict", async () => {
  const { quota, accountId } = quotaFixture();
  const operationId = randomUUID();
  await quota.reserve(RENDERER, accountId, { operationId, items: batch(10), expiresInSeconds: 600 });
  await assert.rejects(
    quota.reserve(RENDERER, accountId, { operationId, items: batch(20), expiresInSeconds: 600 }),
    refusedWith(409, "idempotency_conflict"),
  );
  await assert.rejects(
    quota.reserve(NARRATOR, accountId, { operationId, items: batch(10), expiresInSeconds: 600 }),
    refusedWith(409, "idempotency_conflict"),
  );
});

test("a crash after the week's write but before the journal is finished by the retry", async () => {
  const { files, quota, accountId, percent } = quotaFixture();
  const input = { operationId: randomUUID(), items: batch(10), expiresInSeconds: 600 };
  const real = files.commit.bind(files);
  files.commit = async (path, ...rest) => {
    if (path.startsWith("journal/")) throw new IdentityFileError("unavailable");
    return real(path, ...rest);
  };
  await assert.rejects(quota.reserve(RENDERER, accountId, input));
  files.commit = real;
  assert.equal((await quota.reserve(RENDERER, accountId, input)).replayed, true);
  assert.equal(await percent(), 3, "held once, not twice");
  assert.equal(journal(files).filter((event) => event.action === "reservation.reserved").length, 1);
});

test("settling charges the actual items, releases the rest, and a repeat charges nothing more", async () => {
  const { quota, accountId, reserve, percent } = quotaFixture();
  const { result } = await reserve(batch(100)); // holds 300
  const input = { operationId: randomUUID(), items: batch(40) }; // 120
  const first = await quota.settle(RENDERER, accountId, result.reservationId, input);
  assert.deepEqual(first.result, { reservationId: result.reservationId, accountId, status: "settled" });
  assert.equal(await percent(), 12);
  assert.deepEqual(
    (await quota.settle(RENDERER, accountId, result.reservationId, input)).result,
    first.result,
  );
  assert.equal(await percent(), 12);
  await assert.rejects(
    quota.settle(RENDERER, accountId, result.reservationId, { ...input, items: batch(41) }),
    refusedWith(409, "idempotency_conflict"),
  );
});

test("work that cost more than it reserved is recorded in full, never refused or capped, and the overshoot is kept", async () => {
  const { files, accountId, reserve, settle, quota } = quotaFixture();
  const { result } = await reserve(batch(100)); // 300
  await settle(result.reservationId, batch(500)); // 1500 units
  assert.equal(week(files, accountId).usedUnits, 1500);
  assert.equal(week(files, accountId).overshootUnits, 500);
  assert.equal((await quota.check(RENDERER, accountId)).result.percentUsed, 100, "the display caps at 100");
});

test("releasing returns everything and charges nothing; repeating it returns the same result", async () => {
  const { quota, accountId, reserve, percent } = quotaFixture();
  const { result } = await reserve(batch(100));
  const input = { operationId: randomUUID() };
  const first = await quota.release(RENDERER, accountId, result.reservationId, input);
  assert.deepEqual(first.result, { reservationId: result.reservationId, accountId, status: "released" });
  assert.deepEqual(
    (await quota.release(RENDERER, accountId, result.reservationId, input)).result,
    first.result,
  );
  assert.equal(await percent(), 0);
});

test("a closed reservation cannot be settled or released again under a new operation ID", async () => {
  const { quota, accountId, reserve, settle } = quotaFixture();
  const { result } = await reserve(batch(100));
  await settle(result.reservationId, batch(10));
  await assert.rejects(settle(result.reservationId, batch(10)), refusedWith(409, "reservation_not_open"));
  await assert.rejects(
    quota.release(RENDERER, accountId, result.reservationId, { operationId: randomUUID() }),
    refusedWith(409, "reservation_not_open"),
  );
});

test("another product cannot settle or release the reservation", async () => {
  const { quota, accountId, reserve, settle, percent } = quotaFixture();
  const { result } = await reserve(batch(100));
  await assert.rejects(settle(result.reservationId, batch(1), NARRATOR), refusedWith(403, "wrong_product"));
  await assert.rejects(
    quota.release(NARRATOR, accountId, result.reservationId, { operationId: randomUUID() }),
    refusedWith(403, "wrong_product"),
  );
  assert.equal(await percent(), 30);
});

test("an abandoned reservation stops holding quota when it expires, and a late settle still records the real use", async () => {
  const { clock, reserve, settle, percent } = quotaFixture();
  const { result } = await reserve(batch(333), { expiresInSeconds: 600 }); // 999 units
  await assert.rejects(reserve(batch(10)), refusedWith(402, "quota_insufficient"));
  clock.ms = START + 599_999;
  assert.equal(await percent(), 99);
  clock.ms = START + 600_000;
  assert.equal(await percent(), 0, "the hold no longer counts");
  assert.equal((await reserve(batch(100))).result.status, "reserved");
  await settle(result.reservationId, batch(50)); // the abandoned job reports what it really used
  assert.equal(await percent(), 15 + 30);
});

test("the week resets by time alone: a new week starts at zero, last week's record stays, unused quota does not carry over", async () => {
  const { files, quota, accountId, clock, reserve, settle } = quotaFixture();
  const { result } = await reserve(batch(100));
  await settle(result.reservationId, batch(100)); // 300 used in week 0
  const resetsAt = (await quota.check(RENDERER, accountId)).result.resetsAt;
  assert.equal(Date.parse(resetsAt as string), Date.parse(week(files, accountId).endsAt));
  clock.ms = Date.parse(resetsAt as string) - 1;
  assert.equal((await quota.check(RENDERER, accountId)).result.percentUsed, 30);
  clock.ms = Date.parse(resetsAt as string);
  const next = (await quota.check(RENDERER, accountId)).result;
  assert.equal(next.percentUsed, 0);
  assert.equal(Date.parse(next.resetsAt as string), Date.parse(resetsAt as string) + WEEK);
  await quota.record(RENDERER, accountId, { operationId: randomUUID(), items: tokens(1000) });
  assert.equal(week(files, accountId, 0).usedUnits, 300, "last week is kept and untouched");
  assert.equal(week(files, accountId, 1).usedUnits, 100);
  // A full allowance is available again: the unused 700 of week 0 did not carry over, and the cap is still 1000.
  assert.equal((await reserve(batch(300))).result.status, "reserved");
  await assert.rejects(reserve(batch(1)), refusedWith(402, "quota_exhausted"));
});

test("the weekly cycle is seven fixed UTC days from the account's creation", async () => {
  const created = Date.parse("2030-01-01T10:00:00.000Z");
  const { quota, accountId, clock } = quotaFixture({ created });
  clock.ms = created + 3 * WEEK + 5;
  const { resetsAt } = (await quota.check(RENDERER, accountId)).result;
  assert.equal(resetsAt, new Date(created + 4 * WEEK).toISOString());
});

test("a hold counts against the week it was taken until it ends; a charge counts in the week it settles", async () => {
  const { files, quota, accountId, clock, reserve, settle, percent } = quotaFixture({
    quota: { maximumHoldSeconds: WEEK / 1000 },
  });
  const endOfWeek = Date.parse(week(files, accountId)?.endsAt ?? new Date(START).toISOString());
  const { result } = await reserve(batch(200), { expiresInSeconds: WEEK / 1000 }); // 600 held in week 0
  const reservationId = result.reservationId as string;
  const weekEnd = Date.parse(week(files, accountId, 0).endsAt);
  assert.ok(weekEnd > endOfWeek - 1);
  clock.ms = weekEnd - 1;
  assert.equal(await percent(), 60, "still held in its own week");
  clock.ms = weekEnd + 1000;
  assert.equal(await percent(), 0, "it does not count against the new week");
  await settle(reservationId, batch(100)); // 300 units, charged to the week that settles
  assert.equal(week(files, accountId, 1).usedUnits, 300);
  assert.equal(week(files, accountId, 0).usedUnits, 0, "last week is not rewritten");
  assert.equal(await percent(), 30);
  await assert.rejects(settle(reservationId, batch(100)), refusedWith(409, "reservation_not_open"));
  await assert.rejects(
    quota.release(RENDERER, accountId, reservationId, { operationId: randomUUID() }),
    refusedWith(409, "reservation_not_open"),
  );
  assert.equal(await percent(), 30, "closed once, charged once");
});

test("releasing a reservation from last week closes it without a charge", async () => {
  const { files, quota, accountId, clock, reserve, percent } = quotaFixture({
    quota: { maximumHoldSeconds: WEEK / 1000 },
  });
  const { result } = await reserve(batch(100), { expiresInSeconds: WEEK / 1000 });
  clock.ms = Date.parse(week(files, accountId, 0).endsAt) + 1000;
  const released = await quota.release(RENDERER, accountId, result.reservationId, {
    operationId: randomUUID(),
  });
  assert.equal(released.result.status, "released");
  assert.equal(await percent(), 0);
  await assert.rejects(
    quota.settle(RENDERER, accountId, result.reservationId, { operationId: randomUUID(), items: batch(1) }),
    refusedWith(409, "reservation_not_open"),
  );
});

test("an unknown item kind is refused for reserve, settle and record, charges nothing, and is recorded for operators", async () => {
  const { files, quota, accountId, reserve, percent } = quotaFixture();
  const unknown = [{ itemKind: "example.mystery", quantity: 5 }];
  const { result } = await reserve(batch(10));
  await assert.rejects(reserve(unknown), refusedWith(422, "unknown_item_kind"));
  await assert.rejects(
    quota.settle(RENDERER, accountId, result.reservationId, {
      operationId: randomUUID(),
      items: [...batch(1), ...unknown],
    }),
    refusedWith(422, "unknown_item_kind"),
  );
  await assert.rejects(
    quota.record(RENDERER, accountId, { operationId: randomUUID(), items: unknown }),
    refusedWith(422, "unknown_item_kind"),
  );
  assert.equal(await percent(), 3, "nothing was charged or released");
  const refusals = journal(files).filter((event) => event.action === "usage.refused");
  assert.equal(refusals.length, 3);
  assert.deepEqual(refusals[0].detail.itemKinds, ["example.mystery"]);
});

test("an unreadable, unparseable or placeholder rate table refuses everything and never makes usage free", async () => {
  const { files, quota, accountId, table, reserve, settle } = quotaFixture();
  const { result } = await reserve(batch(10));
  const commits = files.commits.length;
  for (const make of [
    () => {
      table.broken = true;
    },
    () => {
      table.broken = false;
      table.table = "not a table";
    },
    () => {
      table.table = '{"version":"unset"}';
    },
  ]) {
    make();
    await assert.rejects(reserve(batch(1)), refusedWith(503, "quota_unavailable"));
    await assert.rejects(settle(result.reservationId, batch(1)), refusedWith(503, "quota_unavailable"));
    await assert.rejects(
      quota.record(RENDERER, accountId, { operationId: randomUUID(), items: tokens(10) }),
      refusedWith(503, "quota_unavailable"),
    );
    await assert.rejects(quota.check(RENDERER, accountId), refusedWith(503, "quota_unavailable"));
    assert.deepEqual(await quota.operatorView(accountId), { state: "unavailable" });
    assert.deepEqual(await quota.customerView(accountId), { state: "unavailable" });
  }
  assert.equal(files.commits.length, commits, "nothing was written while the table was unusable");
});

test("each charge records its table version, and a rate change never rewrites what was charged", async () => {
  const { files, quota, accountId, table, reserve, settle } = quotaFixture();
  const held = await reserve(batch(100)); // priced at version 1: 300 units
  await quota.record(RENDERER, accountId, { operationId: randomUUID(), items: batch(10) }); // 30 units
  const second = exampleTable();
  second.version = "example-2";
  second.rates["example.batch.seconds"] = { units: 6, per: 1 };
  table.table = second;
  await quota.record(RENDERER, accountId, { operationId: randomUUID(), items: batch(10) }); // 60 units
  await settle(held.result.reservationId, batch(10)); // priced when it settles: 60 units
  const current = week(files, accountId);
  assert.deepEqual(current.usedByTableVersion, { "example-1": 30, "example-2": 120 });
  assert.equal(current.usedUnits, 150);
  const charges = journal(files).filter((event) => event.detail?.tableVersion);
  assert.deepEqual(
    charges.map((event) => [event.action, event.detail.tableVersion, event.detail.units]).sort(),
    [
      ["reservation.reserved", "example-1", 300],
      ["reservation.settled", "example-2", 60],
      ["usage.recorded", "example-1", 30],
      ["usage.recorded", "example-2", 60],
    ],
  );
  assert.deepEqual(
    (await quota.operatorView(accountId)).state === "set" &&
      ((await quota.operatorView(accountId)) as any).tableVersions,
    ["example-1", "example-2"],
  );
});

test("pay after: record charges a batch once, a retry changes nothing, and overshoot past 100% is kept while the display caps", async () => {
  const { files, quota, accountId } = quotaFixture();
  const input = { operationId: randomUUID(), items: [...tokens(8000), ...batch(100)] }; // 800 + 300
  const first = await quota.record(RENDERER, accountId, input);
  assert.deepEqual(first.result, { accountId, status: "recorded" });
  assert.equal((await quota.record(RENDERER, accountId, input)).replayed, true);
  assert.equal(week(files, accountId).usedUnits, 1100, "recorded once");
  assert.equal(week(files, accountId).overshootUnits, 100);
  const check = (await quota.check(RENDERER, accountId)).result;
  assert.deepEqual([check.allowed, check.percentUsed], [false, 100]);
  await assert.rejects(
    quota.reserve(RENDERER, accountId, { operationId: randomUUID(), items: tokens(1), expiresInSeconds: 60 }),
    refusedWith(402, "quota_exhausted"),
  );
  await assert.rejects(
    quota.record(RENDERER, accountId, { ...input, items: tokens(1) }),
    refusedWith(409, "idempotency_conflict"),
  );
});

test("check is a read: it writes nothing, answers allowed below 100% and needs an entitled product and an allowance", async () => {
  const { files, quota, accountId, entitlements, table } = quotaFixture();
  const commits = files.commits.length;
  assert.deepEqual((await quota.check(RENDERER, accountId)).result.allowed, true);
  assert.equal(files.commits.length, commits);
  entitlements[accountId]["example-renderer"].status = "disabled";
  await assert.rejects(quota.check(RENDERER, accountId), refusedWith(403, "product_not_entitled"));
  entitlements[accountId]["example-renderer"].status = "active";
  const bare = exampleTable();
  delete bare.defaultPlan;
  table.table = bare;
  await assert.rejects(quota.check(RENDERER, accountId), refusedWith(403, "no_allowance"));
  await assert.rejects(
    quota.reserve(RENDERER, accountId, { operationId: randomUUID(), items: tokens(1), expiresInSeconds: 60 }),
    refusedWith(403, "no_allowance"),
  );
});

test("high volume does not grow the week's document: usage is aggregated and every call is a journal file", async () => {
  const { files, quota, accountId } = quotaFixture();
  await quota.setAllowance(operator("ada"), accountId, {
    operationId: randomUUID(),
    allowanceOverrideUnits: 1_000_000_000,
  });
  const sizes: number[] = [];
  for (let index = 0; index < 400; index++) {
    await quota.record(index % 2 ? RENDERER : NARRATOR, accountId, {
      operationId: randomUUID(),
      items: [...tokens(1000 + index), ...batch(1)],
    });
    if (index === 99 || index === 399) sizes.push(Buffer.byteLength(JSON.stringify(week(files, accountId))));
  }
  assert.ok(
    sizes[1] < sizes[0] * 1.1 && sizes[1] < 20000,
    `the document stopped growing: ${sizes.join(" then ")} bytes`,
  );
  assert.deepEqual(Object.keys(week(files, accountId).usedByKind).sort(), [
    "example.batch.seconds",
    "example.tokens",
  ]);
  assert.equal(week(files, accountId).audit.length, 32, "the audit is bounded");
  assert.equal(journal(files).filter((event) => event.action === "usage.recorded").length, 400);
});

test("a customer's view has one percentage, the reset time and each app's share, with no units, rates or money", async () => {
  const { quota, accountId, reserve, settle } = quotaFixture();
  const a = await reserve(batch(100)); // 300 held by the renderer
  await settle(a.result.reservationId, batch(50)); // 150 used
  await quota.record(NARRATOR, accountId, { operationId: randomUUID(), items: batch(100) }); // 300 used
  const customer = await quota.customerView(accountId);
  assert.deepEqual(Object.keys(customer).sort(), ["byProduct", "percentUsed", "resetsAt", "state"]);
  assert.equal(customer.state === "set" && customer.percentUsed, 45);
  assert.deepEqual(customer.state === "set" && customer.byProduct, [
    { product: "example-narrator", percentOfQuota: 30 },
    { product: "example-renderer", percentOfQuota: 15 },
  ]);
  const text = JSON.stringify(customer);
  for (const word of [
    "Units",
    "units",
    "Cents",
    "cents",
    "rate",
    "plan",
    "dollar",
    "tableVersion",
    "allowance",
  ])
    assert.ok(!text.includes(word), `the customer view mentions ${word}`);
});

test("staff also see internal units and the plan, but never the rate table", async () => {
  const { quota, accountId, reserve } = quotaFixture();
  await reserve(batch(100));
  const view: any = await quota.operatorView(accountId);
  assert.deepEqual([view.allowanceUnits, view.heldUnits, view.usedUnits, view.planId], [1000, 300, 0, null]);
  const text = JSON.stringify(view);
  assert.ok(!text.includes("example.batch.seconds") && !text.includes("rates"));
});

test("every result a product receives is free of units, rates and money", async () => {
  const { quota, accountId, reserve, settle } = quotaFixture();
  const reserved = await reserve(batch(10));
  const settled = await settle(reserved.result.reservationId, batch(5));
  const recorded = await quota.record(RENDERER, accountId, { operationId: randomUUID(), items: tokens(10) });
  const checked = await quota.check(RENDERER, accountId);
  assert.deepEqual(Object.keys(reserved.result).sort(), [
    "accountId",
    "expiresAt",
    "reservationId",
    "status",
  ]);
  assert.deepEqual(Object.keys(settled.result).sort(), ["accountId", "reservationId", "status"]);
  assert.deepEqual(Object.keys(recorded.result).sort(), ["accountId", "status"]);
  assert.deepEqual(Object.keys(checked.result).sort(), ["allowed", "percentUsed", "resetsAt"]);
});

test("an operator picks a plan or a per-account override; the override wins and either can be cleared", async () => {
  const { quota, accountId, setAllowance, reserve, ada } = quotaFixture();
  assert.equal(((await quota.operatorView(accountId)) as any).allowanceUnits, 1000, "the default plan");
  await setAllowance({ plan: "example-large" });
  assert.equal(((await quota.operatorView(accountId)) as any).allowanceUnits, 5000);
  await setAllowance({ allowanceOverrideUnits: 90 });
  const view: any = await quota.operatorView(accountId);
  assert.deepEqual(
    [view.allowanceUnits, view.planId, view.allowanceOverrideUnits],
    [90, "example-large", 90],
  );
  await assert.rejects(reserve(batch(31)), refusedWith(402, "quota_insufficient")); // 93 > 90
  await setAllowance({ allowanceOverrideUnits: null, plan: null });
  assert.equal(((await quota.operatorView(accountId)) as any).allowanceUnits, 1000);
  const operationId = randomUUID(),
    input = { operationId, plan: "example-large" };
  const first = await quota.setAllowance(ada, accountId, input);
  assert.deepEqual((await quota.setAllowance(ada, accountId, input)).result, first.result);
  await assert.rejects(
    quota.setAllowance(ada, accountId, { operationId, plan: "example-basic" }),
    refusedWith(409, "idempotency_conflict"),
  );
});

test("only the reviewed quota permission may set an allowance, and the input is validated", async () => {
  const { quota, accountId } = quotaFixture();
  for (const subject of ["reader", "entitler", "nobody"])
    await assert.rejects(
      quota.setAllowance(operator(subject), accountId, { operationId: randomUUID(), plan: "example-large" }),
      refusedWith(403, "operator_forbidden"),
    );
  const ada = operator("ada");
  const bad = (input: object, code: string, status = 400) =>
    assert.rejects(
      quota.setAllowance(ada, accountId, { operationId: randomUUID(), ...input }),
      refusedWith(status, code),
    );
  await bad({}, "invalid_settings");
  await bad({ plan: "example-missing" }, "unknown_plan");
  await bad({ plan: "Bad Plan" }, "invalid_plan");
  await bad({ allowanceOverrideUnits: -1 }, "invalid_amount");
  await bad({ allowanceOverrideUnits: 1.5 }, "invalid_amount");
  await assert.rejects(
    quota.setAllowance(ada, randomUUID(), { operationId: randomUUID(), plan: "example-large" }),
    refusedWith(404, "account_missing"),
  );
});

test("an unknown account, no allowance, an unentitled product and bad input are all refused", async () => {
  const { reserve, table, entitlements, accountId } = quotaFixture();
  await assert.rejects(reserve(batch(1), {}, RENDERER, randomUUID()), refusedWith(404, "account_missing"));
  await assert.rejects(
    reserve(batch(1), {}, { product: "example-other" }),
    refusedWith(403, "product_not_entitled"),
  );
  entitlements[accountId]["example-renderer"].status = "disabled";
  await assert.rejects(reserve(batch(1)), refusedWith(403, "product_not_entitled"));
  entitlements[accountId]["example-renderer"].status = "active";
  for (const items of [
    [],
    "x",
    [{ itemKind: "example.tokens", quantity: -1 }],
    [{ itemKind: "example.tokens" }],
  ])
    await assert.rejects(
      reserve(items as any),
      (error: any) => error instanceof QuotaError && error.status === 400,
    );
  for (const expiresInSeconds of [0, 1.5, "60", 25 * 3600])
    await assert.rejects(reserve(batch(1), { expiresInSeconds }), refusedWith(400, "invalid_expiry"));
  void table;
});

test("an unavailable store means refusal: no read or write failure ever looks like success", async () => {
  const { files, quota, accountId, reserve, settle } = quotaFixture();
  const { result } = await reserve(batch(10));
  const realGet = files.get.bind(files),
    realCommit = files.commit.bind(files);
  files.get = async () => {
    throw new IdentityFileError("unavailable");
  };
  await assert.rejects(reserve(batch(1)), (error: any) => !(error instanceof QuotaError));
  await assert.rejects(settle(result.reservationId, batch(1)));
  await assert.rejects(quota.check(RENDERER, accountId));
  assert.deepEqual(await quota.customerView(accountId), { state: "unavailable" });
  files.get = realGet;
  files.commit = async () => {
    throw new IdentityFileError("unavailable");
  };
  await assert.rejects(reserve(batch(1)));
  files.commit = realCommit;
  assert.equal(await quota.check(RENDERER, accountId).then((checked) => checked.result.percentUsed), 3);
});

test("a full record of active reservations refuses a new one, and expired holds are dropped only to make room", async () => {
  const { files, quota, accountId, clock, reserve, setAllowance } = quotaFixture();
  await setAllowance({ allowanceOverrideUnits: 1_000_000_000 });
  const first = await reserve(tokens(10), { expiresInSeconds: 60 });
  await assert.rejects(
    (async () => {
      for (;;) await reserve(tokens(10), { expiresInSeconds: 60 });
    })(),
    refusedWith(409, "quota_capacity"),
  );
  clock.ms += 120_000;
  const active = await reserve(tokens(10), { expiresInSeconds: 3600 });
  assert.ok(journal(files).some((event) => event.action === "reservation.expired"));
  await assert.rejects(
    quota.settle(RENDERER, accountId, first.result.reservationId, { operationId: randomUUID(), items: [] }),
    refusedWith(409, "reservation_not_open"),
  );
  assert.equal(
    (await quota.release(RENDERER, accountId, active.result.reservationId, { operationId: randomUUID() }))
      .result.status,
    "released",
  );
});

test("every mutation writes one journal event and a refusal writes none, apart from the unknown-item note", async () => {
  const { files, accountId, quota, reserve, settle } = quotaFixture();
  const { result } = await reserve(batch(10));
  await assert.rejects(reserve(batch(10_000)));
  await settle(result.reservationId, batch(5));
  await quota.record(RENDERER, accountId, { operationId: randomUUID(), items: tokens(10) });
  assert.deepEqual(
    journal(files)
      .map((event) => event.action)
      .sort(),
    ["reservation.reserved", "reservation.settled", "usage.recorded"],
  );
});

test("quota files are kept apart: settings, weeks and journal only", async () => {
  const { files, setAllowance, reserve } = quotaFixture();
  await setAllowance({ plan: "example-large" });
  await reserve(batch(1));
  for (const path of files.objects.keys()) assert.match(path, /^(settings|weeks|journal)\//);
});
