import assert from "node:assert/strict";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Template } from "aws-cdk-lib/assertions";
import { EvaluationIntake } from "../lib/evaluation-intake";

test("synthetic evaluation adds only a fixed submit route and narrowly named runtime resources", () => {
  const stack = new cdk.Stack(new cdk.App(), "EvaluationReview", { env: { account: "712236451410", region: "us-east-1" } });
  new EvaluationIntake(stack, "Intake", lambda.Code.fromInline("exports.handler=async()=>({statusCode:503})"));
  const template = Template.fromStack(stack);
  template.resourceCountIs("AWS::Cognito::UserPool", 0);
  template.resourceCountIs("AWS::S3::Bucket", 0);
  template.resourceCountIs("AWS::DynamoDB::Table", 0);
  template.resourceCountIs("AWS::Lambda::Function", 1);
  template.hasResourceProperties("AWS::Lambda::Function", { FunctionName: "prospectus-intake-evaluation", ReservedConcurrentExecutions: 2, Runtime: "nodejs22.x" });
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "POST /intake/demo" });
  template.hasResourceProperties("AWS::ApiGatewayV2::Stage", { DefaultRouteSettings: { ThrottlingBurstLimit: 2, ThrottlingRateLimit: 1 } });
  const statements = Object.values(template.findResources("AWS::IAM::Policy")).flatMap((r: any) => r.Properties.PolicyDocument.Statement);
  const actions = statements.flatMap((s: any) => Array.isArray(s.Action) ? s.Action : [s.Action]).sort();
  assert.deepEqual(actions, ["lambda:InvokeFunction", "logs:CreateLogStream", "logs:PutLogEvents", "s3:GetObject", "s3:PutObject"].sort());
  const invoke = statements.find((s: any) => s.Action === "lambda:InvokeFunction");
  assert.equal(invoke.Resource, "arn:aws:lambda:us-east-1:712236451410:function:prospectus-api");
  const s3 = statements.find((s: any) => Array.isArray(s.Action) && s.Action.includes("s3:GetObject"));
  assert.deepEqual(s3.Resource, ["arn:aws:s3:::prospectus-records-712236451410/_virtuus/cyclotron/prospectus/intake-identities/*", "arn:aws:s3:::prospectus-records-712236451410/_virtuus/cyclotron/prospectus/intake-receipts/*"]);
});
