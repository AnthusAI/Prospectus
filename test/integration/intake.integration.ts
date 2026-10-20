import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { IntakeError, IntakeService, type IntakeOptions } from "../../server/intake";
import { startLocalIntake } from "../../server/local";
import { FileControlStore } from "../../server/control-store";
import type { IssueRecord } from "../../src/client";

test("real Kanbus persistence: concurrent capture, replay/restart, edits, conflict, handoff and anonymous boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prospectus-real-api-"));
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
        KANBUS_NAMESPACE: "test/prospectus",
        KANBUS_PORT: "0",
        KANBUS_LOCAL_TOKEN: token,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let service: IntakeService | undefined;
  const independentWorkers: IntakeService[] = [];
  let adapter: Awaited<ReturnType<typeof startLocalIntake>> | undefined;
  try {
    const api = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Real Kanbus API did not start")), 10000);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error("Real Kanbus API exited before readiness"));
      });
      child.stderr.on("data", (data: Buffer) => {
        const match = data.toString().match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(`${match[0]}/api`);
        }
      });
    });
    const request: IntakeOptions["request"] = async (path, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token}`);
      const response = await fetch(`${api}${path}`, { ...init, headers });
      if (!response.ok) {
        const failure = (await response.json()) as { error?: string };
        throw new IntakeError(response.status, "Private API rejected the operation", failure.error);
      }
      return response.json();
    };
    const options: IntakeOptions = {
      directory: join(directory, "intake"),
      workspace: "test/prospectus",
      owner: "local-member",
      siteId: "prospectus-web-review",
      formId: "demo-v1",
      request,
      identityStore: new FileControlStore(join(directory, "shared-identity")),
      now: () => new Date("2026-10-16T10:00:00Z"),
    };
    adapter = await startLocalIntake(options, 0, "http://127.0.0.1:5490");
    service = adapter.service;
    const endpoint = `http://127.0.0.1:${(adapter.server.address() as AddressInfo).port}/intake/demo`;
    const input = (changes = {}) => ({
      submission_id: randomUUID(),
      name: "Alex Example",
      email: "alex@example.invalid",
      company: "Example Studio",
      message: "Synthetic demo inquiry",
      website: "",
      notice_version: "synthetic-demo-v1",
      marketing_opt_in: false,
      page_path: "/request-demo",
      campaign: { utm_source: "review" },
      ...changes,
    });
    const post = (body: unknown, origin = "http://127.0.0.1:5490") =>
      fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify(body),
      });
    assert.equal((await fetch(`${api}/issues`)).status, 401);
    assert.equal((await post(input(), "https://untrusted.invalid")).status, 403);
    assert.equal((await post(input({ email: "alex@example.com" }))).status, 400);
    assert.equal((await post(input({ assignee: "intruder" }))).status, 400);
    assert.equal((await post(input({ message: "x".repeat(13000) }))).status, 413);
    const first = input();
    const second = input({ email: " ALEX@EXAMPLE.INVALID ", message: "Another synthetic inquiry" });
    const responses = await Promise.all([post(first), post(second), post(first)]);
    for (const response of responses) {
      assert.equal(response.status, 202);
      const result = await response.json();
      assert.deepEqual(Object.keys(result).sort(), ["message", "receipt"]);
      assert.equal(JSON.stringify(result).includes("prsp-"), false);
      assert.equal(JSON.stringify(result).includes(token), false);
    }
    let page = (await request("/issues?type=prospect")) as { issues: IssueRecord[] };
    assert.equal(page.issues.length, 1);
    let record = page.issues[0];
    const id = record.issue.id;
    assert.equal(record.issue.assignee, "local-member");
    assert.equal(record.issue.custom!.next_action, "Respond to demo request");
    assert.equal(record.issue.custom!.next_follow_up_at, "2026-10-19");
    assert.equal((record.issue.custom!.inquiries as unknown[]).length, 2);
    const patch = async (changes: Record<string, unknown>, revision = record.revision) => {
      const result = (await request(`/issues/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "If-Match": revision, "X-Operation-Id": randomUUID() },
        body: JSON.stringify(changes),
      })) as IssueRecord;
      record = result;
      return result;
    };
    const stale = record.revision;
    await patch({ status: "contacted", custom: { next_action: "Confirm fit" } });
    await assert.rejects(
      patch({ status: "qualified" }, stale),
      (error: unknown) => error instanceof IntakeError && error.status === 409,
    );
    await post(input({ message: "Repeat after sales contact" }));
    record = (await request(`/issues/${id}`)) as IssueRecord;
    assert.equal(record.issue.status, "contacted");
    assert.equal(record.issue.custom!.next_action, "Confirm fit");
    assert.equal((record.issue.custom!.inquiries as unknown[]).length, 3);
    for (let attempt = 0; attempt < 13; attempt++)
      assert.equal((await post(input({ website: "honeypot" }))).status, 202);
    assert.equal((await post(input({ website: "honeypot" }))).status, 429);
    await new Promise<void>((resolve) => adapter!.server.close(() => resolve()));
    await service.close();
    service = await IntakeService.open(options);
    await service.submit(first);
    record = (await request(`/issues/${id}`)) as IssueRecord;
    assert.equal((record.issue.custom!.inquiries as unknown[]).length, 3);
    for (const status of ["qualified", "proposal", "customer"]) await patch({ status });
    await patch({
      assignee: "customer-success",
      custom: {
        next_action: "Onboarding check-in",
        next_follow_up_at: "2026-10-20",
        converted_at: "2026-10-14T12:00:00Z",
      },
    });
    record = (await request(`/issues/${id}`)) as IssueRecord;
    assert.equal(record.issue.id, id);
    assert.equal(record.issue.status, "customer");
    assert.equal(record.issue.assignee, "customer-success");
    assert.equal((record.issue.custom!.inquiries as unknown[]).length, 3);
    await patch({ custom: { contact_email: "corrected@example.invalid" } });
    await service.submit(input({ email: "corrected@example.invalid", message: "Corrected contact inquiry" }));
    page = (await request("/issues?type=prospect")) as { issues: IssueRecord[] };
    assert.equal(page.issues.length, 1);
    record = (await request(`/issues/${id}`)) as IssueRecord;
    assert.equal((record.issue.custom!.inquiries as unknown[]).length, 4);
    await service.close();
    let dropResponse = true;
    service = await IntakeService.open({
      ...options,
      request: async (path, init) => {
        const result = await request(path, init);
        if (init?.method === "PATCH" && dropResponse) {
          dropResponse = false;
          throw new Error("Lost committed PATCH response");
        }
        return result;
      },
    });
    const uncertain = input({
      email: "corrected@example.invalid",
      message: "Committed inquiry with lost response",
    });
    // The visitor is accepted; the lost response leaves the inbox item pending for the retry below.
    await service.submit(uncertain);
    await service.close();
    service = await IntakeService.open(options);
    await service.submit(uncertain);
    record = (await request(`/issues/${id}`)) as IssueRecord;
    assert.equal((record.issue.custom!.inquiries as unknown[]).length, 5);
    assert.equal(record.issue.assignee, "customer-success");
    await service.close();
    let compete = true;
    service = await IntakeService.open({
      ...options,
      request: async (path, init) => {
        if (init?.method === "PATCH" && compete) {
          compete = false;
          await request(path, {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              "If-Match": new Headers(init.headers).get("If-Match")!,
              "X-Operation-Id": randomUUID(),
            },
            body: JSON.stringify({
              custom: { next_action: "Manual action remains", manual_note: "Concurrent edit remains" },
            }),
          });
        }
        return request(path, init);
      },
    });
    await service.submit(
      input({ email: "corrected@example.invalid", message: "Inquiry concurrent with manual update" }),
    );
    record = (await request(`/issues/${id}`)) as IssueRecord;
    assert.equal((record.issue.custom!.inquiries as unknown[]).length, 6);
    assert.equal(record.issue.custom!.next_action, "Manual action remains");
    assert.equal(record.issue.custom!.manual_note, "Concurrent edit remains");
    let readers = 0;
    let releaseReaders!: () => void;
    const bothRead = new Promise<void>((resolve) => {
      releaseReaders = resolve;
    });
    const independentlyScopedRequest: IntakeOptions["request"] = async (path, init) => {
      const result = await request(path, init);
      if (!init?.method && path.startsWith("/issues?")) {
        readers++;
        if (readers === 2) releaseReaders();
        await bothRead;
      }
      return result;
    };
    for (const worker of ["a", "b"])
      independentWorkers.push(
        await IntakeService.open({
          ...options,
          directory: join(directory, `independent-${worker}`),
          identityStore: new FileControlStore(join(directory, "shared-identity")),
          request: independentlyScopedRequest,
        }),
      );
    await Promise.all(
      independentWorkers.map((worker) =>
        worker.submit(
          input({ email: "distributed-race@example.invalid", name: "Synthetic distributed race" }),
        ),
      ),
    );
    const identityQuery = encodeURIComponent(
      JSON.stringify([
        { field: "custom.contact_email", operator: "eq", value: "distributed-race@example.invalid" },
      ]),
    );
    const duplicates = (await request(`/issues?type=prospect&fields=${identityQuery}`)) as {
      issues: IssueRecord[];
    };
    assert.equal(
      duplicates.issues.length,
      1,
      "Independent ledgers share a conditional identity claim despite synchronized empty catalog reads.",
    );
    assert.equal((duplicates.issues[0].issue.custom!.inquiries as unknown[]).length, 2);
    console.log(
      "Real API proof: one prospect, six inquiries, lost committed PATCH recovery, concurrent manual edit retry/preservation, restart/replay, contact correction, customer handoff, rate limit, stale-write rejection and anonymous 401.",
    );
    console.log(
      "Shared conditional identity proof: two independent ledgers with synchronized empty catalog reads retained one canonical issue and both inquiries. S3 transport and cloud fault acceptance remain unverified.",
    );
  } finally {
    if (adapter?.server.listening)
      await new Promise<void>((resolve) => adapter!.server.close(() => resolve()));
    await service?.close();
    await Promise.all(independentWorkers.map((worker) => worker.close()));
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
    await rm(directory, { recursive: true, force: true });
  }
});
