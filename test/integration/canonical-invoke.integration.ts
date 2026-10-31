import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { canonicalRequest } from "../../server/canonical-invoke";
import { FileControlStore } from "../../server/control-store";
import { IntakeService } from "../../server/intake";
import type { IssueRecord } from "../../src/client";

/**
 * Production intake reaches Kanbus through a synthetic HTTP API v2 event, and the Kanbus Lambda
 * adapter builds its query only from `rawQueryString`. This forwards the trusted adapter's event to
 * the real pinned API the same way (rawPath + rawQueryString, nothing else), so a dropped query
 * string turns the identity lookup into an unfiltered listing and this test fails.
 */
test("trusted intake over the Lambda event shape keeps same-length contacts on separate prospects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prospectus-invoke-"));
  const root = join(directory, "kanbus");
  await mkdir(join(root, "project/issues"), { recursive: true });
  await mkdir(join(root, "project/events"), { recursive: true });
  await copyFile("config/prospectus.kanbus.yml", join(root, ".kanbus.yml"));
  const token = randomBytes(32).toString("hex");
  const child = spawn(
    resolve(process.env.KANBUS_API_BINARY ?? ".build/target/release/kanbus-api-local"),
    [],
    {
      env: {
        ...process.env,
        KANBUS_BACKEND: "file",
        KANBUS_ROOT: root,
        KANBUS_TENANT: "cyclotron",
        KANBUS_PROJECT: "prospectus",
        KANBUS_PORT: "0",
        KANBUS_LOCAL_TOKEN: token,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const services: IntakeService[] = [];
  try {
    const origin = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Real Kanbus API did not start")), 30000);
      child.once("exit", () => reject(new Error("Real Kanbus API exited before readiness")));
      let readiness = "";
      child.stderr.on("data", (data: Buffer) => {
        readiness += data.toString();
        const match = readiness.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) {
          clearTimeout(timeout);
          resolve(match[0]);
        }
      });
    });
    const request = canonicalRequest(async (payload) => {
      const event = payload as {
        rawPath: string;
        rawQueryString?: string;
        headers: Record<string, string>;
        body?: string;
        requestContext: { http: { method: string } };
      };
      const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
      const response = await fetch(`${origin}${event.rawPath}${query}`, {
        method: event.requestContext.http.method,
        headers: { ...event.headers, authorization: `Bearer ${token}` },
        body: event.body,
      });
      return { statusCode: response.status, body: await response.text() };
    });
    const open = async (name: string) => {
      const service = await IntakeService.open({
        directory: join(directory, name),
        workspace: "cyclotron/prospectus",
        owner: "local-member",
        siteId: "prospectus-web-review",
        formId: "demo-v1",
        request,
        identityStore: new FileControlStore(join(directory, "identity")),
        now: () => new Date("2026-10-21T19:14:00Z"),
      });
      services.push(service);
      return service;
    };
    const submit = (service: IntakeService, email: string, message: string) =>
      service.submit({
        submission_id: randomUUID(),
        name: "Synthetic Contact",
        email,
        company: "Example Co",
        message,
        website: "",
        notice_version: "synthetic-demo-v1",
        marketing_opt_in: false,
        page_path: "/request-demo",
        campaign: {},
      });
    const first = await open("first");
    await submit(first, "aaaa@example.invalid", "First contact");
    const second = await open("second");
    await submit(second, "bbbb@example.invalid", "A different contact of the same length");
    await submit(second, "bbbb@example.invalid", "Repeat from the second contact");
    await submit(await open("third"), "aaaa@example.invalid", "Repeat from the first contact");

    const listed = (await request("/issues?type=prospect&limit=100")) as { issues: IssueRecord[] };
    assert.equal(listed.issues.length, 2);
    const byEmail = new Map(
      listed.issues.map((record) => [record.issue.custom!.contact_email, record.issue.custom!.inquiries]),
    );
    assert.equal((byEmail.get("aaaa@example.invalid") as unknown[]).length, 2);
    assert.equal((byEmail.get("bbbb@example.invalid") as unknown[]).length, 2);
    assert.ok(listed.issues.every((record) => !record.issue.labels?.includes("needs-review")));
    const fields = JSON.stringify([
      { field: "custom.contact_email", operator: "eq", value: "bbbb@example.invalid" },
    ]);
    const filtered = (await request(
      `/issues?type=prospect&limit=2&fields=${encodeURIComponent(fields)}`,
    )) as { issues: IssueRecord[] };
    assert.deepEqual(
      filtered.issues.map((record) => record.issue.custom!.contact_email),
      ["bbbb@example.invalid"],
    );
  } finally {
    await Promise.all(services.map((service) => service.close()));
    child.kill();
    await rm(directory, { recursive: true, force: true });
  }
});
