import { accountsBffHandler } from "./bff";
import { CognitoKeys, type ProductRegistration } from "./auth";
import { serverAccountsClient } from "../packages/accounts-client/src/server";
import { APP_ORIGINS } from "../infra/lib/scope";
const registration: ProductRegistration = JSON.parse(process.env.PROSPECTUS_DIRECTORY_REGISTRATION ?? "null");
if (!registration) throw new Error("Directory runtime registration required.");
const keys = new CognitoKeys();
export const handler = accountsBffHandler({
  origins: APP_ORIGINS,
  registration,
  keys: (issuer, kid) => keys.resolve(issuer, kid),
  client: (human, id) =>
    serverAccountsClient({
      endpoint: process.env.PROSPECTUS_CENTRAL_ENDPOINT ?? "",
      region: "us-east-1",
      humanToken: () => human ?? "",
      identityToken: () => id ?? "",
    }),
});
