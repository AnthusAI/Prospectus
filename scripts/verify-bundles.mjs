// Run after `npm run build`: the staff console bundle (dist) and the portal bundle (dist-portal) must not share application code.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Literal strings that live only in the named staff console modules and survive minification.
const STAFF_ONLY = {
  "src/App.tsx": "Workspace settings for Prospectus will live here.",
  "src/AccountsView.tsx": "Needs billing data",
  "src/admin/PipelineView.tsx": "Reply and book an intro call",
  "src/admin/TodayView.tsx": "ACCOUNTS TO WATCH",
  "src/IntakeForm.tsx": "Send demo inquiry",
  "src/client.ts": "Sign in to access this workspace.",
};
// Literal strings that live only in the portal modules.
const PORTAL_ONLY = {
  "src/portal/PortalShell.tsx": "Contact Anthus",
  "src/portal/pages.tsx": "Deleting a workspace is not offered here. Ask Anthus.",
};

function files(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

function bundle(directory) {
  if (!existsSync(directory)) throw new Error(`${directory} is missing; run npm run build first.`);
  return files(directory)
    .filter((file) => /\.(js|html|css)$/.test(file))
    .map((file) => ({ file, text: readFileSync(file, "utf8") }));
}

const failures = [];
function expectAbsent(directory, markers, label) {
  const contents = bundle(directory);
  for (const [module, marker] of Object.entries(markers))
    for (const { file, text } of contents)
      if (text.includes(marker)) failures.push(`${file} contains ${label} ${module} ("${marker}")`);
}
function expectPresent(directory, markers) {
  const contents = bundle(directory);
  for (const [module, marker] of Object.entries(markers))
    if (!contents.some(({ text }) => text.includes(marker)))
      failures.push(`${directory} lacks ${module} ("${marker}"); the marker is stale`);
}

expectPresent("dist", STAFF_ONLY);
expectPresent("dist-portal", PORTAL_ONLY);
expectAbsent("dist-portal", STAFF_ONLY, "staff console module");
expectAbsent("dist", PORTAL_ONLY, "portal module");
if (bundle("dist").some(({ file, text }) => file.endsWith(".html") && text.includes("/src/portal/")))
  failures.push("dist has a portal entry page");
if (existsSync(join("dist", "portal"))) failures.push("dist contains a portal directory");

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("Bundles are separate: dist-portal has no staff console modules and dist has no portal entry.");
