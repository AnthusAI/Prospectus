import { AccountsError } from "../accounts/model";

/** Billing refusals reuse the accounts error shape, so the refusal log records them by status and code only. Messages
 * never carry billing contact data or any other submitted value. */
export class BillingError extends AccountsError {}
export function fail(status: number, code: string, message: string): never {
  throw new BillingError(status, code, message);
}

/** The billing counterpart of failWith: a broken validation rule becomes a BillingError with the rule's message. */
export const failWith =
  (status: number, code: string, summary: string) =>
  (brokenRuleMessage: string): never =>
    fail(status, code, `${summary}: ${brokenRuleMessage}`);

export const BILLING_CURRENCY = "usd";
export const DEFAULT_NET_TERMS_DAYS = 30;
export const MAXIMUM_AUDIT_ENTRIES = 32;

export const billingModes = ["direct", "invoiced"] as const;
export type BillingMode = (typeof billingModes)[number];
export const planFamilies = ["papyrus", "cyclotron-lab"] as const;
export type PlanFamily = (typeof planFamilies)[number];
export const planIntervals = ["month", "year"] as const;
export type PlanInterval = (typeof planIntervals)[number];
export const lineStatuses = ["pending", "active", "paused", "ended"] as const;
export type LineStatus = (typeof lineStatuses)[number];
/** Every line that is not ended still belongs to the account's current billing mode and subscription. */
export const isOpenLine = (line: { status: LineStatus }) => line.status !== "ended";
export const paymentMethodKinds = [
  "stripe_card",
  "stripe_bank",
  "bank_transfer",
  "check",
  "venmo",
  "melio",
  "cash",
  "other",
] as const;
export type PaymentMethodKind = (typeof paymentMethodKinds)[number];

export interface PostalAddress {
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postalCode: string;
  country: string;
}
/** Billing data as the client supplied it. Never identity: it never finds, matches or authorizes a Person. */
export interface BillingContact {
  name: string;
  email: string;
  address?: PostalAddress;
  taxId?: string;
}

/** The reviewed operator grant that made a change; never a name or email. */
export type BillingActor = string;

export interface AuditEntry {
  revision: number;
  action: BillingAction;
  operationId: string;
  requestHash: string;
  actor: BillingActor;
  at: string;
}
export interface VersionedRecord {
  revision: number;
  creation: { operationId: string; at: string };
  audit: AuditEntry[];
}

export interface BillingProfile extends VersionedRecord {
  version: 1;
  kind: "billing-profile";
  accountId: string;
  /** Absent: not yet billable. */
  mode?: BillingMode;
  currency: typeof BILLING_CURRENCY;
  status: "active";
  stripeCustomerId?: string;
  billingContact: BillingContact;
  /** Absent: the default of 30 days. */
  netTermsDays?: number;
  /** Absent: the issuer's accepted payment methods. */
  paymentMethods?: PaymentMethodKind[];
  /** The account's open lines by product. Opening a line and switching mode both write this record, so neither can
   * slip past the other; absent or empty means no line is open or opening. */
  openLines?: Record<string, OpenLineReservation>;
}

/** Written before a line opens and removed after it ends. While the line file is still missing it is in flight. */
export interface OpenLineReservation {
  /** The create operation that opened the line; the line records it as openedBy. */
  operationId: string;
  interval: PlanInterval;
  reservedAt: string;
}
/** A reservation whose line never appeared after this long is a create that failed, and no longer blocks. */
export const RESERVATION_TIMEOUT_MS = 10 * 60 * 1000;

/** Asks an operator whether to disable the product through the entitlement route. Billing never does it. */
export interface EndedLineFollowUp {
  type: "consider-disabling-product";
  accountId: string;
  product: string;
  /** True while the entitlement is still active, so disabling it is the open question. */
  disableProduct: boolean;
  entitlementStatus: "active" | "disabled" | "missing";
}

export interface BillingLine extends VersionedRecord {
  version: 1;
  kind: "billing-line";
  accountId: string;
  product: string;
  planId: string;
  family: PlanFamily;
  interval: PlanInterval;
  /** The profile mode the line was opened under. */
  mode: BillingMode;
  status: LineStatus;
  /** The create operation that opened this period, matching the profile's open-line reservation. */
  openedBy: string;
  period: { start: string; end?: string };
  stripeSubscriptionItemId?: string;
  endFollowUp?: EndedLineFollowUp;
}

export const billingActions = [
  "profile.set",
  "line.created",
  "line.paused",
  "line.resumed",
  "line.ended",
  "profile.contact_revealed",
  "issuer.set",
  "invoice.drafted",
  "invoice.issued",
  "invoice.entered",
  "invoice.voided",
  "invoice.written_off",
  "credit.recorded",
  "payment.recorded",
  "payment.allocated",
  "payment.reversed",
] as const;
export type BillingAction = (typeof billingActions)[number];

/** One append-only event per billing mutation. Profile and line events carry revisions and ids only. Ledger events
 * add `detail`: ids and integer cents, never contact data, issuer details or payment instructions. */
export interface JournalEvent {
  version: 1;
  kind: "billing-journal-event";
  eventId: string;
  action: BillingAction;
  recordKind: "profile" | "line" | "issuer" | "invoice" | "payment" | "contact";
  recordPath: string;
  /** Absent only for records that belong to no account (the issuer). */
  accountId?: string;
  product?: string;
  operationId: string;
  requestHash: string;
  actor: BillingActor;
  beforeRevision: number | null;
  afterRevision: number;
  /** The storage commit that wrote afterRevision; replaying it returns the original result. */
  storageOperationId: string;
  storageRequestHash: string;
  at: string;
  /** Ledger events: every record the operation wrote, with its revisions. */
  records?: { path: string; beforeRevision: number | null; afterRevision: number }[];
  /** Ledger events: what the operation did, enough to rebuild every balance from the journal. */
  detail?: Record<string, unknown>;
  /** Ledger events: what the operation added to the account's index, so an interrupted finish can be repeated. */
  index?: { invoices?: string[]; payments?: string[] };
}

export type InvoiceStatus = "draft" | "issued" | "partially_paid" | "paid" | "void" | "uncollectible";
/** What a person decided about an invoice. The paid statuses are derived from allocations and credits. */
export type InvoiceLifecycle = "draft" | "issued" | "void" | "uncollectible";

export interface InvoiceLineItem {
  description: string;
  quantity: number;
  unitAmountCents: number;
  /** The billing line (product) this item bills, when it bills one. */
  billingLine?: string;
  product?: string;
  /** Service dates, as typed. */
  period?: string;
}

/** The seller block. Admin-set data in `issuer/0.json`, copied into each invoice when it is issued. */
export interface IssuerBlock {
  legalName: string;
  billingEmail: string;
  addressLines: string[];
  taxId?: string;
  footerNote?: string;
}
export interface AcceptedPaymentMethod {
  label: string;
  instructions: string;
  offered: boolean;
}
export interface IssuerRecord extends VersionedRecord {
  version: 1;
  kind: "billing-issuer";
  issuer: IssuerBlock;
  paymentMethods: AcceptedPaymentMethod[];
  defaultNetTermsDays: number;
}

/** An allocation as the invoice and the payment list it. A reversal's amount is negative and names the original. */
export interface AllocationRef {
  id: string;
  paymentId: string;
  invoiceId: string;
  amountCents: number;
  at: string;
  /** The admin's operator grant id. */
  by: string;
  reversal_of?: string;
}
export interface CreditRef {
  id: string;
  amountCents: number;
  at: string;
}

export interface LedgerInvoice extends VersionedRecord {
  version: 1;
  kind: "billing-invoice";
  id: string;
  accountId: string;
  /** `YYYYMM-NNN`, assigned at issue and never reused. A draft has none. */
  number: string | null;
  currency: typeof BILLING_CURRENCY;
  lineItems: InvoiceLineItem[];
  /** `YYYY-MM` when this is the account's invoice for a billing period. */
  period?: string;
  subtotalCents: number;
  /** No tax lines in the MVP, so the total is the subtotal. */
  totalCents: number;
  issuedVia: "manual";
  /** True when the invoice was issued outside Prospectus and entered with its given number. */
  entered?: true;
  netTermsDays: number;
  issueDate?: string;
  dueDate?: string;
  lifecycle: InvoiceLifecycle;
  /** Recomputed from the references below on every write, and again on every read. */
  status: InvoiceStatus;
  balanceCents: number;
  allocatedCents: number;
  creditsCents: number;
  paidAt?: string;
  allocations: AllocationRef[];
  credits: CreditRef[];
  /** Copied from the issuer record when issued, so a later change never alters an issued invoice or its PDF. */
  issuer?: IssuerBlock;
  paymentMethods?: AcceptedPaymentMethod[];
  closedReason?: string;
  closedAt?: string;
  /** What was still owed when the invoice was written off. Kept apart from outstanding balances. */
  writtenOffCents?: number;
}

export interface LedgerPayment extends VersionedRecord {
  version: 1;
  kind: "billing-payment";
  id: string;
  accountId: string;
  /** Negative on a reversing payment. */
  amountCents: number;
  currency: typeof BILLING_CURRENCY;
  method: PaymentMethodKind;
  receivedAt: string;
  reference?: string;
  note?: string;
  /** The admin's operator grant id; `stripe-webhook` is reserved for the mirror. */
  recordedBy: string;
  /** Recomputed from `allocations` on every write: amount minus the sum of its allocations. */
  unallocatedCents: number;
  allocations: AllocationRef[];
  /** On a reversing payment: the payment it undoes. */
  reversal_of?: string;
  reversalReason?: string;
}

/** Immutable once written. */
export interface LedgerAllocation extends VersionedRecord {
  version: 1;
  kind: "billing-allocation";
  id: string;
  accountId: string;
  paymentId: string;
  invoiceId: string;
  amountCents: number;
  at: string;
  by: string;
  reversal_of?: string;
}
export interface LedgerCredit extends VersionedRecord {
  version: 1;
  kind: "billing-credit";
  id: string;
  accountId: string;
  invoiceId: string;
  amountCents: number;
  reason: string;
  at: string;
  by: string;
}

/** The month's counter. A hint only: the claim files under `numbers/` are what make a number unique. */
export interface InvoiceSequence {
  version: 1;
  kind: "billing-sequence";
  month: string;
  next: number;
}
/** One file per invoice number ever assigned, created with a conditional write so no number is issued twice. */
export interface NumberClaim {
  version: 1;
  kind: "billing-number";
  number: string;
  invoiceId: string;
  accountId: string;
  operationId: string;
}
