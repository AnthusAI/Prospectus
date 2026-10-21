import { accountsBffHandler } from "./bff";
import { CognitoKeys, type ProductRegistration } from "./auth";
import { GOOGLE_ISSUER, GoogleKeys } from "./google-direct";
import { serverAccountsClient } from "../packages/accounts-client/src/server";
import { APP_ORIGINS, PORTAL_ORIGINS } from "../infra/lib/scope";
const registration: ProductRegistration = JSON.parse(process.env.PROSPECTUS_DIRECTORY_REGISTRATION ?? "null");
if (!registration) throw new Error("Directory runtime registration required.");
const keys = new CognitoKeys();
const googleKeys = new GoogleKeys();
// The same bundle serves two deployments: the staff Accounts BFF and the Anthus One customer BFF.
const surface = process.env.PROSPECTUS_BFF_SURFACE === "customer" ? "customer" : "staff";
export const handler = accountsBffHandler({
  surface,
  origins: surface === "customer" ? PORTAL_ORIGINS : APP_ORIGINS,
  registration,
  keys: (issuer, kid) =>
    issuer === GOOGLE_ISSUER ? googleKeys.resolve(issuer, kid) : keys.resolve(issuer, kid),
  client: (human, id) =>
    serverAccountsClient({
      endpoint: process.env.PROSPECTUS_CENTRAL_ENDPOINT ?? "",
      region: "us-east-1",
      humanToken: () => human ?? "",
      identityToken: () => id ?? "",
    }),
});
