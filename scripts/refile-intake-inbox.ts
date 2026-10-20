/**
 * Operator retry of intake inbox items left pending. Run it yourself with your own AWS credentials
 * (the intake Lambda role has no ListBucket and is not used here).
 *
 *   AWS_PROFILE=papyrus-production \
 *   PROSPECTUS_INBOX_BUCKET=prospectus-records-712236451410 \
 *   PROSPECTUS_INBOX_CONTACT_MODE=real-contacts \
 *   node --import tsx scripts/refile-intake-inbox.ts            # counts only, writes nothing
 *   node --import tsx scripts/refile-intake-inbox.ts --apply    # file pending items into the CRM
 *
 * Output is counts only. Idempotent: filing uses the same identity claims and operation ids as live
 * submissions, so re-running never duplicates an inquiry.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  ControlConflict,
  type ConditionalControlStore,
  type ControlCondition,
} from "../server/control-store";
import { canonicalRequest } from "../server/canonical-invoke";
import { refileInbox } from "../server/inbox-refile";
import { intakeContactPolicyForMode } from "../server/intake-contact-policy";
import { parseIntakeFormRegistry } from "../server/intake-forms";

const exec = promisify(execFile);
const workspace = process.env.PROSPECTUS_INBOX_WORKSPACE ?? "cyclotron/prospectus";
const bucket = process.env.PROSPECTUS_INBOX_BUCKET ?? "";
const region = process.env.AWS_REGION ?? "us-east-1";
const functionName = process.env.PROSPECTUS_CANONICAL_FUNCTION ?? "prospectus-api";
const apply = process.argv.includes("--apply");
if (process.argv.slice(2).some((arg) => arg !== "--apply")) throw new Error("Only --apply is supported.");
if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error("Set PROSPECTUS_INBOX_BUCKET.");

const aws = async (...args: string[]) =>
  (await exec("aws", [...args, "--region", region], { maxBuffer: 64 * 1024 * 1024 })).stdout;
const prefix = `_virtuus/${workspace}/`;

class AwsCliControlStore implements ConditionalControlStore {
  async getControl(path: string) {
    const directory = await mkdtemp(join(tmpdir(), "prospectus-inbox-"));
    try {
      const file = join(directory, "object");
      const meta = JSON.parse(
        await aws("s3api", "get-object", "--bucket", bucket, "--key", prefix + path, file),
      ) as { ETag: string };
      return { bytes: await readFile(file, "utf8"), revision: meta.ETag };
    } catch (error) {
      if (/NoSuchKey/.test(String((error as { stderr?: string }).stderr))) return null;
      throw error;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  async putControl(path: string, bytes: string, condition: ControlCondition) {
    const directory = await mkdtemp(join(tmpdir(), "prospectus-inbox-"));
    try {
      const file = join(directory, "object");
      await writeFile(file, bytes, { mode: 0o600 });
      const guard = "absent" in condition ? ["--if-none-match", "*"] : ["--if-match", condition.revision];
      const meta = JSON.parse(
        await aws(
          "s3api",
          "put-object",
          "--bucket",
          bucket,
          "--key",
          prefix + path,
          "--body",
          file,
          "--content-type",
          "application/json",
          ...guard,
        ),
      ) as { ETag: string };
      return { bytes, revision: meta.ETag };
    } catch (error) {
      if (/PreconditionFailed|ConditionalRequestConflict/.test(String((error as { stderr?: string }).stderr)))
        throw new ControlConflict("Control revision changed.");
      throw error;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

const invoke = async (event: unknown) => {
  const directory = await mkdtemp(join(tmpdir(), "prospectus-invoke-"));
  try {
    await writeFile(join(directory, "event.json"), JSON.stringify(event), { mode: 0o600 });
    await aws(
      "lambda",
      "invoke",
      "--function-name",
      functionName,
      "--payload",
      `fileb://${join(directory, "event.json")}`,
      join(directory, "out.json"),
    );
    return JSON.parse(await readFile(join(directory, "out.json"), "utf8"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const listed = JSON.parse(
  await aws(
    "s3api",
    "list-objects-v2",
    "--bucket",
    bucket,
    "--prefix",
    `${prefix}intake-receipts/`,
    "--output",
    "json",
  ),
) as { Contents?: Array<{ Key: string }> } | null;
const paths = (listed?.Contents ?? []).map((object) => object.Key.slice(prefix.length));
const forms = parseIntakeFormRegistry(JSON.parse(await readFile("intake-forms.json", "utf8")));
const summary = await refileInbox({
  workspace,
  store: new AwsCliControlStore(),
  paths,
  request: canonicalRequest(invoke),
  forms,
  demoPolicy: intakeContactPolicyForMode(process.env.PROSPECTUS_INBOX_CONTACT_MODE),
  apply,
});
console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", ...summary }, null, 2));
