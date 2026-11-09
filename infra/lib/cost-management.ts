import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as customResources from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import { COST_TAG_KEYS } from "../../packages/cost-accounting/src/tags";
import { COST_IMPORT_CALLER_ROLE_NAME, COST_IMPORT_ROLE_NAME } from "../../quota/cost-import";

export interface CostManagementProps {
  /** The Prospectus account whose central runtime runs the daily import. */
  prospectusAccount: string;
  /**
   * Activate the Anthus cost tags as cost allocation tags. AWS accepts a key only after it has appeared on billed
   * usage, so this stays off until the first app's tagged resources have been billed (about a day after tagging).
   */
  activateTags?: boolean;
}

/**
 * Cost accounting resources in the AWS Organizations management account (docs/COST_ACCOUNTING.md). Cost Explorer
 * covers every linked account only from there. This creates one role the Prospectus central runtime may assume to
 * read costs, and, once the tags exist on billed usage, activates the Anthus cost allocation tags. Nothing is set up
 * by hand.
 */
export class CostManagement extends Construct {
  readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: CostManagementProps) {
    super(scope, id);
    if (!/^\d{12}$/.test(props.prospectusAccount)) throw new Error("The Prospectus account is 12 digits.");
    this.role = new iam.Role(this, "CostImport", {
      roleName: COST_IMPORT_ROLE_NAME,
      description: "Lets the Prospectus central runtime read daily costs from Cost Explorer. Read only.",
      assumedBy: new iam.ArnPrincipal(
        `arn:${cdk.Aws.PARTITION}:iam::${props.prospectusAccount}:role/${COST_IMPORT_CALLER_ROLE_NAME}`,
      ),
      maxSessionDuration: cdk.Duration.hours(1),
      inlinePolicies: {
        ReadCosts: new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({ actions: ["ce:GetCostAndUsage"], resources: ["*"] })],
        }),
      },
    });
    if (props.activateTags) {
      const call: customResources.AwsSdkCall = {
        service: "CostExplorer",
        action: "UpdateCostAllocationTagsStatus",
        parameters: {
          CostAllocationTagsStatus: COST_TAG_KEYS.map((TagKey) => ({ TagKey, Status: "Active" })),
        },
        physicalResourceId: customResources.PhysicalResourceId.of("anthus-cost-allocation-tags"),
      };
      new customResources.AwsCustomResource(this, "ActivateCostTags", {
        onCreate: call,
        onUpdate: call,
        // Removing the stack leaves the tags active: deactivating them would silently stop cost attribution.
        policy: customResources.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({ actions: ["ce:UpdateCostAllocationTagsStatus"], resources: ["*"] }),
        ]),
        installLatestAwsSdk: false,
      });
    }
  }
}
