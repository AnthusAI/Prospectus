import { AccountsError } from "../accounts/model";
import { SHORTEST_WEEK_MS } from "./week";

/** Quota refusals reuse the accounts error shape, so the refusal log records them by status and code only. */
export class QuotaError extends AccountsError {}
export function fail(status: number, code: string, message: string): never {
  throw new QuotaError(status, code, message);
}

export type { BillableItem, OperatorQuotaView, QuotaView } from "../packages/accounts-client/src/quota";

export const MAXIMUM_AUDIT_ENTRIES = 32;
/** One week's record is one 64 KiB document. Expired holds are dropped to make room. */
export const DOCUMENT_BYTE_BUDGET = 65536;
/** A hold is read from its own week and the next, so it must be shorter than the shortest week (167 hours). */
export const MAXIMUM_HOLD_SECONDS_LIMIT = SHORTEST_WEEK_MS / 1000;
/** Longest lifetime a product may ask for unless a deployment configures another (never above the shortest week). */
export const DEFAULT_MAXIMUM_HOLD_SECONDS = 24 * 60 * 60;

export const quotaActions = [
  "settings.changed",
  "reservation.reserved",
  "reservation.settled",
  "reservation.released",
  "reservation.expired",
  "usage.recorded",
  "usage.refused",
] as const;
export type QuotaAction = (typeof quotaActions)[number];

/** `product:<name>` for a registered product, `operator:<reviewed grant id>` for an operator, `system` for expiry. */
export type QuotaActor = string;

/** Usage held for one piece of work. It counts against the week it was taken until it ends. */
export interface Hold {
  product: string;
  /** Internal usage units, never shown to a product or a customer. */
  units: number;
  tableVersion: string;
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

/** `quota/settings/<accountUUID>.json`: which plan an account is on and any per-account allowance override. */
export interface QuotaSettings {
  version: 1;
  kind: "quota-settings";
  accountId: string;
  planId?: string;
  allowanceOverrideUnits?: number;
  revision: number;
  creation: { operationId: string; at: string };
  audit: QuotaAuditEntry[];
}

/**
 * `quota/weeks/<accountUUID>/<week>.json`: one account's usage for one week. It holds aggregates only, so the
 * document's size does not grow with the volume of usage; every individual charge is a journal file instead. Past
 * weeks are never rewritten after their week ends.
 */
export interface QuotaWeek {
  version: 1;
  kind: "quota-week";
  accountId: string;
  /** The week start as a date number: YYYYMMDD of its Saturday in the quota time zone. */
  week: number;
  startsAt: string;
  endsAt: string;
  /** The allowance as last seen by a write this week; null when the account had no allowance. */
  allowanceUnits: number | null;
  usedUnits: number;
  /** Units used beyond the allowance, from usage recorded after the fact. */
  overshootUnits: number;
  usedByProduct: Record<string, number>;
  usedByKind: Record<string, { quantity: number; units: number }>;
  /** Units charged under each version of the rate table, so past usage stays explainable. */
  usedByTableVersion: Record<string, number>;
  /** Active holds taken this week, keyed by reservation ID (the client's reserve operation ID). */
  holds: Record<string, Hold>;
  /** Reservations taken last week and closed this week: closed here so they cannot be closed twice. */
  closedFromPriorWeek: Record<string, string>;
  revision: number;
  creation: { operationId: string; at: string };
  audit: QuotaAuditEntry[];
}

/** One append-only file per mutation, `quota/journal/<eventId>.json`. The result is what a repeat returns. */
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
  /** What was charged and under which table version. Internal: never returned to a product. */
  detail?: Record<string, unknown>;
  at: string;
}

export const isExpired = (hold: Pick<Hold, "expiresAt">, nowMs: number) =>
  nowMs >= Date.parse(hold.expiresAt);
