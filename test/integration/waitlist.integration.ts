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
import { parseIntakeFormRegistry, waitlistContactPolicy } from "../../server/intake-forms";
import type { IssueRecord } from "../../src/client";

test("real Kanbus persistence: a waitlist signup lands as a labelled lead, extends an existing demo contact and deduplicates per app", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prospectus-waitlist-api-"));
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
    const [registered] = parseIntakeFormRegistry(JSON.parse(await readFile("intake-forms.json", "utf8")));
    const form = {
      ...registered,
      enabled: true,
      approval: "Local disposable integration proof only, no deployment",
    };
    const identityStore = new FileControlStore(join(directory, "shared-identity"));
    const open = async (name: string, source: "waitlist" | "demo") => {
      const service = await IntakeService.open({
        directory: join(directory, name),
        workspace: "test/prospectus",
        owner: "intake-queue",
        siteId: source === "waitlist" ? form.siteId : REAL_CONTACT_POLICY.siteId,
        formId: source === "waitlist" ? form.formId : REAL_CONTACT_POLICY.formId,
        contactPolicy: source === "waitlist" ? waitlistContactPolicy(form) : REAL_CONTACT_POLICY,
        ...(source === "waitlist" ? { form } : {}),
        identityStore,
        request,
        now: () => new Date("2026-10-16T10:00:00Z"),
      });
      services.push(service);
      return service;
    };
    const waitlist = await open("waitlist", "waitlist");
    const demo = await open("demo", "demo");
    const signup = (email: string, changes: Record<string, unknown> = {}) => ({
      submission_id: randomUUID(),
      email,
      name: "Casey Example",
      marketing_opt_in: true,
      notice_version: form.noticeVersion,
      attributes: { persona: "creator", source: "waitlist-page" },
      ...changes,
    });

    await demo.submit({
      submission_id: randomUUID(),
      name: "Dana Demo",
      email: "dana@example.com",
      company: "Example",
      message: "Show me",
      notice_version: REAL_CONTACT_POLICY.noticeVersion,
    });
    await waitlist.submit(signup("casey@example.com"));
    const casey = signup("casey@example.com", { attributes: { persona: "agency" } });
    await Promise.all([waitlist.submit(casey), waitlist.submit(casey)]);
    await waitlist.submit(signup("dana@example.com", { name: "" }));

    const page = (await request("/issues?type=prospect")) as { issues: IssueRecord[] };
    assert.equal(page.issues.length, 2);
    const byEmail = (email: string) =>
      page.issues.find((record) => record.issue.custom?.contact_email === email)!;
    const created = byEmail("casey@example.com").issue;
    assert.equal(created.status, "new");
    assert.equal(created.assignee, "intake-queue");
    assert.deepEqual(created.labels, ["waitlist", "app-babulus"]);
    assert.equal("next_action" in created.custom!, false);
    assert.equal("next_follow_up_at" in created.custom!, false);
    assert.equal((created.custom!.inquiries as any[]).length, 1);
    assert.equal((created.custom!.inquiries as any[])[0].attributes.persona, "creator");

    const extended = byEmail("dana@example.com").issue;
    assert.equal(extended.title, "Dana Demo");
    assert.equal(extended.custom!.next_action, "Respond to demo request");
    assert.equal(extended.custom!.next_follow_up_at, "2026-10-19");
    assert.deepEqual(
      (extended.custom!.inquiries as any[]).map((inquiry) => inquiry.kind),
      ["demo", "waitlist"],
    );
    assert.deepEqual(extended.labels, ["waitlist", "app-babulus"]);
    console.log(
      "Real API proof: waitlist lead creation, labels, existing-contact append and per-app deduplication.",
    );
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
