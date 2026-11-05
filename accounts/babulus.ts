import type { ProductRegistration } from "./auth";
import type { Operation } from "./model";
import {
  CLIENT_ID_PATTERN,
  COGNITO_ISSUER_PATTERN,
  REVIEW_IDENTIFIER_PATTERN,
  matchesStringPattern,
} from "./validation-rules";

/**
 * The Babulus product. Its server role, Cognito issuer, app client and reviewed federation ID are deployment
 * options, never values in this public repository. Babulus signs people in through its own Google-only Cognito pool,
 * so it is registered like a Papyrus editor site, plus the quota flag for the cloud-fallback spending check.
 */
export interface BabulusOptions {
  roleArn: string;
  issuer: string;
  clientId: string;
  federationReviewId: string;
  /** Optional: a second role (for example a spending gate) allowed on the quota routes only. */
  quotaCallerRoleArn?: string;
}
export const BABULUS_PRODUCT = "babulus";
export const babulusCapabilities: readonly Operation[] = ["console:read", "console:write", "members:read"];
/** Identity, account and authorization reads. Babulus does not create accounts or change memberships. */
export const babulusRoutes: readonly string[] = [
  "GET/v1/identities/me",
  "POST/v1/identities/google/challenge",
  "POST/v1/identities/google/resolve",
  "GET/v1/accounts",
  "GET/v1/accounts/*",
  "POST/v1/accounts/*/authorize",
  "GET/v1/account-directory",
  "GET/v1/account-directory/*",
];
const rolePattern = /^arn:aws:iam::\d{12}:role\/(?:[A-Za-z0-9+=,.@_-]+\/)*[A-Za-z0-9+=,.@_-]+$/;
const optionNames = ["roleArn", "issuer", "clientId", "federationReviewId"];
const optionalNames = ["quotaCallerRoleArn"];

export function babulusRegistration(options: unknown): ProductRegistration {
  const value = options as Record<string, unknown> | null;
  const keys = value && typeof value === "object" ? Object.keys(value).sort() : [];
  const required = [...optionNames].sort();
  if (
    !required.every((name) => keys.includes(name)) ||
    keys.some((name) => !required.includes(name) && !optionalNames.includes(name))
  )
    throw new Error(
      "Exact reviewed Babulus registration required: exactly the four reviewed options, plus optionally the quota caller role.",
    );
  const { roleArn, issuer, clientId, federationReviewId, quotaCallerRoleArn } = value as Record<
    string,
    string
  >;
  if (keys.includes("quotaCallerRoleArn") && !matchesStringPattern(quotaCallerRoleArn, rolePattern))
    throw new Error(
      "Exact reviewed Babulus registration required: the quota caller role must be an IAM role ARN.",
    );
  if (!matchesStringPattern(roleArn, rolePattern))
    throw new Error(
      "Exact reviewed Babulus registration required: the runtime role must be an IAM role ARN.",
    );
  if (!matchesStringPattern(issuer, COGNITO_ISSUER_PATTERN))
    throw new Error(
      "Exact reviewed Babulus registration required: the issuer must be a Cognito user pool URL.",
    );
  if (!matchesStringPattern(clientId, CLIENT_ID_PATTERN))
    throw new Error(
      "Exact reviewed Babulus registration required: the client ID must be a Cognito app client.",
    );
  if (!matchesStringPattern(federationReviewId, REVIEW_IDENTIFIER_PATTERN))
    throw new Error(
      "Exact reviewed Babulus registration required: the federation review ID must be an identifier.",
    );
  return {
    product: BABULUS_PRODUCT,
    roleArn,
    issuer,
    clientIds: [clientId],
    capabilities: [...babulusCapabilities],
    enabled: true,
    accountDirectory: true,
    quota: true,
    ...(quotaCallerRoleArn !== undefined ? { quotaCaller: { roleArn: quotaCallerRoleArn } } : {}),
    googleFederation: { policy: "google-only-unlinked-v1", reviewedPolicyId: federationReviewId, clientId },
  };
}

/** Reads the options from the deployment environment. Absent or switched off: Babulus is not registered. */
export function babulusFromEnvironment(
  environment: Record<string, string | undefined> = process.env,
): ProductRegistration | undefined {
  if (environment.PROSPECTUS_BABULUS_ENABLED !== "true") return undefined;
  return babulusRegistration({
    roleArn: environment.PROSPECTUS_BABULUS_ROLE_ARN,
    issuer: environment.PROSPECTUS_BABULUS_ISSUER,
    clientId: environment.PROSPECTUS_BABULUS_CLIENT_ID,
    federationReviewId: environment.PROSPECTUS_BABULUS_FEDERATION_REVIEW_ID,
    ...(environment.PROSPECTUS_BABULUS_QUOTA_ROLE_ARN
      ? { quotaCallerRoleArn: environment.PROSPECTUS_BABULUS_QUOTA_ROLE_ARN }
      : {}),
  });
}
