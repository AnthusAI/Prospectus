import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import { DescribeOrganizationCommand, OrganizationsClient } from "@aws-sdk/client-organizations";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { AwsCostExplorerSource, COST_IMPORT_ROLE_NAME } from "./cost-import";

/**
 * Cost Explorer covers every linked account only from the Organizations management account, so the import assumes
 * the role `prospectus-cost-import` there (infra/lib/cost-management.ts). The management account is read from
 * Organizations at run time, so no account ID is configured or committed.
 */
const REGION = "us-east-1";

export function managementCostExplorer(): AwsCostExplorerSource {
  let client: Promise<CostExplorerClient> | undefined;
  const connect = async () => {
    const organization = await new OrganizationsClient({ region: REGION }).send(
      new DescribeOrganizationCommand({}),
    );
    const management = organization.Organization?.MasterAccountId;
    if (!management || !/^\d{12}$/.test(management)) throw new Error("cost_management_account_unknown");
    const sts = new STSClient({ region: REGION });
    const roleArn = `arn:aws:iam::${management}:role/${COST_IMPORT_ROLE_NAME}`;
    return new CostExplorerClient({
      region: REGION,
      credentials: async () => {
        const assumed = await sts.send(
          new AssumeRoleCommand({
            RoleArn: roleArn,
            RoleSessionName: "prospectus-cost-import",
            DurationSeconds: 900,
          }),
        );
        const credentials = assumed.Credentials;
        if (!credentials?.AccessKeyId || !credentials.SecretAccessKey)
          throw new Error("cost_role_unavailable");
        return {
          accessKeyId: credentials.AccessKeyId,
          secretAccessKey: credentials.SecretAccessKey,
          sessionToken: credentials.SessionToken,
          expiration: credentials.Expiration,
        };
      },
    });
  };
  return new AwsCostExplorerSource(
    async (command) => {
      // A failed connection is retried on the next run rather than cached.
      client ??= connect().catch((error) => {
        client = undefined;
        throw error;
      });
      return (await client).send(command as GetCostAndUsageCommand);
    },
    { GetCostAndUsageCommand },
  );
}
