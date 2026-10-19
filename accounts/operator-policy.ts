import { createHash } from "node:crypto";
import type { Context } from "./model";
import {
  REVIEW_IDENTIFIER_PATTERN,
  hasExactlyKeys,
  isCognitoIssuer,
  isProductName,
  matchesStringPattern,
  requireRules,
  throwErrorWithPrefix,
  rule,
  type ValidationRule,
} from "./validation-rules";
export const operatorPermissions = ["accounts:admin:read", "accounts:admin:entitlements"] as const;
export type OperatorPermission = (typeof operatorPermissions)[number];
/** Deployment-owned operator grants. Never derive these from email, CRM groups or memberships. */
export interface OperatorGrant {
  product: string;
  issuer: string;
  subjectHash: string;
  permission: OperatorPermission;
  reviewedGrantId: string;
}
export const operatorSubjectHash = (subject: string) => createHash("sha256").update(subject).digest("hex");
const MAXIMUM_OPERATOR_GRANTS = 20;
const SUBJECT_HASH_PATTERN = /^[a-f0-9]{64}$/;
const grantKeys = "issuer,permission,product,reviewedGrantId,subjectHash";

const grantRules: ValidationRule<OperatorGrant>[] = [
  rule((grant) => !!grant && typeof grant === "object", "A central operator grant must be an object."),
  rule(
    (grant) => hasExactlyKeys(grant, grantKeys),
    "A central operator grant must have exactly the reviewed fields.",
  ),
  rule((grant) => typeof grant.product === "string", "A central operator grant product must be a string."),
  rule(
    (grant) => isProductName(grant.product),
    "A central operator grant product must be lowercase letters, digits and hyphens, starting with a letter.",
  ),
  rule((grant) => typeof grant.issuer === "string", "A central operator grant issuer must be a string."),
  rule(
    (grant) => isCognitoIssuer(grant.issuer),
    "A central operator grant issuer must be a regional Cognito user pool URL.",
  ),
  rule(
    (grant) => typeof grant.subjectHash === "string",
    "A central operator grant subject hash must be a string.",
  ),
  rule(
    (grant) => matchesStringPattern(grant.subjectHash, SUBJECT_HASH_PATTERN),
    "A central operator grant subject hash must be a SHA-256 hex digest.",
  ),
  rule(
    (grant) => (operatorPermissions as readonly string[]).includes(grant.permission),
    "A central operator grant permission must be a known operator permission.",
  ),
  rule(
    (grant) => typeof grant.reviewedGrantId === "string",
    "A central operator grant review ID must be a string.",
  ),
  rule(
    (grant) => matchesStringPattern(grant.reviewedGrantId, REVIEW_IDENTIFIER_PATTERN),
    "A central operator grant review ID must be a reviewed identifier.",
  ),
];

export function operatorGrants(value: unknown): readonly OperatorGrant[] {
  if (!Array.isArray(value)) throw new Error("Central operator policy must be an array of grants.");
  if (value.length > MAXIMUM_OPERATOR_GRANTS)
    throw new Error("Central operator policy exceeds the maximum of 20 grants.");
  const seen = new Set<string>();
  for (const grant of value) {
    requireRules(grant, grantRules, throwErrorWithPrefix("Exact reviewed central operator grant required:"));
    const key = JSON.stringify([grant.product, grant.issuer, grant.subjectHash, grant.permission]);
    if (seen.has(key)) throw new Error("Duplicate central operator grant.");
    seen.add(key);
  }
  return structuredClone(value);
}
/** Call only after canonical Person resolution has validated the current session proof. */
export function hasOperatorPermission(
  context: Context,
  grants: readonly OperatorGrant[],
  permission: OperatorPermission,
): boolean {
  return grants.some(
    (grant) =>
      grant.product === context.product &&
      grant.issuer === context.human.issuer &&
      grant.subjectHash === operatorSubjectHash(context.human.subject) &&
      grant.permission === permission,
  );
}
export const canReadOperatorDirectory = (context: Context, grants: readonly OperatorGrant[]) =>
  hasOperatorPermission(context, grants, "accounts:admin:read");
