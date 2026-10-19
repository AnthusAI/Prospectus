import type { ProductRegistration } from "./auth";
import {
  CLIENT_ID_PATTERN,
  COGNITO_ISSUER_PATTERN,
  PRODUCT_NAME_PATTERN,
  REVIEW_IDENTIFIER_PATTERN,
  hasOnlyKeys,
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

const isRoleArn = (value: unknown) => typeof value === "string" && rolePattern.test(value);
const isReviewIdentifier = (value: unknown) =>
  typeof value === "string" && REVIEW_IDENTIFIER_PATTERN.test(value);
const isClientId = (value: unknown) => typeof value === "string" && CLIENT_ID_PATTERN.test(value);

const registrationRules: ValidationRule<RegistrationUnderValidation>[] = [
  rule(({ item }) => !!item, "A product registration must be an object."),
  rule(
    ({ item }) => hasOnlyKeys(item, registrationFields),
    "A product registration has a field that is not allowed.",
  ),
  rule(
    ({ item }) => PRODUCT_NAME_PATTERN.test(item.product),
    "A product name must be lowercase letters, digits and hyphens, starting with a letter.",
  ),
  rule(({ item }) => typeof item.roleArn === "string", "A product runtime role ARN must be a string."),
  rule(({ item }) => rolePattern.test(item.roleArn), "A product runtime role must be an IAM role ARN."),
  rule(
    ({ item }) => COGNITO_ISSUER_PATTERN.test(item.issuer),
    "A product issuer must be a regional Cognito user pool URL.",
  ),
  rule(({ item }) => Array.isArray(item.clientIds), "Product client IDs must be an array."),
  rule(({ item }) => item.clientIds.length > 0, "A product needs at least one client ID."),
  rule(
    ({ item }) => item.clientIds.every(isClientId),
    "Product client IDs must be lowercase alphanumeric identifiers.",
  ),
  rule(({ item }) => Array.isArray(item.capabilities), "Product capabilities must be an array."),
  rule(({ item }) => item.capabilities.length > 0, "A product needs at least one capability."),
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
    (policy) => policy.policy === "google-only-unlinked-v1",
    "A Google federation policy must be google-only-unlinked-v1.",
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
export function registrations(value: unknown): ValidatedRegistrations {
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
  return registrationsSnapshot as unknown as ValidatedRegistrations;
}
