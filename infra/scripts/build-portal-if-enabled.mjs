import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";

// Builds dist-portal for CDK BucketDeployment when portal hosting is enabled. Runtime configuration
// (sign-in client identifiers, accounts BFF URL) comes from infra/scripts/write-portal-env.mjs, which owns
// the values; this script only decides where they go: .env.portal.local, read by `--mode portal`
// and never by the CRM build, so the two bundles cannot pick up each other's settings.
const { enabled } = JSON.parse(readFileSync("infra/portal-hosting.json", "utf8"));
if (enabled !== true) {
  console.log("Anthus One portal hosting is not enabled; skipping the portal build.");
  process.exit(0);
}
const generated = ".env.production.local";
const target = ".env.portal.local";
const displaced = `${generated}.displaced`;
if (existsSync(generated)) renameSync(generated, displaced);
try {
  execFileSync(process.execPath, ["infra/scripts/write-portal-env.mjs"], { stdio: "inherit" });
  renameSync(generated, target);
} finally {
  if (existsSync(displaced)) renameSync(displaced, generated);
}
try {
  execFileSync(
    "npx",
    ["vite", "build", "--config", "vite.portal.config.ts", "--mode", "portal", "--emptyOutDir"],
    { stdio: "inherit" },
  );
} finally {
  rmSync(target, { force: true });
}
for (const required of ["dist-portal/index.html", "dist-portal/assets"])
  if (!existsSync(required)) throw new Error(`Portal build did not produce ${required}`);
console.log("Built dist-portal for CDK publication.");
