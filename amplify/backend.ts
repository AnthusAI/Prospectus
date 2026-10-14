import { Code } from "aws-cdk-lib/aws-lambda";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { createProspectusBackend } from "./create-backend";
const artifact = resolve(".artifacts/backend/bootstrap.zip");
if (!existsSync(artifact)) throw new Error("Build the reviewed source-locked Rust Lambda before Amplify deployment");
createProspectusBackend(() => Code.fromAsset(artifact));
