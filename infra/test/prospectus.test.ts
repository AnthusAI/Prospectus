import assert from "node:assert/strict";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { ProspectusDeploymentStack } from "../lib/prospectus-deployment-stack";
import { ProspectusBackend } from "../lib/prospectus-backend";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import {
  assertDeploymentScope, AMPLIFY_APP_ID, DEPLOYMENT_BRANCH, SOURCE_REPOSITORY, SITE_DOMAIN,
  TARGET_ACCOUNT, TARGET_REGION,
} from "../lib/scope";

const env = { account: TARGET_ACCOUNT, region: TARGET_REGION };
const appTemplate = () => {
 const stack = new cdk.Stack(new cdk.App(), "Review", { env });
 new ProspectusBackend(stack, "Prospectus", lambda.Code.fromBucket(s3.Bucket.fromBucketName(stack, "ReviewedArtifact", "review-only-artifact"), "review-only.zip"));
 return Template.fromStack(stack);
};

test("canonical files remain private, retained S3 objects; catalog is scoped metadata", () => {
  const template = appTemplate();
  template.resourceCountIs("AWS::S3::Bucket", 1);
  template.resourceCountIs("AWS::DynamoDB::Table", 1);
  template.hasResourceProperties("AWS::S3::Bucket", {
    VersioningConfiguration: { Status: "Enabled" },
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
    },
  });
  template.hasResourceProperties("AWS::DynamoDB::Table", {
    KeySchema: [{ AttributeName: "scope", KeyType: "HASH" }, { AttributeName: "path", KeyType: "RANGE" }],
    BillingMode: "PAY_PER_REQUEST",
    DeletionProtectionEnabled: true,
    PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    GlobalSecondaryIndexes: Match.arrayWith([
      Match.objectLike({ IndexName: "by_type", KeySchema: [{ AttributeName: "type_scope", KeyType: "HASH" }, { AttributeName: "path", KeyType: "RANGE" }] }),
      Match.objectLike({ IndexName: "by_status", KeySchema: [{ AttributeName: "status_scope", KeyType: "HASH" }, { AttributeName: "path", KeyType: "RANGE" }] }),
      Match.objectLike({ IndexName: "by_type_status", KeySchema: [{ AttributeName: "type_status_scope", KeyType: "HASH" }, { AttributeName: "path", KeyType: "RANGE" }] }),
    ]),
  });
  for (const resource of Object.values(template.findResources("AWS::DynamoDB::Table"))) {
    assert.equal(resource.DeletionPolicy, "Retain");
  }
});

test("dedicated user pool disables signup and browser client uses authorization code only", () => {
  const template = appTemplate();
  template.hasResourceProperties("AWS::Cognito::UserPool", {
    AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    DeletionProtection: "ACTIVE",
  });
  template.hasResourceProperties("AWS::Cognito::UserPoolGroup", { GroupName: "prospectus-members" });
  template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
    GenerateSecret: false,
    AllowedOAuthFlows: ["code"],
    SupportedIdentityProviders: ["Google"],
    CallbackURLs: [`https://${SITE_DOMAIN}/auth/callback`],
    LogoutURLs: [`https://${SITE_DOMAIN}/`],
  });
  template.resourceCountIs("AWS::Cognito::UserPoolUser", 0);
  template.hasResourceProperties("AWS::Cognito::UserPoolIdentityProvider", { ProviderType: "Google", AttributeMapping: { email: "email", email_verified: "email_verified" } });
  template.resourceCountIs("AWS::SecretsManager::Secret", 0);
});

test("every application API route requires verified JWT and access-token scope", () => {
  const template = appTemplate();
  const routes = Object.values(template.findResources("AWS::ApiGatewayV2::Route"));
  assert.equal(routes.length, 4);
  for (const route of routes) {
    assert.equal(route.Properties.AuthorizationType, "JWT");
    assert.deepEqual(route.Properties.AuthorizationScopes, ["openid"]);
    assert.ok(route.Properties.AuthorizerId);
  }
  template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
    CorsConfiguration: { AllowOrigins: [`https://${SITE_DOMAIN}`] },
  });
  template.hasResourceProperties("AWS::Lambda::Function", {
    Runtime: "provided.al2023",
    Architectures: ["x86_64"],
    Environment: { Variables: {
      KANBUS_BACKEND: "s3",
      KANBUS_NAMESPACE: "cyclotron/prospectus",
      KANBUS_REQUIRED_GROUP: "prospectus-members",
      KANBUS_OBJECT_BUCKET: Match.anyValue(), KANBUS_CATALOG_TABLE: Match.anyValue(),
    } },
    FunctionName: "prospectus-cyclotron-api",
    VpcConfig: Match.absent(),
  });
  template.resourceCountIs("AWS::Lambda::Url", 0);
});

test("runtime policies permit only scoped object access and catalog operations", () => {
  const template = appTemplate();
  template.hasResourceProperties("AWS::IAM::Policy", {
    PolicyDocument: { Statement: Match.arrayWith([{
      Effect: "Allow", Action: "s3:ListBucket", Resource: Match.anyValue(),
      Condition: { StringLike: { "s3:prefix": ["cyclotron/prospectus/*", "_virtuus/cyclotron/prospectus/*"] } },
    }, {
      Effect: "Allow",
      Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Query"],
      Resource: Match.anyValue(),
      Condition: { "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["cyclotron/prospectus"] } },
    }]) },
  });
  const policies = JSON.stringify(template.findResources("AWS::IAM::Policy"));
  const roles = JSON.stringify(template.findResources("AWS::IAM::Role"));
  assert.ok(!roles.includes("AWSLambdaBasicExecutionRole"));
  for (const forbidden of ["dynamodb:Scan", "s3:DeleteBucket", "dynamodb:DeleteTable", "cognito-idp:AdminCreateUser", "cognito-idp:AdminAddUserToGroup", "iam:PassRole"]) {
    assert.ok(!policies.includes(forbidden), `${forbidden} must not be granted to API runtime`);
  }
});

test("Amplify owns hosting; backend has no alternative delivery or public data plane", () => {
 const template = appTemplate();
 for (const type of ["AWS::CloudFront::Distribution", "AWS::CodePipeline::Pipeline", "AWS::CodeBuild::Project", "AWS::Route53::RecordSet", "AWS::Cognito::UserPoolUser", "AWS::AppSync::GraphQLApi"]) template.resourceCountIs(type, 0);
});

test("scope changes fail unless the exact account, region, hostname and source are reviewed", () => {
  const scope = { ...env, siteDomain: SITE_DOMAIN, repository: SOURCE_REPOSITORY, appId: AMPLIFY_APP_ID, branch: DEPLOYMENT_BRANCH };
  assert.doesNotThrow(() => assertDeploymentScope(scope));
  for (const key of Object.keys(scope)) {
    assert.throws(() => assertDeploymentScope({ ...scope, [key]: "unreviewed" }), /must be/);
  }
});


test("deployment identities use isolated file bootstrap and omit direct marketing IAM or pipeline grants", () => {
  const template = Template.fromStack(new ProspectusDeploymentStack(new cdk.App(), "DeliveryReview", { env }));
  template.resourceCountIs("AWS::IAM::Role", 5);
  template.resourceCountIs("AWS::ECR::Repository", 0);
  template.hasResourceProperties("AWS::SSM::Parameter", { Name: "/cdk-bootstrap/prspctus/version", Value: "8" });
  const policies = JSON.stringify(template.findResources("AWS::IAM::Policy"));
  for (const forbidden of ["AdministratorAccess", "AmplifyBackendDeployFullAccess", "CyclotronMarketing", "codepipeline:", "cloudfront:", "cognito-idp:AdminCreateUser", "cognito-idp:AdminAddUserToGroup", "route53:"]) assert.ok(!policies.includes(forbidden), forbidden);
});


test("Google admission runtime links only in its own pool and reads no OAuth secret", () => {
 const template = appTemplate();
 template.hasResourceProperties("AWS::Lambda::Function", { FunctionName: "prospectus-cyclotron-google-admission", Runtime: "nodejs22.x" });
 const policies = Object.values(template.findResources("AWS::IAM::Policy"));
 const admission = policies.find(policy => JSON.stringify(policy).includes("cognito-idp:AdminLinkProviderForUser"));
 assert.ok(admission);
 const text = JSON.stringify(admission);
 assert.ok(!text.includes("secretsmanager:"));
 assert.ok(!text.includes("cognito-idp:AdminCreateUser"));
 assert.ok(!text.includes("cognito-idp:AdminAddUserToGroup"));
 assert.ok(!text.includes('"Resource":"*"'));
});
