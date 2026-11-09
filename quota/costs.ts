import { IdentityFileError, type IdentityFiles } from "../accounts/identity-files";
import { UUID_PATTERN } from "../accounts/model";
import { isPlainRecord, matchesStringPattern } from "../accounts/validation-rules";
import { fail } from "./model";
import { convertItems, isItemKind, parseItems, unknownItemKinds, type RateTableSource } from "./rate-table";
import {
  hash,
  journalPath,
  requireAccountId,
  requireOperationId,
  type AccountReader,
  type Quota,
} from "./service";

/**
 * The private cost ledger (docs/COST_ACCOUNTING.md, features/cost-ledger.feature). What each Account actually costs
 * Anthus, in integer microdollars, by app, deployment, category and UTC day. Live usage reports are estimates; an
 * imported actual replaces the estimate for the same key and day and is never added to it. Every change in the day's
 * effective amount is charged to the Account's current quota week. Nothing here is ever shown to a customer or a
 * product.
 *
 * Stored in the quota Virtuus project under the `costs` kind: one bounded aggregate document per Account and day,
 * and one journal file per message or import.
 */

/** Product families. Every Papyrus site is app `papyrus` with its site ID as the deployment. */
export const COST_APPS = ["papyrus", "cyclotron", "babulus", "chatticus", "prospectus"] as const;
export type CostApp = (typeof COST_APPS)[number];
export const DEPLOYMENT_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PAPYRUS_PREFIX = "papyrus-";

/** The app a registered product belongs to, or null for a product outside cost accounting. */
export function appOf(product: string): CostApp | null {
  if (product.startsWith(PAPYRUS_PREFIX) && DEPLOYMENT_PATTERN.test(product.slice(PAPYRUS_PREFIX.length)))
    return "papyrus";
  return (COST_APPS as readonly string[]).includes(product) ? (product as CostApp) : null;
}
/** The registered product a cost belongs to: a Papyrus site's own product, otherwise the app itself. */
export const productOf = (app: CostApp, deployment: string | null) =>
  app === "papyrus" && deployment ? `${PAPYRUS_PREFIX}${deployment}` : app;

export const MAXIMUM_COST_AUDIT_ENTRIES = 64;
/** Usage messages may name a day up to this far back; imports may correct older days. */
export const MESSAGE_DAY_WINDOW_DAYS = 14;
export const IMPORT_DAY_WINDOW_DAYS = 62;
const DAY_MS = 86_400_000;

/** Why a cost is charged to no Account: no anthus:cost-key tag, shared cost with no usage reported that day, a cost
 * key naming an Account that does not exist, or a credit (a negative amount) that is never passed to an Account. */
export type OverheadKind = "untagged" | "unattributed" | "unknown_account" | "credit";
export const OVERHEAD_KINDS: readonly OverheadKind[] = [
  "untagged",
  "unattributed",
  "unknown_account",
  "credit",
];
/** The overhead day documents live under the nil UUID, which is never an Account. */
/** The account value meaning "the deployment's owning Account", in cost tags and usage messages. */
export const OWNER_ACCOUNT = "owner";
export const OVERHEAD_ACCOUNT = [8, 4, 4, 4, 12].map((length) => "0".repeat(length)).join("-");

export interface CostEntry {
  /** Null only for untagged overhead, where the app is unknown. */
  app: CostApp | null;
  deployment: string | null;
  category: string;
  quantity: number;
  estimatedMicros: number;
  actualMicros: number | null;
  /** Set only on entries in the overhead day document. */
  overhead?: OverheadKind;
}
export interface CostAuditEntry {
  revision: number;
  action: CostAction;
  operationId: string;
  requestHash: string;
  delta: number;
  at: string;
}
/** `costs/<accountUUID>/<YYYYMMDD>.json`: one Account's costs for one UTC day, aggregates only. */
export interface CostDay {
  version: 1;
  kind: "cost-day";
  accountId: string;
  day: number;
  entries: Record<string, CostEntry>;
  revision: number;
  creation: { operationId: string; at: string };
  audit: CostAuditEntry[];
}
export type CostAction = "cost.estimated" | "cost.actual" | "cost.refused" | "cost.overhead";
export interface CostJournalEvent {
  version: 1;
  kind: "cost-journal-event";
  eventId: string;
  action: CostAction;
  accountId: string;
  day: number;
  operationId: string;
  requestHash: string;
  actor: string;
  product: string;
  /** The change in the day's effective amount, in microdollars, charged to the current quota week. */
  delta: number;
  detail: Record<string, unknown>;
  at: string;
}

export const costDayPath = (accountId: string, day: number) => `costs/${accountId}/${day}.json`;
const entryKey = (app: string, deployment: string | null, category: string) =>
  `${app}|${deployment ?? ""}|${category}`;
const effective = (entry: CostEntry) => entry.actualMicros ?? entry.estimatedMicros;
const add = (left: number, right: number) =>
  Number.isSafeInteger(left + right) ? left + right : fail(409, "quota_capacity", "Amount is too large.");

/** A UUID-shaped operation ID derived from a digest, for operations the ledger itself originates. */
export function derivedOperationId(...parts: unknown[]): string {
  const digest = hash(["cost-derived-v1", ...parts]);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/** YYYYMMDD of a UTC instant. */
export const utcDay = (ms: number) => Number(new Date(ms).toISOString().slice(0, 10).replaceAll("-", ""));
const dayStartMs = (day: number) => {
  const text = String(day);
  const ms = Date.UTC(Number(text.slice(0, 4)), Number(text.slice(4, 6)) - 1, Number(text.slice(6, 8)));
  return utcDay(ms) === day ? ms : NaN;
};
/** A real UTC day, not in the future (one day of clock skew allowed) and within the window. */
export function requireDay(value: unknown, nowMs: number, windowDays: number): number {
  const ms = Number.isSafeInteger(value) ? dayStartMs(value as number) : NaN;
  if (Number.isNaN(ms) || ms > nowMs + DAY_MS || ms < nowMs - windowDays * DAY_MS)
    fail(400, "invalid_day", "The day must be a recent UTC day as YYYYMMDD.");
  return value as number;
}

/** A monthly charge spread over its month's days, as whole microdollars that sum to the total exactly. */
export function spreadMonthly(totalMicros: number, year: number, month: number): number[] {
  if (!Number.isSafeInteger(totalMicros) || totalMicros < 0)
    fail(400, "invalid_amount", "Whole microdollars.");
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const base = Math.floor(totalMicros / days),
    remainder = totalMicros - base * days;
  return Array.from({ length: days }, (_, index) => base + (index < remainder ? 1 : 0));
}

/**
 * A shared cost split across Accounts in proportion to their reported usage, by largest remainder so the parts sum
 * to the total exactly. Null when nobody reported usage: the cost is then unattributed overhead.
 */
export function splitShared(
  totalMicros: number,
  weights: Record<string, number>,
): Record<string, number> | null {
  const entries = Object.entries(weights).filter(([, weight]) => weight > 0);
  if (!Number.isSafeInteger(totalMicros) || totalMicros < 0)
    fail(400, "invalid_amount", "Whole microdollars.");
  if (entries.some(([, weight]) => !Number.isSafeInteger(weight)))
    fail(400, "invalid_quantity", "Whole usage.");
  const totalWeight = entries.reduce((sum, [, weight]) => sum + BigInt(weight), 0n);
  if (totalWeight === 0n) return null;
  const parts = entries.map(([id, weight]) => {
    const scaled = BigInt(totalMicros) * BigInt(weight);
    return { id, share: scaled / totalWeight, remainder: scaled % totalWeight };
  });
  let left = BigInt(totalMicros) - parts.reduce((sum, part) => sum + part.share, 0n);
  for (const part of [...parts].sort((a, b) =>
    a.remainder === b.remainder ? a.id.localeCompare(b.id) : a.remainder > b.remainder ? -1 : 1,
  )) {
    if (left === 0n) break;
    part.share += 1n;
    left -= 1n;
  }
  return Object.fromEntries(parts.map((part) => [part.id, Number(part.share)]));
}

/** One actual cost from the import, for one category of one Account, app and deployment on one day. */
export interface ActualCost {
  category: string;
  micros: number;
}

interface Change {
  action: CostAction;
  accountId: string;
  day: number;
  operationId: string;
  requestHash: string;
  actor: string;
  product: string;
  source: string;
  detail: Record<string, unknown>;
  /** False for overhead, which is charged to no Account's quota. */
  chargesQuota?: boolean;
  apply(day: CostDay): number;
}

/** One overhead cost from the import: charged to no Account. Credits may be negative. */
export interface OverheadCost {
  overhead: OverheadKind;
  app: CostApp | null;
  category: string;
  micros: number;
}

export class CostLedger {
  constructor(
    private files: IdentityFiles,
    private accounts: AccountReader,
    private quota: Pick<Quota, "applyCost">,
    private table: RateTableSource,
    private now: () => string,
    /** Resolves `accountId: "owner"` in a usage message to the deployment's owning Account (see `costOwners`). */
    private ownerOf?: (app: CostApp, deployment: string) => Promise<string | null>,
  ) {}

  /**
   * A usage message from a product's queue. The product comes from the queue, never from the body. The items are
   * priced with the private price list and recorded as estimates.
   *
   * `accountId: "owner"` charges the one Account holding the active entitlement to the queue's per-deployment
   * product, for runtimes that know the site but never see a verified customer. Without a single owner the message
   * is refused, so it reaches the dead-letter queue and its alarm instead of being charged to a guess.
   */
  async recordUsage(product: string, body: unknown) {
    if (
      !isPlainRecord(body) ||
      !Object.keys(body).every((key) =>
        ["version", "operationId", "accountId", "app", "deployment", "day", "items"].includes(key),
      )
    )
      fail(400, "unknown_fields", "Unknown fields in a usage message.");
    if (body.version !== 1) fail(400, "invalid_version", "Usage message version 1 is required.");
    const operationId = requireOperationId(body.operationId),
      items = parseItems(body.items, 1),
      nowMs = Date.parse(this.now()),
      day = requireDay(body.day, nowMs, MESSAGE_DAY_WINDOW_DAYS);
    const deployment =
      body.deployment === undefined || body.deployment === null
        ? null
        : matchesStringPattern(body.deployment, DEPLOYMENT_PATTERN)
          ? body.deployment
          : fail(400, "invalid_deployment", "A deployment ID is lower-case letters, digits and hyphens.");
    const app = appOf(product);
    if (!app || body.app !== app || productOf(app, deployment) !== product)
      fail(403, "wrong_product", "The message does not belong to this product's queue.");
    let accountId: string;
    if (body.accountId === OWNER_ACCOUNT) {
      if (!deployment) fail(400, "owner_needs_deployment", 'accountId "owner" needs the deployment.');
      const owner = this.ownerOf ? await this.ownerOf(app, deployment) : null;
      accountId = owner ?? fail(422, "owner_unknown", "No single Account owns this deployment.");
    } else accountId = requireAccountId(body.accountId);
    const account = await this.accounts(accountId);
    if (!account) fail(404, "account_missing", "Account not found.");
    if (account.entitlements[product]?.status !== "active")
      fail(403, "product_not_entitled", "The account is not entitled to this product.");
    const table = await this.table.current();
    const requestHash = hash(["cost-usage-v1", product, accountId, app, deployment, day, items]);
    const unknown = unknownItemKinds(table, items);
    if (unknown.length) {
      await this.journalRefusal(product, accountId, day, operationId, requestHash, unknown);
      fail(422, "unknown_item_kind", "An item kind is not recognized.");
    }
    const conversion = convertItems(table, items);
    return this.change({
      action: "cost.estimated",
      accountId,
      day,
      operationId,
      requestHash,
      actor: `product:${product}`,
      product,
      source: table.version,
      detail: { tableVersion: table.version, app, deployment, lines: conversion.lines },
      apply: (document) => {
        let delta = 0;
        for (const line of conversion.lines) {
          const key = entryKey(app, deployment, line.itemKind);
          const entry: CostEntry = document.entries[key] ?? {
            app,
            deployment,
            category: line.itemKind,
            quantity: 0,
            estimatedMicros: 0,
            actualMicros: null,
          };
          entry.quantity = add(entry.quantity, line.quantity);
          entry.estimatedMicros = add(entry.estimatedMicros, line.units);
          if (entry.actualMicros === null) delta = add(delta, line.units);
          document.entries[key] = entry;
        }
        return delta;
      },
    });
  }

  /**
   * The day's actual costs for one Account, app and deployment, from the daily import. Each replaces whatever was
   * recorded for its category that day, so re-running an import with the same figures changes nothing and a later
   * import with new figures corrects the day.
   */
  async recordActual(input: {
    accountId: unknown;
    app: CostApp;
    deployment: string | null;
    day: unknown;
    costs: readonly ActualCost[];
    source: string;
  }) {
    const accountId = requireAccountId(input.accountId),
      nowMs = Date.parse(this.now()),
      day = requireDay(input.day, nowMs, IMPORT_DAY_WINDOW_DAYS);
    if (!(COST_APPS as readonly string[]).includes(input.app)) fail(400, "invalid_app", "Unknown app.");
    if (input.deployment !== null && !DEPLOYMENT_PATTERN.test(input.deployment))
      fail(400, "invalid_deployment", "A deployment ID is lower-case letters, digits and hyphens.");
    const costs = [...input.costs].sort((a, b) => a.category.localeCompare(b.category));
    for (const cost of costs)
      if (!isItemKind(cost.category) || !Number.isSafeInteger(cost.micros) || cost.micros < 0)
        fail(400, "invalid_cost", "Each cost is a category and whole microdollars.");
    if (new Set(costs.map((cost) => cost.category)).size !== costs.length)
      fail(400, "invalid_cost", "Each category appears once.");
    if (!(await this.accounts(accountId))) fail(404, "account_missing", "Account not found.");
    const { app, deployment } = input;
    const product = productOf(app, deployment);
    const operationId = derivedOperationId("actual", accountId, app, deployment, day, costs);
    return this.change({
      action: "cost.actual",
      accountId,
      day,
      operationId,
      requestHash: hash(["cost-actual-v1", accountId, app, deployment, day, costs]),
      actor: "system:cost-import",
      product,
      source: "actual",
      detail: { source: input.source, app, deployment, costs },
      apply: (document) => {
        let delta = 0;
        for (const cost of costs) {
          const key = entryKey(app, deployment, cost.category);
          const entry: CostEntry = document.entries[key] ?? {
            app,
            deployment,
            category: cost.category,
            quantity: 0,
            estimatedMicros: 0,
            actualMicros: null,
          };
          delta = add(delta, cost.micros - effective(entry));
          entry.actualMicros = cost.micros;
          document.entries[key] = entry;
        }
        return delta;
      },
    });
  }

  /**
   * The day's overhead from the daily import, kept in its own day document under the nil UUID and charged to no
   * Account. Like actuals, each replaces what was recorded for its key that day.
   */
  async recordOverhead(input: { day: unknown; costs: readonly OverheadCost[]; source: string }) {
    const day = requireDay(input.day, Date.parse(this.now()), IMPORT_DAY_WINDOW_DAYS);
    const costs = [...input.costs].sort((a, b) => overheadKey(a).localeCompare(overheadKey(b)));
    for (const cost of costs)
      if (
        !OVERHEAD_KINDS.includes(cost.overhead) ||
        (cost.app !== null && !(COST_APPS as readonly string[]).includes(cost.app)) ||
        !isItemKind(cost.category) ||
        !Number.isSafeInteger(cost.micros)
      )
        fail(
          400,
          "invalid_cost",
          "Each overhead cost is a kind, an app or null, a category and whole microdollars.",
        );
    if (new Set(costs.map(overheadKey)).size !== costs.length)
      fail(400, "invalid_cost", "Each overhead key appears once.");
    const operationId = derivedOperationId("overhead", day, costs);
    return this.change({
      action: "cost.overhead",
      accountId: OVERHEAD_ACCOUNT,
      day,
      operationId,
      requestHash: hash(["cost-overhead-v1", day, costs]),
      actor: "system:cost-import",
      product: "overhead",
      source: "actual",
      detail: { source: input.source, costs },
      chargesQuota: false,
      apply: (document) => {
        let delta = 0;
        for (const cost of costs) {
          const key = overheadKey(cost);
          const entry: CostEntry = document.entries[key] ?? {
            app: cost.app,
            deployment: null,
            category: cost.category,
            quantity: 0,
            estimatedMicros: 0,
            actualMicros: null,
            overhead: cost.overhead,
          };
          delta = add(delta, cost.micros - effective(entry));
          entry.actualMicros = cost.micros;
          document.entries[key] = entry;
        }
        return delta;
      },
    });
  }

  async overheadDay(day: number): Promise<CostDay | null> {
    return (await this.files.get<CostDay>(costDayPath(OVERHEAD_ACCOUNT, day)))?.value ?? null;
  }

  async day(accountId: string, day: number): Promise<CostDay | null> {
    return (await this.files.get<CostDay>(costDayPath(requireAccountId(accountId), day)))?.value ?? null;
  }

  private async change(change: Change) {
    const eventId = hash(["cost-journal-v1", change.accountId, change.action, change.operationId]);
    const path = costDayPath(change.accountId, change.day);
    for (let attempt = 0; attempt < 12; attempt++) {
      const journaled = await this.files.get<CostJournalEvent>(journalPath(eventId));
      if (journaled) {
        if (journaled.value.requestHash !== change.requestHash) idempotencyConflict();
        await this.chargeQuota(change, eventId, journaled.value.delta);
        return { result: { accountId: change.accountId, status: "recorded" }, replayed: true };
      }
      const stored = await this.files.get<CostDay>(path),
        current = stored?.value ?? null,
        at = this.now();
      const prior = current?.audit.find(
        (entry) => entry.operationId === change.operationId && entry.action === change.action,
      );
      if (prior) {
        // Committed before its journal event was written: finish the journal and the quota charge, then replay.
        if (prior.requestHash !== change.requestHash) idempotencyConflict();
        await this.journal(change, eventId, prior.delta, prior.at);
        await this.chargeQuota(change, eventId, prior.delta);
        return { result: { accountId: change.accountId, status: "recorded" }, replayed: true };
      }
      const next: CostDay = structuredClone(
        current ?? {
          version: 1,
          kind: "cost-day",
          accountId: change.accountId,
          day: change.day,
          entries: {},
          revision: 0,
          creation: { operationId: change.operationId, at },
          audit: [],
        },
      );
      const delta = change.apply(next);
      next.revision = (current?.revision ?? 0) + 1;
      next.audit = [
        ...next.audit,
        {
          revision: next.revision,
          action: change.action,
          operationId: change.operationId,
          requestHash: change.requestHash,
          delta,
          at,
        },
      ].slice(-MAXIMUM_COST_AUDIT_ENTRIES);
      try {
        await this.files.commit(
          path,
          `cost:${eventId}:${current?.revision ?? 0}`,
          hash(["cost-storage-v1", change.requestHash, current?.revision ?? 0]),
          next,
          stored?.revision ?? null,
        );
      } catch (error) {
        if (
          error instanceof IdentityFileError &&
          ["conflict", "operation_mismatch", "uncertain", "unavailable"].includes(error.code)
        ) {
          if (["uncertain", "unavailable"].includes(error.code))
            await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** Math.min(attempt, 5)));
          continue;
        }
        throw error;
      }
      await this.journal(change, eventId, delta, at);
      await this.chargeQuota(change, eventId, delta);
      return { result: { accountId: change.accountId, status: "recorded" }, replayed: false };
    }
    fail(409, "busy", "Concurrent cost change; retry with the same operation ID.");
  }

  private async chargeQuota(change: Change, eventId: string, delta: number) {
    if (delta === 0 || change.chargesQuota === false) return;
    await this.quota.applyCost({
      accountId: change.accountId,
      operationId: derivedOperationId("quota", eventId),
      product: change.product,
      units: delta,
      source: change.source,
      detail: { costDay: change.day, costEvent: eventId },
    });
  }

  private async journal(change: Change, eventId: string, delta: number, at: string) {
    const event: CostJournalEvent = {
      version: 1,
      kind: "cost-journal-event",
      eventId,
      action: change.action,
      accountId: change.accountId,
      day: change.day,
      operationId: change.operationId,
      requestHash: change.requestHash,
      actor: change.actor,
      product: change.product,
      delta,
      detail: change.detail,
      at,
    };
    await this.writeJournal(eventId, event);
  }

  private async journalRefusal(
    product: string,
    accountId: string,
    day: number,
    operationId: string,
    requestHash: string,
    unknown: string[],
  ) {
    const eventId = hash(["cost-journal-v1", accountId, "cost.refused", operationId]);
    try {
      await this.writeJournal(eventId, {
        version: 1,
        kind: "cost-journal-event",
        eventId,
        action: "cost.refused",
        accountId,
        day,
        operationId,
        requestHash,
        actor: `product:${product}`,
        product,
        delta: 0,
        detail: { reason: "unknown_item_kind", itemKinds: unknown },
        at: this.now(),
      });
    } catch {
      // The refusal stands even if its operator-visible note could not be written.
    }
  }

  private async writeJournal(eventId: string, event: CostJournalEvent) {
    try {
      await this.files.commit(
        journalPath(eventId),
        `cost:journal:${eventId}`,
        event.requestHash,
        event,
        null,
      );
    } catch (error) {
      if (!(error instanceof IdentityFileError && ["conflict", "operation_mismatch"].includes(error.code)))
        throw error;
      const existing = await this.files.get<CostJournalEvent>(journalPath(eventId));
      if (existing?.value.requestHash !== event.requestHash) idempotencyConflict();
    }
  }
}

function idempotencyConflict(): never {
  fail(409, "idempotency_conflict", "Operation ID belongs to a different cost request.");
}

/**
 * Looks up the owner of a per-customer deployment tagged `owner`: the one Account holding the active entitlement to
 * its product (`papyrus-<site>` for a Papyrus site, otherwise the app). Null when no Account or more than one does,
 * so the cost is overhead rather than charged to a guess. Reads every Account once per import run.
 */
export function costOwners(
  accounts: () => Promise<
    Array<{ account: { id: string }; entitlements: Record<string, { product?: string; status: string }> }>
  >,
) {
  let owners: Promise<Map<string, string[]>> | undefined;
  return async (app: CostApp, deployment: string) => {
    owners ??= accounts().then((documents) => {
      const map = new Map<string, string[]>();
      for (const document of documents)
        for (const [key, entitlement] of Object.entries(document.entitlements))
          if (entitlement.status === "active") {
            const product = entitlement.product ?? key;
            map.set(product, [...(map.get(product) ?? []), document.account.id]);
          }
      return map;
    });
    const holders = (await owners).get(productOf(app, deployment)) ?? [];
    return holders.length === 1 ? holders[0] : null;
  };
}

const overheadKey = (cost: OverheadCost) => `${cost.overhead}|${cost.app ?? ""}|${cost.category}`;

export const isUuid = (value: unknown): value is string => matchesStringPattern(value, UUID_PATTERN);
