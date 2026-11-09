import { test } from "node:test";
import assert from "node:assert/strict";
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { CostManagement } from "../lib/cost-management";

// features/cost-daily-import.feature: the management account side. Synthetic account numbers only.
const synth = (activateTags?: boolean) => {
  const stack = new Stack(new App(), "CostManagement", {
    env: { account: "111122223333", region: "us-east-1" },
  });
  new CostManagement(stack, "Cost", { prospectusAccount: "123456789012", activateTags });
  return Template.fromStack(stack);
};

test("the management account holds one read-only role that only the Prospectus central runtime may assume", () => {
  const template = synth();
  template.resourceCountIs("AWS::IAM::Role", 1);
  const [role] = Object.values(template.findResources("AWS::IAM::Role")) as any[];
  assert.equal(role.Properties.RoleName, "prospectus-cost-import");
  const principal = JSON.stringify(role.Properties.AssumeRolePolicyDocument.Statement[0].Principal);
  assert.match(principal, /123456789012:role\/prospectus-central-accounts-runtime/);
  assert.deepEqual(
    role.Properties.Policies[0].PolicyDocument.Statement.map((statement: any) => statement.Action),
    ["ce:GetCostAndUsage"],
  );
  template.resourceCountIs("Custom::AWS", 0);
});

test("tag activation is code, switched on once the tags exist on billed usage", () => {
  const template = synth(true);
  const [resource] = Object.values(template.findResources("Custom::AWS")) as any[];
  const create = JSON.stringify(resource.Properties.Create);
  for (const key of ["anthus:account", "anthus:app", "anthus:deployment", "anthus:cost-key"])
    assert.ok(create.includes(key), key);
  assert.ok(create.includes("UpdateCostAllocationTagsStatus"));
  assert.throws(
    () => new CostManagement(new Stack(new App(), "X"), "Y", { prospectusAccount: "1" }),
    /12 digits/,
  );
});
