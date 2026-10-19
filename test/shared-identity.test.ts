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
import { IntakeError, IntakeService, type IntakeOptions } from "../server/intake";
import type { IssueRecord } from "../src/client";

class MemoryControls implements ConditionalControlStore {
  objects = new Map<string, ControlObject>();
  afterPut?: (object: ControlObject) => void;
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
    this.afterPut?.(object);
    return structuredClone(object);
  }
}

class CanonicalApi {
  records = new Map<string, IssueRecord>();
  operations = new Map<string, { hash: string; result: IssueRecord }>();
  creates = 0;
  catalogOnline = true;
  loseCreate = false;
  losePatch = false;
  queries = 0;
  request: IntakeOptions["request"] = async (path, init = {}) => {
    if (!init.method) {
      if (path.startsWith("/issues?")) {
        this.queries++;
        const predicates = JSON.parse(new URL(path, "http://local").searchParams.get("fields")!);
        return {
          issues: this.catalogOnline
            ? [...this.records.values()]
                .filter((record) => record.issue.custom!.contact_email === predicates[0].value)
                .map((record) => structuredClone(record))
            : [],
        };
      }
      const record = this.records.get(path.slice("/issues/".length));
      if (!record) throw new IntakeError(404, "Missing canonical record");
      return structuredClone(record);
    }
    const headers = new Headers(init.headers);
    const operation = headers.get("X-Operation-Id")!;
    const hash = JSON.stringify([path, init.method, init.body, headers.get("If-Match")]);
    const prior = this.operations.get(operation);
    if (prior) {
      if (prior.hash !== hash) throw new IntakeError(409, "Operation mismatch", "operation_conflict");
      return structuredClone(prior.result);
    }
    const body = JSON.parse(String(init.body));
    let record: IssueRecord;
    if (init.method === "POST") {
      this.creates++;
      record = {
        issue: { ...body, id: `prsp-${randomUUID()}`, status: "new", priority: 2, comments: [] },
        revision: "1",
      };
    } else {
      record = structuredClone(this.records.get(path.slice("/issues/".length))!);
      if (record.revision !== headers.get("If-Match"))
        throw new IntakeError(409, "Revision changed", "revision_conflict");
      record.issue.custom = { ...record.issue.custom, ...body.custom };
      record.revision = String(Number(record.revision) + 1);
    }
    this.records.set(record.issue.id, structuredClone(record));
    this.operations.set(operation, { hash, result: structuredClone(record) });
    if (init.method === "POST" && this.loseCreate) {
      this.loseCreate = false;
      throw new Error("Lost create acknowledgement");
    }
    if (init.method === "PATCH" && this.losePatch) {
      this.losePatch = false;
      throw new Error("Lost patch acknowledgement");
    }
    return structuredClone(record);
  };
}
const input = (changes = {}) => ({
  submission_id: randomUUID(),
  name: "Example",
  email: "shared@example.invalid",
  company: "Example Co",
  message: "Synthetic shared inquiry",
  website: "",
  notice_version: "synthetic-demo-v1",
  marketing_opt_in: false,
  page_path: "/request-demo",
  campaign: {},
  ...changes,
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "prospectus-shared-"));
  const controls = new MemoryControls();
  const api = new CanonicalApi();
  const workers: IntakeService[] = [];
  let number = 0;
  return {
    controls,
    api,
    async worker(changes: Partial<IntakeOptions> = {}) {
      const service = await IntakeService.open({
        directory: join(root, `worker-${++number}`),
        workspace: "test/prospectus",
        owner: "seller",
        siteId: "review",
        formId: "demo",
        identityStore: controls,
        request: api.request,
        ...changes,
      });
      workers.push(service);
      return service;
    },
    async close() {
      await Promise.all(workers.map((worker) => worker.close()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("independent workers share one immutable create operation and append each receipt once", async () => {
  const setup = await fixture();
  try {
    const workers = await Promise.all([setup.worker(), setup.worker(), setup.worker()]);
    const requests = [
      input({ campaign: { utm_source: "review", utm_medium: "test" } }),
      input(),
      input(),
      input(),
    ];
    await Promise.all(requests.map((request, index) => workers[index % workers.length].submit(request)));
    await Promise.all(workers.map((worker) => worker.submit(requests[0])));
    await workers[1].submit({ ...requests[0], campaign: { utm_medium: "test", utm_source: "review" } });
    assert.equal(setup.api.creates, 1);
    assert.equal(setup.api.records.size, 1);
    const record = [...setup.api.records.values()][0];
    assert.equal((record.issue.custom!.inquiries as unknown[]).length, 4);
    assert.equal(setup.controls.objects.size, 5);
    const claim = JSON.parse(
      [...setup.controls.objects.entries()].find(([key]) => key.startsWith("intake-identities/"))![1].bytes,
    );
    assert.equal(claim.issueId, record.issue.id);
    assert.ok(claim.create.operation);
    await assert.rejects(
      workers[1].submit({ ...requests[0], message: "Different payload, same receipt" }),
      (error: unknown) => error instanceof IntakeError && error.status === 409,
    );
  } finally {
    await setup.close();
  }
});

test("a durable claim with lost acknowledgement survives receipt loss and catalog rebuild", async () => {
  const setup = await fixture();
  try {
    let fail = true;
    setup.controls.afterPut = (object) => {
      const value = JSON.parse(object.bytes);
      if (fail && value.create && !value.issueId) {
        fail = false;
        throw new Error("Lost claim acknowledgement");
      }
    };
    const first = input();
    const initial = await setup.worker();
    await assert.rejects(initial.submit(first), /Lost claim acknowledgement/);
    assert.equal(setup.api.creates, 0);
    await initial.close();
    setup.api.catalogOnline = false;
    const recovered = await setup.worker();
    await recovered.submit(input({ message: "Second worker recovers first intent" }));
    await recovered.submit(first);
    assert.equal(setup.api.creates, 1);
    assert.equal(([...setup.api.records.values()][0].issue.custom!.inquiries as unknown[]).length, 2);
    const queries = setup.api.queries;
    const rebuiltReceipts = await setup.worker();
    await rebuiltReceipts.submit(first);
    assert.equal(
      setup.api.queries,
      queries,
      "Existing claim bypasses unavailable/rebuilt supplemental catalog",
    );
    assert.equal(setup.api.creates, 1);
  } finally {
    await setup.close();
  }
});

test("lost canonical creation and claim-completion responses are recovered by another worker", async () => {
  for (const failure of ["create", "completion"]) {
    const setup = await fixture();
    try {
      if (failure === "create") setup.api.loseCreate = true;
      else {
        let fail = true;
        setup.controls.afterPut = (object) => {
          if (fail && JSON.parse(object.bytes).issueId) {
            fail = false;
            throw new Error("Lost completion acknowledgement");
          }
        };
      }
      const request = input();
      const first = await setup.worker();
      await assert.rejects(first.submit(request));
      await first.close();
      setup.api.catalogOnline = false;
      await (await setup.worker()).submit(request);
      assert.equal(setup.api.creates, 1);
      assert.equal(([...setup.api.records.values()][0].issue.custom!.inquiries as unknown[]).length, 1);
    } finally {
      await setup.close();
    }
  }
});

test("another worker resolves a lost append response without duplicating its receipt", async () => {
  const setup = await fixture();
  try {
    const first = await setup.worker();
    await first.submit(input());
    const request = input({ message: "Lost appended response" });
    setup.api.losePatch = true;
    await assert.rejects(first.submit(request), /Lost patch/);
    await first.close();
    await (await setup.worker()).submit(request);
    assert.equal(setup.api.creates, 1);
    assert.equal(([...setup.api.records.values()][0].issue.custom!.inquiries as unknown[]).length, 2);
  } finally {
    await setup.close();
  }
});

test("a rejected claim write never publishes a canonical record and can be retried safely", async () => {
  const setup = await fixture();
  try {
    const put = setup.controls.putControl.bind(setup.controls);
    let fail = true;
    setup.controls.putControl = async (path, bytes, condition) => {
      if (fail) {
        fail = false;
        throw new Error("Claim storage unavailable");
      }
      return put(path, bytes, condition);
    };
    const request = input();
    await assert.rejects((await setup.worker()).submit(request), /Claim storage unavailable/);
    assert.equal(setup.api.creates, 0);
    await (await setup.worker()).submit(request);
    assert.equal(setup.api.creates, 1);
  } finally {
    await setup.close();
  }
});

test("the same contact in different workspaces has separate claims and canonical records", async () => {
  const setup = await fixture();
  try {
    const otherApi = new CanonicalApi();
    const request = input();
    const first = await setup.worker();
    const second = await setup.worker({ workspace: "other/prospectus", request: otherApi.request });
    await Promise.all([first.submit(request), second.submit(request)]);
    assert.equal(setup.api.creates, 1);
    assert.equal(otherApi.creates, 1);
    assert.equal(setup.controls.objects.size, 4);
  } finally {
    await setup.close();
  }
});

test("a new worker cannot reuse a global receipt ID for another contact or payload", async () => {
  const setup = await fixture();
  try {
    const request = input();
    await (await setup.worker()).submit(request);
    await assert.rejects(
      (await setup.worker()).submit({ ...request, email: "another@example.invalid" }),
      (error: unknown) => error instanceof IntakeError && error.status === 409,
    );
    await assert.rejects(
      (await setup.worker()).submit({ ...request, message: "Changed request" }),
      (error: unknown) => error instanceof IntakeError && error.status === 409,
    );
    assert.equal(setup.api.creates, 1);
    assert.equal(setup.api.records.size, 1);
  } finally {
    await setup.close();
  }
});

test("a shared receipt with a lost acknowledgement is recovered from a fresh local ledger", async () => {
  const setup = await fixture();
  try {
    let fail = true;
    setup.controls.afterPut = (object) => {
      if (fail && JSON.parse(object.bytes).fingerprint) {
        fail = false;
        throw new Error("Lost receipt acknowledgement");
      }
    };
    const request = input();
    const worker = await setup.worker();
    await assert.rejects(worker.submit(request), /Lost receipt acknowledgement/);
    await worker.close();
    await (await setup.worker()).submit(request);
    assert.equal(setup.api.creates, 1);
    assert.equal(([...setup.api.records.values()][0].issue.custom!.inquiries as unknown[]).length, 1);
  } finally {
    await setup.close();
  }
});

test("a contact correction preserves known receipt replay while new old-email inquiries need review", async () => {
  const setup = await fixture();
  try {
    const request = input();
    await (await setup.worker()).submit(request);
    const record = [...setup.api.records.values()][0];
    record.issue.custom!.contact_email = "corrected@example.invalid";
    record.revision = "2";
    await (await setup.worker()).submit(request);
    await assert.rejects(
      (await setup.worker()).submit(input()),
      (error: unknown) => error instanceof IntakeError && error.code === "identity_changed",
    );
    assert.equal(setup.api.creates, 1);
    assert.equal((record.issue.custom!.inquiries as unknown[]).length, 1);
  } finally {
    await setup.close();
  }
});
