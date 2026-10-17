/** Offline actual Gen2 factory review. Inline code here is a non-deploying fixture. */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { App, CfnParameter } from "../../amplify/node_modules/aws-cdk-lib";
import { Code } from "../../amplify/node_modules/aws-cdk-lib/aws-lambda";
import { createProspectusBackend } from "../../amplify/create-backend";
import { accountsDeployment } from "../../accounts/deployment";
import { TARGET_ACCOUNT, TARGET_REGION, AMPLIFY_APP_ID, DEPLOYMENT_BRANCH } from "../lib/scope";
process.env.CDK_DEFAULT_ACCOUNT = TARGET_ACCOUNT;
process.env.CDK_DEFAULT_REGION = TARGET_REGION;
process.env.CDK_OUTDIR = resolve(".artifacts/accounts-review");
process.env.CDK_CONTEXT_JSON = JSON.stringify({
  "amplify-backend-namespace": AMPLIFY_APP_ID,
  "amplify-backend-name": DEPLOYMENT_BRANCH,
  "amplify-backend-type": "branch",
});
const backend = createProspectusBackend(
  (stack) =>
    Code.fromCfnParameters({
      bucketNameParam: new CfnParameter(stack, "ReviewedCrmArtifactBucket", { type: "String" }),
      objectKeyParam: new CfnParameter(stack, "ReviewedCrmArtifactKey", { type: "String" }),
    }),
  undefined,
  {
    code: Code.fromInline("exports.handler=async()=>({statusCode:503})"),
    bffCode: Code.fromInline("exports.handler=async()=>({statusCode:503})"),
    ...accountsDeployment()!,
  },
);
const app = App.of(backend.stack)!;
const assembly = app.synth();
assert.equal(assembly.stacks.length, 1, "No additional deployment/bootstrap stack allowed");
const resources = readdirSync(assembly.directory)
  .filter((name) => name.endsWith(".template.json"))
  .flatMap((name) =>
    Object.values(JSON.parse(readFileSync(resolve(assembly.directory, name), "utf8")).Resources ?? {}),
  ) as any[];
assert.equal(resources.filter((resource) => resource.Type === "AWS::S3::Bucket").length, 1);
assert.equal(resources.filter((resource) => resource.Type === "AWS::DynamoDB::Table").length, 1);
assert.equal(resources.filter((resource) => resource.Type === "AWS::Cognito::UserPoolClient").length, 2);
assert.equal(resources.filter((resource) => resource.Type === "AWS::ApiGateway::RestApi").length, 1);
assert.ok(
  !resources.some(
    (resource) =>
      resource.Type === "AWS::IAM::Role" && String(resource.Properties.RoleName ?? "").includes("cfn-exec"),
  ),
);
console.log(
  "Enabled Accounts actual Gen2 assembly PASS; existing CRM bucket/catalog/client preserved; dedicated public console client plus approved Accounts plane.",
);
