import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { mkdirSync, writeFileSync } from "node:fs";
if (process.env.AWS_REGION !== "us-east-1" || process.env.AWS_APP_ID !== "d15sc1sptohtqb" || process.env.AWS_BRANCH !== "main") throw new Error("Build must target the approved Prospectus app main branch in us-east-1");
const identity = await new STSClient({ region: "us-east-1" }).send(new GetCallerIdentityCommand({}));
if (identity.Account !== "712236451410") throw new Error("Build credentials are outside papyrus-production");
mkdirSync(".build", { recursive: true });
writeFileSync(".build/deployment.env", "export CDK_DEFAULT_ACCOUNT=712236451410\nexport CDK_DEFAULT_REGION=us-east-1\n");
console.log("Verified Prospectus deployment account, region, app and main branch.");
