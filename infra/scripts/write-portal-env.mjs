import { readFileSync, writeFileSync } from "node:fs";
const { signIn } = JSON.parse(readFileSync("infra/portal-app.json", "utf8"));
// The portal signs in with Google directly: the client ID is public and there is no secret or Cognito setting.
if (!/^[0-9]{6,20}-[a-z0-9]{1,64}\.apps\.googleusercontent\.com$/.test(signIn?.googleClientId ?? ""))
  throw new Error("Missing portal sign-in setting googleClientId");
if (typeof signIn.accountsBffUrl !== "string")
  throw new Error("Missing portal sign-in setting accountsBffUrl");
// The accounts API URL exists only after the backend deploys (CDK output AnthusOneBffUrl). Until it is recorded
// here the portal builds and says the account service is not configured.
if (!signIn.accountsBffUrl)
  console.warn("infra/portal-app.json accountsBffUrl is empty: record the AnthusOneBffUrl deploy output.");
else if (
  !/^https:\/\/[a-z0-9]+\.execute-api\.[a-z0-9-]+\.amazonaws\.com\/api\/saas$/.test(signIn.accountsBffUrl)
)
  throw new Error("accountsBffUrl must be the AnthusOneBffUrl deploy output");
const values = {
  VITE_GOOGLE_CLIENT_ID: signIn.googleClientId,
  VITE_ACCOUNTS_BFF_URL: signIn.accountsBffUrl,
};
writeFileSync(
  ".env.production.local",
  Object.entries(values)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("\n") + "\n",
);
