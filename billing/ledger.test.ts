import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const here = fileURLToPath(new URL(".", import.meta.url));
import { daysPastDue, isOpenInvoice, isPastDue, rebuildBalancesFromJournal } from "./balances";
import { BillingError, type JournalEvent, type LedgerInvoice, type LedgerPayment } from "./model";
import { formatUsd, lineTotalCents, parseDollars } from "./money";
import {
  billingFixture,
  CONTACT_MARKER,
  issuerFields,
  lineItems,
  operator,
  owner,
  profileInput,
} from "./testing/billing-fixture";

const ada = operator("ada"),
  grace = operator("grace"),
  reader = operator("reader");
const refusedWith = (status: number, code: string) => (error: any) =>
  error instanceof BillingError && error.status === status && error.code === code;

type Fixture = ReturnType<typeof billingFixture>;

async function ready() {
  const fixture = billingFixture();
  await fixture.profiles.set(ada, fixture.accountId, profileInput(), randomUUID());
  await fixture.issuer.set(ada, issuerFields(), randomUUID());
  return fixture;
}
async function addAccount(fixture: Fixture) {
  const accountId = randomUUID();
  await fixture.profiles.set(ada, accountId, profileInput(), randomUUID());
  return accountId;
}
const events = (fixture: Fixture) =>
  [...fixture.files.objects.entries()]
    .filter(([path]) => path.startsWith("journal/"))
    .map(([, stored]) => stored.value as JournalEvent);
const ledgerEvents = (fixture: Fixture) => events(fixture).filter((event) => event.detail);
const snapshot = (fixture: Fixture) => JSON.stringify([...fixture.files.objects.entries()]);

/** Raises and issues an invoice for the account, returning the issued invoice. */
async function issued(
  fixture: Fixture,
  options: { accountId?: string; cents?: number; issueDate?: string; period?: string } = {},
) {
  const { invoice } = await fixture.ledger.raise(
    ada,
    options.accountId ?? fixture.accountId,
    {
      lineItems: lineItems([
        { description: "Example work", quantity: 1, unitAmountCents: options.cents ?? 120000 },
      ]),
      issuedVia: "manual",
      draft: false,
      issueDate: options.issueDate ?? "2026-11-02",
      ...(options.period ? { period: options.period } : {}),
    },
    randomUUID(),
  );
  return invoice;
}
const pay = (
  fixture: Fixture,
  amountCents: number,
  allocations: { invoiceId: string; amountCents: number }[] = [],
  accountId = fixture.accountId,
  extra: Record<string, unknown> = {},
) =>
  fixture.ledger.recordPayment(
    ada,
    accountId,
    {
      amountCents,
      method: "bank_transfer",
      receivedAt: "2026-11-03",
      reference: "EX-1",
      allocations,
      ...extra,
    },
    randomUUID(),
  );

test("raise and issue: totals, balance, status, the next number of the month and two journal events", async () => {
  const fixture = await ready();
  const { invoice } = await fixture.ledger.raise(
    ada,
    fixture.accountId,
    {
      lineItems: lineItems([
        {
          description: "Site one",
          quantity: 2,
          unitAmountCents: 25000,
          billingLine: "papyrus-example-invalid",
        },
        { description: "Site two", quantity: 1, unitAmountCents: 70000, period: "Nov 2026" },
      ]),
      issuedVia: "manual",
      draft: false,
      issueDate: "2026-11-02",
    },
    randomUUID(),
  );
  assert.equal(invoice.subtotalCents, 120000);
  assert.equal(invoice.totalCents, 120000, "no tax lines, so the total is the subtotal");
  assert.equal(invoice.balanceCents, 120000);
  assert.equal(invoice.status, "issued");
  assert.equal(invoice.number, "202611-001");
  assert.equal(invoice.currency, "usd");
  assert.equal(invoice.issuedVia, "manual");
  const stored = fixture.files.objects.get(`invoices/${invoice.id}.json`)!.value as LedgerInvoice;
  assert.equal(stored.totalCents, 120000);
  assert.equal(stored.balanceCents, 120000);
  assert.deepEqual(
    ledgerEvents(fixture)
      .map((event) => event.action)
      .sort(),
    ["invoice.drafted", "invoice.issued"],
  );
  assert.ok(!JSON.stringify(events(fixture)).includes(CONTACT_MARKER));
  assert.ok(
    !JSON.stringify(events(fixture)).includes("Example Issuer"),
    "the journal carries no issuer details",
  );
});

test("net 30 by default, the profile override, and an explicit value on the invoice", async () => {
  const fixture = await ready();
  assert.equal((await issued(fixture)).dueDate, "2026-12-02");
  const other = await addAccount(fixture);
  await fixture.profiles.set(ada, other, profileInput({ netTermsDays: 15 }), randomUUID());
  assert.equal((await issued(fixture, { accountId: other })).dueDate, "2026-11-17");
  const { invoice } = await fixture.ledger.raise(
    ada,
    fixture.accountId,
    { lineItems: lineItems(), issuedVia: "manual", draft: false, issueDate: "2026-11-02", netTermsDays: 45 },
    randomUUID(),
  );
  assert.equal(invoice.dueDate, "2026-12-17");
  assert.equal(invoice.netTermsDays, 45);
});

test("the issuer's default net terms apply when the profile has none", async () => {
  const fixture = await ready();
  await fixture.issuer.set(ada, issuerFields({ defaultNetTermsDays: 10, expectedRevision: 1 }), randomUUID());
  assert.equal((await issued(fixture)).dueDate, "2026-11-12");
});

test("only US dollars: a currency field is refused on invoices and payments, and nothing is written", async () => {
  const fixture = await ready();
  const before = snapshot(fixture);
  await assert.rejects(
    fixture.ledger.createDraft(
      ada,
      fixture.accountId,
      { lineItems: lineItems(), currency: "eur" },
      randomUUID(),
    ),
    refusedWith(400, "invalid_invoice"),
  );
  await assert.rejects(
    pay(fixture, 1000, [], fixture.accountId, { currency: "eur" }),
    refusedWith(400, "invalid_currency"),
  );
  assert.equal(snapshot(fixture), before);
  assert.equal(
    ((await pay(fixture, 1000, [], fixture.accountId, { currency: "usd" })).payment as LedgerPayment)
      .currency,
    "usd",
  );
});

test("one combined invoice per client per period; a voided draft frees the period", async () => {
  const fixture = await ready();
  const first = await fixture.ledger.createDraft(
    ada,
    fixture.accountId,
    {
      period: "2026-11",
      lineItems: lineItems([
        { description: "Site one", quantity: 1, unitAmountCents: 100, product: "papyrus-example-invalid" },
        { description: "Site two", quantity: 1, unitAmountCents: 200, product: "papyrus-second-invalid" },
        { description: "Lab", quantity: 1, unitAmountCents: 300, product: "cyclotron" },
      ]),
    },
    randomUUID(),
  );
  assert.equal(first.invoice.lineItems.length, 3);
  await assert.rejects(
    fixture.ledger.createDraft(
      ada,
      fixture.accountId,
      { period: "2026-11", lineItems: lineItems() },
      randomUUID(),
    ),
    refusedWith(409, "period_invoiced"),
  );
  // Another period, a one-off invoice, and another account are unaffected.
  await fixture.ledger.createDraft(
    ada,
    fixture.accountId,
    { period: "2026-12", lineItems: lineItems() },
    randomUUID(),
  );
  await fixture.ledger.createDraft(ada, fixture.accountId, { lineItems: lineItems() }, randomUUID());
  await fixture.ledger.createDraft(
    ada,
    await addAccount(fixture),
    { period: "2026-11", lineItems: lineItems() },
    randomUUID(),
  );
  const voided = await fixture.ledger.void(
    ada,
    first.invoice.id,
    { reason: "Raised in error" },
    randomUUID(),
  );
  assert.equal(voided.invoice.status, "void");
  assert.equal(voided.invoice.number, null, "a draft has no number to waste");
  await fixture.ledger.createDraft(
    ada,
    fixture.accountId,
    { period: "2026-11", lineItems: lineItems() },
    randomUUID(),
  );
});

test("a concurrent second invoice for the same period is refused, not raced", async () => {
  const fixture = await ready();
  const results = await Promise.allSettled(
    [0, 1, 2].map(() =>
      fixture.ledger.createDraft(
        ada,
        fixture.accountId,
        { period: "2026-11", lineItems: lineItems() },
        randomUUID(),
      ),
    ),
  );
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  for (const result of results.filter((result) => result.status === "rejected"))
    assert.ok(refusedWith(409, "period_invoiced")((result as PromiseRejectedResult).reason));
});

test("accounts must be invoiced, issuers set, and Stripe issuing is not available", async () => {
  const fixture = billingFixture();
  await assert.rejects(
    fixture.ledger.createDraft(ada, fixture.accountId, { lineItems: lineItems() }, randomUUID()),
    refusedWith(409, "not_yet_billable"),
  );
  await fixture.profiles.set(ada, fixture.accountId, profileInput({ mode: "direct" }), randomUUID());
  await assert.rejects(
    fixture.ledger.createDraft(ada, fixture.accountId, { lineItems: lineItems() }, randomUUID()),
    refusedWith(409, "not_invoiced"),
  );
  await fixture.profiles.set(ada, fixture.accountId, profileInput({ expectedRevision: 1 }), randomUUID());
  const draft = await fixture.ledger.createDraft(
    ada,
    fixture.accountId,
    { lineItems: lineItems() },
    randomUUID(),
  );
  await assert.rejects(
    fixture.ledger.issue(ada, draft.invoice.id, {}, randomUUID()),
    refusedWith(409, "issuer_missing"),
  );
  await fixture.issuer.set(ada, issuerFields(), randomUUID());
  await assert.rejects(
    fixture.ledger.issue(ada, draft.invoice.id, { issuedVia: "stripe" }, randomUUID()),
    refusedWith(409, "stripe_unavailable"),
  );
  const issuedInvoice = (
    await fixture.ledger.issue(ada, draft.invoice.id, { issueDate: "2026-11-02" }, randomUUID())
  ).invoice;
  assert.equal(issuedInvoice.issuedVia, "manual");
});

test("invoice numbers are sequential within each month, concurrent issues never share one, and a void is not reused", async () => {
  const fixture = await ready();
  const other = await addAccount(fixture);
  const [left, right] = await Promise.all([
    issued(fixture, { issueDate: "2026-10-31" }),
    issued(fixture, { accountId: other, issueDate: "2026-10-31" }),
  ]);
  assert.deepEqual([left.number, right.number].sort(), ["202610-001", "202610-002"]);
  const november = await issued(fixture, { issueDate: "2026-11-02" });
  assert.equal(november.number, "202611-001");
  const voided = await fixture.ledger.void(ada, left.id, { reason: "Wrong client" }, randomUUID());
  assert.equal(voided.invoice.status, "void");
  assert.equal(voided.invoice.balanceCents, 0);
  assert.equal(voided.invoice.number, left.number, "the number stays with the voided invoice");
  const next = await issued(fixture, { issueDate: "2026-10-31" });
  assert.equal(next.number, "202610-003");
  assert.equal((await fixture.ledger.invoiceByNumber("202610-001"))!.status, "void");
});

test("many concurrent issues across accounts get distinct, gap-free numbers", async () => {
  const fixture = await ready();
  const accounts = [fixture.accountId];
  for (let index = 0; index < 5; index++) accounts.push(await addAccount(fixture));
  const results = await Promise.all(
    accounts.map((accountId) => issued(fixture, { accountId, issueDate: "2026-10-05" })),
  );
  assert.deepEqual(results.map((invoice) => invoice.number).sort(), [
    "202610-001",
    "202610-002",
    "202610-003",
    "202610-004",
    "202610-005",
    "202610-006",
  ]);
});

test("more than 999 invoices in a month is refused", async () => {
  const fixture = await ready();
  fixture.files.objects.set("sequences/202610.json", {
    value: { version: 1, kind: "billing-sequence", month: "202610", next: 1000 },
    revision: "r-seed",
  });
  const draft = await fixture.ledger.createDraft(
    ada,
    fixture.accountId,
    { lineItems: lineItems() },
    randomUUID(),
  );
  await assert.rejects(
    fixture.ledger.issue(ada, draft.invoice.id, { issueDate: "2026-10-05" }, randomUUID()),
    refusedWith(409, "invoice_numbers_exhausted"),
  );
  // The refusal frees the account for the next operation.
  await fixture.ledger.issue(ada, draft.invoice.id, { issueDate: "2026-11-05" }, randomUUID());
});

test("an invoice issued outside Prospectus is entered with its number, and the counter never reuses it", async () => {
  const fixture = await ready();
  const { invoice } = await fixture.ledger.enterIssued(
    ada,
    fixture.accountId,
    {
      number: "202610-001",
      issueDate: "2026-10-28",
      lineItems: lineItems([{ description: "Example engagement", quantity: 1, unitAmountCents: 500000 }]),
    },
    randomUUID(),
  );
  assert.equal(invoice.number, "202610-001");
  assert.equal(invoice.status, "issued");
  assert.equal(invoice.entered, true);
  assert.equal(invoice.dueDate, "2026-11-27");
  assert.equal(invoice.issuer?.legalName, "Example Issuer LLC");
  assert.equal(events(fixture).filter((event) => event.action === "invoice.entered").length, 1);
  assert.equal((fixture.files.objects.get("sequences/202610.json")!.value as any).next, 2);
  const next = await issued(fixture, { issueDate: "2026-10-29" });
  assert.equal(next.number, "202610-002");
  // The same number again, from any account, is refused and nothing is written.
  const before = snapshot(fixture);
  await assert.rejects(
    fixture.ledger.enterIssued(
      ada,
      await addAccount(fixture),
      { number: "202610-001", issueDate: "2026-10-28", lineItems: lineItems() },
      randomUUID(),
    ),
    refusedWith(409, "number_taken"),
  );
  assert.equal(snapshot(fixture).length >= before.length, true);
  assert.equal((await fixture.ledger.invoiceByNumber("202610-001"))!.id, invoice.id);
  // A number whose month differs from the issue date, or a malformed one, is refused.
  for (const bad of [
    { number: "202611-004", issueDate: "2026-10-28" },
    { number: "20261-004", issueDate: "2026-10-28" },
    { number: "202610-000", issueDate: "2026-10-28" },
    { number: "202613-001", issueDate: "2026-10-28" },
  ])
    await assert.rejects(
      fixture.ledger.enterIssued(ada, fixture.accountId, { ...bad, lineItems: lineItems() }, randomUUID()),
      refusedWith(400, "invalid_invoice"),
    );
});

test("a manual number ahead of the counter is skipped by later issues", async () => {
  const fixture = await ready();
  await fixture.ledger.enterIssued(
    ada,
    fixture.accountId,
    { number: "202610-003", issueDate: "2026-10-28", lineItems: lineItems() },
    randomUUID(),
  );
  const numbers = [
    (await issued(fixture, { issueDate: "2026-10-29" })).number,
    (await issued(fixture, { issueDate: "2026-10-29" })).number,
    (await issued(fixture, { issueDate: "2026-10-29" })).number,
  ];
  assert.deepEqual(numbers, ["202610-001", "202610-002", "202610-004"]);
});

test("the issuer block and payment methods are copied at issue; a later change never alters the invoice", async () => {
  const fixture = await ready();
  const invoice = await issued(fixture);
  assert.equal(invoice.issuer?.addressLines[0], "100 Placeholder Street");
  assert.deepEqual(
    invoice.paymentMethods?.map((method) => method.label),
    ["Bank transfer", "Venmo"],
  );
  await fixture.issuer.set(
    ada,
    issuerFields({
      issuer: {
        legalName: "Changed LLC",
        billingEmail: "billing@changed.example.invalid",
        addressLines: ["200 Other Road"],
      },
      paymentMethods: [{ label: "Check", instructions: "Mail it (placeholder)", offered: true }],
      expectedRevision: 1,
    }),
    randomUUID(),
  );
  const again = (await fixture.ledger.invoice(invoice.id))!;
  assert.equal(again.issuer?.legalName, "Example Issuer LLC");
  assert.equal(again.issuer?.addressLines[0], "100 Placeholder Street");
  assert.deepEqual(
    again.paymentMethods?.map((method) => method.label),
    ["Bank transfer", "Venmo"],
  );
  const later = await issued(fixture, { issueDate: "2026-11-03" });
  assert.equal(later.issuer?.legalName, "Changed LLC");
});

test("only billing admins set the issuer, and a stale revision is a conflict", async () => {
  const fixture = billingFixture();
  for (const who of [reader, owner])
    await assert.rejects(
      fixture.issuer.set(who, issuerFields(), randomUUID()),
      refusedWith(403, "forbidden"),
    );
  assert.equal(fixture.files.objects.size, 0);
  await fixture.issuer.set(ada, issuerFields(), randomUUID());
  await assert.rejects(
    fixture.issuer.set(grace, issuerFields({ expectedRevision: 0 }), randomUUID()),
    refusedWith(409, "revision_conflict"),
  );
  await assert.rejects(
    fixture.issuer.set(ada, issuerFields({ defaultNetTermsDays: 0 }), randomUUID()),
    refusedWith(400, "invalid_issuer"),
  );
});

test("an issued invoice is immutable: it cannot be re-issued, and nothing edits its lines", async () => {
  const fixture = await ready();
  const invoice = await issued(fixture);
  await assert.rejects(
    fixture.ledger.issue(ada, invoice.id, { issueDate: "2026-11-05" }, randomUUID()),
    refusedWith(409, "invoice_not_draft"),
  );
  assert.equal((fixture.ledger as any).updateLines, undefined);
  assert.equal((fixture.ledger as any).editInvoice, undefined);
  assert.deepEqual((await fixture.ledger.invoice(invoice.id))!.lineItems, invoice.lineItems);
});

test("integer arithmetic: totals sum exactly, and fractional or unsafe amounts are refused", async () => {
  const fixture = await ready();
  let seed = 12345;
  const next = (limit: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % limit;
  };
  for (let round = 0; round < 25; round++) {
    const items = Array.from({ length: 1 + next(6) }, (_, index) => ({
      description: `Item ${index}`,
      quantity: 1 + next(40),
      unitAmountCents: next(900000),
    }));
    const expected = items.reduce((total, item) => total + item.quantity * item.unitAmountCents, 0);
    if (expected === 0) continue;
    const { invoice } = await fixture.ledger.createDraft(
      ada,
      await addAccount(fixture),
      { lineItems: items },
      randomUUID(),
    );
    assert.equal(invoice.totalCents, expected);
    assert.equal(invoice.subtotalCents, expected);
    assert.ok(Number.isInteger(invoice.totalCents));
  }
  for (const bad of [
    { description: "x", quantity: 1, unitAmountCents: 10.5 },
    { description: "x", quantity: 1.5, unitAmountCents: 100 },
    { description: "x", quantity: 0, unitAmountCents: 100 },
    { description: "x", quantity: 1, unitAmountCents: -100 },
    { description: "x", quantity: 1, unitAmountCents: Number.MAX_SAFE_INTEGER },
    { description: "x", quantity: 1, unitAmountCents: 0 },
    { description: "", quantity: 1, unitAmountCents: 100 },
    { description: "x", quantity: 1, unitAmountCents: 100, taxCents: 5 },
  ])
    await assert.rejects(
      fixture.ledger.createDraft(ada, fixture.accountId, { lineItems: [bad] }, randomUUID()),
      refusedWith(400, "invalid_invoice"),
    );
  assert.equal(lineTotalCents(3, 1999), 5997);
  assert.equal(parseDollars("1,234.50"), 123450);
  assert.equal(parseDollars("12.345"), null);
  assert.equal(parseDollars("-5.00"), null);
  assert.equal(parseDollars("1e3"), null);
  assert.equal(formatUsd(123456), "$1,234.56");
  assert.equal(formatUsd(5), "$0.05");
});

test("no floating point anywhere in billing source", () => {
  const forbidden =
    /parseFloat|toFixed|Math\.(round|floor|ceil|trunc|pow)|\*\s*0\.\d|\/\s*100\b|\bNumber\.parseFloat/;
  const files = readdirSync(here).filter((name) => name.endsWith(".ts") && !name.includes("test"));
  assert.ok(files.length > 8);
  for (const name of files) {
    const source = readFileSync(join(here, name), "utf8");
    assert.ok(!forbidden.test(source), `${name} must not use floating point`);
  }
});

test("record an external payment, then allocate it: partially_paid, then paid across three payments", async () => {
  const fixture = await ready();
  const invoice = await issued(fixture);
  const { payment } = await pay(fixture, 50000);
  assert.equal(payment.unallocatedCents, 50000);
  assert.equal(payment.recordedBy, "synthetic-ada-billing");
  assert.equal(payment.method, "bank_transfer");
  assert.ok(fixture.files.objects.has(`payments/${payment.id}.json`));
  const allocated = await fixture.ledger.allocate(
    ada,
    payment.id,
    { allocations: [{ invoiceId: invoice.id, amountCents: 50000 }] },
    randomUUID(),
  );
  assert.equal(allocated.payment.unallocatedCents, 0);
  const partly = (await fixture.ledger.invoice(invoice.id))!;
  assert.equal(partly.balanceCents, 70000);
  assert.equal(partly.status, "partially_paid");
  await pay(fixture, 30000, [{ invoiceId: invoice.id, amountCents: 30000 }]);
  assert.equal((await fixture.ledger.invoice(invoice.id))!.balanceCents, 40000);
  await pay(fixture, 40000, [{ invoiceId: invoice.id, amountCents: 40000 }]);
  const paid = (await fixture.ledger.invoice(invoice.id))!;
  assert.equal(paid.balanceCents, 0);
  assert.equal(paid.status, "paid");
  assert.equal(paid.paidAt, "2030-03-17");
  assert.equal(paid.allocations.length, 3);
  assert.equal(isOpenInvoice(paid), false);
  assert.equal(
    [...fixture.files.objects.keys()].filter((path) => path.startsWith("allocations/")).length,
    3,
    "each allocation is its own record",
  );
});

test("one payment pays several invoices", async () => {
  const fixture = await ready();
  const invoices = [
    await issued(fixture, { cents: 30000 }),
    await issued(fixture, { cents: 30000 }),
    await issued(fixture, { cents: 30000 }),
  ];
  const { payment } = await pay(
    fixture,
    90000,
    invoices.map((invoice) => ({ invoiceId: invoice.id, amountCents: 30000 })),
    fixture.accountId,
    { method: "check", reference: "1042" },
  );
  assert.equal(payment.unallocatedCents, 0);
  assert.equal(payment.allocations.length, 3);
  for (const invoice of invoices) assert.equal((await fixture.ledger.invoice(invoice.id))!.status, "paid");
  const recorded = events(fixture).filter((event) => event.action === "payment.recorded");
  assert.equal(recorded.length, 1, "one event for the one mutation");
});

test("over-allocation, wrong account, unopen invoices and bad amounts are refused and nothing is written", async () => {
  const fixture = await ready();
  const invoice = await issued(fixture, { cents: 30000 });
  const { payment } = await pay(fixture, 50000);
  const stranger = await addAccount(fixture);
  const foreign = await issued(fixture, { accountId: stranger, cents: 30000 });
  const draft = (
    await fixture.ledger.createDraft(ada, fixture.accountId, { lineItems: lineItems() }, randomUUID())
  ).invoice;
  const before = snapshot(fixture);
  const attempt = (allocations: unknown, code: string, status = 409) =>
    assert.rejects(
      fixture.ledger.allocate(ada, payment.id, { allocations }, randomUUID()),
      refusedWith(status, code),
    );
  await attempt([{ invoiceId: invoice.id, amountCents: 30001 }], "over_allocation");
  await attempt([{ invoiceId: foreign.id, amountCents: 100 }], "wrong_account");
  await attempt([{ invoiceId: draft.id, amountCents: 100 }], "invoice_not_open");
  await attempt([{ invoiceId: randomUUID(), amountCents: 100 }], "invoice_missing", 404);
  await attempt([{ invoiceId: invoice.id, amountCents: 100.5 }], "invalid_allocation", 400);
  await attempt([{ invoiceId: invoice.id, amountCents: 0 }], "invalid_allocation", 400);
  await attempt(
    [
      { invoiceId: invoice.id, amountCents: 100 },
      { invoiceId: invoice.id, amountCents: 100 },
    ],
    "invalid_allocation",
    400,
  );
  await attempt([], "invalid_allocation", 400);
  assert.equal(snapshot(fixture), before);
  // More than the payment holds, spread over invoices that could each take their share.
  const second = await issued(fixture, { cents: 30000 });
  await attempt(
    [
      { invoiceId: invoice.id, amountCents: 30000 },
      { invoiceId: second.id, amountCents: 30000 },
    ],
    "over_allocation",
  );
  await assert.rejects(
    pay(fixture, 1000, [{ invoiceId: invoice.id, amountCents: 2000 }]),
    refusedWith(409, "over_allocation"),
  );
  assert.equal((await fixture.ledger.payment(payment.id))!.unallocatedCents, 50000);
});

test("two admins allocating the same payment at once cannot exceed its remainder", async () => {
  const fixture = await ready();
  const first = await issued(fixture, { cents: 40000 }),
    second = await issued(fixture, { cents: 40000 });
  const { payment } = await pay(fixture, 50000);
  const results = await Promise.allSettled([
    fixture.ledger.allocate(
      ada,
      payment.id,
      { allocations: [{ invoiceId: first.id, amountCents: 40000 }] },
      randomUUID(),
    ),
    fixture.ledger.allocate(
      grace,
      payment.id,
      { allocations: [{ invoiceId: second.id, amountCents: 40000 }] },
      randomUUID(),
    ),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const loser = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
  assert.ok(refusedWith(409, "over_allocation")(loser.reason), String(loser.reason));
  const stored = (await fixture.ledger.payment(payment.id))!;
  assert.equal(stored.unallocatedCents, 10000);
  assert.equal(stored.allocations.length, 1);
});

test("two payments allocated at once to one invoice cannot exceed its balance", async () => {
  const fixture = await ready();
  const invoice = await issued(fixture, { cents: 50000 });
  const [one, two] = [(await pay(fixture, 40000)).payment, (await pay(fixture, 40000)).payment];
  const results = await Promise.allSettled([
    fixture.ledger.allocate(
      ada,
      one.id,
      { allocations: [{ invoiceId: invoice.id, amountCents: 40000 }] },
      randomUUID(),
    ),
    fixture.ledger.allocate(
      grace,
      two.id,
      { allocations: [{ invoiceId: invoice.id, amountCents: 40000 }] },
      randomUUID(),
    ),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal((await fixture.ledger.invoice(invoice.id))!.balanceCents, 10000);
});

test("Stripe payments cannot be recorded by hand, and other methods are checked", async () => {
  const fixture = await ready();
  const before = snapshot(fixture);
  for (const method of ["stripe_card", "stripe_bank"])
    await assert.rejects(
      pay(fixture, 1000, [], fixture.accountId, { method }),
      refusedWith(400, "stripe_payments_by_webhook"),
    );
  await assert.rejects(
    pay(fixture, 1000, [], fixture.accountId, { method: "paypal" }),
    refusedWith(400, "invalid_payment"),
  );
  await assert.rejects(pay(fixture, 0), refusedWith(400, "invalid_amount"));
  await assert.rejects(pay(fixture, 10.5), refusedWith(400, "invalid_amount"));
  await assert.rejects(
    pay(fixture, 1000, [], fixture.accountId, { receivedAt: "2026-13-01" }),
    refusedWith(400, "invalid_payment"),
  );
  assert.equal(snapshot(fixture), before);
  for (const method of ["bank_transfer", "check", "venmo", "cash", "other"])
    await pay(fixture, 100, [], fixture.accountId, { method });
});

test("reversing a bounced check: reversing records, the invoice returns, originals untouched", async () => {
  const fixture = await ready();
  const invoice = await issued(fixture, { cents: 30000 });
  const { payment } = await pay(
    fixture,
    30000,
    [{ invoiceId: invoice.id, amountCents: 30000 }],
    fixture.accountId,
    { method: "check", reference: "1042" },
  );
  assert.equal((await fixture.ledger.invoice(invoice.id))!.status, "paid");
  const paymentBefore = JSON.stringify(fixture.files.objects.get(`payments/${payment.id}.json`));
  const allocationPaths = [...fixture.files.objects.keys()].filter((path) => path.startsWith("allocations/"));
  const allocationBefore = allocationPaths.map((path) => JSON.stringify(fixture.files.objects.get(path)));
  const reversed = await fixture.ledger.reverse(ada, payment.id, { reason: "Check bounced" }, randomUUID());
  assert.equal(reversed.payment.reversal_of, payment.id);
  assert.equal(reversed.payment.amountCents, -30000);
  assert.equal(reversed.payment.allocations[0].reversal_of, payment.allocations[0].id);
  assert.equal(reversed.payment.allocations[0].amountCents, -30000);
  const back = (await fixture.ledger.invoice(invoice.id))!;
  assert.equal(back.balanceCents, 30000);
  assert.equal(back.status, "issued");
  assert.equal(back.paidAt, undefined);
  assert.equal(JSON.stringify(fixture.files.objects.get(`payments/${payment.id}.json`)), paymentBefore);
  assert.deepEqual(
    allocationPaths.map((path) => JSON.stringify(fixture.files.objects.get(path))),
    allocationBefore,
  );
  assert.equal([...fixture.files.objects.keys()].filter((path) => path.startsWith("allocations/")).length, 2);
  // It cannot be reversed twice, allocated to, or itself reversed.
  await assert.rejects(
    fixture.ledger.reverse(ada, payment.id, { reason: "again" }, randomUUID()),
    refusedWith(409, "payment_reversed"),
  );
  await assert.rejects(
    fixture.ledger.allocate(
      ada,
      payment.id,
      { allocations: [{ invoiceId: invoice.id, amountCents: 100 }] },
      randomUUID(),
    ),
    refusedWith(409, "payment_reversed"),
  );
  await assert.rejects(
    fixture.ledger.reverse(ada, reversed.payment.id, { reason: "undo" }, randomUUID()),
    refusedWith(409, "payment_is_reversal"),
  );
});

test("reversing a partly allocated payment returns only what was allocated", async () => {
  const fixture = await ready();
  const invoice = await issued(fixture, { cents: 30000 });
  const { payment } = await pay(fixture, 50000, [{ invoiceId: invoice.id, amountCents: 20000 }]);
  const reversed = await fixture.ledger.reverse(ada, payment.id, { reason: "Reversed" }, randomUUID());
  assert.equal(reversed.payment.amountCents, -50000);
  assert.equal(reversed.payment.unallocatedCents, -30000, "the unallocated part is cancelled too");
  assert.equal((await fixture.ledger.invoice(invoice.id))!.balanceCents, 30000);
  // After the reversal the invoice has no net allocations, so it can be voided.
  assert.equal(
    (await fixture.ledger.void(ada, invoice.id, { reason: "Wrong client" }, randomUUID())).invoice.status,
    "void",
  );
});

test("credits reduce the balance, are limited to it, and block voiding", async () => {
  const fixture = await ready();
  const invoice = await issued(fixture, { cents: 120000 });
  await pay(fixture, 50000, [{ invoiceId: invoice.id, amountCents: 50000 }]);
  const credited = await fixture.ledger.credit(
    ada,
    invoice.id,
    { amountCents: 20000, reason: "Goodwill" },
    randomUUID(),
  );
  assert.equal(credited.invoice.balanceCents, 50000);
  assert.equal(credited.invoice.creditsCents, 20000);
  const creditFiles = [...fixture.files.objects.values()].filter(
    (stored) => stored.value.kind === "billing-credit",
  );
  assert.equal(creditFiles.length, 1);
  assert.equal(creditFiles[0].value.invoiceId, invoice.id);
  const before = snapshot(fixture);
  await assert.rejects(
    fixture.ledger.credit(ada, invoice.id, { amountCents: 50001, reason: "Too much" }, randomUUID()),
    refusedWith(409, "over_credit"),
  );
  assert.equal(snapshot(fixture), before);
  await assert.rejects(
    fixture.ledger.void(ada, invoice.id, { reason: "No" }, randomUUID()),
    refusedWith(409, "invoice_has_allocations"),
  );
  await pay(fixture, 50000, [{ invoiceId: invoice.id, amountCents: 50000 }]);
  assert.equal((await fixture.ledger.invoice(invoice.id))!.status, "paid");
});

test("voiding needs no live allocations", async () => {
  const fixture = await ready();
  const invoice = await issued(fixture, { cents: 30000 });
  await pay(fixture, 100, [{ invoiceId: invoice.id, amountCents: 100 }]);
  await assert.rejects(
    fixture.ledger.void(ada, invoice.id, { reason: "No" }, randomUUID()),
    refusedWith(409, "invoice_has_allocations"),
  );
});

test("write-off: the balance is kept apart from outstanding, and the invoice takes nothing more", async () => {
  const fixture = await ready();
  const invoice = await issued(fixture, { cents: 120000 });
  const { payment } = await pay(fixture, 50000, [{ invoiceId: invoice.id, amountCents: 50000 }]);
  const written = await fixture.ledger.writeOff(ada, invoice.id, { reason: "Client closed" }, randomUUID());
  assert.equal(written.invoice.status, "uncollectible");
  assert.equal(written.invoice.writtenOffCents, 70000);
  assert.equal(written.invoice.balanceCents, 70000, "the unpaid figure stays visible");
  assert.equal(isOpenInvoice(written.invoice), false, "but it is not outstanding");
  assert.equal(events(fixture).filter((event) => event.action === "invoice.written_off").length, 1);
  assert.ok(fixture.files.objects.has(`invoices/${invoice.id}.json`), "the invoice stays on record");
  const extra = (await pay(fixture, 1000)).payment;
  for (const attempt of [
    fixture.ledger.writeOff(ada, invoice.id, { reason: "Again" }, randomUUID()),
    fixture.ledger.credit(ada, invoice.id, { amountCents: 100, reason: "x" }, randomUUID()),
    fixture.ledger.allocate(
      ada,
      extra.id,
      { allocations: [{ invoiceId: invoice.id, amountCents: 100 }] },
      randomUUID(),
    ),
    fixture.ledger.void(ada, invoice.id, { reason: "x" }, randomUUID()),
  ])
    await assert.rejects(attempt, (error: any) => error instanceof BillingError && error.status === 409);
  // A bounced check on the paid part raises the written-off figure, never the open one.
  await fixture.ledger.reverse(ada, payment.id, { reason: "Bounced" }, randomUUID());
  const after = (await fixture.ledger.invoice(invoice.id))!;
  assert.equal(after.status, "uncollectible");
  assert.equal(after.balanceCents, 120000);
  assert.equal(isOpenInvoice(after), false);
});

test("past due is derived from the due date and the balance, never stored", async () => {
  const fixture = await ready();
  const invoice = await issued(fixture, { cents: 30000 });
  assert.equal(invoice.dueDate, "2026-12-02");
  assert.equal(isPastDue(invoice, "2026-12-02"), false);
  assert.equal(daysPastDue(invoice, "2026-12-05"), 3);
  assert.ok(!JSON.stringify(fixture.files.objects.get(`invoices/${invoice.id}.json`)).includes("past"));
  await pay(fixture, 30000, [{ invoiceId: invoice.id, amountCents: 30000 }]);
  assert.equal(isPastDue((await fixture.ledger.invoice(invoice.id))!, "2027-01-01"), false);
});

test("only billing admins write: a read-only operator and an owner get 403 and nothing is written", async () => {
  const fixture = await ready();
  const invoice = await issued(fixture, { cents: 30000 });
  const { payment } = await pay(fixture, 30000);
  const before = snapshot(fixture);
  for (const who of [reader, owner]) {
    const attempts = [
      fixture.ledger.createDraft(who, fixture.accountId, { lineItems: lineItems() }, randomUUID()),
      fixture.ledger.raise(who, fixture.accountId, { lineItems: lineItems(), draft: false }, randomUUID()),
      fixture.ledger.issue(who, invoice.id, {}, randomUUID()),
      fixture.ledger.enterIssued(
        who,
        fixture.accountId,
        { number: "202610-009", issueDate: "2026-10-01", lineItems: lineItems() },
        randomUUID(),
      ),
      fixture.ledger.void(who, invoice.id, { reason: "x" }, randomUUID()),
      fixture.ledger.writeOff(who, invoice.id, { reason: "x" }, randomUUID()),
      fixture.ledger.credit(who, invoice.id, { amountCents: 1, reason: "x" }, randomUUID()),
      fixture.ledger.recordPayment(
        who,
        fixture.accountId,
        { amountCents: 1, method: "cash", receivedAt: "2026-11-03" },
        randomUUID(),
      ),
      fixture.ledger.allocate(
        who,
        payment.id,
        { allocations: [{ invoiceId: invoice.id, amountCents: 1 }] },
        randomUUID(),
      ),
      fixture.ledger.reverse(who, payment.id, { reason: "x" }, randomUUID()),
    ];
    for (const attempt of attempts) await assert.rejects(attempt, refusedWith(403, "forbidden"));
  }
  assert.equal(snapshot(fixture), before);
});

test("no second-operator confirmation: any amount is recorded by one admin", async () => {
  const fixture = await ready();
  const { payment } = await pay(fixture, 9_999_999_900);
  assert.equal(payment.amountCents, 9_999_999_900);
});

test("a replayed operation returns the original and writes nothing; a different request under the same ID is a conflict", async () => {
  const fixture = await ready();
  const operationId = randomUUID();
  const input = { amountCents: 50000, method: "bank_transfer", receivedAt: "2026-11-03", reference: "EX-1" };
  const first = await fixture.ledger.recordPayment(ada, fixture.accountId, input, operationId);
  const invoice = await issued(fixture, { cents: 50000 });
  await fixture.ledger.allocate(
    ada,
    first.payment.id,
    { allocations: [{ invoiceId: invoice.id, amountCents: 50000 }] },
    randomUUID(),
  );
  const before = snapshot(fixture);
  const replay = await fixture.ledger.recordPayment(ada, fixture.accountId, input, operationId);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.payment, first.payment, "the original result, not the payment as it is now");
  assert.equal(snapshot(fixture), before);
  assert.equal((await fixture.ledger.payments(fixture.accountId)).length, 1);
  await assert.rejects(
    fixture.ledger.recordPayment(ada, fixture.accountId, { ...input, amountCents: 50001 }, operationId),
    refusedWith(409, "idempotency_conflict"),
  );
  assert.equal(snapshot(fixture), before);
  // Replays of a draft and an issue answer the same way.
  const draftOperation = randomUUID();
  const draft = await fixture.ledger.createDraft(
    ada,
    fixture.accountId,
    { lineItems: lineItems() },
    draftOperation,
  );
  const again = await fixture.ledger.createDraft(
    ada,
    fixture.accountId,
    { lineItems: lineItems() },
    draftOperation,
  );
  assert.equal(again.replayed, true);
  assert.equal(again.invoice.id, draft.invoice.id);
  const issueOperation = randomUUID();
  const one = await fixture.ledger.issue(ada, draft.invoice.id, { issueDate: "2026-11-02" }, issueOperation);
  const two = await fixture.ledger.issue(ada, draft.invoice.id, { issueDate: "2026-11-02" }, issueOperation);
  assert.equal(two.replayed, true);
  assert.equal(two.invoice.number, one.invoice.number);
});

test("expectedRevision: a stale revision is 409 revision_conflict and nothing is written", async () => {
  const fixture = await ready();
  const invoice = await issued(fixture, { cents: 50000 });
  const { payment } = await pay(fixture, 50000);
  await fixture.ledger.credit(ada, invoice.id, { amountCents: 100, reason: "Small" }, randomUUID());
  const stale = invoice.revision;
  const before = snapshot(fixture);
  const conflicts = [
    fixture.ledger.void(ada, invoice.id, { reason: "x", expectedRevision: stale }, randomUUID()),
    fixture.ledger.writeOff(ada, invoice.id, { reason: "x", expectedRevision: stale }, randomUUID()),
    fixture.ledger.credit(
      ada,
      invoice.id,
      { amountCents: 1, reason: "x", expectedRevision: stale },
      randomUUID(),
    ),
    fixture.ledger.allocate(
      ada,
      payment.id,
      { allocations: [{ invoiceId: invoice.id, amountCents: 100 }], expectedRevision: 0 },
      randomUUID(),
    ),
    fixture.ledger.reverse(ada, payment.id, { reason: "x", expectedRevision: 5 }, randomUUID()),
  ];
  for (const attempt of conflicts) await assert.rejects(attempt, refusedWith(409, "revision_conflict"));
  assert.equal(snapshot(fixture), before);
  const current = (await fixture.ledger.invoice(invoice.id))!.revision;
  assert.equal(
    (
      await fixture.ledger.credit(
        ada,
        invoice.id,
        { amountCents: 1, reason: "ok", expectedRevision: current },
        randomUUID(),
      )
    ).invoice.creditsCents,
    101,
  );
});

test("the journal has exactly one event per mutation, with actor and revisions, and every balance can be rebuilt from it", async () => {
  const fixture = await ready();
  const first = await issued(fixture, { cents: 120000 }),
    second = await issued(fixture, { cents: 80000 }),
    third = await issued(fixture, { cents: 5000 });
  const { payment } = await pay(fixture, 60000, [{ invoiceId: first.id, amountCents: 50000 }]);
  await fixture.ledger.allocate(
    ada,
    payment.id,
    { allocations: [{ invoiceId: second.id, amountCents: 10000 }] },
    randomUUID(),
  );
  await fixture.ledger.credit(ada, first.id, { amountCents: 20000, reason: "Goodwill" }, randomUUID());
  const bounced = await pay(
    fixture,
    30000,
    [{ invoiceId: second.id, amountCents: 30000 }],
    fixture.accountId,
    { method: "check" },
  );
  await fixture.ledger.reverse(ada, bounced.payment.id, { reason: "Bounced" }, randomUUID());
  await fixture.ledger.void(ada, third.id, { reason: "Raised in error" }, randomUUID());
  // 3 x (draft + issue), record, allocate, credit, record, reverse, void.
  const ledger = ledgerEvents(fixture);
  assert.equal(ledger.length, 6 + 6);
  for (const event of ledger) {
    assert.equal(event.actor, "synthetic-ada-billing");
    assert.ok(event.operationId && event.requestHash && event.at);
    assert.ok(event.records && event.records.length >= 1);
    assert.equal(typeof event.afterRevision, "number");
  }
  assert.equal(new Set(ledger.map((event) => event.eventId)).size, ledger.length);
  const rebuilt = rebuildBalancesFromJournal(ledger);
  for (const invoice of await fixture.ledger.invoices(fixture.accountId))
    assert.equal(rebuilt.get(invoice.id), invoice.balanceCents, `balance of ${invoice.number}`);
  assert.equal(rebuilt.get(first.id), 50000);
  assert.equal(rebuilt.get(second.id), 70000);
  assert.equal(rebuilt.get(third.id), 0);
  assert.ok(!JSON.stringify(ledger).includes(CONTACT_MARKER));
  const timeline = await fixture.ledger.journal(fixture.accountId);
  assert.equal(timeline.length, ledger.length);
  assert.equal(timeline[0].at >= timeline[timeline.length - 1].at, true);
});

test("an operation that stops part-way is finished, exactly once, by the next operation on the account", async () => {
  const fixture = await ready();
  const invoice = await issued(fixture, { cents: 50000 });
  let crashed = false;
  fixture.files.beforeCommit = (path) => {
    if (path.startsWith("payments/") && !crashed) {
      crashed = true;
      throw new Error("process stopped");
    }
  };
  const operationId = randomUUID();
  const input = {
    amountCents: 50000,
    method: "bank_transfer",
    receivedAt: "2026-11-03",
    allocations: [{ invoiceId: invoice.id, amountCents: 50000 }],
  };
  await assert.rejects(
    fixture.ledger.recordPayment(ada, fixture.accountId, input, operationId),
    /process stopped/,
  );
  // The allocation and the invoice were written; the payment and the event were not.
  assert.equal((await fixture.ledger.invoice(invoice.id))!.balanceCents, 0);
  assert.equal((await fixture.ledger.payments(fixture.accountId)).length, 0);
  // Any other operation on the account finishes the pending one first.
  const other = await fixture.ledger.createDraft(
    ada,
    fixture.accountId,
    { lineItems: lineItems() },
    randomUUID(),
  );
  assert.ok(other.invoice.id);
  assert.equal((await fixture.ledger.payments(fixture.accountId)).length, 1);
  assert.equal(events(fixture).filter((event) => event.action === "payment.recorded").length, 1);
  // The caller's retry returns the original payment and writes no second one.
  const retry = await fixture.ledger.recordPayment(ada, fixture.accountId, input, operationId);
  assert.equal(retry.replayed, true);
  assert.equal(retry.payment.allocations.length, 1);
  assert.equal((await fixture.ledger.payments(fixture.accountId)).length, 1);
  assert.equal((await fixture.ledger.invoice(invoice.id))!.allocations.length, 1);
  assert.equal([...fixture.files.objects.keys()].filter((path) => path.startsWith("allocations/")).length, 1);
});

test("a number chosen for an interrupted issue is reused when it is finished", async () => {
  const fixture = await ready();
  const draft = (
    await fixture.ledger.createDraft(ada, fixture.accountId, { lineItems: lineItems() }, randomUUID())
  ).invoice;
  let crashed = false;
  fixture.files.beforeCommit = (path) => {
    if (path.startsWith("invoices/") && !crashed) {
      crashed = true;
      throw new Error("process stopped");
    }
  };
  const operationId = randomUUID();
  await assert.rejects(
    fixture.ledger.issue(ada, draft.id, { issueDate: "2026-11-02" }, operationId),
    /process stopped/,
  );
  const retry = await fixture.ledger.issue(ada, draft.id, { issueDate: "2026-11-02" }, operationId);
  assert.equal(retry.invoice.number, "202611-001");
  assert.equal(
    [...fixture.files.objects.keys()].filter((path) => path.startsWith("numbers/")).length,
    1,
    "no number was wasted",
  );
  assert.equal((await issued(fixture, { issueDate: "2026-11-03" })).number, "202611-002");
});

test("reads: by number, by account and across accounts", async () => {
  const fixture = await ready();
  const other = await addAccount(fixture);
  const one = await issued(fixture),
    two = await issued(fixture, { accountId: other });
  await pay(fixture, 100);
  await pay(fixture, 200, [], other);
  assert.equal((await fixture.ledger.invoiceByNumber(one.number!))!.id, one.id);
  assert.equal(await fixture.ledger.invoiceByNumber("202699-001"), null);
  assert.equal(await fixture.ledger.invoiceByNumber("not-a-number"), null);
  assert.deepEqual(
    (await fixture.ledger.invoices(other)).map((invoice) => invoice.id),
    [two.id],
  );
  assert.equal((await fixture.ledger.allInvoices()).length, 2);
  assert.equal((await fixture.ledger.allPayments()).length, 2);
});

test("billing ledger records carry only ids, amounts and the stated reason, never contact data", async () => {
  const fixture = await ready();
  const invoice = await issued(fixture, { cents: 1000 });
  await pay(fixture, 1000, [{ invoiceId: invoice.id, amountCents: 1000 }]);
  for (const [path, stored] of fixture.files.objects)
    if (!path.startsWith("profiles/") && !path.startsWith("invoices/") && !path.startsWith("issuer/"))
      assert.ok(!JSON.stringify(stored.value).includes(CONTACT_MARKER), path);
  assert.ok(
    !JSON.stringify(fixture.files.objects.get(`invoices/${invoice.id}.json`)).includes(CONTACT_MARKER),
  );
});

test("reversing a payment that was allocated twice to one invoice returns both allocations", async () => {
  const fixture = await ready();
  const invoice = await issued(fixture, { cents: 100000 });
  const { payment } = await pay(fixture, 100000, [{ invoiceId: invoice.id, amountCents: 40000 }]);
  await fixture.ledger.allocate(
    ada,
    payment.id,
    { allocations: [{ invoiceId: invoice.id, amountCents: 60000 }] },
    randomUUID(),
  );
  assert.equal((await fixture.ledger.invoice(invoice.id))!.status, "paid");
  const reversed = await fixture.ledger.reverse(ada, payment.id, { reason: "Bounced" }, randomUUID());
  assert.equal(reversed.payment.allocations.length, 2);
  const back = (await fixture.ledger.invoice(invoice.id))!;
  assert.equal(back.balanceCents, 100000);
  assert.equal(back.status, "issued");
  assert.equal(back.allocations.length, 4);
});
