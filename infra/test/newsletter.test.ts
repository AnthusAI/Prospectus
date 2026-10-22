import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Template } from "aws-cdk-lib/assertions";
import { EvaluationIntake } from "../lib/evaluation-intake";
import { NEWSLETTER_TOKEN_SECRET_INITIALIZER_SOURCE } from "../lib/site-subject-secret";
import { parseIntakeForm, parseIntakeFormRegistry, type IntakeFormConfig } from "../../server/intake-forms";
import { unscopableRoutesWithScopes } from "./route-auth";

const shipped = () => parseIntakeFormRegistry(JSON.parse(readFileSync("../intake-forms.json", "utf8")));
const synthesize = (forms: readonly IntakeFormConfig[]) => {
  const stack = new cdk.Stack(new cdk.App(), "NewsletterReview", {
    env: { account: "712236451410", region: "us-east-1" },
  });
  const intake = new EvaluationIntake(
    stack,
    "Intake",
    lambda.Code.fromInline("exports.handler=async()=>({statusCode:503})"),
    "real-contacts",
    forms,
  );
  return { template: Template.fromStack(stack), intake, stack };
};
const resources = (template: Template, type: string) => Object.values(template.findResources(type)) as any[];
const statementsOf = (template: Template, roleFragment: string) =>
  Object.values(template.findResources("AWS::IAM::Policy"))
    .filter((policy: any) => JSON.stringify(policy.Properties.Roles).includes(roleFragment))
    .flatMap((policy: any) => policy.Properties.PolicyDocument.Statement);
const withoutNewsletter = () => shipped().filter((form) => form.kind !== "newsletter");

test("the shipped newsletter adds its routes with their own throttles, all on the intake API", () => {
  const { template, intake } = synthesize(shipped());
  const keys = resources(template, "AWS::ApiGatewayV2::Route")
    .map((route) => route.Properties.RouteKey)
    .sort();
  for (const key of [
    "POST /intake/newsletter/papyrus-newsletter-v1",
    "GET /intake/newsletter/confirm",
    "POST /intake/newsletter/confirm",
    "GET /intake/newsletter/unsubscribe",
    "POST /intake/newsletter/unsubscribe",
  ])
    assert.ok(keys.includes(key), key);
  const stage = resources(template, "AWS::ApiGatewayV2::Stage")[0];
  assert.deepEqual(stage.Properties.RouteSettings["POST /intake/newsletter/papyrus-newsletter-v1"], {
    ThrottlingBurstLimit: 2,
    ThrottlingRateLimit: 1,
  });
  for (const key of [
    "GET /intake/newsletter/confirm",
    "POST /intake/newsletter/confirm",
    "GET /intake/newsletter/unsubscribe",
    "POST /intake/newsletter/unsubscribe",
  ])
    assert.deepEqual(stage.Properties.RouteSettings[key], {
      ThrottlingBurstLimit: 4,
      ThrottlingRateLimit: 2,
    });
  const routeIds = Object.entries(template.findResources("AWS::ApiGatewayV2::Route"));
  for (const key of Object.keys(stage.Properties.RouteSettings)) {
    const id = routeIds.find(([, route]: [string, any]) => route.Properties.RouteKey === key)![0];
    assert.ok(stage.DependsOn.includes(id), `${key} must be in the stage's DependsOn`);
  }
  assert.deepEqual(unscopableRoutesWithScopes(template.toJSON()), []);
  const cors = resources(template, "AWS::ApiGatewayV2::Api")[0].Properties.CorsConfiguration;
  assert.deepEqual(cors.AllowMethods, ["POST"], "pages are navigations; CORS stays POST only");
  assert.equal(cors.AllowOrigins.filter((origin: string) => origin === "https://p.apyr.us").length, 1);
  assert.match(intake.newsletterBaseUrl!, /\/intake\/newsletter$/);
});

test("SES: a news.apyr.us identity with Easy DKIM and a custom MAIL FROM, and a configuration set that suppresses bounces and complaints", () => {
  const { template } = synthesize(shipped());
  template.resourceCountIs("AWS::SES::EmailIdentity", 1);
  template.resourceCountIs("AWS::SES::ConfigurationSet", 1);
  template.resourceCountIs("AWS::SES::ConfigurationSetEventDestination", 0);
  template.resourceCountIs("AWS::SNS::Topic", 0);
  template.resourceCountIs("AWS::SecretsManager::Secret", 0);
  const identity = resources(template, "AWS::SES::EmailIdentity")[0].Properties;
  assert.equal(identity.EmailIdentity, "news.apyr.us");
  assert.deepEqual(identity.DkimAttributes, { SigningEnabled: true });
  assert.deepEqual(identity.DkimSigningAttributes, { NextSigningKeyLength: "RSA_2048_BIT" });
  assert.deepEqual(identity.MailFromAttributes, {
    MailFromDomain: "bounce.news.apyr.us",
    BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
  });
  assert.ok(identity.ConfigurationSetAttributes.ConfigurationSetName);
  const set = resources(template, "AWS::SES::ConfigurationSet")[0].Properties;
  assert.equal(set.Name, "prospectus-newsletter");
  assert.deepEqual(set.SuppressionOptions, { SuppressedReasons: ["BOUNCE", "COMPLAINT"] });
  assert.deepEqual(set.ReputationOptions, { ReputationMetricsEnabled: true });
  assert.deepEqual(set.SendingOptions, { SendingEnabled: true });
});

test("DNS in the existing apyr.us zone: three DKIM CNAMEs, MAIL FROM MX and SPF, DMARC p=none; no zone is created", () => {
  const { template, stack } = synthesize(shipped());
  template.resourceCountIs("AWS::Route53::HostedZone", 0);
  const records = resources(template, "AWS::Route53::RecordSet").map((record) =>
    stack.resolve(record.Properties),
  );
  assert.equal(records.length, 6);
  for (const record of records) assert.equal(record.HostedZoneId, "Z0630882HVOV46S7IPV7");
  const cnames = records.filter((record) => record.Type === "CNAME");
  assert.equal(cnames.length, 3);
  for (const [index, cname] of cnames.entries()) {
    assert.match(JSON.stringify(cname.Name), new RegExp(`DkimDNSTokenName${index + 1}`));
    assert.match(JSON.stringify(cname.ResourceRecords), new RegExp(`DkimDNSTokenValue${index + 1}`));
  }
  const byName = (type: string, name: string) =>
    records.find((record) => record.Type === type && record.Name === name);
  assert.deepEqual(byName("MX", "bounce.news.apyr.us.")!.ResourceRecords, [
    "10 feedback-smtp.us-east-1.amazonses.com",
  ]);
  assert.deepEqual(byName("TXT", "bounce.news.apyr.us.")!.ResourceRecords, [
    '"v=spf1 include:amazonses.com ~all"',
  ]);
  assert.deepEqual(byName("TXT", "_dmarc.news.apyr.us.")!.ResourceRecords, ['"v=DMARC1; p=none"']);
  assert.ok(
    !records.some((record) => /^(apyr\.us|p\.apyr\.us)\.$/.test(record.Name)),
    "no existing name is touched",
  );
});

test("IAM: the intake role gains only send-as-the-list, the token parameter and the newsletter prefix; the initializer may only create the parameter", () => {
  const baseline = synthesize(withoutNewsletter());
  const { template } = synthesize(shipped());
  const roles = resources(template, "AWS::IAM::Role")
    .map((role) => role.Properties.RoleName)
    .sort();
  assert.deepEqual(roles, ["prospectus-intake-evaluation", "prospectus-newsletter-token-init"]);
  const before = statementsOf(baseline.template, "IntakeRole");
  const after = statementsOf(template, "IntakeRole");
  assert.ok(before.length > 0);
  const added = after.filter(
    (statement) => !before.some((old) => JSON.stringify(old) === JSON.stringify(statement)),
  );
  assert.equal(after.length - before.length, added.length, "no existing statement changed");
  assert.deepEqual(added, [
    {
      Action: "ses:SendEmail",
      Condition: { StringEquals: { "ses:FromAddress": [["papyrus", "news.apyr.us"].join("@")] } },
      Effect: "Allow",
      Resource: [
        "arn:aws:ses:us-east-1:712236451410:identity/news.apyr.us",
        "arn:aws:ses:us-east-1:712236451410:configuration-set/prospectus-newsletter",
      ],
    },
    {
      Action: ["s3:GetObject", "s3:PutObject"],
      Effect: "Allow",
      Resource:
        "arn:aws:s3:::prospectus-records-712236451410/_virtuus/cyclotron/prospectus/intake-newsletter/*",
    },
    {
      Action: "ssm:GetParameter",
      Effect: "Allow",
      Resource: "arn:aws:ssm:us-east-1:712236451410:parameter/prospectus/newsletter/token-signing/v1",
    },
  ]);
  const init = statementsOf(template, "TokenKeyInitializerRuntime");
  assert.deepEqual(
    init.map((statement: any) => [statement.Effect, statement.Action, statement.Condition ?? null]),
    [
      ["Allow", "ssm:PutParameter", null],
      ["Deny", "ssm:PutParameter", { StringEquals: { "ssm:Overwrite": "true" } }],
      ["Allow", ["logs:CreateLogStream", "logs:PutLogEvents"], null],
    ],
  );
  const json = JSON.stringify(template.toJSON());
  for (const forbidden of ["s3:ListBucket", "ses:*", "ses:SendRawEmail", "secretsmanager:", "iam:", "kms:"])
    assert.ok(!json.includes(forbidden), forbidden);
});

test("the token key is a retained create-only custom resource the runtime waits for", () => {
  const { template } = synthesize(shipped());
  const custom = Object.entries(template.findResources("Custom::ProspectusNewsletterTokenKey"));
  assert.equal(custom.length, 1);
  const [customId, resource] = custom[0] as [string, any];
  assert.equal(resource.Properties.ParameterName, "/prospectus/newsletter/token-signing/v1");
  assert.equal(resource.DeletionPolicy, "Retain");
  assert.equal(resource.UpdateReplacePolicy, "Retain");
  const functions = Object.entries(template.findResources("AWS::Lambda::Function")) as [string, any][];
  const initializer = functions.find(
    ([, fn]) => fn.Properties.FunctionName === "prospectus-newsletter-token-init",
  )!;
  assert.equal(initializer[1].Properties.Code.ZipFile, NEWSLETTER_TOKEN_SECRET_INITIALIZER_SOURCE);
  assert.match(NEWSLETTER_TOKEN_SECRET_INITIALIZER_SOURCE, /Overwrite: false/);
  assert.match(NEWSLETTER_TOKEN_SECRET_INITIALIZER_SOURCE, /NoEcho: true/);
  const runtime = functions.find(([, fn]) => fn.Properties.FunctionName === "prospectus-intake-evaluation")!;
  assert.ok(runtime[1].DependsOn.includes(customId), "the key exists before the runtime is updated");
  assert.equal(runtime[1].Properties.ReservedConcurrentExecutions, undefined);
  template.resourceCountIs("AWS::SSM::Parameter", 0);
  template.hasResourceProperties("AWS::Logs::LogGroup", {
    LogGroupName: "/aws/lambda/prospectus-newsletter-token-init",
    RetentionInDays: 30,
  });
});

test("the runtime environment stays under Lambda's 4 KB limit and carries no approval text", () => {
  const { template } = synthesize(shipped());
  const runtime = resources(template, "AWS::Lambda::Function").find(
    (fn) => fn.Properties.FunctionName === "prospectus-intake-evaluation",
  );
  const variables = runtime.Properties.Environment.Variables;
  const size = Object.entries(variables).reduce(
    (total, [key, value]) => total + key.length + String(value).length,
    0,
  );
  assert.ok(size < 4096, `environment is ${size} bytes`);
  const forms = JSON.parse(variables.PROSPECTUS_INTAKE_FORMS);
  assert.ok(forms.every((form: any) => form.approval === "Recorded in intake-forms.json."));
  // What the Lambda receives parses back into the same registry entries.
  assert.deepEqual(
    parseIntakeFormRegistry({ forms }).map((form) => form.formId),
    shipped().map((form) => form.formId),
  );
});

test("a disabled newsletter adds no route, origin, permission, mail domain, record or secret", () => {
  const newsletter = shipped().find((form) => form.kind === "newsletter")!;
  const baseline = synthesize(withoutNewsletter());
  const disabled = synthesize([...withoutNewsletter(), parseIntakeForm({ ...newsletter, enabled: false })]);
  assert.deepEqual(disabled.template.toJSON(), baseline.template.toJSON());
  assert.equal(disabled.intake.newsletterBaseUrl, undefined);
});
