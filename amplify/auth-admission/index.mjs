import { CognitoIdentityProviderClient, DescribeUserPoolCommand, ListUsersCommand, AdminListGroupsForUserCommand, AdminLinkProviderForUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { createAdmissionHandler } from "./admission.mjs";
// Node.js 22 Lambda includes AWS SDK v3. No OAuth secret is read by this function.
const client = new CognitoIdentityProviderClient({ region: "us-east-1" });
export const handler = createAdmissionHandler({
  describePool: async (UserPoolId) => (await client.send(new DescribeUserPoolCommand({ UserPoolId }))).UserPool,
  findUsers: (UserPoolId, email) => client.send(new ListUsersCommand({ UserPoolId, Filter: `email = "${email}"`, Limit: 2 })),
  listGroups: (UserPoolId, Username) => client.send(new AdminListGroupsForUserCommand({ UserPoolId, Username, Limit: 60 })),
  link: (UserPoolId, username, subject) => client.send(new AdminLinkProviderForUserCommand({
    UserPoolId,
    DestinationUser: { ProviderName: "Cognito", ProviderAttributeValue: username },
    SourceUser: { ProviderName: "Google", ProviderAttributeName: "Cognito_Subject", ProviderAttributeValue: subject },
  })),
});
