import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aging,
  attention,
  billingFollowUps,
  daysPastDue,
  existingForPeriod,
  isPastDue,
  ledgerRows,
  oldestFirst,
  owedBy,
  totals,
} from "../src/billing/derive";
import { syntheticBilling } from "../src/billing/synthetic";
import type { Invoice } from "../src/billing/types";

const TODAY = "2026-11-05";
const fixture = () => syntheticBilling({ today: TODAY });

const invoice = (over: Partial<Invoice>): Invoice => ({
  id: "i",
  accountId: "a",
  number: "202610-001",
  currency: "usd",
  lineItems: [],
  subtotalCents: 1000,
  totalCents: 1000,
  issuedVia: "manual",
  issuedAt: "2026-10-01",
  dueAt: "2026-10-31",
  netTermsDays: 30,
  status: "issued",
  creditsCents: 0,
  balanceCents: 1000,
  revision: 1,
  ...over,
});

test("past due is derived from the due date and the balance", () => {
  assert.equal(daysPastDue(invoice({}), TODAY), 5);
  assert.equal(isPastDue(invoice({}), "2026-10-31"), false, "due today is not late");
  assert.equal(isPastDue(invoice({}), "2026-11-01"), true);
  for (const closed of [
    invoice({ balanceCents: 0, status: "paid" }),
    invoice({ status: "void", balanceCents: 0 }),
    invoice({ status: "uncollectible" }),
    invoice({ status: "draft", dueAt: null }),
  ])
    assert.equal(isPastDue(closed, TODAY), false, closed.status);
  assert.equal(isPastDue(invoice({ status: "partially_paid", balanceCents: 400 }), TODAY), true);
});

test("the fixture totals match the reviewed designs on Nov 5, 2026", async () => {
  const { invoices, payments, accounts } = await fixture().overview();
  const sum = totals(invoices, payments, TODAY);
  assert.equal(sum.outstandingCents, 1990000);
  assert.equal(sum.pastDueCents, 640000);
  assert.equal(sum.pastDueCount, 2);
  assert.equal(sum.pastDueAccounts, 2);
  assert.equal(sum.unappliedCents, 150000);
  assert.deepEqual(aging(invoices, TODAY), {
    notDueCents: 1350000,
    late1to30Cents: 640000,
    late31to60Cents: 0,
    lateOver60Cents: 0,
  });
  const items = attention(accounts, invoices, payments, TODAY);
  assert.deepEqual(
    items.map((item) => item.kind),
    ["Past due", "Past due", "To allocate"],
  );
  const harbor = accounts.find((account) => account.name === "Harbor Lantern Media")!;
  const owed = owedBy(harbor.id, invoices, payments, TODAY);
  assert.equal(owed.owedCents, 1050000);
  assert.equal(owed.pastDueCents, 400000);
  assert.equal(owed.unappliedCents, 150000);
  assert.equal(billingFollowUps(accounts, invoices, payments, TODAY).length, 3);
});

test("a reversed payment leaves the invoice at its earlier balance and shows in the ledger", async () => {
  const client = fixture();
  const { invoice: late, journal, payments } = await client.invoice("202610-003");
  assert.equal(late.balanceCents, 400000);
  const rows = ledgerRows(late, journal, payments);
  assert.deepEqual(
    rows.map((row) => row.balanceCents),
    [650000, 600000, 650000, 400000],
  );
  assert.match(rows[2].what, /reversed/);
});

test("a second invoice for the same period is found, and a void one is not", async () => {
  const { invoices, accounts } = await fixture().overview();
  const harbor = accounts[0].id;
  assert.equal(existingForPeriod(harbor, "2026-11", invoices)?.number, "202611-002");
  assert.equal(existingForPeriod(harbor, "2026-12", invoices), undefined);
  const nimbus = accounts[3].id;
  assert.equal(existingForPeriod(nimbus, "2026-10", invoices), undefined, "the October invoice is void");
});

test("oldest first fills the earliest due date up to each balance", () => {
  const first = invoice({ id: "a", dueAt: "2026-10-31", balanceCents: 400000 });
  const second = invoice({ id: "b", dueAt: "2026-12-02", balanceCents: 650000 });
  assert.deepEqual(
    [...oldestFirst(500000, [second, first])],
    [
      ["a", 400000],
      ["b", 100000],
    ],
  );
  assert.deepEqual([...oldestFirst(300000, [second, first])], [["a", 300000]]);
});
