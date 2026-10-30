import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { App, Stack } from "aws-cdk-lib";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { Code } from "aws-cdk-lib/aws-lambda";
import { Template } from "aws-cdk-lib/assertions";
import { ProspectusBackend } from "../lib/prospectus-backend";
import { parseCliSignIn, type CliSignInBroker } from "../lib/cli-sign-in-deployment";
import { SITE_DOMAIN } from "../lib/scope";

const BROKER_ARN = "arn:aws:lambda:us-east-1:712236451410:function:prospectus-cli-broker-Broker-AbC123";
const BROKER_URL = "https://abcdefghijklmnopqrstuvwxyz012345.lambda-url.us-east-1.on.aws/";
const PAGES_ROUTES = ["GET /cli/approve", "GET /cli/callback", "GET /cli/discovery", "POST /cli/approve"];

function template(cli: { broker: CliSignInBroker | null } | undefined, accounts = true) {
  const stack = new Stack(new App(), "CliReview", { env: { account: "712236451410", region: "us-east-1" } });
  new ProspectusBackend(
    stack,
    "Prospectus",
    Code.fromBucket(Bucket.fromBucketName(stack, "Artifact", "review-only-artifact"), "crm.zip"),
    undefined,
    accounts
      ? {
          code: Code.fromInline("accounts artifact placeholder"),
          bffCode: Code.fromInline("BFF artifact placeholder"),
          googlePolicyReviewId: "synthetic-review-v1",
          consoleClientEnabled: false,
          consolePairEnabled: false,
          consoleFederationReviewId: "cyclotron-google-only-unlinked-v1-20261015",
          consolePairReviewId: "cyclotron-execution-pair-v1-20261015",
          papyrusSites: [],
          loginChallengeSigner: {
            kind: "parameter-store",
            parameterPrefix: "/prospectus/central-accounts/login-challenge-mac/",
            currentKeyId: "v1",
          },
        }
      : undefined,
    "synthetic-only",
    [],
    undefined,
    "shadow",
    cli ? { ...cli, code: Code.fromInline("pages artifact placeholder") } : undefined,
  );
  return Template.fromStack(stack);
}

const pagesFunction = (t: Template) =>
  Object.values(
    t.findResources("AWS::Lambda::Function", { Properties: { FunctionName: "prospectus-cli-pages" } }),
  );

const pagesPolicy = (t: Template) => {
  const [role] = Object.entries(
    t.findResources("AWS::IAM::Role", { Properties: { RoleName: "prospectus-cli-pages-runtime" } }),
  );
  assert.ok(role, "pages role");
  const policies = Object.values(t.findResources("AWS::IAM::Policy")).filter((policy: any) =>
    policy.Properties.Roles.some((ref: any) => ref.Ref === role[0]),
  );
  return {
    role: role[1] as any,
    statements: policies.flatMap((policy: any) => policy.Properties.PolicyDocument.Statement),
  };
};

test("the committed configuration is rollout step 1: the pages deploy without a broker", () => {
  const committed = JSON.parse(readFileSync(new URL("../cli-sign-in.json", import.meta.url), "utf8"));
  assert.deepEqual(committed, { enabled: true, broker: null });
  assert.deepEqual(parseCliSignIn(committed), { broker: null });
});

test("while disabled there is no pages function, role or route", () => {
  const t = template(undefined);
  assert.equal(pagesFunction(t).length, 0);
  assert.equal(
    Object.keys(
      t.findResources("AWS::IAM::Role", { Properties: { RoleName: "prospectus-cli-pages-runtime" } }),
    ).length,
    0,
  );
  const keys = Object.values(t.findResources("AWS::ApiGatewayV2::Route")).map(
    (route: any) => route.Properties.RouteKey,
  );
  assert.ok(!keys.some((key) => key.includes("/cli/")));
});

test("the pages are four public routes on the CRM API, throttled, and nothing else under /cli", () => {
  const t = template({ broker: null });
  const routes = Object.values(t.findResources("AWS::ApiGatewayV2::Route")).filter((route: any) =>
    route.Properties.RouteKey.includes("/cli/"),
  ) as any[];
  assert.deepEqual(routes.map((route) => route.Properties.RouteKey).sort(), PAGES_ROUTES);
  for (const route of routes) {
    assert.equal(route.Properties.AuthorizationType, "NONE");
    assert.equal(route.Properties.AuthorizationScopes, undefined);
  }
  const [stage] = Object.values(t.findResources("AWS::ApiGatewayV2::Stage")) as any[];
  for (const key of PAGES_ROUTES)
    assert.deepEqual(
      stage.Properties.RouteSettings[key],
      { ThrottlingBurstLimit: 10, ThrottlingRateLimit: 5 },
      key,
    );
});

test("before the broker exists the pages run unconfigured and may invoke nothing", () => {
  const t = template({ broker: null });
  const [fn] = pagesFunction(t) as any[];
  assert.equal(fn.Properties.Runtime, "python3.12");
  assert.equal(fn.Properties.Handler, "prospectus_cli.pages.lambda_handler");
  assert.equal(fn.Properties.Environment, undefined);
  const { statements } = pagesPolicy(t);
  assert.deepEqual(
    statements
      .map((statement: any) => statement.Action)
      .flat()
      .sort(),
    ["logs:CreateLogStream", "logs:PutLogEvents"],
  );
});

test("with the broker the pages may invoke only that function and know only public values", () => {
  const t = template({ broker: { functionArn: BROKER_ARN, endpoint: BROKER_URL } });
  const [fn] = pagesFunction(t) as any[];
  const environment = fn.Properties.Environment.Variables;
  assert.deepEqual(Object.keys(environment).sort(), [
    "CLI_API_URL",
    "CLI_BROKER_ARN",
    "CLI_BROKER_ENDPOINT",
    "CLI_CLIENT_ID",
    "CLI_ISSUER",
    "CLI_OAUTH_DOMAIN",
    "CLI_PUBLIC_ORIGIN",
  ]);
  assert.equal(environment.CLI_BROKER_ARN, BROKER_ARN);
  assert.equal(
    environment.CLI_BROKER_ENDPOINT,
    "https://abcdefghijklmnopqrstuvwxyz012345.lambda-url.us-east-1.on.aws",
  );
  assert.equal(environment.CLI_PUBLIC_ORIGIN, `https://${SITE_DOMAIN}`);
  const { role, statements } = pagesPolicy(t);
  assert.deepEqual(role.Properties.AssumeRolePolicyDocument.Statement[0].Principal, {
    Service: "lambda.amazonaws.com",
  });
  assert.equal(role.Properties.ManagedPolicyArns, undefined);
  const invoke = statements.filter((statement: any) => statement.Action === "lambda:InvokeFunction");
  assert.deepEqual(invoke, [{ Action: "lambda:InvokeFunction", Effect: "Allow", Resource: BROKER_ARN }]);
  const actions = statements.map((statement: any) => statement.Action).flat();
  for (const action of actions)
    assert.match(action, /^(logs:CreateLogStream|logs:PutLogEvents|lambda:InvokeFunction)$/);
});

test("remote CLI sign-in needs the accounts plane for enrollment", () => {
  assert.throws(() => template({ broker: null }, false), /accounts/);
});

test("the configuration accepts only a broker in this account and region", () => {
  assert.deepEqual(parseCliSignIn({ enabled: true, broker: null }), { broker: null });
  assert.deepEqual(
    parseCliSignIn({ enabled: true, broker: { functionArn: BROKER_ARN, endpoint: BROKER_URL } }),
    {
      broker: { functionArn: BROKER_ARN, endpoint: BROKER_URL },
    },
  );
  for (const bad of [
    { enabled: "yes", broker: null },
    { enabled: true },
    { enabled: true, broker: null, extra: 1 },
    {
      enabled: true,
      broker: { functionArn: BROKER_ARN.replace("712236451410", "682849160744"), endpoint: BROKER_URL },
    },
    {
      enabled: true,
      broker: { functionArn: BROKER_ARN.replace("us-east-1", "us-west-2"), endpoint: BROKER_URL },
    },
    {
      enabled: true,
      broker: { functionArn: BROKER_ARN, endpoint: "http://abc.lambda-url.us-east-1.on.aws/" },
    },
    { enabled: true, broker: { functionArn: BROKER_ARN, endpoint: "https://broker.example.com/" } },
    { enabled: true, broker: { functionArn: BROKER_ARN } },
  ])
    assert.throws(() => parseCliSignIn(bad), /cli-sign-in/, JSON.stringify(bad));
});

test("the pages bundle is built before pipeline-deploy and handed to the backend only when enabled", () => {
  const lines = readFileSync(new URL("../../amplify.yml", import.meta.url), "utf8")
    .split("\n")
    .map((line) => line.trim());
  const build = lines.indexOf("- node infra/scripts/build-cli-pages-if-enabled.mjs");
  assert.ok(build > 0 && build < lines.findIndex((line) => line.includes("ampx pipeline-deploy")));
  const backend = readFileSync(new URL("../../amplify/backend.ts", import.meta.url), "utf8");
  assert.match(backend, /cliSignIn \? \{ \.\.\.cliSignIn, code: Code\.fromAsset\(cliPages\) \} : undefined/);
});

const rewrite = (t: Template) => Object.values(t.findResources("Custom::AmplifyRewrite")) as any[];

test("prospectus.anth.us proxies /cli/<*> to the CRM API through one owned rewrite", () => {
  assert.equal(rewrite(template(undefined)).length, 0, "no rewrite while disabled");
  const t = template({ broker: null });
  const [rule] = rewrite(t);
  assert.ok(rule, "the rewrite exists before the broker so routing can be proven on 503");
  assert.equal(rule.Properties.AppId, "d15sc1sptohtqb");
  assert.equal(rule.Properties.Source, "/cli/<*>");
  const [api] = Object.keys(t.findResources("AWS::ApiGatewayV2::Api"));
  assert.deepEqual(rule.Properties.Target, {
    "Fn::Join": ["", [{ "Fn::GetAtt": [api, "ApiEndpoint"] }, "/cli/<*>"]],
  });
  const [helper] = Object.values(
    t.findResources("AWS::Lambda::Function", { Properties: { FunctionName: "prospectus-cli-rewrite" } }),
  ) as any[];
  assert.equal(helper.Properties.Runtime, "python3.12");
  assert.equal(
    helper.Properties.Code.ZipFile,
    readFileSync(new URL("../lib/cli-rewrite/index.py", import.meta.url), "utf8"),
  );
  assert.ok(Buffer.byteLength(helper.Properties.Code.ZipFile) < 4096, "inline code limit");
  assert.ok(
    rule.DependsOn?.some((id: string) => id.includes("RewriteRole")),
    "policy precedes the rule",
  );
});

test("the rewrite helper may read and update only the CRM's Amplify app", () => {
  const t = template({ broker: { functionArn: BROKER_ARN, endpoint: BROKER_URL } });
  const [role] = Object.entries(
    t.findResources("AWS::IAM::Role", { Properties: { RoleName: "prospectus-cli-rewrite" } }),
  );
  assert.ok(role);
  assert.equal((role[1] as any).Properties.ManagedPolicyArns, undefined);
  const statements = Object.values(t.findResources("AWS::IAM::Policy"))
    .filter((policy: any) => policy.Properties.Roles.some((ref: any) => ref.Ref === role[0]))
    .flatMap((policy: any) => policy.Properties.PolicyDocument.Statement);
  const amplify = statements.filter((statement: any) =>
    JSON.stringify(statement.Action).includes("amplify:"),
  );
  assert.deepEqual(amplify, [
    {
      Action: ["amplify:GetApp", "amplify:UpdateApp"],
      Effect: "Allow",
      Resource: "arn:aws:amplify:us-east-1:712236451410:apps/d15sc1sptohtqb",
    },
  ]);
  for (const action of statements.map((statement: any) => statement.Action).flat())
    assert.match(action, /^(logs:CreateLogStream|logs:PutLogEvents|amplify:GetApp|amplify:UpdateApp)$/);
});
