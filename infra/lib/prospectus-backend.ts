import * as cdk from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { AccountsPlane, type AccountsPlaneOptions } from "./accounts-plane";

const LOGIN_CHALLENGE_PATH = "/api/saas/identity/login-challenge";
import { Construct } from "constructs";
import { EvaluationIntake, type IntakeContactMode } from "./evaluation-intake";
import type { SpamLabelling } from "../../server/intake-spam-mode";
import type { IntakeFormConfig } from "../../server/intake-forms";
import { throttleRoutes, throttleStageDefault } from "./throttle-routes";
import { PortalHosting } from "./portal-hosting";
import {
  APP_ORIGINS,
  KANBUS_BOARD_GROUP,
  MEMBER_GROUP,
  PORTAL_ORIGINS,
  PORTAL_DOMAIN,
  PROJECT_NAMESPACE,
  SITE_DOMAIN,
  TARGET_ACCOUNT,
} from "./scope";

/** Separate private CRM data plane; public static assets contain no CRM records. */
export class ProspectusBackend extends Construct {
  readonly outputs: Record<string, string>;
  constructor(
    scope: Construct,
    id: string,
    code: lambda.Code,
    evaluationCode?: lambda.Code,
    accounts?: AccountsPlaneOptions,
    intakeContactMode: IntakeContactMode = "synthetic-only",
    intakeForms: readonly IntakeFormConfig[] = [],
    portal?: { assetDirectory: string },
    intakeSpamLabelling: SpamLabelling = "shadow",
  ) {
    super(scope, id);
    cdk.Tags.of(this).add("anthus:project", "Prospectus");
    cdk.Tags.of(this).add("anthus:surface", "crm");

    const objects = new s3.Bucket(this, "CanonicalObjects", {
      bucketName: `prospectus-records-${TARGET_ACCOUNT}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });
    const catalog = new dynamodb.Table(this, "Catalog", {
      tableName: "prospectus-catalog",
      partitionKey: { name: "scope", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "path", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    catalog.addGlobalSecondaryIndex({
      indexName: "by_type",
      partitionKey: { name: "type_scope", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "path", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    catalog.addGlobalSecondaryIndex({
      indexName: "by_status",
      partitionKey: { name: "status_scope", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "path", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    catalog.addGlobalSecondaryIndex({
      indexName: "by_type_status",
      partitionKey: { name: "type_status_scope", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "path", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    const pool = new cognito.UserPool(this, "Members", {
      userPoolName: "prospectus-members",
      selfSignUpEnabled: false,
      signInCaseSensitive: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
    });
    const googleSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "GoogleOAuth",
      "prospectus/proof/oauth/google",
    );
    const google = new cognito.UserPoolIdentityProviderGoogle(this, "Google", {
      userPool: pool,
      clientId: googleSecret.secretValueFromJson("client_id").unsafeUnwrap(),
      clientSecretValue: googleSecret.secretValueFromJson("client_secret"),
      scopes: ["openid", "email", "profile"],
      attributeMapping: {
        email: cognito.ProviderAttribute.GOOGLE_EMAIL,
        emailVerified: cognito.ProviderAttribute.GOOGLE_EMAIL_VERIFIED,
      },
    });
    new cognito.CfnUserPoolGroup(this, "MemberGroup", {
      groupName: MEMBER_GROUP,
      userPoolId: pool.userPoolId,
      description: "Explicit membership required by the Kanbus API after JWT verification.",
    });
    new cognito.CfnUserPoolGroup(this, "KanbusBoardGroup", {
      groupName: KANBUS_BOARD_GROUP,
      userPoolId: pool.userPoolId,
      description: "Grants the cyclotron/prospectus board in the multi-board Kanbus API (kanbus-0ec206).",
    });
    new cognito.CfnUserPoolGroup(this, "AdministratorGroup", {
      groupName: "admin",
      userPoolId: pool.userPoolId,
      description: "Prospectus application administrators; workspace access also requires membership.",
    });
    const appUrl = `https://${SITE_DOMAIN}`;
    const client = pool.addClient("Browser", {
      generateSecret: false,
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.GOOGLE],
      preventUserExistenceErrors: true,
      authFlows: { userSrp: false, userPassword: false, adminUserPassword: false, custom: false },
      oAuth: {
        flows: { authorizationCodeGrant: true, implicitCodeGrant: false, clientCredentials: false },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        // The last is remote CLI sign-in: an approval page hands the code to the cli-login broker, and only the
        // waiting CLI, holding the PKCE verifier, can redeem it. Production only; no localhost CLI callback.
        callbackUrls: [...APP_ORIGINS.map((origin) => `${origin}/auth/callback`), `${appUrl}/cli/callback`],
        logoutUrls: APP_ORIGINS.map((origin) => `${origin}/`),
      },
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
      enableTokenRevocation: true,
    });
    client.node.addDependency(google);
    const domain = pool.addDomain("Login", {
      cognitoDomain: { domainPrefix: `prospectus-${TARGET_ACCOUNT}` },
    });
    const logGroup = new logs.LogGroup(this, "ApiLogs", {
      logGroupName: "/aws/lambda/prospectus-api",
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const runtimeRole = new iam.Role(this, "RuntimeRole", {
      roleName: "prospectus-runtime",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [logGroup.logGroupArn],
      }),
    );
    const backend = new lambda.Function(this, "Backend", {
      functionName: "prospectus-api",
      description: "Generic Kanbus API: private canonical S3 files and supplemental catalog only.",
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.X86_64,
      handler: "bootstrap",
      code,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      logGroup,
      role: runtimeRole,
      environment: {
        KANBUS_BACKEND: "s3",
        KANBUS_OBJECT_BUCKET: objects.bucketName,
        KANBUS_CATALOG_TABLE: catalog.tableName,
      },
    });
    backend.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:ListBucket"],
        resources: [objects.bucketArn],
        conditions: {
          StringLike: { "s3:prefix": [`${PROJECT_NAMESPACE}/*`, `_virtuus/${PROJECT_NAMESPACE}/*`] },
        },
      }),
    );
    backend.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        resources: [
          objects.arnForObjects(`${PROJECT_NAMESPACE}/*`),
          objects.arnForObjects(`_virtuus/${PROJECT_NAMESPACE}/*`),
        ],
      }),
    );
    backend.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Query"],
        resources: [catalog.tableArn],
        conditions: { "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": [PROJECT_NAMESPACE] } },
      }),
    );
    for (const [index, field] of [
      ["by_type", "type"],
      ["by_status", "status"],
      ["by_type_status", "type"],
    ]) {
      backend.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["dynamodb:Query"],
          resources: [`${catalog.tableArn}/index/${index}`],
          conditions: {
            "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [`${PROJECT_NAMESPACE}#${field}#*`] },
          },
        }),
      );
    }

    const jwt = new HttpJwtAuthorizer(
      "MemberJwt",
      `https://cognito-idp.${cdk.Stack.of(this).region}.amazonaws.com/${pool.userPoolId}`,
      {
        jwtAudience: [client.userPoolClientId],
      },
    );
    const api = new apigw.HttpApi(this, "Api", {
      apiName: "prospectus",
      defaultAuthorizer: jwt,
      defaultAuthorizationScopes: ["openid"],
      corsPreflight: {
        allowOrigins: [...APP_ORIGINS],
        allowHeaders: ["authorization", "content-type", "if-match", "x-operation-id"],
        allowMethods: [
          apigw.CorsHttpMethod.GET,
          apigw.CorsHttpMethod.POST,
          apigw.CorsHttpMethod.PATCH,
          apigw.CorsHttpMethod.DELETE,
          apigw.CorsHttpMethod.OPTIONS,
        ],
        exposeHeaders: ["etag"],
        maxAge: cdk.Duration.hours(1),
      },
    });
    api.addRoutes({
      // The multi-board API reads the board from the path and access from kanbus:<tenant>/<project> groups.
      path: `/${PROJECT_NAMESPACE}/api/{proxy+}`,
      methods: [apigw.HttpMethod.GET, apigw.HttpMethod.POST, apigw.HttpMethod.PATCH, apigw.HttpMethod.DELETE],
      integration: new HttpLambdaIntegration("Kanbus", backend),
    });

    const consoleClient = accounts?.consoleClientEnabled
      ? pool.addClient("CyclotronConsoleBrowser", {
          userPoolClientName: "cyclotron-console-public",
          generateSecret: false,
          supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.GOOGLE],
          preventUserExistenceErrors: true,
          authFlows: { userSrp: false, userPassword: false, adminUserPassword: false, custom: false },
          oAuth: {
            flows: { authorizationCodeGrant: true, implicitCodeGrant: false, clientCredentials: false },
            scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
            // The second is remote CLI sign-in: an approval page on the lab hands the code to the lab's
            // cli-login broker, and only the waiting CLI, holding the PKCE verifier, can redeem it.
            callbackUrls: [
              "https://lab.cyclotron.anth.us/auth/callback",
              "https://lab.cyclotron.anth.us/cli/callback",
            ],
            logoutUrls: ["https://lab.cyclotron.anth.us/"],
          },
          accessTokenValidity: cdk.Duration.hours(1),
          idTokenValidity: cdk.Duration.hours(1),
          refreshTokenValidity: cdk.Duration.days(30),
          enableTokenRevocation: true,
        })
      : undefined;
    consoleClient?.node.addDependency(google);
    const accountsPlane = accounts
      ? new AccountsPlane(this, "SaasAccounts", objects, pool, client, { ...accounts, consoleClient })
      : null;
    if (accountsPlane) {
      api.addRoutes({
        path: "/api/saas/{proxy+}",
        methods: [apigw.HttpMethod.GET, apigw.HttpMethod.POST],
        integration: new HttpLambdaIntegration("AccountsDirectory", accountsPlane.bff),
      });
      const [loginChallengeRoute] = api.addRoutes({
        path: LOGIN_CHALLENGE_PATH,
        methods: [apigw.HttpMethod.POST],
        integration: new HttpLambdaIntegration("AccountsLoginChallenge", accountsPlane.bff),
        authorizer: new apigw.HttpNoneAuthorizer(),
        // The API defaults to the "openid" scope, which API Gateway rejects on a NONE route.
        authorizationScopes: [],
      });
      throttleRoutes(api.defaultStage!, [
        { routeKey: `POST ${LOGIN_CHALLENGE_PATH}`, route: loginChallengeRoute, burstLimit: 2, rateLimit: 1 },
      ]);
    }
    // Anthus One: its own HTTP API in front of the customer BFF. API Gateway verifies the Google ID token (issuer and
    // audience) before the Lambda does again; there is no Cognito pool and no Google client secret anywhere.
    let portalApiUrl: string | undefined;
    let portalApiOrigin: string | undefined;
    if (accountsPlane?.portalBff && accounts?.anthusOne) {
      const portalApi = new apigw.HttpApi(this, "AnthusOneApi", {
        apiName: "anthus-one",
        defaultAuthorizer: new HttpJwtAuthorizer("AnthusOneGoogleJwt", "https://accounts.google.com", {
          jwtAudience: [accounts.anthusOne.googleClientId],
        }),
        corsPreflight: {
          allowOrigins: [...PORTAL_ORIGINS],
          allowHeaders: ["authorization", "content-type"],
          allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST, apigw.CorsHttpMethod.OPTIONS],
          maxAge: cdk.Duration.hours(1),
        },
      });
      const portalIntegration = new HttpLambdaIntegration("AnthusOneAccounts", accountsPlane.portalBff);
      portalApi.addRoutes({
        path: "/api/saas/{proxy+}",
        methods: [apigw.HttpMethod.GET],
        integration: portalIntegration,
      });
      const [portalPostRoute] = portalApi.addRoutes({
        path: "/api/saas/{proxy+}",
        methods: [apigw.HttpMethod.POST],
        integration: portalIntegration,
      });
      const [portalChallengeRoute] = portalApi.addRoutes({
        path: LOGIN_CHALLENGE_PATH,
        methods: [apigw.HttpMethod.POST],
        integration: portalIntegration,
        authorizer: new apigw.HttpNoneAuthorizer(),
      });
      // Account creation is the one write a signed-in person can repeat, so POSTs are held to 2 per second (burst 5)
      // across the API, and every other route to 10 per second (burst 20). The public challenge route serves only a
      // first sign-in (token refresh uses the authenticated challenge), so 2 per second (burst 5) lets about 120
      // people start signing in each minute; it stores nothing, so exhausting it creates no data.
      throttleStageDefault(portalApi.defaultStage!, 10, 20);
      throttleRoutes(portalApi.defaultStage!, [
        { routeKey: "POST /api/saas/{proxy+}", route: portalPostRoute, burstLimit: 5, rateLimit: 2 },
        {
          routeKey: `POST ${LOGIN_CHALLENGE_PATH}`,
          route: portalChallengeRoute,
          burstLimit: 5,
          rateLimit: 2,
        },
      ]);
      portalApiUrl = `${portalApi.apiEndpoint}/api/saas`;
      portalApiOrigin = portalApi.apiEndpoint;
    }
    const outputs: Record<string, string> = {
      AppUrl: appUrl,
      ApiUrl: api.apiEndpoint,
      UserPoolId: pool.userPoolId,
      ClientId: client.userPoolClientId,
      CognitoDomainUrl: domain.baseUrl(),
      RequiredGroup: MEMBER_GROUP,
      CanonicalNamespace: PROJECT_NAMESPACE,
      ConfigurationObjectKey: `${PROJECT_NAMESPACE}/.kanbus.yml`,
      GoogleCallbackUrl: `${domain.baseUrl()}/oauth2/idpresponse`,
      BackendFunctionName: backend.functionName,
      ObjectBucketName: objects.bucketName,
      CatalogTableName: catalog.tableName,
    };
    if (evaluationCode) {
      const intake = new EvaluationIntake(
        this,
        "EvaluationIntake",
        evaluationCode,
        intakeContactMode,
        intakeForms,
        intakeSpamLabelling,
      );
      outputs.EvaluationIntakeUrl = intake.url;
      if (intake.waitlistBaseUrl) outputs.IntakeWaitlistBaseUrl = intake.waitlistBaseUrl;
      if (intake.contactBaseUrl) outputs.IntakeContactBaseUrl = intake.contactBaseUrl;
      if (intake.newsletterBaseUrl) outputs.IntakeNewsletterBaseUrl = intake.newsletterBaseUrl;
    }
    if (accountsPlane) {
      outputs.AccountsBffUrl = `${api.apiEndpoint}/api/saas`;
      outputs.AccountsApiUrl = accountsPlane.endpoint;
    }
    if (portalApiUrl) outputs.AnthusOneBffUrl = portalApiUrl;
    if (consoleClient) {
      outputs.ConsoleClientId = consoleClient.userPoolClientId;
      outputs.ConsoleCognitoDomainUrl = domain.baseUrl();
    }
    if (portal) {
      const hosting = new PortalHosting(this, "AnthusOnePortal", {
        assetDirectory: portal.assetDirectory,
        // The page may connect only to its own accounts API (and Google); never the CRM API.
        apiOrigin: portalApiOrigin ?? api.apiEndpoint,
      });
      outputs.PortalUrl = `https://${PORTAL_DOMAIN}`;
      outputs.PortalBucketName = hosting.bucket.bucketName;
      outputs.PortalDistributionId = hosting.distribution.distributionId;
    }
    this.outputs = outputs;
  }
}
