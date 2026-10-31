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
}

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
] as const;
export type BillingAction = (typeof billingActions)[number];

/** One append-only event per billing mutation. Revisions and ids only: no contact data and no amounts. */
export interface JournalEvent {
  version: 1;
  kind: "billing-journal-event";
  eventId: string;
  action: BillingAction;
  recordKind: "profile" | "line";
  recordPath: string;
  accountId: string;
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
}
