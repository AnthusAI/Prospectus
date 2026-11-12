/**
 * Balances and statuses, derived from the records and never trusted from a stored value alone. An invoice's balance is
 * its total minus its allocations minus its credits; its status follows from the balance and from what a person
 * decided (void, written off). Past due is derived from the due date and the balance and is never stored.
 */
import { daysBetween } from "./dates";
import { sumCents } from "./money";
import type { InvoiceStatus, JournalEvent, LedgerInvoice, LedgerPayment } from "./model";

export interface InvoiceFigures {
  status: InvoiceStatus;
  balanceCents: number;
  allocatedCents: number;
  creditsCents: number;
  /** The date the balance reached zero, when it has: the day the settling money arrived, not the day it was entered. */
  paidAt?: string;
}

/** The day each payment's money arrived, by payment id. */
export type ReceivedOn = (paymentId: string) => string | undefined;

type InvoiceBasis = Pick<LedgerInvoice, "lifecycle" | "totalCents" | "allocations" | "credits">;

export function deriveInvoice(invoice: InvoiceBasis, receivedOn?: ReceivedOn): InvoiceFigures {
  const allocatedCents = sumCents(invoice.allocations.map((allocation) => allocation.amountCents));
  const creditsCents = sumCents(invoice.credits.map((credit) => credit.amountCents));
  if (invoice.lifecycle === "void") return { status: "void", balanceCents: 0, allocatedCents, creditsCents };
  const balanceCents = invoice.totalCents - allocatedCents - creditsCents;
  if (invoice.lifecycle === "draft") return { status: "draft", balanceCents, allocatedCents, creditsCents };
  if (invoice.lifecycle === "uncollectible")
    return { status: "uncollectible", balanceCents, allocatedCents, creditsCents };
  if (balanceCents === 0) {
    const settled = [
      ...invoice.allocations.map((entry) => receivedOn?.(entry.paymentId) ?? entry.at.slice(0, 10)),
      ...invoice.credits.map((entry) => entry.at.slice(0, 10)),
    ].sort();
    return {
      status: "paid",
      balanceCents,
      allocatedCents,
      creditsCents,
      paidAt: settled[settled.length - 1]?.slice(0, 10),
    };
  }
  return {
    status: allocatedCents > 0 ? "partially_paid" : "issued",
    balanceCents,
    allocatedCents,
    creditsCents,
  };
}

/** The invoice with its stored figures recomputed from its references. */
export function withDerivedFigures<T extends LedgerInvoice>(invoice: T, receivedOn?: ReceivedOn): T {
  const { paidAt: _paidAt, ...rest } = invoice;
  const figures = deriveInvoice(invoice, receivedOn);
  return { ...rest, ...figures } as T;
}

/** Looks up when each payment's money arrived. */
export const receivedOnFrom =
  (payments: readonly Pick<LedgerPayment, "id" | "receivedAt">[]): ReceivedOn =>
  (paymentId) =>
    payments.find((payment) => payment.id === paymentId)?.receivedAt?.slice(0, 10);

/** What is left of a payment: its amount minus the allocations drawn from it. */
export const paymentRemainder = (payment: Pick<LedgerPayment, "amountCents" | "allocations">) =>
  payment.amountCents - sumCents(payment.allocations.map((allocation) => allocation.amountCents));

/** Open means money may still be collected: issued or partly paid, with something left. Written-off balances are not. */
export const isOpenInvoice = (figures: Pick<InvoiceFigures, "status" | "balanceCents">) =>
  (figures.status === "issued" || figures.status === "partially_paid") && figures.balanceCents > 0;

/** Whole days past the due date while a balance is open; zero otherwise. */
export function daysPastDue(invoice: Pick<LedgerInvoice, "dueDate"> & InvoiceBasis, today: string): number {
  const figures = deriveInvoice(invoice);
  if (!isOpenInvoice(figures) || !invoice.dueDate) return 0;
  return Math.max(daysBetween(invoice.dueDate, today), 0);
}
export const isPastDue = (invoice: Pick<LedgerInvoice, "dueDate"> & InvoiceBasis, today: string) =>
  daysPastDue(invoice, today) > 0;

/**
 * Rebuilds every invoice balance from journal events alone, as the reconciliation source. Invoices are introduced by
 * their issue (or entry) event and then moved by allocations (reversals are negative), credits and voiding.
 */
export function rebuildBalancesFromJournal(events: readonly JournalEvent[]): Map<string, number> {
  const totals = new Map<string, number>();
  const applied = new Map<string, number>();
  const voided = new Set<string>();
  const apply = (invoiceId: unknown, cents: number) => {
    if (typeof invoiceId === "string") applied.set(invoiceId, (applied.get(invoiceId) ?? 0) + cents);
  };
  // The sums do not depend on the order events are read in.
  for (const event of events) {
    const detail = event.detail ?? {};
    switch (event.action) {
      case "invoice.drafted":
      case "invoice.issued":
      case "invoice.entered":
        if (typeof detail.invoiceId === "string" && typeof detail.totalCents === "number")
          totals.set(detail.invoiceId, detail.totalCents);
        break;
      case "payment.recorded":
      case "payment.allocated":
      case "payment.reversed":
        for (const allocation of (detail.allocations as any[] | undefined) ?? [])
          apply(allocation.invoiceId, allocation.amountCents);
        break;
      case "credit.recorded":
        apply(detail.invoiceId, detail.amountCents as number);
        break;
      case "invoice.voided":
        if (typeof detail.invoiceId === "string") voided.add(detail.invoiceId);
        break;
    }
  }
  const balances = new Map<string, number>();
  for (const [invoiceId, total] of totals)
    balances.set(invoiceId, voided.has(invoiceId) ? 0 : total - (applied.get(invoiceId) ?? 0));
  return balances;
}
