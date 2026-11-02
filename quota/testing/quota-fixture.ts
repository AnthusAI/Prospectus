import { randomUUID } from "node:crypto";
import type { IdentityFiles } from "../../accounts/identity-files";
import type { Context } from "../../accounts/model";
import { operatorSubjectHash, type OperatorGrant } from "../../accounts/operator-policy";
import { MemoryBillingFiles } from "../../billing/testing/memory-billing-files";
import { QuotaError } from "../model";
import type { BillableItem } from "../model";
import { parseRateTable, type RateTable, type RateTableSource } from "../rate-table";
import { Quota, type QuotaOptions } from "../service";

export const ISSUER = `https://cognito-idp.us-east-1.amazonaws.com/${["us-east-1", "Example"].join("_")}`;
export const OPERATOR_PRODUCT = "prospectus-crm";
export const CREATED = Date.parse("2030-03-15T17:46:40.000Z");
/** Two days into the account's first week. */
export const START = CREATED + 2 * 24 * 60 * 60 * 1000;
export const WEEK = 7 * 24 * 60 * 60 * 1000;

export const operator = (subject: string): Context => ({
  product: OPERATOR_PRODUCT,
  principal: "synthetic-operator-runtime",
  human: { issuer: ISSUER, subject },
  capabilities: [],
});
const grant = (subject: string, permission: OperatorGrant["permission"]): OperatorGrant => ({
  product: OPERATOR_PRODUCT,
  issuer: ISSUER,
  subjectHash: operatorSubjectHash(subject),
  permission,
  reviewedGrantId: `synthetic-${subject}-${permission.split(":").pop()}`,
});
export const grants: readonly OperatorGrant[] = [
  grant("ada", "accounts:admin:quota"),
  grant("ada", "accounts:admin:read"),
  grant("reader", "accounts:admin:read"),
  grant("entitler", "accounts:admin:entitlements"),
];

export const RENDERER = { product: "example-renderer" };
export const NARRATOR = { product: "example-narrator" };

/** A made-up table. Nothing here resembles any real rate or allowance. */
export const exampleTable = (): RateTable => ({
  version: "example-1",
  defaultPlan: "example-basic",
  plans: { "example-basic": { weeklyAllowanceUnits: 1000 }, "example-large": { weeklyAllowanceUnits: 5000 } },
  rates: {
    "example.tokens": { units: 1, per: 10 },
    "example.batch.seconds": { units: 3, per: 1 },
    "example.lambda.seconds": { units: 1, per: 2 },
  },
});
/** Units for work in a made-up kind: batch seconds are 3 units each, tokens are 1 unit per 10. */
export const batch = (seconds: number): BillableItem[] => [
  { itemKind: "example.batch.seconds", quantity: seconds },
];
export const tokens = (count: number): BillableItem[] => [{ itemKind: "example.tokens", quantity: count }];

/** A table source tests can change, break or make unparseable. */
export class FakeTable implements RateTableSource {
  table: RateTable | string = exampleTable();
  broken = false;
  async current(): Promise<RateTable> {
    if (this.broken) throw new QuotaError(503, "quota_unavailable", "Quota is unavailable.");
    return typeof this.table === "string" ? parseRateTable(this.table) : structuredClone(this.table);
  }
}

/** Synthetic accounts, a mutable clock and in-memory Virtuus-style files. No AWS. */
export function quotaFixture(
  options: { storage?: IdentityFiles; quota?: QuotaOptions; created?: number } = {},
) {
  const files = new MemoryBillingFiles();
  const store = options.storage ?? files;
  const accountId = randomUUID();
  const createdAt = new Date(options.created ?? CREATED).toISOString();
  const entitlements: Record<string, Record<string, { status: "active" | "disabled" }>> = {
    [accountId]: { "example-renderer": { status: "active" }, "example-narrator": { status: "active" } },
  };
  const clock = { ms: START };
  const accounts = async (id: string) =>
    entitlements[id] ? { createdAt, entitlements: structuredClone(entitlements[id]) } : null;
  const table = new FakeTable();
  const quota = new Quota(
    store,
    accounts,
    grants,
    () => new Date(clock.ms).toISOString(),
    table,
    options.quota,
  );
  const ada = operator("ada");
  const setAllowance = (
    input: { plan?: string | null; allowanceOverrideUnits?: number | null },
    id = accountId,
  ) => quota.setAllowance(ada, id, { operationId: randomUUID(), ...input });
  const reserve = (
    items: BillableItem[],
    overrides: Record<string, unknown> = {},
    caller = RENDERER,
    id = accountId,
  ) => quota.reserve(caller, id, { operationId: randomUUID(), items, expiresInSeconds: 3600, ...overrides });
  const settle = (reservationId: unknown, items: BillableItem[], caller = RENDERER) =>
    quota.settle(caller, accountId, reservationId, { operationId: randomUUID(), items });
  const percent = async () => (await quota.check(RENDERER, accountId)).result.percentUsed as number;
  return {
    files,
    store,
    accountId,
    entitlements,
    clock,
    table,
    quota,
    ada,
    setAllowance,
    reserve,
    settle,
    percent,
    createdAt,
  };
}
