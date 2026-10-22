/**
 * Operator export of confirmed newsletter subscribers. Run it yourself with your own AWS credentials
 * (read only: it lists and reads the newsletter control prefix and the SES account suppression list).
 *
 *   AWS_PROFILE=papyrus-production \
 *   PROSPECTUS_NEWSLETTER_BUCKET=prospectus-records-712236451410 \
 *   node --import tsx scripts/export-newsletter-subscribers.ts                     # counts only
 *   node --import tsx scripts/export-newsletter-subscribers.ts --list papyrus-newsletter-v1 \
 *     --output ~/papyrus-subscribers.csv                                           # also writes a CSV (mode 600)
 *
 * Standard output is counts per list and status only, never an address. The CSV holds the confirmed
 * subscribers who have not unsubscribed and are not on the SES suppression list (hard bounces and
 * complaints), with their consent times. Treat it as personal data and delete it after use.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ConditionalControlStore } from "../server/control-store";
import { exportSubscribers, toCsv } from "../server/newsletter-export";

const exec = promisify(execFile);
const workspace = process.env.PROSPECTUS_NEWSLETTER_WORKSPACE ?? "cyclotron/prospectus";
const bucket = process.env.PROSPECTUS_NEWSLETTER_BUCKET ?? "";
const region = process.env.AWS_REGION ?? "us-east-1";
const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
if (
  args.length % 2 !== 0 ||
  args.some((arg, index) => (index % 2 === 0 ? !["--list", "--output"].includes(arg) : arg.startsWith("--")))
)
  throw new Error("Only --list <listId> and --output <file> are supported.");
const listId = option("--list");
const output = option("--output");
if (listId !== undefined && !/^[a-z0-9][a-z0-9-]{1,63}$/.test(listId)) throw new Error("Invalid --list.");
if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error("Set PROSPECTUS_NEWSLETTER_BUCKET.");

const aws = async (...command: string[]) =>
  (await exec("aws", [...command, "--region", region], { maxBuffer: 64 * 1024 * 1024 })).stdout;
const prefix = `_virtuus/${workspace}/`;

const store: Pick<ConditionalControlStore, "getControl"> = {
  async getControl(path: string) {
    const directory = await mkdtemp(join(tmpdir(), "prospectus-newsletter-"));
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
  },
};

const paths: string[] = [];
let token: string | undefined;
do {
  const page = JSON.parse(
    await aws(
      "s3api",
      "list-objects-v2",
      "--bucket",
      bucket,
      "--prefix",
      `${prefix}intake-newsletter/`,
      "--output",
      "json",
      ...(token ? ["--continuation-token", token] : []),
    ),
  ) as { Contents?: Array<{ Key: string }>; NextContinuationToken?: string } | null;
  paths.push(...(page?.Contents ?? []).map((object) => object.Key.slice(prefix.length)));
  token = page?.NextContinuationToken;
} while (token);

const suppressed = new Set<string>();
let next: string | undefined;
do {
  const page = JSON.parse(
    await aws(
      "sesv2",
      "list-suppressed-destinations",
      "--output",
      "json",
      ...(next ? ["--next-token", next] : []),
    ),
  ) as { SuppressedDestinationSummaries?: Array<{ EmailAddress: string }>; NextToken?: string };
  for (const item of page.SuppressedDestinationSummaries ?? [])
    suppressed.add(item.EmailAddress.toLowerCase());
  next = page.NextToken;
} while (next);

const summary = await exportSubscribers({
  workspace,
  store: store as ConditionalControlStore,
  paths,
  suppressed,
  ...(listId ? { listId } : {}),
});
if (output) await writeFile(output, toCsv(summary.rows), { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ counts: summary.counts, exported: output ? summary.rows.length : 0 }, null, 2));
