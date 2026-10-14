import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { ProspectusBackend } from "../lib/prospectus-backend";
import { TARGET_ACCOUNT, TARGET_REGION } from "../lib/scope";
const app = new cdk.App();
const stack = new cdk.Stack(app, "ProspectusBackendReview", { env: { account: TARGET_ACCOUNT, region: TARGET_REGION } });
// Review template only: no code is uploaded and no dummy executable exists.
const bucket = new cdk.CfnParameter(stack, "ReviewedArtifactBucket", { type: "String" });
const key = new cdk.CfnParameter(stack, "ReviewedArtifactKey", { type: "String" });
const backend = new ProspectusBackend(stack, "Prospectus", lambda.Code.fromCfnParameters({ bucketNameParam: bucket, objectKeyParam: key }));
for (const [name, value] of Object.entries(backend.outputs)) new cdk.CfnOutput(stack, name, { value });
