/**
 * The shapes the console reads (src/billing/types.ts), built from ledger records. Every figure is recomputed from the
 * records, and the billing contact is masked here: the full contact leaves only through the audited reveal.
 */
import type {
  AccountSummary,
  Allocation,
  BillingLine as LineView,
  BillingProfile as ProfileView,
  Engagement as EngagementView,
  Invoice as InvoiceView,
  JournalAction,
  JournalEvent as JournalView,
  Payment as PaymentView,
} from "../src/billing/types";
import { receivedOnFrom, withDerivedFigures } from "./balances";
import { lastInvoiced, uninvoicedMonth } from "./engagements";
import type { LedgerReader } from "./ledger-engine";
import type {
  BillingContact,
  BillingLine,
  BillingProfile,
  JournalEvent,
  LedgerEngagement,
  LedgerInvoice,
  LedgerPayment,
  PaymentMethodKind,
} from "./model";
import type { BillingPlanCatalog } from "./plans";

const METHOD_NAME: Record<PaymentMethodKind, string> = {
  stripe_card: "card",
  stripe_bank: "bank",
  bank_transfer: "bank transfer",
  check: "check",
  venmo: "Venmo",
  melio: "Melio",
  cash: "cash",
  other: "payment",
};
export const paymentLabel = (payment: Pick<LedgerPayment, "method" | "reference">) =>
  [METHOD_NAME[payment.method], payment.reference].filter(Boolean).join(" ");

const hide = (word: string) =>
  word.length <= 1 ? "•" : `${word[0]}${"•".repeat(Math.min(word.length - 1, 5))}`;
export const maskEmail = (email: string) => {
  const [local, domain = ""] = email.split("@");
  const parts = domain.split(".");
  return `${hide(local)}@${hide(parts[0] ?? "")}.${parts.slice(1).join(".")}`;
};
export const maskContact = (contact: BillingContact) => ({
  name: contact.name.split(/\s+/).map(hide).join(" "),
  email: maskEmail(contact.email),
  address: contact.address
    ? `${hide(contact.address.line1.split(/\s+/)[0] ?? "")}…, ${contact.address.country}`
    : "",
});

export function accountSummary(
  account: { id: string; name: string },
  profile: Pick<BillingProfile, "mode"> | null,
): AccountSummary {
  return {
    id: account.id,
    name: account.name,
    ...(profile?.mode ? { mode: profile.mode } : {}),
    billable: !!profile?.mode,
  };
}

export function invoiceView(
  invoice: LedgerInvoice,
  profile?: BillingProfile | null,
  payments?: readonly LedgerPayment[],
): InvoiceView {
  const figures = withDerivedFigures(invoice, payments ? receivedOnFrom(payments) : undefined);
  return {
    id: figures.id,
    accountId: figures.accountId,
    number: figures.number,
    currency: figures.currency,
    lineItems: figures.lineItems,
    subtotalCents: figures.subtotalCents,
    totalCents: figures.totalCents,
    issuedVia: figures.issuedVia,
    issuedAt: figures.issueDate ?? null,
    dueAt: figures.dueDate ?? null,
    ...(figures.paidAt ? { paidAt: figures.paidAt } : {}),
    netTermsDays: figures.netTermsDays,
    status: figures.status,
    ...(figures.period ? { period: figures.period } : {}),
    creditsCents: figures.creditsCents,
    balanceCents: figures.balanceCents,
    ...(figures.issuer ? { issuer: figures.issuer } : {}),
    ...(figures.paymentMethods ? { paymentMethods: figures.paymentMethods } : {}),
    ...(profile ? { billToContactMasked: maskContact(profile.billingContact).name } : {}),
    revision: figures.revision,
  };
}

/** A payment as the console reads it: the originals only. A reversal shows on the payment it undoes, never as a payment. */
export async function paymentView(
  reader: LedgerReader,
  payment: LedgerPayment,
  reversing: LedgerPayment | null,
): Promise<PaymentView> {
  const numbers = new Map<string, string | null>();
  const numberOf = async (invoiceId: string) => {
    if (!numbers.has(invoiceId)) numbers.set(invoiceId, (await reader.invoice(invoiceId))?.number ?? null);
    return numbers.get(invoiceId)!;
  };
  const allocations: Allocation[] = [];
  for (const [owner, source] of [
    [payment, payment] as const,
    ...(reversing ? [[payment, reversing] as const] : []),
  ])
    for (const ref of source.allocations)
      allocations.push({
        id: ref.id,
        paymentId: owner.id,
        invoiceId: ref.invoiceId,
        invoiceNumber: await numberOf(ref.invoiceId),
        amountCents: ref.amountCents,
        at: ref.at,
        by: ref.by,
        paymentLabel: paymentLabel(payment),
        ...(ref.reversal_of ? { reversal_of: ref.reversal_of } : {}),
      });
  return {
    id: payment.id,
    accountId: payment.accountId,
    amountCents: payment.amountCents,
    currency: payment.currency,
    method: payment.method as PaymentView["method"],
    receivedAt: payment.receivedAt,
    ...(payment.reference ? { reference: payment.reference } : {}),
    recordedBy: payment.recordedBy,
    ...(payment.note ? { note: payment.note } : {}),
    unallocatedCents: reversing ? 0 : payment.unallocatedCents,
    allocations,
    ...(reversing
      ? {
          reversal: {
            at: reversing.audit[0]?.at ?? reversing.receivedAt,
            by: reversing.recordedBy,
            reason: reversing.reversalReason ?? "",
          },
        }
      : {}),
    revision: payment.revision,
  };
}

export function profileView(profile: BillingProfile): ProfileView {
  return {
    accountId: profile.accountId,
    ...(profile.mode ? { mode: profile.mode } : {}),
    currency: profile.currency,
    ...(profile.netTermsDays !== undefined ? { netTermsDays: profile.netTermsDays } : {}),
    contactMasked: maskContact(profile.billingContact),
    ...(profile.paymentMethods
      ? {
          paymentMethods: profile.paymentMethods.map((kind) => ({
            label: METHOD_NAME[kind],
            instructions: "",
            offered: true,
          })),
        }
      : {}),
    status: profile.status,
    revision: profile.revision,
  };
}

export function lineView(line: BillingLine, plans: BillingPlanCatalog): LineView {
  const plan = plans.get(line.planId);
  return {
    accountId: line.accountId,
    product: line.product,
    name: line.product,
    planId: line.planId,
    ...(plan ? { planName: plan.displayName, unitAmountCents: plan.amountCents } : {}),
    status: line.status,
    periodStart: line.period.start,
    ...(line.period.end ? { periodEnd: line.period.end } : {}),
  };
}

const JOURNAL_ACTION: Partial<Record<JournalEvent["action"], JournalAction>> = {
  "profile.set": "profile.saved",
  "issuer.set": "issuer.saved",
  "invoice.drafted": "invoice.drafted",
  "invoice.issued": "invoice.issued",
  "invoice.entered": "invoice.issued",
  "invoice.voided": "invoice.voided",
  "invoice.written_off": "invoice.written_off",
  "payment.recorded": "payment.recorded",
  "payment.allocated": "payment.allocated",
  "payment.reversed": "payment.reversed",
  "engagement.created": "engagement.created",
  "engagement.updated": "engagement.updated",
  "engagement.ended": "engagement.ended",
};

/** The console's timeline entry for an event, or null for events it has no word for (lines, credits, reveals). */
export function journalView(
  event: JournalEvent,
  payments: readonly LedgerPayment[] = [],
): JournalView | null {
  const action = JOURNAL_ACTION[event.action];
  if (!action) return null;
  const detail = (event.detail ?? {}) as Record<string, any>;
  const payment = payments.find((candidate) => candidate.id === detail.paymentId);
  const allocations =
    (detail.allocations as { amountCents: number; invoiceNumber?: string }[] | undefined) ?? [];
  const applied = allocations.reduce((total, entry) => total + entry.amountCents, 0);
  return {
    id: event.eventId,
    at: event.at,
    actor: event.actor,
    action,
    ...(event.accountId ? { accountId: event.accountId } : {}),
    ...(typeof detail.invoiceNumber === "string" ? { invoiceNumber: detail.invoiceNumber } : {}),
    ...(typeof detail.amountCents === "number"
      ? { amountCents: detail.amountCents }
      : typeof detail.totalCents === "number"
        ? { amountCents: detail.totalCents }
        : {}),
    ...(allocations.length ? { appliedCents: applied } : {}),
    ...(typeof detail.invoiceNumber !== "string" && typeof allocations[0]?.invoiceNumber === "string"
      ? { invoiceNumber: allocations[0].invoiceNumber }
      : {}),
    ...(payment
      ? { paymentLabel: paymentLabel(payment) }
      : typeof detail.method === "string"
        ? { paymentLabel: paymentLabel({ method: detail.method as LedgerPayment["method"] }) }
        : event.action.startsWith("payment.")
          ? { paymentLabel: "a payment" }
          : {}),
    ...(typeof detail.reason === "string" ? { reason: detail.reason } : {}),
  };
}

/** An engagement as the console reads it, with when it was last invoiced and any month still waiting. */
export function engagementView(
  engagement: LedgerEngagement,
  invoices: readonly LedgerInvoice[],
  today: string,
): EngagementView {
  const last = lastInvoiced(engagement.id, invoices);
  const waiting = uninvoicedMonth(engagement, invoices, today);
  return {
    id: engagement.id,
    accountId: engagement.accountId,
    name: engagement.name,
    type: engagement.type,
    status: engagement.status,
    lead: engagement.lead,
    startDate: engagement.startDate,
    ...(engagement.endDate ? { endDate: engagement.endDate } : {}),
    ...(engagement.monthlyAmountCents !== undefined
      ? { monthlyAmountCents: engagement.monthlyAmountCents }
      : {}),
    ...(engagement.packagePriceCents !== undefined
      ? { packagePriceCents: engagement.packagePriceCents }
      : {}),
    ...(engagement.lengthWeeks !== undefined ? { lengthWeeks: engagement.lengthWeeks } : {}),
    ...(engagement.stage ? { stage: engagement.stage } : {}),
    ...(last ? { lastInvoiced: last } : {}),
    ...(waiting ? { uninvoicedMonth: waiting } : {}),
    revision: engagement.revision,
  };
}
