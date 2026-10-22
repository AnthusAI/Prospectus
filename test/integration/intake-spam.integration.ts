import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { FileControlStore } from "../../server/control-store";
import { IntakeError, IntakeService, type IntakeOptions } from "../../server/intake";
import { REAL_CONTACT_POLICY } from "../../server/intake-contact-policy";
import { scoreInquiry, type SpamLabelling } from "../../server/intake-spam";
import type { Configuration, IssueRecord } from "../../src/client";
import { spamReviewChanges } from "../../src/spam-review";
import { BOT_SHAPED, exampleMailRules } from "../fixtures/intake-spam";

test("real Kanbus persistence: spam results, likely-spam filing, honeypot capture, shadow mode, and revisioned Not spam / Spam corrections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prospectus-spam-api-"));
  const root = join(directory, "kanbus");
  await mkdir(join(root, "project/issues"), { recursive: true });
  await mkdir(join(root, "project/events"), { recursive: true });
  await writeFile(join(root, ".kanbus.yml"), await readFile("config/prospectus.kanbus.yml"));
  const token = randomBytes(32).toString("hex");
  const child = spawn(
    resolve(process.env.KANBUS_API_BINARY ?? ".build/target/release/kanbus-api-local"),
    [],
    {
      env: {
        ...process.env,
        KANBUS_BACKEND: "file",
        KANBUS_ROOT: root,
        KANBUS_TENANT: "test",
        KANBUS_PROJECT: "prospectus",
        KANBUS_PORT: "0",
        KANBUS_LOCAL_TOKEN: token,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const services: IntakeService[] = [];
  try {
    const api = await new Promise<string>((resolveApi, reject) => {
      const timeout = setTimeout(() => reject(new Error("Real Kanbus API did not start")), 10000);
      child.once("error", reject);
      child.once("exit", () => reject(new Error("Real Kanbus API exited before readiness")));
      child.stderr.on("data", (data: Buffer) => {
        const match = data.toString().match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolveApi(`${match[0]}/test/prospectus/api`);
        }
      });
    });
    const request = async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token}`);
      const response = await fetch(`${api}${path}`, { ...init, headers });
      if (!response.ok) {
        const failure = (await response.json()) as { error?: string };
        throw new IntakeError(response.status, "Private API rejected the operation", failure.error);
      }
      return response.json();
    };
    const open = async (spamLabelling: SpamLabelling) => {
      const service = await IntakeService.open({
        directory: join(directory, `intake-${spamLabelling}-${services.length}`),
        workspace: "test/prospectus",
        owner: "intake-queue",
        siteId: REAL_CONTACT_POLICY.siteId,
        formId: REAL_CONTACT_POLICY.formId,
        contactPolicy: REAL_CONTACT_POLICY,
        identityStore: new FileControlStore(join(directory, "shared-identity")),
        request: request as IntakeOptions["request"],
        now: () => new Date("2026-10-16T10:00:00Z"),
        log: () => undefined,
        spamLabelling,
        // Test data uses @example.com only; these rules treat it like gmail.com.
        spamScorer: (input) => scoreInquiry(input, exampleMailRules),
      });
      services.push(service);
      return service;
    };
    const contact = (changes: Record<string, unknown> = {}) => ({
      submission_id: randomUUID(),
      name: "Alex Example",
      email: "alex@example.com",
      company: "Example Studio",
      message: "Please show the Papyrus demo to our contracts team.",
      website: "",
      notice_version: "contact-v1",
      marketing_opt_in: false,
      page_path: "/engage",
      campaign: {},
      ...changes,
    });
    const find = async (email: string) => {
      const fields = JSON.stringify([{ field: "custom.contact_email", operator: "eq", value: email }]);
      const page = (await request(`/issues?type=prospect&fields=${encodeURIComponent(fields)}`)) as {
        issues: IssueRecord[];
      };
      assert.equal(page.issues.length, 1, email);
      return (await request(`/issues/${page.issues[0].issue.id}`)) as IssueRecord;
    };

    const labelled = await open("label");
    const bot = contact({
      name: BOT_SHAPED.name,
      email: BOT_SHAPED.email,
      company: BOT_SHAPED.company,
      message: BOT_SHAPED.message,
      elapsed_ms: 2500,
    });
    assert.deepEqual(await labelled.submit(bot), {
      receipt: bot.submission_id,
      message: "Demo request received.",
    });
    let record = await find(BOT_SHAPED.email);
    assert.deepEqual(record.issue.labels, ["likely-spam"]);
    assert.equal(record.issue.custom!.next_follow_up_at ?? null, null);
    assert.equal(record.issue.custom!.spam_status, "likely_spam");
    const inquiry = (record.issue.custom!.inquiries as any[])[0];
    assert.equal(inquiry.spam_score, 0.784);
    assert.equal(inquiry.spam_verdict, "likely_spam");
    assert.equal(inquiry.spam_rules_version, "intake-spam-rules-1");
    assert.deepEqual(inquiry.form_signals, { elapsed_ms: 2500 });

    const honeypot = contact({ email: "honeypot@example.com", website: "filled-by-a-bot" });
    assert.deepEqual(await labelled.submit(honeypot), {
      receipt: honeypot.submission_id,
      message: "Demo request received.",
    });
    const trapped = await find("honeypot@example.com");
    assert.deepEqual(trapped.issue.labels, ["likely-spam"]);
    assert.deepEqual((trapped.issue.custom!.inquiries as any[])[0].spam_reasons, ["honeypot"]);
    assert.equal(JSON.stringify(trapped).includes("filled-by-a-bot"), false);

    const shadow = await open("shadow");
    await shadow.submit(contact({ ...bot, submission_id: randomUUID(), email: "shadow@example.com" }));
    const shadowed = await find("shadow@example.com");
    assert.deepEqual(shadowed.issue.labels ?? [], []);
    assert.equal(shadowed.issue.custom!.next_follow_up_at, "2026-10-19");
    assert.equal((shadowed.issue.custom!.inquiries as any[])[0].spam_mode, "shadow");

    // A person's decisions are revisioned updates on the real API.
    const configuration = (await request("/config")) as Configuration;
    const now = new Date("2026-10-21T15:00:00Z");
    const stale = record.revision;
    record = (await request(`/issues/${record.issue.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "If-Match": stale, "X-Operation-Id": randomUUID() },
      body: JSON.stringify(spamReviewChanges(record.issue, "not_spam", configuration, now)),
    })) as IssueRecord;
    record = (await request(`/issues/${record.issue.id}`)) as IssueRecord;
    assert.deepEqual(record.issue.labels ?? [], []);
    assert.equal(record.issue.custom!.next_action, "Respond to demo request");
    assert.equal(record.issue.custom!.next_follow_up_at, "2026-10-22");
    assert.equal((record.issue.custom!.spam_review as any).label, "not_spam");
    assert.equal((record.issue.custom!.spam_review as any).machine.verdict, "likely_spam");
    // A stale decision is a revision conflict, not an overwrite.
    await assert.rejects(
      request(`/issues/${record.issue.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "If-Match": stale, "X-Operation-Id": randomUUID() },
        body: JSON.stringify(spamReviewChanges(record.issue, "spam", configuration, now)),
      }),
      (error: unknown) => error instanceof IntakeError && error.status === 409,
    );
    const confirmed = (await request(`/issues/${trapped.issue.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "If-Match": trapped.revision,
        "X-Operation-Id": randomUUID(),
      },
      body: JSON.stringify(spamReviewChanges(trapped.issue, "spam", configuration, now)),
    })) as IssueRecord;
    const kept = (await request(`/issues/${confirmed.issue.id}`)) as IssueRecord;
    assert.equal(kept.issue.status, "lost");
    assert.deepEqual(kept.issue.labels, ["spam"]);
    assert.equal(kept.issue.custom!.next_follow_up_at ?? null, null);
    assert.equal(
      (kept.issue.custom!.inquiries as unknown[]).length,
      1,
      "confirmed spam is kept, not deleted",
    );
    assert.equal((kept.issue.custom!.spam_corrections as unknown[]).length, 1);
    assert.equal(
      (await readFile(join(root, "project/issues", `${kept.issue.id}.json`), "utf8")).includes('"spam"'),
      true,
      "the decision is in the ordinary Kanbus file",
    );
  } finally {
    for (const service of services) await service.close();
    child.kill();
    await rm(directory, { recursive: true, force: true });
  }
});
