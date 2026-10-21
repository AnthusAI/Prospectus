import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  labVerifier,
  labVerifierCapabilities,
  labVerifierRoutes,
  reviewedLabVerifierEntry,
} from "../accounts/lab-verifier";
import { papyrusSiteRegistrations } from "../accounts/papyrus-sites";
import { registrations } from "../accounts/registration";
import reviewedPapyrusSites from "../accounts/papyrus-sites.json";
import reviewedLabVerifier from "../accounts/lab-verifier.json";

const cyclotronBff = "arn:aws:iam::682849160744:role/cyclotron-console-bff-runtime";
const cyclotronWorker = "arn:aws:iam::682849160744:role/cyclotron-console-worker-runtime";

test("the verifier has the same two routes as the execution authority and never member management", () => {
  assert.deepEqual([...labVerifierRoutes], ["GET/v1/identities/me", "POST/v1/accounts/*/authorize"]);
  assert.deepEqual([...labVerifierCapabilities], ["console:read", "console:write"]);
});

test("the committed lab verifier file is exact reviewed configuration and is valid when activated", () => {
  const sites = papyrusSiteRegistrations(reviewedPapyrusSites);
  const entry = reviewedLabVerifierEntry({ ...reviewedLabVerifier, enabled: true });
  assert.deepEqual(entry, {
    roleArn: "arn:aws:iam::682849160744:role/cyclotron-lab-verifier",
    reviewId: reviewedLabVerifier.reviewId,
  });
  const verifier = labVerifier(entry, sites);
  assert.equal(verifier.entitlementProduct, "cyclotron");
  assert.deepEqual(
    verifier.sites.map((site) => site.product),
    sites.map((site) => site.product),
  );
  // It must coexist with the deployed cyclotron registrations without a role-name collision.
  const issuer = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_SyntheticConsole";
  const federation = {
    policy: "google-only-unlinked-v1" as const,
    reviewedPolicyId: "x",
    clientId: "consoleclient",
  };
  const cyclotron = {
    product: "cyclotron",
    roleArn: cyclotronBff,
    issuer,
    clientIds: ["consoleclient"],
    capabilities: ["console:read" as const, "console:write" as const],
    enabled: true,
    googleFederation: federation,
    executionDelegation: {
      roleArn: cyclotronWorker,
      enrollmentRoleArn: cyclotronBff,
      issuer,
      clientId: "consoleclient",
      enrollmentPolicyRevision: "x",
      reviewedPolicyId: "y",
    },
  };
  assert.doesNotThrow(() => registrations([cyclotron, ...sites], { labVerifier: verifier }));
  for (const roleArn of [cyclotronBff, cyclotronWorker])
    assert.throws(() => registrations([cyclotron, ...sites], { labVerifier: { ...verifier, roleArn } }));
});

test("the checked-in lab verifier is committed disabled until a reviewed change enables it", () => {
  assert.equal(reviewedLabVerifier.enabled, false);
  assert.equal(reviewedLabVerifierEntry(reviewedLabVerifier), undefined);
  const text = readFileSync(new URL("../accounts/lab-verifier.json", import.meta.url), "utf8");
  assert.ok(!/arn:aws:iam::\d{12}:user/.test(text));
});

test("unreviewed or ambiguous verifier files are refused", () => {
  for (const value of [
    null,
    {},
    { enabled: "yes", roleArn: reviewedLabVerifier.roleArn, reviewId: "x" },
    { enabled: true, roleArn: "arn:aws:iam::682849160744:user/x", reviewId: "x" },
    { enabled: true, roleArn: reviewedLabVerifier.roleArn, reviewId: "" },
    { enabled: true, roleArn: reviewedLabVerifier.roleArn, reviewId: "x", extra: 1 },
    { enabled: true, roleArn: reviewedLabVerifier.roleArn },
  ])
    assert.throws(() => reviewedLabVerifierEntry(value));
});
