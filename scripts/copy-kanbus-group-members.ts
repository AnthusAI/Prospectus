/** Operator script (kanbus-0ec206 phase A): copies every member of `prospectus-members` into
 * `kanbus:cyclotron/prospectus` so the multi-board Kanbus API admits the same people.
 * Run with the operator's own AWS credentials. Dry run by default; `--apply` writes.
 * Idempotent: existing members are skipped. Output has counts and sha256 prefixes of usernames only.
 *
 *   PROSPECTUS_USER_POOL_ID=us-east-1_xxxx node --import tsx scripts/copy-kanbus-group-members.ts [--apply]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const SOURCE_GROUP = "prospectus-members";
const TARGET_GROUP = "kanbus:cyclotron/prospectus";
const args = process.argv.slice(2);
if (args.some((argument) => argument !== "--apply")) throw new Error("Only --apply is supported.");
const apply = args.includes("--apply");
const poolId = process.env.PROSPECTUS_USER_POOL_ID ?? "";
if (!/^[\w-]+_[0-9a-zA-Z]+$/.test(poolId))
  throw new Error("Set PROSPECTUS_USER_POOL_ID to the Cognito user pool id.");
const region = process.env.AWS_REGION ?? "us-east-1";

function cognito(...command: string[]): unknown {
  const output = execFileSync("aws", ["cognito-idp", ...command, "--region", region, "--output", "json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return output.trim() ? JSON.parse(output) : {};
}

function members(group: string): string[] {
  const result = cognito("list-users-in-group", "--user-pool-id", poolId, "--group-name", group) as {
    Users?: { Username: string }[];
  };
  return (result.Users ?? []).map((user) => user.Username);
}

const label = (username: string) => createHash("sha256").update(username).digest("hex").slice(0, 8);
const source = members(SOURCE_GROUP);
let targetExists = true;
try {
  cognito("get-group", "--user-pool-id", poolId, "--group-name", TARGET_GROUP);
} catch {
  targetExists = false;
}
if (!targetExists && apply) throw new Error(`Group ${TARGET_GROUP} does not exist; deploy phase A first.`);
const existing = new Set(targetExists ? members(TARGET_GROUP) : []);
const missing = source.filter((username) => !existing.has(username));
const added: string[] = [];
const failed: string[] = [];
if (apply)
  for (const username of missing) {
    try {
      cognito(
        "admin-add-user-to-group",
        "--user-pool-id",
        poolId,
        "--group-name",
        TARGET_GROUP,
        "--username",
        username,
      );
      added.push(username);
    } catch {
      failed.push(username);
    }
  }
console.log(
  JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    source: SOURCE_GROUP,
    target: TARGET_GROUP,
    targetExists,
    sourceMembers: source.length,
    alreadyInTarget: source.length - missing.length,
    toAdd: apply ? undefined : missing.length,
    toAddUsernames: apply ? undefined : missing.map(label),
    added: apply ? added.length : undefined,
    addedUsernames: apply ? added.map(label) : undefined,
    failed: apply ? failed.length : undefined,
    failedUsernames: apply ? failed.map(label) : undefined,
  }),
);
if (failed.length) process.exitCode = 1;
