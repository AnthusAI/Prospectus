import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as ses from "aws-cdk-lib/aws-ses";
import { Construct } from "constructs";
import {
  NEWSLETTER_CONFIGURATION_SET,
  NEWSLETTER_MAIL_DOMAINS,
  NEWSLETTER_TOKEN_PARAMETER,
  senderAddress,
  type IntakeFormConfig,
} from "../../server/intake-forms";
import { NEWSLETTER_TOKEN_SECRET_INITIALIZER_SOURCE } from "./site-subject-secret";
import { TARGET_ACCOUNT, TARGET_REGION } from "./scope";

/** The existing public zones the sending domains live in. They are imported, never created. */
export const MAIL_DOMAIN_ZONES: Record<
  (typeof NEWSLETTER_MAIL_DOMAINS)[number],
  { zoneName: string; hostedZoneId: string }
> = {
  "news.apyr.us": { zoneName: "apyr.us", hostedZoneId: "Z0630882HVOV46S7IPV7" },
};
/** SES's feedback endpoint for a custom MAIL FROM domain in this region. */
export const SES_FEEDBACK_HOST = `feedback-smtp.${TARGET_REGION}.amazonses.com`;
export const MAIL_FROM_PREFIX = "bounce";

/**
 * Sending for enabled newsletters, all as code: per sending domain an SES domain identity with Easy
 * DKIM (2048-bit) and a custom MAIL FROM domain, its DNS (three DKIM CNAMEs, MAIL FROM MX and SPF,
 * DMARC p=none), one configuration set whose bounce and complaint suppression uses the SES account
 * suppression list, and the token key (an SSM SecureString created once by a create-only custom
 * resource). The intake runtime gets only: send as each list sender through that identity and
 * configuration set, read the token parameter, and read and write the newsletter control prefix.
 */
export class NewsletterMail extends Construct {
  readonly tokenSecret: cdk.CustomResource;
  constructor(
    scope: Construct,
    id: string,
    props: { forms: readonly IntakeFormConfig[]; runtime: iam.Role; controlPrefixArn: string },
  ) {
    super(scope, id);
    const lists = props.forms.filter((form) => form.kind === "newsletter").map((form) => form.list!);
    if (!lists.length) throw new Error("NewsletterMail needs at least one enabled newsletter.");
    const domains = [...new Set(lists.map((list) => list.senderDomain))].sort();
    const configurationSet = new ses.ConfigurationSet(this, "ConfigurationSet", {
      configurationSetName: NEWSLETTER_CONFIGURATION_SET,
      // Bounces and complaints go on the SES account suppression list and are never sent to again,
      // from any list: the global suppression. No SNS topic, event destination or Lambda is needed.
      suppressionReasons: ses.SuppressionReasons.BOUNCES_AND_COMPLAINTS,
      reputationMetrics: true,
      sendingEnabled: true,
    });
    const identityArns: string[] = [];
    for (const domain of domains) {
      const zoneSpec = MAIL_DOMAIN_ZONES[domain as keyof typeof MAIL_DOMAIN_ZONES];
      if (!zoneSpec) throw new Error(`No reviewed hosted zone for mail domain ${domain}.`);
      const label = domain.replace(/[^a-z0-9]/g, "");
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, `Zone${label}`, zoneSpec);
      const mailFrom = `${MAIL_FROM_PREFIX}.${domain}`;
      const identity = new ses.EmailIdentity(this, `Identity${label}`, {
        identity: ses.Identity.domain(domain),
        configurationSet,
        dkimSigning: true,
        dkimIdentity: ses.DkimIdentity.easyDkim(ses.EasyDkimSigningKeyLength.RSA_2048_BIT),
        mailFromDomain: mailFrom,
        mailFromBehaviorOnMxFailure: ses.MailFromBehaviorOnMxFailure.USE_DEFAULT_VALUE,
        // SES requires forwarding unless SNS bounce and complaint topics exist; suppression does the work.
        feedbackForwarding: true,
      });
      identity.dkimRecords.forEach((record, index) => {
        new route53.CnameRecord(this, `Dkim${label}${index + 1}`, {
          zone,
          // SES returns fully qualified names; the trailing dot stops the zone name being appended.
          recordName: `${record.name}.`,
          domainName: record.value,
          ttl: cdk.Duration.minutes(30),
        });
      });
      new route53.MxRecord(this, `MailFromMx${label}`, {
        zone,
        recordName: `${mailFrom}.`,
        values: [{ priority: 10, hostName: SES_FEEDBACK_HOST }],
        ttl: cdk.Duration.minutes(30),
      });
      new route53.TxtRecord(this, `MailFromSpf${label}`, {
        zone,
        recordName: `${mailFrom}.`,
        values: ["v=spf1 include:amazonses.com ~all"],
        ttl: cdk.Duration.minutes(30),
      });
      // Monitoring only. No report address: none exists yet, and one is added by a reviewed change.
      new route53.TxtRecord(this, `Dmarc${label}`, {
        zone,
        recordName: `_dmarc.${domain}.`,
        values: ["v=DMARC1; p=none"],
        ttl: cdk.Duration.minutes(30),
      });
      identityArns.push(`arn:aws:ses:${TARGET_REGION}:${TARGET_ACCOUNT}:identity/${domain}`);
    }
    props.runtime.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail"],
        resources: [
          ...identityArns,
          `arn:aws:ses:${TARGET_REGION}:${TARGET_ACCOUNT}:configuration-set/${NEWSLETTER_CONFIGURATION_SET}`,
        ],
        conditions: { StringEquals: { "ses:FromAddress": [...new Set(lists.map(senderAddress))].sort() } },
      }),
    );
    props.runtime.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:PutObject"],
        resources: [props.controlPrefixArn],
      }),
    );
    const parameterArn = `arn:aws:ssm:${TARGET_REGION}:${TARGET_ACCOUNT}:parameter${NEWSLETTER_TOKEN_PARAMETER}`;
    props.runtime.addToPolicy(
      new iam.PolicyStatement({ actions: ["ssm:GetParameter"], resources: [parameterArn] }),
    );
    // Create-only: the initializer may put this one parameter and never overwrite it.
    const initializerRole = new iam.Role(this, "TokenKeyInitializerRuntime", {
      roleName: "prospectus-newsletter-token-init",
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
    const initializerLogs = new logs.LogGroup(this, "TokenKeyInitializerLogs", {
      logGroupName: "/aws/lambda/prospectus-newsletter-token-init",
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    initializerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [initializerLogs.logGroupArn],
      }),
    );
    const initializer = new lambda.Function(this, "TokenKeyInitializer", {
      functionName: "prospectus-newsletter-token-init",
      description:
        "Create-only: generates the newsletter token key once; never overwrites, logs or returns it.",
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.X86_64,
      handler: "index.handler",
      code: lambda.Code.fromInline(NEWSLETTER_TOKEN_SECRET_INITIALIZER_SOURCE),
      role: initializerRole,
      logGroup: initializerLogs,
      memorySize: 128,
      timeout: cdk.Duration.seconds(60),
    });
    this.tokenSecret = new cdk.CustomResource(this, "TokenKey", {
      serviceToken: initializer.functionArn,
      resourceType: "Custom::ProspectusNewsletterTokenKey",
      properties: { ParameterName: NEWSLETTER_TOKEN_PARAMETER },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
  }
}
