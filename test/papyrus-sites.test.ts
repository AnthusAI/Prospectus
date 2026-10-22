import { test } from "node:test";
import assert from "node:assert/strict";
import {
  papyrusSiteRegistrations,
  papyrusSiteRoutes,
  type PapyrusSiteEntry,
} from "../accounts/papyrus-sites";
import { editorSiteRegistrations } from "../accounts/papyrus-sites";
import { registrations } from "../accounts/registration";
import reviewedPapyrusSites from "../accounts/papyrus-sites.json";

const syntheticSite = (index: number): PapyrusSiteEntry => ({
  product: `papyrus-synthetic-${index}`,
  roleArn: `arn:aws:iam::111111111111:role/SyntheticPapyrusSite${index}`,
  issuer: `https://cognito-idp.us-east-1.amazonaws.com/us-east-1_SyntheticSite${index}`,
  clientId: `syntheticclient${index}`,
  federationReviewId: `synthetic-google-only-${index}`,
  siteReviewId: `synthetic-site-review-${index}`,
});

test("a reviewed Papyrus site becomes a directory-capable product registration without account creation or membership writes", () => {
  const [registration] = papyrusSiteRegistrations([syntheticSite(1)]);
  assert.deepEqual(registration, {
    product: "papyrus-synthetic-1",
    roleArn: "arn:aws:iam::111111111111:role/SyntheticPapyrusSite1",
    issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_SyntheticSite1",
    clientIds: ["syntheticclient1"],
    capabilities: ["console:read", "console:write", "members:read"],
    enabled: true,
    accountDirectory: true,
    googleFederation: {
      policy: "google-only-unlinked-v1",
      reviewedPolicyId: "synthetic-google-only-1",
      clientId: "syntheticclient1",
    },
  });
  assert.ok(!registration.capabilities.includes("members:write"));
  assert.ok(papyrusSiteRoutes.includes("GET/v1/account-directory"));
  assert.ok(papyrusSiteRoutes.includes("POST/v1/accounts/*/authorize"));
  assert.ok(!papyrusSiteRoutes.includes("POST/v1/accounts"));
  assert.ok(!papyrusSiteRoutes.some((route) => route.includes("memberships")));
});

test("the checked-in Papyrus site registry is valid reviewed configuration", () => {
  assert.ok(Array.isArray(papyrusSiteRegistrations(reviewedPapyrusSites)));
});

test("unreviewed, ambiguous or non-Papyrus site entries are refused", () => {
  const site = syntheticSite(1);
  for (const value of [
    null,
    {},
    [{}],
    [{ ...site, product: "cyclotron" }],
    [{ ...site, product: "papyrus-" }],
    [{ ...site, siteReviewId: "" }],
    [{ ...site, federationReviewId: undefined }],
    [{ ...site, email: "editor@example.invalid" }],
    [{ ...site, issuer: "https://accounts.google.com" }],
    [site, site],
    [site, { ...syntheticSite(2), roleArn: site.roleArn }],
  ])
    assert.throws(() => papyrusSiteRegistrations(value));
});

test("more than twenty sites register exactly alongside the existing products", () => {
  const sites = papyrusSiteRegistrations(Array.from({ length: 40 }, (_, index) => syntheticSite(index)));
  const directory = {
    product: "prospectus-directory",
    roleArn: "arn:aws:iam::111111111111:role/SyntheticDirectory",
    issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_SyntheticCentral",
    clientIds: ["syntheticcentral"],
    capabilities: ["console:read", "members:read"],
    enabled: true,
    accountDirectory: true,
  };
  assert.equal(registrations([directory, ...sites]).length, 41);
  assert.throws(() => registrations([directory, { ...sites[0], roleArn: directory.roleArn }]));
});

test("a public-reader site gets sign-in and a profile only: no capabilities and no account directory", () => {
  const [registration] = papyrusSiteRegistrations([{ ...syntheticSite(1), audience: "public-reader" }]);
  assert.deepEqual(registration.capabilities, []);
  assert.equal(registration.accountDirectory, undefined);
  assert.equal(registration.googleFederation?.policy, "google-only-unlinked-v1");
  assert.equal(registrations([registration]).length, 1);
});

test("public readers register beside editor sites but the lab verifier never trusts them", () => {
  const sites = papyrusSiteRegistrations([
    syntheticSite(1),
    { ...syntheticSite(2), audience: "public-reader" },
  ]);
  assert.equal(registrations(sites).length, 2);
  assert.deepEqual(
    editorSiteRegistrations(sites).map((site) => site.product),
    ["papyrus-synthetic-1"],
  );
});

test("only the public-reader audience is accepted, and empty capabilities need the reader shape", () => {
  for (const audience of ["editor", "", null, "public-reader "])
    assert.throws(() => papyrusSiteRegistrations([{ ...syntheticSite(1), audience } as never]));
  const [reader] = papyrusSiteRegistrations([{ ...syntheticSite(1), audience: "public-reader" }]);
  assert.throws(() => registrations([{ ...reader, accountDirectory: true }]));
  assert.throws(() => registrations([{ ...reader, googleFederation: undefined }]));
});

test("only a Papyrus public-reader may hold no capabilities, and each refusal names its rule", () => {
  const [reader] = papyrusSiteRegistrations([{ ...syntheticSite(1), audience: "public-reader" }]);
  assert.equal(reader.audience, "public-reader");
  const delegation = {
    roleArn: "arn:aws:iam::111111111111:role/SyntheticExecution",
    enrollmentRoleArn: reader.roleArn,
    issuer: reader.issuer,
    clientId: reader.clientIds[0],
    enrollmentPolicyRevision: reader.googleFederation!.reviewedPolicyId,
    reviewedPolicyId: "synthetic-delegation-review",
  };
  assert.throws(
    () => registrations([{ ...reader, executionDelegation: delegation }]),
    /A public-reader product cannot hold an execution delegation/,
  );
  // Falsy values are not "absent": the check is an explicit undefined test.
  assert.throws(
    () => registrations([{ ...reader, executionDelegation: null as never }]),
    /cannot hold an execution delegation/,
  );
  for (const accountDirectory of [true, false, "yes"])
    assert.throws(
      () => registrations([{ ...reader, accountDirectory: accountDirectory as never }]),
      /A public-reader product cannot hold an account directory/,
    );
  // A non-Papyrus product with no capabilities is refused, as is one with no reader audience.
  for (const product of ["other-reader", "cyclotron"])
    assert.throws(() => registrations([{ ...reader, product }]), /A product needs at least one capability/);
  const { audience: _omitted, ...unmarked } = reader;
  assert.throws(() => registrations([unmarked]), /A product needs at least one capability/);
  assert.throws(
    () => registrations([{ ...reader, audience: "editor" as never }]),
    /A product needs at least one capability/,
  );
  assert.throws(
    () => registrations([{ ...reader, capabilities: ["console:read"] }]),
    /A public-reader product holds no capabilities/,
  );
  // Outside readers, a non-boolean directory flag keeps its own specific message.
  const [editor] = papyrusSiteRegistrations([syntheticSite(2)]);
  assert.throws(
    () => registrations([{ ...editor, accountDirectory: "yes" as never }]),
    /Directory registration must be explicitly true or absent/,
  );
  assert.equal(registrations([reader, editor]).length, 2);
});
