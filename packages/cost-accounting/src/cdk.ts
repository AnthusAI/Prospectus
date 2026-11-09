import { Tags } from "aws-cdk-lib";
import type { IConstruct } from "constructs";
import { costTags, type CostTagConfiguration } from "./tags.js";

export * from "./tags.js";

/**
 * Applies the Anthus cost tags to every taggable resource under `scope` (usually a whole stack), from the stack's
 * own configuration, so nobody tags by hand. Throws at synthesis on an invalid configuration. Existing tags such as
 * `anthus:project` are left alone.
 *
 * ```ts
 * applyCostTags(stack, { account: config.accountId, app: "papyrus", deployment: config.siteId });
 * applyCostTags(sharedStack, { account: "shared", app: "cyclotron" });
 * ```
 */
export function applyCostTags(
  scope: IConstruct,
  configuration: CostTagConfiguration,
): Record<string, string> {
  const tags = costTags(configuration);
  for (const [key, value] of Object.entries(tags)) Tags.of(scope).add(key, value);
  return tags;
}
