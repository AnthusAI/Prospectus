import { readFileSync } from "node:fs";
import * as cdk from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import type { CliSignInBroker } from "./cli-sign-in-deployment";
import { AMPLIFY_APP_ID, TARGET_ACCOUNT, TARGET_REGION } from "./scope";
import { throttleRoutes } from "./throttle-routes";

export interface CliSignInOptions {
  readonly broker: CliSignInBroker | null;
  /** The pages bundle: prospectus_cli plus the pinned cli-login (infra/scripts/build-cli-pages.py). */
  readonly code: lambda.Code;
}

const PAGES: [apigw.HttpMethod, string][] = [
  [apigw.HttpMethod.GET, "/cli/discovery"],
  [apigw.HttpMethod.GET, "/cli/approve"],
  [apigw.HttpMethod.POST, "/cli/approve"],
  [apigw.HttpMethod.GET, "/cli/callback"],
];

/** The one rule this stack owns on the CRM's Amplify app; it must precede the single-page-app rewrite. */
export const CLI_REWRITE_SOURCE = "/cli/<*>";

/**
 * cli-login's approval pages for prospectus.anth.us. They invoke the broker's private operations directly and hold
 * no secret; enrollment goes through the CRM accounts BFF's public login-challenge route.
 */
export class CliSignIn extends Construct {
  readonly role: iam.Role;
  constructor(
    scope: Construct,
    id: string,
    api: apigw.HttpApi,
    pool: cognito.IUserPool,
    client: cognito.IUserPoolClient,
    domain: cognito.UserPoolDomain,
    appUrl: string,
    options: CliSignInOptions,
  ) {
    super(scope, id);
    const logGroup = new logs.LogGroup(this, "Logs", {
      logGroupName: "/aws/lambda/prospectus-cli-pages",
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.role = new iam.Role(this, "Role", {
      roleName: "prospectus-cli-pages-runtime",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [logGroup.logGroupArn],
      }),
    );
    const { broker } = options;
    if (broker)
      this.role.addToPolicy(
        new iam.PolicyStatement({ actions: ["lambda:InvokeFunction"], resources: [broker.functionArn] }),
      );
    const pages = new lambda.Function(this, "Pages", {
      functionName: "prospectus-cli-pages",
      description: "Remote CLI sign-in approval pages (cli-login); invokes only the broker.",
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: "prospectus_cli.pages.lambda_handler",
      code: options.code,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      logGroup,
      role: this.role,
      // Public values only. Without a broker the pages are unconfigured and answer 503.
      ...(broker
        ? {
            environment: {
              CLI_BROKER_ARN: broker.functionArn,
              CLI_BROKER_ENDPOINT: broker.endpoint.replace(/\/$/, ""),
              CLI_PUBLIC_ORIGIN: appUrl,
              CLI_ISSUER: `https://cognito-idp.${cdk.Stack.of(this).region}.amazonaws.com/${pool.userPoolId}`,
              CLI_CLIENT_ID: client.userPoolClientId,
              CLI_OAUTH_DOMAIN: domain.baseUrl(),
              CLI_API_URL: api.apiEndpoint,
            },
          }
        : {}),
    });
    const integration = new HttpLambdaIntegration("CliPages", pages);
    const throttles = PAGES.map(([method, path]) => {
      const [route] = api.addRoutes({
        path,
        methods: [method],
        integration,
        authorizer: new apigw.HttpNoneAuthorizer(),
        // The API defaults to the "openid" scope, which API Gateway rejects on a NONE route.
        authorizationScopes: [],
      });
      return { routeKey: `${method} ${path}`, route, burstLimit: 10, rateLimit: 5 };
    });
    throttleRoutes(api.defaultStage!, throttles);
    this.rewrite(api);
  }

  /**
   * Proxies prospectus.anth.us/cli/* to the pages on the CRM API. The Amplify app is not CDK-managed
   * (kanbus-e72209), so a helper adds or removes only this rule and keeps every other rule as it is.
   */
  private rewrite(api: apigw.HttpApi) {
    const logGroup = new logs.LogGroup(this, "RewriteLogs", {
      logGroupName: "/aws/lambda/prospectus-cli-rewrite",
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const role = new iam.Role(this, "RewriteRole", {
      roleName: "prospectus-cli-rewrite",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [logGroup.logGroupArn],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["amplify:GetApp", "amplify:UpdateApp"],
        resources: [`arn:aws:amplify:${TARGET_REGION}:${TARGET_ACCOUNT}:apps/${AMPLIFY_APP_ID}`],
      }),
    );
    const helper = new lambda.Function(this, "RewriteHelper", {
      functionName: "prospectus-cli-rewrite",
      description: "Keeps the /cli/<*> proxy rewrite on the CRM Amplify app; changes no other rule.",
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromInline(readFileSync(new URL("./cli-rewrite/index.py", import.meta.url), "utf8")),
      memorySize: 128,
      timeout: cdk.Duration.seconds(30),
      logGroup,
      role,
    });
    const rule = new cdk.CustomResource(this, "Rewrite", {
      serviceToken: helper.functionArn,
      resourceType: "Custom::AmplifyRewrite",
      properties: { AppId: AMPLIFY_APP_ID, Source: CLI_REWRITE_SOURCE, Target: `${api.apiEndpoint}/cli/<*>` },
    });
    // The policy must exist before CloudFormation invokes the helper, and on removal it must outlive the rule.
    rule.node.addDependency(role);
  }
}
