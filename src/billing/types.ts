/**
 * The records and routes of the billing ledger, as docs/BILLING.md describes them. The ledger and its routes
 * are not built yet (kanbus-ffdad5, kanbus-0f125f): nothing in the console may invent figures in their place.
 * Every amount is an integer number of US cents. Dates are `YYYY-MM-DD`; instants are ISO 8601.
 */

export const BILLING_PERMISSION = "accounts:admin:billing";

export type InvoiceStatus = "draft" | "issued" | "partially_paid" | "paid" | "void" | "uncollectible";
export type IssuedVia = "stripe" | "manual";
export type ExternalPaymentMethod = "bank_transfer" | "check" | "venmo" | "cash" | "other";
export type PaymentMethod = ExternalPaymentMethod | "stripe_card" | "stripe_bank";
export const EXTERNAL_METHODS: readonly ExternalPaymentMethod[] = [
  "check",
  "bank_transfer",
  "venmo",
  "cash",
  "other",
];
export type LineStatus = "pending" | "active" | "paused" | "ended";

export interface InvoiceLineItem {
  description: string;
  quantity: number;
  unitAmountCents: number;
  /** The billing line this item bills, when it bills one. */
  billingLine?: string;
  product?: string;
  /** Service dates, as typed or as the period gives them. */
  period?: string;
}

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

/** An allocation of one payment to one invoice. A reversal names the allocation it undoes. */
export interface Allocation {
  id: string;
  paymentId: string;
  invoiceId: string;
  invoiceNumber: string | null;
  amountCents: number;
  /** When it was made, who made it, and the payment as people name it ("check 1042"). */
  at: string;
  by: string;
  paymentLabel: string;
  reversal_of?: string;
}

export interface Invoice {
  id: string;
  accountId: string;
  /** `YYYYMM-NNN`, assigned at issue. A draft has none. */
  number: string | null;
  currency: "usd";
  lineItems: InvoiceLineItem[];
  subtotalCents: number;
  totalCents: number;
  issuedVia: IssuedVia;
  stripeInvoiceId?: string;
  issuedAt: string | null;
  dueAt: string | null;
  paidAt?: string | null;
  netTermsDays: number;
  status: InvoiceStatus;
  /** `YYYY-MM` when this is the account's invoice for a billing period. */
  period?: string;
  creditsCents: number;
  /** Derived by the server from the records on every write: total minus allocations minus credits. */
  balanceCents: number;
  /** Copied from the issuer record when issued, so a later change never alters an issued invoice. */
  issuer?: IssuerBlock;
  paymentMethods?: AcceptedPaymentMethod[];
  billToContactMasked?: string;
  revision: number;
}

export interface Payment {
  id: string;
  accountId: string;
  amountCents: number;
  currency: "usd";
  method: PaymentMethod;
  receivedAt: string;
  reference?: string;
  /** The admin's operator grant id, or `stripe-webhook`, as a name people recognise. */
  recordedBy: string;
  note?: string;
  unallocatedCents: number;
  allocations: Allocation[];
  /** Set on a payment that was reversed, with who, when and why. */
  reversal?: { at: string; by: string; reason: string };
  revision: number;
}

export interface BillingContact {
  name: string;
  email: string;
  address: string;
}

export interface BillingProfile {
  accountId: string;
  mode?: "direct" | "invoiced";
  currency: "usd";
  netTermsDays?: number;
  /** Masked by the server. The full contact is only fetched by `revealContact`. */
  contactMasked: BillingContact;
  paymentMethods?: AcceptedPaymentMethod[];
  status: "active" | "inactive";
  revision: number;
}

export interface BillingLine {
  accountId: string;
  product: string;
  /** The product's display name. */
  name: string;
  planId?: string;
  planName?: string;
  status: LineStatus | "none";
  periodStart?: string;
  periodEnd?: string;
  /** What the plan charges for one period, when the catalog says. Used to prefill an invoice line. */
  unitAmountCents?: number;
}

export type JournalAction =
  | "profile.saved"
  | "invoice.issued"
  | "invoice.drafted"
  | "invoice.voided"
  | "invoice.written_off"
  | "invoice.past_due"
  | "payment.recorded"
  | "payment.allocated"
  | "payment.reversed"
  | "issuer.saved";

export interface JournalEvent {
  id: string;
  at: string;
  /** Who did it: a person, an agent acting for a person, or Billing itself. */
  actor: string;
  action: JournalAction;
  accountId?: string;
  invoiceNumber?: string;
  paymentLabel?: string;
  amountCents?: number;
  appliedCents?: number;
  reason?: string;
  detail?: string;
}

export interface AccountSummary {
  id: string;
  name: string;
  mode?: "direct" | "invoiced";
  billable: boolean;
}

export interface BillingOverview {
  accounts: AccountSummary[];
  invoices: Invoice[];
  payments: Payment[];
}

export interface AccountBilling {
  account: AccountSummary;
  profile: BillingProfile | null;
  lines: BillingLine[];
  invoices: Invoice[];
  payments: Payment[];
  journal: JournalEvent[];
}

export interface InvoiceDetail {
  invoice: Invoice;
  account: AccountSummary;
  journal: JournalEvent[];
  payments: Payment[];
}

export interface PaymentDetail {
  payment: Payment;
  account: AccountSummary;
  /** Open invoices of the account that the remainder could be applied to. */
  openInvoices: Invoice[];
  journal: JournalEvent[];
}

export interface IssuerSettings {
  issuer: IssuerBlock;
  paymentMethods: AcceptedPaymentMethod[];
  defaultNetTermsDays: number;
  nextInvoiceNumber: string;
  /** Names the connection and says whether it is live; never a key. */
  stripe: { connected: boolean; mode?: "test" | "live" };
  revision: number;
}

export interface BillingAccess {
  /** The reviewed operator permissions the server reports for this operator. */
  permissions: string[];
}

export interface RaiseInvoiceInput {
  operationId: string;
  accountId: string;
  /** `YYYY-MM` for a billing period; absent for anything else. */
  period?: string;
  lineItems: InvoiceLineItem[];
  netTermsDays: number;
  issuedVia: IssuedVia;
  /** Keeps it a draft: no number, not sent. */
  draft: boolean;
}

export interface AllocationInput {
  invoiceId: string;
  amountCents: number;
}

export interface RecordPaymentInput {
  operationId: string;
  accountId: string;
  amountCents: number;
  method: ExternalPaymentMethod;
  receivedAt: string;
  reference?: string;
  note?: string;
  allocations: AllocationInput[];
}

export interface ProfileInput {
  operationId: string;
  mode: "direct" | "invoiced";
  netTermsDays?: number;
  expectedRevision?: number;
}

export interface IssuerInput {
  operationId: string;
  issuer: IssuerBlock;
  paymentMethods: AcceptedPaymentMethod[];
  defaultNetTermsDays: number;
  expectedRevision: number;
}

export interface ReasonInput {
  operationId: string;
  reason: string;
  expectedRevision: number;
}

/** A refusal from the billing routes, with the server's own words when it gave them. */
export class BillingError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

/**
 * What the console needs from billing. `available` is false while the routes are not deployed: pages then show
 * the Unavailable note and never call anything else.
 */
export interface BillingClient {
  readonly available: boolean;
  access(): Promise<BillingAccess>;
  overview(): Promise<BillingOverview>;
  account(accountId: string): Promise<AccountBilling>;
  /** `reference` is the invoice number, or the invoice id for a draft. */
  invoice(reference: string): Promise<InvoiceDetail>;
  invoicePdf(reference: string): Promise<Blob>;
  payment(paymentId: string): Promise<PaymentDetail>;
  revealContact(accountId: string): Promise<BillingContact>;
  saveProfile(accountId: string, input: ProfileInput): Promise<BillingProfile>;
  raiseInvoice(input: RaiseInvoiceInput): Promise<Invoice>;
  recordPayment(input: RecordPaymentInput): Promise<Payment>;
  allocate(
    paymentId: string,
    input: { operationId: string; allocations: AllocationInput[]; expectedRevision: number },
  ): Promise<Payment>;
  reversePayment(paymentId: string, input: ReasonInput): Promise<Payment>;
  writeOff(invoiceId: string, input: ReasonInput): Promise<Invoice>;
  voidInvoice(invoiceId: string, input: ReasonInput): Promise<Invoice>;
  issuer(): Promise<IssuerSettings>;
  saveIssuer(input: IssuerInput): Promise<IssuerSettings>;
}
