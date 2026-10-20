// Local development against the deployed Prospectus backend: real Google sign-in through the
// deployed Cognito client, the deployed API and accounts service, and Vite's instant reload.
// Nothing is deployed. The deployed backend accepts this origin (LOCAL_DEV_ORIGIN in infra/lib/scope.ts).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AMPLIFY_APP_ID, DEPLOYMENT_BRANCH, LOCAL_DEV_ORIGIN, TARGET_REGION } from "../infra/lib/scope";

const outputDirectory = resolve(".build/cloud");
const outputs = resolve(outputDirectory, "amplify_outputs.json");

// The outputs are the same public identifiers the production bundle ships; they are cached in
// the ignored .build directory. Refresh after a backend change with `npm run dev:cloud -- --refresh`.
if (process.argv.includes("--refresh") || !existsSync(outputs)) {
  mkdirSync(outputDirectory, { recursive: true });
  console.log(`Reading ${DEPLOYMENT_BRANCH} backend outputs from Amplify app ${AMPLIFY_APP_ID}…`);
  const result = spawnSync(
    "npm",
    [
      "exec",
      "--prefix",
      "amplify",
      "--",
      "ampx",
      "generate",
      "outputs",
      "--app-id",
      AMPLIFY_APP_ID,
      "--branch",
      DEPLOYMENT_BRANCH,
      "--out-dir",
      outputDirectory,
    ],
    { stdio: "inherit", env: { ...process.env, AWS_REGION: TARGET_REGION } },
  );
  if (result.status !== 0)
    throw new Error(
      "Could not read the deployed outputs. Run `aws login` for papyrus-production and try again.",
    );
}

const { custom } = JSON.parse(readFileSync(outputs, "utf8")) as { custom?: Record<string, string> };
for (const key of ["ApiUrl", "UserPoolId", "ClientId", "CognitoDomainUrl"])
  if (!custom?.[key]) throw new Error(`The deployed outputs are missing ${key}. Refresh with --refresh.`);

const port = new URL(LOCAL_DEV_ORIGIN).port;
const vite = spawn(
  process.execPath,
  ["node_modules/vite/bin/vite.js", "--host", "localhost", "--port", port, "--strictPort"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      // The browser calls /api on localhost; vite.config.ts forwards it to the deployed API.
      PROSPECTUS_CLOUD_API_ORIGIN: new URL(custom!.ApiUrl).origin,
      VITE_KANBUS_API_URL: "",
      VITE_COGNITO_USER_POOL_ID: custom!.UserPoolId,
      VITE_COGNITO_CLIENT_ID: custom!.ClientId,
      VITE_COGNITO_DOMAIN_URL: custom!.CognitoDomainUrl,
      VITE_COGNITO_REDIRECT_URI: `${LOCAL_DEV_ORIGIN}/auth/callback`,
      VITE_COGNITO_LOGOUT_URI: `${LOCAL_DEV_ORIGIN}/`,
      VITE_ACCOUNTS_BFF_URL: custom!.AccountsBffUrl ? new URL(custom!.AccountsBffUrl).pathname : "",
      VITE_INTAKE_EVALUATION_URL: "",
    },
  },
);
console.log(`Prospectus against the deployed backend: ${LOCAL_DEV_ORIGIN}/ (real data; edits are real)`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => vite.kill(signal));
vite.once("exit", (code) => process.exit(code ?? 0));
