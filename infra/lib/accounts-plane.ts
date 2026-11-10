import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as logs from "aws-cdk-lib/aws-logs";
import * as gateway from "aws-cdk-lib/aws-apigateway";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as events from "aws-cdk-lib/aws-events";
import * as eventTargets from "aws-cdk-lib/aws-events-targets";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import type * as cognito from "aws-cdk-lib/aws-cognito";
import type * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import type { ProductRegistration } from "../../accounts/auth";
import type { LoginChallengeSignerConfiguration } from "../../accounts/challenge-signer";
import { papyrusSiteRoutes } from "../../accounts/papyrus-sites";
import { labVerifierRoutes, type LabVerifierEntry } from "../../accounts/lab-verifier";
import { babulusRoutes } from "../../accounts/babulus";
import { quotaRoutes } from "../../quota/routes";
import { billingStoragePrefixes, billingWriteRoutes } from "../../billing/paths";
import type { SiteSubjectSecretConfiguration } from "../../accounts/site-subjects";
import {
  QUOTA_RATE_TABLE_INITIALIZER_SOURCE,
  SITE_SUBJECT_SECRET_INITIALIZER_SOURCE,
} from "./site-subject-secret";
import type { RateTableConfiguration } from "../../quota/rate-table";
import { appOf } from "../../quota/costs";
import { COST_IMPORT_ROLE_NAME } from "../../quota/cost-import";
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
  /** The Cyclotron lab verifier: an IAM role in the Cyclotron account (created there, not here) that may call only
   * identities/me and accounts/{id}/authorize. The central Lambda reads the same reviewed file at runtime. */
  labVerifier?: LabVerifierEntry;
  /** The Anthus One portal: a google-direct product with its own role, Lambda and API; no Cognito pool or secret. */
  anthusOne?: { googleClientId: string; federationReviewId: string };
  loginChallengeSigner: LoginChallengeSignerConfiguration;
  /** The v1 HMAC secret behind public-reader site subjects: an SSM SecureString created once by a create-only custom
   * resource and read by the central runtime. Absent: reader sites get 503 and no site subjects exist. */
  siteSubjectSecret?: SiteSubjectSecretConfiguration;
  /** Reviewed product registrations that carry the `quota` flag. Each is registered with the central service and its
   * role may invoke only the three quota routes. Absent: no product can reserve quota. */
  quotaProducts?: readonly ProductRegistration[];
  /** The Babulus product (see accounts/babulus.ts): a Google-only Cognito product with the quota flag. Its role gets
   * the identity and account routes plus the five quota routes. Absent: Babulus is not registered. */
  babulus?: ProductRegistration;
  /** The private quota rate table: an SSM SecureString created once with a placeholder, whose real value operators set
   * outside Git. Absent: every quota call is refused as unavailable. */
  quotaRateTable?: RateTableConfiguration;
  /** `ledger.enabled` in billing/deployment.json. True adds the billing S3 prefixes to the central runtime role and
   * the twelve operator write routes to the staff BFF role and the API access policy. Absent or false: the synthesized
   * output is exactly what it was before billing existed. */
  billingLedger?: boolean;
  /** `usageQueues` in accounts/deployment.json (docs/COST_ACCOUNTING.md). True creates one usage queue and dead-letter
   * queue per registered cost-accounted product, each sendable only by that product's roles, an alarm per
   * dead-letter queue, receive and delete for the central runtime, and a once-a-minute drain schedule. Absent or
   * false: the synthesized output is exactly what it was before cost accounting. */
  usageQueues?: boolean;
  /** `costImport` in accounts/deployment.json (docs/COST_ACCOUNTING.md). True lets the central runtime read the
   * organization and assume `prospectus-cost-import` in the Organizations management account (created by
   * infra/lib/cost-management.ts), and runs the Cost Explorer import daily. Absent or false: the synthesized output
   * is exactly what it was before. */
  costImport?: boolean;
}
/** Additive resources only. No CRM role, client, namespace or authorizer edits. */
export class AccountsPlane extends Construct {
  readonly bff: lambda.Function;
  /** The Anthus One customer BFF, when the portal is activated. */
  readonly portalBff?: lambda.Function;
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
      // Quota is its own Virtuus project: allowances and a journal, apart from accounts and billing.
      "prospectus-central/quota/*",
      "_virtuus/prospectus-central/quota/*",
      // Billing is its own Virtuus project. Only while billing/deployment.json enables the ledger.
      ...(options.billingLedger ? billingStoragePrefixes : []),
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
    // Routes a customer BFF role may invoke centrally. Central still refuses operator reads for this product.
    const customerRoutes: ReadonlyArray<readonly [string, string]> = [
      ["GET", "/v1/account-directory"],
      ["GET", "/v1/account-directory/*"],
      ["POST", "/v1/identities/google/challenge"],
      ["POST", "/v1/identities/google/resolve"],
      // Self-service account creation: exactly this path, never /v1/accounts/*.
      ["POST", "/v1/accounts"],
    ];
    const portalRole = options.anthusOne
      ? new iam.Role(this, "AnthusOneBffRuntime", {
          roleName: "prospectus-anthus-one-bff-runtime",
          assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
        })
      : undefined;
    const portalRegistration = options.anthusOne && {
      product: "anthus-one",
      roleArn: portalRole!.roleArn,
      issuer: "https://accounts.google.com",
      clientIds: [options.anthusOne.googleClientId],
      capabilities: ["console:read", "members:read"],
      enabled: true,
      accountDirectory: true,
      googleFederation: {
        policy: "google-direct-v1",
        reviewedPolicyId: options.anthusOne.federationReviewId,
        clientId: options.anthusOne.googleClientId,
      },
    };
    if (portalRegistration) products.push(portalRegistration);
    const quotaProducts = options.quotaProducts ?? [];
    if (quotaProducts.some((product) => product.quota !== true))
      throw new Error("Quota products must carry the quota flag.");
    products.push(...quotaProducts);
    const babulus = options.babulus;
    if (babulus) {
      if (babulus.quota !== true) throw new Error("Quota products must carry the quota flag.");
      products.push(babulus);
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
    const siteSubject = options.siteSubjectSecret;
    let siteSubjectSecretResource: cdk.CustomResource | undefined;
    if (siteSubject) {
      if (
        !/^\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*\/v1$/.test(siteSubject.parameterName) ||
        siteSubject.version !== "v1"
      )
        throw new Error("The site subject secret must be a reviewed v1 parameter.");
      const parameterArn = `arn:${stack.partition}:ssm:${stack.region}:${stack.account}:parameter${siteSubject.parameterName}`;
      runtime.addToPolicy(
        new iam.PolicyStatement({ actions: ["ssm:GetParameter"], resources: [parameterArn] }),
      );
      // Create-only: the initializer may put this one parameter and never overwrite it.
      const initializerRole = new iam.Role(this, "SiteSubjectSecretInitializerRuntime", {
        roleName: "prospectus-site-subject-secret-init",
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      });
      initializerRole.addToPolicy(
        new iam.PolicyStatement({ actions: ["ssm:PutParameter"], resources: [parameterArn] }),
      );
      initializerRole.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.DENY,
          actions: ["ssm:PutParameter"],
          resources: [parameterArn],
          conditions: { StringEquals: { "ssm:Overwrite": "true" } },
        }),
      );
      const initializerLogs = new logs.LogGroup(this, "SiteSubjectSecretInitializerLogs", {
        logGroupName: "/aws/lambda/prospectus-site-subject-secret-init",
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });
      initializerRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
          resources: [initializerLogs.logGroupArn],
        }),
      );
      const initializer = new lambda.Function(this, "SiteSubjectSecretInitializer", {
        functionName: "prospectus-site-subject-secret-init",
        description:
          "Create-only: generates the site subject secret once; never overwrites, logs or returns it.",
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.X86_64,
        handler: "index.handler",
        code: lambda.Code.fromInline(SITE_SUBJECT_SECRET_INITIALIZER_SOURCE),
        role: initializerRole,
        logGroup: initializerLogs,
        memorySize: 128,
        timeout: cdk.Duration.seconds(60),
      });
      siteSubjectSecretResource = new cdk.CustomResource(this, "SiteSubjectSecret", {
        serviceToken: initializer.functionArn,
        resourceType: "Custom::ProspectusSiteSubjectSecret",
        properties: { ParameterName: siteSubject.parameterName },
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });
    }
    const rateTable = options.quotaRateTable;
    let rateTableResource: cdk.CustomResource | undefined;
    if (rateTable) {
      if (
        !/^\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*\/v1$/.test(rateTable.parameterName) ||
        rateTable.version !== "v1"
      )
        throw new Error("The quota rate table must be a reviewed v1 parameter.");
      const parameterArn = `arn:${stack.partition}:ssm:${stack.region}:${stack.account}:parameter${rateTable.parameterName}`;
      runtime.addToPolicy(
        new iam.PolicyStatement({ actions: ["ssm:GetParameter"], resources: [parameterArn] }),
      );
      // Create-only: the initializer may put this one parameter and never overwrite it. Operators set the value.
      const rateRole = new iam.Role(this, "QuotaRateTableInitializerRuntime", {
        roleName: "prospectus-quota-rate-table-init",
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      });
      rateRole.addToPolicy(
        new iam.PolicyStatement({ actions: ["ssm:PutParameter"], resources: [parameterArn] }),
      );
      rateRole.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.DENY,
          actions: ["ssm:PutParameter"],
          resources: [parameterArn],
          conditions: { StringEquals: { "ssm:Overwrite": "true" } },
        }),
      );
      const rateLogs = new logs.LogGroup(this, "QuotaRateTableInitializerLogs", {
        logGroupName: "/aws/lambda/prospectus-quota-rate-table-init",
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });
      rateRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
          resources: [rateLogs.logGroupArn],
        }),
      );
      const rateInitializer = new lambda.Function(this, "QuotaRateTableInitializer", {
        functionName: "prospectus-quota-rate-table-init",
        description:
          "Create-only: creates the quota rate table parameter once with a placeholder; never overwrites it.",
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.X86_64,
        handler: "index.handler",
        code: lambda.Code.fromInline(QUOTA_RATE_TABLE_INITIALIZER_SOURCE),
        role: rateRole,
        logGroup: rateLogs,
        memorySize: 128,
        timeout: cdk.Duration.seconds(60),
      });
      rateTableResource = new cdk.CustomResource(this, "QuotaRateTable", {
        serviceToken: rateInitializer.functionArn,
        resourceType: "Custom::ProspectusQuotaRateTable",
        properties: { ParameterName: rateTable.parameterName },
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });
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
        ...(siteSubject ? { PROSPECTUS_SITE_SUBJECT_SECRET: JSON.stringify(siteSubject) } : {}),
        ...(rateTable ? { PROSPECTUS_QUOTA_RATE_TABLE: JSON.stringify(rateTable) } : {}),
        PROSPECTUS_PRODUCTS: cdk.Stack.of(this).toJsonString(products),
      },
    });
    if (options.usageQueues) {
      const queueUrls: Record<string, string> = {};
      const queueArns: string[] = [];
      // Papyrus sites are not in PROSPECTUS_PRODUCTS (the Lambda reads the bundled registry), so take both.
      for (const entry of [...(products as ProductRegistration[]), ...(options.papyrusSites ?? [])]) {
        if (!appOf(entry.product) || entry.audience === "public-reader") continue;
        if (entry.product.length > 59) throw new Error(`Usage queue name too long for ${entry.product}.`);
        const senders = [
          entry.roleArn,
          entry.quotaCaller?.roleArn,
          (entry as { executionDelegation?: { roleArn?: string } }).executionDelegation?.roleArn,
        ].filter((arn): arn is string => typeof arn === "string");
        const id = entry.product.replace(/[^A-Za-z0-9]/g, "");
        const deadLetters = new sqs.Queue(this, `UsageDeadLetters${id}`, {
          queueName: `prospectus-usage-${entry.product}-dlq`,
          retentionPeriod: cdk.Duration.days(14),
          encryption: sqs.QueueEncryption.SQS_MANAGED,
          enforceSSL: true,
        });
        const queue = new sqs.Queue(this, `Usage${id}`, {
          queueName: `prospectus-usage-${entry.product}`,
          retentionPeriod: cdk.Duration.days(14),
          visibilityTimeout: cdk.Duration.minutes(5),
          encryption: sqs.QueueEncryption.SQS_MANAGED,
          enforceSSL: true,
          deadLetterQueue: { queue: deadLetters, maxReceiveCount: 10 },
        });
        // Exactly this product's roles may send; the drain takes the product from the queue, never the message.
        queue.addToResourcePolicy(
          new iam.PolicyStatement({
            actions: ["sqs:SendMessage"],
            principals: senders.map((arn) => new iam.ArnPrincipal(arn)),
            resources: [queue.queueArn],
          }),
        );
        // So are the product's other roles, by the cost tags its own infrastructure puts on every resource: any role
        // in the product's AWS account tagged with its app (and, for a Papyrus site, its deployment). Nothing is
        // registered by hand, and a backend rebuilt with new role names keeps sending.
        const senderAccounts = [
          ...new Set(senders.map((arn) => arn.split(":")[4]).filter((id) => /^\d{12}$/.test(id))),
        ];
        const deployment = entry.product.startsWith("papyrus-")
          ? entry.product.slice("papyrus-".length)
          : undefined;
        if (senderAccounts.length)
          queue.addToResourcePolicy(
            new iam.PolicyStatement({
              actions: ["sqs:SendMessage"],
              principals: senderAccounts.map((id) => new iam.AccountPrincipal(id)),
              resources: [queue.queueArn],
              conditions: {
                StringEquals: {
                  "aws:PrincipalTag/anthus:app": appOf(entry.product)!,
                  ...(deployment ? { "aws:PrincipalTag/anthus:deployment": deployment } : {}),
                },
              },
            }),
          );
        new cloudwatch.Alarm(this, `UsageDeadLetterAlarm${id}`, {
          alarmName: `prospectus-usage-${entry.product}-dead-letters`,
          metric: deadLetters.metricApproximateNumberOfMessagesVisible({
            period: cdk.Duration.minutes(5),
            statistic: "Maximum",
          }),
          threshold: 1,
          evaluationPeriods: 1,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
        queueUrls[entry.product] = queue.queueUrl;
        queueArns.push(queue.queueArn);
      }
      if (queueArns.length) {
        runtime.addToPolicy(
          new iam.PolicyStatement({
            actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility"],
            resources: queueArns,
          }),
        );
        central.addEnvironment("PROSPECTUS_USAGE_QUEUES", stack.toJsonString(queueUrls));
        new events.Rule(this, "UsageDrainSchedule", {
          ruleName: "prospectus-usage-drain",
          description: "Drains every product's usage queue into the cost ledger once a minute.",
          schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
          targets: [
            new eventTargets.LambdaFunction(central, {
              event: events.RuleTargetInput.fromObject({ prospectusTask: "usage-drain" }),
              retryAttempts: 0,
            }),
          ],
        });
      }
    }
    if (options.costImport) {
      runtime.addToPolicy(
        new iam.PolicyStatement({ actions: ["organizations:DescribeOrganization"], resources: ["*"] }),
      );
      // The management account is read at run time; its role's trust policy names this runtime role exactly.
      runtime.addToPolicy(
        new iam.PolicyStatement({
          actions: ["sts:AssumeRole"],
          resources: [`arn:${cdk.Aws.PARTITION}:iam::*:role/${COST_IMPORT_ROLE_NAME}`],
        }),
      );
      central.addEnvironment("PROSPECTUS_COST_IMPORT", "enabled");
      new events.Rule(this, "CostImportSchedule", {
        ruleName: "prospectus-cost-import",
        description: "Imports the last three days of AWS cost from Cost Explorer into the cost ledger.",
        schedule: events.Schedule.cron({ minute: "15", hour: "7" }),
        targets: [
          new eventTargets.LambdaFunction(central, {
            event: events.RuleTargetInput.fromObject({ prospectusTask: "cost-import" }),
            retryAttempts: 2,
          }),
        ],
      });
    }
    // The secret exists before the runtime that reads it is updated.
    if (siteSubjectSecretResource) central.node.addDependency(siteSubjectSecretResource);
    if (rateTableResource) central.node.addDependency(rateTableResource);
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
      // Staff only: an operator turning a product on or off. Central still requires the reviewed
      // accounts:admin:entitlements grant. Never add this to customerRoutes or any other role.
      api.arnForExecuteApi("POST", "/v1/account-directory/operator/accounts/*/entitlements/*", "api"),
      // Staff only, and only while the ledger is on. Central still requires accounts:admin:billing for each.
      ...(options.billingLedger
        ? billingWriteRoutes.map(([method, path]) => api.arnForExecuteApi(method, path, "api"))
        : []),
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
          "execute-api:/api/POST/v1/account-directory/operator/accounts/*/entitlements/*",
          ...(options.billingLedger
            ? billingWriteRoutes.map(([method, path]) => `execute-api:/api/${method}${path}`)
            : []),
        ],
      }),
    );
    // Resource policy changes must publish to the existing API stage as well.
    api.latestDeployment?.addToLogicalId({ directoryRoutes: "organization-creation-v1" });
    // v2 adds the two engagement write routes (kanbus-935b1f), so the stage republishes with them.
    if (options.billingLedger)
      api.latestDeployment?.addToLogicalId({ billingRoutes: "ledger-v2-engagements" });
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
    if (portalRole) {
      api.addToResourcePolicy(
        new iam.PolicyStatement({
          principals: [new iam.ArnPrincipal(portalRole.roleArn)],
          actions: ["execute-api:Invoke"],
          resources: customerRoutes.map(([method, path]) => `execute-api:/api/${method}${path}`),
        }),
      );
      api.latestDeployment?.addToLogicalId({ anthusOne: options.anthusOne!.federationReviewId });
    }
    if (babulus) {
      api.addToResourcePolicy(
        new iam.PolicyStatement({
          principals: [new iam.ArnPrincipal(babulus.roleArn)],
          actions: ["execute-api:Invoke"],
          resources: babulusRoutes.map((route) => `execute-api:/api/${route}`),
        }),
      );
      api.latestDeployment?.addToLogicalId({ babulusRole: babulus.roleArn });
    }
    const quotaRoles = [...quotaProducts, ...(babulus ? [babulus] : [])].flatMap((product) => [
      product.roleArn,
      ...(product.quotaCaller ? [product.quotaCaller.roleArn] : []),
    ]);
    if (quotaRoles.length) {
      api.addToResourcePolicy(
        new iam.PolicyStatement({
          principals: quotaRoles.map((role) => new iam.ArnPrincipal(role)),
          actions: ["execute-api:Invoke"],
          resources: quotaRoutes.map((route) => `execute-api:/api/${route}`),
        }),
      );
      api.latestDeployment?.addToLogicalId({ quotaRoles });
    }
    const labVerifierRole = options.labVerifier?.roleArn;
    if (labVerifierRole) {
      if (!papyrusSiteRoles.length)
        throw new Error("The lab verifier needs at least one registered Papyrus site.");
      const roleName = (arn: string) =>
        arn
          .split(":")
          .slice(4)
          .join(":")
          .replace(/role\/(?:.*\/)?/, "");
      if (
        [consoleBff, consoleWorker, ...papyrusSiteRoles].some(
          (role) => roleName(role) === roleName(labVerifierRole),
        )
      )
        throw new Error("The lab verifier role must be distinct from every other registered runtime role.");
      // The role lives in another account, so this is a literal ARN: no resource is created or imported here.
      api.addToResourcePolicy(
        new iam.PolicyStatement({
          principals: [new iam.ArnPrincipal(labVerifierRole)],
          actions: ["execute-api:Invoke"],
          resources: labVerifierRoutes.map((route) => `execute-api:/api/${route}`),
        }),
      );
      api.latestDeployment?.addToLogicalId({ labVerifier: options.labVerifier!.reviewId, labVerifierRole });
    }
    const permittedPrincipals = [
      bffRole.roleArn,
      ...(portalRole ? [portalRole.roleArn] : []),
      ...(options.consolePairEnabled ? [consoleBff, consoleWorker] : []),
      ...papyrusSiteRoles,
      ...quotaRoles,
      ...(labVerifierRole ? [labVerifierRole] : []),
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
    if (portalRole && portalRegistration) {
      const portalLogs = new logs.LogGroup(this, "AnthusOneBffLogs", {
        logGroupName: "/aws/lambda/prospectus-anthus-one-bff",
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });
      portalRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
          resources: [portalLogs.logGroupArn],
        }),
      );
      portalRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ["execute-api:Invoke"],
          resources: customerRoutes.map(([method, path]) => api.arnForExecuteApi(method, path, "api")),
        }),
      );
      this.portalBff = new lambda.Function(this, "AnthusOneBff", {
        functionName: "prospectus-anthus-one-bff",
        description: "Anthus One customer accounts BFF: Google ID tokens, customer routes only.",
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.X86_64,
        handler: "index.handler",
        code: options.bffCode,
        role: portalRole,
        logGroup: portalLogs,
        memorySize: 256,
        timeout: cdk.Duration.seconds(29),
        environment: {
          PROSPECTUS_CENTRAL_ENDPOINT: api.url,
          PROSPECTUS_BFF_SURFACE: "customer",
          PROSPECTUS_DIRECTORY_REGISTRATION: stack.toJsonString(portalRegistration),
        },
      });
    }
  }
}
