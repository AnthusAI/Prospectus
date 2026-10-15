import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const configuration = JSON.parse(readFileSync("evaluation-deployment.json", "utf8"));
if (configuration.enabled) execFileSync("bash", ["infra/scripts/build-evaluation.sh"], { stdio: "inherit" });
