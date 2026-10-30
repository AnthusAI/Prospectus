import * as cdk from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import type { CliSignInBroker } from "./cli-sign-in-deployment";
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
  }
}
