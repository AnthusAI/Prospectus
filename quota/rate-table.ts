import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { isPlainRecord, matchesStringPattern } from "../accounts/validation-rules";
import { fail, type BillableItem } from "./model";

/**
 * The private rate table. The repository holds only this engine; the table itself (rates and each plan's weekly
 * allowance) lives outside Git in an SSM SecureString whose value operators set. Rates are integers: `units` usage
 * units per `per` of the item's own quantity, rounded up per item.
 */
export interface RateTable {
  /** Names this exact table. Every charge records it, so a later change never rewrites what was charged. */
  version: string;
  defaultPlan?: string;
  plans: Record<string, { weeklyAllowanceUnits: number }>;
  rates: Record<string, { units: number; per: number }>;
}

export const ITEM_KIND_PATTERN = /^[a-z][a-z0-9]*(\.[a-z0-9][a-z0-9_:-]*)+$/;
export const PLAN_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
const VERSION_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const MAXIMUM_ITEM_KIND_LENGTH = 96;

const unavailable = (): never =>
  fail(503, "quota_unavailable", "Quota is unavailable. Do not spend; retry with the same operation ID.");
const whole = (value: unknown, minimum: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= minimum;
const onlyKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

export const isItemKind = (value: unknown): value is string =>
  typeof value === "string" && value.length <= MAXIMUM_ITEM_KIND_LENGTH && ITEM_KIND_PATTERN.test(value);

/** Strict parse. Anything unparseable, unknown or inconsistent is "unavailable" (503), never an empty or free table. */
export function parseRateTable(text: unknown): RateTable {
  let value: unknown;
  try {
    value = JSON.parse(String(text));
  } catch {
    return unavailable();
  }
  if (
    !isPlainRecord(value) ||
    !onlyKeys(value, ["version", "defaultPlan", "plans", "rates"]) ||
    !matchesStringPattern(value.version, VERSION_PATTERN) ||
    !isPlainRecord(value.plans) ||
    !isPlainRecord(value.rates)
  )
    return unavailable();
  const plans: RateTable["plans"] = {},
    rates: RateTable["rates"] = {};
  for (const [id, plan] of Object.entries(value.plans)) {
    if (!PLAN_PATTERN.test(id) || !isPlainRecord(plan) || Object.keys(plan).length !== 1)
      return unavailable();
    // A plan names exactly one allowance. Units are microdollars of real cost (docs/COST_ACCOUNTING.md): a monthly
    // budget allows a quarter of itself each week, rounded down. Tables written before that keep a weekly figure.
    if (whole(plan.weeklyAllowanceUnits, 0)) plans[id] = { weeklyAllowanceUnits: plan.weeklyAllowanceUnits };
    else if (whole(plan.monthlyBudgetMicrodollars, 0))
      plans[id] = { weeklyAllowanceUnits: Math.floor(plan.monthlyBudgetMicrodollars / 4) };
    else return unavailable();
  }
  for (const [kind, rate] of Object.entries(value.rates)) {
    if (!isItemKind(kind) || !isPlainRecord(rate) || !onlyKeys(rate, ["units", "per"])) return unavailable();
    if (!whole(rate.units, 0) || !whole(rate.per, 1)) return unavailable();
    rates[kind] = { units: rate.units, per: rate.per };
  }
  if (value.defaultPlan !== undefined && (typeof value.defaultPlan !== "string" || !plans[value.defaultPlan]))
    return unavailable();
  return {
    version: value.version,
    ...(value.defaultPlan !== undefined ? { defaultPlan: value.defaultPlan } : {}),
    plans,
    rates,
  };
}

export interface Conversion {
  units: number;
  lines: Array<{ itemKind: string; quantity: number; units: number }>;
}

/** Items to usage units. An item kind the table does not know is refused, so unpriced work is never free. */
export function convertItems(table: RateTable, items: readonly BillableItem[]): Conversion {
  let total = 0n;
  const lines: Conversion["lines"] = [];
  for (const item of items) {
    const rate = table.rates[item.itemKind];
    if (!rate) fail(422, "unknown_item_kind", "An item kind is not recognized.");
    const units = (BigInt(item.quantity) * BigInt(rate.units) + BigInt(rate.per) - 1n) / BigInt(rate.per);
    total += units;
    lines.push({ itemKind: item.itemKind, quantity: item.quantity, units: Number(units) });
  }
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) fail(400, "invalid_quantity", "The quantity is too large.");
  return { units: Number(total), lines };
}

export const unknownItemKinds = (table: RateTable, items: readonly BillableItem[]) => [
  ...new Set(items.filter((item) => !table.rates[item.itemKind]).map((item) => item.itemKind)),
];

/** Where the table comes from. It throws whenever the table cannot be used, so every caller fails closed. */
export interface RateTableSource {
  current(): Promise<RateTable>;
}

/** No table configured: every call is refused as unavailable. */
export const unconfiguredRateTable: RateTableSource = { current: async () => unavailable() };

export interface RateTableConfiguration {
  version: "v1";
  parameterName: string;
}
const PARAMETER_PATTERN = /^\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*\/v1$/;
export function rateTableConfiguration(value: unknown): RateTableConfiguration {
  if (
    isPlainRecord(value) &&
    Object.keys(value).sort().join(",") === "parameterName,version" &&
    value.version === "v1" &&
    matchesStringPattern(value.parameterName, PARAMETER_PATTERN)
  )
    return { version: "v1", parameterName: value.parameterName };
  throw new Error("The quota rate table must be a reviewed v1 Parameter Store name ending in /v1.");
}

/** Reads the SecureString and caches the parsed table briefly, so a change applies within one refresh interval and a
 * failed read is never cached. The value is never logged. */
export class ParameterStoreRateTable implements RateTableSource {
  private cached?: { table: RateTable; expires: number };
  constructor(
    private configuration: RateTableConfiguration,
    private client: Pick<SSMClient, "send"> = new SSMClient({ region: "us-east-1" }),
    private refreshMs = 60_000,
    private now: () => number = Date.now,
  ) {}
  async current(): Promise<RateTable> {
    if (this.cached && this.cached.expires > this.now()) return this.cached.table;
    let value: string | undefined;
    try {
      value = (
        await this.client.send(
          new GetParameterCommand({ Name: this.configuration.parameterName, WithDecryption: true }),
        )
      ).Parameter?.Value;
    } catch {
      return unavailable();
    }
    const table = parseRateTable(value);
    this.cached = { table, expires: this.now() + this.refreshMs };
    return table;
  }
}

/** Validates items a caller sent: an array of {itemKind, quantity} with whole non-negative quantities. */
export function parseItems(value: unknown, minimumCount: number): BillableItem[] {
  if (!Array.isArray(value) || value.length < minimumCount)
    return fail(400, "invalid_items", "A list of billable items is required.");
  return value.map((item) => {
    if (!isPlainRecord(item) || !onlyKeys(item, ["itemKind", "quantity"]))
      return fail(400, "invalid_items", "Each item is an itemKind and a quantity.");
    if (!isItemKind(item.itemKind)) return fail(400, "invalid_item_kind", "An item kind is malformed.");
    if (!whole(item.quantity, 0)) return fail(400, "invalid_quantity", "A quantity must be a whole number.");
    return { itemKind: item.itemKind, quantity: item.quantity };
  });
}
