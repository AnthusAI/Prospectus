import { test } from "node:test";
import assert from "node:assert/strict";
import { babulusFromEnvironment, babulusRegistration } from "./babulus";

const good = {
  roleArn: "arn:aws:iam::111122223333:role/synthetic-babulus-runtime",
  issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_SyntheticBabulus",
  clientId: "syntheticbabulusclient",
  federationReviewId: "synthetic-babulus-review-v1",
};

test("the reviewed options become a Google-only quota product that cannot create accounts", () => {
  const registration = babulusRegistration(good);
  assert.equal(registration.product, "babulus");
  assert.equal(registration.quota, true);
  assert.deepEqual(registration.clientIds, [good.clientId]);
  assert.equal(registration.googleFederation?.policy, "google-only-unlinked-v1");
  assert.deepEqual(registration.capabilities, ["console:read", "console:write", "members:read"]);
});

test("missing, extra or malformed options are refused", () => {
  assert.throws(() => babulusRegistration({ ...good, extra: "x" }), /exactly the four/);
  assert.throws(() => babulusRegistration({ ...good, roleArn: "not-a-role" }), /IAM role/);
  assert.throws(() => babulusRegistration({ ...good, issuer: "https://accounts.google.com" }), /Cognito/);
  assert.throws(() => babulusRegistration({ ...good, clientId: "Not Valid" }), /client ID/);
  assert.throws(() => babulusRegistration(null), /exactly the four/);
});

test("the environment registers Babulus only when switched on, and then needs every value", () => {
  assert.equal(babulusFromEnvironment({}), undefined);
  assert.equal(babulusFromEnvironment({ PROSPECTUS_BABULUS_ROLE_ARN: good.roleArn }), undefined);
  assert.throws(
    () => babulusFromEnvironment({ PROSPECTUS_BABULUS_ENABLED: "true" }),
    /exactly the four|IAM role/,
  );
  const registration = babulusFromEnvironment({
    PROSPECTUS_BABULUS_ENABLED: "true",
    PROSPECTUS_BABULUS_ROLE_ARN: good.roleArn,
    PROSPECTUS_BABULUS_ISSUER: good.issuer,
    PROSPECTUS_BABULUS_CLIENT_ID: good.clientId,
    PROSPECTUS_BABULUS_FEDERATION_REVIEW_ID: good.federationReviewId,
  });
  assert.equal(registration?.product, "babulus");
});
