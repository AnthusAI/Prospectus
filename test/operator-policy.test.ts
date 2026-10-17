import { test } from "node:test";
import assert from "node:assert/strict";
import { operatorSubjectHash, operatorGrants, canReadOperatorDirectory } from "../accounts/operator-policy";
import type { Context } from "../accounts/model";
import deployedGrants from "../accounts/operator-grants.json";
const context: Context = {
  product: "prospectus-directory",
  principal: "arn:aws:iam::111111111111:role/Synthetic",
  human: {
    issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Synthetic",
    subject: "synthetic-operator",
  },
  capabilities: ["console:read", "members:read"],
};
const grant = {
  product: context.product,
  issuer: context.human.issuer,
  subjectHash: operatorSubjectHash(context.human.subject),
  permission: "accounts:admin:read",
  reviewedGrantId: "synthetic-approval-v1",
};
test("operator permission requires an exact deployment-owned human grant and the approved production grant is read-only", () => {
  assert.equal(deployedGrants.length, 1);
  assert.equal(deployedGrants[0].permission, "accounts:admin:read");
  assert.equal(
    deployedGrants[0].subjectHash,
    "3354c9f139ef4d2e872245b1af080140816a95954c4e54aa596f2106c86cf95c",
  );
  operatorGrants(deployedGrants);
  assert.equal(canReadOperatorDirectory(context, operatorGrants([])), false);
  const policy = operatorGrants([grant]);
  assert.equal(canReadOperatorDirectory(context, policy), true);
  for (const changed of [
    { ...context, product: "other" },
    { ...context, human: { ...context.human, issuer: context.human.issuer + "other" } },
    { ...context, human: { ...context.human, subject: "other" } },
  ])
    assert.equal(canReadOperatorDirectory(changed, policy), false);
  grant.subjectHash = "a".repeat(64);
  assert.equal(canReadOperatorDirectory(context, policy), true);
});
test("malformed or ambiguous operator grants fail closed", () => {
  for (const value of [
    null,
    {},
    [{}],
    [{ ...grant, reviewedGrantId: "" }],
    [{ ...grant, permission: "accounts:admin:write" }],
    [{ ...grant, email: "operator@example.invalid" }],
    [grant, grant],
  ])
    assert.throws(() => operatorGrants(value));
});
