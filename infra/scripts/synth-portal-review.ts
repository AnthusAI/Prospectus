/** Offline actual Gen2 factory review with Anthus One hosting enabled. The assets are a fixture. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { App, CfnParameter } from "../../amplify/node_modules/aws-cdk-lib";
import { Code } from "../../amplify/node_modules/aws-cdk-lib/aws-lambda";
import { createProspectusBackend } from "../../amplify/create-backend";
import { AMPLIFY_APP_ID, DEPLOYMENT_BRANCH, TARGET_ACCOUNT, TARGET_REGION } from "../lib/scope";

process.env.CDK_DEFAULT_ACCOUNT = TARGET_ACCOUNT;
process.env.CDK_DEFAULT_REGION = TARGET_REGION;
process.env.CDK_OUTDIR = resolve(process.env.PROSPECTUS_REVIEW_OUTDIR ?? ".artifacts/portal-review");
process.env.CDK_CONTEXT_JSON = JSON.stringify({
  "amplify-backend-namespace": AMPLIFY_APP_ID,
  "amplify-backend-name": DEPLOYMENT_BRANCH,
  "amplify-backend-type": "branch",
});
const assetDirectory = mkdtempSync(join(tmpdir(), "portal-review-"));
mkdirSync(join(assetDirectory, "assets"));
writeFileSync(join(assetDirectory, "index.html"), "<!doctype html><div id=root></div>\n");
writeFileSync(join(assetDirectory, "assets", "portal-review.js"), "export {};\n");
const backend = createProspectusBackend(
  (stack) =>
    Code.fromCfnParameters({
      bucketNameParam: new CfnParameter(stack, "ReviewedCrmArtifactBucket", { type: "String" }),
      objectKeyParam: new CfnParameter(stack, "ReviewedCrmArtifactKey", { type: "String" }),
    }),
  undefined,
  undefined,
  "synthetic-only",
  [],
  { assetDirectory },
);
const assembly = App.of(backend.stack)!.synth();
assert.equal(assembly.stacks.length, 1, "Portal hosting must live in the one Gen2 stack");
type Resource = { Type: string; Properties?: Record<string, any> };
const resources = readdirSync(assembly.directory)
  .filter((name) => name.endsWith(".template.json"))
  .flatMap(
    (name) =>
      Object.values(
        JSON.parse(readFileSync(resolve(assembly.directory, name), "utf8")).Resources ?? {},
      ) as Resource[],
  );
const count = (type: string) => resources.filter((resource) => resource.Type === type).length;
assert.deepEqual(
  resources
    .filter((resource) => resource.Type === "AWS::IAM::Role")
    .map((resource) => resource.Properties?.RoleName)
    .sort(),
  [
    "anthus-one-portal-publish",
    "prospectus-runtime",
    `prospectus-${AMPLIFY_APP_ID}-${DEPLOYMENT_BRANCH}-linker`,
    `prospectus-${AMPLIFY_APP_ID}-${DEPLOYMENT_BRANCH}-provider`,
  ].sort(),
  "the only new role is the named portal publisher",
);
for (const [type, expected] of [
  ["AWS::CloudFront::Distribution", 1],
  ["AWS::CloudFront::OriginAccessControl", 1],
  ["AWS::CloudFront::ResponseHeadersPolicy", 1],
  ["AWS::CertificateManager::Certificate", 1],
  ["AWS::Route53::RecordSet", 2],
  ["AWS::Route53::HostedZone", 0],
  ["Custom::CDKBucketDeployment", 2],
  ["AWS::S3::Bucket", 2],
] as const)
  assert.equal(count(type), expected, type);
const certificate = resources.find((resource) => resource.Type === "AWS::CertificateManager::Certificate")!;
assert.equal(certificate.Properties?.DomainName, "one.anth.us");
assert.equal(TARGET_REGION, "us-east-1");
const lambdas = resources.filter((resource) => resource.Type === "AWS::Lambda::Function");
console.log(
  `Verified Gen2 stack with Anthus One hosting: ${resources.length} resources, ${lambdas.length} Lambda functions, named publisher role only.`,
);
