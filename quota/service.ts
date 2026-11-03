import { createHash } from "node:crypto";
import { IdentityFileError, type IdentityFiles, type IdentityObject } from "../accounts/identity-files";
import { UUID_PATTERN, type Context } from "../accounts/model";
import { quotaAdministrationGrant, type OperatorGrant } from "../accounts/operator-policy";
import { matchesStringPattern } from "../accounts/validation-rules";
import {
  DEFAULT_MAXIMUM_HOLD_SECONDS,
  DOCUMENT_BYTE_BUDGET,
  MAXIMUM_AUDIT_ENTRIES,
  MAXIMUM_HOLD_SECONDS_LIMIT,
  fail,
  isExpired,
  type BillableItem,
  type Hold,
  type OperatorQuotaView,
  type QuotaAction,
  type QuotaActor,
  type QuotaAuditEntry,
  type QuotaJournalEvent,
  type QuotaSettings,
  type QuotaView,
  type QuotaWeek,
} from "./model";
import { previousWeekKey, weekAt } from "./week";
import {
  PLAN_PATTERN,
  convertItems,
  parseItems,
  unknownItemKinds,
  type RateTable,
  type RateTableSource,
} from "./rate-table";

/** What quota needs to know about an account: whether it exists and which products it is entitled to. */
export type AccountReader = (
  accountId: string,
) => Promise<{ entitlements: Record<string, { status: string }> } | null>;

export const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const settingsPath = (accountId: string) => `settings/${accountId}.json`;
export const weekPath = (accountId: string, week: number) => `weeks/${accountId}/${week}.json`;
export const journalPath = (eventId: string) => `journal/${eventId}.json`;

const uuid = (code: string, message: string) => (value: unknown) =>
  matchesStringPattern(value, UUID_PATTERN) ? value.toLowerCase() : fail(400, code, message);
export const requireAccountId = uuid("invalid_account", "Account UUID required.");
export const requireOperationId = uuid("invalid_operation_id", "UUID operation ID required.");
export const requireReservationId = uuid("invalid_reservation", "UUID reservation ID required.");

const sum = (left: number, right: number) =>
  Number.isSafeInteger(left + right) ? left + right : fail(409, "quota_capacity", "Amount is too large.");

/** Whole percent, 0 to 100. Reaching the allowance is 100; a zero allowance is always 100. */
export function percentOf(units: number, allowance: number): number {
  if (units >= allowance) return 100;
  return Number((BigInt(units) * 100n) / BigInt(allowance));
}

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

interface Versioned {
  revision: number;
  audit: QuotaAuditEntry[];
}
interface Applied<D> {
  next: D;
  result: Record<string, unknown>;
  detail?: Record<string, unknown>;
  /** Expired holds dropped to make room; each is journaled before the document is written. */
  expired?: Array<[string, Hold]>;
  /** The operation was already in the document; only its result is needed. */
  unchanged?: boolean;
}
interface Operation<D extends Versioned, X = undefined> {
  action: QuotaAction;
  path: string;
  accountId: string;
  reservationId?: string;
  operationId: string;
  actor: QuotaActor;
  /** The normalized client request. The same operation ID with another request is an idempotency conflict. */
  request: unknown;
  /** Runs after a repeat has been answered and before anything is applied. */
  prepare?: () => Promise<void>;
  /** Extra reading for each attempt, for example last week's record. */
  load?: () => Promise<X>;
  apply: (current: D | null, nowMs: number, at: string, extra: X) => Applied<D>;
}

export interface QuotaCaller {
  product: string;
}
export interface QuotaOptions {
  maximumHoldSeconds?: number;
}

interface Context_ {
  entitlements: Record<string, { status: string }>;
  table: RateTable;
  settings: QuotaSettings | null;
  /** Units a week allows, or null when no plan and no override gives the account an allowance. */
  allowanceUnits: number | null;
  /** The week start as a date number (YYYYMMDD of its Saturday in the quota time zone). */
  week: number;
  previousWeek: number;
  startsAt: string;
  endsAt: string;
  nowMs: number;
}

/**
 * Weekly quota. An account's allowance applies per week, in Prospectus's own internal usage units, and resets by
 * time alone: every account's week starts at the same instant (Saturday noon in the quota time zone, see week.ts),
 * and a new week simply reads a new record. Customers and products never see units, rates or money; they see a percentage.
 *
 * Products report billable items. Prospectus converts them with a private rate table and charges units, recording the
 * table version with each charge. Two ways to spend: `reserve`, `settle` and `release` for expensive work, and `check`
 * and `record` for high-volume small items. Every refusal path writes nothing, and every failure to read or write is
 * an error, never a success.
 */
export class Quota {
  private maximumHoldSeconds: number;
  constructor(
    private files: IdentityFiles,
    private accounts: AccountReader,
    private grants: readonly OperatorGrant[],
    private now: () => string,
    private table: RateTableSource,
    options: QuotaOptions = {},
  ) {
    this.maximumHoldSeconds = options.maximumHoldSeconds ?? DEFAULT_MAXIMUM_HOLD_SECONDS;
    if (
      !Number.isSafeInteger(this.maximumHoldSeconds) ||
      this.maximumHoldSeconds < 1 ||
      this.maximumHoldSeconds > MAXIMUM_HOLD_SECONDS_LIMIT
    )
      throw new Error("The maximum hold lifetime must be whole seconds, shorter than the shortest week.");
  }

  private async context(accountIdInput: unknown): Promise<Context_ & { accountId: string }> {
    const accountId = requireAccountId(accountIdInput);
    const account = await this.accounts(accountId);
    if (!account) fail(404, "account_missing", "Account not found.");
    const table = await this.table.current();
    const settings = (await this.files.get<QuotaSettings>(settingsPath(accountId)))?.value ?? null;
    const nowMs = Date.parse(this.now());
    const window = weekAt(nowMs);
    const plan = settings?.planId ?? table.defaultPlan;
    const allowanceUnits =
      settings?.allowanceOverrideUnits ??
      (plan !== undefined ? (table.plans[plan]?.weeklyAllowanceUnits ?? null) : null);
    return {
      accountId,
      entitlements: account.entitlements,
      table,
      settings,
      allowanceUnits,
      week: window.key,
      previousWeek: previousWeekKey(nowMs),
      startsAt: window.startsAt,
      endsAt: window.endsAt,
      nowMs,
    };
  }

  private blankWeek(context: Context_ & { accountId: string }, operationId: string, at: string): QuotaWeek {
    return {
      version: 1,
      kind: "quota-week",
      accountId: context.accountId,
      week: context.week,
      startsAt: context.startsAt,
      endsAt: context.endsAt,
      allowanceUnits: context.allowanceUnits,
      usedUnits: 0,
      overshootUnits: 0,
      usedByProduct: {},
      usedByKind: {},
      usedByTableVersion: {},
      holds: {},
      closedFromPriorWeek: {},
      revision: 0,
      creation: { operationId, at },
      audit: [],
    };
  }

  private readWeek(accountId: string, week: number) {
    return this.files.get<QuotaWeek>(weekPath(accountId, week));
  }

  /** Cheap read for high-volume work: may this account start work now? Nothing is written. */
  async check(caller: QuotaCaller, accountIdInput: unknown) {
    const context = await this.context(accountIdInput);
    if (context.entitlements[caller.product]?.status !== "active")
      fail(403, "product_not_entitled", "The account is not entitled to this product.");
    if (context.allowanceUnits === null) fail(403, "no_allowance", "The account has no quota allowance.");
    const week = (await this.readWeek(context.accountId, context.week))?.value ?? null;
    const committed = week ? committedUnits(week, context.nowMs) : 0;
    const percentUsed = percentOf(committed, context.allowanceUnits);
    return { result: { allowed: percentUsed < 100, percentUsed, resetsAt: context.endsAt } };
  }

  /** Holds quota for expensive work. Succeeds only if this week's remaining quota covers the estimated maximum. */
  async reserve(
    caller: QuotaCaller,
    accountIdInput: unknown,
    input: { operationId?: unknown; items?: unknown; expiresInSeconds?: unknown },
  ) {
    const operationId = requireOperationId(input.operationId),
      items = parseItems(input.items, 1),
      expiresInSeconds =
        Number.isSafeInteger(input.expiresInSeconds) && (input.expiresInSeconds as number) >= 1
          ? (input.expiresInSeconds as number)
          : fail(400, "invalid_expiry", "The reservation lifetime must be whole seconds above zero.");
    if (expiresInSeconds > this.maximumHoldSeconds)
      fail(400, "invalid_expiry", "The reservation lifetime is longer than this service allows.");
    const context = await this.context(accountIdInput);
    if (context.entitlements[caller.product]?.status !== "active")
      fail(403, "product_not_entitled", "The account is not entitled to this product.");
    const { accountId } = context;
    return this.run<QuotaWeek>({
      action: "reservation.reserved",
      path: weekPath(accountId, context.week),
      accountId,
      reservationId: operationId,
      operationId,
      actor: `product:${caller.product}`,
      request: { items, expiresInSeconds },
      prepare: () => this.refuseUnknown(context, caller, "reservation.reserved", operationId, items),
      apply: (current, nowMs, at) => {
        if (context.allowanceUnits === null) fail(403, "no_allowance", "The account has no quota allowance.");
        const conversion = convertItems(context.table, items);
        const requestHash = hash(["quota-hold-v2", accountId, caller.product, items, expiresInSeconds]);
        const expiresAt = new Date(nowMs + expiresInSeconds * 1000).toISOString();
        const result = (hold: Pick<Hold, "expiresAt">) => ({
          reservationId: operationId,
          accountId,
          status: "reserved",
          expiresAt: hold.expiresAt,
        });
        const existing = current?.holds[operationId];
        if (existing) {
          if (existing.requestHash !== requestHash || existing.product !== caller.product)
            idempotencyConflict();
          return { next: current!, result: result(existing), unchanged: true };
        }
        const week = current ?? this.blankWeek(context, operationId, at);
        const remaining = context.allowanceUnits - committedUnits(week, nowMs);
        if (remaining <= 0) fail(402, "quota_exhausted", "This week's quota is used up.");
        if (conversion.units > remaining)
          fail(402, "quota_insufficient", "This week's remaining quota does not cover this reservation.");
        const next = structuredClone(week);
        next.allowanceUnits = context.allowanceUnits;
        const hold: Hold = {
          product: caller.product,
          units: conversion.units,
          tableVersion: context.table.version,
          reservedAt: at,
          expiresAt,
          requestHash,
        };
        next.holds[operationId] = hold;
        return {
          next,
          result: result(hold),
          detail: { units: conversion.units, tableVersion: context.table.version, items },
          expired: makeRoom(next, nowMs),
        };
      },
    });
  }

  /** Charges what the work actually used and releases the hold. The charge counts in the week it settles. */
  async settle(
    caller: QuotaCaller,
    accountIdInput: unknown,
    reservationIdInput: unknown,
    input: { operationId?: unknown; items?: unknown },
  ) {
    const reservationId = requireReservationId(reservationIdInput),
      operationId = requireOperationId(input.operationId),
      items = parseItems(input.items, 0);
    const context = await this.context(accountIdInput);
    const { accountId } = context;
    return this.run<QuotaWeek, QuotaWeek | null>({
      action: "reservation.settled",
      path: weekPath(accountId, context.week),
      accountId,
      reservationId,
      operationId,
      actor: `product:${caller.product}`,
      request: { items },
      prepare: () => this.refuseUnknown(context, caller, "reservation.settled", operationId, items),
      load: async () => (await this.readWeek(accountId, context.previousWeek))?.value ?? null,
      apply: (current, _nowMs, at, previous) => {
        let hold = current?.holds[reservationId];
        const fromPriorWeek = !hold && !current?.closedFromPriorWeek[reservationId];
        if (!hold && fromPriorWeek) hold = previous?.holds[reservationId];
        if (!hold) fail(409, "reservation_not_open", "The reservation is unknown, closed or reclaimed.");
        if (hold.product !== caller.product)
          fail(403, "wrong_product", "The reservation belongs to another product.");
        const conversion = convertItems(context.table, items);
        const next = structuredClone(current ?? this.blankWeek(context, operationId, at));
        if (fromPriorWeek) next.closedFromPriorWeek[reservationId] = operationId;
        else delete next.holds[reservationId];
        charge(next, context, caller.product, conversion);
        return {
          next,
          result: { reservationId, accountId, status: "settled" },
          detail: {
            units: conversion.units,
            tableVersion: context.table.version,
            lines: conversion.lines,
            week: context.week,
            fromPriorWeek,
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
    const reservationId = requireReservationId(reservationIdInput),
      operationId = requireOperationId(input.operationId);
    const context = await this.context(accountIdInput);
    const { accountId } = context;
    return this.run<QuotaWeek, QuotaWeek | null>({
      action: "reservation.released",
      path: weekPath(accountId, context.week),
      accountId,
      reservationId,
      operationId,
      actor: `product:${caller.product}`,
      request: {},
      load: async () => (await this.readWeek(accountId, context.previousWeek))?.value ?? null,
      apply: (current, _nowMs, at, previous) => {
        let hold = current?.holds[reservationId];
        const fromPriorWeek = !hold && !current?.closedFromPriorWeek[reservationId];
        if (!hold && fromPriorWeek) hold = previous?.holds[reservationId];
        if (!hold) fail(409, "reservation_not_open", "The reservation is unknown, closed or reclaimed.");
        if (hold.product !== caller.product)
          fail(403, "wrong_product", "The reservation belongs to another product.");
        const next = structuredClone(current ?? this.blankWeek(context, operationId, at));
        if (fromPriorWeek) next.closedFromPriorWeek[reservationId] = operationId;
        else delete next.holds[reservationId];
        next.allowanceUnits = context.allowanceUnits;
        return {
          next,
          result: { reservationId, accountId, status: "released" },
          detail: { week: context.week, fromPriorWeek },
        };
      },
    });
  }

  /** Pay after: records what small, high-volume work actually used. It may take the week past 100%; that overshoot is
   * recorded, the display stays at 100, and the next check or reserve refuses. */
  async record(
    caller: QuotaCaller,
    accountIdInput: unknown,
    input: { operationId?: unknown; items?: unknown },
  ) {
    const operationId = requireOperationId(input.operationId),
      items = parseItems(input.items, 1);
    const context = await this.context(accountIdInput);
    const { accountId } = context;
    return this.run<QuotaWeek>({
      action: "usage.recorded",
      path: weekPath(accountId, context.week),
      accountId,
      operationId,
      actor: `product:${caller.product}`,
      request: { items },
      prepare: () => this.refuseUnknown(context, caller, "usage.recorded", operationId, items),
      apply: (current, _nowMs, at) => {
        const conversion = convertItems(context.table, items);
        const next = structuredClone(current ?? this.blankWeek(context, operationId, at));
        charge(next, context, caller.product, conversion);
        return {
          next,
          result: { accountId, status: "recorded" },
          detail: {
            units: conversion.units,
            tableVersion: context.table.version,
            lines: conversion.lines,
            week: context.week,
            overshootUnits: next.overshootUnits,
          },
        };
      },
    });
  }

  /** Operator: choose the account's plan and/or a per-account weekly allowance override. `null` clears a field. */
  async setAllowance(
    operator: Context,
    accountIdInput: unknown,
    input: { operationId?: unknown; plan?: unknown; allowanceOverrideUnits?: unknown },
  ) {
    const operationId = requireOperationId(input.operationId);
    const authority = quotaAdministrationGrant(operator, this.grants);
    if (!authority) fail(403, "operator_forbidden", "Explicit central quota permission is required.");
    if (input.plan === undefined && input.allowanceOverrideUnits === undefined)
      fail(400, "invalid_settings", "Set a plan, an allowance override, or both.");
    if (input.plan !== undefined && input.plan !== null && !matchesStringPattern(input.plan, PLAN_PATTERN))
      fail(400, "invalid_plan", "A plan name is malformed.");
    const override = input.allowanceOverrideUnits;
    if (
      override !== undefined &&
      override !== null &&
      !(Number.isSafeInteger(override) && (override as number) >= 0)
    )
      fail(400, "invalid_amount", "An allowance override must be whole units, zero or more, or null.");
    const context = await this.context(accountIdInput);
    if (typeof input.plan === "string" && !context.table.plans[input.plan])
      fail(400, "unknown_plan", "That plan is not in the rate table.");
    const { accountId } = context;
    return this.run<QuotaSettings>({
      action: "settings.changed",
      path: settingsPath(accountId),
      accountId,
      operationId,
      actor: `operator:${authority.reviewedGrantId}`,
      request: { plan: input.plan ?? "unchanged", override: override ?? "unchanged" },
      apply: (current, _nowMs, at) => {
        const next: QuotaSettings = structuredClone(
          current ?? {
            version: 1,
            kind: "quota-settings",
            accountId,
            revision: 0,
            creation: { operationId, at },
            audit: [],
          },
        );
        if (input.plan === null) delete next.planId;
        else if (typeof input.plan === "string") next.planId = input.plan;
        if (override === null) delete next.allowanceOverrideUnits;
        else if (typeof override === "number") next.allowanceOverrideUnits = override;
        return {
          next,
          result: {
            accountId,
            planId: next.planId ?? null,
            allowanceOverrideUnits: next.allowanceOverrideUnits ?? null,
          },
        };
      },
    });
  }

  /** What a customer may see: the week's percentage, its reset time and each app's share. No units, no money. */
  async customerView(accountId: string): Promise<QuotaView> {
    const view = await this.operatorView(accountId);
    if (view.state !== "set") return view.state === "none" ? { state: "none" } : { state: "unavailable" };
    return {
      state: "set",
      percentUsed: view.percentUsed,
      resetsAt: view.resetsAt,
      byProduct: view.byProduct,
    };
  }

  /** What staff see: the customer view plus internal units. A failure is `unavailable`, never zero or unlimited. */
  async operatorView(accountId: string): Promise<OperatorQuotaView> {
    try {
      const context = await this.context(accountId);
      const planId = context.settings?.planId ?? null,
        allowanceOverrideUnits = context.settings?.allowanceOverrideUnits ?? null;
      if (context.allowanceUnits === null) return { state: "none", planId, allowanceOverrideUnits };
      const week = (await this.readWeek(context.accountId, context.week))?.value ?? null;
      const held = week ? heldByProduct(week, context.nowMs) : {};
      const used = week?.usedByProduct ?? {};
      const allowance = context.allowanceUnits;
      const heldUnits = Object.values(held).reduce((total, units) => total + units, 0);
      const committed = (week?.usedUnits ?? 0) + heldUnits;
      return {
        state: "set",
        percentUsed: percentOf(committed, allowance),
        resetsAt: context.endsAt,
        startedAt: context.startsAt,
        byProduct: [...new Set([...Object.keys(used), ...Object.keys(held)])].sort().map((product) => ({
          product,
          percentOfQuota:
            allowance === 0
              ? 0
              : Math.min(
                  100,
                  Number((BigInt((used[product] ?? 0) + (held[product] ?? 0)) * 100n) / BigInt(allowance)),
                ),
        })),
        planId,
        allowanceOverrideUnits,
        allowanceUnits: allowance,
        usedUnits: week?.usedUnits ?? 0,
        heldUnits,
        overshootUnits: week?.overshootUnits ?? 0,
        tableVersions: Object.keys(week?.usedByTableVersion ?? {}).sort(),
      };
    } catch {
      return { state: "unavailable" };
    }
  }

  /** An unknown item kind is refused before anything is charged, and recorded for operators. */
  private async refuseUnknown(
    context: Context_ & { accountId: string },
    caller: QuotaCaller,
    action: QuotaAction,
    operationId: string,
    items: readonly BillableItem[],
  ) {
    const unknown = unknownItemKinds(context.table, items);
    if (!unknown.length) return;
    const eventId = hash(["quota-refusal-v1", context.accountId, action, operationId]);
    const requestHash = hash(["quota-refusal-request-v1", unknown]);
    try {
      await this.record_(eventId, requestHash, {
        version: 1,
        kind: "quota-journal-event",
        eventId,
        action: "usage.refused",
        accountId: context.accountId,
        operationId,
        requestHash,
        actor: `product:${caller.product}`,
        beforeRevision: null,
        afterRevision: null,
        result: { status: "refused", code: "unknown_item_kind" },
        detail: { refusedAction: action, itemKinds: unknown, tableVersion: context.table.version },
        at: this.now(),
      });
    } catch {
      // The refusal stands even if its operator-visible note could not be written.
    }
    fail(422, "unknown_item_kind", "An item kind is not recognized.");
  }

  private async run<D extends Versioned, X = undefined>(
    operation: Operation<D, X>,
  ): Promise<{ result: Record<string, unknown>; replayed: boolean }> {
    const requestHash = hash([
      "quota-request-v2",
      operation.action,
      operation.accountId,
      operation.reservationId ?? null,
      operation.actor,
      operation.request,
    ]);
    const eventId = hash(["quota-journal-v2", operation.accountId, operation.action, operation.operationId]);
    const event = (
      applied: Pick<Applied<D>, "result" | "detail">,
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
      ...(applied.detail ? { detail: applied.detail } : {}),
      at,
    });
    let transient = 0,
      prepared = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      const journaled = await this.files.get<QuotaJournalEvent>(journalPath(eventId));
      if (journaled) {
        if (journaled.value.requestHash !== requestHash) idempotencyConflict();
        return { result: journaled.value.result, replayed: true };
      }
      const stored = await this.files.get<D>(operation.path),
        current = stored?.value ?? null;
      const at = this.now(),
        nowMs = Date.parse(at);
      const prior = current?.audit.find(
        (entry) => entry.operationId === operation.operationId && entry.action === operation.action,
      );
      if (prior) {
        // Committed before its journal event was written: finish the journal, then answer as a replay.
        if (prior.requestHash !== requestHash) idempotencyConflict();
        await this.record_(
          eventId,
          requestHash,
          event(prior, prior.revision - 1 || null, prior.revision, prior.at),
        );
        return { result: prior.result, replayed: true };
      }
      if (!prepared) {
        await operation.prepare?.();
        prepared = true;
      }
      const extra = (await operation.load?.()) as X;
      const applied = operation.apply(current, nowMs, at, extra);
      if (applied.unchanged) {
        await this.record_(
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
        fail(409, "quota_capacity", "The account's quota record for this week is full.");
      // Expiry is a fact of time, so journaling it before the document changes is safe, and repeating it is harmless.
      for (const [expiredId, hold] of applied.expired ?? [])
        await this.recordExpiry(operation.accountId, expiredId, hold, at);
      try {
        await commitWithRetry(
          this.files,
          operation.path,
          `quota:${eventId}:${baseRevision}`,
          hash(["quota-storage-v2", requestHash, baseRevision]),
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
      await this.record_(
        eventId,
        requestHash,
        event(applied, current ? baseRevision : null, next.revision, at),
      );
      return { result: applied.result, replayed: false };
    }
    fail(409, "busy", "Concurrent quota change; retry with the same operation ID.");
  }

  private async record_(eventId: string, requestHash: string, event: QuotaJournalEvent) {
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
    const eventId = hash(["quota-expiry-v2", accountId, reservationId]);
    const requestHash = hash(["quota-expiry-request-v2", accountId, reservationId, hold.expiresAt]);
    await this.record_(eventId, requestHash, {
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
      result: { reservationId, accountId, status: "expired" },
      detail: { units: hold.units, tableVersion: hold.tableVersion, expiresAt: hold.expiresAt },
      at,
    });
  }
}

function heldByProduct(week: QuotaWeek, nowMs: number) {
  const held: Record<string, number> = {};
  for (const hold of Object.values(week.holds))
    if (!isExpired(hold, nowMs)) held[hold.product] = (held[hold.product] ?? 0) + hold.units;
  return held;
}
/** Used plus held by unexpired holds: what counts against the week. */
const committedUnits = (week: QuotaWeek, nowMs: number) =>
  Object.values(heldByProduct(week, nowMs)).reduce((total, units) => total + units, week.usedUnits);

/** Adds one charge to a week's aggregates, recording the table version it was priced under. */
function charge(
  week: QuotaWeek,
  context: Context_,
  product: string,
  conversion: ReturnType<typeof convertItems>,
) {
  week.usedUnits = sum(week.usedUnits, conversion.units);
  week.usedByProduct[product] = sum(week.usedByProduct[product] ?? 0, conversion.units);
  week.usedByTableVersion[context.table.version] = sum(
    week.usedByTableVersion[context.table.version] ?? 0,
    conversion.units,
  );
  for (const line of conversion.lines) {
    const kind = week.usedByKind[line.itemKind] ?? { quantity: 0, units: 0 };
    week.usedByKind[line.itemKind] = {
      quantity: sum(kind.quantity, line.quantity),
      units: sum(kind.units, line.units),
    };
  }
  week.allowanceUnits = context.allowanceUnits;
  week.overshootUnits =
    context.allowanceUnits === null ? 0 : Math.max(0, week.usedUnits - context.allowanceUnits);
}

/** Drops the oldest expired holds until the document fits its byte budget, and returns them for journaling. Active
 * holds are never dropped. */
function makeRoom(week: QuotaWeek, nowMs: number): Array<[string, Hold]> {
  const dropped: Array<[string, Hold]> = [];
  const expired = Object.entries(week.holds)
    .filter(([, hold]) => isExpired(hold, nowMs))
    .sort(([, left], [, right]) => left.expiresAt.localeCompare(right.expiresAt));
  // Leave headroom for the audit entry and journal fields added after this point.
  while (Buffer.byteLength(JSON.stringify(week)) > DOCUMENT_BYTE_BUDGET - 4096 && expired.length) {
    const [id, hold] = expired.shift()!;
    delete week.holds[id];
    dropped.push([id, hold]);
  }
  return dropped;
}

function idempotencyConflict(): never {
  fail(409, "idempotency_conflict", "Operation ID belongs to a different quota request.");
}
