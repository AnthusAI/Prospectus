import { createHash } from "node:crypto";
import { IdentityFileError, type IdentityFiles, type IdentityObject } from "../accounts/identity-files";
import { UUID_PATTERN, type Context } from "../accounts/model";
import { quotaAdministrationGrant, type OperatorGrant } from "../accounts/operator-policy";
import { matchesStringPattern } from "../accounts/validation-rules";
import {
  DEFAULT_MAXIMUM_HOLD_SECONDS,
  DOCUMENT_BYTE_BUDGET,
  MAXIMUM_AUDIT_ENTRIES,
  QUOTA_UNIT,
  fail,
  isExpired,
  type Hold,
  type QuotaAction,
  type QuotaActor,
  type QuotaAllowance,
  type QuotaJournalEvent,
} from "./model";
import type { QuotaSummary, QuotaView } from "../packages/accounts-client/src/quota";

/** What quota needs to know about an account: whether it exists and which products it is entitled to. */
export type AccountReader = (
  accountId: string,
) => Promise<{ entitlements: Record<string, { status: string }> } | null>;

export const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const allowancePath = (accountId: string) => `allowances/${accountId}.json`;
export const journalPath = (eventId: string) => `journal/${eventId}.json`;

export const requireAccountId = (value: unknown) =>
  matchesStringPattern(value, UUID_PATTERN)
    ? value.toLowerCase()
    : fail(400, "invalid_account", "Account UUID required.");
export const requireOperationId = (value: unknown) =>
  matchesStringPattern(value, UUID_PATTERN)
    ? value.toLowerCase()
    : fail(400, "invalid_operation_id", "UUID operation ID required.");
export const requireReservationId = (value: unknown) =>
  matchesStringPattern(value, UUID_PATTERN)
    ? value.toLowerCase()
    : fail(400, "invalid_reservation", "UUID reservation ID required.");
/** Whole cents. Nothing fractional, negative or beyond what an integer sum can hold exactly. */
const cents = (value: unknown, minimum: number, code: string, message: string): number =>
  Number.isSafeInteger(value) && (value as number) >= minimum ? (value as number) : fail(400, code, message);
const sum = (left: number, right: number) =>
  Number.isSafeInteger(left + right) ? left + right : fail(409, "quota_capacity", "Amount is too large.");

async function commitWithRetry<T>(
  files: IdentityFiles,
  path: string,
  operationId: string,
  requestHash: string,
  value: T,
  revision: string | null,
): Promise<IdentityObject<T>> {
  // Retry only the same frozen intent; never invent a replacement operation while publication may be in flight.
  for (let attempt = 0; ; attempt++)
    try {
      return await files.commit(path, operationId, requestHash, value, revision);
    } catch (error) {
      if (
        !(error instanceof IdentityFileError && ["uncertain", "unavailable"].includes(error.code)) ||
        attempt >= 3
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
    }
}

const blank = (accountId: string, operationId: string, at: string): QuotaAllowance => ({
  version: 1,
  kind: "quota-allowance",
  accountId,
  unit: QUOTA_UNIT,
  allowanceCents: 0,
  usedCents: 0,
  overageCents: 0,
  usedByProduct: {},
  holds: {},
  revision: 0,
  creation: { operationId, at },
  audit: [],
});

const heldBy = (allowance: QuotaAllowance, nowMs: number) => {
  const held: Record<string, number> = {};
  for (const hold of Object.values(allowance.holds))
    if (!isExpired(hold, nowMs)) held[hold.product] = (held[hold.product] ?? 0) + hold.maxCents;
  return held;
};
const remainingOf = (allowance: QuotaAllowance, nowMs: number) =>
  allowance.allowanceCents -
  allowance.usedCents -
  Object.values(heldBy(allowance, nowMs)).reduce((total, amount) => total + amount, 0);

/** The effect of one operation on an allowance: the next document and the result a repeat returns. */
interface Applied {
  next: QuotaAllowance;
  result: Record<string, unknown>;
  /** Expired holds dropped from the document to make room; each is journaled before the document is written. */
  expired: Array<[string, Hold]>;
  /** The operation was already in the document; only the result is needed. */
  unchanged?: boolean;
}
interface Operation {
  action: QuotaAction;
  accountId: string;
  reservationId?: string;
  operationId: string;
  actor: QuotaActor;
  /** The normalized client request. The same operation ID with another request is an idempotency conflict. */
  request: unknown;
  apply: (current: QuotaAllowance | null, nowMs: number, at: string) => Applied;
}

export interface QuotaCaller {
  product: string;
}
export interface QuotaOptions {
  maximumHoldSeconds?: number;
}

/**
 * The account's quota. Every refusal path writes nothing, and every failure to read or write is an error, never a
 * success: an unknown account, a missing allowance or an unavailable store all mean the caller may not spend.
 *
 * Money lives in one conditional-write document per account, so concurrent reservations cannot together exceed the
 * allowance: the loser re-reads and is checked against what the winner held. Each mutation then writes one journal
 * event that carries the operation's result, which is how a retry gets the original answer.
 */
export class Quota {
  private maximumHoldSeconds: number;
  constructor(
    private files: IdentityFiles,
    private accounts: AccountReader,
    private grants: readonly OperatorGrant[],
    private now: () => string,
    options: QuotaOptions = {},
  ) {
    this.maximumHoldSeconds = options.maximumHoldSeconds ?? DEFAULT_MAXIMUM_HOLD_SECONDS;
    if (!Number.isSafeInteger(this.maximumHoldSeconds) || this.maximumHoldSeconds < 1)
      throw new Error("The maximum hold lifetime must be a whole number of seconds.");
  }

  /** Holds quota for one job. Succeeds only if the account's remaining quota covers `maxCents`. */
  async reserve(
    caller: QuotaCaller,
    accountIdInput: unknown,
    input: { operationId?: unknown; maxCents?: unknown; expiresInSeconds?: unknown },
  ) {
    const accountId = requireAccountId(accountIdInput),
      reservationId = requireOperationId(input.operationId),
      maxCents = cents(
        input.maxCents,
        1,
        "invalid_amount",
        "The reservation maximum must be whole cents above zero.",
      ),
      expiresInSeconds = cents(
        input.expiresInSeconds,
        1,
        "invalid_expiry",
        "The reservation lifetime must be whole seconds above zero.",
      );
    if (expiresInSeconds > this.maximumHoldSeconds)
      fail(400, "invalid_expiry", "The reservation lifetime is longer than this service allows.");
    const account = await this.accounts(accountId);
    if (!account) fail(404, "account_missing", "Account not found.");
    if (account.entitlements[caller.product]?.status !== "active")
      fail(403, "product_not_entitled", "The account is not entitled to this product.");
    return this.run({
      action: "reservation.reserved",
      accountId,
      reservationId,
      operationId: reservationId,
      actor: `product:${caller.product}`,
      request: { maxCents, expiresInSeconds },
      apply: (current, nowMs, at) => {
        if (!current) fail(403, "no_allowance", "The account has no quota allowance.");
        const requestHash = hash(["quota-hold-v1", accountId, caller.product, maxCents, expiresInSeconds]);
        const expiresAt = new Date(nowMs + expiresInSeconds * 1000).toISOString();
        const existing = current.holds[reservationId];
        const result = (hold: Pick<Hold, "maxCents" | "expiresAt">) => ({
          reservationId,
          accountId,
          status: "reserved",
          maxCents: hold.maxCents,
          expiresAt: hold.expiresAt,
        });
        if (existing) {
          if (existing.requestHash !== requestHash || existing.product !== caller.product)
            idempotencyConflict();
          return { next: current, result: result(existing), expired: [], unchanged: true };
        }
        if (maxCents > remainingOf(current, nowMs))
          fail(402, "quota_insufficient", "The account's remaining quota does not cover this reservation.");
        const hold: Hold = { product: caller.product, maxCents, reservedAt: at, expiresAt, requestHash };
        const next = structuredClone(current);
        next.holds[reservationId] = hold;
        const expired = makeRoom(next, nowMs);
        return { next, result: result(hold), expired };
      },
    });
  }

  /** Charges the actual cost of a reserved job and releases the rest. Past the reservation, or past its expiry, the
   * cost is recorded only when the caller explicitly acknowledges the overage. */
  async settle(
    caller: QuotaCaller,
    accountIdInput: unknown,
    reservationIdInput: unknown,
    input: { operationId?: unknown; actualCents?: unknown; allowOverage?: unknown },
  ) {
    const accountId = requireAccountId(accountIdInput),
      reservationId = requireReservationId(reservationIdInput),
      operationId = requireOperationId(input.operationId),
      actualCents = cents(input.actualCents, 0, "invalid_amount", "The actual cost must be whole cents."),
      allowOverage = input.allowOverage === undefined ? false : input.allowOverage;
    if (typeof allowOverage !== "boolean")
      fail(400, "invalid_overage", "allowOverage must be true or false.");
    return this.run({
      action: "reservation.settled",
      accountId,
      reservationId,
      operationId,
      actor: `product:${caller.product}`,
      request: { actualCents, allowOverage },
      apply: (current, nowMs) => {
        const hold = current?.holds[reservationId];
        if (!current || !hold)
          fail(409, "reservation_not_open", "The reservation is unknown, closed or reclaimed.");
        if (hold.product !== caller.product)
          fail(403, "wrong_product", "The reservation belongs to another product.");
        const expired = isExpired(hold, nowMs);
        // An expired hold no longer covers anything, so the whole cost is overage.
        const overageCents = expired ? actualCents : Math.max(0, actualCents - hold.maxCents);
        if (overageCents > 0 && !allowOverage)
          expired
            ? fail(
                409,
                "reservation_expired",
                "The reservation expired; settle with allowOverage to record the cost.",
              )
            : fail(
                409,
                "exceeds_reservation",
                "The cost is above the reservation; settle with allowOverage to record it.",
              );
        const next = structuredClone(current);
        delete next.holds[reservationId];
        next.usedCents = sum(next.usedCents, actualCents);
        next.overageCents = sum(next.overageCents, overageCents);
        next.usedByProduct[hold.product] = sum(next.usedByProduct[hold.product] ?? 0, actualCents);
        const releasedCents = expired ? 0 : Math.max(0, hold.maxCents - actualCents);
        return {
          next,
          expired: [],
          result: {
            reservationId,
            accountId,
            status: expired ? "settled_late" : "settled",
            chargedCents: actualCents,
            releasedCents,
            overageCents,
          },
        };
      },
    });
  }

  /** Returns everything a reservation held. Nothing is charged. */
  async release(
    caller: QuotaCaller,
    accountIdInput: unknown,
    reservationIdInput: unknown,
    input: { operationId?: unknown },
  ) {
    const accountId = requireAccountId(accountIdInput),
      reservationId = requireReservationId(reservationIdInput),
      operationId = requireOperationId(input.operationId);
    return this.run({
      action: "reservation.released",
      accountId,
      reservationId,
      operationId,
      actor: `product:${caller.product}`,
      request: {},
      apply: (current) => {
        const hold = current?.holds[reservationId];
        if (!current || !hold)
          fail(409, "reservation_not_open", "The reservation is unknown, closed or reclaimed.");
        if (hold.product !== caller.product)
          fail(403, "wrong_product", "The reservation belongs to another product.");
        const next = structuredClone(current);
        delete next.holds[reservationId];
        return {
          next,
          expired: [],
          result: { reservationId, accountId, status: "released", releasedCents: hold.maxCents },
        };
      },
    });
  }

  /** Operator grant: sets the account's total allowance. Lowering it below what is used and held is allowed and
   * leaves remaining quota negative, so new reservations are refused until it is raised again. */
  async grant(
    operator: Context,
    accountIdInput: unknown,
    input: { operationId?: unknown; allowanceCents?: unknown },
  ) {
    const accountId = requireAccountId(accountIdInput),
      operationId = requireOperationId(input.operationId),
      allowanceCents = cents(
        input.allowanceCents,
        0,
        "invalid_amount",
        "The allowance must be whole cents, zero or more.",
      );
    const authority = quotaAdministrationGrant(operator, this.grants);
    if (!authority) fail(403, "operator_forbidden", "Explicit central quota permission is required.");
    if (!(await this.accounts(accountId))) fail(404, "account_missing", "Account not found.");
    return this.run({
      action: "allowance.granted",
      accountId,
      operationId,
      actor: `operator:${authority.reviewedGrantId}`,
      request: { allowanceCents },
      apply: (current, _nowMs, at) => {
        const next = structuredClone(current ?? blank(accountId, operationId, at));
        next.allowanceCents = allowanceCents;
        return { next, expired: [], result: { accountId, unit: QUOTA_UNIT, allowanceCents } };
      },
    });
  }

  /** The account's numbers for the CRM and the portal, or null when it has no allowance record. */
  async summary(accountIdInput: unknown): Promise<QuotaSummary | null> {
    const accountId = requireAccountId(accountIdInput);
    const stored = await this.files.get<QuotaAllowance>(allowancePath(accountId));
    if (!stored) return null;
    const allowance = stored.value,
      nowMs = Date.parse(this.now()),
      held = heldBy(allowance, nowMs);
    const products = new Set([...Object.keys(allowance.usedByProduct), ...Object.keys(held)]);
    return {
      unit: QUOTA_UNIT,
      allowanceCents: allowance.allowanceCents,
      usedCents: allowance.usedCents,
      heldCents: Object.values(held).reduce((total, amount) => total + amount, 0),
      overageCents: allowance.overageCents,
      remainingCents: remainingOf(allowance, nowMs),
      byProduct: [...products].sort().map((product) => ({
        product,
        usedCents: allowance.usedByProduct[product] ?? 0,
        heldCents: held[product] ?? 0,
      })),
    };
  }

  /** The directory's view: an unreadable store is `unavailable`, never an empty or unlimited quota. */
  async view(accountId: string): Promise<QuotaView> {
    try {
      const summary = await this.summary(accountId);
      return summary ? { state: "set", ...summary } : { state: "none" };
    } catch {
      return { state: "unavailable" };
    }
  }

  private async run(operation: Operation): Promise<{ result: Record<string, unknown>; replayed: boolean }> {
    const requestHash = hash([
      "quota-request-v1",
      operation.action,
      operation.accountId,
      operation.reservationId ?? null,
      operation.actor,
      operation.request,
    ]);
    const eventId = hash(["quota-journal-v1", operation.accountId, operation.action, operation.operationId]);
    const event = (
      applied: Pick<Applied, "result">,
      beforeRevision: number | null,
      afterRevision: number | null,
      at: string,
    ): QuotaJournalEvent => ({
      version: 1,
      kind: "quota-journal-event",
      eventId,
      action: operation.action,
      accountId: operation.accountId,
      ...(operation.reservationId ? { reservationId: operation.reservationId } : {}),
      operationId: operation.operationId,
      requestHash,
      actor: operation.actor,
      beforeRevision,
      afterRevision,
      result: applied.result,
      at,
    });
    let transient = 0;
    for (let attempt = 0; attempt < 12; attempt++) {
      const journaled = await this.files.get<QuotaJournalEvent>(journalPath(eventId));
      if (journaled) {
        if (journaled.value.requestHash !== requestHash) idempotencyConflict();
        return { result: journaled.value.result, replayed: true };
      }
      const stored = await this.files.get<QuotaAllowance>(allowancePath(operation.accountId)),
        current = stored?.value ?? null;
      const at = this.now(),
        nowMs = Date.parse(at);
      const prior = current?.audit.find(
        (entry) => entry.operationId === operation.operationId && entry.action === operation.action,
      );
      if (prior) {
        // Committed before its journal event was written: finish the journal, then answer as a replay.
        if (prior.requestHash !== requestHash) idempotencyConflict();
        await this.record(
          eventId,
          requestHash,
          event(prior, prior.revision - 1 || null, prior.revision, prior.at),
        );
        return { result: prior.result, replayed: true };
      }
      const applied = operation.apply(current, nowMs, at);
      if (applied.unchanged) {
        await this.record(
          eventId,
          requestHash,
          event(applied, current?.revision ?? null, current?.revision ?? null, at),
        );
        return { result: applied.result, replayed: true };
      }
      const baseRevision = current?.revision ?? 0;
      const next = applied.next;
      next.revision = baseRevision + 1;
      next.audit = [
        ...next.audit,
        {
          revision: next.revision,
          action: operation.action,
          operationId: operation.operationId,
          requestHash,
          actor: operation.actor,
          result: applied.result,
          at,
        },
      ].slice(-MAXIMUM_AUDIT_ENTRIES);
      if (Buffer.byteLength(JSON.stringify(next)) > DOCUMENT_BYTE_BUDGET)
        fail(409, "quota_capacity", "The account's quota record is full of active reservations.");
      // Expiry is a fact of time, so journaling it before the document changes is safe, and repeating it is harmless.
      for (const [expiredId, hold] of applied.expired)
        await this.recordExpiry(operation.accountId, expiredId, hold, at);
      try {
        await commitWithRetry(
          this.files,
          allowancePath(operation.accountId),
          `quota:${eventId}:${baseRevision}`,
          hash(["quota-storage-v1", requestHash, baseRevision]),
          next,
          stored?.revision ?? null,
        );
      } catch (error) {
        if (error instanceof IdentityFileError && ["conflict", "operation_mismatch"].includes(error.code))
          continue;
        // Publication contention or a lost response: the commit may have landed. Look again before deciding; the
        // same storage operation ID makes writing it a second time return the first outcome.
        if (
          error instanceof IdentityFileError &&
          ["uncertain", "unavailable"].includes(error.code) &&
          ++transient <= 5
        ) {
          await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** transient));
          continue;
        }
        throw error;
      }
      await this.record(
        eventId,
        requestHash,
        event(applied, current ? baseRevision : null, next.revision, at),
      );
      return { result: applied.result, replayed: false };
    }
    fail(409, "busy", "Concurrent quota change; retry with the same operation ID.");
  }

  private async record(eventId: string, requestHash: string, event: QuotaJournalEvent) {
    try {
      await commitWithRetry(
        this.files,
        journalPath(eventId),
        `quota:journal:${eventId}`,
        requestHash,
        event,
        null,
      );
    } catch (error) {
      if (!(error instanceof IdentityFileError && ["conflict", "operation_mismatch"].includes(error.code)))
        throw error;
      const existing = await this.files.get<QuotaJournalEvent>(journalPath(eventId));
      if (existing?.value.requestHash !== requestHash) idempotencyConflict();
    }
  }

  private async recordExpiry(accountId: string, reservationId: string, hold: Hold, at: string) {
    const eventId = hash(["quota-expiry-v1", accountId, reservationId]);
    const requestHash = hash(["quota-expiry-request-v1", accountId, reservationId, hold.expiresAt]);
    await this.record(eventId, requestHash, {
      version: 1,
      kind: "quota-journal-event",
      eventId,
      action: "reservation.expired",
      accountId,
      reservationId,
      operationId: reservationId,
      requestHash,
      actor: "system",
      beforeRevision: null,
      afterRevision: null,
      result: {
        reservationId,
        accountId,
        status: "expired",
        maxCents: hold.maxCents,
        expiresAt: hold.expiresAt,
      },
      at,
    });
  }
}

/** Drops the oldest expired holds until the document fits its byte budget, and returns them for journaling. Active
 * holds are never dropped. */
function makeRoom(allowance: QuotaAllowance, nowMs: number): Array<[string, Hold]> {
  const dropped: Array<[string, Hold]> = [];
  const expired = Object.entries(allowance.holds)
    .filter(([, hold]) => isExpired(hold, nowMs))
    .sort(([, left], [, right]) => left.expiresAt.localeCompare(right.expiresAt));
  // Leave headroom for the audit entry and journal fields added after this point.
  while (Buffer.byteLength(JSON.stringify(allowance)) > DOCUMENT_BYTE_BUDGET - 4096 && expired.length) {
    const [id, hold] = expired.shift()!;
    delete allowance.holds[id];
    dropped.push([id, hold]);
  }
  return dropped;
}

function idempotencyConflict(): never {
  fail(409, "idempotency_conflict", "Operation ID belongs to a different quota request.");
}
