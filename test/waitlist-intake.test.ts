import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEvaluationHandler, type EvaluationEvent } from "../server/evaluation-handler";
import { FileControlStore } from "../server/control-store";
import { IntakeError, IntakeService, validateWaitlistSubmission, type IntakeOptions } from "../server/intake";
import { REAL_CONTACT_POLICY } from "../server/intake-contact-policy";
import {
  enabledIntakeForms,
  parseIntakeForm,
  parseIntakeFormRegistry,
  waitlistContactPolicy,
  waitlistRoutePath,
  type IntakeFormConfig,
} from "../server/intake-forms";
import type { IssueRecord } from "../src/client";

const babulusEntry = {
  enabled: true,
  approval: "Ryan approved the Babulus waitlist notice and owner for these tests only",
  siteId: "babulus",
  formId: "babulus-waitlist-v1",
  kind: "waitlist",
  origins: ["https://babul.us", "https://www.babul.us", "https://babulus.anth.us"],
  noticeVersion: "babulus-waitlist-v1",
  owner: "intake-queue",
  defaultPagePath: "/waitlist",
  attributes: {
    persona: { values: ["business", "agency", "marketer", "creator", "developer", "other"] },
    source: { pattern: "^[a-z0-9][a-z0-9-]{0,39}$" },
  },
};
const babulus = parseIntakeForm(babulusEntry);
const otherApp: IntakeFormConfig = parseIntakeForm({
  ...babulusEntry,
  siteId: "papyrus",
  formId: "papyrus-waitlist-v1",
  noticeVersion: "papyrus-waitlist-v1",
  origins: ["https://papyrus.example.org"],
  attributes: {},
});

const signup = (changes: Record<string, unknown> = {}) => ({
  submission_id: randomUUID(),
  email: "casey@example.com",
  name: "Casey Example",
  marketing_opt_in: true,
  website: "",
  notice_version: "babulus-waitlist-v1",
  page_path: "/waitlist",
  campaign: { utm_campaign: "launch" },
  attributes: { persona: "creator", source: "waitlist-page" },
  ...changes,
});

const fakeCrm = (seed: IssueRecord[] = []) => {
  const records = new Map<string, IssueRecord>(seed.map((record) => [record.issue.id, record]));
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const request: IntakeOptions["request"] = async (path, init) => {
    calls.push({
      method: init?.method ?? "GET",
      path,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (!init?.method) {
      if (path.startsWith("/issues?")) {
        const fields = JSON.parse(new URL(path, "http://local").searchParams.get("fields")!);
        return {
          issues: [...records.values()].filter(
            (record) => record.issue.custom?.contact_email === fields[0].value,
          ),
        };
      }
      return structuredClone(records.get(decodeURIComponent(path.slice("/issues/".length)))!);
    }
    const body = JSON.parse(String(init.body));
    if (init.method === "POST") {
      const record = {
        issue: { id: `prsp-${records.size + 1}`, ...body, status: "new", priority: 2 },
        revision: "1",
      } as IssueRecord;
      records.set(record.issue.id, structuredClone(record));
      return record;
    }
    const id = decodeURIComponent(path.slice("/issues/".length));
    const current = structuredClone(records.get(id)!);
    const updated = {
      issue: {
        ...current.issue,
        ...(body.labels ? { labels: body.labels } : {}),
        custom: { ...current.issue.custom, ...body.custom },
      },
      revision: String(Number(current.revision) + 1),
    } as IssueRecord;
    records.set(id, structuredClone(updated));
    return updated;
  };
  return { records, calls, request };
};

const openWaitlist = async (form: IntakeFormConfig, request: IntakeOptions["request"], shared: string) => {
  const directory = await mkdtemp(join(tmpdir(), "prospectus-waitlist-"));
  const service = await IntakeService.open({
    directory,
    workspace: "test/prospectus",
    owner: form.owner,
    siteId: form.siteId,
    formId: form.formId,
    contactPolicy: waitlistContactPolicy(form),
    form,
    identityStore: new FileControlStore(join(shared, "identity")),
    request,
    now: () => new Date("2026-10-16T10:00:00Z"),
  });
  return {
    service,
    close: async () => (await service.close(), rm(directory, { recursive: true, force: true })),
  };
};

test("the registry file ships the Babulus waitlist disabled with its own notice and the three Babulus origins", async () => {
  const forms = parseIntakeFormRegistry(JSON.parse(await readFile("intake-forms.json", "utf8")));
  assert.equal(forms.length, 1);
  assert.equal(forms[0].siteId, "babulus");
  assert.equal(forms[0].formId, "babulus-waitlist-v1");
  assert.equal(forms[0].noticeVersion, "babulus-waitlist-v1");
  assert.notEqual(forms[0].noticeVersion, REAL_CONTACT_POLICY.noticeVersion);
  assert.equal(forms[0].enabled, false);
  assert.deepEqual(enabledIntakeForms(forms), []);
  assert.deepEqual(forms[0].origins, ["https://babul.us", "https://www.babul.us", "https://babulus.anth.us"]);
  assert.equal(waitlistRoutePath(forms[0]), "/intake/waitlist/babulus-waitlist-v1");
});

test("a registry entry is rejected when enabled without approval, malformed, unknown or duplicated", () => {
  const { approval: _approval, ...unapproved } = babulusEntry;
  for (const changes of [
    unapproved,
    { ...babulusEntry, origins: ["http://babul.us"] },
    { ...babulusEntry, origins: ["https://babul.us/path"] },
    { ...babulusEntry, origins: [] },
    { ...babulusEntry, kind: "newsletter" },
    { ...babulusEntry, formId: "Bad Id" },
    { ...babulusEntry, owner: "" },
    { ...babulusEntry, extra: true },
    { ...babulusEntry, attributes: { persona: { values: ["a"], pattern: "x" } } },
    { ...babulusEntry, throttle: { rate: 5, burst: 2 } },
  ])
    assert.throws(() => parseIntakeForm(changes), /Intake form/);
  assert.throws(() => parseIntakeFormRegistry({ forms: [babulusEntry, babulusEntry] }), /declared twice/);
  assert.doesNotThrow(() => parseIntakeForm({ ...unapproved, enabled: false }));
});

test("waitlist validation accepts the minimal signup and normalizes the email and attribute order", () => {
  const minimal = validateWaitlistSubmission(
    { submission_id: randomUUID(), email: " Casey@Example.COM ", notice_version: "babulus-waitlist-v1" },
    babulus,
    waitlistContactPolicy(babulus),
  );
  assert.equal(minimal.email, "casey@example.com");
  assert.equal(minimal.name, "");
  assert.equal(minimal.marketing_opt_in, false);
  assert.equal(minimal.page_path, "/waitlist");
  assert.deepEqual(minimal.attributes, {});
  for (const persona of ["business", "agency", "marketer", "creator", "developer", "other"])
    assert.equal(
      validateWaitlistSubmission(signup({ attributes: { persona } }), babulus, waitlistContactPolicy(babulus))
        .attributes.persona,
      persona,
    );
});

test("waitlist validation rejects bad emails, notices, personas, sources, controls and unknown fields", () => {
  const policy = waitlistContactPolicy(babulus);
  for (const changes of [
    { email: "not an email" },
    { email: "casey@localhost" },
    { email: "" },
    { submission_id: "not-a-uuid" },
    { notice_version: "contact-v1" },
    { notice_version: "" },
    { marketing_opt_in: "yes" },
    { name: "x".repeat(151) },
    { page_path: "/?token=secret" },
    { campaign: { secret: "token" } },
    { attributes: { persona: "wizard" } },
    { attributes: { persona: ["creator"] } },
    { attributes: { source: "Waitlist Page!" } },
    { attributes: { role: "admin" } },
    { attributes: "creator" },
    { company: "Example" },
    { message: "Hello" },
    { site_id: "papyrus" },
    { form_id: "other-form" },
    { owner: "intruder" },
    { assignee: "intruder" },
    { status: "customer" },
    { id: "prsp-1" },
  ])
    assert.throws(
      () => validateWaitlistSubmission(signup(changes), babulus, policy),
      IntakeError,
      JSON.stringify(changes),
    );
  assert.throws(() => validateWaitlistSubmission([], babulus, policy), IntakeError);
});

const handlerFor = (opened: string[]) =>
  createEvaluationHandler({
    allowedOrigins: ["https://prospectus.anth.us", "https://anth.us", "https://www.anth.us"],
    forms: [babulus, otherApp],
    open: async () => {
      opened.push("demo");
      return {
        submit: async () => ({ receipt: "r", message: "Demo request received." }),
        close: async () => undefined,
      };
    },
    openForm: async (form) => {
      opened.push(form.formId);
      return {
        submit: async () => ({ receipt: "r", message: "Waitlist signup received." }),
        close: async () => undefined,
      };
    },
  });
const postTo = (rawPath: string, origin: string | undefined, body: unknown = signup()): EvaluationEvent => ({
  rawPath,
  requestContext: { http: { method: "POST" } },
  headers: { ...(origin ? { origin } : {}), "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("each origin reaches only its own form: Babulus cannot post demo intake and anth.us cannot post a waitlist", async () => {
  const opened: string[] = [];
  const handler = handlerFor(opened);
  const waitlist = waitlistRoutePath(babulus);
  for (const [path, origin, expected] of [
    [waitlist, "https://babul.us", 202],
    [waitlist, "https://www.babul.us", 202],
    [waitlist, "https://babulus.anth.us", 202],
    [waitlist, "https://anth.us", 403],
    [waitlist, "https://www.anth.us", 403],
    [waitlist, "https://prospectus.anth.us", 403],
    [waitlist, "https://papyrus.example.org", 403],
    [waitlist, "https://babul.us.evil.example", 403],
    [waitlist, "http://babul.us", 403],
    [waitlist, undefined, 403],
    ["/intake/demo", "https://babul.us", 403],
    ["/intake/demo", "https://www.babul.us", 403],
    ["/intake/demo", "https://babulus.anth.us", 403],
    ["/intake/demo", "https://anth.us", 202],
    [waitlistRoutePath(otherApp), "https://babul.us", 403],
    [waitlistRoutePath(otherApp), "https://papyrus.example.org", 202],
  ] as const) {
    const before = opened.length;
    const result = await handler(postTo(path, origin));
    assert.equal(result.statusCode, expected, `${path} from ${origin}`);
    assert.equal(opened.length - before, expected === 202 ? 1 : 0, `${path} from ${origin}`);
  }
});

test("an unknown form, a body-declared form and other methods are not found before any service opens", async () => {
  const opened: string[] = [];
  const handler = handlerFor(opened);
  for (const event of [
    postTo("/intake/waitlist/unknown-form-v1", "https://babul.us"),
    postTo("/intake/waitlist/", "https://babul.us"),
    postTo("/intake/waitlist", "https://babul.us", signup({ form_id: "babulus-waitlist-v1" })),
    postTo("/intake/babulus-waitlist-v1", "https://babul.us"),
    {
      ...postTo(waitlistRoutePath(babulus), "https://babul.us"),
      requestContext: { http: { method: "GET" } },
    },
  ])
    assert.equal((await handler(event)).statusCode, 404);
  assert.deepEqual(opened, []);
});

test("a waitlist route enforces the same content type and size rules as demo intake", async () => {
  const opened: string[] = [];
  const handler = handlerFor(opened);
  const base = postTo(waitlistRoutePath(babulus), "https://babul.us");
  assert.equal(
    (await handler({ ...base, headers: { origin: "https://babul.us", "content-type": "text/plain" } }))
      .statusCode,
    415,
  );
  assert.equal((await handler({ ...base, body: "x".repeat(16385) })).statusCode, 400);
  assert.equal((await handler({ ...base, body: "{" })).statusCode, 400);
  assert.deepEqual(opened, []);
});

test("a handler without registry forms still serves only the demo route", async () => {
  const handler = createEvaluationHandler({
    allowedOrigins: ["https://anth.us"],
    open: async () => ({
      submit: async () => ({ receipt: "r", message: "ok" }),
      close: async () => undefined,
    }),
  });
  assert.equal((await handler(postTo("/intake/demo", "https://anth.us"))).statusCode, 202);
  assert.equal((await handler(postTo(waitlistRoutePath(babulus), "https://babul.us"))).statusCode, 404);
});

test("a Babulus signup becomes one new tagged prospect with no follow-up action and no account side effects", async () => {
  const shared = await mkdtemp(join(tmpdir(), "prospectus-waitlist-shared-"));
  const crm = fakeCrm();
  const { service, close } = await openWaitlist(babulus, crm.request, shared);
  try {
    const input = signup();
    const response = await service.submit(input);
    assert.deepEqual(response, { receipt: input.submission_id, message: "Waitlist signup received." });
    assert.equal(crm.records.size, 1);
    const { issue } = [...crm.records.values()][0];
    assert.equal(issue.type, "prospect");
    assert.equal(issue.status, "new");
    assert.equal(issue.assignee, "intake-queue");
    assert.equal(issue.title, "Casey Example");
    assert.deepEqual(issue.labels, ["waitlist", "app-babulus"]);
    assert.equal(issue.custom!.contact_email, "casey@example.com");
    assert.equal("next_action" in issue.custom!, false);
    assert.equal("next_follow_up_at" in issue.custom!, false);
    const inquiries = issue.custom!.inquiries as any[];
    assert.equal(inquiries.length, 1);
    assert.equal(inquiries[0].kind, "waitlist");
    assert.equal(inquiries[0].marketing_opt_in, true);
    assert.deepEqual(inquiries[0].attributes, { persona: "creator", source: "waitlist-page" });
    assert.deepEqual(inquiries[0].source, {
      site_id: "babulus",
      form_id: "babulus-waitlist-v1",
      page_path: "/waitlist",
      campaign: { utm_campaign: "launch" },
    });
    assert.equal(inquiries[0].received_at, "2026-10-16T10:00:00.000Z");
    for (const call of crm.calls) assert.match(call.path, /^\/issues(\?|$|\/)/);
    assert.ok(crm.calls.every((call) => !/member|account|entitle|appointment|booking/i.test(call.path)));
    assert.equal(JSON.stringify([...crm.records.values()]).match(/member|entitlement|appointment/i), null);
  } finally {
    await close();
    await rm(shared, { recursive: true, force: true });
  }
});

test("a signup without a name uses the email as the prospect title", async () => {
  const shared = await mkdtemp(join(tmpdir(), "prospectus-waitlist-shared-"));
  const crm = fakeCrm();
  const { service, close } = await openWaitlist(babulus, crm.request, shared);
  try {
    await service.submit({
      submission_id: randomUUID(),
      email: "Anon@Example.com",
      notice_version: "babulus-waitlist-v1",
    });
    assert.equal([...crm.records.values()][0].issue.title, "anon@example.com");
  } finally {
    await close();
    await rm(shared, { recursive: true, force: true });
  }
});

test("a waitlist signup from an existing demo contact appends to the same prospect and preserves its work", async () => {
  const shared = await mkdtemp(join(tmpdir(), "prospectus-waitlist-shared-"));
  const existing = {
    issue: {
      id: "prsp-existing",
      title: "Casey",
      type: "prospect",
      status: "qualified",
      priority: 2,
      assignee: "seller",
      labels: ["vip"],
      comments: [{ id: "c1", text: "Called." }],
      custom: {
        contact_email: "casey@example.com",
        next_action: "Prepare proposal",
        next_follow_up_at: "2026-10-20",
        inquiries: [{ id: randomUUID(), kind: "demo", source: { site_id: "anthus-website" } }],
      },
    },
    revision: "1",
  } as unknown as IssueRecord;
  const crm = fakeCrm([existing]);
  const { service, close } = await openWaitlist(babulus, crm.request, shared);
  try {
    await service.submit(signup());
    assert.equal(crm.records.size, 1);
    const { issue } = crm.records.get("prsp-existing")!;
    assert.equal(issue.status, "qualified");
    assert.equal(issue.assignee, "seller");
    assert.equal(issue.custom!.next_action, "Prepare proposal");
    assert.equal(issue.custom!.next_follow_up_at, "2026-10-20");
    assert.equal(issue.comments!.length, 1);
    assert.deepEqual(issue.labels, ["vip", "waitlist", "app-babulus"]);
    assert.equal((issue.custom!.inquiries as unknown[]).length, 2);
    assert.equal((issue.custom!.latest_source as any).site_id, "babulus");
    assert.equal(crm.calls.filter((call) => call.method === "POST").length, 0);
  } finally {
    await close();
    await rm(shared, { recursive: true, force: true });
  }
});

test("the same email on the same app stores one inquiry whether the receipt is retried or renewed", async () => {
  const shared = await mkdtemp(join(tmpdir(), "prospectus-waitlist-shared-"));
  const crm = fakeCrm();
  const { service, close } = await openWaitlist(babulus, crm.request, shared);
  try {
    const first = signup();
    const firstResponse = await service.submit(first);
    const retried = await service.submit(first);
    const renewed = await service.submit(signup({ attributes: { persona: "agency" }, name: "Casey Again" }));
    assert.deepEqual(retried, firstResponse);
    assert.equal(renewed.message, firstResponse.message);
    const { issue } = [...crm.records.values()][0];
    assert.equal((issue.custom!.inquiries as any[]).length, 1);
    assert.equal((issue.custom!.inquiries as any[])[0].attributes.persona, "creator");
    assert.equal(crm.records.size, 1);
    await assert.rejects(
      service.submit({ ...first, attributes: { persona: "developer" } }),
      (error: unknown) => error instanceof IntakeError && error.status === 409,
    );
  } finally {
    await close();
    await rm(shared, { recursive: true, force: true });
  }
});

test("a different app may add its own waitlist inquiry for the same email", async () => {
  const shared = await mkdtemp(join(tmpdir(), "prospectus-waitlist-shared-"));
  const crm = fakeCrm();
  const first = await openWaitlist(babulus, crm.request, shared);
  const second = await openWaitlist(otherApp, crm.request, shared);
  try {
    await first.service.submit(signup());
    await second.service.submit({
      submission_id: randomUUID(),
      email: "casey@example.com",
      notice_version: "papyrus-waitlist-v1",
    });
    assert.equal(crm.records.size, 1);
    const { issue } = [...crm.records.values()][0];
    assert.deepEqual(
      (issue.custom!.inquiries as any[]).map((inquiry) => inquiry.source.site_id),
      ["babulus", "papyrus"],
    );
    assert.deepEqual(issue.labels, ["waitlist", "app-babulus", "app-papyrus"]);
  } finally {
    await first.close();
    await second.close();
    await rm(shared, { recursive: true, force: true });
  }
});

test("the honeypot returns success and neither claims nor writes anything", async () => {
  const shared = await mkdtemp(join(tmpdir(), "prospectus-waitlist-shared-"));
  const crm = fakeCrm();
  const { service, close } = await openWaitlist(babulus, crm.request, shared);
  try {
    const input = signup({ website: "https://spam.example" });
    assert.deepEqual(await service.submit(input), {
      receipt: input.submission_id,
      message: "Waitlist signup received.",
    });
    assert.deepEqual(crm.calls, []);
    assert.equal(crm.records.size, 0);
  } finally {
    await close();
    await rm(shared, { recursive: true, force: true });
  }
});

test("a service cannot open a waitlist form whose source differs from its registry entry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prospectus-waitlist-mismatch-"));
  try {
    for (const changes of [{ siteId: "papyrus" }, { formId: "other-form-v1" }, { owner: "someone" }])
      await assert.rejects(
        IntakeService.open({
          directory,
          workspace: "test/prospectus",
          owner: babulus.owner,
          siteId: babulus.siteId,
          formId: babulus.formId,
          contactPolicy: waitlistContactPolicy(babulus),
          form: babulus,
          identityStore: new FileControlStore(join(directory, "identity")),
          request: async () => ({ issues: [] }),
          ...changes,
        }),
        /registry entry/,
      );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("demo intake still creates exactly the fields it created before the registry existed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prospectus-demo-unchanged-"));
  const crm = fakeCrm();
  const service = await IntakeService.open({
    directory,
    workspace: "test/prospectus",
    owner: "intake-queue",
    siteId: REAL_CONTACT_POLICY.siteId,
    formId: REAL_CONTACT_POLICY.formId,
    contactPolicy: REAL_CONTACT_POLICY,
    identityStore: new FileControlStore(join(directory, "identity")),
    request: crm.request,
    now: () => new Date("2026-10-16T10:00:00Z"),
  });
  try {
    const receipt = randomUUID();
    const response = await service.submit({
      submission_id: receipt,
      name: "Alex Example",
      email: "alex@example.com",
      company: "Example Studio",
      message: "Please show the demo.",
      website: "",
      notice_version: "contact-v1",
      marketing_opt_in: false,
      page_path: "/contact",
      campaign: {},
    });
    assert.deepEqual(response, { receipt, message: "Demo request received." });
    const create = crm.calls.find((call) => call.method === "POST")!;
    assert.deepEqual(Object.keys(create.body).sort(), ["assignee", "custom", "description", "title", "type"]);
    assert.deepEqual(Object.keys(create.body.custom).sort(), [
      "company",
      "contact_email",
      "first_source",
      "inquiries",
      "latest_inquiry_at",
      "latest_source",
      "next_action",
      "next_follow_up_at",
    ]);
    assert.equal(create.body.custom.next_action, "Respond to demo request");
    assert.equal(create.body.custom.next_follow_up_at, "2026-10-19");
    assert.equal(create.body.custom.inquiries[0].kind, "demo");
    assert.equal("attributes" in create.body.custom.inquiries[0], false);
    assert.throws(
      () =>
        service.submit({ submission_id: randomUUID(), email: "a@example.com", notice_version: "contact-v1" }),
      IntakeError,
    );
    assert.throws(
      () =>
        service.submit({
          submission_id: randomUUID(),
          name: "A",
          email: "a@example.com",
          message: "m",
          notice_version: "contact-v1",
          attributes: { persona: "creator" },
        }),
      /Unknown form field/,
    );
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
