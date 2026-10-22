import assert from "node:assert/strict";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Template } from "aws-cdk-lib/assertions";
import { EvaluationIntake, intakeFormOriginsForMode } from "../lib/evaluation-intake";
import { RESERVED_DEMO_ORIGINS, parseIntakeForm, parseIntakeFormRegistry } from "../../server/intake-forms";
import { ProspectusBackend } from "../lib/prospectus-backend";
import { unscopableRoutesWithScopes } from "./route-auth";

const lambdaEnvironment = (template: Template) =>
  (Object.values(template.findResources("AWS::Lambda::Function"))[0] as any).Properties.Environment.Variables;
const corsOrigins = (template: Template) =>
  (Object.values(template.findResources("AWS::ApiGatewayV2::Api"))[0] as any).Properties.CorsConfiguration
    .AllowOrigins;

test("synthetic evaluation adds only a fixed submit route and narrowly named runtime resources", () => {
  const stack = new cdk.Stack(new cdk.App(), "EvaluationReview", {
    env: { account: "712236451410", region: "us-east-1" },
  });
  new EvaluationIntake(
    stack,
    "Intake",
    lambda.Code.fromInline("exports.handler=async()=>({statusCode:503})"),
  );
  const template = Template.fromStack(stack);
  template.resourceCountIs("AWS::Cognito::UserPool", 0);
  template.resourceCountIs("AWS::S3::Bucket", 0);
  template.resourceCountIs("AWS::DynamoDB::Table", 0);
  template.resourceCountIs("AWS::Lambda::Function", 1);
  template.resourceCountIs("AWS::Logs::LogGroup", 0);
  template.hasResourceProperties("AWS::Lambda::Function", {
    FunctionName: "prospectus-intake-evaluation",
    Runtime: "nodejs24.x",
  });
  const intakeFunction = Object.values(template.findResources("AWS::Lambda::Function"))[0] as any;
  assert.equal(
    intakeFunction.Properties.ReservedConcurrentExecutions,
    undefined,
    "the account has no spare concurrency to reserve; throttling comes from the API stage",
  );
  const reservedConcurrencyByFunction = Object.values(template.findResources("AWS::Lambda::Function")).map(
    (resource: any) => resource.Properties.ReservedConcurrentExecutions,
  );
  assert.deepEqual(
    reservedConcurrencyByFunction,
    [undefined],
    "the target account allows 10 concurrent Lambda executions in total, so no function may reserve any",
  );
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "POST /intake/demo" });
  template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
    DefaultRouteSettings: { ThrottlingBurstLimit: 2, ThrottlingRateLimit: 1 },
  });
  assert.deepEqual(unscopableRoutesWithScopes(template.toJSON()), []);
  const statements = Object.values(template.findResources("AWS::IAM::Policy")).flatMap(
    (r: any) => r.Properties.PolicyDocument.Statement,
  );
  const actions = statements
    .flatMap((statement: any) => (Array.isArray(statement.Action) ? statement.Action : [statement.Action]))
    .sort();
  assert.deepEqual(
    actions,
    [
      "lambda:InvokeFunction",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "s3:GetObject",
      "s3:PutObject",
    ].sort(),
  );
  assert.ok(
    !JSON.stringify(statements).includes("s3:ListBucket"),
    "intake claims are created first, so reading an absent claim never needs bucket listing",
  );
  const invoke = statements.find((statement: any) => statement.Action === "lambda:InvokeFunction");
  assert.equal(invoke.Resource, "arn:aws:lambda:us-east-1:712236451410:function:prospectus-api");
  const s3 = statements.find(
    (statement: any) => Array.isArray(statement.Action) && statement.Action.includes("s3:GetObject"),
  );
  assert.deepEqual(s3.Resource, [
    "arn:aws:s3:::prospectus-records-712236451410/_virtuus/cyclotron/prospectus/intake-identities/*",
    "arn:aws:s3:::prospectus-records-712236451410/_virtuus/cyclotron/prospectus/intake-receipts/*",
  ]);
  assert.deepEqual(corsOrigins(template), ["https://prospectus.anth.us"]);
  assert.equal(lambdaEnvironment(template).PROSPECTUS_INTAKE_ALLOWED_ORIGINS, "https://prospectus.anth.us");
  assert.equal(lambdaEnvironment(template).PROSPECTUS_INTAKE_CONTACT_MODE, "synthetic-only");
});

test("real-contact intake adds only the anth.us form origins and keeps the same narrow runtime access", () => {
  const stack = new cdk.Stack(new cdk.App(), "RealContactReview", {
    env: { account: "712236451410", region: "us-east-1" },
  });
  new EvaluationIntake(
    stack,
    "Intake",
    lambda.Code.fromInline("exports.handler=async()=>({statusCode:503})"),
    "real-contacts",
  );
  const template = Template.fromStack(stack);
  const expectedOrigins = ["https://prospectus.anth.us", "https://anth.us", "https://www.anth.us"];
  assert.deepEqual(corsOrigins(template), expectedOrigins);
  assert.equal(lambdaEnvironment(template).PROSPECTUS_INTAKE_ALLOWED_ORIGINS, expectedOrigins.join(","));
  assert.equal(lambdaEnvironment(template).PROSPECTUS_INTAKE_CONTACT_MODE, "real-contacts");
  template.resourceCountIs("AWS::Lambda::Function", 1);
  template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
    DefaultRouteSettings: { ThrottlingBurstLimit: 2, ThrottlingRateLimit: 1 },
  });
  const actions = Object.values(template.findResources("AWS::IAM::Policy"))
    .flatMap((r: any) => r.Properties.PolicyDocument.Statement)
    .flatMap((statement: any) => (Array.isArray(statement.Action) ? statement.Action : [statement.Action]))
    .sort();
  assert.deepEqual(
    actions,
    [
      "lambda:InvokeFunction",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "s3:GetObject",
      "s3:PutObject",
    ].sort(),
  );
});

test("the backend passes the deployment's real-contact mode through to the intake API", () => {
  const stack = new cdk.Stack(new cdk.App(), "BackendRealContactReview", {
    env: { account: "712236451410", region: "us-east-1" },
  });
  const reviewedCrmCode = lambda.Code.fromBucket(
    s3.Bucket.fromBucketName(stack, "ReviewedArtifact", "review-only-artifact"),
    "review-only.zip",
  );
  const intakeCode = lambda.Code.fromInline("exports.handler=async()=>({statusCode:503})");
  const backend = new ProspectusBackend(
    stack,
    "Prospectus",
    reviewedCrmCode,
    intakeCode,
    undefined,
    "real-contacts",
  );
  const template = Template.fromStack(stack);
  assert.ok(backend.outputs.EvaluationIntakeUrl);
  const intakeApi = Object.values(template.findResources("AWS::ApiGatewayV2::Api")).find(
    (resource: any) => resource.Properties.Name === "prospectus-intake-evaluation",
  ) as any;
  assert.deepEqual(intakeApi.Properties.CorsConfiguration.AllowOrigins, [
    "https://prospectus.anth.us",
    "https://anth.us",
    "https://www.anth.us",
  ]);
});

const babulusWaitlist = parseIntakeForm({
  enabled: true,
  approval: "Ryan approved the Babulus waitlist for this synthesis test only",
  siteId: "babulus",
  formId: "babulus-waitlist-v1",
  kind: "waitlist",
  origins: ["https://babul.us", "https://www.babul.us", "https://babulus.anth.us"],
  noticeVersion: "babulus-waitlist-v1",
  owner: "intake-queue",
  defaultPagePath: "/waitlist",
  attributes: { persona: { values: ["creator", "other"] } },
  throttle: { rate: 1, burst: 2 },
});
const synthesize = (
  forms: Parameters<typeof parseIntakeForm>[0][],
  mode: "synthetic-only" | "real-contacts",
) => {
  const stack = new cdk.Stack(new cdk.App(), "WaitlistReview", {
    env: { account: "712236451410", region: "us-east-1" },
  });
  const intake = new EvaluationIntake(
    stack,
    "Intake",
    lambda.Code.fromInline("exports.handler=async()=>({statusCode:503})"),
    mode,
    forms.map((form) => parseIntakeForm(form)),
  );
  return { template: Template.fromStack(stack), intake };
};
const routeKeys = (template: Template) =>
  Object.values(template.findResources("AWS::ApiGatewayV2::Route"))
    .map((route: any) => route.Properties.RouteKey)
    .sort();
const policyActions = (template: Template) =>
  Object.values(template.findResources("AWS::IAM::Policy"))
    .flatMap((r: any) => r.Properties.PolicyDocument.Statement)
    .flatMap((statement: any) => (Array.isArray(statement.Action) ? statement.Action : [statement.Action]))
    .sort();

test("a disabled registry form changes nothing in the synthesized real-contact intake", () => {
  const baseline = synthesize([], "real-contacts");
  const disabled = synthesize([{ ...babulusWaitlist, enabled: false }], "real-contacts");
  assert.deepEqual(disabled.template.toJSON(), baseline.template.toJSON());
  assert.equal(disabled.intake.waitlistBaseUrl, undefined);
});

test("an enabled waitlist form adds its own route, origins and route-level throttle and no permissions", () => {
  const baseline = synthesize([], "real-contacts");
  const { template, intake } = synthesize([babulusWaitlist], "real-contacts");
  assert.deepEqual(routeKeys(template), ["POST /intake/demo", "POST /intake/waitlist/babulus-waitlist-v1"]);
  assert.deepEqual(corsOrigins(template), [
    "https://prospectus.anth.us",
    "https://anth.us",
    "https://www.anth.us",
    "https://babul.us",
    "https://www.babul.us",
    "https://babulus.anth.us",
  ]);
  const api = Object.values(template.findResources("AWS::ApiGatewayV2::Api"))[0] as any;
  assert.deepEqual(api.Properties.CorsConfiguration.AllowHeaders, ["content-type"]);
  assert.deepEqual(api.Properties.CorsConfiguration.AllowMethods, ["POST"]);
  const environment = lambdaEnvironment(template);
  assert.equal(
    environment.PROSPECTUS_INTAKE_ALLOWED_ORIGINS,
    "https://prospectus.anth.us,https://anth.us,https://www.anth.us",
    "the demo route keeps its own origin list",
  );
  assert.deepEqual(
    JSON.parse(environment.PROSPECTUS_INTAKE_FORMS).map((form: any) => form.formId),
    ["babulus-waitlist-v1"],
  );
  template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
    DefaultRouteSettings: { ThrottlingBurstLimit: 2, ThrottlingRateLimit: 1 },
    RouteSettings: {
      "POST /intake/waitlist/babulus-waitlist-v1": { ThrottlingBurstLimit: 2, ThrottlingRateLimit: 1 },
    },
  });
  const stage = Object.values(template.findResources("AWS::ApiGatewayV2::Stage"))[0] as any;
  assert.deepEqual(Object.keys(stage.Properties.RouteSettings), [
    "POST /intake/waitlist/babulus-waitlist-v1",
  ]);
  assert.deepEqual(policyActions(template), policyActions(baseline.template));
  assert.ok(!JSON.stringify(template.toJSON()).includes("s3:ListBucket"));
  template.resourceCountIs("AWS::Lambda::Function", 1);
  assert.match(intake.waitlistBaseUrl!, /\/intake\/waitlist$/);
});

test("waitlist forms collect real contacts so they are refused by the synthetic-only runtime", () => {
  assert.throws(() => synthesize([babulusWaitlist], "synthetic-only"), /real-contacts runtime/);
});

test("each enabled form gets its own throttle so one app cannot spend another's allowance", () => {
  const { template } = synthesize(
    [
      babulusWaitlist,
      {
        ...babulusWaitlist,
        siteId: "papyrus",
        formId: "papyrus-waitlist-v1",
        noticeVersion: "papyrus-waitlist-v1",
        origins: ["https://papyrus.example.org"],
        attributes: {},
        throttle: { rate: 3, burst: 6 },
      },
    ],
    "real-contacts",
  );
  const stage = Object.values(template.findResources("AWS::ApiGatewayV2::Stage"))[0] as any;
  assert.deepEqual(stage.Properties.RouteSettings, {
    "POST /intake/waitlist/babulus-waitlist-v1": { ThrottlingBurstLimit: 2, ThrottlingRateLimit: 1 },
    "POST /intake/waitlist/papyrus-waitlist-v1": { ThrottlingBurstLimit: 6, ThrottlingRateLimit: 3 },
  });
});

test("the shipped registry file enables only the Babulus waitlist for https://babulus.anth.us", async () => {
  const { readFileSync } = await import("node:fs");
  const shipped = parseIntakeFormRegistry(JSON.parse(readFileSync("../intake-forms.json", "utf8")));
  const { template, intake } = synthesize(shipped, "real-contacts");
  assert.deepEqual(routeKeys(template), ["POST /intake/demo", "POST /intake/waitlist/babulus-waitlist-v1"]);
  assert.deepEqual(corsOrigins(template), [
    "https://prospectus.anth.us",
    "https://anth.us",
    "https://www.anth.us",
    "https://babulus.anth.us",
  ]);
  assert.equal(
    lambdaEnvironment(template).PROSPECTUS_INTAKE_ALLOWED_ORIGINS,
    "https://prospectus.anth.us,https://anth.us,https://www.anth.us",
    "babulus.anth.us is not a demo origin",
  );
  const stage = Object.values(template.findResources("AWS::ApiGatewayV2::Stage"))[0] as any;
  assert.deepEqual(stage.Properties.RouteSettings, {
    "POST /intake/waitlist/babulus-waitlist-v1": { ThrottlingBurstLimit: 2, ThrottlingRateLimit: 1 },
  });
  assert.deepEqual(policyActions(template), policyActions(synthesize([], "real-contacts").template));
  assert.deepEqual(unscopableRoutesWithScopes(template.toJSON()), []);
  for (const route of Object.values(template.findResources("AWS::ApiGatewayV2::Route")) as any[])
    assert.equal(route.Properties.AuthorizationScopes, undefined);
  assert.match(intake.waitlistBaseUrl!, /\/intake\/waitlist$/);
});

test("a disabled registry form leaves routes, environment, stage settings and CORS exactly as before", () => {
  const { template } = synthesize([{ ...babulusWaitlist, enabled: false }], "real-contacts");
  assert.deepEqual(routeKeys(template), ["POST /intake/demo"]);
  assert.equal("PROSPECTUS_INTAKE_FORMS" in lambdaEnvironment(template), false);
  const stage = Object.values(template.findResources("AWS::ApiGatewayV2::Stage"))[0] as any;
  assert.equal(stage.Properties.RouteSettings, undefined);
  assert.deepEqual(stage.Properties.DefaultRouteSettings, {
    ThrottlingBurstLimit: 2,
    ThrottlingRateLimit: 1,
  });
  assert.deepEqual(corsOrigins(template), [
    "https://prospectus.anth.us",
    "https://anth.us",
    "https://www.anth.us",
  ]);
  assert.equal(
    lambdaEnvironment(template).PROSPECTUS_INTAKE_ALLOWED_ORIGINS,
    "https://prospectus.anth.us,https://anth.us,https://www.anth.us",
  );
});

test("the registry's reserved demo origins match the real-contact demo origin list", () => {
  assert.deepEqual([...RESERVED_DEMO_ORIGINS].sort(), intakeFormOriginsForMode("real-contacts").sort());
});

test("the synthesized intake refuses forms whose origins overlap another form or the demo origins", () => {
  const overlapping = { ...babulusWaitlist, formId: "other-waitlist-v1", siteId: "other" };
  assert.throws(() => synthesize([babulusWaitlist, overlapping], "real-contacts"), /more than one form/);
  assert.throws(
    () => synthesize([{ ...babulusWaitlist, origins: ["https://anth.us"] }], "real-contacts"),
    /demo origin/,
  );
});

test("every waitlist route in the stage's route settings is created before the stage is updated", () => {
  const { template } = synthesize(
    [
      babulusWaitlist,
      {
        ...babulusWaitlist,
        siteId: "papyrus",
        formId: "papyrus-waitlist-v1",
        noticeVersion: "papyrus-waitlist-v1",
        origins: ["https://papyrus.example.org"],
        attributes: {},
      },
    ],
    "real-contacts",
  );
  const routes = template.findResources("AWS::ApiGatewayV2::Route");
  const stage = Object.values(template.findResources("AWS::ApiGatewayV2::Stage"))[0] as any;
  const settingKeys = Object.keys(stage.Properties.RouteSettings);
  assert.equal(settingKeys.length, 2);
  const dependsOn: string[] = stage.DependsOn ?? [];
  for (const key of settingKeys) {
    const routeLogicalIds = Object.entries(routes)
      .filter(([, route]: [string, any]) => route.Properties.RouteKey === key)
      .map(([logicalId]) => logicalId);
    assert.equal(routeLogicalIds.length, 1, `${key} has exactly one route`);
    assert.ok(dependsOn.includes(routeLogicalIds[0]), `${key} route must be in the stage's DependsOn`);
  }
});

test("intake spam labelling defaults to shadow, is passed only as environment and adds no resource or permission", () => {
  const build = (spamLabelling?: "shadow" | "label") => {
    const stack = new cdk.Stack(new cdk.App(), "SpamReview", {
      env: { account: "712236451410", region: "us-east-1" },
    });
    new EvaluationIntake(
      stack,
      "Intake",
      lambda.Code.fromInline("exports.handler=async()=>({statusCode:503})"),
      "real-contacts",
      [],
      spamLabelling,
    );
    return Template.fromStack(stack);
  };
  const shadow = build();
  const label = build("label");
  assert.equal(lambdaEnvironment(shadow).PROSPECTUS_INTAKE_SPAM_LABELLING, "shadow");
  assert.equal(lambdaEnvironment(label).PROSPECTUS_INTAKE_SPAM_LABELLING, "label");
  assert.deepEqual(policyActions(label), policyActions(shadow));
  assert.deepEqual(
    Object.keys(label.toJSON().Resources).sort(),
    Object.keys(shadow.toJSON().Resources).sort(),
  );
  assert.throws(() => build("off" as never), /Unknown spam labelling/);
});
