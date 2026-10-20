import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as logs from "aws-cdk-lib/aws-logs";
import * as gateway from "aws-cdk-lib/aws-apigateway";
import type * as cognito from "aws-cdk-lib/aws-cognito";
import type * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import type { ProductRegistration } from "../../accounts/auth";
import type { LoginChallengeSignerConfiguration } from "../../accounts/challenge-signer";
import { papyrusSiteRoutes } from "../../accounts/papyrus-sites";
export interface AccountsPlaneOptions {
  code: lambda.Code;
  bffCode: lambda.Code;
  googlePolicyReviewId: string;
  consoleClientEnabled?: boolean;
  consolePairEnabled?: boolean;
  consoleClient?: cognito.IUserPoolClient;
  consoleFederationReviewId?: string;
  consolePairReviewId?: string;
  papyrusSites?: readonly ProductRegistration[];
  loginChallengeSigner: LoginChallengeSignerConfiguration;
}
/** Additive resources only. No CRM role, client, namespace or authorizer edits. */
export class AccountsPlane extends Construct {
  readonly bff: lambda.Function;
  readonly endpoint: string;
  constructor(
    scope: Construct,
    id: string,
    bucket: s3.IBucket,
    pool: cognito.IUserPool,
    client: cognito.IUserPoolClient,
    options: AccountsPlaneOptions,
  ) {
    super(scope, id);
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(options.googlePolicyReviewId))
      throw new Error("Explicit reviewed Google-only policy ID required.");
    const runtime = new iam.Role(this, "Runtime", {
      roleName: "prospectus-central-accounts-runtime",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    const bffRole = new iam.Role(this, "BffRuntime", {
      roleName: "prospectus-accounts-directory-runtime",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    const prefixes = [
      "prospectus-central/identities/*",
      "prospectus-central/accounts/*",
      "_virtuus/prospectus-central/identities/*",
      "_virtuus/prospectus-central/accounts/*",
    ];
    runtime.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:PutObject"],
        resources: prefixes.map((prefix) => bucket.arnForObjects(prefix)),
      }),
    );
    runtime.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:ListBucket"],
        resources: [bucket.bucketArn],
        conditions: { StringLike: { "s3:prefix": prefixes } },
      }),
    );
    const stack = cdk.Stack.of(this);
    const registration = {
      product: "prospectus-directory",
      roleArn: bffRole.roleArn,
      issuer: `https://cognito-idp.${stack.region}.amazonaws.com/${pool.userPoolId}`,
      clientIds: [client.userPoolClientId],
      capabilities: ["console:read", "members:read"],
      enabled: true,
      accountDirectory: true,
      googleFederation: {
        policy: "google-only-unlinked-v1",
        reviewedPolicyId: options.googlePolicyReviewId,
        clientId: client.userPoolClientId,
      },
    };
    const products: unknown[] = [registration];
    const consoleBff = "arn:aws:iam::682849160744:role/cyclotron-console-bff-runtime";
    const consoleWorker = "arn:aws:iam::682849160744:role/cyclotron-console-worker-runtime";
    if (options.consolePairEnabled) {
      if (
        !options.consoleClient ||
        options.consoleFederationReviewId !== "cyclotron-google-only-unlinked-v1-20261015" ||
        options.consolePairReviewId !== "cyclotron-execution-pair-v1-20261015"
      )
        throw new Error("Exact approved console client and role-pair review required.");
      const issuer = registration.issuer,
        clientId = options.consoleClient.userPoolClientId;
      products.push({
        product: "cyclotron",
        roleArn: consoleBff,
        issuer,
        clientIds: [clientId],
        capabilities: ["console:read", "console:write"],
        enabled: true,
        googleFederation: {
          policy: "google-only-unlinked-v1",
          reviewedPolicyId: options.consoleFederationReviewId,
          clientId,
        },
        executionDelegation: {
          roleArn: consoleWorker,
          enrollmentRoleArn: consoleBff,
          issuer,
          clientId,
          enrollmentPolicyRevision: options.consoleFederationReviewId,
          reviewedPolicyId: options.consolePairReviewId,
        },
      });
    }
    const signer = options.loginChallengeSigner;
    let challengeSignerEnvironment: Record<string, string>;
    if (signer.kind === "kms") {
      const challengeMacKey = new kms.Key(this, "ChallengeMacKey", {
        alias: "alias/prospectus-central-login-challenge-mac",
        description:
          "HMAC_256 key that signs stateless pre-sign-in login challenges for the central Accounts service.",
        keySpec: kms.KeySpec.HMAC_256,
        keyUsage: kms.KeyUsage.GENERATE_VERIFY_MAC,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        pendingWindow: cdk.Duration.days(30),
      });
      runtime.addToPolicy(
        new iam.PolicyStatement({
          actions: ["kms:GenerateMac", "kms:VerifyMac"],
          resources: [challengeMacKey.keyArn],
          conditions: { StringEquals: { "kms:MacAlgorithm": "HMAC_SHA_256" } },
        }),
      );
      challengeSignerEnvironment = {
        PROSPECTUS_LOGIN_CHALLENGE_SIGNER: JSON.stringify(signer),
        PROSPECTUS_CHALLENGE_MAC_KEY_ARN: challengeMacKey.keyArn,
      };
    } else {
      runtime.addToPolicy(
        new iam.PolicyStatement({
          actions: ["ssm:GetParameter"],
          resources: [signer.currentKeyId, ...(signer.previousKeyId ? [signer.previousKeyId] : [])].map(
            (keyId) =>
              `arn:${stack.partition}:ssm:${stack.region}:${stack.account}:parameter${signer.parameterPrefix}${keyId}`,
          ),
        }),
      );
      challengeSignerEnvironment = { PROSPECTUS_LOGIN_CHALLENGE_SIGNER: JSON.stringify(signer) };
    }
    const centralLogs = new logs.LogGroup(this, "Logs", {
      logGroupName: "/aws/lambda/prospectus-central-accounts",
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const bffLogs = new logs.LogGroup(this, "BffLogs", {
      logGroupName: "/aws/lambda/prospectus-accounts-directory-bff",
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    for (const [role, group] of [
      [runtime, centralLogs],
      [bffRole, bffLogs],
    ] as const)
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
          resources: [group.logGroupArn],
        }),
      );
    const central = new lambda.Function(this, "Handler", {
      functionName: "prospectus-central-accounts",
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.X86_64,
      handler: "index.handler",
      code: options.code,
      role: runtime,
      logGroup: centralLogs,
      memorySize: 512,
      timeout: cdk.Duration.seconds(28),
      environment: {
        PROSPECTUS_CANONICAL_ACCOUNTS: "enabled",
        PROSPECTUS_ACCOUNTS_BUCKET: bucket.bucketName,
        PROSPECTUS_ACCOUNTS_OWNER: stack.account,
        ...challengeSignerEnvironment,
        PROSPECTUS_PRODUCTS: cdk.Stack.of(this).toJsonString(products),
      },
    });
    const api = new gateway.RestApi(this, "Api", {
      restApiName: "prospectus-accounts",
      cloudWatchRole: false,
      endpointTypes: [gateway.EndpointType.REGIONAL],
      deployOptions: {
        stageName: "api",
        dataTraceEnabled: false,
        loggingLevel: gateway.MethodLoggingLevel.OFF,
      },
      defaultMethodOptions: { authorizationType: gateway.AuthorizationType.IAM },
    });
    const methods = api.root.addResource("v1").addResource("{proxy+}");
    for (const method of ["GET", "POST"])
      methods.addMethod(method, new gateway.LambdaIntegration(central, { allowTestInvoke: false }), {
        authorizationType: gateway.AuthorizationType.IAM,
      });
    const invoke = [
      api.arnForExecuteApi("GET", "/v1/account-directory", "api"),
      api.arnForExecuteApi("GET", "/v1/account-directory/*", "api"),
      api.arnForExecuteApi("POST", "/v1/identities/google/challenge", "api"),
      api.arnForExecuteApi("POST", "/v1/identities/google/resolve", "api"),
      // Self-service account creation: exactly this path, never /v1/accounts/*.
      api.arnForExecuteApi("POST", "/v1/accounts", "api"),
    ];
    bffRole.addToPolicy(new iam.PolicyStatement({ actions: ["execute-api:Invoke"], resources: invoke }));
    api.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ArnPrincipal(bffRole.roleArn)],
        actions: ["execute-api:Invoke"],
        resources: [
          "execute-api:/api/GET/v1/account-directory",
          "execute-api:/api/GET/v1/account-directory/*",
          "execute-api:/api/POST/v1/identities/google/challenge",
          "execute-api:/api/POST/v1/identities/google/resolve",
          "execute-api:/api/POST/v1/accounts",
        ],
      }),
    );
    // Resource policy changes must publish to the existing API stage as well.
    api.latestDeployment?.addToLogicalId({ directoryRoutes: "organization-creation-v1" });
    if (options.consolePairEnabled) {
      const consoleBffRoutes = [
        "GET/v1/identities/me",
        "POST/v1/identities/google/challenge",
        "POST/v1/identities/google/resolve",
        "GET/v1/accounts",
        "POST/v1/accounts",
        "GET/v1/accounts/*",
        "POST/v1/accounts/*/authorize",
      ];
      const consoleWorkerRoutes = ["GET/v1/identities/me", "POST/v1/accounts/*/authorize"];
      for (const [principal, routes] of [
        [consoleBff, consoleBffRoutes],
        [consoleWorker, consoleWorkerRoutes],
      ] as const)
        api.addToResourcePolicy(
          new iam.PolicyStatement({
            principals: [new iam.ArnPrincipal(principal)],
            actions: ["execute-api:Invoke"],
            resources: routes.map((route) => `execute-api:/api/${route}`),
          }),
        );
      // Resource policy changes must publish to the existing API stage as well.
      api.latestDeployment?.addToLogicalId({
        consolePairReviewId: options.consolePairReviewId,
        consoleBff,
        consoleWorker,
      });
    }
    const papyrusSiteRoles = (options.papyrusSites ?? []).map((site) => site.roleArn);
    if (papyrusSiteRoles.length) {
      api.addToResourcePolicy(
        new iam.PolicyStatement({
          principals: papyrusSiteRoles.map((role) => new iam.ArnPrincipal(role)),
          actions: ["execute-api:Invoke"],
          resources: papyrusSiteRoutes.map((route) => `execute-api:/api/${route}`),
        }),
      );
      api.latestDeployment?.addToLogicalId({ papyrusSiteRoles });
    }
    const permittedPrincipals = [
      bffRole.roleArn,
      ...(options.consolePairEnabled ? [consoleBff, consoleWorker] : []),
      ...papyrusSiteRoles,
    ];
    api.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ["execute-api:Invoke"],
        resources: ["execute-api:/*"],
        conditions: {
          ArnNotEquals: {
            "aws:PrincipalArn": permittedPrincipals.length > 1 ? permittedPrincipals : bffRole.roleArn,
          },
        },
      }),
    );
    this.bff = new lambda.Function(this, "Bff", {
      functionName: "prospectus-accounts-directory-bff",
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.X86_64,
      handler: "index.handler",
      code: options.bffCode,
      role: bffRole,
      logGroup: bffLogs,
      memorySize: 256,
      timeout: cdk.Duration.seconds(29),
      environment: {
        PROSPECTUS_CENTRAL_ENDPOINT: api.url,
        PROSPECTUS_DIRECTORY_REGISTRATION: stack.toJsonString(registration),
      },
    });
    this.endpoint = api.url;
  }
}
