import * as cdk from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import {
  NEWSLETTER_PAGES,
  assertDistinctFormOrigins,
  enabledIntakeForms,
  formRoutePath,
  newsletterPagePath,
  type IntakeFormConfig,
} from "../../server/intake-forms";
import { spamLabellingForMode, type SpamLabelling } from "../../server/intake-spam-mode";
import { NewsletterMail } from "./newsletter-mail";
import { throttleRoutes, type RouteThrottle } from "./throttle-routes";
import { PROJECT_NAMESPACE, SITE_DOMAIN, TARGET_ACCOUNT } from "./scope";

export type IntakeContactMode = "synthetic-only" | "real-contacts";

export const ANTHUS_WEBSITE_ORIGINS = ["https://anth.us", "https://www.anth.us"];

/**
 * The registry entry as the runtime receives it. The approval text stays in intake-forms.json: the
 * Lambda does not need it, and Lambda environment variables are limited to 4 KB in total.
 */
export function runtimeForm(form: IntakeFormConfig): IntakeFormConfig {
  return { ...form, approval: "Recorded in intake-forms.json." };
}

export function intakeFormOriginsForMode(contactMode: IntakeContactMode): string[] {
  const prospectusOrigin = `https://${SITE_DOMAIN}`;
  return contactMode === "real-contacts" ? [prospectusOrigin, ...ANTHUS_WEBSITE_ORIGINS] : [prospectusOrigin];
}

/** Additive inquiry intake. Synthetic-only unless real contacts are explicitly enabled. Existing CRM routes stay private. */
export class EvaluationIntake extends Construct {
  readonly url: string;
  readonly waitlistBaseUrl?: string;
  readonly contactBaseUrl?: string;
  readonly newsletterBaseUrl?: string;
  constructor(
    scope: Construct,
    id: string,
    code: lambda.Code,
    contactMode: IntakeContactMode = "synthetic-only",
    registryForms: readonly IntakeFormConfig[] = [],
    spamLabelling: SpamLabelling = "shadow",
  ) {
    super(scope, id);
    spamLabellingForMode(spamLabelling);
    const forms = enabledIntakeForms(registryForms);
    const newsletterForms = forms.filter((form) => form.kind === "newsletter");
    assertDistinctFormOrigins(registryForms);
    if (forms.length && contactMode !== "real-contacts")
      throw new Error("Registry forms collect real contacts and need the real-contacts runtime.");
    const formOrigins = intakeFormOriginsForMode(contactMode);
    const corsOrigins = [...new Set([...formOrigins, ...forms.flatMap((form) => form.origins)])];
    const logGroup = logs.LogGroup.fromLogGroupName(this, "Logs", "/aws/lambda/prospectus-intake-evaluation");
    const role = new iam.Role(this, "Role", {
      roleName: "prospectus-intake-evaluation",
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
        actions: ["lambda:InvokeFunction"],
        resources: [`arn:aws:lambda:us-east-1:${TARGET_ACCOUNT}:function:prospectus-api`],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:PutObject"],
        resources: [
          `arn:aws:s3:::prospectus-records-${TARGET_ACCOUNT}/_virtuus/${PROJECT_NAMESPACE}/intake-identities/*`,
          `arn:aws:s3:::prospectus-records-${TARGET_ACCOUNT}/_virtuus/${PROJECT_NAMESPACE}/intake-receipts/*`,
        ],
      }),
    );
    const handler = new lambda.Function(this, "Handler", {
      functionName: "prospectus-intake-evaluation",
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.X86_64,
      description:
        contactMode === "real-contacts"
          ? newsletterForms.length
            ? "Contact, demo, waitlist and newsletter intake; newsletter confirmation email only; no invitations, accounts or public CRM reads."
            : "Contact and demo inquiries from anth.us and Prospectus; no email, invitations, accounts or public CRM reads."
          : "Synthetic .invalid inquiry evaluation only; no email, invitations, accounts or public CRM reads.",
      handler: "index.handler",
      code,
      role,
      logGroup,
      memorySize: 512,
      timeout: cdk.Duration.seconds(60),
      environment: {
        PROSPECTUS_INTAKE_ALLOWED_ORIGINS: formOrigins.join(","),
        PROSPECTUS_INTAKE_CONTACT_MODE: contactMode,
        PROSPECTUS_INTAKE_SPAM_LABELLING: spamLabelling,
        ...(forms.length ? { PROSPECTUS_INTAKE_FORMS: JSON.stringify(forms.map(runtimeForm)) } : {}),
        PROSPECTUS_EVALUATION_WORKSPACE: PROJECT_NAMESPACE,
        PROSPECTUS_EVALUATION_BUCKET: `prospectus-records-${TARGET_ACCOUNT}`,
        PROSPECTUS_CANONICAL_FUNCTION: "prospectus-api",
      },
    });
    const api = new apigw.HttpApi(this, "Api", {
      apiName: "prospectus-intake-evaluation",
      corsPreflight: {
        allowOrigins: corsOrigins,
        allowMethods: [apigw.CorsHttpMethod.POST],
        allowHeaders: ["content-type"],
        maxAge: cdk.Duration.minutes(10),
      },
    });
    api.addRoutes({
      path: "/intake/demo",
      methods: [apigw.HttpMethod.POST],
      integration: new HttpLambdaIntegration("SyntheticSubmission", handler),
    });
    const integrationName = { waitlist: "Waitlist", contact: "Contact", newsletter: "Newsletter" };
    const formRoutes = forms.map((form, index) => ({
      form,
      route: api.addRoutes({
        path: formRoutePath(form),
        methods: [apigw.HttpMethod.POST],
        integration: new HttpLambdaIntegration(`${integrationName[form.kind]}Submission${index}`, handler),
      })[0],
    }));
    const pageRoutes: RouteThrottle[] = [];
    if (newsletterForms.length) {
      const mail = new NewsletterMail(this, "Newsletter", {
        forms: newsletterForms,
        runtime: role,
        controlPrefixArn: `arn:aws:s3:::prospectus-records-${TARGET_ACCOUNT}/_virtuus/${PROJECT_NAMESPACE}/intake-newsletter/*`,
      });
      // The key exists before the runtime that reads it is updated.
      handler.node.addDependency(mail.tokenSecret);
      for (const page of NEWSLETTER_PAGES) {
        const methods = [apigw.HttpMethod.GET, apigw.HttpMethod.POST];
        const routes = api.addRoutes({
          path: newsletterPagePath(page),
          methods,
          integration: new HttpLambdaIntegration(
            `Newsletter${page === "confirm" ? "Confirm" : "Unsubscribe"}Page`,
            handler,
          ),
        });
        routes.forEach((route, index) =>
          pageRoutes.push({
            routeKey: `${methods[index]} ${newsletterPagePath(page)}`,
            route,
            // Links opened from email and one-click requests from mail providers; still well inside
            // the account's 10 concurrent Lambda executions.
            burstLimit: 4,
            rateLimit: 2,
          }),
        );
      }
    }
    const stage = api.defaultStage!.node.defaultChild as apigw.CfnStage;
    stage.defaultRouteSettings = { throttlingBurstLimit: 2, throttlingRateLimit: 1 };
    // Route and status only, so refusals can be told apart; no addresses, agents, paths or bodies.
    const accessLog = new logs.LogGroup(this, "AccessLog", {
      logGroupName: "/aws/apigateway/prospectus-intake-evaluation",
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    stage.accessLogSettings = {
      destinationArn: accessLog.logGroupArn,
      format: JSON.stringify({
        requestId: "$context.requestId",
        requestTime: "$context.requestTime",
        method: "$context.httpMethod",
        route: "$context.routeKey",
        status: "$context.status",
        integrationStatus: "$context.integrationStatus",
        error: "$context.error.message",
      }),
    };
    if (formRoutes.length)
      throttleRoutes(api.defaultStage!, [
        ...formRoutes.map(({ form, route }) => ({
          routeKey: `POST ${formRoutePath(form)}`,
          route,
          burstLimit: form.throttle.burst,
          rateLimit: form.throttle.rate,
        })),
        ...pageRoutes,
      ]);
    this.url = `${api.apiEndpoint}/intake/demo`;
    this.newsletterBaseUrl = newsletterForms.length ? `${api.apiEndpoint}/intake/newsletter` : undefined;
    this.waitlistBaseUrl = forms.some((form) => form.kind === "waitlist")
      ? `${api.apiEndpoint}/intake/waitlist`
      : undefined;
    this.contactBaseUrl = forms.some((form) => form.kind === "contact")
      ? `${api.apiEndpoint}/intake/contact`
      : undefined;
  }
}
