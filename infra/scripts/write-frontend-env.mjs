import { readFileSync, writeFileSync } from "node:fs";
const { custom } = JSON.parse(readFileSync("amplify_outputs.json", "utf8"));
const required = ["ApiUrl", "UserPoolId", "ClientId", "CognitoDomainUrl"];
for (const key of required) if (typeof custom?.[key] !== "string" || !custom[key]) throw new Error(`Missing Amplify output ${key}`);
const values = {
 VITE_KANBUS_API_URL: custom.ApiUrl,
 VITE_COGNITO_USER_POOL_ID: custom.UserPoolId,
 VITE_COGNITO_CLIENT_ID: custom.ClientId,
 VITE_COGNITO_DOMAIN_URL: custom.CognitoDomainUrl,
 VITE_COGNITO_REDIRECT_URI: "https://prospectus.cyclotron.anth.us/auth/callback",
 VITE_COGNITO_LOGOUT_URI: "https://prospectus.cyclotron.anth.us/",
};
writeFileSync(".env.production.local", Object.entries(values).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join("\n") + "\n");
