import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { FileControlStore } from "../../server/control-store";
import { IntakeError, IntakeService } from "../../server/intake";
import { REAL_CONTACT_POLICY } from "../../server/intake-contact-policy";
import { parseIntakeFormRegistry } from "../../server/intake-forms";
import { NEWSLETTER_CONTACT_POLICY, NewsletterService } from "../../server/newsletter";
import type { ListEmail } from "../../server/newsletter-mailer";
import type { IssueRecord } from "../../src/client";

test("real Kanbus persistence: a subscription shows on the existing prospect through a revision conflict, and no prospect is created for a new subscriber", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prospectus-newsletter-api-"));
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
  let demo: IntakeService | undefined;
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
    const raw = async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token}`);
      const response = await fetch(`${api}${path}`, { ...init, headers });
      if (!response.ok) {
        const failure = (await response.json()) as { error?: string };
        throw new IntakeError(response.status, "Private API rejected the operation", failure.error);
      }
      return response.json();
    };
    // An operator edit lands between the newsletter's read and its write once, so the first PATCH
    // carries a stale revision and must be refused by the real API and retried.
    let interfere = true;
    const request = async (path: string, init: RequestInit = {}) => {
      if (init.method === "PATCH" && interfere && JSON.parse(String(init.body)).custom?.newsletters) {
        interfere = false;
        const current = (await raw(path)) as IssueRecord;
        await raw(path, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-Operation-Id": randomUUID(),
            "If-Match": current.revision,
          },
          body: JSON.stringify({ custom: { next_action: "Operator note" } }),
        });
      }
      return raw(path, init);
    };
    const store = new FileControlStore(join(directory, "controls"));
    demo = await IntakeService.open({
      directory: join(directory, "demo"),
      workspace: "test/prospectus",
      owner: "intake-queue",
      siteId: REAL_CONTACT_POLICY.siteId,
      formId: REAL_CONTACT_POLICY.formId,
      contactPolicy: REAL_CONTACT_POLICY,
      identityStore: store,
      request: raw,
    });
    await demo.submit({
      submission_id: randomUUID(),
      name: "Casey Example",
      email: "casey@example.com",
      company: "Example",
      message: "Hello",
      notice_version: REAL_CONTACT_POLICY.noticeVersion,
    });
    const form = parseIntakeFormRegistry(JSON.parse(await readFile("intake-forms.json", "utf8"))).find(
      (item) => item.kind === "newsletter",
    )!;
    const sent: ListEmail[] = [];
    const service = new NewsletterService({
      workspace: "test/prospectus",
      store,
      forms: [form],
      contactPolicy: NEWSLETTER_CONTACT_POLICY,
      tokenSecret: async () => Buffer.alloc(48, 7),
      mailer: async (email) => {
        sent.push(email);
      },
      request,
      now: () => new Date("2026-10-21T12:00:00Z"),
    });
    const base = "https://abcde12345.execute-api.us-east-1.amazonaws.com";
    const signup = (email: string) => ({
      submission_id: randomUUID(),
      email,
      website: "",
      notice_version: form.noticeVersion,
      page_path: "/",
    });
    await service.subscribe(form, signup("casey@example.com"), base);
    const confirm = new URL(sent[0].text.match(/https:\/\/\S+\/confirm\?token=\S+/)![0]);
    await service.confirm(confirm.searchParams.get("token"), "POST");
    await service.subscribe(form, signup("new@example.com"), base);

    const page = (await raw("/issues?type=prospect")) as { issues: IssueRecord[] };
    assert.equal(page.issues.length, 1, "a subscriber without a prospect does not get one");
    const persisted = (await raw(`/issues/${page.issues[0].issue.id}`)) as IssueRecord;
    const custom = persisted.issue.custom!;
    assert.equal(custom.next_action, "Operator note", "the concurrent operator edit is kept");
    assert.equal(custom.company, "Example");
    assert.equal((custom.inquiries as any[]).length, 1);
    assert.equal((custom.newsletters as any)["papyrus-newsletter-v1"].status, "active");
    assert.equal(
      (custom.newsletters as any)["papyrus-newsletter-v1"].confirmed_at,
      "2026-10-21T12:00:00.000Z",
    );
    assert.equal(interfere, false, "the conflict path ran");
    console.log("Real API proof: newsletter status on the existing prospect, revision conflict retried.");
  } finally {
    await demo?.close();
    child.kill("SIGTERM");
    await new Promise<void>((resolveExit) => {
      if (child.exitCode !== null) resolveExit();
      else child.once("exit", () => resolveExit());
    });
    await rm(directory, { recursive: true, force: true });
  }
});
