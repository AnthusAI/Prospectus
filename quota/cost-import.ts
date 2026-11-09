import { parseCostKey } from "../packages/cost-accounting/src/tags";
import {
  splitShared,
  utcDay,
  type ActualCost,
  type CostApp,
  type CostDay,
  type CostLedger,
  type OverheadCost,
} from "./costs";

/**
 * The daily import of real AWS costs (docs/COST_ACCOUNTING.md, features/cost-daily-import.feature). Reads each recent
 * day's cost from Cost Explorer grouped by `anthus:cost-key` and service, and records it in the cost ledger:
 *
 * - a per-customer cost key becomes that Account's actual for the app, deployment and service;
 * - a `shared/<app>/` key is split across Accounts by the usage the app reported that day;
 * - cost with no key, shared cost with no usage, a key naming an unknown Account, and credits are overhead,
 *   charged to no Account.
 *
 * An imported actual for service `aws.<service>` also replaces the live estimates the app reported under
 * `aws.<service>.<unit>` for the same Account, app and deployment, so the real figure is never added on top.
 * Every write is idempotent: running the import again for a day with the same figures changes nothing, and new
 * figures (Cost Explorer firms up estimates over a day or two) correct the day.
 */

export interface CostExplorerRow {
  /** The `anthus:cost-key` tag value, or null for cost without the tag. */
  costKey: string | null;
  /** Cost Explorer's SERVICE dimension, for example "AWS AppSync". */
  service: string;
  micros: number;
}
export interface CostExplorerDay {
  /** True while Cost Explorer still marks the day's figures as estimated. */
  estimated: boolean;
  rows: CostExplorerRow[];
}
export interface CostExplorerSource {
  day(day: number): Promise<CostExplorerDay>;
}

/** The role the import assumes in the Organizations management account (infra/lib/cost-management.ts). */
export const COST_IMPORT_ROLE_NAME = "prospectus-cost-import";
/** The runtime role allowed to assume it, in the Prospectus account. */
export const COST_IMPORT_CALLER_ROLE_NAME = "prospectus-central-accounts-runtime";
/** Recent days to (re-)import each run: Cost Explorer revises a day's figures for a day or two. */
export const IMPORT_LOOKBACK_DAYS = 3;
const DAY_MS = 86_400_000;

/** "AWS AppSync" → "aws.appsync", "Amazon DynamoDB" → "aws.dynamodb". */
export function serviceCategory(service: string): string {
  const slug = service
    .toLowerCase()
    .replace(/^(amazon web services|amazon|aws)\s+/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return `aws.${slug || "other"}`;
}

/** Dollars as Cost Explorer prints them ("0.3500000000") to whole microdollars, rounded half away from zero. */
export function dollarsToMicros(amount: string): number {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!match) throw new Error("cost_amount_malformed");
  const [, sign, whole, fraction = ""] = match;
  const digits = (fraction + "0000000").slice(0, 7);
  let micros = BigInt(whole) * 1_000_000n + BigInt(digits.slice(0, 6));
  if (Number(digits[6]) >= 5) micros += 1n;
  const value = Number(sign ? -micros : micros);
  if (!Number.isSafeInteger(value)) throw new Error("cost_amount_too_large");
  return value === 0 ? 0 : value;
}

type Log = (entry: Record<string, unknown>) => void;

export interface ImportResult {
  day: number;
  imported: boolean;
  estimated?: boolean;
  actuals?: number;
  overhead?: number;
  reason?: string;
}

/** Imports one UTC day. A Cost Explorer failure records nothing and is retried on the next run. */
export async function importCostDay(input: {
  source: CostExplorerSource;
  ledger: Pick<CostLedger, "recordActual" | "recordOverhead" | "day">;
  /** Every Account ID, for splitting shared cost by reported usage. */
  accountIds: () => Promise<string[]>;
  /** The Account holding the active entitlement to an app deployment's product, for `owner` cost keys; null when
   * none or more than one does. */
  ownerOf?: (app: CostApp, deployment: string) => Promise<string | null>;
  day: number;
  log?: Log;
}): Promise<ImportResult> {
  const { source, ledger, day } = input;
  const log = input.log ?? (() => {});
  let report: CostExplorerDay;
  try {
    report = await source.day(day);
  } catch (error) {
    const reason =
      error instanceof Error && /^cost_[a-z_]+$/.test(error.message) ? error.message : "cost_explorer_failed";
    log({ event: "cost_import_failed", day, reason });
    return { day, imported: false, reason };
  }
  const label = `cost-explorer:${report.estimated ? "estimated" : "final"}`;

  // Sum rows by destination. Cost Explorer may return several rows that map to one category.
  const actuals = new Map<
    string,
    { accountId: string; app: CostApp; deployment: string | null; costs: Map<string, number> }
  >();
  const shared = new Map<CostApp, Map<string, number>>();
  const overhead = new Map<string, OverheadCost>();
  const addTo = (map: Map<string, number>, key: string, micros: number) =>
    map.set(key, (map.get(key) ?? 0) + micros);
  const addOverhead = (cost: OverheadCost) => {
    const key = `${cost.overhead}|${cost.app ?? ""}|${cost.category}`;
    const prior = overhead.get(key);
    overhead.set(key, { ...cost, micros: (prior?.micros ?? 0) + cost.micros });
  };
  const addActual = (
    accountId: string,
    app: CostApp,
    deployment: string | null,
    category: string,
    micros: number,
  ) => {
    const key = `${accountId}|${app}|${deployment ?? ""}`;
    const group = actuals.get(key) ?? { accountId, app, deployment, costs: new Map<string, number>() };
    addTo(group.costs, category, micros);
    actuals.set(key, group);
  };

  for (const row of report.rows) {
    const category = serviceCategory(row.service);
    const key = row.costKey ? parseCostKey(row.costKey) : null;
    if (!key) addOverhead({ overhead: "untagged", app: null, category, micros: row.micros });
    else if (key.account === "shared") {
      const costs = shared.get(key.app) ?? new Map<string, number>();
      addTo(costs, category, row.micros);
      shared.set(key.app, costs);
    } else if (key.account === "owner") {
      const owner = input.ownerOf && key.deployment ? await input.ownerOf(key.app, key.deployment) : null;
      if (owner) addActual(owner, key.app, key.deployment, category, row.micros);
      else addOverhead({ overhead: "unknown_account", app: key.app, category, micros: row.micros });
    } else addActual(key.account, key.app, key.deployment, category, row.micros);
  }

  // Shared cost: split by the usage each Account reported for that service, else by its total reported usage of the
  // app that day, else overhead.
  if (shared.size) {
    const days = new Map<string, CostDay>();
    for (const accountId of await input.accountIds()) {
      const document = await ledger.day(accountId, day);
      if (document) days.set(accountId, document);
    }
    for (const [app, costs] of shared)
      for (const [category, micros] of costs) {
        if (micros <= 0) {
          addOverhead({ overhead: micros < 0 ? "credit" : "unattributed", app, category, micros });
          continue;
        }
        const weights = (measure: (entryCategory: string, quantity: number, estimated: number) => number) =>
          Object.fromEntries(
            [...days].map(([accountId, document]) => [
              accountId,
              Object.values(document.entries)
                .filter((entry) => entry.app === app)
                .reduce(
                  (sum, entry) => sum + measure(entry.category, entry.quantity, entry.estimatedMicros),
                  0,
                ),
            ]),
          );
        const split =
          splitShared(
            micros,
            weights((entry, quantity) => (entry.startsWith(`${category}.`) ? quantity : 0)),
          ) ??
          splitShared(
            micros,
            weights((_entry, _quantity, estimated) => estimated),
          );
        if (!split) addOverhead({ overhead: "unattributed", app, category, micros });
        else
          for (const [accountId, part] of Object.entries(split))
            if (part) addActual(accountId, app, null, category, part);
      }
  }

  let recorded = 0;
  for (const group of [...actuals.values()].sort((a, b) =>
    `${a.accountId}|${a.app}|${a.deployment}`.localeCompare(`${b.accountId}|${b.app}|${b.deployment}`),
  )) {
    const costs: ActualCost[] = [];
    for (const [category, micros] of group.costs) {
      if (micros < 0) addOverhead({ overhead: "credit", app: group.app, category, micros });
      costs.push({ category, micros: Math.max(micros, 0) });
    }
    // The imported service cost replaces the live estimates for its units.
    const existing = await ledger.day(group.accountId, day);
    for (const entry of Object.values(existing?.entries ?? {}))
      if (
        entry.app === group.app &&
        entry.deployment === group.deployment &&
        !group.costs.has(entry.category) &&
        [...group.costs.keys()].some((category) => entry.category.startsWith(`${category}.`))
      )
        costs.push({ category: entry.category, micros: 0 });
    try {
      await ledger.recordActual({ ...group, day, costs, source: label });
      recorded++;
    } catch (error) {
      if ((error as { code?: string }).code !== "account_missing") throw error;
      for (const [category, micros] of group.costs)
        if (micros > 0) addOverhead({ overhead: "unknown_account", app: group.app, category, micros });
    }
  }
  if (overhead.size) await ledger.recordOverhead({ day, costs: [...overhead.values()], source: label });
  log({ event: "cost_import", day, estimated: report.estimated, actuals: recorded, overhead: overhead.size });
  return { day, imported: true, estimated: report.estimated, actuals: recorded, overhead: overhead.size };
}

/** The scheduled run: re-imports the last few complete UTC days, oldest first. Stops at the first failure. */
export async function importRecentCosts(input: {
  source: CostExplorerSource;
  ledger: Pick<CostLedger, "recordActual" | "recordOverhead" | "day">;
  accountIds: () => Promise<string[]>;
  ownerOf?: (app: CostApp, deployment: string) => Promise<string | null>;
  nowMs: number;
  lookbackDays?: number;
  /** False when the invocation is close to its deadline: the remaining days wait for the next run. */
  hasTime?: () => boolean;
  log?: Log;
}): Promise<ImportResult[]> {
  const results: ImportResult[] = [];
  for (let back = input.lookbackDays ?? IMPORT_LOOKBACK_DAYS; back >= 1; back--) {
    if (input.hasTime && !input.hasTime()) break;
    const result = await importCostDay({ ...input, day: utcDay(input.nowMs - back * DAY_MS) });
    results.push(result);
    if (!result.imported) break;
  }
  return results;
}

/** Cost Explorer through an SDK client, in the Organizations management account (or a role it provides). */
export class AwsCostExplorerSource implements CostExplorerSource {
  constructor(
    private send: (command: unknown) => Promise<any>,
    private commands: { GetCostAndUsageCommand: new (input: any) => unknown },
  ) {}

  async day(day: number): Promise<CostExplorerDay> {
    const text = String(day);
    const start = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
    const end = new Date(Date.parse(`${start}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
    const rows: CostExplorerRow[] = [];
    let estimated = false,
      token: string | undefined;
    do {
      const page = await this.send(
        new this.commands.GetCostAndUsageCommand({
          TimePeriod: { Start: start, End: end },
          Granularity: "DAILY",
          Metrics: ["UnblendedCost"],
          GroupBy: [
            { Type: "TAG", Key: "anthus:cost-key" },
            { Type: "DIMENSION", Key: "SERVICE" },
          ],
          NextPageToken: token,
        }),
      );
      for (const result of page.ResultsByTime ?? []) {
        estimated ||= Boolean(result.Estimated);
        for (const group of result.Groups ?? []) {
          const [tag = "", service = "Unknown"] = group.Keys ?? [];
          const value = tag.slice(tag.indexOf("$") + 1);
          const amount = group.Metrics?.UnblendedCost?.Amount ?? "0";
          const micros = dollarsToMicros(amount);
          if (micros !== 0) rows.push({ costKey: value || null, service, micros });
        }
      }
      token = page.NextPageToken;
    } while (token);
    return { estimated, rows };
  }
}
