import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const portal = JSON.parse(readFileSync("infra/portal-app.json", "utf8"));
const isPortal = Boolean(portal.appId) && process.env.AWS_APP_ID === portal.appId;
if (
  process.env.AWS_REGION !== "us-east-1" ||
  !(process.env.AWS_APP_ID === "d15sc1sptohtqb" || isPortal) ||
  process.env.AWS_BRANCH !== "main"
)
  throw new Error(
    "Build must target the approved Prospectus or Anthus One portal app main branch in us-east-1",
  );
mkdirSync(".build", { recursive: true });
if (isPortal) {
  writeFileSync(".build/deployment.env", "export PROSPECTUS_APP=portal\n");
  console.log("Verified the Anthus One portal app and main branch; building the portal frontend only.");
} else {
  const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
  const identity = await new STSClient({ region: "us-east-1" }).send(new GetCallerIdentityCommand({}));
  if (identity.Account !== "712236451410")
    throw new Error("Build credentials are outside papyrus-production");
  writeFileSync(
    ".build/deployment.env",
    "export CDK_DEFAULT_ACCOUNT=712236451410\nexport CDK_DEFAULT_REGION=us-east-1\nexport PROSPECTUS_APP=prospectus\n",
  );
  console.log("Verified Prospectus deployment account, region, app and main branch.");
}
