import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ControlConflict,
  type ConditionalControlStore,
  type ControlCondition,
  type ControlObject,
} from "../server/control-store";
import { createEvaluationHandler } from "../server/evaluation-handler";
import { refileInbox } from "../server/inbox-refile";
import { IntakeError, IntakeService, type IntakeOptions } from "../server/intake";
import { REAL_CONTACT_POLICY } from "../server/intake-contact-policy";
import type { IssueRecord } from "../src/client";

class MemoryControls implements ConditionalControlStore {
  objects = new Map<string, ControlObject>();
  async getControl(path: string) {
    const object = this.objects.get(path);
    return object ? structuredClone(object) : null;
  }
  async putControl(path: string, bytes: string, condition: ControlCondition) {
    const current = this.objects.get(path);
    if ("absent" in condition ? Boolean(current) : current?.revision !== condition.revision)
      throw new ControlConflict("CAS failed");
    const object = { bytes, revision: createHash("sha256").update(bytes).digest("hex") };
    this.objects.set(path, object);
    return structuredClone(object);
  }
  inbox() {
    return [...this.objects.values()]
      .map((object) => JSON.parse(object.bytes))
      .filter((value) => value.kind === "intake-inbox");
  }
}

/**
 * A canonical API like the real catalog: search hits are summaries with no custom fields, so only
 * GET /issues/<id> returns the contact email and inquiry history.
 */
class SummaryCatalogApi {
  records = new Map<string, IssueRecord>();
  operations = new Map<string, IssueRecord>();
  creates = 0;
  fail?: (method: string, path: string) => Error | undefined;
  request: IntakeOptions["request"] = async (path, init = {}) => {
    const method = init.method ?? "GET";
    const failure = this.fail?.(method, path);
    if (failure) throw failure;
    if (method === "GET") {
      if (path.startsWith("/issues?")) {
        const predicate = JSON.parse(new URL(path, "http://local").searchParams.get("fields")!)[0];
        return {
          issues: [...this.records.values()]
            .filter((record) => record.issue.custom?.contact_email === predicate.value)
            .map((record) => ({
              issue: { id: record.issue.id, type: "prospect", status: record.issue.status },
              revision: record.revision,
            })) as unknown as IssueRecord[],
        };
      }
      const record = this.records.get(path.slice("/issues/".length));
      if (!record) throw new IntakeError(404, "Missing canonical record");
      return structuredClone(record);
    }
    const headers = new Headers(init.headers);
    const operation = headers.get("X-Operation-Id")!;
    const prior = this.operations.get(operation);
    if (prior) return structuredClone(prior);
    const body = JSON.parse(String(init.body));
    let record: IssueRecord;
    if (method === "POST") {
      this.creates++;
      record = { issue: { ...body, id: `prsp-${randomUUID()}`, status: "new", priority: 2 }, revision: "1" };
    } else {
      record = structuredClone(this.records.get(path.slice("/issues/".length))!);
      if (record.revision !== headers.get("If-Match"))
        throw new IntakeError(409, "Revision changed", "revision_conflict");
      record.issue.custom = { ...record.issue.custom, ...body.custom };
      record.revision = String(Number(record.revision) + 1);
    }
    this.records.set(record.issue.id, structuredClone(record));
    this.operations.set(operation, structuredClone(record));
    return structuredClone(record);
  };
  prospects(label?: string) {
    return [...this.records.values()].filter(
      (record) => !label || (record.issue.labels as string[] | undefined)?.includes(label),
    );
  }
}

const input = (changes: Record<string, unknown> = {}) => ({
  submission_id: randomUUID(),
  name: "Info Anthus",
  email: "info@anth.us",
  company: "Anthus",
  message: "Hello from the engage page",
  website: "",
  notice_version: "contact-v1",
  marketing_opt_in: false,
  page_path: "/engage",
  campaign: {},
  ...changes,
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "prospectus-inbox-"));
  const controls = new MemoryControls();
  const api = new SummaryCatalogApi();
  const logs: Array<{ event: string; reason: string }> = [];
  const services: IntakeService[] = [];
  let count = 0;
  return {
    controls,
    api,
    logs,
    async worker(changes: Partial<IntakeOptions> = {}) {
      const service = await IntakeService.open({
        directory: join(root, `worker-${++count}`),
        workspace: "test/prospectus",
        owner: "intake-queue",
        siteId: REAL_CONTACT_POLICY.siteId,
        formId: REAL_CONTACT_POLICY.formId,
        contactPolicy: REAL_CONTACT_POLICY,
        identityStore: controls,
        request: api.request,
        log: (entry) => logs.push(entry),
        ...changes,
      });
      services.push(service);
      return service;
    },
    async close() {
      await Promise.all(services.map((service) => service.close()));
      await rm(root, { recursive: true, force: true });
    },
  };
}
const inquiriesOf = (record: IssueRecord) => record.issue.custom!.inquiries as Array<{ id: string }>;

test("a first submission creates one prospect and stores the inquiry in the inbox", async () => {
  const setup = await fixture();
  try {
    const first = input();
    assert.equal((await (await setup.worker()).submit(first)).receipt, first.submission_id);
    assert.equal(setup.api.creates, 1);
    assert.equal(inquiriesOf(setup.api.prospects()[0]).length, 1);
    assert.equal(setup.controls.inbox().length, 1);
    assert.equal(setup.controls.inbox()[0].status, "filed");
    assert.equal(setup.controls.inbox()[0].inquiry.message, first.message);
  } finally {
    await setup.close();
  }
});

test("a repeat contact with a new submission id appends to the same prospect although search returns summaries", async () => {
  const setup = await fixture();
  try {
    await (await setup.worker()).submit(input());
    const second = input({ message: "Second note from the same visitor" });
    await (await setup.worker()).submit(second);
    assert.equal(setup.api.creates, 1);
    assert.equal(setup.api.prospects().length, 1);
    assert.equal(inquiriesOf(setup.api.prospects()[0]).length, 2);
    assert.equal(setup.api.prospects()[0].issue.labels, undefined);
    assert.deepEqual(
      setup.controls.inbox().map((item) => item.status),
      ["filed", "filed"],
    );
  } finally {
    await setup.close();
  }
});

test("a retry with the same submission id is idempotent", async () => {
  const setup = await fixture();
  try {
    const first = input();
    await (await setup.worker()).submit(first);
    const second = input({ message: "Another" });
    await (await setup.worker()).submit(second);
    await (await setup.worker()).submit(first);
    await (await setup.worker()).submit(second);
    assert.equal(setup.api.creates, 1);
    assert.equal(inquiriesOf(setup.api.prospects()[0]).length, 2);
    assert.equal(setup.controls.inbox().length, 2);
  } finally {
    await setup.close();
  }
});

test("canonical API 409, 500 and timeout failures still accept the visitor and keep the full inquiry", async () => {
  for (const failure of [
    new IntakeError(409, "Private CRM operation was not confirmed.", "operation_conflict"),
    new IntakeError(500, "Private CRM operation was not confirmed."),
    new Error("Task timed out after 60.00 seconds"),
  ]) {
    const setup = await fixture();
    try {
      setup.api.fail = () => failure;
      const request = input({ message: "Do not lose this note" });
      const response = await (await setup.worker()).submit(request);
      assert.equal(response.receipt, request.submission_id);
      assert.equal(setup.api.records.size, 0);
      const [item] = setup.controls.inbox();
      assert.equal(item.status, "pending");
      assert.equal(item.inquiry.message, "Do not lose this note");
      assert.equal(item.inquiry.email, "info@anth.us");
      // Logs carry reason codes only.
      assert.ok(setup.logs.length > 0);
      assert.ok(setup.logs.every((entry) => !JSON.stringify(entry).includes("info@anth.us")));
      assert.ok(setup.logs.every((entry) => !JSON.stringify(entry).includes("Do not lose")));
      // Recovery: the same receipt retried after the outage files it exactly once.
      setup.api.fail = undefined;
      await (await setup.worker()).submit(request);
      assert.equal(setup.api.creates, 1);
      assert.equal(setup.controls.inbox()[0].status, "filed");
    } finally {
      await setup.close();
    }
  }
});

test("duplicate catalog matches are accepted and filed as a needs-review prospect without follow-up", async () => {
  const setup = await fixture();
  try {
    for (const id of ["prsp-a", "prsp-b"])
      setup.api.records.set(id, {
        issue: {
          id,
          type: "prospect",
          status: "new",
          custom: { contact_email: "info@anth.us", inquiries: [] },
        },
        revision: "1",
      } as unknown as IssueRecord);
    const request = input();
    assert.equal((await (await setup.worker()).submit(request)).receipt, request.submission_id);
    const [review] = setup.api.prospects("needs-review");
    assert.equal(review.issue.custom!.review_reason, "duplicate_contact");
    assert.equal(review.issue.custom!.contact_email, undefined);
    assert.equal(review.issue.custom!.next_follow_up_at, undefined);
    assert.equal(inquiriesOf(review).length, 1);
    assert.equal(setup.controls.inbox()[0].status, "review");
    // Retrying never files a second review prospect.
    await (await setup.worker()).submit(request);
    assert.equal(setup.api.prospects("needs-review").length, 1);
  } finally {
    await setup.close();
  }
});

test("a full inquiry history is accepted and filed for review", async () => {
  const setup = await fixture();
  try {
    await (await setup.worker()).submit(input());
    const record = setup.api.prospects()[0];
    record.issue.custom!.inquiries = Array.from({ length: 100 }, () => ({ id: randomUUID() }));
    await (await setup.worker()).submit(input({ message: "Number 101" }));
    const [review] = setup.api.prospects("needs-review");
    assert.equal(review.issue.custom!.review_reason, "history_full");
    assert.equal(review.issue.custom!.review_related_issue, record.issue.id);
    assert.equal(inquiriesOf(setup.api.prospects()[0]).length, 100);
  } finally {
    await setup.close();
  }
});

test("a reused submission id with other content is stored as a new inquiry, never rejected", async () => {
  const setup = await fixture();
  try {
    const first = input();
    await (await setup.worker()).submit(first);
    const changed = { ...first, message: "Edited after the first send" };
    assert.equal((await (await setup.worker()).submit(changed)).receipt, first.submission_id);
    await (await setup.worker()).submit(changed);
    assert.equal(inquiriesOf(setup.api.prospects()[0]).length, 2);
    assert.equal(setup.controls.inbox().length, 2);
  } finally {
    await setup.close();
  }
});

test("only invalid fields are rejected, and nothing is stored for them", async () => {
  const setup = await fixture();
  try {
    const worker = await setup.worker();
    for (const changes of [{ email: "not an email" }, { notice_version: "old" }, { message: "" }]) {
      assert.throws(
        () => worker.submit(input(changes)),
        (error: unknown) => error instanceof IntakeError && error.status === 400,
      );
    }
    assert.equal(setup.controls.objects.size, 0);
  } finally {
    await setup.close();
  }
});

test("the HTTP handler answers 202 with the receipt when the CRM is down", async () => {
  const setup = await fixture();
  try {
    setup.api.fail = () => new IntakeError(500, "down");
    const handler = createEvaluationHandler({
      allowedOrigins: ["https://anth.us"],
      open: async () => await setup.worker(),
    });
    const request = input();
    const result = await handler({
      rawPath: "/intake/demo",
      requestContext: { http: { method: "POST" } },
      headers: { origin: "https://anth.us", "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    assert.equal(result.statusCode, 202);
    assert.equal(JSON.parse(result.body).receipt, request.submission_id);
    assert.equal(setup.controls.inbox().length, 1);
  } finally {
    await setup.close();
  }
});

test("the operator refile reports counts first and then files pending items once", async () => {
  const setup = await fixture();
  try {
    setup.api.fail = () => new IntakeError(500, "down");
    await (await setup.worker()).submit(input());
    await (await setup.worker()).submit(input({ message: "Second while down" }));
    setup.api.fail = undefined;
    const base = {
      workspace: "test/prospectus",
      store: setup.controls,
      paths: [...setup.controls.objects.keys()],
      request: setup.api.request,
      forms: [],
      demoPolicy: REAL_CONTACT_POLICY,
    };
    const dry = await refileInbox({ ...base, apply: false });
    assert.deepEqual([dry.inboxItems, dry.pending, dry.filed], [2, 2, 0]);
    assert.equal(setup.api.records.size, 0);
    const applied = await refileInbox({ ...base, apply: true });
    assert.deepEqual([applied.filed, applied.review, applied.stillPending], [2, 0, 0]);
    assert.equal(setup.api.creates, 1);
    assert.equal(inquiriesOf(setup.api.prospects()[0]).length, 2);
    const again = await refileInbox({ ...base, apply: true });
    assert.deepEqual([again.pending, again.filed], [0, 0]);
  } finally {
    await setup.close();
  }
});
