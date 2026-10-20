import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  IntakeError,
  IntakeService,
  nextBusinessDay,
  validateSubmission,
  type IntakeOptions,
} from "../server/intake";
import { FileControlStore } from "../server/control-store";
import {
  REAL_CONTACT_POLICY,
  SYNTHETIC_CONTACT_POLICY,
  intakeContactPolicyForMode,
} from "../server/intake-contact-policy";
import type { IssueRecord } from "../src/client";

const openIntake = (options: Omit<IntakeOptions, "identityStore">) =>
  IntakeService.open({
    ...options,
    identityStore: new FileControlStore(join(options.directory, "identity-claims")),
  });

export const submission = (changes: Record<string, unknown> = {}) => ({
  submission_id: randomUUID(),
  name: "Alex Example",
  email: "alex@example.invalid",
  company: "Example Studio",
  message: "Please show the demo.",
  website: "",
  notice_version: "synthetic-demo-v1",
  marketing_opt_in: false,
  page_path: "/request-demo",
  campaign: { utm_source: "review" },
  ...changes,
});

test("synthetic boundary rejects real contact data, unexpected control fields and invalid attribution", () => {
  for (const changes of [
    { email: "alex@example.com" },
    { assignee: "intruder" },
    { notice_version: "old" },
    { message: "x".repeat(3001) },
    { campaign: { secret: "token" } },
    { page_path: "/?token=secret" },
  ]) {
    assert.throws(() => validateSubmission(submission(changes)), IntakeError);
  }
  assert.equal(
    validateSubmission(submission({ email: " ALEX@EXAMPLE.INVALID " })).email,
    "alex@example.invalid",
  );
  assert.equal(
    validateSubmission(submission({ email: "alex+demo@example.invalid" })).email,
    "alex+demo@example.invalid",
  );
  assert.equal(nextBusinessDay(new Date("2026-10-16T23:00:00Z")), "2026-10-19");
});

test("real-contact policy accepts ordinary addresses only with its own notice version", () => {
  const realSubmission = (changes: Record<string, unknown> = {}) =>
    submission({ notice_version: REAL_CONTACT_POLICY.noticeVersion, email: "alex@example.com", ...changes });
  assert.equal(
    validateSubmission(realSubmission({ email: " Alex.Porter+demo@Example.CO.uk " }), REAL_CONTACT_POLICY)
      .email,
    "alex.porter+demo@example.co.uk",
  );
  for (const changes of [
    { email: "alex@localhost" },
    { email: "alex@-example.com" },
    { email: "not an email" },
    { notice_version: SYNTHETIC_CONTACT_POLICY.noticeVersion },
    { assignee: "intruder" },
  ]) {
    assert.throws(() => validateSubmission(realSubmission(changes), REAL_CONTACT_POLICY), IntakeError);
  }
  assert.throws(() => validateSubmission(realSubmission()), IntakeError);
  assert.equal(intakeContactPolicyForMode(undefined), SYNTHETIC_CONTACT_POLICY);
  assert.equal(intakeContactPolicyForMode("real-contacts"), REAL_CONTACT_POLICY);
  assert.throws(() => intakeContactPolicyForMode("everything"), /Unknown intake contact mode/);
});

test("durable receipts recover a lost create response and preserve subsequent inquiries after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prospectus-receipts-"));
  const records = new Map<string, IssueRecord>();
  const operations = new Map<string, IssueRecord>();
  let loseResponse = true;
  let creates = 0;
  const request: IntakeOptions["request"] = async (path, init) => {
    if (!init?.method) {
      if (path.startsWith("/issues?")) return { issues: [...records.values()] };
      return structuredClone(records.get(path.slice("/issues/".length))!);
    }
    const operation = new Headers(init.headers).get("X-Operation-Id")!;
    if (operations.has(operation)) return structuredClone(operations.get(operation)!);
    const body = JSON.parse(String(init.body));
    const record =
      init.method === "POST"
        ? ({
            issue: { id: "prsp-example", ...body, status: "new", comments: [] },
            revision: "1",
          } as IssueRecord)
        : structuredClone(records.get(path.slice("/issues/".length))!);
    if (init.method === "POST") creates++;
    else {
      record.issue.custom = { ...record.issue.custom, ...body.custom };
      record.revision = String(Number(record.revision) + 1);
    }
    records.set(record.issue.id, structuredClone(record));
    operations.set(operation, structuredClone(record));
    if (loseResponse) {
      loseResponse = false;
      throw new Error("Connection dropped after commit");
    }
    return record;
  };
  const options = {
    directory,
    workspace: "test/prospectus",
    owner: "seller",
    siteId: "review",
    formId: "demo",
    request,
    now: () => new Date("2026-10-16T10:00:00Z"),
  };
  let service = await openIntake(options);
  try {
    const first = submission();
    // The visitor is accepted even though the CRM response was lost; the inbox keeps it pending.
    assert.equal((await service.submit(first)).receipt, first.submission_id);
    await service.close();
    service = await openIntake(options);
    await service.submit(first);
    const saved = records.get("prsp-example")!;
    saved.issue.status = "qualified";
    saved.issue.assignee = "existing-owner";
    saved.issue.custom!.next_action = "Prepare proposal";
    await Promise.all([service.submit(submission({ message: "Second inquiry" })), service.submit(first)]);
    const updated = records.get("prsp-example")!;
    assert.equal(creates, 1);
    assert.equal(updated.issue.status, "qualified");
    assert.equal(updated.issue.assignee, "existing-owner");
    assert.equal(updated.issue.custom!.next_action, "Prepare proposal");
    assert.equal((updated.issue.custom!.inquiries as unknown[]).length, 2);
    assert.equal(updated.issue.custom!.next_follow_up_at, "2026-10-19");
    // A reused receipt with other content is never rejected: it is stored as a new inquiry.
    await service.submit({ ...first, message: "Changed receipt" });
    assert.equal((records.get("prsp-example")!.issue.custom!.inquiries as unknown[]).length, 3);
  } finally {
    await service.close();
    await rm(directory, { recursive: true });
  }
});

test("a ledger admits one worker and honeypots cause no canonical write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prospectus-worker-"));
  let calls = 0;
  const options = {
    directory,
    workspace: "test/prospectus",
    owner: "seller",
    siteId: "review",
    formId: "demo",
    request: async () => {
      calls++;
      return { issues: [] };
    },
  };
  const service = await openIntake(options);
  try {
    await assert.rejects(openIntake(options), /Another intake worker/);
    await service.submit(submission({ website: "spam" }));
    assert.equal(calls, 0);
  } finally {
    await service.close();
    await rm(directory, { recursive: true });
  }
});

test("a contact awaiting private duplicate review does not block a different contact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prospectus-review-"));
  let creates = 0;
  let independent: IssueRecord | undefined;
  const service = await openIntake({
    directory,
    workspace: "test/prospectus",
    owner: "seller",
    siteId: "review",
    formId: "demo",
    request: async (path, init) => {
      if (!init?.method) {
        if (!path.startsWith("/issues?")) return independent!;
        const fields = JSON.parse(new URL(path, "http://local").searchParams.get("fields")!);
        return {
          issues: fields[0].value === "alex@example.invalid" ? [{} as IssueRecord, {} as IssueRecord] : [],
        };
      }
      creates++;
      independent = {
        issue: { id: "prsp-independent", ...JSON.parse(String(init.body)), status: "new", priority: 2 },
        revision: "1",
      } as IssueRecord;
      return independent;
    },
  });
  try {
    // Duplicate matches are accepted and filed as a separate needs-review prospect.
    await service.submit(submission());
    assert.equal(creates, 1);
    await service.submit(submission({ email: "independent@example.invalid" }));
    assert.equal(creates, 2);
  } finally {
    await service.close();
    await rm(directory, { recursive: true });
  }
});

test("stale locks are not automatically reclaimed by competing workers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prospectus-stale-"));
  await mkdir(join(directory, "worker.lock"));
  await writeFile(join(directory, "worker.lock/pid"), "987654321");
  const options = {
    directory,
    workspace: "test/prospectus",
    owner: "seller",
    siteId: "review",
    formId: "demo",
    request: async () => ({ issues: [] }),
  };
  try {
    const outcomes = await Promise.allSettled([openIntake(options), openIntake(options)]);
    for (const outcome of outcomes) {
      assert.equal(outcome.status, "rejected");
      if (outcome.status === "rejected") assert.match(outcome.reason.message, /Stale intake worker lock/);
    }
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("failed receipt storage prevents subsequent unjournaled backend writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prospectus-disk-"));
  let requests = 0;
  const identityDirectory = await mkdtemp(join(tmpdir(), "prospectus-disk-controls-"));
  const service = await IntakeService.open({
    directory,
    identityStore: new FileControlStore(identityDirectory),
    workspace: "test/prospectus",
    owner: "seller",
    siteId: "review",
    formId: "demo",
    request: async () => {
      requests++;
      return { issues: [] };
    },
  });
  try {
    await rm(directory, { recursive: true });
    const input = submission();
    // The inquiry is stored in the inbox, but nothing is written to the CRM without a journal.
    await service.submit(input);
    await service.submit(input);
    assert.equal(requests, 0);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
    await rm(identityDirectory, { recursive: true, force: true });
  }
});

test("an operation mismatch retains the same saved intent rather than retrying with a new operation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prospectus-operation-"));
  const operations: string[] = [];
  const record = {
    issue: {
      id: "prsp-existing",
      title: "Example",
      type: "prospect",
      status: "new",
      priority: 2,
      custom: { contact_email: "alex@example.invalid", inquiries: [] },
    },
    revision: "1",
  } as IssueRecord;
  const service = await openIntake({
    directory,
    workspace: "test/prospectus",
    owner: "seller",
    siteId: "review",
    formId: "demo",
    request: async (path, init) => {
      if (!init?.method) return path.startsWith("/issues?") ? { issues: [record] } : record;
      operations.push(new Headers(init.headers).get("X-Operation-Id")!);
      throw new IntakeError(409, "Operation mismatch", "operation_conflict");
    },
  });
  try {
    const input = submission();
    await service.submit(input);
    await service.submit(input);
    assert.equal(operations.length, 2);
    assert.equal(new Set(operations).size, 1);
  } finally {
    await service.close();
    await rm(directory, { recursive: true });
  }
});
