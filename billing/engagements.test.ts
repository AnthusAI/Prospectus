import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lastInvoiced, uninvoicedMonth } from "./engagements";
import { BillingError, type JournalEvent, type LedgerInvoice } from "./model";
import { engagementView } from "./views";
import { billingFixture, issuerFields, operator, profileInput } from "./testing/billing-fixture";

const ada = operator("ada"),
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
const ongoing = (overrides: Record<string, unknown> = {}) => ({
  name: "Reporting desk support",
  type: "ongoing",
  lead: "Example Lead",
  startDate: "2026-10-01",
  monthlyAmountCents: 1000000,
  ...overrides,
});
const setup = (overrides: Record<string, unknown> = {}) => ({
  name: "Newsroom setup",
  type: "setup",
  lead: "Example Lead",
  startDate: "2026-10-26",
  packagePriceCents: 1200000,
  lengthWeeks: 6,
  ...overrides,
});
const start = (fixture: Fixture, input: Record<string, unknown>, accountId = fixture.accountId) =>
  fixture.ledger.createEngagement(ada, accountId, input, randomUUID());
const journal = (fixture: Fixture) =>
  [...fixture.files.objects.entries()]
    .filter(([path]) => path.startsWith("journal/"))
    .map(([, stored]) => stored.value as JournalEvent);
const snapshot = (fixture: Fixture) => JSON.stringify([...fixture.files.objects.entries()]);
const retainerLine = (engagementId: string, period = "October 1–31, 2026") => [
  {
    description: "Reporting desk support, monthly retainer",
    quantity: 1,
    unitAmountCents: 1000000,
    period,
    engagementId,
  },
];

test("an ongoing engagement is stored, indexed and journaled", async () => {
  const fixture = await ready();
  const { engagement, event, replayed } = await start(fixture, ongoing());
  assert.equal(replayed, false);
  assert.equal(engagement.status, "active");
  assert.equal(engagement.type, "ongoing");
  assert.equal(engagement.monthlyAmountCents, 1000000);
  assert.equal(engagement.endDate, undefined);
  assert.equal(event.action, "engagement.created");
  assert.equal(event.recordKind, "engagement");
  assert.equal(event.recordPath, `engagements/${engagement.id}.json`);
  assert.ok(fixture.files.objects.has(`engagements/${engagement.id}.json`));
  assert.deepEqual(
    (await fixture.ledger.engagements(fixture.accountId)).map((entry) => entry.id),
    [engagement.id],
  );
  assert.deepEqual(
    (await fixture.ledger.allEngagements()).map((entry) => entry.id),
    [engagement.id],
  );
});

test("a setup package ends after its weeks, starts at Installation and moves through stages", async () => {
  const fixture = await ready();
  const { engagement } = await start(fixture, setup());
  assert.equal(engagement.endDate, "2026-12-07");
  assert.equal(engagement.stage, "Installation");
  const { engagement: moved, event } = await fixture.ledger.changeEngagement(
    ada,
    engagement.id,
    { stage: "Training", expectedRevision: engagement.revision },
    randomUUID(),
  );
  assert.equal(moved.stage, "Training");
  assert.equal(event.action, "engagement.updated");
  const { engagement: longer } = await fixture.ledger.changeEngagement(
    ada,
    engagement.id,
    { lengthWeeks: 8 },
    randomUUID(),
  );
  assert.equal(longer.endDate, "2026-12-21");
});

test("a proposed engagement starts later and cannot be billed until then", async () => {
  const fixture = await ready();
  const { engagement } = await start(fixture, ongoing({ status: "proposed" }));
  assert.equal(engagement.status, "proposed");
  await assert.rejects(
    fixture.ledger.raise(
      ada,
      fixture.accountId,
      { lineItems: retainerLine(engagement.id), issueDate: "2026-10-31" },
      randomUUID(),
    ),
    refusedWith(400, "invalid_engagement"),
  );
  const { engagement: started } = await fixture.ledger.changeEngagement(
    ada,
    engagement.id,
    { status: "active" },
    randomUUID(),
  );
  assert.equal(started.status, "active");
  await assert.rejects(
    fixture.ledger.changeEngagement(ada, engagement.id, { status: "active" }, randomUUID()),
    refusedWith(409, "engagement_started"),
  );
});

test("ending an engagement records the end date and closes it to changes", async () => {
  const fixture = await ready();
  const { engagement } = await start(fixture, ongoing());
  const { engagement: ended, event } = await fixture.ledger.changeEngagement(
    ada,
    engagement.id,
    { status: "ended", endDate: "2026-12-31" },
    randomUUID(),
  );
  assert.equal(ended.status, "ended");
  assert.equal(ended.endDate, "2026-12-31");
  assert.equal(event.action, "engagement.ended");
  await assert.rejects(
    fixture.ledger.changeEngagement(ada, engagement.id, { name: "Another name" }, randomUUID()),
    refusedWith(409, "engagement_ended"),
  );
  await assert.rejects(
    fixture.ledger.changeEngagement(
      ada,
      engagement.id,
      { status: "ended", endDate: "2026-09-01" },
      randomUUID(),
    ),
    refusedWith(409, "engagement_ended"),
  );
});

test("writes need the billing permission, replay once and compare revisions", async () => {
  const fixture = await ready();
  const before = snapshot(fixture);
  await assert.rejects(
    fixture.ledger.createEngagement(reader, fixture.accountId, ongoing(), randomUUID()),
    (error: any) => error instanceof BillingError && error.status === 403,
  );
  assert.equal(snapshot(fixture), before);
  const operationId = randomUUID();
  const first = await fixture.ledger.createEngagement(ada, fixture.accountId, ongoing(), operationId);
  const again = await fixture.ledger.createEngagement(ada, fixture.accountId, ongoing(), operationId);
  assert.equal(again.replayed, true);
  assert.deepEqual(again.engagement, first.engagement);
  assert.equal((await fixture.ledger.engagements(fixture.accountId)).length, 1);
  await assert.rejects(
    fixture.ledger.createEngagement(ada, fixture.accountId, ongoing({ name: "Other" }), operationId),
    (error: any) => error instanceof BillingError && error.status === 409,
  );
  await assert.rejects(
    fixture.ledger.changeEngagement(reader, first.engagement.id, { name: "Renamed" }, randomUUID()),
    (error: any) => error instanceof BillingError && error.status === 403,
  );
  await fixture.ledger.changeEngagement(ada, first.engagement.id, { name: "Renamed" }, randomUUID());
  await assert.rejects(
    fixture.ledger.changeEngagement(
      ada,
      first.engagement.id,
      { lead: "Someone else", expectedRevision: first.engagement.revision },
      randomUUID(),
    ),
    refusedWith(409, "revision_conflict"),
  );
  assert.equal(journal(fixture).filter((event) => event.action.startsWith("engagement.")).length, 2);
});

test("engagement fields are checked and a refusal writes nothing", async () => {
  const fixture = await ready();
  const before = snapshot(fixture);
  for (const input of [
    ongoing({ monthlyAmountCents: 0 }),
    ongoing({ monthlyAmountCents: 10.5 }),
    ongoing({ monthlyAmountCents: undefined }),
    ongoing({ lengthWeeks: 4 }),
    setup({ packagePriceCents: undefined }),
    setup({ lengthWeeks: 0 }),
    setup({ lengthWeeks: 105 }),
    setup({ monthlyAmountCents: 100 }),
    setup({ stage: "Somewhere" }),
    ongoing({ name: "" }),
    ongoing({ lead: " " }),
    ongoing({ startDate: "2026-13-01" }),
    ongoing({ type: "retainer" }),
    ongoing({ status: "ended" }),
    ongoing({ surprise: true }),
  ])
    await assert.rejects(start(fixture, input), refusedWith(400, "invalid_engagement"));
  assert.equal(snapshot(fixture), before);
  const { engagement } = await start(fixture, ongoing());
  for (const change of [
    { stage: "Training" },
    { packagePriceCents: 100 },
    { monthlyAmountCents: -1 },
    { endDate: "2026-12-31" },
    { status: "proposed" },
    {},
  ])
    await assert.rejects(
      fixture.ledger.changeEngagement(ada, engagement.id, change, randomUUID()),
      refusedWith(400, "invalid_engagement"),
    );
});

test("invoice lines name an engagement of the same account, on raised and already-sent invoices", async () => {
  const fixture = await ready();
  const { engagement } = await start(fixture, ongoing());
  const { invoice } = await fixture.ledger.enterIssued(
    ada,
    fixture.accountId,
    { number: "202610-001", issueDate: "2026-10-31", lineItems: retainerLine(engagement.id) },
    randomUUID(),
  );
  assert.equal(invoice.lineItems[0].engagementId, engagement.id);
  const { invoice: november } = await fixture.ledger.raise(
    ada,
    fixture.accountId,
    { lineItems: retainerLine(engagement.id, "November 1–30, 2026"), issueDate: "2026-11-30" },
    randomUUID(),
  );
  const invoices = await fixture.ledger.invoices(fixture.accountId);
  assert.deepEqual(lastInvoiced(engagement.id, invoices), {
    invoiceId: november.id,
    invoiceNumber: november.number,
    issueDate: "2026-11-30",
    period: "November 1–30, 2026",
  });
});

test("an invoice naming another account's, a missing or a malformed engagement is refused", async () => {
  const fixture = await ready();
  const other = randomUUID();
  await fixture.profiles.set(ada, other, profileInput(), randomUUID());
  const { engagement: theirs } = await start(fixture, ongoing(), other);
  const before = snapshot(fixture);
  for (const engagementId of [theirs.id, randomUUID()])
    await assert.rejects(
      fixture.ledger.raise(
        ada,
        fixture.accountId,
        { lineItems: retainerLine(engagementId), issueDate: "2026-10-31" },
        randomUUID(),
      ),
      refusedWith(400, "invalid_engagement"),
    );
  await assert.rejects(
    fixture.ledger.raise(
      ada,
      fixture.accountId,
      { lineItems: retainerLine("not-an-id"), issueDate: "2026-10-31" },
      randomUUID(),
    ),
    refusedWith(400, "invalid_invoice"),
  );
  assert.equal(snapshot(fixture), before);
});

test("an ended engagement can still be billed for its last month", async () => {
  const fixture = await ready();
  const { engagement } = await start(fixture, ongoing());
  await fixture.ledger.changeEngagement(
    ada,
    engagement.id,
    { status: "ended", endDate: "2026-11-30" },
    randomUUID(),
  );
  const { invoice } = await fixture.ledger.raise(
    ada,
    fixture.accountId,
    { lineItems: retainerLine(engagement.id, "November 1–30, 2026"), issueDate: "2026-11-30" },
    randomUUID(),
  );
  assert.equal(invoice.lifecycle, "issued");
});

test("a month waiting for an invoice, in arrears and in advance", () => {
  const engagement = {
    id: "e",
    type: "ongoing" as const,
    status: "active" as const,
    startDate: "2026-10-01",
  };
  const invoice = (issueDate: string, lifecycle: LedgerInvoice["lifecycle"] = "issued") =>
    ({
      id: issueDate,
      number: `${issueDate.slice(0, 4)}${issueDate.slice(5, 7)}-001`,
      issueDate,
      lifecycle,
      lineItems: [{ description: "x", quantity: 1, unitAmountCents: 1, engagementId: "e" }],
    }) as unknown as LedgerInvoice;
  // October was billed on its last day; on November 5 nothing waits.
  assert.equal(uninvoicedMonth(engagement, [invoice("2026-10-31")], "2026-11-05"), null);
  // November was not billed; on December 5 it waits.
  assert.equal(uninvoicedMonth(engagement, [invoice("2026-10-31")], "2026-12-05"), "2026-11");
  // Billed in arrears on December 2: nothing waits.
  assert.equal(
    uninvoicedMonth(engagement, [invoice("2026-10-31"), invoice("2026-12-02")], "2026-12-05"),
    null,
  );
  // A void invoice does not count.
  assert.equal(uninvoicedMonth(engagement, [invoice("2026-12-02", "void")], "2026-12-05"), "2026-11");
  // January looks back at December across the year.
  assert.equal(uninvoicedMonth(engagement, [], "2027-01-10"), "2026-12");
  // Not started by the end of last month: nothing is owed.
  assert.equal(uninvoicedMonth({ ...engagement, startDate: "2026-12-01" }, [], "2026-12-20"), null);
  // Started in the middle of last month: that month is owed.
  assert.equal(uninvoicedMonth({ ...engagement, startDate: "2026-11-15" }, [], "2026-12-20"), "2026-11");
  // Only active ongoing engagements wait.
  assert.equal(uninvoicedMonth({ ...engagement, status: "ended" }, [], "2026-12-20"), null);
  assert.equal(uninvoicedMonth({ ...engagement, type: "setup" }, [], "2026-12-20"), null);
});

test("the engagement view carries last invoiced and the month still waiting", async () => {
  const fixture = await ready();
  const { engagement } = await start(fixture, ongoing());
  await fixture.ledger.enterIssued(
    ada,
    fixture.accountId,
    { number: "202610-001", issueDate: "2026-10-31", lineItems: retainerLine(engagement.id) },
    randomUUID(),
  );
  const invoices = await fixture.ledger.invoices(fixture.accountId);
  const view = engagementView(engagement, invoices, "2026-12-05");
  assert.equal(view.lastInvoiced?.invoiceNumber, "202610-001");
  assert.equal(view.lastInvoiced?.period, "October 1–31, 2026");
  assert.equal(view.uninvoicedMonth, "2026-11");
  assert.equal(engagementView(engagement, invoices, "2026-11-05").uninvoicedMonth, undefined);
});
