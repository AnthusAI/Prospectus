import { test } from "node:test";
import assert from "node:assert/strict";
import { registrations } from "../accounts/registration";
import { papyrusSiteRegistrations } from "../accounts/papyrus-sites";
import { operatorGrants, operatorSubjectHash } from "../accounts/operator-policy";
import { matchesStringPattern } from "../accounts/validation-rules";

const registrationPrefix = "Invalid or ambiguous product registration:";
const federationPrefix = "An exact reviewed Google-only federation policy/client is required:";
const delegationPrefix = "An exact reviewed enrollment-to-execution binding is required:";
const siteEntryPrefix = "Exact reviewed Papyrus site registration required:";
const grantPrefix = "Exact reviewed central operator grant required:";

const baseRegistration = () => ({
  product: "cyclotron",
  roleArn: "arn:aws:iam::111111111111:role/SyntheticEnrollment",
  issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Synthetic",
  clientIds: ["syntheticclient"],
  capabilities: ["console:read"],
  enabled: true,
  googleFederation: {
    policy: "google-only-unlinked-v1",
    reviewedPolicyId: "synthetic-review-v1",
    clientId: "syntheticclient",
  },
});

const delegatedRegistration = () => ({
  ...baseRegistration(),
  executionDelegation: {
    roleArn: "arn:aws:iam::111111111111:role/SyntheticExecution",
    enrollmentRoleArn: "arn:aws:iam::111111111111:role/SyntheticEnrollment",
    issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Synthetic",
    clientId: "syntheticclient",
    enrollmentPolicyRevision: "synthetic-review-v1",
    reviewedPolicyId: "synthetic-execution-review-v1",
  },
});

const rejectsRegistration = (value: unknown, message: string) =>
  assert.throws(() => registrations(value), { message });

test("the baseline registrations used for message checks are valid", () => {
  assert.equal(registrations([baseRegistration()]).length, 1);
  assert.equal(registrations([delegatedRegistration()]).length, 1);
});

test("registration lists name which size rule they break", () => {
  rejectsRegistration(null, "Exact product runtime registrations are required.");
  rejectsRegistration([], "At least one product runtime registration is required.");
  rejectsRegistration(
    Array.from({ length: 101 }, () => baseRegistration()),
    "Product runtime registrations exceed the maximum of 100.",
  );
});

test("each registration field failure names the field", () => {
  const cases: Array<[string, (registration: any) => void, string]> = [
    [
      "unknown field",
      (registration) => (registration.email = "x"),
      "A product registration has a field that is not allowed.",
    ],
    [
      "product name",
      (registration) => (registration.product = "Not Valid"),
      "A product name must be lowercase letters, digits and hyphens, starting with a letter.",
    ],
    [
      "role type",
      (registration) => (registration.roleArn = 5),
      "A product runtime role ARN must be a string.",
    ],
    [
      "role shape",
      (registration) => (registration.roleArn = "role"),
      "A product runtime role must be an IAM role ARN.",
    ],
    [
      "issuer",
      (registration) => (registration.issuer = "https://accounts.google.com"),
      "A product issuer must be a regional Cognito user pool URL.",
    ],
    [
      "client list type",
      (registration) => (registration.clientIds = "a"),
      "Product client IDs must be an array.",
    ],
    [
      "client list empty",
      (registration) => (registration.clientIds = []),
      "A product needs at least one client ID.",
    ],
    [
      "client shape",
      (registration) => (registration.clientIds = ["Bad Id"]),
      "Product client IDs must be lowercase alphanumeric identifiers.",
    ],
    [
      "capability list type",
      (registration) => (registration.capabilities = "a"),
      "Product capabilities must be an array.",
    ],
    [
      "capability list empty",
      (registration) => (registration.capabilities = []),
      "A product needs at least one capability.",
    ],
    [
      "capability unknown",
      (registration) => (registration.capabilities = ["root"]),
      "Product capabilities must be known operations.",
    ],
    [
      "enabled type",
      (registration) => (registration.enabled = "yes"),
      "A product enabled flag must be a boolean.",
    ],
  ];
  for (const [, change, message] of cases) {
    const registration = baseRegistration();
    change(registration);
    rejectsRegistration([registration], `${registrationPrefix} ${message}`);
  }
});

test("duplicate products, directory flags and runtime roles name the conflict", () => {
  rejectsRegistration(
    [baseRegistration(), baseRegistration()],
    `${registrationPrefix} Each product may be registered only once.`,
  );
  rejectsRegistration(
    [{ ...baseRegistration(), accountDirectory: false }],
    "Directory registration must be explicitly true or absent.",
  );
  rejectsRegistration(
    [baseRegistration(), { ...baseRegistration(), product: "papyrus" }],
    "Runtime principals must be unique and cannot delegate transitively.",
  );
});

test("federation policy failures name the broken policy rule", () => {
  const cases: Array<[(registration: any) => void, string]> = [
    [
      (registration) => (registration.googleFederation = null),
      "A Google federation policy must be an object.",
    ],
    [
      (registration) => (registration.googleFederation.extra = true),
      "A Google federation policy has a field that is not allowed.",
    ],
    [
      (registration) => (registration.googleFederation.policy = "other"),
      "A Google federation policy must be google-only-unlinked-v1.",
    ],
    [
      (registration) => (registration.googleFederation.reviewedPolicyId = ""),
      "A Google federation policy needs a reviewed policy identifier.",
    ],
    [
      (registration) => (registration.googleFederation.clientId = "outside"),
      "its client must be one of the product's client IDs.",
    ],
  ];
  for (const [change, message] of cases) {
    const registration = baseRegistration();
    change(registration);
    rejectsRegistration([registration], `${federationPrefix} ${message}`);
  }
});

test("execution delegation failures name the broken binding rule", () => {
  const cases: Array<[(registration: any) => void, string]> = [
    [
      (registration) => (registration.executionDelegation = null),
      "An execution delegation must be an object.",
    ],
    [
      (registration) => (registration.executionDelegation.extra = true),
      "An execution delegation has a field that is not allowed.",
    ],
    [
      (registration) => delete registration.googleFederation,
      "An execution delegation requires a reviewed Google federation policy.",
    ],
    [
      (registration) => (registration.accountDirectory = true),
      "A directory principal cannot hold an execution delegation.",
    ],
    [
      (registration) => (registration.executionDelegation.roleArn = "role"),
      "An execution role must be an IAM role ARN.",
    ],
    [
      (registration) =>
        (registration.executionDelegation.enrollmentRoleArn = "arn:aws:iam::111111111111:role/Other"),
      "An execution delegation must name the product's enrollment role.",
    ],
    [
      (registration) =>
        (registration.executionDelegation.issuer =
          "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Other"),
      "An execution delegation must use the product's issuer.",
    ],
    [
      (registration) => (registration.executionDelegation.clientId = "other"),
      "An execution delegation must use the federation client.",
    ],
    [
      (registration) => (registration.executionDelegation.enrollmentPolicyRevision = "other"),
      "An execution delegation must cite the reviewed federation policy.",
    ],
    [
      (registration) => (registration.executionDelegation.reviewedPolicyId = ""),
      "An execution delegation needs a reviewed policy identifier.",
    ],
  ];
  for (const [change, message] of cases) {
    const registration: any = delegatedRegistration();
    change(registration);
    rejectsRegistration([registration], `${delegationPrefix} ${message}`);
  }
});

const siteEntry = () => ({
  product: "papyrus-synthetic",
  roleArn: "arn:aws:iam::111111111111:role/SyntheticSite",
  issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_SyntheticSite",
  clientId: "syntheticsite",
  federationReviewId: "synthetic-federation-review",
  siteReviewId: "synthetic-site-review",
});

const rejectsSite = (value: unknown, message: string) =>
  assert.throws(() => papyrusSiteRegistrations(value), { message });

test("Papyrus site failures name the broken site rule", () => {
  rejectsSite(null, "Reviewed Papyrus site registrations are required.");
  rejectsSite(
    Array.from({ length: 41 }, () => siteEntry()),
    "Reviewed Papyrus site registrations exceed the maximum of 40.",
  );
  const cases: Array<[(entry: any) => void, string]> = [
    [(entry) => (entry.email = "x"), "A Papyrus site entry must have exactly the reviewed fields."],
    [(entry) => (entry.product = 5), "A Papyrus site product must be a string."],
    [
      (entry) => (entry.product = "cyclotron"),
      "A Papyrus site product must be named papyrus-<site> in lowercase letters, digits and hyphens.",
    ],
    [(entry) => (entry.roleArn = 5), "A Papyrus site runtime role ARN must be a string."],
    [(entry) => (entry.roleArn = "role"), "A Papyrus site runtime role must be an IAM role ARN."],
    [(entry) => (entry.issuer = 5), "A Papyrus site issuer must be a string."],
    [
      (entry) => (entry.issuer = "https://accounts.google.com"),
      "A Papyrus site issuer must be a regional Cognito user pool URL.",
    ],
    [(entry) => (entry.clientId = 5), "A Papyrus site client ID must be a string."],
    [
      (entry) => (entry.clientId = "Bad Id"),
      "A Papyrus site client ID must be a lowercase alphanumeric identifier.",
    ],
    [(entry) => (entry.federationReviewId = 5), "A Papyrus site federation review ID must be a string."],
    [
      (entry) => (entry.federationReviewId = ""),
      "A Papyrus site federation review ID must be a reviewed identifier.",
    ],
    [(entry) => (entry.siteReviewId = 5), "A Papyrus site review ID must be a string."],
    [(entry) => (entry.siteReviewId = ""), "A Papyrus site review ID must be a reviewed identifier."],
  ];
  for (const [change, message] of cases) {
    const entry = siteEntry();
    change(entry);
    rejectsSite([entry], `${siteEntryPrefix} ${message}`);
  }
});

test("Papyrus sites must not share a product or a runtime role", () => {
  rejectsSite([siteEntry(), siteEntry()], "Each Papyrus site needs its own product name.");
  rejectsSite(
    [siteEntry(), { ...siteEntry(), product: "papyrus-other" }],
    "Each Papyrus site needs its own runtime role.",
  );
});

const grant = () => ({
  product: "prospectus-directory",
  issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_SyntheticCentral",
  subjectHash: operatorSubjectHash("synthetic-operator"),
  permission: "accounts:admin:read",
  reviewedGrantId: "synthetic-grant-review",
});

const rejectsGrants = (value: unknown, message: string) =>
  assert.throws(() => operatorGrants(value), { message });

test("operator grant failures name the broken grant rule", () => {
  rejectsGrants(null, "Central operator policy must be an array of grants.");
  rejectsGrants(
    Array.from({ length: 21 }, () => grant()),
    "Central operator policy exceeds the maximum of 20 grants.",
  );
  const cases: Array<[(entry: any) => void, string]> = [
    [(entry) => (entry.email = "x"), "A central operator grant must have exactly the reviewed fields."],
    [
      (entry) => (entry.product = "Not Valid"),
      "A central operator grant product must be lowercase letters, digits and hyphens, starting with a letter.",
    ],
    [
      (entry) => (entry.issuer = "https://accounts.google.com"),
      "A central operator grant issuer must be a regional Cognito user pool URL.",
    ],
    [(entry) => (entry.subjectHash = 5), "A central operator grant subject hash must be a string."],
    [
      (entry) => (entry.subjectHash = "abc"),
      "A central operator grant subject hash must be a SHA-256 hex digest.",
    ],
    [
      (entry) => (entry.permission = "accounts:admin:write"),
      "A central operator grant permission must be a known operator permission.",
    ],
    [(entry) => (entry.reviewedGrantId = 5), "A central operator grant review ID must be a string."],
    [
      (entry) => (entry.reviewedGrantId = ""),
      "A central operator grant review ID must be a reviewed identifier.",
    ],
  ];
  for (const [change, message] of cases) {
    const entry = grant();
    change(entry);
    rejectsGrants([entry], `${grantPrefix} ${message}`);
  }
});

test("duplicate operator grants are named as duplicates", () => {
  rejectsGrants([grant(), grant()], "Duplicate central operator grant.");
});

const nonStringValues: Array<[string, unknown]> = [
  ["undefined", undefined],
  ["null", null],
  ["a number", 5],
  ["an array holding a valid name", ["cyclotron"]],
];

const nonStringIssuers = (validIssuer: string): Array<[string, unknown]> => [
  ...nonStringValues,
  ["an array holding a valid issuer", [validIssuer]],
];

test("a product registration needs a string product, whatever it coerces to", () => {
  for (const [, product] of nonStringValues) {
    rejectsRegistration(
      [{ ...baseRegistration(), product }],
      `${registrationPrefix} A product name must be a string.`,
    );
  }
  const withoutProduct: any = baseRegistration();
  delete withoutProduct.product;
  rejectsRegistration([withoutProduct], `${registrationPrefix} A product name must be a string.`);
});

test("a product registration needs a string issuer, whatever it coerces to", () => {
  for (const [, issuer] of nonStringIssuers(baseRegistration().issuer)) {
    rejectsRegistration(
      [{ ...baseRegistration(), issuer }],
      `${registrationPrefix} A product issuer must be a string.`,
    );
  }
});

test("a product literally named undefined is a valid name but a missing product is not", () => {
  assert.equal(registrations([{ ...baseRegistration(), product: "undefined" }]).length, 1);
});

test("an operator grant needs a string product and issuer, whatever they coerce to", () => {
  for (const [, product] of nonStringValues) {
    rejectsGrants(
      [{ ...grant(), product }],
      `${grantPrefix} A central operator grant product must be a string.`,
    );
  }
  for (const [, issuer] of nonStringIssuers(grant().issuer)) {
    rejectsGrants(
      [{ ...grant(), issuer }],
      `${grantPrefix} A central operator grant issuer must be a string.`,
    );
  }
  const withoutProduct: any = grant();
  delete withoutProduct.product;
  rejectsGrants(
    [withoutProduct],
    `${grantPrefix} A central operator grant must have exactly the reviewed fields.`,
  );
});

test("a Papyrus site needs a string product, whatever it coerces to", () => {
  for (const [, product] of nonStringValues) {
    rejectsSite([{ ...siteEntry(), product }], `${siteEntryPrefix} A Papyrus site product must be a string.`);
  }
});

test("a shared string-pattern guard refuses every value that only coerces to a match", () => {
  const pattern = /^[a-z]+$/;
  assert.equal(matchesStringPattern("abc", pattern), true);
  for (const value of [["abc"], 5, null, undefined, { toString: () => "abc" }]) {
    assert.equal(matchesStringPattern(value, pattern), false);
  }
});

test("operator grant and Papyrus site identifiers refuse array-wrapped valid values", () => {
  for (const field of ["subjectHash", "reviewedGrantId"] as const) {
    const wrapped: any = grant();
    wrapped[field] = [wrapped[field]];
    assert.throws(() => operatorGrants([wrapped]), /must be a string\.$/);
  }
  for (const field of [
    "product",
    "roleArn",
    "issuer",
    "clientId",
    "federationReviewId",
    "siteReviewId",
  ] as const) {
    const wrapped: any = siteEntry();
    wrapped[field] = [wrapped[field]];
    assert.throws(() => papyrusSiteRegistrations([wrapped]), /must be a string\.$/);
  }
});
