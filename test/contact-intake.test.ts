import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ControlConflict,
  type ConditionalControlStore,
  type ControlCondition,
  type ControlObject,
} from "../server/control-store";
import { createEvaluationHandler, type EvaluationEvent } from "../server/evaluation-handler";
import { IntakeError, IntakeService, validateContactSubmission, type IntakeOptions } from "../server/intake";
import { REAL_CONTACT_POLICY } from "../server/intake-contact-policy";
import {
  contactRoutePath,
  enabledIntakeForms,
  formContactPolicy,
  formRoutePath,
  parseIntakeForm,
  parseIntakeFormRegistry,
  waitlistRoutePath,
} from "../server/intake-forms";
import { scoreInquiry } from "../server/intake-spam";
import { spamReviewChanges } from "../src/spam-review";
import type { IssueRecord } from "../src/client";
import { BOT_SHAPED, exampleMailRules } from "./fixtures/intake-spam";

const contactEntry = {
  enabled: true,
  approval: "Ryan approved the Papyrus contact notice and owner for these tests only",
  siteId: "papyrus",
  formId: "papyrus-contact-v1",
  kind: "contact",
  origins: ["https://p.apyr.us"],
  noticeVersion: "papyrus-contact-v1",
  owner: "intake-queue",
  defaultPagePath: "/contact",
  throttle: { rate: 1, burst: 2 },
};
const waitlistEntry = {
  enabled: true,
  approval: "Ryan approved the Papyrus waitlist notice and owner for these tests only",
  siteId: "papyrus",
  formId: "papyrus-waitlist-v1",
  kind: "waitlist",
  origins: ["https://p.apyr.us"],
  noticeVersion: "papyrus-waitlist-v1",
  owner: "intake-queue",
  defaultPagePath: "/early-access",
  attributes: { persona: { values: ["personal-feed", "personal-blog"] } },
};
const papyrusContact = parseIntakeForm(contactEntry);
const papyrusWaitlist = parseIntakeForm(waitlistEntry);
const policy = formContactPolicy(papyrusContact);

const message = (changes: Record<string, unknown> = {}) => ({
  submission_id: randomUUID(),
  name: "Casey Example",
  email: "casey@example.com",
  company: "Example Studio",
  message: "Can Papyrus publish a feed for our team blog?",
  website: "",
  notice_version: "papyrus-contact-v1",
  marketing_opt_in: false,
  page_path: "/contact",
  campaign: { utm_campaign: "launch" },
  ...changes,
});

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

const fakeCrm = (seed: IssueRecord[] = []) => {
  const records = new Map<string, IssueRecord>(seed.map((record) => [record.issue.id, record]));
  const state = { down: false };
  const request: IntakeOptions["request"] = async (path, init) => {
    if (state.down) throw new IntakeError(500, "Private CRM operation was not confirmed.");
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
  return { records, request, state };
};

async function openContact(crm = fakeCrm(), controls = new MemoryControls(), labelling?: "label") {
  const directory = await mkdtemp(join(tmpdir(), "prospectus-contact-"));
  const service = await IntakeService.open({
    directory,
    workspace: "test/prospectus",
    owner: papyrusContact.owner,
    siteId: papyrusContact.siteId,
    formId: papyrusContact.formId,
    contactPolicy: policy,
    form: papyrusContact,
    identityStore: controls,
    request: crm.request,
    now: () => new Date("2026-10-16T10:00:00Z"),
    log: () => undefined,
    spamScorer: (input) => scoreInquiry(input, exampleMailRules),
    ...(labelling ? { spamLabelling: labelling } : {}),
  });
  return {
    service,
    crm,
    controls,
    close: async () => {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const only = (crm: ReturnType<typeof fakeCrm>) => {
  assert.equal(crm.records.size, 1);
  return [...crm.records.values()][0].issue;
};

test("the contact route is its own path per form id and the registry resolves it by kind", () => {
  assert.equal(contactRoutePath(papyrusContact), "/intake/contact/papyrus-contact-v1");
  assert.equal(formRoutePath(papyrusContact), "/intake/contact/papyrus-contact-v1");
  assert.equal(formRoutePath(papyrusWaitlist), "/intake/waitlist/papyrus-waitlist-v1");
  assert.equal(papyrusContact.kind, "contact");
});

test("the shipped registry enables both Papyrus forms with recorded approvals, their own notices and only p.apyr.us", async () => {
  const forms = parseIntakeFormRegistry(JSON.parse(await readFile("intake-forms.json", "utf8")));
  const byId = Object.fromEntries(forms.map((form) => [form.formId, form]));
  assert.deepEqual(Object.keys(byId).sort(), [
    "babulus-waitlist-v1",
    "papyrus-contact-v1",
    "papyrus-waitlist-v1",
  ]);
  const waitlist = byId["papyrus-waitlist-v1"];
  const contact = byId["papyrus-contact-v1"];
  for (const form of [waitlist, contact]) {
    assert.equal(form.enabled, true);
    assert.match(form.approval ?? "", /^Ryan approved 2026-10-21: owner intake-queue; notice /);
    assert.equal(form.siteId, "papyrus");
    assert.equal(form.owner, "intake-queue");
    assert.deepEqual(form.origins, ["https://p.apyr.us"]);
    assert.deepEqual(form.throttle, { rate: 1, burst: 2 });
    assert.equal(form.noticeVersion, form.formId);
    assert.notEqual(form.noticeVersion, REAL_CONTACT_POLICY.noticeVersion);
    assert.ok(enabledIntakeForms(forms).includes(form));
  }
  assert.equal(waitlist.kind, "waitlist");
  assert.equal(waitlist.defaultPagePath, "/early-access");
  assert.deepEqual(waitlist.attributes, {
    persona: { values: ["personal-feed", "personal-blog"] },
    source: { pattern: "^[a-z0-9][a-z0-9-]{0,39}$" },
  });
  assert.equal(contact.kind, "contact");
  assert.equal(contact.defaultPagePath, "/contact");
  assert.deepEqual(contact.attributes, {});
  assert.equal(contactRoutePath(contact), "/intake/contact/papyrus-contact-v1");
  assert.ok(
    forms.every((form) => !/@/.test(form.approval ?? "")),
    "no email literals in approvals",
  );
});

test("a contact entry takes no attributes and shares an origin only with its own site's other kind", () => {
  assert.throws(
    () => parseIntakeForm({ ...contactEntry, attributes: { persona: { values: ["a"] } } }),
    /takes no attributes/,
  );
  assert.throws(() => parseIntakeForm({ ...contactEntry, kind: "newsletter" }), /waitlist or contact/);
  assert.throws(() => parseIntakeForm({ ...contactEntry, approval: undefined }), /recorded approval/);
  assert.doesNotThrow(() => parseIntakeFormRegistry({ forms: [waitlistEntry, contactEntry] }));
  for (const clash of [
    { ...contactEntry, formId: "papyrus-contact-v2", noticeVersion: "papyrus-contact-v2" },
    { ...contactEntry, formId: "other-contact-v1", noticeVersion: "other-contact-v1", siteId: "other" },
  ])
    assert.throws(
      () => parseIntakeFormRegistry({ forms: [waitlistEntry, contactEntry, clash] }),
      /more than one form/,
    );
  assert.throws(
    () => parseIntakeFormRegistry({ forms: [{ ...contactEntry, siteId: "other" }, waitlistEntry] }),
    /more than one form/,
  );
  for (const origin of ["https://anth.us", "https://www.anth.us", "https://prospectus.anth.us"])
    assert.throws(() => parseIntakeForm({ ...contactEntry, origins: [origin] }), /demo origin/);
});

test("contact validation accepts the demo fields under the form's notice and rejects everything else", () => {
  const valid = validateContactSubmission(message({ elapsed_ms: 4200 }), papyrusContact, policy);
  assert.equal(valid.message, "Can Papyrus publish a feed for our team blog?");
  assert.equal(valid.company, "Example Studio");
  assert.equal(valid.elapsed_ms, 4200);
  const minimal = validateContactSubmission(
    {
      submission_id: randomUUID(),
      name: "Casey",
      email: " CASEY@example.com ",
      message: "Hello",
      notice_version: "papyrus-contact-v1",
    },
    papyrusContact,
    policy,
  );
  assert.equal(minimal.email, "casey@example.com");
  assert.equal(minimal.company, "");
  assert.equal(minimal.page_path, "/contact", "the form's own default page path");
  for (const changes of [
    { notice_version: "contact-v1" },
    { notice_version: "papyrus-waitlist-v1" },
    { email: "not-an-email" },
    { name: "" },
    { message: "" },
    { message: "x".repeat(3001) },
    { submission_id: "nope" },
    { marketing_opt_in: "yes" },
    { page_path: "contact" },
    { site_id: "anthus-website" },
    { form_id: "engage-contact-v1" },
    { owner: "someone" },
    { assignee: "someone" },
    { status: "closed" },
    { attributes: {} },
  ])
    assert.throws(
      () => validateContactSubmission(message(changes), papyrusContact, policy),
      IntakeError,
      JSON.stringify(changes),
    );
  assert.throws(() => validateContactSubmission([], papyrusContact, policy), IntakeError);
});

const handlerFor = (opened: string[]) =>
  createEvaluationHandler({
    allowedOrigins: ["https://prospectus.anth.us", "https://anth.us", "https://www.anth.us"],
    forms: [papyrusContact, papyrusWaitlist],
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
        submit: async () => ({ receipt: "r", message: "ok" }),
        close: async () => undefined,
      };
    },
  });
const postTo = (rawPath: string, origin: string | undefined, body: unknown = message()): EvaluationEvent => ({
  rawPath,
  requestContext: { http: { method: "POST" } },
  headers: { ...(origin ? { origin } : {}), "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("each origin reaches only its own route: p.apyr.us cannot post demo intake and anth.us cannot post Papyrus contact", async () => {
  const opened: string[] = [];
  const handler = handlerFor(opened);
  const contact = contactRoutePath(papyrusContact);
  for (const [path, origin, expected] of [
    [contact, "https://p.apyr.us", 202],
    [contact, "https://anth.us", 403],
    [contact, "https://www.anth.us", 403],
    [contact, "https://prospectus.anth.us", 403],
    [contact, "https://babulus.anth.us", 403],
    [contact, "https://p.apyr.us.evil.example", 403],
    [contact, "http://p.apyr.us", 403],
    [contact, undefined, 403],
    ["/intake/demo", "https://p.apyr.us", 403],
    ["/intake/demo", "https://anth.us", 202],
    [waitlistRoutePath(papyrusWaitlist), "https://p.apyr.us", 202],
    [waitlistRoutePath(papyrusWaitlist), "https://anth.us", 403],
    // A route is its kind's: a contact form id is not served under the waitlist prefix, or the reverse.
    [`/intake/waitlist/${papyrusContact.formId}`, "https://p.apyr.us", 404],
    [`/intake/contact/${papyrusWaitlist.formId}`, "https://p.apyr.us", 404],
    ["/intake/contact/unknown-contact-v1", "https://p.apyr.us", 404],
    ["/intake/contact/", "https://p.apyr.us", 404],
    ["/intake/contact", "https://p.apyr.us", 404],
  ] as const) {
    const before = opened.length;
    const result = await handler(postTo(path, origin));
    assert.equal(result.statusCode, expected, `${path} from ${origin}`);
    assert.equal(opened.length - before, expected === 202 ? 1 : 0, `${path} from ${origin}`);
  }
  assert.deepEqual(
    opened.filter((name) => name !== "demo"),
    ["papyrus-contact-v1", "papyrus-waitlist-v1"],
  );
});

test("a contact route enforces the same content type and size rules as demo intake", async () => {
  const opened: string[] = [];
  const handler = handlerFor(opened);
  const base = postTo(contactRoutePath(papyrusContact), "https://p.apyr.us");
  assert.equal(
    (await handler({ ...base, headers: { origin: "https://p.apyr.us", "content-type": "text/plain" } }))
      .statusCode,
    415,
  );
  assert.equal((await handler({ ...base, body: "x".repeat(16385) })).statusCode, 400);
  assert.equal((await handler({ ...base, body: "{" })).statusCode, 400);
  assert.deepEqual(opened, []);
});

test("a contact message is stored first, then filed as a prospect that needs a reply", async () => {
  const { service, crm, controls, close } = await openContact();
  try {
    const input = message();
    assert.deepEqual(await service.submit(input), {
      receipt: input.submission_id,
      message: "Message received.",
    });
    const issue = only(crm);
    assert.equal(issue.type, "prospect");
    assert.equal(issue.assignee, "intake-queue");
    assert.equal(issue.title, "Casey Example");
    assert.equal(issue.description, input.message);
    assert.deepEqual(issue.labels, ["contact", "app-papyrus"]);
    assert.equal(issue.custom!.company, "Example Studio");
    assert.equal(issue.custom!.contact_email, "casey@example.com");
    assert.equal(issue.custom!.next_action, "Respond to inquiry");
    assert.equal(issue.custom!.next_follow_up_at, "2026-10-19");
    const [inquiry] = issue.custom!.inquiries as any[];
    assert.equal(inquiry.kind, "contact");
    assert.equal(inquiry.message, input.message);
    assert.deepEqual(inquiry.source, {
      site_id: "papyrus",
      form_id: "papyrus-contact-v1",
      page_path: "/contact",
      campaign: { utm_campaign: "launch" },
    });
    assert.equal(inquiry.notice_version, "papyrus-contact-v1");
    assert.equal(inquiry.spam_verdict, "clean");
    assert.equal(controls.inbox()[0].status, "filed");
    assert.equal(controls.inbox()[0].inquiry.message, input.message);
  } finally {
    await close();
  }
});

test("a CRM outage keeps the full message pending and the visitor still sees success; a retry files it once", async () => {
  const crm = fakeCrm();
  const { service, controls, close } = await openContact(crm);
  try {
    crm.state.down = true;
    const input = message({ message: "Do not lose this note" });
    const response = await service.submit(input);
    assert.equal(response.receipt, input.submission_id);
    assert.equal(crm.records.size, 0);
    const [item] = controls.inbox();
    assert.equal(item.status, "pending");
    assert.equal(item.inquiry.message, "Do not lose this note");
    assert.equal(item.inquiry.kind, "contact");
    crm.state.down = false;
    await service.submit(input);
    assert.equal(controls.inbox()[0].status, "filed");
    assert.equal((only(crm).custom!.inquiries as any[]).length, 1);
  } finally {
    await close();
  }
});

test("a repeat message from the same contact appends to the same prospect and a replay stores nothing twice", async () => {
  const { service, crm, close } = await openContact();
  try {
    const first = message();
    await service.submit(first);
    await service.submit(first);
    await service.submit(message({ message: "A second question about pricing." }));
    const issue = only(crm);
    assert.equal((issue.custom!.inquiries as any[]).length, 2);
    // Reusing a receipt for different content is never rejected: it is kept as its own inquiry.
    const reused = await service.submit({ ...first, message: "Different content, same receipt" });
    assert.equal(reused.receipt, first.submission_id);
    assert.equal((only(crm).custom!.inquiries as any[]).length, 3);
  } finally {
    await close();
  }
});

test("a message from a contact already on the Papyrus waitlist joins that prospect and keeps its work", async () => {
  const seed = {
    issue: {
      id: "prsp-9",
      type: "prospect",
      status: "qualified",
      assignee: "ryan",
      labels: ["waitlist", "app-papyrus"],
      custom: { contact_email: "casey@example.com", inquiries: [], notes: "Met at launch." },
    },
    revision: "4",
  } as unknown as IssueRecord;
  const crm = fakeCrm([seed]);
  const { service, close } = await openContact(crm);
  try {
    await service.submit(message());
    const issue = only(crm);
    assert.equal(issue.status, "qualified");
    assert.equal(issue.assignee, "ryan");
    assert.equal(issue.custom!.notes, "Met at launch.");
    assert.equal((issue.custom!.inquiries as any[]).length, 1);
    assert.ok(["waitlist", "app-papyrus", "contact"].every((label) => issue.labels!.includes(label)));
  } finally {
    await close();
  }
});

test("contact messages are spam scored like demo inquiries: shadow keeps the follow-up, label removes it", async () => {
  const bot = (changes = {}) =>
    message({
      name: BOT_SHAPED.name,
      email: BOT_SHAPED.email,
      company: BOT_SHAPED.company,
      message: BOT_SHAPED.message,
      ...changes,
    });
  const shadow = await openContact();
  try {
    await shadow.service.submit(bot());
    const issue = only(shadow.crm);
    assert.equal(issue.custom!.spam_status, "likely_spam");
    assert.equal(issue.custom!.next_action, "Respond to inquiry");
    assert.equal((issue.custom!.inquiries as any[])[0].spam_mode, "shadow");
  } finally {
    await shadow.close();
  }
  const label = await openContact(fakeCrm(), new MemoryControls(), "label");
  try {
    const input = bot();
    assert.deepEqual(await label.service.submit(input), {
      receipt: input.submission_id,
      message: "Message received.",
    });
    const issue = only(label.crm);
    assert.deepEqual(issue.labels, ["contact", "app-papyrus", "likely-spam"]);
    assert.equal("next_action" in issue.custom!, false);
    assert.equal("next_follow_up_at" in issue.custom!, false);
    const [inquiry] = issue.custom!.inquiries as any[];
    assert.deepEqual(inquiry.spam_reasons, ["gibberish_name", "template_only_message", "gmail_dot_scatter"]);
    assert.equal(inquiry.spam_verdict, "likely_spam");
    // Not spam restores the contact form's own follow-up wording.
    const change = spamReviewChanges(
      issue as any,
      "not_spam",
      { actor_id: "member-1", initial_status: "new", statuses: [], workflows: {} } as any,
      new Date("2026-10-16T10:00:00Z"),
    );
    assert.equal((change.custom as any).next_action, "Respond to inquiry");
  } finally {
    await label.close();
  }
});

test("a filled honeypot returns success and is stored, scored and labelled, never dropped", async () => {
  const { service, crm, controls, close } = await openContact(fakeCrm(), new MemoryControls(), "label");
  try {
    const input = message({ website: "https://spam.example" });
    assert.deepEqual(await service.submit(input), {
      receipt: input.submission_id,
      message: "Message received.",
    });
    const issue = only(crm);
    assert.deepEqual(issue.labels, ["contact", "app-papyrus", "likely-spam"]);
    const [inquiry] = issue.custom!.inquiries as any[];
    assert.ok(inquiry.spam_reasons.includes("honeypot"));
    assert.deepEqual(inquiry.form_signals, { honeypot_filled: true });
    assert.equal(JSON.stringify([...crm.records.values()]).includes("spam.example"), false);
    assert.equal(controls.inbox().length, 1);
  } finally {
    await close();
  }
});

test("a service cannot open a contact form whose source differs from its registry entry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prospectus-contact-"));
  try {
    await assert.rejects(
      IntakeService.open({
        directory,
        workspace: "test/prospectus",
        owner: papyrusContact.owner,
        siteId: "anthus-website",
        formId: papyrusContact.formId,
        contactPolicy: policy,
        form: papyrusContact,
        identityStore: new MemoryControls(),
        request: fakeCrm().request,
      }),
      /registry entry/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
