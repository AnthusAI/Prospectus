/** Figures the billing pages work out from the records each time. Nothing here is stored. */
import { addDays } from "../prospect";
import { formatCents } from "./money";
import type {
  AccountSummary,
  Allocation,
  AllocationInput,
  Invoice,
  InvoiceStatus,
  JournalEvent,
  Payment,
  PaymentMethod,
} from "./types";

const OPEN: readonly InvoiceStatus[] = ["issued", "partially_paid"];

export const isOpen = (invoice: Invoice) => OPEN.includes(invoice.status) && invoice.balanceCents > 0;

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Past due is derived from the due date and the balance, never stored. */
export function daysPastDue(invoice: Invoice, today: string): number {
  if (!isOpen(invoice) || !invoice.dueAt) return 0;
  return Math.max(daysBetween(invoice.dueAt, today), 0);
}
export const isPastDue = (invoice: Invoice, today: string) => daysPastDue(invoice, today) > 0;

export const STATUS_LABEL: Record<InvoiceStatus, string> = {
  draft: "Draft",
  issued: "Issued",
  partially_paid: "Partly paid",
  paid: "Paid",
  void: "Void",
  uncollectible: "Written off",
};
export const METHOD_LABEL: Record<PaymentMethod, string> = {
  bank_transfer: "Bank transfer",
  check: "Check",
  venmo: "Venmo",
  cash: "Cash",
  other: "Other",
  stripe_card: "Card, through Stripe",
  stripe_bank: "Bank, through Stripe",
};

/** "Nov 2" from `2026-11-02`, with the year when it is not the current one. */
export function shortDate(date: string | null | undefined, today?: string): string {
  if (!date) return "—";
  const value = new Date(`${date}T12:00:00Z`);
  const options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", timeZone: "UTC" };
  if (!today || today.slice(0, 4) !== date.slice(0, 4)) options.year = "numeric";
  return value.toLocaleDateString("en-US", options);
}
export const longDate = (date: string | null | undefined) =>
  date
    ? new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      })
    : "—";

export function dueLabel(invoice: Invoice, today: string): string {
  if (invoice.status === "paid") return invoice.paidAt ? `Paid ${shortDate(invoice.paidAt, today)}` : "Paid";
  if (invoice.status === "void" || !invoice.dueAt) return "—";
  const late = daysPastDue(invoice, today);
  const base = shortDate(invoice.dueAt, today);
  return late ? `${base} · ${late} ${late === 1 ? "day" : "days"} late` : base;
}

export interface Totals {
  outstandingCents: number;
  openCount: number;
  pastDueCents: number;
  pastDueCount: number;
  pastDueAccounts: number;
  unappliedCents: number;
  unappliedCount: number;
  collectedCents: number;
  collectedCount: number;
}

export function totals(invoices: Invoice[], payments: Payment[], today: string): Totals {
  const open = invoices.filter(isOpen);
  const late = open.filter((invoice) => isPastDue(invoice, today));
  const live = payments.filter((payment) => !payment.reversal);
  const month = today.slice(0, 7);
  const received = live.filter((payment) => payment.receivedAt.startsWith(month));
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  return {
    outstandingCents: sum(open.map((invoice) => invoice.balanceCents)),
    openCount: open.length,
    pastDueCents: sum(late.map((invoice) => invoice.balanceCents)),
    pastDueCount: late.length,
    pastDueAccounts: new Set(late.map((invoice) => invoice.accountId)).size,
    unappliedCents: sum(live.map((payment) => payment.unallocatedCents)),
    unappliedCount: live.filter((payment) => payment.unallocatedCents > 0).length,
    collectedCents: sum(received.map((payment) => payment.amountCents)),
    collectedCount: received.length,
  };
}

export interface Aging {
  notDueCents: number;
  late1to30Cents: number;
  late31to60Cents: number;
  lateOver60Cents: number;
}
export function aging(invoices: Invoice[], today: string): Aging {
  const result: Aging = { notDueCents: 0, late1to30Cents: 0, late31to60Cents: 0, lateOver60Cents: 0 };
  for (const invoice of invoices.filter(isOpen)) {
    const late = daysPastDue(invoice, today);
    if (late === 0) result.notDueCents += invoice.balanceCents;
    else if (late <= 30) result.late1to30Cents += invoice.balanceCents;
    else if (late <= 60) result.late31to60Cents += invoice.balanceCents;
    else result.lateOver60Cents += invoice.balanceCents;
  }
  return result;
}

export interface AccountOwed {
  owedCents: number;
  pastDueCents: number;
  unappliedCents: number;
  openCount: number;
  lastPayment: Payment | null;
}
export function owedBy(
  accountId: string,
  invoices: Invoice[],
  payments: Payment[],
  today: string,
): AccountOwed {
  const own = invoices.filter((invoice) => invoice.accountId === accountId);
  const live = payments
    .filter((payment) => payment.accountId === accountId && !payment.reversal)
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  const open = own.filter(isOpen);
  return {
    owedCents: open.reduce((sum, invoice) => sum + invoice.balanceCents, 0),
    pastDueCents: open
      .filter((invoice) => isPastDue(invoice, today))
      .reduce((sum, invoice) => sum + invoice.balanceCents, 0),
    unappliedCents: live.reduce((sum, payment) => sum + payment.unallocatedCents, 0),
    openCount: open.length,
    lastPayment: live[0] ?? null,
  };
}

export type AttentionKind = "Past due" | "To allocate";
export interface Attention {
  key: string;
  kind: AttentionKind;
  text: string;
  /** Where the action leads: an invoice reference, a payment id or an account id. */
  target: { type: "invoice" | "payment" | "account"; id: string };
  action: string;
  accountId: string;
}

const nameOf = (accounts: AccountSummary[], id: string) =>
  accounts.find((item) => item.id === id)?.name ?? "Account";

/** What needs a person. Billing only raises these; it never changes anyone's access. */
export function attention(
  accounts: AccountSummary[],
  invoices: Invoice[],
  payments: Payment[],
  today: string,
): Attention[] {
  const items: Attention[] = [];
  const late = invoices
    .filter((invoice) => isPastDue(invoice, today) && invoice.number)
    .sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""));
  for (const invoice of late) {
    const days = daysPastDue(invoice, today);
    items.push({
      key: `late-${invoice.id}`,
      kind: "Past due",
      text: `${nameOf(accounts, invoice.accountId)}: ${invoice.number} is ${days} ${days === 1 ? "day" : "days"} late, with ${formatCents(invoice.balanceCents)} open.${invoice.issuedVia === "stripe" ? " Stripe sent this one." : ""}`,
      target: { type: "invoice", id: invoice.number! },
      action: "Open invoice",
      accountId: invoice.accountId,
    });
  }
  for (const payment of payments.filter((item) => !item.reversal && item.unallocatedCents > 0)) {
    items.push({
      key: `unapplied-${payment.id}`,
      kind: "To allocate",
      text: `${nameOf(accounts, payment.accountId)}: ${formatCents(payment.unallocatedCents)} of ${paymentLabel(payment)} is not applied to an invoice yet.`,
      target: { type: "payment", id: payment.id },
      action: "Allocate",
      accountId: payment.accountId,
    });
  }
  return items;
}

/** The follow-ups Today shows, worked out from the records. */
export function billingFollowUps(
  accounts: AccountSummary[],
  invoices: Invoice[],
  payments: Payment[],
  today: string,
) {
  return attention(accounts, invoices, payments, today).map((item) => {
    const account = nameOf(accounts, item.accountId);
    const invoice =
      item.target.type === "invoice" ? invoices.find((i) => i.number === item.target.id) : undefined;
    const payment =
      item.target.type === "payment" ? payments.find((p) => p.id === item.target.id) : undefined;
    return {
      key: item.key,
      account,
      target: item.target,
      action: invoice
        ? `Chase ${invoice.number}: ${formatCents(invoice.balanceCents)} open, ${daysPastDue(invoice, today)} ${daysPastDue(invoice, today) === 1 ? "day" : "days"} late`
        : `Apply the ${formatCents(payment?.unallocatedCents ?? 0)} left from ${payment ? paymentLabel(payment) : "a payment"}`,
    };
  });
}

export function paymentLabel(payment: Payment): string {
  const method = METHOD_LABEL[payment.method];
  if (payment.method === "check" && payment.reference)
    return `check ${payment.reference.replace(/^No\.?\s*/i, "")}`;
  return payment.reference ? `${method.toLowerCase()} ${payment.reference}` : method.toLowerCase();
}

/** The sentence a journal event reads as in a timeline. */
export function describeEvent(event: JournalEvent): string {
  const money = event.amountCents === undefined ? "" : formatCents(event.amountCents);
  switch (event.action) {
    case "invoice.issued":
      return `Issued ${event.invoiceNumber} for ${money}.`;
    case "invoice.drafted":
      return `Saved a draft invoice for ${money}.`;
    case "invoice.voided":
      return `Voided ${event.invoiceNumber}${event.reason ? `: ${event.reason}` : ""}.`;
    case "invoice.written_off":
      return `Wrote off ${event.invoiceNumber}${event.reason ? `: ${event.reason}` : ""}.`;
    case "invoice.past_due":
      return `${event.invoiceNumber} went past due. Follow-up created.`;
    case "payment.recorded":
      return `Recorded ${event.paymentLabel} for ${money}.${event.appliedCents ? ` Applied ${formatCents(event.appliedCents)}${event.invoiceNumber ? ` to ${event.invoiceNumber}` : ""}.` : ""}`;
    case "payment.allocated":
      return `Applied ${money} of ${event.paymentLabel}${event.invoiceNumber ? ` to ${event.invoiceNumber}` : ""}.`;
    case "payment.reversed":
      return `Reversed ${event.paymentLabel} for ${money}${event.reason ? `: ${event.reason}` : ""}.`;
    case "issuer.saved":
      return "Changed the billing settings.";
    case "profile.saved":
      return event.detail ?? "Changed the billing profile.";
  }
}

export function eventTone(event: JournalEvent): "good" | "info" | "alert" | "quiet" {
  if (["payment.recorded", "payment.allocated"].includes(event.action)) return "good";
  if (["invoice.issued", "invoice.drafted"].includes(event.action)) return "info";
  if (
    ["invoice.past_due", "payment.reversed", "invoice.written_off", "invoice.voided"].includes(event.action)
  )
    return "alert";
  return "quiet";
}

export interface LedgerRow {
  when: string;
  what: string;
  by: string;
  change: string;
  balanceCents: number;
}

/** How an invoice's balance got where it is: each record that changed it, in order, with the balance after. */
export function ledgerRows(invoice: Invoice, journal: JournalEvent[], payments: Payment[]): LedgerRow[] {
  if (!invoice.issuedAt) return [];
  const steps: Array<{ at: string; row: Omit<LedgerRow, "balanceCents">; delta: number }> = [];
  for (const allocation of payments.flatMap((payment) => payment.allocations)) {
    if (allocation.invoiceId !== invoice.id) continue;
    const reversal = Boolean(allocation.reversal_of);
    steps.push({
      at: allocation.at,
      delta: reversal ? allocation.amountCents : -allocation.amountCents,
      row: {
        when: allocation.at.slice(0, 10),
        what: `${capital(allocation.paymentLabel)} ${reversal ? "reversed" : "applied"}`,
        by: allocation.by,
        change: `${reversal ? "+" : "−"} ${formatCents(allocation.amountCents)}`,
      },
    });
  }
  for (const event of journal) {
    if (event.invoiceNumber !== invoice.number) continue;
    if (event.action === "invoice.written_off" || event.action === "invoice.voided")
      steps.push({
        at: event.at,
        delta: event.action === "invoice.voided" ? Number.NEGATIVE_INFINITY : 0,
        row: {
          when: event.at.slice(0, 10),
          what: `${event.action === "invoice.voided" ? "Voided" : "Written off"}${event.reason ? `: ${event.reason}` : ""}`,
          by: event.actor,
          change: "—",
        },
      });
  }
  steps.sort((a, b) => a.at.localeCompare(b.at));
  const issued = journal.find(
    (event) => event.action === "invoice.issued" && event.invoiceNumber === invoice.number,
  );
  const rows: LedgerRow[] = [
    {
      when: invoice.issuedAt,
      what: "Invoice issued",
      by: issued?.actor ?? "",
      change: formatCents(invoice.totalCents),
      balanceCents: invoice.totalCents,
    },
  ];
  let balance = invoice.totalCents;
  for (const step of steps) {
    balance = step.delta === Number.NEGATIVE_INFINITY ? 0 : balance + step.delta;
    rows.push({ ...step.row, balanceCents: balance });
  }
  return rows;
}
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The invoice already billing this period, if any. A second one for the same period is refused. */
export function existingForPeriod(
  accountId: string,
  period: string,
  invoices: Invoice[],
): Invoice | undefined {
  return invoices.find(
    (invoice) =>
      invoice.accountId === accountId &&
      invoice.period === period &&
      invoice.number &&
      !["void", "draft"].includes(invoice.status),
  );
}

/** Applies a payment to the oldest invoices first, each up to its balance. */
export function oldestFirst(amountCents: number, invoices: Invoice[]): Map<string, number> {
  const result = new Map<string, number>();
  let remaining = amountCents;
  for (const invoice of [...invoices].sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""))) {
    const share = Math.min(remaining, invoice.balanceCents);
    if (share > 0) result.set(invoice.id, share);
    remaining -= share;
  }
  return result;
}

export function sumAllocations(
  allocations: Array<Pick<Allocation | AllocationInput, "amountCents">>,
): number {
  return allocations.reduce((sum, allocation) => sum + allocation.amountCents, 0);
}

/** The next period (`YYYY-MM`) after `today`'s month, and the current one, newest first. */
export function periodChoices(today: string): string[] {
  const current = today.slice(0, 7);
  const next = addDays(`${current}-01`, 32).slice(0, 7);
  return [next, current];
}
export function periodLabel(period: string): string {
  return new Date(`${period}-01T12:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
