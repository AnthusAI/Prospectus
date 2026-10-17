import * as cdk from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import { PROJECT_NAMESPACE, SITE_DOMAIN, TARGET_ACCOUNT } from "./scope";

export type IntakeContactMode = "synthetic-only" | "real-contacts";

export const ANTHUS_WEBSITE_ORIGINS = ["https://anth.us", "https://www.anth.us"];

export function intakeFormOriginsForMode(contactMode: IntakeContactMode): string[] {
  const prospectusOrigin = `https://${SITE_DOMAIN}`;
  return contactMode === "real-contacts" ? [prospectusOrigin, ...ANTHUS_WEBSITE_ORIGINS] : [prospectusOrigin];
}

/** Additive inquiry intake. Synthetic-only unless real contacts are explicitly enabled. Existing CRM routes stay private. */
export class EvaluationIntake extends Construct {
  readonly url: string;
  constructor(scope: Construct, id: string, code: lambda.Code, contactMode: IntakeContactMode = "synthetic-only") {
    super(scope, id);
    const formOrigins = intakeFormOriginsForMode(contactMode);
    const logGroup = new logs.LogGroup(this, "Logs", { logGroupName: "/aws/lambda/prospectus-intake-evaluation", retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.RETAIN });
    const role = new iam.Role(this, "Role", { roleName: "prospectus-intake-evaluation", assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") });
    role.addToPolicy(new iam.PolicyStatement({ actions: ["logs:CreateLogStream", "logs:PutLogEvents"], resources: [logGroup.logGroupArn] }));
    role.addToPolicy(new iam.PolicyStatement({ actions: ["lambda:InvokeFunction"], resources: [`arn:aws:lambda:us-east-1:${TARGET_ACCOUNT}:function:prospectus-api`] }));
    role.addToPolicy(new iam.PolicyStatement({ actions: ["s3:GetObject", "s3:PutObject"], resources: [
      `arn:aws:s3:::prospectus-records-${TARGET_ACCOUNT}/_virtuus/${PROJECT_NAMESPACE}/intake-identities/*`,
      `arn:aws:s3:::prospectus-records-${TARGET_ACCOUNT}/_virtuus/${PROJECT_NAMESPACE}/intake-receipts/*`,
    ] }));
    const handler = new lambda.Function(this, "Handler", {
      functionName: "prospectus-intake-evaluation", runtime: lambda.Runtime.NODEJS_22_X, architecture: lambda.Architecture.X86_64,
      description: contactMode === "real-contacts"
        ? "Contact and demo inquiries from anth.us and Prospectus; no email, invitations, accounts or public CRM reads."
        : "Synthetic .invalid inquiry evaluation only; no email, invitations, accounts or public CRM reads.",
      handler: "index.handler", code, role, logGroup, memorySize: 512, timeout: cdk.Duration.seconds(60), reservedConcurrentExecutions: 2,
      environment: { PROSPECTUS_INTAKE_ALLOWED_ORIGINS: formOrigins.join(","), PROSPECTUS_INTAKE_CONTACT_MODE: contactMode, PROSPECTUS_EVALUATION_WORKSPACE: PROJECT_NAMESPACE,
        PROSPECTUS_EVALUATION_BUCKET: `prospectus-records-${TARGET_ACCOUNT}`, PROSPECTUS_CANONICAL_FUNCTION: "prospectus-api" },
    });
    const api = new apigw.HttpApi(this, "Api", { apiName: "prospectus-intake-evaluation", corsPreflight: {
      allowOrigins: formOrigins, allowMethods: [apigw.CorsHttpMethod.POST], allowHeaders: ["content-type"], maxAge: cdk.Duration.minutes(10),
    } });
    api.addRoutes({ path: "/intake/demo", methods: [apigw.HttpMethod.POST], integration: new HttpLambdaIntegration("SyntheticSubmission", handler) });
    const stage = api.defaultStage!.node.defaultChild as apigw.CfnStage;
    stage.defaultRouteSettings = { throttlingBurstLimit: 2, throttlingRateLimit: 1 };
    this.url = `${api.apiEndpoint}/intake/demo`;
  }
}
