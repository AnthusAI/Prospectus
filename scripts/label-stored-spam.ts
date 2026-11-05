/**
 * Labels stored prospects likely-spam with the current rules. Run it yourself with your own AWS credentials.
 *
 *   AWS_PROFILE=papyrus-production node --import tsx scripts/label-stored-spam.ts            # writes nothing
 *   AWS_PROFILE=papyrus-production node --import tsx scripts/label-stored-spam.ts --apply
 *
 * Output is counts and ids only. Running it again changes nothing. See docs/INTAKE_SPAM.md.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { canonicalRequest } from "../server/canonical-invoke";
import { labelStoredSpam } from "../server/stored-spam";

const exec = promisify(execFile);
const apply = process.argv.includes("--apply");
if (process.argv.slice(2).some((arg) => arg !== "--apply")) throw new Error("Only --apply is supported.");
const region = process.env.AWS_REGION ?? "us-east-1";
const functionName = process.env.PROSPECTUS_CANONICAL_FUNCTION ?? "prospectus-api";

const invoke = async (event: unknown) => {
  const directory = await mkdtemp(join(tmpdir(), "prospectus-invoke-"));
  try {
    await writeFile(join(directory, "event.json"), JSON.stringify(event), { mode: 0o600 });
    await exec(
      "aws",
      [
        "lambda",
        "invoke",
        "--function-name",
        functionName,
        "--payload",
        `fileb://${join(directory, "event.json")}`,
        join(directory, "out.json"),
        "--region",
        region,
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    return JSON.parse(await readFile(join(directory, "out.json"), "utf8"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const summary = await labelStoredSpam({
  request: canonicalRequest(invoke),
  workspace: process.env.PROSPECTUS_INBOX_WORKSPACE ?? "cyclotron/prospectus",
  initialStatus: "new",
  apply,
});
console.log(
  JSON.stringify(
    {
      mode: apply ? "apply" : "dry-run",
      scanned: summary.scanned,
      count: summary.labelled.length,
      ids: summary.labelled,
    },
    null,
    2,
  ),
);
