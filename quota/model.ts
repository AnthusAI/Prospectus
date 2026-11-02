import { AccountsError } from "../accounts/model";

/** Quota refusals reuse the accounts error shape, so the refusal log records them by status and code only. */
export class QuotaError extends AccountsError {}
export function fail(status: number, code: string, message: string): never {
  throw new QuotaError(status, code, message);
}

/** The unit of every amount: integer US cents of cloud cost. There is one allowance per account, shared by every app. */
export { QUOTA_UNIT } from "../packages/accounts-client/src/quota";
import { QUOTA_UNIT } from "../packages/accounts-client/src/quota";
export const MAXIMUM_AUDIT_ENTRIES = 32;
/** The record is one 64 KiB document, like the account document. Expired holds are dropped to make room. */
export const DOCUMENT_BYTE_BUDGET = 65536;
/** Longest lifetime a product may ask for. A hold that is never settled frees its quota at expiry, so the longest hold
 * bounds how long a crashed job can keep quota out of use. A deployment may configure another value. */
export const DEFAULT_MAXIMUM_HOLD_SECONDS = 24 * 60 * 60;

export const quotaActions = [
  "allowance.granted",
  "reservation.reserved",
  "reservation.settled",
  "reservation.released",
  "reservation.expired",
] as const;
export type QuotaAction = (typeof quotaActions)[number];

/** `product:<name>` for a registered product, `operator:<reviewed grant id>` for an operator, `system` for expiry. */
export type QuotaActor = string;

/** Quota held for one job. Active until settled, released or expired; an expired hold keeps its entry (and stops
 * counting) so a late settle can still record what the job really cost. */
export interface Hold {
  product: string;
  maxCents: number;
  reservedAt: string;
  expiresAt: string;
  requestHash: string;
}

export interface QuotaAuditEntry {
  revision: number;
  action: QuotaAction;
  operationId: string;
  requestHash: string;
  actor: QuotaActor;
  result: Record<string, unknown>;
  at: string;
}

/** `quota/allowances/<accountUUID>.json`: the account's one allowance and everything charged against it. */
export interface QuotaAllowance {
  version: 1;
  kind: "quota-allowance";
  accountId: string;
  unit: typeof QUOTA_UNIT;
  /** Total granted by operators, set absolutely. */
  allowanceCents: number;
  /** Total of settled actual costs, overage included. */
  usedCents: number;
  /** The part of usedCents that no reservation covered, each time explicitly acknowledged. */
  overageCents: number;
  usedByProduct: Record<string, number>;
  /** Keyed by reservation ID (the client's reserve operation ID). */
  holds: Record<string, Hold>;
  revision: number;
  creation: { operationId: string; at: string };
  audit: QuotaAuditEntry[];
}

/** One append-only file per mutation, `quota/journal/<eventId>.json`. The result is what a repeat of the operation
 * returns, so a retry never depends on the allowance document still holding it. */
export interface QuotaJournalEvent {
  version: 1;
  kind: "quota-journal-event";
  eventId: string;
  action: QuotaAction;
  accountId: string;
  reservationId?: string;
  operationId: string;
  requestHash: string;
  actor: QuotaActor;
  beforeRevision: number | null;
  afterRevision: number | null;
  result: Record<string, unknown>;
  at: string;
}

export type { QuotaSummary, QuotaView } from "../packages/accounts-client/src/quota";

export const isExpired = (hold: Pick<Hold, "expiresAt">, nowMs: number) =>
  nowMs >= Date.parse(hold.expiresAt);
