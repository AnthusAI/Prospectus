import { randomUUID } from "node:crypto";
import type { IdentityFiles } from "../../accounts/identity-files";
import type { Context } from "../../accounts/model";
import { operatorSubjectHash, type OperatorGrant } from "../../accounts/operator-policy";
import { MemoryBillingFiles } from "../../billing/testing/memory-billing-files";
import { Quota, type QuotaOptions } from "../service";

export const ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/synthetic-operator-pool".replace(
  "synthetic-operator-pool",
  ["us-east-1", "Example"].join("_"),
);
export const OPERATOR_PRODUCT = "prospectus-crm";
export const START = Date.parse("2030-03-17T17:46:40.000Z");

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

/** Synthetic accounts, a mutable clock and in-memory Virtuus-style files. No AWS. */
export function quotaFixture(options: { storage?: IdentityFiles; quota?: QuotaOptions } = {}) {
  const files = new MemoryBillingFiles();
  const store = options.storage ?? files;
  const accountId = randomUUID();
  const entitlements: Record<string, Record<string, { status: "active" | "disabled" }>> = {
    [accountId]: { "example-renderer": { status: "active" }, "example-narrator": { status: "active" } },
  };
  const clock = { ms: START };
  const accounts = async (id: string) =>
    entitlements[id] ? { entitlements: structuredClone(entitlements[id]) } : null;
  const quota = new Quota(store, accounts, grants, () => new Date(clock.ms).toISOString(), options.quota);
  const ada = operator("ada");
  const grantAllowance = (allowanceCents: number, id = accountId) =>
    quota.grant(ada, id, { operationId: randomUUID(), allowanceCents });
  const reserve = (
    maxCents: number,
    overrides: Record<string, unknown> = {},
    caller = RENDERER,
    id = accountId,
  ) =>
    quota.reserve(caller, id, { operationId: randomUUID(), maxCents, expiresInSeconds: 3600, ...overrides });
  return { files, store, accountId, entitlements, clock, quota, ada, grantAllowance, reserve };
}
