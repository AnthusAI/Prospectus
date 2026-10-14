import { resolve } from "node:path";
import { CfnParameter } from "../../amplify/node_modules/aws-cdk-lib";
import { Code } from "../../amplify/node_modules/aws-cdk-lib/aws-lambda";
import { createProspectusBackend } from "../../amplify/create-backend";
process.env.CDK_DEFAULT_ACCOUNT = "682849160744";
process.env.CDK_DEFAULT_REGION = "us-east-1";
process.env.CDK_OUTDIR = resolve(".artifacts/amplify-review");
process.env.CDK_CONTEXT_JSON = JSON.stringify({
 "amplify-backend-namespace": "dnfou6dg4d6x2",
 "amplify-backend-name": "proof",
 "amplify-backend-type": "branch",
});
const backend = createProspectusBackend(stack => Code.fromCfnParameters({
 bucketNameParam: new CfnParameter(stack, "ReviewedArtifactBucket", { type: "String" }),
 objectKeyParam: new CfnParameter(stack, "ReviewedArtifactKey", { type: "String" }),
}));
console.log(`Verified Gen2 root ${backend.stack.stackName}; isolated artifact and deployment roles.`);
process.emit("message", "amplifySynth", undefined);
