import { test } from "node:test";
import assert from "node:assert/strict";
import { App, Stack } from "aws-cdk-lib";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { Code } from "aws-cdk-lib/aws-lambda";
import { Template } from "aws-cdk-lib/assertions";
import { ProspectusBackend } from "../lib/prospectus-backend";
import { PORTAL_GOOGLE_CLIENT_ID } from "../lib/scope";
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
  anthusOne = false,
  labVerifier?: { roleArn: string; reviewId: string },
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
          ...(labVerifier ? { labVerifier } : {}),
          loginChallengeSigner,
          ...(anthusOne
            ? {
                anthusOne: {
                  googleClientId: PORTAL_GOOGLE_CLIENT_ID,
                  federationReviewId: "anthus-one-google-direct-v1-20261020",
                },
              }
            : {}),
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
  assert.equal(invoke[0].Resource.length, 5);
  assert.ok(invokeText.includes("identities/google/resolve"));
  // The only account write: POST on exactly /v1/accounts, never a wildcard or an account sub-route.
  const accountRoutes = invoke[0].Resource.map((value: any) => JSON.stringify(value)).filter(
    (value: string) => value.includes("/v1/accounts"),
  );
  assert.equal(accountRoutes.length, 1);
  assert.ok(accountRoutes[0].includes('/POST/v1/accounts"'));
  assert.ok(!invokeText.includes("/v1/accounts/"));
  assert.ok(!invokeText.includes("/v1/accounts*"));
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
  assert.deepEqual(client.CallbackURLs, [
    "https://lab.cyclotron.anth.us/auth/callback",
    "https://lab.cyclotron.anth.us/cli/callback",
  ]);
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
  const member = routes.find((r: any) => r.Properties.RouteKey === "GET /cyclotron/prospectus/api/{proxy+}");
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

test("Anthus One adds a Google-direct customer API with no Cognito pool, secret or operator route", () => {
  const before = template(true, true, true),
    after = template(true, true, true, [], parameterStoreSigner, true);
  const added = Object.entries(after.Resources)
    .filter(([id]) => !before.Resources[id])
    .map(([id, resource]) => ({ id, ...(resource as any) }));
  const changed = Object.entries(before.Resources).filter(
    ([id, resource]) => JSON.stringify(after.Resources[id]) !== JSON.stringify(resource),
  );
  assert.deepEqual(
    [...new Set(added.map((resource) => resource.Type))].sort(),
    [
      "AWS::ApiGateway::Deployment", // the central API's resource policy changed, so it republishes
      "AWS::ApiGatewayV2::Api",
      "AWS::ApiGatewayV2::Authorizer",
      "AWS::ApiGatewayV2::Integration",
      "AWS::ApiGatewayV2::Route",
      "AWS::ApiGatewayV2::Stage",
      "AWS::IAM::Policy",
      "AWS::IAM::Role",
      "AWS::Lambda::Function",
      "AWS::Lambda::Permission",
      "AWS::Logs::LogGroup",
    ],
    "No Cognito, Secrets Manager, DynamoDB, S3 or KMS resource may be added",
  );
  const text = JSON.stringify(added);
  assert.ok(!text.includes("secretsmanager"), "no secret reference");
  assert.ok(!text.includes("client_secret") && !JSON.stringify(after).includes("anthus-one/oauth/google"));
  // Existing resources change only where the central service must learn the new product and role.
  assert.deepEqual(changed.map(([, resource]) => (resource as any).Type).sort(), [
    "AWS::ApiGateway::Deployment",
    "AWS::ApiGateway::RestApi",
    "AWS::ApiGateway::Stage",
    "AWS::Lambda::Function",
  ]);
  const role = added.find((resource) => resource.Type === "AWS::IAM::Role")!;
  assert.equal(role.Properties.RoleName, "prospectus-anthus-one-bff-runtime");
  const fn = added.find((resource) => resource.Type === "AWS::Lambda::Function")!;
  assert.equal(fn.Properties.FunctionName, "prospectus-anthus-one-bff");
  assert.equal(fn.Properties.Environment.Variables.PROSPECTUS_BFF_SURFACE, "customer");
  const flatten = (value: any): string => {
    if (typeof value === "string") return value;
    if (value["Fn::Join"]) return value["Fn::Join"][1].map(flatten).join(value["Fn::Join"][0]);
    return "arn:aws:iam::712236451410:role/prospectus-anthus-one-bff-runtime";
  };
  const registration = JSON.parse(
    flatten(fn.Properties.Environment.Variables.PROSPECTUS_DIRECTORY_REGISTRATION),
  );
  assert.deepEqual(registration, {
    product: "anthus-one",
    roleArn: "arn:aws:iam::712236451410:role/prospectus-anthus-one-bff-runtime",
    issuer: "https://accounts.google.com",
    clientIds: [PORTAL_GOOGLE_CLIENT_ID],
    capabilities: ["console:read", "members:read"],
    enabled: true,
    accountDirectory: true,
    googleFederation: {
      policy: "google-direct-v1",
      reviewedPolicyId: "anthus-one-google-direct-v1-20261020",
      clientId: PORTAL_GOOGLE_CLIENT_ID,
    },
  });
  // The central service learns the same registration.
  const central = Object.values(after.Resources).find(
    (resource: any) => resource.Properties?.FunctionName === "prospectus-central-accounts",
  ) as any;
  const products = JSON.parse(
    flatten(central.Properties.Environment.Variables.PROSPECTUS_PRODUCTS).replaceAll(
      "arn:aws:iam::712236451410:role/prospectus-anthus-one-bff-runtime",
      "arn:aws:iam::712236451410:role/prospectus-anthus-one-bff-runtime",
    ),
  );
  assert.ok(products.some((product: any) => product.product === "anthus-one"));
  // API Gateway rejects a token that is not Google's for this client before the Lambda runs.
  const authorizer = added.find((resource) => resource.Type === "AWS::ApiGatewayV2::Authorizer")!;
  assert.equal(authorizer.Properties.AuthorizerType, "JWT");
  assert.deepEqual(authorizer.Properties.JwtConfiguration, {
    Audience: [PORTAL_GOOGLE_CLIENT_ID],
    Issuer: "https://accounts.google.com",
  });
  const api = added.find((resource) => resource.Type === "AWS::ApiGatewayV2::Api")!;
  assert.deepEqual(api.Properties.CorsConfiguration.AllowOrigins, ["https://one.anth.us"]);
  assert.deepEqual(api.Properties.CorsConfiguration.AllowHeaders, ["authorization", "content-type"]);
  const routes = added.filter((resource) => resource.Type === "AWS::ApiGatewayV2::Route");
  assert.deepEqual(
    routes.map((route) => [route.Properties.RouteKey, route.Properties.AuthorizationType]).sort(),
    [
      ["GET /api/saas/{proxy+}", "JWT"],
      ["POST /api/saas/identity/login-challenge", "NONE"],
      ["POST /api/saas/{proxy+}", "JWT"],
    ],
  );
  assert.ok(routes.every((route) => !route.Properties.AuthorizationScopes?.length));
  // Throttling: account creation and the public challenge are limited per route, everything else by default, and
  // the stage is only updated after every throttled route exists.
  const stage = added.find((resource) => resource.Type === "AWS::ApiGatewayV2::Stage")!;
  assert.deepEqual(stage.Properties.DefaultRouteSettings, {
    ThrottlingBurstLimit: 20,
    ThrottlingRateLimit: 10,
  });
  assert.deepEqual(stage.Properties.RouteSettings, {
    "POST /api/saas/{proxy+}": { ThrottlingBurstLimit: 5, ThrottlingRateLimit: 2 },
    "POST /api/saas/identity/login-challenge": { ThrottlingBurstLimit: 5, ThrottlingRateLimit: 2 },
  });
  const throttledRoutes = added
    .filter(
      (resource) =>
        resource.Type === "AWS::ApiGatewayV2::Route" &&
        (resource.Properties.RouteKey === "POST /api/saas/{proxy+}" ||
          resource.Properties.RouteKey === "POST /api/saas/identity/login-challenge"),
    )
    .map((resource) => resource.id);
  assert.equal(throttledRoutes.length, 2);
  for (const route of throttledRoutes) assert.ok(stage.DependsOn.includes(route), `stage waits for ${route}`);
  // The role may call only the customer routes centrally; never operator, membership or authorize paths.
  const invoke = added
    .filter((resource) => resource.Type === "AWS::IAM::Policy")
    .flatMap((resource) => resource.Properties.PolicyDocument.Statement)
    .filter((statement: any) => JSON.stringify(statement.Action).includes("execute-api:Invoke"));
  assert.equal(invoke.length, 1);
  const paths = invoke[0].Resource.map((resource: any) => JSON.stringify(resource));
  assert.equal(paths.length, 5);
  assert.ok(paths.every((path: string) => !path.includes("operator") && !path.includes("memberships")));
  assert.ok(paths.some((path: string) => path.includes('/POST/v1/accounts"')));
  assert.ok(!paths.some((path: string) => path.includes("/v1/accounts/")));
  // The central policy allows exactly that role those routes, and the catch-all deny exempts it.
  const restApi = Object.values(after.Resources).find(
    (resource: any) => resource.Type === "AWS::ApiGateway::RestApi",
  ) as any;
  const policyText = JSON.stringify(restApi.Properties.Policy);
  assert.ok(policyText.includes("AnthusOneBffRuntime"));
  assert.ok(!policyText.includes("operator"));
});

test("Anthus One is off unless activated, leaving the Accounts plane unchanged", () => {
  const without = template(true, true, true);
  assert.ok(!JSON.stringify(without).includes("anthus-one"));
});

const verifierEntry = {
  roleArn: "arn:aws:iam::682849160744:role/cyclotron-lab-verifier",
  reviewId: "cyclotron-lab-verifier-v1-20261021",
};
const apiPolicy = (built: any) =>
  (Object.values(built.Resources) as any[]).find((value) => value.Type === "AWS::ApiGateway::RestApi")
    .Properties.Policy;

test("the lab verifier role may call exactly identities/me and accounts authorize and nothing else changes", () => {
  const before = template(true, true, true, syntheticPapyrusSites(2)),
    after = template(true, true, true, syntheticPapyrusSites(2), parameterStoreSigner, false, verifierEntry);
  // No IAM role, policy, key, Lambda or any other resource is created or changed; the role lives in the Cyclotron account.
  for (const [id, resource] of Object.entries(after.Resources) as [string, any][]) {
    if (!before.Resources[id]) assert.equal(resource.Type, "AWS::ApiGateway::Deployment");
    else if (resource.Type !== "AWS::ApiGateway::RestApi" && resource.Type !== "AWS::ApiGateway::Stage")
      assert.deepEqual(resource, before.Resources[id], `Unrelated resource changed: ${id}`);
  }
  assert.equal(
    Object.values(after.Resources).filter((value: any) => value.Type === "AWS::IAM::Role").length,
    Object.values(before.Resources).filter((value: any) => value.Type === "AWS::IAM::Role").length,
  );
  const policy = apiPolicy(after).Statement,
    previous = apiPolicy(before).Statement;
  const verifierStatements = policy.filter((statement: any) =>
    JSON.stringify(statement.Principal).includes("cyclotron-lab-verifier"),
  );
  const allow = verifierStatements.filter((statement: any) => statement.Effect === "Allow");
  assert.equal(allow.length, 1);
  assert.deepEqual(allow[0].Principal, { AWS: verifierEntry.roleArn });
  assert.deepEqual(allow[0].Action, "execute-api:Invoke");
  assert.deepEqual(allow[0].Resource, [
    "execute-api:/api/GET/v1/identities/me",
    "execute-api:/api/POST/v1/accounts/*/authorize",
  ]);
  // Deny-by-default stays: the same single Deny, with the verifier as one more exempt principal.
  const denies = policy.filter((statement: any) => statement.Effect === "Deny");
  assert.equal(denies.length, 1);
  assert.deepEqual(denies[0].Condition.ArnNotEquals["aws:PrincipalArn"], [
    ...previous.find((statement: any) => statement.Effect === "Deny").Condition.ArnNotEquals[
      "aws:PrincipalArn"
    ],
    verifierEntry.roleArn,
  ]);
  // Every pre-existing statement is untouched.
  assert.deepEqual(
    policy.filter(
      (statement: any) => !verifierStatements.includes(statement) && statement.Effect === "Allow",
    ),
    previous.filter((statement: any) => statement.Effect === "Allow"),
  );
  const deploymentIds = (built: any) =>
    Object.entries(built.Resources)
      .filter(([, value]: any) => value.Type === "AWS::ApiGateway::Deployment")
      .map(([id]) => id);
  assert.notDeepEqual(
    deploymentIds(after),
    deploymentIds(before),
    "The resource policy must publish to the stage",
  );
});

test("a disabled lab verifier leaves the synthesized template byte for byte unchanged", () => {
  assert.deepEqual(
    template(true, true, true, syntheticPapyrusSites(2)),
    template(true, true, true, syntheticPapyrusSites(2), parameterStoreSigner, false, undefined),
  );
});

test("the lab verifier must be distinct from every other runtime role and have a site to verify", () => {
  assert.throws(() =>
    template(true, true, true, syntheticPapyrusSites(2), parameterStoreSigner, false, {
      ...verifierEntry,
      roleArn: "arn:aws:iam::682849160744:role/cyclotron-console-bff-runtime",
    }),
  );
  assert.throws(() =>
    template(true, true, true, syntheticPapyrusSites(2), parameterStoreSigner, false, {
      ...verifierEntry,
      roleArn: "arn:aws:iam::682849160744:role/synthetic-papyrus-site-0-runtime",
    }),
  );
  assert.throws(() => template(true, true, true, [], parameterStoreSigner, false, verifierEntry));
});

// Sites registered in the deployed account have long Amplify compute role names (about 95 characters).
const deployedLengthSites = (count: number) =>
  papyrusSiteRegistrations(
    Array.from({ length: count }, (_, index) => ({
      product: `papyrus-deployed-${index}`,
      roleArn: `arn:aws:iam::712236451410:role/amplify-app-shell-site-AmplifyComputeRoleD988057-${String(index).padStart(12, "x")}`,
      issuer: `https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Deployed${index}`,
      clientId: `deployedclient${index}`,
      federationReviewId: `deployed-google-only-${index}`,
      siteReviewId: `deployed-site-review-${index}`,
    })),
  );
const deployedPolicySize = (built: any) =>
  JSON.stringify(apiPolicy(built)).replaceAll(
    "execute-api:/",
    "arn:aws:execute-api:us-east-1:712236451410:abcdefghij/",
  ).length;

test("the lab verifier adds one small statement and twenty deployed-length sites still fit with every registration enabled", () => {
  const without = template(true, true, true, deployedLengthSites(20), parameterStoreSigner, true),
    withVerifier = template(
      true,
      true,
      true,
      deployedLengthSites(20),
      parameterStoreSigner,
      true,
      verifierEntry,
    );
  assert.ok(
    deployedPolicySize(withVerifier) - deployedPolicySize(without) < 400,
    "The verifier statement must stay small",
  );
  assert.ok(
    deployedPolicySize(withVerifier) < 8192,
    `Deployed API resource policy would be ${deployedPolicySize(withVerifier)} bytes`,
  );
});
