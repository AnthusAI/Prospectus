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
import { formContactPolicy, parseIntakeFormRegistry } from "../../server/intake-forms";
import type { IssueRecord } from "../../src/client";

test("real Kanbus persistence: a Papyrus contact message lands as a labelled inquiry, extends a waitlist lead and files likely spam without follow-up", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prospectus-contact-api-"));
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
      const timeout = setTimeout(() => reject(new Error("Real Kanbus API did not start")), 30000);
      child.once("error", reject);
      child.once("exit", () => reject(new Error("Real Kanbus API exited before readiness")));
      let readiness = "";
      child.stderr.on("data", (data: Buffer) => {
        readiness += data.toString();
        const match = readiness.match(/http:\/\/127\.0\.0\.1:(\d+)/);
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

    const registry = parseIntakeFormRegistry(JSON.parse(await readFile("intake-forms.json", "utf8")));
    const find = (formId: string) => registry.find((entry) => entry.formId === formId)!;
    const contactForm = find("papyrus-contact-v1");
    const waitlistForm = find("papyrus-waitlist-v1");
    const identityStore = new FileControlStore(join(directory, "shared-identity"));
    const open = async (name: string, form: typeof contactForm) => {
      const service = await IntakeService.open({
        directory: join(directory, name),
        workspace: "test/prospectus",
        owner: form.owner,
        siteId: form.siteId,
        formId: form.formId,
        contactPolicy: formContactPolicy(form),
        form,
        identityStore,
        request,
        now: () => new Date("2026-10-16T10:00:00Z"),
        spamLabelling: "label",
      });
      services.push(service);
      return service;
    };
    const contact = await open("contact", contactForm);
    const waitlist = await open("waitlist", waitlistForm);
    const message = (email: string, changes: Record<string, unknown> = {}) => ({
      submission_id: randomUUID(),
      name: "Casey Example",
      email,
      company: "Example Studio",
      message: "Can Papyrus publish a feed for our team blog?",
      notice_version: contactForm.noticeVersion,
      ...changes,
    });

    await waitlist.submit({
      submission_id: randomUUID(),
      email: "dana@example.com",
      name: "Dana Waitlist",
      notice_version: waitlistForm.noticeVersion,
      attributes: { persona: "personal-blog" },
    });
    const casey = message("casey@example.com");
    await Promise.all([contact.submit(casey), contact.submit(casey)]);
    await contact.submit(message("dana@example.com", { name: "Dana Waitlist" }));
    await contact.submit(message("sam@example.com", { website: "https://spam.example" }));

    const page = (await request("/issues?type=prospect")) as { issues: IssueRecord[] };
    assert.equal(page.issues.length, 3);
    const byEmail = (email: string) =>
      page.issues.find((record) => record.issue.custom?.contact_email === email)!;
    const created = byEmail("casey@example.com").issue;
    assert.equal(created.status, "new");
    assert.equal(created.assignee, "intake-queue");
    assert.deepEqual(created.labels, ["contact", "app-papyrus"]);
    assert.equal(created.custom!.next_action, "Respond to inquiry");
    assert.equal(created.custom!.next_follow_up_at, "2026-10-19");
    assert.equal((created.custom!.inquiries as any[]).length, 1);
    assert.equal((created.custom!.inquiries as any[])[0].kind, "contact");

    const extended = byEmail("dana@example.com").issue;
    assert.deepEqual(
      (extended.custom!.inquiries as any[]).map((inquiry) => inquiry.kind),
      ["waitlist", "contact"],
    );
    assert.deepEqual(extended.labels, ["waitlist", "app-papyrus", "contact"]);

    const spam = byEmail("sam@example.com").issue;
    assert.deepEqual(spam.labels, ["contact", "app-papyrus", "likely-spam"]);
    assert.equal("next_action" in spam.custom!, false);
    console.log("Real API proof: contact filing, waitlist extension and honeypot spam handling.");
  } finally {
    await Promise.all(services.map((service) => service.close()));
    child.kill("SIGTERM");
    await new Promise<void>((resolveExit) => {
      if (child.exitCode !== null) resolveExit();
      else child.once("exit", () => resolveExit());
    });
    await rm(directory, { recursive: true, force: true });
  }
});
