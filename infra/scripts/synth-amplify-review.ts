import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { App, CfnParameter, DefaultStackSynthesizer } from "../../amplify/node_modules/aws-cdk-lib";
import { Code } from "../../amplify/node_modules/aws-cdk-lib/aws-lambda";
import { createProspectusBackend } from "../../amplify/create-backend";
import { AMPLIFY_APP_ID, DEPLOYMENT_BRANCH, TARGET_ACCOUNT, TARGET_REGION } from "../lib/scope";

// Offline review of the same Gen2 factory used by pipeline-deploy. Code remains
// a CloudFormation parameter: this does not upload an artifact or call AWS.
process.env.CDK_DEFAULT_ACCOUNT = TARGET_ACCOUNT;
process.env.CDK_DEFAULT_REGION = TARGET_REGION;
process.env.CDK_OUTDIR = resolve(process.env.PROSPECTUS_REVIEW_OUTDIR ?? ".artifacts/amplify-review");
const context = {
  "amplify-backend-namespace": AMPLIFY_APP_ID,
  "amplify-backend-name": DEPLOYMENT_BRANCH,
  "amplify-backend-type": "branch",
};
process.env.CDK_CONTEXT_JSON = JSON.stringify(context);
const backend = createProspectusBackend(stack => Code.fromCfnParameters({
  bucketNameParam: new CfnParameter(stack, "ReviewedArtifactBucket", { type: "String" }),
  objectKeyParam: new CfnParameter(stack, "ReviewedArtifactKey", { type: "String" }),
}));
assert.deepEqual(JSON.parse(process.env.CDK_CONTEXT_JSON), context, "backend must not rewrite CDK bootstrap context");
assert.ok(backend.stack.synthesizer instanceof DefaultStackSynthesizer);
assert.equal(backend.stack.synthesizer.bootstrapQualifier, DefaultStackSynthesizer.DEFAULT_QUALIFIER);
const app = App.of(backend.stack);
assert.ok(app);
const assembly = app.synth();
assert.equal(assembly.stacks.length, 1, "Gen2 must not add a separate deployment/bootstrap stack");
const root = assembly.getStackArtifact(backend.stack.artifactId);
const role = (name: string) => `arn:\${AWS::Partition}:iam::\${AWS::AccountId}:role/cdk-hnb659fds-${name}-role-\${AWS::AccountId}-\${AWS::Region}`;
const bootstrapParameter = "/cdk-bootstrap/hnb659fds/version";
assert.equal(root.assumeRoleArn, role("deploy"));
assert.equal(root.cloudFormationExecutionRoleArn, role("cfn-exec"));
assert.equal(root.bootstrapStackVersionSsmParameter, bootstrapParameter);
assert.equal(root.lookupRole?.arn, role("lookup"));
assert.equal(root.lookupRole?.bootstrapStackVersionSsmParameter, bootstrapParameter);

const artifacts = Object.values(assembly.manifest.artifacts ?? {});
const manifests = artifacts.filter(artifact => artifact.type === "cdk:asset-manifest");
assert.ok(manifests.length > 0, "Gen2 must synthesize its real branch/helper assets");
for (const artifact of manifests) {
  const properties = artifact.properties as { file: string; bootstrapStackVersionSsmParameter: string };
  assert.equal(properties.bootstrapStackVersionSsmParameter, bootstrapParameter);
  const assets = JSON.parse(readFileSync(resolve(assembly.directory, properties.file), "utf8")) as {
    files: Record<string, { destinations: Record<string, { bucketName: string; assumeRoleArn: string }> }>;
  };
  for (const file of Object.values(assets.files)) {
    for (const destination of Object.values(file.destinations)) {
      assert.equal(destination.bucketName, "cdk-hnb659fds-assets-${AWS::AccountId}-${AWS::Region}");
      assert.equal(destination.assumeRoleArn, role("file-publishing"));
    }
  }
}

type Resource = { Type: string; Properties?: Record<string, any> };
const resources: Resource[] = readdirSync(assembly.directory)
  .filter(name => name.endsWith(".template.json"))
  .flatMap(name => Object.values(JSON.parse(readFileSync(resolve(assembly.directory, name), "utf8")).Resources ?? {}) as Resource[]);
const roles = resources.filter(resource => resource.Type === "AWS::IAM::Role");
assert.deepEqual(roles.map(resource => resource.Properties?.RoleName).sort(), [
  "prospectus-runtime",
  `prospectus-${AMPLIFY_APP_ID}-${DEPLOYMENT_BRANCH}-linker`,
  `prospectus-${AMPLIFY_APP_ID}-${DEPLOYMENT_BRANCH}-provider`,
].sort(), "Gen2 should create application roles only, not a service role or account bootstrap");
assert.ok(!resources.some(resource => resource.Type === "AWS::SSM::Parameter" && resource.Properties?.Name?.startsWith("/cdk-bootstrap/")));
const branchUpdates = resources.filter(resource => resource.Type === "AWS::IAM::Policy")
  .flatMap(resource => resource.Properties?.PolicyDocument?.Statement ?? [])
  .filter(statement => [statement.Action].flat().includes("amplify:UpdateBranch"));
assert.equal(branchUpdates.length, 1);
assert.equal(branchUpdates[0].Resource, `arn:aws:amplify:${TARGET_REGION}:${TARGET_ACCOUNT}:apps/${AMPLIFY_APP_ID}/branches/${DEPLOYMENT_BRANCH}`);
assert.ok(!JSON.stringify(assembly.manifest).includes("prspctus"));
assert.ok(!JSON.stringify(resources).includes("prspctus"));
console.log(`Verified Gen2 root ${backend.stack.stackName}; standard hnb659fds bootstrap references and scoped application roles.`);
