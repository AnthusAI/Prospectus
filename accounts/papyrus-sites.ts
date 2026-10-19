import type { ProductRegistration } from "./auth";
import type { Operation } from "./model";
import {
  CLIENT_ID_PATTERN,
  COGNITO_ISSUER_PATTERN,
  REVIEW_IDENTIFIER_PATTERN,
  hasExactlyKeys,
  requireRules,
  throwErrorWithPrefix,
  rule,
  type ValidationRule,
} from "./validation-rules";
/** Reviewed Papyrus site entries. Each site reads its people's accounts; account creation and membership writes stay with other products. */
export interface PapyrusSiteEntry {
  product: string;
  roleArn: string;
  issuer: string;
  clientId: string;
  federationReviewId: string;
  siteReviewId: string;
}
export const papyrusSiteCapabilities: readonly Operation[] = [
  "console:read",
  "console:write",
  "members:read",
];
export const papyrusSiteRoutes: readonly string[] = [
  "GET/v1/identities/me",
  "POST/v1/identities/google/challenge",
  "POST/v1/identities/google/resolve",
  "GET/v1/accounts",
  "GET/v1/accounts/*",
  "POST/v1/accounts/*/authorize",
  "GET/v1/account-directory",
  "GET/v1/account-directory/*",
];
const siteRolePattern = /^arn:aws:iam::\d{12}:role\/(?:[A-Za-z0-9+=,.@_-]+\/)*[A-Za-z0-9+=,.@_-]+$/;
const PAPYRUS_PRODUCT_PATTERN = /^papyrus-[a-z0-9][a-z0-9-]{0,31}$/;
const MAXIMUM_PAPYRUS_SITES = 40;
const siteEntryKeys = "clientId,federationReviewId,issuer,product,roleArn,siteReviewId";
const isString = (value: unknown): value is string => typeof value === "string";

const siteEntryRules: ValidationRule<PapyrusSiteEntry>[] = [
  rule((site) => !!site && typeof site === "object", "A Papyrus site entry must be an object."),
  rule(
    (site) => hasExactlyKeys(site, siteEntryKeys),
    "A Papyrus site entry must have exactly the reviewed fields.",
  ),
  rule((site) => isString(site.product), "A Papyrus site product must be a string."),
  rule(
    (site) => PAPYRUS_PRODUCT_PATTERN.test(site.product),
    "A Papyrus site product must be named papyrus-<site> in lowercase letters, digits and hyphens.",
  ),
  rule((site) => isString(site.roleArn), "A Papyrus site runtime role ARN must be a string."),
  rule((site) => siteRolePattern.test(site.roleArn), "A Papyrus site runtime role must be an IAM role ARN."),
  rule((site) => isString(site.issuer), "A Papyrus site issuer must be a string."),
  rule(
    (site) => COGNITO_ISSUER_PATTERN.test(site.issuer),
    "A Papyrus site issuer must be a regional Cognito user pool URL.",
  ),
  rule((site) => isString(site.clientId), "A Papyrus site client ID must be a string."),
  rule(
    (site) => CLIENT_ID_PATTERN.test(site.clientId),
    "A Papyrus site client ID must be a lowercase alphanumeric identifier.",
  ),
  rule((site) => isString(site.federationReviewId), "A Papyrus site federation review ID must be a string."),
  rule(
    (site) => REVIEW_IDENTIFIER_PATTERN.test(site.federationReviewId),
    "A Papyrus site federation review ID must be a reviewed identifier.",
  ),
  rule((site) => isString(site.siteReviewId), "A Papyrus site review ID must be a string."),
  rule(
    (site) => REVIEW_IDENTIFIER_PATTERN.test(site.siteReviewId),
    "A Papyrus site review ID must be a reviewed identifier.",
  ),
];

export function papyrusSiteRegistrations(value: unknown): ProductRegistration[] {
  if (!Array.isArray(value)) throw new Error("Reviewed Papyrus site registrations are required.");
  if (value.length > MAXIMUM_PAPYRUS_SITES)
    throw new Error("Reviewed Papyrus site registrations exceed the maximum of 40.");
  const products = new Set<string>(),
    roles = new Set<string>();
  return value.map((site: PapyrusSiteEntry) => {
    requireRules(
      site,
      siteEntryRules,
      throwErrorWithPrefix("Exact reviewed Papyrus site registration required:"),
    );
    if (products.has(site.product)) throw new Error("Each Papyrus site needs its own product name.");
    if (roles.has(site.roleArn)) throw new Error("Each Papyrus site needs its own runtime role.");
    products.add(site.product);
    roles.add(site.roleArn);
    return {
      product: site.product,
      roleArn: site.roleArn,
      issuer: site.issuer,
      clientIds: [site.clientId],
      capabilities: [...papyrusSiteCapabilities],
      enabled: true,
      accountDirectory: true as const,
      googleFederation: {
        policy: "google-only-unlinked-v1" as const,
        reviewedPolicyId: site.federationReviewId,
        clientId: site.clientId,
      },
    };
  });
}
