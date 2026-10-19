import assert from "node:assert/strict";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Template } from "aws-cdk-lib/assertions";
import { EvaluationIntake } from "../lib/evaluation-intake";
import { ProspectusBackend } from "../lib/prospectus-backend";

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
