import { readFileSync, writeFileSync } from "node:fs";
const { domain, signIn } = JSON.parse(readFileSync("infra/portal-app.json", "utf8"));
for (const key of ["cognitoDomainUrl", "clientId", "accountsBffUrl"])
  if (typeof signIn?.[key] !== "string" || !signIn[key])
    throw new Error(`Missing portal sign-in setting ${key}`);
const origin = `https://${domain}`;
const values = {
  VITE_COGNITO_CLIENT_ID: signIn.clientId,
  VITE_COGNITO_DOMAIN_URL: signIn.cognitoDomainUrl,
  VITE_COGNITO_REDIRECT_URI: `${origin}/auth/callback`,
  VITE_COGNITO_LOGOUT_URI: `${origin}/`,
  VITE_ACCOUNTS_BFF_URL: signIn.accountsBffUrl,
};
writeFileSync(
  ".env.production.local",
  Object.entries(values)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("\n") + "\n",
);
