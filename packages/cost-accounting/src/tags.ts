/**
 * The Anthus cost tags (Prospectus docs/COST_ACCOUNTING.md, "The tagging standard"). Every AWS resource every app
 * creates carries them, and Prospectus reads each day's cost from Cost Explorer by `anthus:cost-key`. This module has
 * no dependencies so any build step can use it.
 */

/** Product families. Every Papyrus site is app `papyrus` with its site ID as the deployment. */
export const COST_APPS = ["papyrus", "cyclotron", "babulus", "chatticus", "prospectus"] as const;
export type CostApp = (typeof COST_APPS)[number];

export const TAG_ACCOUNT = "anthus:account";
export const TAG_APP = "anthus:app";
export const TAG_DEPLOYMENT = "anthus:deployment";
export const TAG_COST_KEY = "anthus:cost-key";
export const COST_TAG_KEYS = [TAG_ACCOUNT, TAG_APP, TAG_DEPLOYMENT, TAG_COST_KEY] as const;

/** The account value of a resource that serves many customers; its cost is split by reported usage. */
export const SHARED = "shared";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const DEPLOYMENT_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface CostTagConfiguration {
  /** The Prospectus Account UUID the resources serve, or "shared" for resources that serve many customers. */
  account: string;
  app: CostApp;
  /** Distinguishes several deployments of one app; for Papyrus, the site ID. */
  deployment?: string;
}

/** Validates a configuration and returns the four tags, or throws naming the bad field. */
export function costTags(configuration: CostTagConfiguration): Record<string, string> {
  const { account, app, deployment } = configuration;
  if (!(COST_APPS as readonly string[]).includes(app))
    throw new Error(`Cost tags: app must be one of ${COST_APPS.join(", ")}.`);
  if (account !== SHARED && !UUID.test(account))
    throw new Error('Cost tags: account must be a lower-case Prospectus Account UUID or "shared".');
  if (deployment !== undefined && !DEPLOYMENT_PATTERN.test(deployment))
    throw new Error("Cost tags: deployment must be lower-case letters, digits and hyphens.");
  return {
    [TAG_ACCOUNT]: account,
    [TAG_APP]: app,
    ...(deployment !== undefined ? { [TAG_DEPLOYMENT]: deployment } : {}),
    [TAG_COST_KEY]: `${account}/${app}/${deployment ?? ""}`,
  };
}

/** Splits a cost key back into its parts, or returns null if it is not one. */
export function parseCostKey(
  value: string,
): { account: string; app: CostApp; deployment: string | null } | null {
  const parts = value.split("/");
  if (parts.length !== 3) return null;
  const [account, app, deployment] = parts;
  try {
    costTags({ account, app: app as CostApp, ...(deployment ? { deployment } : {}) });
  } catch {
    return null;
  }
  return { account, app: app as CostApp, deployment: deployment || null };
}

/**
 * CloudFormation resource types that carry cost and accept tags. The CI check requires the cost tags on each of
 * these in a synthesized template. Extend the list when an app starts using another costly service.
 */
export const COSTED_RESOURCE_TYPES = [
  "AWS::Lambda::Function",
  "AWS::DynamoDB::Table",
  "AWS::DynamoDB::GlobalTable",
  "AWS::AppSync::GraphQLApi",
  "AWS::S3::Bucket",
  "AWS::SQS::Queue",
  "AWS::SNS::Topic",
  "AWS::Amplify::App",
  "AWS::ECS::Cluster",
  "AWS::ECS::Service",
  "AWS::ECS::TaskDefinition",
  "AWS::Batch::ComputeEnvironment",
  "AWS::Batch::JobQueue",
  "AWS::Batch::JobDefinition",
  "AWS::StepFunctions::StateMachine",
  "AWS::Logs::LogGroup",
  "AWS::CloudFront::Distribution",
  "AWS::ApiGateway::RestApi",
  "AWS::ApiGatewayV2::Api",
  "AWS::Kinesis::Stream",
  "AWS::EFS::FileSystem",
  "AWS::RDS::DBInstance",
  "AWS::RDS::DBCluster",
] as const;

export interface CostTagViolation {
  logicalId: string;
  type: string;
  missing: string[];
}

/** Reads a resource's tags whether CloudFormation spells them as a list of {Key, Value} or as a map. */
function tagsOf(resource: { Properties?: Record<string, unknown> }): Record<string, unknown> {
  const tags = resource.Properties?.Tags ?? resource.Properties?.UserPoolTags;
  if (Array.isArray(tags))
    return Object.fromEntries(
      tags.flatMap((tag) =>
        tag && typeof tag === "object" && "Key" in tag
          ? [[String(tag.Key), (tag as { Value: unknown }).Value]]
          : [],
      ),
    );
  if (tags && typeof tags === "object") return tags as Record<string, unknown>;
  return {};
}

/**
 * The CI check: every costed resource in a synthesized CloudFormation template carries `anthus:app`,
 * `anthus:account` and `anthus:cost-key`. Returns the violations; an empty list passes.
 */
export function checkCostTags(template: {
  Resources?: Record<string, { Type?: string; Properties?: Record<string, unknown> }>;
}): CostTagViolation[] {
  const violations: CostTagViolation[] = [];
  for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
    if (!resource.Type || !(COSTED_RESOURCE_TYPES as readonly string[]).includes(resource.Type)) continue;
    const tags = tagsOf(resource);
    const missing = [TAG_APP, TAG_ACCOUNT, TAG_COST_KEY].filter((key) => tags[key] === undefined);
    if (missing.length) violations.push({ logicalId, type: resource.Type, missing });
  }
  return violations;
}

/** Throws with a readable list if any costed resource is untagged. */
export function assertCostTags(template: Parameters<typeof checkCostTags>[0]): void {
  const violations = checkCostTags(template);
  if (violations.length)
    throw new Error(
      `Resources missing Anthus cost tags:\n${violations
        .map((violation) => `  ${violation.logicalId} (${violation.type}): ${violation.missing.join(", ")}`)
        .join("\n")}`,
    );
}
