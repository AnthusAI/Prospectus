import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import { App, Stack } from "aws-cdk-lib";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { Code } from "aws-cdk-lib/aws-lambda";
import { Template } from "aws-cdk-lib/assertions";
import { ProspectusBackend } from "../lib/prospectus-backend";
import { SITE_SUBJECT_SECRET_INITIALIZER_SOURCE } from "../lib/site-subject-secret";
import { papyrusSiteRegistrations } from "../../accounts/papyrus-sites";

const nodeRequire = createRequire(import.meta.url);
const PARAMETER = "/prospectus/central-accounts/site-subject/v1";
const PARAMETER_ARN = `arn:aws:ssm:us-east-1:712236451410:parameter${PARAMETER}`;

function template(siteSubjectSecret?: { version: "v1"; parameterName: string }) {
  const stack = new Stack(new App(), "SiteSubjectReview", {
    env: { account: "712236451410", region: "us-east-1" },
  });
  new ProspectusBackend(
    stack,
    "Prospectus",
    Code.fromBucket(Bucket.fromBucketName(stack, "Artifact", "review-only-artifact"), "crm.zip"),
    undefined,
    {
      code: Code.fromInline("accounts artifact placeholder"),
      bffCode: Code.fromInline("BFF artifact placeholder"),
      googlePolicyReviewId: "synthetic-review-v1",
      papyrusSites: papyrusSiteRegistrations([
        {
          audience: "public-reader",
          product: "papyrus-reader",
          roleArn: "arn:aws:iam::712236451410:role/synthetic-reader-runtime",
          issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_SyntheticReader",
          clientId: "syntheticreader",
          federationReviewId: "synthetic-reader-google-only",
          siteReviewId: "synthetic-reader-site",
        },
      ]),
      loginChallengeSigner: {
        kind: "parameter-store",
        parameterPrefix: "/prospectus/central-accounts/login-challenge-mac/",
        currentKeyId: "v1",
      },
      ...(siteSubjectSecret ? { siteSubjectSecret } : {}),
    },
  );
  return Template.fromStack(stack).toJSON();
}
const pseudo: Record<string, string> = {
  "AWS::Partition": "aws",
  "AWS::Region": "us-east-1",
  "AWS::AccountId": "712236451410",
};
const resolveArn = (value: any): string =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.map(resolveArn).join(" ")
      : value?.["Fn::Join"]
        ? value["Fn::Join"][1].map(resolveArn).join(value["Fn::Join"][0])
        : (pseudo[value?.Ref] ?? JSON.stringify(value));

test("the site subject secret is one retained create-only custom resource; only its initializer may put the parameter", () => {
  const without = template(),
    built = template({ version: "v1", parameterName: PARAMETER });
  const added = Object.entries(built.Resources as Record<string, any>)
    .filter(([id]) => !without.Resources[id])
    .map(([, value]) => value);
  assert.deepEqual(added.map((resource) => resource.Type).sort(), [
    "AWS::IAM::Policy",
    "AWS::IAM::Role",
    "AWS::Lambda::Function",
    "AWS::Logs::LogGroup",
    "Custom::ProspectusSiteSubjectSecret",
  ]);
  assert.ok(
    !JSON.stringify(built.Resources).includes("AWS::SSM::Parameter"),
    "CloudFormation holds no secret",
  );
  const custom = added.find((resource) => resource.Type === "Custom::ProspectusSiteSubjectSecret");
  assert.equal(custom.Properties.ParameterName, PARAMETER);
  assert.equal(custom.DeletionPolicy, "Retain");
  assert.equal(custom.UpdateReplacePolicy, "Retain");
  const role = added.find((resource) => resource.Type === "AWS::IAM::Role");
  assert.equal(role.Properties.RoleName, "prospectus-site-subject-secret-init");
  const initializer = added.find((resource) => resource.Type === "AWS::Lambda::Function");
  assert.equal(initializer.Properties.FunctionName, "prospectus-site-subject-secret-init");
  assert.equal(initializer.Properties.Code.ZipFile, SITE_SUBJECT_SECRET_INITIALIZER_SOURCE);
  assert.equal(initializer.Properties.Environment, undefined);
  const statements = added.find((resource) => resource.Type === "AWS::IAM::Policy").Properties.PolicyDocument
    .Statement;
  assert.deepEqual(
    statements.map((statement: any) => [statement.Effect, statement.Action, statement.Condition ?? null]),
    [
      ["Allow", "ssm:PutParameter", null],
      ["Deny", "ssm:PutParameter", { StringEquals: { "ssm:Overwrite": "true" } }],
      ["Allow", ["logs:CreateLogStream", "logs:PutLogEvents"], null],
    ],
  );
  for (const statement of statements.slice(0, 2))
    assert.ok(resolveArn(statement.Resource).includes(PARAMETER_ARN));

  // The central runtime reads exactly this parameter, gets the reviewed configuration, and is updated after it exists.
  const central = Object.entries(built.Resources as Record<string, any>).find(
    ([, resource]) =>
      resource.Type === "AWS::Lambda::Function" &&
      resource.Properties.FunctionName === "prospectus-central-accounts",
  )!;
  assert.deepEqual(JSON.parse(central[1].Properties.Environment.Variables.PROSPECTUS_SITE_SUBJECT_SECRET), {
    version: "v1",
    parameterName: PARAMETER,
  });
  const customId = Object.entries(built.Resources as Record<string, any>).find(
    ([, resource]) => resource.Type === "Custom::ProspectusSiteSubjectSecret",
  )![0];
  assert.ok(central[1].DependsOn.includes(customId));
  const reads = Object.values(built.Resources as Record<string, any>)
    .filter((resource) => resource.Type === "AWS::IAM::Policy")
    .flatMap((resource) => resource.Properties.PolicyDocument.Statement)
    .filter((statement: any) => resolveArn(statement.Resource).includes(PARAMETER_ARN));
  assert.deepEqual(reads.map((statement: any) => statement.Action).sort(), [
    "ssm:GetParameter",
    "ssm:PutParameter",
    "ssm:PutParameter",
  ]);
  // Without the configuration nothing about site subjects is deployed.
  assert.ok(!/site-subject-secret|SITE_SUBJECT|site-subject\/v1/.test(JSON.stringify(without)));
  assert.throws(() => template({ version: "v1", parameterName: "/prospectus/site-subject/v2" }));
});

test("the retired-subject route reuses the site statement's GET/v1/accounts/* pattern: the access policy does not grow", () => {
  const policy = (built: any) =>
    (Object.values(built.Resources) as any[]).find((value) => value.Type === "AWS::ApiGateway::RestApi")
      .Properties.Policy;
  const sites = policy(template()).Statement.find((statement: any) =>
    JSON.stringify(statement.Principal).includes("synthetic-reader-runtime"),
  );
  assert.equal(sites.Resource.length, 8);
  assert.ok(sites.Resource.includes("execute-api:/api/GET/v1/accounts/*"));
  assert.ok(!JSON.stringify(policy(template())).includes("site-subjects"));
  assert.equal(
    JSON.stringify(policy(template({ version: "v1", parameterName: PARAMETER }))),
    JSON.stringify(policy(template())),
  );
});

/** Runs the inline initializer source with a fake SSM client and a captured CloudFormation response. */
async function runInitializer(event: Record<string, unknown>, put: (input: any) => Promise<unknown>) {
  const inputs: any[] = [];
  const responses: any[] = [];
  const logged: string[] = [];
  class PutParameterCommand {
    constructor(readonly input: any) {}
  }
  class SSMClient {
    async send(command: PutParameterCommand) {
      inputs.push(command.input);
      return put(command.input);
    }
  }
  const module = { exports: {} as any };
  const fakeRequire = (name: string) =>
    name === "@aws-sdk/client-ssm" ? { SSMClient, PutParameterCommand } : nodeRequire(name);
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = (async (url: string, init: any) => {
    responses.push({ url, ...init, body: JSON.parse(init.body) });
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  console.log = (...values: unknown[]) => void logged.push(values.map(String).join(" "));
  try {
    new Function("require", "exports", "module", SITE_SUBJECT_SECRET_INITIALIZER_SOURCE)(
      fakeRequire,
      module.exports,
      module,
    );
    await module.exports.handler({
      StackId: "synthetic-stack",
      RequestId: "synthetic-request",
      LogicalResourceId: "SiteSubjectSecret",
      ResponseURL: "https://example.com/synthetic-response",
      ResourceProperties: { ParameterName: PARAMETER },
      ...event,
    });
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
  return { inputs, responses, logged };
}
test("the initializer creates a 48-byte SecureString once and never returns, logs, overwrites or deletes it", async () => {
  const created = await runInitializer({ RequestType: "Create" }, async () => ({}));
  assert.equal(created.inputs.length, 1);
  const [input] = created.inputs;
  assert.equal(input.Name, PARAMETER);
  assert.equal(input.Type, "SecureString");
  assert.equal(input.Overwrite, false);
  assert.equal(Buffer.from(input.Value, "base64").length, 48);
  const [response] = created.responses;
  assert.equal(response.method, "PUT");
  assert.equal(response.body.Status, "SUCCESS");
  assert.equal(response.body.NoEcho, true);
  assert.deepEqual(response.body.Data, {});
  assert.equal(response.body.PhysicalResourceId, PARAMETER);
  assert.ok(!JSON.stringify(created.responses).includes(input.Value));
  assert.deepEqual(created.logged, []);

  // An existing parameter is left alone and still succeeds.
  const exists = await runInitializer({ RequestType: "Create" }, async () => {
    throw Object.assign(new Error("exists"), { name: "ParameterAlreadyExists" });
  });
  assert.equal(exists.responses[0].body.Status, "SUCCESS");

  // Update with the same name and Delete never touch SSM.
  for (const event of [
    {
      RequestType: "Update",
      PhysicalResourceId: PARAMETER,
      OldResourceProperties: { ParameterName: PARAMETER },
    },
    { RequestType: "Delete", PhysicalResourceId: PARAMETER },
  ]) {
    const result = await runInitializer(event, async () => ({}));
    assert.equal(result.inputs.length, 0);
    assert.equal(result.responses[0].body.Status, "SUCCESS");
    assert.equal(result.responses[0].body.PhysicalResourceId, PARAMETER);
  }

  // Failures report only an error class.
  const failed = await runInitializer({ RequestType: "Create" }, async () => {
    throw Object.assign(new Error("secret-looking detail"), { name: "AccessDeniedException" });
  });
  assert.equal(failed.responses[0].body.Status, "FAILED");
  assert.match(failed.responses[0].body.Reason, /AccessDeniedException/);
  assert.ok(!failed.responses[0].body.Reason.includes("secret-looking detail"));
});
