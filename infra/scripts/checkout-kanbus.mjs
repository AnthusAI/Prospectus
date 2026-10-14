import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const lock = JSON.parse(readFileSync("source-lock.json", "utf8"));
for (const [name, repository] of [["kanbus", "AnthusAI/Kanbus"], ["virtuus", "AnthusAI/Virtuus"]]) {
  const entry = lock[name];
  if (entry?.repository !== repository || !/^[0-9a-f]{40}$/.test(entry?.revision ?? "")) {
    throw new Error(`source-lock.json ${name} must identify ${repository} at a reviewed full commit SHA; moving branches and placeholders cannot build a release.`);
  }
}
const destination = resolve(".build/kanbus");
const run = (...args) => execFileSync("git", args, { stdio: "inherit" });
if (existsSync(destination)) {
  const revision = execFileSync("git", ["-C", destination, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["-C", destination, "status", "--porcelain"], { encoding: "utf8" }).trim();
  if (revision !== lock.kanbus.revision || dirty) throw new Error("Existing .build/kanbus must be clean and match source-lock.json exactly.");
} else {
  run("init", destination);
  run("-C", destination, "remote", "add", "origin", `https://github.com/${lock.kanbus.repository}.git`);
  run("-C", destination, "fetch", "--depth", "1", "origin", lock.kanbus.revision);
  run("-C", destination, "checkout", "--detach", "FETCH_HEAD");
}
const actual = execFileSync("git", ["-C", destination, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (actual !== lock.kanbus.revision) throw new Error("Fetched Kanbus revision does not match the source lock.");
const manifest = readFileSync(resolve(destination, "services/kanbus-api/Cargo.toml"), "utf8");
if (!manifest.includes(lock.virtuus.revision)) throw new Error("Kanbus API must pin the source-lock.json Virtuus revision in Cargo.toml.");
console.log(`Verified Kanbus ${actual} and Virtuus ${lock.virtuus.revision}.`);
