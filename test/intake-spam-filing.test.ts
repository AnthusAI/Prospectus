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
import { IntakeService, validateSubmission, type IntakeOptions } from "../server/intake";
import { REAL_CONTACT_POLICY } from "../server/intake-contact-policy";
import { parseIntakeForm, waitlistContactPolicy } from "../server/intake-forms";
import { scoreInquiry, type SpamLabelling } from "../server/intake-spam";
import type { IssueRecord } from "../src/client";
import { BOT_SHAPED, exampleMailRules } from "./fixtures/intake-spam";

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
  const request: IntakeOptions["request"] = async (path, init) => {
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
  return { records, request };
};

const contact = (changes: Record<string, unknown> = {}) => ({
  submission_id: randomUUID(),
  name: "Alex Example",
  email: "alex@example.com",
  company: "Example Studio",
  message: "Please show the Papyrus demo to our contracts team next week.",
  website: "",
  notice_version: "contact-v1",
  marketing_opt_in: false,
  page_path: "/engage",
  campaign: {},
  ...changes,
});

const botShaped = (changes: Record<string, unknown> = {}) =>
  contact({
    name: BOT_SHAPED.name,
    email: BOT_SHAPED.email,
    company: BOT_SHAPED.company,
    message: BOT_SHAPED.message,
    ...changes,
  });

async function openDemo(
  options: {
    spamLabelling?: SpamLabelling;
    spamScorer?: IntakeOptions["spamScorer"];
    crm?: ReturnType<typeof fakeCrm>;
    controls?: MemoryControls;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "prospectus-spam-"));
  const crm = options.crm ?? fakeCrm();
  const controls = options.controls ?? new MemoryControls();
  const service = await IntakeService.open({
    directory,
    workspace: "test/prospectus",
    owner: "intake-queue",
    siteId: REAL_CONTACT_POLICY.siteId,
    formId: REAL_CONTACT_POLICY.formId,
    contactPolicy: REAL_CONTACT_POLICY,
    identityStore: controls,
    request: crm.request,
    now: () => new Date("2026-10-16T10:00:00Z"),
    log: () => undefined,
    // Test data uses @example.com only; these rules treat it like gmail.com.
    spamScorer: options.spamScorer ?? ((input) => scoreInquiry(input, exampleMailRules)),
    ...(options.spamLabelling ? { spamLabelling: options.spamLabelling } : {}),
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

test("label mode: likely spam gets the same reply, is stored with its result and filed with likely-spam and no follow-up", async () => {
  const { service, crm, controls, close } = await openDemo({ spamLabelling: "label" });
  try {
    const input = botShaped();
    assert.deepEqual(await service.submit(input), {
      receipt: input.submission_id,
      message: "Demo request received.",
    });
    const issue = only(crm);
    assert.deepEqual(issue.labels, ["likely-spam"]);
    assert.equal("next_action" in issue.custom!, false);
    assert.equal("next_follow_up_at" in issue.custom!, false);
    assert.equal(issue.custom!.spam_status, "likely_spam");
    const inquiry = (issue.custom!.inquiries as any[])[0];
    assert.equal(inquiry.spam_score, 0.784);
    assert.equal(inquiry.spam_verdict, "likely_spam");
    assert.deepEqual(inquiry.spam_reasons, ["gibberish_name", "template_only_message", "gmail_dot_scatter"]);
    assert.equal(inquiry.spam_rules_version, "intake-spam-rules-1");
    assert.equal(inquiry.spam_mode, "label");
    // The inbox keeps the full inquiry with the same result.
    const [item] = controls.inbox();
    assert.equal(item.status, "filed");
    assert.equal(item.inquiry.message, BOT_SHAPED.message);
    assert.equal(item.inquiry.spam_verdict, "likely_spam");
    assert.deepEqual(item.inquiry.spam_reasons, inquiry.spam_reasons);
    assert.equal(item.inquiry.spam_rules_version, "intake-spam-rules-1");
  } finally {
    await close();
  }
});

test("shadow mode (the default) scores and stores but adds no label and keeps the usual follow-up", async () => {
  const { service, crm, close } = await openDemo();
  try {
    const input = botShaped();
    assert.deepEqual(await service.submit(input), {
      receipt: input.submission_id,
      message: "Demo request received.",
    });
    const issue = only(crm);
    assert.equal(issue.labels, undefined);
    assert.equal(issue.custom!.next_action, "Respond to demo request");
    assert.equal(issue.custom!.next_follow_up_at, "2026-10-19");
    assert.equal(issue.custom!.spam_status, "likely_spam");
    const inquiry = (issue.custom!.inquiries as any[])[0];
    assert.equal(inquiry.spam_verdict, "likely_spam");
    assert.equal(inquiry.spam_mode, "shadow");
  } finally {
    await close();
  }
});

for (const mode of ["shadow", "label"] as const)
  test(`${mode} mode: a filled honeypot is stored in the inbox, filed and labelled, with the normal reply`, async () => {
    const { service, crm, controls, close } = await openDemo({ spamLabelling: mode });
    try {
      const input = contact({ website: "https://bot.example.com" });
      assert.deepEqual(await service.submit(input), {
        receipt: input.submission_id,
        message: "Demo request received.",
      });
      const issue = only(crm);
      assert.deepEqual(issue.labels, ["likely-spam"]);
      assert.equal("next_follow_up_at" in issue.custom!, false);
      const inquiry = (issue.custom!.inquiries as any[])[0];
      assert.deepEqual(inquiry.spam_reasons, ["honeypot"]);
      assert.equal(inquiry.spam_verdict, "likely_spam");
      assert.equal(inquiry.message, input.message);
      const [item] = controls.inbox();
      assert.equal(item.status, "filed");
      assert.deepEqual(item.inquiry.form_signals, { honeypot_filled: true });
      // The honeypot's text is never stored.
      assert.equal(JSON.stringify([...controls.objects.values()]).includes("bot.example.com"), false);
      assert.equal(JSON.stringify(issue).includes("bot.example.com"), false);
    } finally {
      await close();
    }
  });

test("a real visitor's 40-letter note is never labelled, even in label mode", async () => {
  const { service, crm, close } = await openDemo({ spamLabelling: "label" });
  try {
    await service.submit(
      botShaped({
        // Name, company and Gmail dots would score 0.766 without the note.
        company: "QwXrtPlKmnZbVcd",
        message:
          "Solution or problem: Contract review for our legal operations team, about two thousand a month.",
      }),
    );
    const issue = only(crm);
    assert.equal(issue.labels, undefined);
    assert.equal(issue.custom!.next_follow_up_at, "2026-10-19");
    const inquiry = (issue.custom!.inquiries as any[])[0];
    assert.equal(inquiry.spam_verdict, "uncertain");
    assert.equal(inquiry.spam_protected, true);
  } finally {
    await close();
  }
});

test("the scorer can never change the HTTP response", async () => {
  const outcomes: Array<{ statusCode: number; headers: unknown; body: Record<string, unknown> }> = [];
  for (const scenario of ["clean", "likely", "throws", "honeypot"] as const) {
    const { service, crm, controls, close } = await openDemo({
      spamLabelling: "label",
      spamScorer:
        scenario === "throws"
          ? () => {
              throw new Error("scorer bug");
            }
          : undefined,
    });
    try {
      const handler = createEvaluationHandler({
        allowedOrigins: ["https://anth.us"],
        open: async () => service,
      });
      const submission_id = randomUUID();
      const body =
        scenario === "likely" || scenario === "throws"
          ? botShaped({ submission_id })
          : contact({ submission_id, ...(scenario === "honeypot" ? { website: "filled" } : {}) });
      const response = await handler({
        requestContext: { http: { method: "POST" } },
        rawPath: "/intake/demo",
        headers: { origin: "https://anth.us", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const parsed = JSON.parse(response.body);
      assert.equal(parsed.receipt, submission_id);
      outcomes.push({
        statusCode: response.statusCode,
        headers: response.headers,
        body: { ...parsed, receipt: "" },
      });
      const issue = only(crm);
      const inquiry = (issue.custom!.inquiries as any[])[0];
      if (scenario === "throws") {
        // A scorer error files exactly as clean.
        assert.equal(inquiry.spam_verdict, "unscored");
        assert.deepEqual(inquiry.spam_reasons, ["scorer_error"]);
        assert.equal(issue.labels, undefined);
        assert.equal(issue.custom!.next_follow_up_at, "2026-10-19");
        assert.equal(controls.inbox()[0].inquiry.spam_verdict, "unscored");
      }
    } finally {
      await close();
    }
  }
  for (const outcome of outcomes.slice(1)) assert.deepEqual(outcome, outcomes[0]);
  assert.equal(outcomes[0].statusCode, 202);
});

test("elapsed_ms is optional, validated without rejecting, and outside the fingerprint", async () => {
  assert.equal(validateSubmission(contact({ elapsed_ms: 4200 }), REAL_CONTACT_POLICY).elapsed_ms, 4200);
  assert.equal(validateSubmission(contact({ elapsed_ms: 0 }), REAL_CONTACT_POLICY).elapsed_ms, 0);
  assert.equal(
    validateSubmission(contact({ elapsed_ms: 86_400_000 }), REAL_CONTACT_POLICY).elapsed_ms,
    86_400_000,
  );
  for (const elapsed_ms of [-1, 86_400_001, 1.5, "1200", null, true, {}])
    assert.equal(
      "elapsed_ms" in validateSubmission(contact({ elapsed_ms }), REAL_CONTACT_POLICY),
      false,
      JSON.stringify(elapsed_ms),
    );
  const { service, crm, controls, close } = await openDemo({ spamLabelling: "label" });
  try {
    const submission_id = randomUUID();
    const first = contact({ submission_id, elapsed_ms: 800 });
    assert.deepEqual(await service.submit(first), {
      receipt: submission_id,
      message: "Demo request received.",
    });
    // A retry of the same note with another timing is the same inquiry, not a resubmission.
    await service.submit({ ...first, elapsed_ms: 2400 });
    const issue = only(crm);
    const inquiries = issue.custom!.inquiries as any[];
    assert.equal(inquiries.length, 1);
    assert.deepEqual(inquiries[0].form_signals, { elapsed_ms: 800 });
    assert.deepEqual(inquiries[0].spam_reasons, ["fast_submit"]);
    assert.equal(inquiries[0].spam_verdict, "clean");
    assert.equal(controls.inbox().length, 1);
    // Without timing the fingerprint is unchanged from before elapsed_ms existed.
    const legacy = contact();
    await service.submit(legacy);
    await service.submit({ ...legacy, elapsed_ms: 5000 });
    assert.equal((only(crm).custom!.inquiries as any[]).length, 2);
  } finally {
    await close();
  }
});

test("a later clean message restores the follow-up on a likely-spam prospect and keeps the label", async () => {
  const { service, crm, close } = await openDemo({ spamLabelling: "label" });
  try {
    await service.submit(botShaped());
    assert.equal("next_follow_up_at" in only(crm).custom!, false);
    await service.submit(
      botShaped({ message: "Sorry, I sent the form empty. We need contract review help." }),
    );
    const issue = only(crm);
    assert.deepEqual(issue.labels, ["likely-spam"]);
    assert.equal(issue.custom!.next_action, "Respond to demo request");
    assert.equal(issue.custom!.next_follow_up_at, "2026-10-19");
    assert.equal(issue.custom!.spam_status, "uncertain");
    // A likely-spam inquiry never labels an existing prospect.
    const real = fakeCrm();
    const second = await openDemo({ spamLabelling: "label", crm: real });
    try {
      await second.service.submit(contact({ email: BOT_SHAPED.email }));
      await second.service.submit(botShaped());
      const prospect = only(real);
      assert.equal(prospect.labels, undefined);
      assert.equal(prospect.custom!.next_follow_up_at, "2026-10-19");
      assert.equal(prospect.custom!.spam_status, "likely_spam");
    } finally {
      await second.close();
    }
  } finally {
    await close();
  }
});

test("waitlist signups use the same scorer and add likely-spam to the waitlist labels in label mode", async () => {
  const form = parseIntakeForm({
    enabled: true,
    approval: "Ryan approved the Babulus waitlist notice and owner for these tests only",
    siteId: "babulus",
    formId: "babulus-waitlist-v1",
    kind: "waitlist",
    origins: ["https://babulus.anth.us"],
    noticeVersion: "babulus-waitlist-v1",
    owner: "intake-queue",
    defaultPagePath: "/waitlist",
    attributes: {},
  });
  for (const mode of ["shadow", "label"] as const) {
    const directory = await mkdtemp(join(tmpdir(), "prospectus-spam-waitlist-"));
    const crm = fakeCrm();
    const service = await IntakeService.open({
      directory,
      workspace: "test/prospectus",
      owner: form.owner,
      siteId: form.siteId,
      formId: form.formId,
      contactPolicy: waitlistContactPolicy(form),
      form,
      identityStore: new MemoryControls(),
      request: crm.request,
      now: () => new Date("2026-10-16T10:00:00Z"),
      log: () => undefined,
      spamLabelling: mode,
      spamScorer: (input) => scoreInquiry(input, exampleMailRules),
    });
    try {
      const submission_id = randomUUID();
      assert.deepEqual(
        await service.submit({
          submission_id,
          email: BOT_SHAPED.email,
          name: BOT_SHAPED.name,
          notice_version: "babulus-waitlist-v1",
          elapsed_ms: 300,
        }),
        { receipt: submission_id, message: "Waitlist signup received." },
      );
      const issue = only(crm);
      const inquiry = (issue.custom!.inquiries as any[])[0];
      assert.deepEqual(inquiry.spam_reasons, ["gibberish_name", "gmail_dot_scatter", "fast_submit"]);
      assert.equal(inquiry.spam_verdict, "likely_spam");
      assert.deepEqual(
        issue.labels,
        mode === "label" ? ["waitlist", "app-babulus", "likely-spam"] : ["waitlist", "app-babulus"],
      );
    } finally {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});
