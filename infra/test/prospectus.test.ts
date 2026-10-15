import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
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

test("Google-first identity creation has no pre-enrollment gate and CRM roles are assigned separately", () => {
  const template = appTemplate();
  template.hasResourceProperties("AWS::Cognito::UserPool", {
    AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    DeletionProtection: "ACTIVE",
    LambdaConfig: Match.absent(),
  });
  template.hasResourceProperties("AWS::Cognito::UserPoolGroup", { GroupName: "prospectus-members" });
  template.hasResourceProperties("AWS::Cognito::UserPoolGroup", { GroupName: "admin" });
  template.hasResourceProperties("AWS::Cognito::UserPoolDomain", { Domain: `prospectus-${TARGET_ACCOUNT}` });
  template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
    GenerateSecret: false,
    AllowedOAuthFlows: ["code"],
    SupportedIdentityProviders: ["Google"],
    ExplicitAuthFlows: ["ALLOW_REFRESH_TOKEN_AUTH"],
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
    FunctionName: "prospectus-api",
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


test("actual Amplify Gen2 assembly uses standard bootstrap and only application roles", () => {
  const output = mkdtempSync(resolve(tmpdir(), "prospectus-amplify-review-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "infra/scripts/synth-amplify-review.ts"], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: { ...process.env, PROSPECTUS_REVIEW_OUTDIR: output },
      encoding: "utf8", timeout: 60_000,
    });
    assert.equal(result.status, 0, result.error?.message ?? `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /standard hnb659fds bootstrap references and scoped application roles/);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});


test("Google-first sign-in creates no enrollment or identity-linking Lambda privileges", () => {
 const template = appTemplate();
 template.resourceCountIs("AWS::Lambda::Function", 1);
 const policies = JSON.stringify(template.findResources("AWS::IAM::Policy"));
 for (const action of ["cognito-idp:AdminLinkProviderForUser", "cognito-idp:AdminCreateUser", "cognito-idp:AdminAddUserToGroup"]) assert.ok(!policies.includes(action));
});


test("hosting SPA rewrite handles dotted application paths while preserving static assets", () => {
  const settings = JSON.parse(readFileSync(new URL("../hosting-settings.json", import.meta.url), "utf8"));
  const rule = settings.customRules[0];
  assert.equal(rule.target, "/index.html");
  assert.equal(rule.status, "200");
  assert.ok(rule.source.startsWith("</") && rule.source.endsWith("/>"));
  const route = new RegExp(rule.source.slice(2, -2));
  for (const path of ["/auth/callback", "/prospects/acme.example", "/sales/report.csv"]) assert.ok(route.test(path), path);
  for (const path of ["/assets/app.js", "/assets/style.css", "/assets/icon.svg", "/assets/font.woff2", "/config.json"]) assert.ok(!route.test(path), path);
  assert.equal(settings.environmentVariables._LIVE_UPDATES, "[]", "pinned Gen2 builds must not install global legacy CLI overrides");
  assert.equal(settings.enableBranchAutoBuild, false);
  assert.equal(settings.enableAutoBranchCreation, false);
});
