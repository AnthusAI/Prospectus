import type { ProductRegistration } from "./auth";
import { fail, type Operation } from "./model";
import {
  PAPYRUS_SITE_PRODUCT_PATTERN,
  REVIEW_IDENTIFIER_PATTERN,
  hasExactlyKeys,
  matchesStringPattern,
  requireRules,
  rule,
  throwErrorWithPrefix,
  type ValidationRule,
} from "./validation-rules";

/** The Cyclotron lab verifier: one reviewed IAM role in the Cyclotron account that may ask Prospectus who a Papyrus
 * site's editor is and whether that person may act on a cyclotron account. The Papyrus token proves identity only;
 * authority is the person's active membership role on an account whose cyclotron product is active. */
export const LAB_VERIFIER_PRODUCT = "cyclotron-lab-verifier";
export const LAB_ENTITLEMENT_PRODUCT = "cyclotron";
/** Never members:read or members:write: the lab learns whether an editor may use an account, not who else may. */
export const labVerifierCapabilities: readonly Operation[] = ["console:read", "console:write"];
export const labVerifierRoutes: readonly string[] = ["GET/v1/identities/me", "POST/v1/accounts/*/authorize"];

export interface LabVerifierEntry {
  roleArn: string;
  reviewId: string;
}
export interface LabVerifier {
  product: typeof LAB_VERIFIER_PRODUCT;
  roleArn: string;
  /** The product whose entitlement and capabilities authorize are evaluated against, whatever site issued the token. */
  entitlementProduct: typeof LAB_ENTITLEMENT_PRODUCT;
  reviewedPolicyId: string;
  capabilities: readonly Operation[];
  /** Exactly the registered Papyrus sites: the verifier has no issuer or client list of its own. */
  sites: readonly ProductRegistration[];
}

const verifierRolePattern = /^arn:aws:iam::\d{12}:role\/(?:[A-Za-z0-9+=,.@_-]+\/)*[A-Za-z0-9+=,.@_-]+$/;

const entryRules: ValidationRule<LabVerifierEntry>[] = [
  rule((entry) => !!entry && typeof entry === "object", "A lab verifier entry must be an object."),
  rule(
    (entry) => hasExactlyKeys(entry, "reviewId,roleArn"),
    "A lab verifier entry must have exactly the reviewed fields.",
  ),
  rule(
    (entry) => matchesStringPattern(entry.roleArn, verifierRolePattern),
    "A lab verifier must be an IAM role.",
  ),
  rule(
    (entry) => matchesStringPattern(entry.reviewId, REVIEW_IDENTIFIER_PATTERN),
    "A lab verifier needs a reviewed identifier.",
  ),
];

const validateEntry = (entry: unknown) =>
  requireRules(
    entry as LabVerifierEntry,
    entryRules,
    throwErrorWithPrefix("Exact reviewed lab verifier registration required:"),
  );

export function labVerifier(entry: unknown, sites: readonly ProductRegistration[]): LabVerifier {
  validateEntry(entry);
  const reviewed = entry as LabVerifierEntry;
  if (sites.length === 0) throw new Error("A lab verifier needs at least one registered Papyrus site.");
  for (const site of sites) {
    // A public-reader site holds no capabilities and is never trusted by the lab, whatever the caller passed.
    if (site.capabilities.length === 0 || site.audience === "public-reader")
      throw new Error("A lab verifier never trusts a public-reader Papyrus site: it holds no capabilities.");
    if (
      !site.enabled ||
      !PAPYRUS_SITE_PRODUCT_PATTERN.test(site.product) ||
      site.googleFederation?.policy !== "google-only-unlinked-v1" ||
      site.clientIds.length !== 1
    )
      throw new Error("A lab verifier trusts only reviewed Google-only Papyrus site registrations.");
  }
  return {
    product: LAB_VERIFIER_PRODUCT,
    roleArn: reviewed.roleArn,
    entitlementProduct: LAB_ENTITLEMENT_PRODUCT,
    reviewedPolicyId: reviewed.reviewId,
    capabilities: [...labVerifierCapabilities],
    sites: structuredClone([...sites]),
  };
}

/** accounts/lab-verifier.json: committed disabled until a reviewed change enables it. Returns the reviewed entry. */
export function reviewedLabVerifierEntry(config: unknown): LabVerifierEntry | undefined {
  const file = config as { enabled?: unknown } & Partial<LabVerifierEntry>;
  if (!file || typeof file !== "object" || !hasExactlyKeys(file, "enabled,reviewId,roleArn"))
    throw new Error("accounts/lab-verifier.json must have exactly enabled, roleArn and reviewId.");
  if (file.enabled === false) return undefined;
  if (file.enabled !== true) throw new Error("accounts/lab-verifier.json enabled must be true or false.");
  const { roleArn, reviewId } = file as LabVerifierEntry;
  validateEntry({ roleArn, reviewId });
  return { roleArn, reviewId };
}

const attached = new WeakMap<object, LabVerifier>();
/** Called by `registrations` only, after it proves the verifier collides with no registered product or role. */
export const attachLabVerifier = (validated: object, verifier: LabVerifier) => {
  attached.set(validated, verifier);
};
export const labVerifierOf = (validated: object): LabVerifier | undefined => attached.get(validated);

/** Picks the registered site whose pool and client issued the token. The result selects which registration verifies
 * the token; nothing here trusts the claims. Every unmatched token fails identically to a forged one. */
export function siteForToken(verifier: LabVerifier, token: string | undefined): ProductRegistration {
  const unverifiable = () => fail(401, "invalid_human", "Identity evidence could not be verified.");
  if (!token || token.length > 16384)
    return fail(401, "human_required", "Verified identity evidence is required.");
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return unverifiable();
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return unverifiable();
  }
  const site = verifier.sites.find(
    (candidate) =>
      candidate.enabled &&
      typeof claims?.iss === "string" &&
      typeof claims.client_id === "string" &&
      candidate.issuer === claims.iss &&
      candidate.clientIds.includes(claims.client_id),
  );
  return site ?? unverifiable();
}
