import { createHash } from "node:crypto";
import type { Context } from "./model";
/** Deployment-owned read grants. Never derive these from email, CRM groups or memberships. */
export interface OperatorGrant {
  product: string;
  issuer: string;
  subjectHash: string;
  permission: "accounts:admin:read";
  reviewedGrantId: string;
}
export const operatorSubjectHash = (subject: string) => createHash("sha256").update(subject).digest("hex");
export function operatorGrants(value: unknown): readonly OperatorGrant[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error("Invalid central operator policy.");
  const seen = new Set<string>();
  for (const grant of value) {
    if (
      !grant ||
      typeof grant !== "object" ||
      Object.keys(grant).sort().join(",") !== "issuer,permission,product,reviewedGrantId,subjectHash" ||
      !/^[a-z][a-z0-9-]{0,39}$/.test(grant.product) ||
      !/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[a-zA-Z0-9_-]+$/.test(grant.issuer) ||
      typeof grant.subjectHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(grant.subjectHash) ||
      grant.permission !== "accounts:admin:read" ||
      typeof grant.reviewedGrantId !== "string" ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(grant.reviewedGrantId)
    )
      throw new Error("Exact reviewed central operator grant required.");
    const key = JSON.stringify([grant.product, grant.issuer, grant.subjectHash]);
    if (seen.has(key)) throw new Error("Duplicate central operator grant.");
    seen.add(key);
  }
  return structuredClone(value);
}
/** Call only after canonical Person resolution has validated the current session proof. */
export function canReadOperatorDirectory(context: Context, grants: readonly OperatorGrant[]): boolean {
  return grants.some(
    (grant) =>
      grant.product === context.product &&
      grant.issuer === context.human.issuer &&
      grant.subjectHash === operatorSubjectHash(context.human.subject) &&
      grant.permission === "accounts:admin:read",
  );
}
