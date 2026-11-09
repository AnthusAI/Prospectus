import { test } from "node:test";
import assert from "node:assert/strict";
import { App, Stack, Tags } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import { applyCostTags, assertCostTags, checkCostTags, costTags, parseCostKey } from "../src/cdk";

// features/cost-tagging.feature
const ACCOUNT = "00000000-0000-4000-8000-000000000001";

function stack() {
  const scope = new Stack(new App(), "Site");
  new dynamodb.Table(scope, "Table", { partitionKey: { name: "id", type: dynamodb.AttributeType.STRING } });
  new s3.Bucket(scope, "Bucket");
  new lambda.Function(scope, "Function", {
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => {}"),
  });
  return scope;
}
const tagsOf = (resource: any) =>
  Object.fromEntries((resource.Properties.Tags ?? []).map((tag: any) => [tag.Key, tag.Value]));

test("the helper tags every costed resource in a per-customer stack", () => {
  const scope = stack();
  Tags.of(scope).add("anthus:project", "Papyrus");
  applyCostTags(scope, { account: ACCOUNT, app: "papyrus", deployment: "example" });
  const template = Template.fromStack(scope).toJSON();
  assert.deepEqual(checkCostTags(template), []);
  for (const resource of Object.values(template.Resources) as any[])
    if (["AWS::DynamoDB::Table", "AWS::S3::Bucket", "AWS::Lambda::Function"].includes(resource.Type)) {
      const tags = tagsOf(resource);
      assert.equal(tags["anthus:account"], ACCOUNT);
      assert.equal(tags["anthus:app"], "papyrus");
      assert.equal(tags["anthus:deployment"], "example");
      assert.equal(tags["anthus:cost-key"], `${ACCOUNT}/papyrus/example`);
      assert.equal(tags["anthus:project"], "Papyrus", "existing tags stay");
    }
});

test("a shared stack is tagged shared, with an empty deployment in the cost key", () => {
  assert.deepEqual(costTags({ account: "shared", app: "cyclotron" }), {
    "anthus:account": "shared",
    "anthus:app": "cyclotron",
    "anthus:cost-key": "shared/cyclotron/",
  });
});

test("an invalid configuration fails with a message naming the field", () => {
  assert.throws(() => costTags({ account: ACCOUNT, app: "unknown" as any }), /app/);
  assert.throws(() => costTags({ account: "Example Press", app: "papyrus" }), /account/);
  assert.throws(
    () => costTags({ account: "00000000-0000-4000-A000-00000000000A", app: "papyrus" }),
    /account/,
  );
  assert.throws(() => costTags({ account: ACCOUNT, app: "papyrus", deployment: "Bad Site" }), /deployment/);
});

test("the check fails an untagged resource and names it", () => {
  const template = Template.fromStack(stack()).toJSON();
  const violations = checkCostTags(template);
  assert.equal(violations.length, 3);
  assert.ok(violations.every((violation) => violation.missing.includes("anthus:app")));
  assert.throws(() => assertCostTags(template), /Resources missing Anthus cost tags/);
  assert.deepEqual(checkCostTags({ Resources: { Role: { Type: "AWS::IAM::Role", Properties: {} } } }), []);
});

test("cost keys parse back into their parts", () => {
  assert.deepEqual(parseCostKey(`${ACCOUNT}/papyrus/example`), {
    account: ACCOUNT,
    app: "papyrus",
    deployment: "example",
  });
  assert.deepEqual(parseCostKey("shared/cyclotron/"), {
    account: "shared",
    app: "cyclotron",
    deployment: null,
  });
  assert.equal(parseCostKey("not-a-key"), null);
  assert.equal(parseCostKey(`${ACCOUNT}/unknown/`), null);
});
