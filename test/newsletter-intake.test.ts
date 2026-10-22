import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileControlStore, type ConditionalControlStore } from "../server/control-store";
import {
  createEvaluationHandler,
  executeApiLinkBase,
  type EvaluationEvent,
} from "../server/evaluation-handler";
import { IntakeError, IntakeService, type IntakeOptions } from "../server/intake";
import {
  NEWSLETTER_MAIL_DOMAINS,
  enabledIntakeForms,
  formRoutePath,
  parseIntakeForm,
  parseIntakeFormRegistry,
  senderAddress,
  type IntakeFormConfig,
} from "../server/intake-forms";
import {
  CONFIRMATION_RESEND_MS,
  NEWSLETTER_CONTACT_POLICY,
  NEWSLETTER_SIGNUP_MESSAGE,
  NewsletterService,
  type SubscriptionRecord,
} from "../server/newsletter";
import { exportSubscribers, toCsv } from "../server/newsletter-export";
import { listHeaders, sesListMailer, type ListEmail } from "../server/newsletter-mailer";
import { PAGE_HEADERS, renderPage } from "../server/newsletter-pages";
import {
  CONFIRM_TOKEN_SECONDS,
  parameterStoreTokenSecret,
  signToken,
  verifyToken,
} from "../server/newsletter-token";
import type { IssueRecord } from "../src/client";

const entry = {
  enabled: true,
  approval: "Approved for these tests only, recorded here as a fixture",
  siteId: "papyrus",
  formId: "papyrus-newsletter-v1",
  kind: "newsletter",
  origins: ["https://p.apyr.us"],
  noticeVersion: "papyrus-newsletter-v1",
  owner: "intake-queue",
  defaultPagePath: "/",
  throttle: { rate: 1, burst: 2 },
  list: {
    name: "Papyrus",
    siteUrl: "https://p.apyr.us/",
    privacyUrl: "https://p.apyr.us/privacy/",
    senderLocalPart: "papyrus",
    senderDomain: "news.apyr.us",
  },
};
const form = parseIntakeForm(entry);
// The list sender, built so no address other than example.com appears literally in the source.
const SENDER = ["papyrus", "news.apyr.us"].join("@");
const LINK_BASE = "https://abcde12345.execute-api.us-east-1.amazonaws.com";
const secretBytes = randomBytes(48);
const tokenSecret = async () => secretBytes;

const signup = (changes: Record<string, unknown> = {}) => ({
  submission_id: randomUUID(),
  email: "casey@example.com",
  website: "",
  notice_version: "papyrus-newsletter-v1",
  page_path: "/",
  campaign: { utm_campaign: "launch" },
  elapsed_ms: 6000,
  ...changes,
});

/** A small fake CRM: one optional prospect; records every call. */
const fakeCrm = (seed?: IssueRecord) => {
  let record = seed ? structuredClone(seed) : undefined;
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const request: IntakeOptions["request"] = async (path, init) => {
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "GET" && path.startsWith("/issues?")) return { issues: record ? [record] : [] };
    if (method === "GET") {
      if (!record) throw new IntakeError(404, "missing");
      return structuredClone(record);
    }
    if (method === "PATCH" && record) {
      if (new Headers(init!.headers).get("if-match") !== record.revision)
        throw new IntakeError(409, "conflict", "revision_conflict");
      const body = JSON.parse(String(init!.body));
      record = {
        ...record,
        revision: `r${Number(record.revision.slice(1)) + 1}`,
        issue: { ...record.issue, custom: { ...record.issue.custom, ...body.custom } },
      };
      return record;
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { request, calls, current: () => record };
};

async function setup(
  options: {
    crm?: ReturnType<typeof fakeCrm>;
    mailer?: (email: ListEmail) => Promise<void>;
    store?: ConditionalControlStore;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "prospectus-newsletter-"));
  const store = options.store ?? new FileControlStore(directory);
  const sent: ListEmail[] = [];
  const logs: Array<{ event: string; reason: string }> = [];
  let now = new Date("2026-10-21T12:00:00Z");
  const service = new NewsletterService({
    workspace: "test/prospectus",
    store,
    forms: [form],
    contactPolicy: NEWSLETTER_CONTACT_POLICY,
    tokenSecret,
    mailer:
      options.mailer ??
      (async (email) => {
        sent.push(email);
      }),
    request: options.crm?.request,
    now: () => now,
    log: (item) => logs.push(item),
  });
  const handler = createEvaluationHandler({
    allowedOrigins: ["https://anth.us"],
    open: async () => {
      throw new Error("the demo service must not open");
    },
    forms: [form],
    openForm: async () => {
      throw new Error("a CRM inquiry service must not open for a newsletter");
    },
    newsletter: async () => service,
  });
  const post = (body: unknown, origin = "https://p.apyr.us", path = formRoutePath(form)) =>
    handler({
      requestContext: { http: { method: "POST" }, domainName: new URL(LINK_BASE).host },
      rawPath: path,
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const page = (method: "GET" | "POST", url: string, body?: string) => {
    const parsed = new URL(url);
    return handler({
      requestContext: { http: { method } },
      rawPath: parsed.pathname,
      rawQueryString: parsed.search.slice(1),
      headers: body ? { "content-type": "application/x-www-form-urlencoded" } : {},
      body: body ?? null,
      isBase64Encoded: false,
    });
  };
  const record = async (email = "casey@example.com") => {
    const object = await store.getControl(
      service.subscriptionPath(service.subscriptionHash(form.formId, email)),
    );
    return object ? (JSON.parse(object.bytes) as SubscriptionRecord) : null;
  };
  const link = (email: ListEmail, kind: "confirm" | "unsubscribe") =>
    kind === "unsubscribe" ? email.unsubscribeUrl : email.text.match(/https:\/\/\S+\/confirm\?token=\S+/)![0];
  return {
    directory,
    store,
    service,
    sent,
    logs,
    post,
    page,
    record,
    link,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test("registry: a newsletter entry is strict and gets its own route", () => {
  assert.equal(formRoutePath(form), "/intake/newsletter/papyrus-newsletter-v1");
  assert.equal(senderAddress(form.list!), SENDER);
  assert.ok((NEWSLETTER_MAIL_DOMAINS as readonly string[]).includes(form.list!.senderDomain));
  for (const [change, reason] of [
    [{ attributes: { persona: { values: ["a"] } } }, /takes no attributes/],
    [{ formId: "confirm" }, /page name/],
    [{ formId: "unsubscribe" }, /page name/],
    [{ list: undefined }, /needs a list/],
    [{ list: { ...entry.list, senderDomain: "apyr.us" } }, /shipped mail domain/],
    [{ list: { ...entry.list, senderLocalPart: "a b" } }, /mailbox name/],
    [{ list: { ...entry.list, privacyUrl: "http://p.apyr.us/privacy/" } }, /https URL/],
    [{ list: { ...entry.list, from: "x" } }, /unknown list setting/],
    [{ kind: "contact" }, /only a newsletter has a list/],
  ] as const)
    assert.throws(() => parseIntakeForm({ ...entry, ...change }), reason);
  // A runtime copy with the approval replaced still parses (it is what the Lambda receives).
  assert.deepEqual(parseIntakeForm(JSON.parse(JSON.stringify(form))), form);
});

test("registry: one site may share its origin between one waitlist, one contact form and one newsletter", () => {
  const forms = parseIntakeFormRegistry(JSON.parse(JSON.stringify({ forms: [] })));
  assert.deepEqual(forms, []);
  const shipped = parseIntakeFormRegistry(
    JSON.parse(
      JSON.stringify({
        forms: [
          { ...entry, formId: "papyrus-waitlist-v1", kind: "waitlist", list: undefined },
          { ...entry, formId: "papyrus-contact-v1", kind: "contact", list: undefined },
          entry,
        ],
      }),
    ),
  );
  assert.equal(shipped.length, 3);
  assert.throws(
    () => parseIntakeFormRegistry({ forms: [entry, { ...entry, formId: "papyrus-newsletter-v2" }] }),
    /used by more than one form/,
  );
  assert.throws(
    () =>
      parseIntakeFormRegistry({ forms: [entry, { ...entry, siteId: "babulus", formId: "other-news-v1" }] }),
    /used by more than one form/,
  );
});

test("the shipped Papyrus newsletter entry matches the contract promised to p.apyr.us", async () => {
  const forms = parseIntakeFormRegistry(JSON.parse(await readFile("intake-forms.json", "utf8")));
  const papyrus = forms.find((item) => item.formId === "papyrus-newsletter-v1")!;
  assert.equal(papyrus.kind, "newsletter");
  assert.equal(papyrus.siteId, "papyrus");
  assert.deepEqual(papyrus.origins, ["https://p.apyr.us"]);
  assert.equal(papyrus.noticeVersion, "papyrus-newsletter-v1");
  assert.equal(papyrus.owner, "intake-queue");
  assert.deepEqual(papyrus.throttle, { rate: 1, burst: 2 });
  assert.equal(papyrus.list?.name, "Papyrus");
  assert.equal(papyrus.list?.privacyUrl, "https://p.apyr.us/privacy/");
  assert.ok(enabledIntakeForms(forms).includes(papyrus));
  assert.match(papyrus.approval!, /Ryan approved 2026-10-21/);
  assert.doesNotMatch(papyrus.approval!, /@/, "no email literal in the approval");
});

test("only the newsletter fields are accepted; invalid fields are a 400 and store nothing", async () => {
  const t = await setup();
  try {
    for (const [body, message] of [
      [signup({ name: "Casey" }), "Unknown form field."],
      [signup({ email: "not-an-email" }), "Enter a valid email address."],
      [signup({ submission_id: "123" }), "Invalid submission receipt."],
      [
        signup({ notice_version: "papyrus-newsletter-v0" }),
        "Reload the page to read the current privacy notice.",
      ],
      [signup({ page_path: "javascript:alert(1)" }), "Invalid page path."],
      [signup({ campaign: { gclid: "x" } }), "Invalid campaign."],
      [signup({ marketing_opt_in: true }), "Unknown form field."],
    ] as const) {
      const response = await t.post(body);
      assert.equal(response.statusCode, 400);
      assert.equal(JSON.parse(response.body).message, message);
    }
    assert.deepEqual(await readdir(t.directory), []);
    assert.equal(t.sent.length, 0);
  } finally {
    await t.cleanup();
  }
});

test("always 202 with one message: new, pending, subscribed, unsubscribed and honeypot look the same", async () => {
  const t = await setup();
  try {
    const responses = [];
    const fresh = await t.post(signup());
    responses.push(fresh);
    t.advance(60_000);
    responses.push(await t.post(signup())); // pending, inside the resend window
    await t.page("POST", t.link(t.sent[0], "confirm"));
    responses.push(await t.post(signup())); // subscribed
    await t.page("POST", t.link(t.sent[0], "unsubscribe"));
    responses.push(await t.post(signup())); // unsubscribed
    responses.push(await t.post(signup({ email: "bot@example.com", website: "https://spam.example.com" })));
    for (const response of responses) {
      const body = JSON.parse(response.body);
      assert.equal(response.statusCode, 202);
      assert.deepEqual(Object.keys(body).sort(), ["message", "receipt"]);
      assert.equal(body.message, NEWSLETTER_SIGNUP_MESSAGE);
      assert.deepEqual(response.headers, responses[0].headers);
    }
    assert.equal(t.sent.length, 1, "only the first signup sent an email");
  } finally {
    await t.cleanup();
  }
});

test("store first: a signup is stored with its consent evidence and no IP, then one confirmation is sent", async () => {
  const t = await setup();
  try {
    const body = signup();
    const response = await t.post(body);
    assert.equal(response.statusCode, 202);
    assert.equal(JSON.parse(response.body).receipt, body.submission_id);
    const record = (await t.record())!;
    assert.equal(record.status, "pending");
    assert.equal(record.list_id, "papyrus-newsletter-v1");
    assert.equal(record.email, "casey@example.com");
    assert.equal(record.requests.length, 1);
    assert.equal(record.requests[0].notice_version, "papyrus-newsletter-v1");
    assert.equal(record.requests[0].page_path, "/");
    assert.deepEqual(record.requests[0].campaign, { utm_campaign: "launch" });
    assert.equal(record.requests[0].received_at, "2026-10-21T12:00:00.000Z");
    assert.equal(record.requests[0].confirmation, "sent");
    assert.equal(record.confirmation.sends, 1);
    assert.doesNotMatch(JSON.stringify(record), /\b(ip|source_ip|user_agent)\b/i);
    const [email] = t.sent;
    assert.equal(email.to, "casey@example.com");
    assert.equal(email.from, `Papyrus <${SENDER}>`);
    assert.equal(email.subject, "Confirm your Papyrus newsletter subscription");
    assert.equal(email.listId, "Papyrus <papyrus-newsletter-v1.news.apyr.us>");
    assert.match(email.text, /https:\/\/p\.apyr\.us\/privacy\//);
    assert.match(email.html, /Confirm subscription/);
    assert.ok(email.unsubscribeUrl.startsWith(`${LINK_BASE}/intake/newsletter/unsubscribe?token=n1.u.`));
    assert.ok(!email.unsubscribeUrl.includes("casey") && !t.link(email, "confirm").includes("casey"));
    // A replay of the same receipt changes nothing and sends nothing.
    await t.post(body);
    assert.equal((await t.record())!.requests.length, 1);
    assert.equal(t.sent.length, 1);
  } finally {
    await t.cleanup();
  }
});

test("tokens: signed, bound to purpose, list and subscription, expiring, and free of the address", async () => {
  const now = 1_800_000_000;
  const claims = {
    purpose: "confirm" as const,
    listId: "papyrus-newsletter-v1",
    subscription: "a".repeat(64),
    expires: now + CONFIRM_TOKEN_SECONDS,
  };
  const token = await signToken(tokenSecret, claims);
  assert.match(token, /^n1\.c\.papyrus-newsletter-v1\.a{64}\.\d+\.[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(await verifyToken(tokenSecret, token, "confirm", now), claims);
  assert.equal(
    await verifyToken(tokenSecret, token, "confirm", now + CONFIRM_TOKEN_SECONDS),
    null,
    "expired",
  );
  assert.equal(await verifyToken(tokenSecret, token, "unsubscribe", now), null, "wrong purpose");
  assert.equal(await verifyToken(async () => randomBytes(48), token, "confirm", now), null, "other key");
  const parts = token.split(".");
  for (const tampered of [
    [...parts.slice(0, 2), "babulus-newsletter-v1", ...parts.slice(3)].join("."),
    [...parts.slice(0, 3), "b".repeat(64), ...parts.slice(4)].join("."),
    [...parts.slice(0, 4), String(now + 10 * CONFIRM_TOKEN_SECONDS), parts[5]].join("."),
    token.slice(0, -1),
    `${token}x`,
    "",
    null,
  ])
    assert.equal(await verifyToken(tokenSecret, tampered, "confirm", now), null);
  const unsubscribe = await signToken(tokenSecret, { ...claims, purpose: "unsubscribe", expires: 0 });
  assert.ok(
    await verifyToken(tokenSecret, unsubscribe, "unsubscribe", now + 10 * 365 * 86400),
    "never expires",
  );
  await assert.rejects(signToken(tokenSecret, { ...claims, expires: 0 }), /permanent/);
  await assert.rejects(signToken(tokenSecret, { ...claims, purpose: "unsubscribe" }), /permanent/);
});

test("the token key comes from Parameter Store, fails closed and is not cached on failure", async () => {
  let calls = 0;
  let value: string | undefined = "c2hvcnQ=";
  const client = {
    send: async (command: any) => {
      calls++;
      assert.equal(command.input.Name, "/prospectus/newsletter/token-signing/v1");
      assert.equal(command.input.WithDecryption, true);
      return { Parameter: { Value: value } };
    },
  };
  const secret = parameterStoreTokenSecret("/prospectus/newsletter/token-signing/v1", client as any);
  await assert.rejects(secret(), /shorter than 32 bytes/);
  value = randomBytes(48).toString("base64");
  assert.equal((await secret()).length, 48);
  await secret();
  assert.equal(calls, 2, "a loaded key is cached, a failure is not");
});

test("confirm: the GET page changes nothing; its button activates with consent; repeating is harmless", async () => {
  const crm = fakeCrm();
  const t = await setup({ crm });
  try {
    await t.post(signup({ page_path: "/blog/hello", campaign: { utm_source: "feed" } }));
    const url = t.link(t.sent[0], "confirm");
    const prompt = await t.page("GET", url);
    assert.equal(prompt.statusCode, 200);
    assert.match(prompt.body, /<button type="submit">Confirm subscription<\/button>/);
    assert.match(prompt.body, /<form method="post" action="\?token=n1\.c\./);
    assert.equal((await t.record())!.status, "pending", "a scanner's GET confirms nothing");
    t.advance(3_600_000);
    const done = await t.page("POST", url);
    assert.equal(done.statusCode, 200);
    assert.match(done.body, /You&#39;re subscribed/);
    const record = (await t.record())!;
    assert.equal(record.status, "active");
    assert.deepEqual(record.consent, {
      notice_version: "papyrus-newsletter-v1",
      requested_at: "2026-10-21T12:00:00.000Z",
      confirmed_at: "2026-10-21T13:00:00.000Z",
      source: {
        site_id: "papyrus",
        form_id: "papyrus-newsletter-v1",
        page_path: "/blog/hello",
        campaign: { utm_source: "feed" },
      },
    });
    const again = await t.page("POST", url);
    assert.equal(again.statusCode, 200);
    assert.equal((await t.record())!.consent!.confirmed_at, "2026-10-21T13:00:00.000Z");
    assert.ok(!crm.calls.some((call) => call.method === "POST"), "no prospect is created");
  } finally {
    await t.cleanup();
  }
});

test("confirm: an expired, tampered or wrong-purpose link changes nothing", async () => {
  const t = await setup();
  try {
    await t.post(signup());
    const url = t.link(t.sent[0], "confirm");
    t.advance(CONFIRM_TOKEN_SECONDS * 1000 + 1000);
    const expired = await t.page("POST", url);
    assert.equal(expired.statusCode, 400);
    assert.match(expired.body, /This link is not valid/);
    for (const bad of [url.replace("n1.c.", "n1.u."), `${url}x`, `${LINK_BASE}/intake/newsletter/confirm`])
      assert.equal((await t.page("POST", bad)).statusCode, 400);
    assert.equal((await t.record())!.status, "pending");
  } finally {
    await t.cleanup();
  }
});

test("unsubscribe: every email carries RFC 8058 headers; the one-click POST and the page button are idempotent; GET changes nothing", async () => {
  const crm = fakeCrm({
    issue: { id: "prsp-1", custom: { contact_email: "casey@example.com" } },
    revision: "r1",
  } as unknown as IssueRecord);
  const t = await setup({ crm });
  try {
    await t.post(signup());
    const headers = listHeaders(t.sent[0]);
    assert.deepEqual(headers[0], { Name: "List-Unsubscribe", Value: `<${t.sent[0].unsubscribeUrl}>` });
    assert.deepEqual(headers[1], { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" });
    assert.throws(() => listHeaders({ ...t.sent[0], unsubscribeUrl: "mailto:x" }), /HTTPS/);
    await t.page("POST", t.link(t.sent[0], "confirm"));
    const url = t.link(t.sent[0], "unsubscribe");
    const prompt = await t.page("GET", url);
    assert.match(prompt.body, /<button type="submit">Unsubscribe<\/button>/);
    assert.equal((await t.record())!.status, "active", "GET unsubscribes nobody");
    const oneClick = await t.page("POST", url, "List-Unsubscribe=One-Click");
    assert.equal(oneClick.statusCode, 200);
    assert.match(oneClick.body, /You&#39;re unsubscribed/);
    const record = (await t.record())!;
    assert.equal(record.status, "unsubscribed");
    assert.equal(record.unsubscribed_at, "2026-10-21T12:00:00.000Z");
    const files = (await readdir(t.directory)).sort();
    t.advance(1000);
    const again = await t.page("POST", url);
    assert.equal(again.statusCode, 200);
    assert.deepEqual((await readdir(t.directory)).sort(), files, "nothing new is written");
    assert.equal((await t.record())!.unsubscribed_at, "2026-10-21T12:00:00.000Z");
    const shown = (crm.current()!.issue.custom!.newsletters as any)["papyrus-newsletter-v1"];
    assert.equal(shown.status, "unsubscribed");
    assert.equal(shown.list, "Papyrus");
    assert.equal(shown.confirmed_at, "2026-10-21T12:00:00.000Z");
  } finally {
    await t.cleanup();
  }
});

test("suppression is honoured forever, even after the subscription record is deleted", async () => {
  const t = await setup();
  try {
    await t.post(signup());
    const confirm = t.link(t.sent[0], "confirm");
    await t.page("POST", t.link(t.sent[0], "unsubscribe"));
    t.advance(2 * CONFIRMATION_RESEND_MS);
    await t.post(signup());
    assert.equal(t.sent.length, 1, "no email to a suppressed address");
    assert.equal((await t.record())!.status, "unsubscribed");
    assert.equal((await t.record())!.requests.at(-1)!.confirmation, "suppressed");
    assert.match(
      (await t.page("POST", confirm)).body,
      /You&#39;re unsubscribed/,
      "an old confirm link cannot resubscribe",
    );
    // A deletion request removes the subscription (and its address); the hashed suppression stays.
    const subscription = t.service.subscriptionPath(
      t.service.subscriptionHash(form.formId, "casey@example.com"),
    );
    await rm(join(t.directory, `newsletter-${subscription.split("/")[1]}`));
    const suppression = (await readdir(t.directory)).map((name) => name);
    assert.equal(suppression.length, 1);
    assert.doesNotMatch(await readFile(join(t.directory, suppression[0]), "utf8"), /casey|example\.com/);
    await t.post(signup());
    assert.equal(t.sent.length, 1);
    assert.equal((await t.record())!.status, "unsubscribed");
  } finally {
    await t.cleanup();
  }
});

test("at most one confirmation per address and list every 24 hours", async () => {
  const t = await setup();
  try {
    await t.post(signup());
    t.advance(CONFIRMATION_RESEND_MS - 1000);
    await t.post(signup());
    assert.equal(t.sent.length, 1);
    assert.equal((await t.record())!.requests.at(-1)!.confirmation, "resend_limit");
    t.advance(2000);
    await t.post(signup());
    assert.equal(t.sent.length, 2);
    assert.equal((await t.record())!.confirmation.sends, 2);
    // Another address is independent.
    await t.post(signup({ email: "robin@example.com" }));
    assert.equal(t.sent.length, 3);
  } finally {
    await t.cleanup();
  }
});

test("likely spam is stored but gets no email; a later clean signup and confirmation is honoured", async () => {
  const t = await setup();
  try {
    const honeypot = await t.post(signup({ website: "https://spam.example.com", elapsed_ms: 200 }));
    assert.equal(honeypot.statusCode, 202);
    assert.equal(t.sent.length, 0);
    const record = (await t.record())!;
    assert.equal(record.status, "pending");
    assert.equal(record.requests[0].spam_verdict, "likely_spam");
    assert.ok(record.requests[0].spam_reasons.includes("honeypot"));
    assert.deepEqual(record.requests[0].form_signals, { honeypot_filled: true, elapsed_ms: 200 });
    assert.equal(record.requests[0].confirmation, "likely_spam");
    await t.post(signup());
    assert.equal(t.sent.length, 1, "the clean signup is not held back by the earlier spam");
    await t.page("POST", t.link(t.sent[0], "confirm"));
    assert.equal((await t.record())!.status, "active");
  } finally {
    await t.cleanup();
  }
});

test("a mail failure still answers 202 and frees the resend window; a storage failure is the only 503", async () => {
  let fail = true;
  const delivered: ListEmail[] = [];
  const t = await setup({
    mailer: async (email) => {
      if (fail) throw Object.assign(new Error("throttled"), { name: "TooManyRequestsException" });
      delivered.push(email);
    },
  });
  try {
    const response = await t.post(signup());
    assert.equal(response.statusCode, 202);
    const record = (await t.record())!;
    assert.equal(record.requests[0].confirmation, "send_failed");
    assert.equal(record.confirmation.sends, 0);
    assert.equal(record.confirmation.last_sent_at, undefined);
    assert.ok(
      t.logs.some(
        (item) => item.event === "newsletter_send_failed" && item.reason === "TooManyRequestsException",
      ),
    );
    assert.doesNotMatch(JSON.stringify(t.logs), /casey|example\.com/);
    fail = false;
    await t.post(signup());
    assert.equal(delivered.length, 1, "the next signup may send at once");
  } finally {
    await t.cleanup();
  }
  const broken = await setup({
    store: {
      getControl: async () => {
        throw new Error("down");
      },
      putControl: async () => {
        throw new Error("down");
      },
    },
  });
  try {
    const response = await broken.post(signup());
    assert.equal(response.statusCode, 503);
    assert.equal(broken.sent.length, 0);
  } finally {
    await broken.cleanup();
  }
});

test("CRM: an existing prospect shows the subscription; a subscriber without one gets no prospect", async () => {
  const crm = fakeCrm({
    issue: { id: "prsp-7", custom: { contact_email: "casey@example.com", company: "Example" } },
    revision: "r1",
  } as unknown as IssueRecord);
  const t = await setup({ crm });
  try {
    await t.post(signup());
    let shown = (crm.current()!.issue.custom!.newsletters as any)["papyrus-newsletter-v1"];
    assert.deepEqual(shown, {
      list: "Papyrus",
      status: "pending",
      requested_at: "2026-10-21T12:00:00.000Z",
      notice_version: "papyrus-newsletter-v1",
      source_page: "/",
    });
    assert.equal(crm.current()!.issue.custom!.company, "Example", "other fields are kept");
    await t.page("POST", t.link(t.sent[0], "confirm"));
    shown = (crm.current()!.issue.custom!.newsletters as any)["papyrus-newsletter-v1"];
    assert.equal(shown.status, "active");
    assert.equal(shown.confirmed_at, "2026-10-21T12:00:00.000Z");
  } finally {
    await t.cleanup();
  }
  const empty = fakeCrm();
  const u = await setup({ crm: empty });
  try {
    await u.post(signup({ email: "new@example.com" }));
    assert.equal(u.sent.length, 1);
    assert.ok(!empty.calls.some((call) => call.method !== "GET"), "no prospect is created or changed");
  } finally {
    await u.cleanup();
  }
});

test("origin binding both ways: p.apyr.us cannot post the demo route and no other origin can post the newsletter", async () => {
  const t = await setup();
  try {
    assert.equal((await t.post(signup(), "https://anth.us")).statusCode, 403);
    assert.equal((await t.post(signup(), "https://p-staging.apyr.us")).statusCode, 403);
    assert.equal((await t.post(signup(), "https://p.apyr.us", "/intake/demo")).statusCode, 403);
    assert.equal(
      (await t.post(signup(), "https://p.apyr.us", "/intake/newsletter/other-v1")).statusCode,
      404,
    );
    assert.equal(
      (await t.post(signup(), "https://p.apyr.us", "/intake/waitlist/papyrus-newsletter-v1")).statusCode,
      404,
    );
    assert.equal(t.sent.length, 0);
    assert.deepEqual(await readdir(t.directory), []);
  } finally {
    await t.cleanup();
  }
});

test("pages are minimal, escaped, branded per list and never cached, framed or indexed", () => {
  const html = renderPage(
    { status: 200, title: "<b>Title</b>", paragraphs: ['"quoted" & more'], button: "Go", list: form.list },
    "?token=a&b",
  );
  assert.match(html, /<html lang="en">/);
  assert.match(html, /&lt;b&gt;Title&lt;\/b&gt;/);
  assert.match(html, /&quot;quoted&quot; &amp; more/);
  assert.match(html, /action="\?token=a&amp;b"/);
  assert.match(html, /href="https:\/\/p\.apyr\.us\/"/);
  assert.match(html, /href="https:\/\/p\.apyr\.us\/privacy\/"/);
  assert.doesNotMatch(html, /<script/);
  assert.equal(PAGE_HEADERS["cache-control"], "no-store");
  assert.equal(PAGE_HEADERS["referrer-policy"], "no-referrer");
  assert.match(PAGE_HEADERS["content-security-policy"], /default-src 'none'.*frame-ancestors 'none'/);
});

test("links use only the API Gateway execute-api host the signup arrived on", () => {
  const event = (domainName?: string): EvaluationEvent => ({ requestContext: { domainName } });
  assert.equal(executeApiLinkBase(event("abcde12345.execute-api.us-east-1.amazonaws.com")), LINK_BASE);
  for (const domain of [
    undefined,
    "evil.example.com",
    "abcde12345.execute-api.us-east-1.amazonaws.com.evil.example",
  ])
    assert.equal(executeApiLinkBase(event(domain)), null);
});

test("SES mailer sends through the configuration set with the list headers", async () => {
  const commands: any[] = [];
  const mailer = sesListMailer("prospectus-newsletter", {
    send: async (command: any) => commands.push(command),
  } as any);
  await mailer({
    to: "casey@example.com",
    from: `Papyrus <${SENDER}>`,
    subject: "s",
    text: "t",
    html: "<p>h</p>",
    unsubscribeUrl: `${LINK_BASE}/intake/newsletter/unsubscribe?token=x`,
    listId: "Papyrus <papyrus-newsletter-v1.news.apyr.us>",
  });
  const input = commands[0].input;
  assert.equal(input.ConfigurationSetName, "prospectus-newsletter");
  assert.deepEqual(input.Destination, { ToAddresses: ["casey@example.com"] });
  assert.deepEqual(
    input.Content.Simple.Headers.map((header: any) => header.Name),
    ["List-Unsubscribe", "List-Unsubscribe-Post", "List-Id"],
  );
});

test("a newsletter is never opened as a CRM inquiry service", async () => {
  await assert.rejects(
    IntakeService.open({
      directory: join(tmpdir(), `prospectus-never-${randomUUID()}`),
      workspace: "test/prospectus",
      owner: form.owner,
      siteId: form.siteId,
      formId: form.formId,
      form,
      contactPolicy: NEWSLETTER_CONTACT_POLICY,
      identityStore: new FileControlStore(join(tmpdir(), `prospectus-never-${randomUUID()}`)),
      request: async () => ({ issues: [] }),
    }),
    /newsletter service/,
  );
});

test("operator export: counts only by default; confirmed, unsuppressed subscribers with consent times", async () => {
  const t = await setup();
  try {
    for (const email of ["a@example.com", "b@example.com", "c@example.com", "d@example.com"])
      await t.post(signup({ email }));
    const [a, b, c] = t.sent;
    await t.page("POST", t.link(a, "confirm"));
    await t.page("POST", t.link(b, "confirm"));
    await t.page("POST", t.link(c, "confirm"));
    await t.page("POST", t.link(c, "unsubscribe"));
    const paths = (await readdir(t.directory))
      .filter((name) => name.startsWith("newsletter-"))
      .map((name) => `intake-newsletter/${name.slice("newsletter-".length)}`);
    const summary = await exportSubscribers({
      workspace: "test/prospectus",
      store: t.store,
      paths,
      suppressed: new Set(["b@example.com"]),
    });
    assert.deepEqual(summary.counts, {
      "papyrus-newsletter-v1": { active: 1, suppressed: 1, unsubscribed: 1, pending: 1 },
    });
    assert.deepEqual(
      summary.rows.map((row) => row.email),
      ["a@example.com"],
    );
    assert.equal(
      toCsv(summary.rows).split("\n")[0],
      "list_id,email,confirmed_at,notice_version,requested_at,source_page",
    );
    assert.match(toCsv([{ ...summary.rows[0], source_page: "=cmd()" }]), /'=cmd\(\)/);
  } finally {
    await t.cleanup();
  }
});
