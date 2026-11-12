import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveInvoice, receivedOnFrom } from "./balances";
import type { JournalEvent } from "./model";
import { journalView } from "./views";
import { describeEvent, paymentLabel } from "../src/billing/derive";

const allocation = { id: "a1", paymentId: "p1", invoiceId: "i1", amountCents: 1_000_000, by: "operator" };

test("an invoice is paid on the day the money arrived, not the day it was entered", () => {
  // Entered late on Nov 10 in Chicago, which is already Nov 11 in UTC.
  const invoice = {
    lifecycle: "issued" as const,
    totalCents: 1_000_000,
    allocations: [{ ...allocation, at: "2026-11-11T03:12:00.000Z" }],
    credits: [],
  };
  const payments = [{ id: "p1", receivedAt: "2026-11-10" }];
  assert.equal(deriveInvoice(invoice, receivedOnFrom(payments)).paidAt, "2026-11-10");
  assert.equal(deriveInvoice(invoice).paidAt, "2026-11-11");
});

test("a recorded payment reads with its method in the timeline", () => {
  const event = {
    eventId: "e1",
    at: "2026-11-11T03:12:00.000Z",
    actor: "operator",
    action: "payment.recorded",
    accountId: "acct",
    detail: {
      paymentId: "p1",
      amountCents: 1_000_000,
      method: "melio",
      allocations: [
        { allocationId: "a1", invoiceId: "i1", invoiceNumber: "202610-001", amountCents: 1_000_000 },
      ],
    },
  } as unknown as JournalEvent;
  const view = journalView(event)!;
  assert.equal(view.paymentLabel, "Melio");
  assert.equal(view.invoiceNumber, "202610-001");
  assert.equal(
    describeEvent(view as never),
    "Recorded Melio for $10,000.00. Applied $10,000.00 to 202610-001.",
  );
  const later = {
    ...event,
    action: "payment.allocated",
    detail: { paymentId: "p1", allocations: [] },
  } as unknown as JournalEvent;
  assert.equal(
    journalView(later, [{ id: "p1", method: "check", reference: "1042" } as never])!.paymentLabel,
    "check 1042",
  );
  assert.equal(journalView(later)!.paymentLabel, "a payment");
});

test("payment methods keep their names mid-sentence", () => {
  assert.equal(paymentLabel({ method: "melio" } as never), "Melio");
  assert.equal(paymentLabel({ method: "venmo", reference: "@dp" } as never), "Venmo @dp");
  assert.equal(paymentLabel({ method: "bank_transfer" } as never), "bank transfer");
});
