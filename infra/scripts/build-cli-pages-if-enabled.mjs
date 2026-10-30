import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

// Builds .artifacts/cli-pages (prospectus_cli plus the hash-pinned cli-login) when remote CLI sign-in is enabled
// in infra/cli-sign-in.json. The builder is standard-library Python, so the Node build image needs no pip.
const { enabled } = JSON.parse(readFileSync("infra/cli-sign-in.json", "utf8"));
if (enabled !== true) {
  console.log("Remote CLI sign-in is not enabled; skipping the pages build.");
  process.exit(0);
}
execFileSync("python3", ["-I", "cli/build_pages.py", ".artifacts/cli-pages"], { stdio: "inherit" });
if (!existsSync(".artifacts/cli-pages/prospectus_cli/pages.py"))
  throw new Error("The CLI pages build did not produce prospectus_cli/pages.py");
