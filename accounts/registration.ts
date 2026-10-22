import { isDeepStrictEqual } from "node:util";
import type { ProductRegistration } from "./auth";
import { LAB_VERIFIER_PRODUCT, attachLabVerifier, type LabVerifier } from "./lab-verifier";
import { GOOGLE_CLIENT_ID_PATTERN, GOOGLE_DIRECT_POLICY, GOOGLE_ISSUER } from "./google-direct";
import {
  CLIENT_ID_PATTERN,
  REVIEW_IDENTIFIER_PATTERN,
  hasOnlyKeys,
  isCognitoIssuer,
  isProductName,
  PAPYRUS_SITE_PRODUCT_PATTERN,
  matchesStringPattern,
  requireRules,
  throwErrorWithPrefix,
  rule,
  type ValidationRule,
} from "./validation-rules";
const operations = new Set(["console:read", "console:write", "members:read", "members:write"]);
const rolePattern = /^arn:aws:iam::(\d{12}):role\/(?:[A-Za-z0-9+=,.@_-]+\/)*([A-Za-z0-9+=,.@_-]+)$/;
const MAXIMUM_REGISTRATIONS = 100;
const registrationFields = [
  "product",
  "roleArn",
  "issuer",
  "clientIds",
  "capabilities",
  "enabled",
  "googleFederation",
  "accountDirectory",
  "audience",
  "executionDelegation",
];
const federationFields = ["policy", "reviewedPolicyId", "clientId"];
const delegationFields = [
  "roleArn",
  "enrollmentRoleArn",
  "issuer",
  "clientId",
  "enrollmentPolicyRevision",
  "reviewedPolicyId",
];
declare const validatedRegistrationsBrand: unique symbol;
export type ValidatedRegistrations = readonly ProductRegistration[] & {
  readonly [validatedRegistrationsBrand]: true;
};

interface RegistrationUnderValidation {
  item: any;
  registeredProducts: ReadonlySet<string>;
}

interface DelegationUnderValidation {
  item: any;
  pair: any;
}

const isRoleArn = (value: unknown) => matchesStringPattern(value, rolePattern);
const isReviewIdentifier = (value: unknown) => matchesStringPattern(value, REVIEW_IDENTIFIER_PATTERN);
const isClientId = (value: unknown) => matchesStringPattern(value, CLIENT_ID_PATTERN);
const isGoogleClientId = (value: unknown) => matchesStringPattern(value, GOOGLE_CLIENT_ID_PATTERN);
/** The only product allowed no capabilities: a Papyrus site that is explicitly a reviewed Google-only public reader. */
const isPublicReaderShape = (item: any) =>
  item.audience === "public-reader" &&
  matchesStringPattern(item.product, PAPYRUS_SITE_PRODUCT_PATTERN) &&
  item.googleFederation?.policy === "google-only-unlinked-v1";
const isGoogleDirectItem = (item: any) => item?.googleFederation?.policy === GOOGLE_DIRECT_POLICY;

const registrationRules: ValidationRule<RegistrationUnderValidation>[] = [
  rule(({ item }) => !!item, "A product registration must be an object."),
  rule(
    ({ item }) => hasOnlyKeys(item, registrationFields),
    "A product registration has a field that is not allowed.",
  ),
  rule(({ item }) => typeof item.product === "string", "A product name must be a string."),
  rule(
    ({ item }) => isProductName(item.product),
    "A product name must be lowercase letters, digits and hyphens, starting with a letter.",
  ),
  rule(({ item }) => typeof item.roleArn === "string", "A product runtime role ARN must be a string."),
  rule(
    ({ item }) => matchesStringPattern(item.roleArn, rolePattern),
    "A product runtime role must be an IAM role ARN.",
  ),
  rule(({ item }) => typeof item.issuer === "string", "A product issuer must be a string."),
  rule(
    ({ item }) => isGoogleDirectItem(item) || isCognitoIssuer(item.issuer),
    "A product issuer must be a regional Cognito user pool URL.",
  ),
  rule(
    ({ item }) => !isGoogleDirectItem(item) || item.issuer === GOOGLE_ISSUER,
    "A google-direct product issuer must be Google.",
  ),
  rule(({ item }) => Array.isArray(item.clientIds), "Product client IDs must be an array."),
  rule(({ item }) => item.clientIds.length > 0, "A product needs at least one client ID."),
  rule(
    ({ item }) => isGoogleDirectItem(item) || item.clientIds.every(isClientId),
    "Product client IDs must be lowercase alphanumeric identifiers.",
  ),
  rule(
    ({ item }) => !isGoogleDirectItem(item) || item.clientIds.every(isGoogleClientId),
    "Google-direct product client IDs must be Google OAuth client IDs.",
  ),
  rule(({ item }) => Array.isArray(item.capabilities), "Product capabilities must be an array."),
  rule(
    ({ item }) => item.capabilities.length > 0 || isPublicReaderShape(item),
    "A product needs at least one capability.",
  ),
  rule(
    ({ item }) => item.audience === undefined || item.audience === "public-reader",
    "A product audience must be absent or public-reader.",
  ),
  rule(
    ({ item }) =>
      item.audience === undefined || matchesStringPattern(item.product, PAPYRUS_SITE_PRODUCT_PATTERN),
    "A public-reader product must be a Papyrus site named papyrus-<site>.",
  ),
  rule(
    ({ item }) => item.audience === undefined || item.capabilities.length === 0,
    "A public-reader product holds no capabilities.",
  ),
  rule(
    ({ item }) => item.audience === undefined || item.accountDirectory === undefined,
    "A public-reader product cannot hold an account directory.",
  ),
  rule(
    ({ item }) => item.audience === undefined || item.executionDelegation === undefined,
    "A public-reader product cannot hold an execution delegation.",
  ),
  rule(
    ({ item }) => item.capabilities.every((operation: unknown) => operations.has(operation as string)),
    "Product capabilities must be known operations.",
  ),
  rule(({ item }) => typeof item.enabled === "boolean", "A product enabled flag must be a boolean."),
  rule(
    ({ item, registeredProducts }) => !registeredProducts.has(item.product),
    "Each product may be registered only once.",
  ),
];

const federationRules: ValidationRule<any>[] = [
  rule((policy) => !!policy, "A Google federation policy must be an object."),
  rule(
    (policy) => hasOnlyKeys(policy, federationFields),
    "A Google federation policy has a field that is not allowed.",
  ),
  rule(
    (policy) => policy.policy === "google-only-unlinked-v1" || policy.policy === GOOGLE_DIRECT_POLICY,
    "A Google federation policy must be google-only-unlinked-v1 or google-direct-v1.",
  ),
  rule(
    (policy) => isReviewIdentifier(policy.reviewedPolicyId),
    "A Google federation policy needs a reviewed policy identifier.",
  ),
];

const delegationRules: ValidationRule<DelegationUnderValidation>[] = [
  rule(({ pair }) => !!pair, "An execution delegation must be an object."),
  rule(
    ({ pair }) => hasOnlyKeys(pair, delegationFields),
    "An execution delegation has a field that is not allowed.",
  ),
  rule(
    ({ item }) => !!item.googleFederation,
    "An execution delegation requires a reviewed Google federation policy.",
  ),
  rule(({ item }) => !item.accountDirectory, "A directory principal cannot hold an execution delegation."),
  rule(({ pair }) => isRoleArn(pair.roleArn), "An execution role must be an IAM role ARN."),
  rule(
    ({ pair, item }) => pair.enrollmentRoleArn === item.roleArn,
    "An execution delegation must name the product's enrollment role.",
  ),
  rule(
    ({ pair, item }) => pair.issuer === item.issuer,
    "An execution delegation must use the product's issuer.",
  ),
  rule(
    ({ pair, item }) => pair.clientId === item.googleFederation.clientId,
    "An execution delegation must use the federation client.",
  ),
  rule(
    ({ pair, item }) => pair.enrollmentPolicyRevision === item.googleFederation.reviewedPolicyId,
    "An execution delegation must cite the reviewed federation policy.",
  ),
  rule(
    ({ pair }) => isReviewIdentifier(pair.reviewedPolicyId),
    "An execution delegation needs a reviewed policy identifier.",
  ),
];

/** Invalid/ambiguous deployment registries never become a permissive runtime.
 * Validate once where a runtime is composed; request handlers accept only the result.
 */
export function registrations(
  value: unknown,
  options: { labVerifier?: LabVerifier } = {},
): ValidatedRegistrations {
  if (!Array.isArray(value)) throw new Error("Exact product runtime registrations are required.");
  if (value.length === 0) throw new Error("At least one product runtime registration is required.");
  if (value.length > MAXIMUM_REGISTRATIONS)
    throw new Error("Product runtime registrations exceed the maximum of 100.");
  const products = new Set<string>(),
    roles = new Set<string>();
  const registrationsSnapshot = structuredClone(value);
  for (const item of registrationsSnapshot) {
    requireRules(
      { item, registeredProducts: products },
      registrationRules,
      throwErrorWithPrefix("Invalid or ambiguous product registration:"),
    );
    if (item.accountDirectory !== undefined && item.accountDirectory !== true)
      throw new Error("Directory registration must be explicitly true or absent.");
    if (item.googleFederation !== undefined) {
      requireRules(
        item.googleFederation,
        federationRules,
        throwErrorWithPrefix("An exact reviewed Google-only federation policy/client is required:"),
      );
      if (!item.clientIds.includes(item.googleFederation.clientId))
        throw new Error(
          "An exact reviewed Google-only federation policy/client is required: its client must be one of the product's client IDs.",
        );
    }
    if (isGoogleDirectItem(item)) {
      if (item.executionDelegation !== undefined || item.accountDirectory !== true)
        throw new Error(
          "A google-direct product must be a directory principal with no execution delegation.",
        );
      if (item.googleFederation.clientId !== item.clientIds[0] || item.clientIds.length !== 1)
        throw new Error("A google-direct product has exactly one client: its Google OAuth client.");
      if (
        item.capabilities.some((operation: string) => !["console:read", "members:read"].includes(operation))
      )
        throw new Error("A google-direct product may hold only the read capabilities.");
    }
    const pair = item.executionDelegation;
    if (pair !== undefined)
      requireRules(
        { item, pair },
        delegationRules,
        throwErrorWithPrefix("An exact reviewed enrollment-to-execution binding is required:"),
      );
    for (const principal of [item.roleArn, ...(pair ? [pair.roleArn] : [])]) {
      const role = rolePattern.exec(principal)!;
      // STS assumed-role evidence omits IAM paths; reject role-name collisions.
      const key = `${role[1]}:${role[2]}`;
      if (roles.has(key))
        throw new Error("Runtime principals must be unique and cannot delegate transitively.");
      roles.add(key);
    }
    products.add(item.product);
  }
  const verifier = options.labVerifier;
  if (verifier) {
    // The verifier is one more principal: its role name may not collide with any registration's, and it trusts only
    // sites that are registered here exactly as reviewed, so no second issuer or client list can drift.
    const role = rolePattern.exec(verifier.roleArn);
    if (!role || roles.has(`${role[1]}:${role[2]}`) || products.has(LAB_VERIFIER_PRODUCT))
      throw new Error("Runtime principals must be unique and cannot delegate transitively.");
    const sites = verifier.sites.map((site) =>
      registrationsSnapshot.find((registered: ProductRegistration) => isDeepStrictEqual(registered, site)),
    );
    if (sites.some((site: ProductRegistration | undefined) => !site))
      throw new Error("A lab verifier trusts only registered Papyrus sites.");
    const validated = registrationsSnapshot as unknown as ValidatedRegistrations;
    attachLabVerifier(validated, { ...verifier, sites });
    return validated;
  }
  return registrationsSnapshot as unknown as ValidatedRegistrations;
}
