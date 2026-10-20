import { test } from "node:test";
import assert from "node:assert/strict";
import { App, Stack } from "aws-cdk-lib";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { Code } from "aws-cdk-lib/aws-lambda";
import { Template } from "aws-cdk-lib/assertions";
import { ProspectusBackend } from "../lib/prospectus-backend";
import { unscopableRoutesWithScopes } from "./route-auth";
import { papyrusSiteRegistrations } from "../../accounts/papyrus-sites";
import type { ProductRegistration } from "../../accounts/auth";
import type { LoginChallengeSignerConfiguration } from "../../accounts/challenge-signer";
const parameterStoreSigner = {
  kind: "parameter-store",
  parameterPrefix: "/prospectus/central-accounts/login-challenge-mac/",
  currentKeyId: "v1",
} as const;
function template(
  enabled: boolean,
  consoleClientEnabled = false,
  consolePairEnabled = false,
  papyrusSites: ProductRegistration[] = [],
  loginChallengeSigner: LoginChallengeSignerConfiguration = parameterStoreSigner,
) {
  const stack = new Stack(new App(), "AccountsReview", {
    env: { account: "712236451410", region: "us-east-1" },
  });
  new ProspectusBackend(
    stack,
    "Prospectus",
    Code.fromBucket(Bucket.fromBucketName(stack, "Artifact", "review-only-artifact"), "crm.zip"),
    undefined,
    enabled
      ? {
          code: Code.fromInline("accounts artifact placeholder"),
          bffCode: Code.fromInline("BFF artifact placeholder"),
          googlePolicyReviewId: "synthetic-review-v1",
          consoleClientEnabled,
          consolePairEnabled,
          consoleFederationReviewId: "cyclotron-google-only-unlinked-v1-20261015",
          consolePairReviewId: "cyclotron-execution-pair-v1-20261015",
          papyrusSites,
          loginChallengeSigner,
        }
      : undefined,
  );
  return Template.fromStack(stack).toJSON();
}
test("Accounts additive synthesis preserves every existing CRM resource and adds only scoped UI routes", () => {
  const before = template(false),
    after = template(true);
  for (const [id, resource] of Object.entries(before.Resources as Record<string, any>)) {
    if (resource.Type === "AWS::ApiGatewayV2::Stage") {
      const { RouteSettings, ...rest } = after.Resources[id].Properties;
      assert.deepEqual(rest, resource.Properties, `Existing CRM stage changed: ${id}`);
      assert.deepEqual(RouteSettings, {
        "POST /api/saas/identity/login-challenge": { ThrottlingBurstLimit: 2, ThrottlingRateLimit: 1 },
      });
      const { DependsOn, ...stageRest } = after.Resources[id];
      assert.deepEqual({ ...stageRest, Properties: undefined }, { ...resource, Properties: undefined });
      assert.ok(DependsOn?.length, "Stage with RouteSettings must depend on its routes");
      continue;
    }
    assert.deepEqual(after.Resources[id], resource, `Existing CRM resource changed: ${id}`);
  }
  const resources = Object.values(after.Resources) as any[],
    newResources = Object.entries(after.Resources)
      .filter(([id]) => !before.Resources[id])
      .map(([, value]) => value as any);
  assert.equal(newResources.filter((value) => value.Type === "AWS::Lambda::Function").length, 2);
  assert.deepEqual(
    newResources
      .filter((value) => value.Type === "AWS::IAM::Role")
      .map((value) => value.Properties.RoleName)
      .sort(),
    ["prospectus-accounts-directory-runtime", "prospectus-central-accounts-runtime"],
  );
  assert.equal(newResources.filter((value) => value.Type === "AWS::ApiGateway::Account").length, 0);
  assert.equal(newResources.filter((value) => value.Type === "AWS::ApiGateway::RestApi").length, 1);
  assert.equal(
    newResources.filter(
      (value) =>
        value.Type === "AWS::DynamoDB::Table" ||
        value.Type === "AWS::S3::Bucket" ||
        value.Type === "AWS::Cognito::UserPool" ||
        value.Type === "AWS::Cognito::UserPoolClient",
    ).length,
    0,
  );
  const routes = newResources.filter((value) => value.Type === "AWS::ApiGatewayV2::Route");
  assert.equal(routes.length, 3);
  assert.ok(routes.every((route) => route.Properties.RouteKey.includes("/api/saas/")));
  const publicRoutes = routes.filter((route) => route.Properties.AuthorizationType !== "JWT");
  assert.deepEqual(
    publicRoutes.map((route) => [route.Properties.RouteKey, route.Properties.AuthorizationType]),
    [["POST /api/saas/identity/login-challenge", "NONE"]],
  );
  assert.equal(routes.filter((route) => route.Properties.AuthorizationType === "JWT").length, 2);
  const policies = newResources
    .filter((value) => value.Type === "AWS::IAM::Policy")
    .flatMap((value) => value.Properties.PolicyDocument.Statement);
  assert.ok(!policies.some((value) => JSON.stringify(value.Action).includes("dynamodb")));
  assert.ok(!policies.some((value) => JSON.stringify(value.Action).includes("cognito-idp")));
  assert.ok(!policies.some((value) => JSON.stringify(value.Action).includes("s3:Delete")));
  assert.ok(!JSON.stringify(newResources).includes("test-invoke-stage"));
  const logWrites = policies.filter((value) => JSON.stringify(value.Action).includes("logs:PutLogEvents"));
  assert.equal(logWrites.length, 2);
  assert.ok(logWrites.every((value) => value.Resource["Fn::GetAtt"]?.[1] === "Arn"));
  const invoke = policies.filter((value) =>
    (Array.isArray(value.Action) ? value.Action : [value.Action]).includes("execute-api:Invoke"),
  );
  assert.equal(invoke.length, 1);
  const invokeText = JSON.stringify(invoke);
  assert.ok(invokeText.includes("account-directory"));
  assert.ok(!invokeText.includes("account-directory*"));
  assert.equal(invoke[0].Resource.length, 4);
  assert.ok(invokeText.includes("identities/google/resolve"));
  assert.ok(!invokeText.includes("/v1/accounts"));
  assert.ok(JSON.stringify(newResources).includes("prospectus-central/identities/*"));
  const bucketListStatements = policies.filter((value) =>
    (Array.isArray(value.Action) ? value.Action : [value.Action]).includes("s3:ListBucket"),
  );
  assert.equal(bucketListStatements.length, 1);
  assert.deepEqual(bucketListStatements[0].Condition, {
    StringLike: {
      "s3:prefix": [
        "prospectus-central/identities/*",
        "prospectus-central/accounts/*",
        "_virtuus/prospectus-central/identities/*",
        "_virtuus/prospectus-central/accounts/*",
      ],
    },
  });
  assert.equal(resources.filter((value) => value.Type === "AWS::Cognito::UserPoolClient").length, 1);
});

test("approved console client stage adds only a dedicated public Google client and leaves directory policy unchanged", () => {
  const before = template(true),
    after = template(true, true);
  for (const [id, resource] of Object.entries(before.Resources))
    assert.deepEqual(
      after.Resources[id],
      resource,
      `Existing resource changed during client-only stage: ${id}`,
    );
  const added = Object.entries(after.Resources)
    .filter(([id]) => !before.Resources[id])
    .map(([, resource]) => resource as any);
  assert.equal(added.length, 1);
  assert.equal(added[0].Type, "AWS::Cognito::UserPoolClient");
  const client = added[0].Properties;
  assert.equal(client.GenerateSecret, false);
  assert.deepEqual(client.SupportedIdentityProviders, ["Google"]);
  assert.deepEqual(client.AllowedOAuthFlows, ["code"]);
  assert.deepEqual(client.AllowedOAuthScopes, ["openid", "email", "profile"]);
  assert.deepEqual(client.CallbackURLs, ["https://lab.cyclotron.anth.us/auth/callback"]);
  assert.deepEqual(client.LogoutURLs, ["https://lab.cyclotron.anth.us/"]);
  assert.equal(client.EnableTokenRevocation, true);
  assert.ok(
    !client.ExplicitAuthFlows ||
      client.ExplicitAuthFlows.every((flow: string) => flow === "ALLOW_REFRESH_TOKEN_AUTH"),
  );
  assert.ok(!JSON.stringify(after.Resources).includes("cyclotron-console-worker-runtime"));
});

test("verified console pair preserves directory and storage grants while allowing only exact console routes", () => {
  const before = template(true, true),
    after = template(true, true, true);
  const values = Object.values(after.Resources) as any[];
  for (const [id, resource] of Object.entries(before.Resources) as [string, any][]) {
    if (
      [
        "AWS::IAM::Role",
        "AWS::IAM::Policy",
        "AWS::Cognito::UserPoolClient",
        "AWS::S3::Bucket",
        "AWS::DynamoDB::Table",
      ].includes(resource.Type)
    )
      assert.deepEqual(after.Resources[id], resource, `Unrelated grants or resource changed: ${id}`);
  }
  const central = values.find(
    (value) =>
      value.Type === "AWS::Lambda::Function" &&
      value.Properties.FunctionName === "prospectus-central-accounts",
  );
  function resolve(value: any): any {
    if (typeof value !== "object" || value === null) return value;
    if (value.Ref) return value.Ref.includes("CyclotronConsoleBrowser") ? "consoleclient" : "syntheticclient";
    if (value["Fn::GetAtt"]) return "arn:aws:iam::712236451410:role/prospectus-accounts-directory-runtime";
    if (value["Fn::Join"]) return value["Fn::Join"][1].map(resolve).join(value["Fn::Join"][0]);
    throw new Error(`Unexpected template token ${JSON.stringify(value)}`);
  }
  const registry = JSON.parse(resolve(central.Properties.Environment.Variables.PROSPECTUS_PRODUCTS));
  const oldCentral = (Object.values(before.Resources) as any[]).find(
    (value) =>
      value.Type === "AWS::Lambda::Function" &&
      value.Properties.FunctionName === "prospectus-central-accounts",
  );
  assert.deepEqual(
    registry[0],
    JSON.parse(resolve(oldCentral.Properties.Environment.Variables.PROSPECTUS_PRODUCTS))[0],
  );
  assert.equal(registry.length, 2);
  const consoleProduct = registry[1];
  const bff = "arn:aws:iam::682849160744:role/cyclotron-console-bff-runtime",
    worker = "arn:aws:iam::682849160744:role/cyclotron-console-worker-runtime";
  assert.deepEqual(consoleProduct.clientIds, ["consoleclient"]);
  assert.notDeepEqual(consoleProduct.clientIds, registry[0].clientIds);
  assert.equal(consoleProduct.product, "cyclotron");
  assert.equal(consoleProduct.roleArn, bff);
  assert.deepEqual(consoleProduct.capabilities, ["console:read", "console:write"]);
  assert.equal(consoleProduct.accountDirectory, undefined);
  assert.deepEqual(consoleProduct.executionDelegation, {
    roleArn: worker,
    enrollmentRoleArn: bff,
    issuer: consoleProduct.issuer,
    clientId: consoleProduct.clientIds[0],
    enrollmentPolicyRevision: consoleProduct.googleFederation.reviewedPolicyId,
    reviewedPolicyId: "cyclotron-execution-pair-v1-20261015",
  });
  assert.equal(
    consoleProduct.googleFederation.reviewedPolicyId,
    "cyclotron-google-only-unlinked-v1-20261015",
  );
  const policy = values.find((value) => value.Type === "AWS::ApiGateway::RestApi").Properties.Policy
    .Statement;
  const allow = (arn: string) =>
    policy.find((statement: any) => statement.Effect === "Allow" && statement.Principal.AWS === arn);
  assert.deepEqual(allow(bff).Resource, [
    "execute-api:/api/GET/v1/identities/me",
    "execute-api:/api/POST/v1/identities/google/challenge",
    "execute-api:/api/POST/v1/identities/google/resolve",
    "execute-api:/api/GET/v1/accounts",
    "execute-api:/api/POST/v1/accounts",
    "execute-api:/api/GET/v1/accounts/*",
    "execute-api:/api/POST/v1/accounts/*/authorize",
  ]);
  assert.deepEqual(allow(worker).Resource, [
    "execute-api:/api/GET/v1/identities/me",
    "execute-api:/api/POST/v1/accounts/*/authorize",
  ]);
  const denied = policy.find((statement: any) => statement.Effect === "Deny").Condition.ArnNotEquals[
    "aws:PrincipalArn"
  ];
  assert.equal(denied.length, 3);
  assert.deepEqual(denied.slice(1), [bff, worker]);
  const deploymentIds = (template: any) =>
    Object.entries(template.Resources)
      .filter(([, value]: any) => value.Type === "AWS::ApiGateway::Deployment")
      .map(([id]) => id);
  assert.notDeepEqual(
    deploymentIds(after),
    deploymentIds(before),
    "Policy rollout must republish the existing API stage",
  );
});

const syntheticPapyrusSites = (count: number) =>
  papyrusSiteRegistrations(
    Array.from({ length: count }, (_, index) => ({
      product: `papyrus-synthetic-${index}`,
      roleArn: `arn:aws:iam::682849160744:role/synthetic-papyrus-site-${index}-runtime`,
      issuer: `https://cognito-idp.us-east-1.amazonaws.com/us-east-1_SyntheticSite${index}`,
      clientId: `syntheticsite${index}`,
      federationReviewId: `synthetic-google-only-${index}`,
      siteReviewId: `synthetic-site-review-${index}`,
    })),
  );

test("reviewed Papyrus sites may call only read and authorize routes and leave every other grant unchanged", () => {
  const before = template(true, true, true),
    after = template(true, true, true, syntheticPapyrusSites(2));
  for (const [id, resource] of Object.entries(before.Resources) as [string, any][]) {
    if (
      [
        "AWS::IAM::Role",
        "AWS::IAM::Policy",
        "AWS::Cognito::UserPoolClient",
        "AWS::S3::Bucket",
        "AWS::DynamoDB::Table",
        "AWS::Lambda::Function",
      ].includes(resource.Type)
    )
      assert.deepEqual(after.Resources[id], resource, `Unrelated grants or resource changed: ${id}`);
  }
  const policy = (Object.values(after.Resources) as any[]).find(
    (value) => value.Type === "AWS::ApiGateway::RestApi",
  ).Properties.Policy.Statement;
  const sitesStatement = policy.find(
    (statement: any) =>
      statement.Effect === "Allow" &&
      JSON.stringify(statement.Principal).includes("synthetic-papyrus-site-0-runtime"),
  );
  assert.deepEqual(sitesStatement.Principal.AWS, [
    "arn:aws:iam::682849160744:role/synthetic-papyrus-site-0-runtime",
    "arn:aws:iam::682849160744:role/synthetic-papyrus-site-1-runtime",
  ]);
  assert.ok(sitesStatement.Resource.includes("execute-api:/api/GET/v1/account-directory"));
  assert.ok(
    !sitesStatement.Resource.includes("execute-api:/api/POST/v1/accounts") &&
      !JSON.stringify(sitesStatement.Resource).includes("memberships"),
  );
  const denied = policy.find((statement: any) => statement.Effect === "Deny").Condition.ArnNotEquals[
    "aws:PrincipalArn"
  ];
  assert.deepEqual(denied.slice(-2), sitesStatement.Principal.AWS);
  const deploymentIds = (template: any) =>
    Object.entries(template.Resources)
      .filter(([, value]: any) => value.Type === "AWS::ApiGateway::Deployment")
      .map(([id]) => id);
  assert.notDeepEqual(
    deploymentIds(after),
    deploymentIds(before),
    "Site rollout must republish the existing API stage",
  );
});

test("the largest reviewed Papyrus site registry keeps the deployed API access policy within the API Gateway size limit", () => {
  const after = template(true, true, true, syntheticPapyrusSites(40));
  const policy = (Object.values(after.Resources) as any[]).find(
    (value) => value.Type === "AWS::ApiGateway::RestApi",
  ).Properties.Policy;
  const deployedPolicyText = JSON.stringify(policy).replaceAll(
    "execute-api:/",
    "arn:aws:execute-api:us-east-1:712236451410:abcdefghij/",
  );
  assert.ok(
    deployedPolicyText.length < 8192,
    `Deployed API resource policy would be ${deployedPolicyText.length} bytes`,
  );
  assert.throws(() => syntheticPapyrusSites(41));
});

test("the login challenge MAC key is an HMAC_256 generate-verify key and only the central runtime may use it", () => {
  const after = template(true, false, false, [], { kind: "kms" }),
    before = template(false);
  const added = Object.entries(after.Resources as Record<string, any>).filter(
    ([id]) => !before.Resources[id],
  );
  const keys = added.filter(([, resource]) => resource.Type === "AWS::KMS::Key");
  assert.equal(keys.length, 1);
  const [keyId, key] = keys[0];
  assert.equal(key.Properties.KeySpec, "HMAC_256");
  assert.equal(key.Properties.KeyUsage, "GENERATE_VERIFY_MAC");
  assert.equal(key.DeletionPolicy, "Retain");
  assert.equal(key.Properties.PendingWindowInDays, 30);
  assert.equal(key.Properties.EnableKeyRotation, undefined);
  const statements = key.Properties.KeyPolicy.Statement;
  assert.equal(statements.length, 1);
  assert.equal(statements[0].Action, "kms:*");
  assert.equal(statements[0].Resource, "*");
  assert.ok(JSON.stringify(statements[0].Principal).includes(":iam::712236451410:root"));
  assert.equal(added.filter(([, resource]) => resource.Type === "AWS::KMS::Alias").length, 1);
  const keyArn = { "Fn::GetAtt": [keyId, "Arn"] };
  const policies = added.filter(([, resource]) => resource.Type === "AWS::IAM::Policy");
  const usages = policies.filter(([, resource]) =>
    JSON.stringify(resource.Properties.PolicyDocument).includes("kms:"),
  );
  assert.equal(usages.length, 1);
  const kmsStatements = usages[0][1].Properties.PolicyDocument.Statement.filter((statement: any) =>
    JSON.stringify(statement.Action).includes("kms:"),
  );
  assert.equal(kmsStatements.length, 1);
  assert.deepEqual(kmsStatements[0].Action, ["kms:GenerateMac", "kms:VerifyMac"]);
  assert.deepEqual(kmsStatements[0].Resource, keyArn);
  assert.deepEqual(kmsStatements[0].Condition, { StringEquals: { "kms:MacAlgorithm": "HMAC_SHA_256" } });
  const centralRole = added.find(
    ([, resource]) =>
      resource.Type === "AWS::IAM::Role" &&
      resource.Properties.RoleName === "prospectus-central-accounts-runtime",
  )![0];
  assert.deepEqual(usages[0][1].Properties.Roles, [{ Ref: centralRole }]);
  const central = added.find(
    ([, resource]) =>
      resource.Type === "AWS::Lambda::Function" &&
      resource.Properties.FunctionName === "prospectus-central-accounts",
  )![1];
  assert.deepEqual(central.Properties.Environment.Variables.PROSPECTUS_CHALLENGE_MAC_KEY_ARN, keyArn);
  assert.ok(!JSON.stringify(central.Properties.Environment.Variables).includes("secret"));
});

test("the parameter-store signer creates no KMS resource and grants only ssm:GetParameter on the exact parameters", () => {
  for (const [signer, names] of [
    [parameterStoreSigner, ["/prospectus/central-accounts/login-challenge-mac/v1"]],
    [
      { ...parameterStoreSigner, currentKeyId: "v2", previousKeyId: "v1" },
      [
        "/prospectus/central-accounts/login-challenge-mac/v2",
        "/prospectus/central-accounts/login-challenge-mac/v1",
      ],
    ],
  ] as const) {
    const after = template(true, false, false, [], signer),
      before = template(false);
    const added = Object.entries(after.Resources as Record<string, any>).filter(
      ([id]) => !before.Resources[id],
    );
    assert.ok(!JSON.stringify(after.Resources).includes('"AWS::KMS::'), "no KMS key or alias");
    assert.ok(!JSON.stringify(after.Resources).includes("kms:"), "no KMS permission");
    assert.ok(!JSON.stringify(after.Resources).includes("AWS::SSM::Parameter"), "no parameter is created");
    const statements = added
      .filter(([, resource]) => resource.Type === "AWS::IAM::Policy")
      .flatMap(([, resource]) => resource.Properties.PolicyDocument.Statement)
      .filter((statement: any) => JSON.stringify(statement.Action).includes("ssm:"));
    assert.equal(statements.length, 1);
    assert.deepEqual(statements[0].Action, "ssm:GetParameter");
    assert.equal(statements[0].Effect, "Allow");
    assert.equal(statements[0].Condition, undefined);
    const resources = Array.isArray(statements[0].Resource)
      ? statements[0].Resource
      : [statements[0].Resource];
    assert.deepEqual(
      resources.map((arn: any) =>
        typeof arn === "string"
          ? arn
          : arn["Fn::Join"][1].map((part: any) => (part.Ref === "AWS::Partition" ? "aws" : part)).join(""),
      ),
      names.map((name) => `arn:aws:ssm:us-east-1:712236451410:parameter${name}`),
    );
    const central = added.find(
      ([, resource]) =>
        resource.Type === "AWS::Lambda::Function" &&
        resource.Properties.FunctionName === "prospectus-central-accounts",
    )![1];
    const environment = central.Properties.Environment.Variables;
    assert.deepEqual(JSON.parse(environment.PROSPECTUS_LOGIN_CHALLENGE_SIGNER), signer);
    assert.equal(environment.PROSPECTUS_CHALLENGE_MAC_KEY_ARN, undefined);
    assert.ok(!JSON.stringify(environment).toLowerCase().includes("secret"));
    const centralRole = added.find(
      ([, resource]) =>
        resource.Type === "AWS::IAM::Role" &&
        resource.Properties.RoleName === "prospectus-central-accounts-runtime",
    )![0];
    const policyWithSsm = added.find(
      ([, resource]) =>
        resource.Type === "AWS::IAM::Policy" &&
        JSON.stringify(resource.Properties).includes("ssm:GetParameter"),
    )![1];
    assert.deepEqual(policyWithSsm.Properties.Roles, [{ Ref: centralRole }]);
  }
});

/** Every stage RouteSettings key must name a Route in the same API that the Stage depends on. */
function assertStageRoutesOrdered(synth: any): number {
  const resources = synth.Resources as Record<string, any>;
  let checked = 0;
  for (const [stageId, stage] of Object.entries(resources)) {
    if (stage.Type !== "AWS::ApiGatewayV2::Stage") continue;
    const apiRef = stage.Properties.ApiId?.Ref;
    const dependsOn: string[] = [stage.DependsOn ?? []].flat();
    for (const key of Object.keys(stage.Properties.RouteSettings ?? {})) {
      const match = Object.entries(resources).find(
        ([, route]) =>
          route.Type === "AWS::ApiGatewayV2::Route" &&
          route.Properties.RouteKey === key &&
          route.Properties.ApiId?.Ref === apiRef,
      );
      assert.ok(match, `${stageId} RouteSettings key "${key}" has no Route in the same API`);
      assert.ok(
        dependsOn.includes(match[0]),
        `${stageId} must DependOn Route ${match[0]} for RouteSettings "${key}" (CloudFormation updates the stage before creating the route otherwise)`,
      );
      checked++;
    }
  }
  return checked;
}
test("API stage depends on every route its RouteSettings reference", () => {
  const synth = template(true);
  assert.ok(assertStageRoutesOrdered(synth) >= 1);
  const loginChallenge = Object.entries(synth.Resources as Record<string, any>).find(
    ([, r]) =>
      r.Type === "AWS::ApiGatewayV2::Route" &&
      r.Properties.RouteKey === "POST /api/saas/identity/login-challenge",
  );
  const stage = Object.values(synth.Resources as Record<string, any>).find(
    (r) => r.Type === "AWS::ApiGatewayV2::Stage",
  );
  assert.ok(loginChallenge && stage.DependsOn.includes(loginChallenge[0]));
});
test("the ordering check fails when a route setting lacks its dependency", () => {
  const synth = JSON.parse(JSON.stringify(template(true)));
  const stage: any = Object.values(synth.Resources).find((r: any) => r.Type === "AWS::ApiGatewayV2::Stage");
  delete stage.DependsOn;
  assert.throws(() => assertStageRoutesOrdered(synth), /must DependOn/);
});

test("routes without an authorizer carry no authorization scopes", () => {
  const synth = template(true);
  assert.deepEqual(unscopableRoutesWithScopes(synth), []);
  const routes = Object.values(synth.Resources as Record<string, any>).filter(
    (r: any) => r.Type === "AWS::ApiGatewayV2::Route",
  );
  const challenge = routes.find(
    (r: any) => r.Properties.RouteKey === "POST /api/saas/identity/login-challenge",
  );
  assert.equal(challenge.Properties.AuthorizationType, "NONE");
  assert.equal(challenge.Properties.AuthorizerId, undefined);
  assert.ok(!(challenge.Properties.AuthorizationScopes ?? []).length);
  const member = routes.find((r: any) => r.Properties.RouteKey === "GET /api/{proxy+}");
  assert.equal(member.Properties.AuthorizationType, "JWT");
  assert.deepEqual(member.Properties.AuthorizationScopes, ["openid"]);
});
test("the scope check fails for a NONE route that inherits scopes", () => {
  const synth = JSON.parse(JSON.stringify(template(true)));
  const route: any = Object.values(synth.Resources).find(
    (r: any) => r.Type === "AWS::ApiGatewayV2::Route" && r.Properties.AuthorizationType === "NONE",
  );
  route.Properties.AuthorizationScopes = ["openid"];
  assert.equal(unscopableRoutesWithScopes(synth).length, 1);
});
