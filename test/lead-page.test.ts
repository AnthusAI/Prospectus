import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Configuration, IssueRecord, KanbusClient } from "../src/client";
import { AppLink } from "../src/admin/AppLink";
import { LeadPage, LeadPlaceholder } from "../src/admin/LeadPage";
import { linkIssueCards } from "../src/admin/card-links";

const configuration = {
  actor_id: "synthetic-staff",
  initial_status: "new",
  types: ["prospect"],
  statuses: [
    { key: "new", name: "New" },
    { key: "contacted", name: "Contacted" },
    { key: "lost", name: "Lost", semantic_category: "done" },
  ],
  workflows: { prospect: { new: ["contacted", "lost"], contacted: ["lost"], lost: [] } },
} as unknown as Configuration;

function record(assignee: string, custom: Record<string, unknown> = {}): IssueRecord {
  return {
    revision: "r1",
    issue: {
      id: "prsp-synthetic1",
      title: "Pat Example",
      status: "new",
      assignee,
      labels: ["likely-spam"],
      comments: [
        {
          id: "c1",
          author: "synthetic-staff",
          text: "Called, no answer",
          created_at: "2026-10-02T10:00:00Z",
        },
      ],
      custom: {
        company: "Example Labs",
        contact_email: "pat@example.invalid",
        next_action: "Reply",
        next_follow_up_at: "2026-10-05",
        inquiries: [
          {
            id: "i1",
            kind: "demo",
            name: "Pat Example",
            email: "pat@example.invalid",
            message: "The full text of the first message\nwith a second line",
            received_at: "2026-10-01T15:04:00.000Z",
            spam_verdict: "likely_spam",
            spam_score: 0.91,
            spam_reasons: ["gibberish_name"],
            source: { site_id: "anthus-website", form_id: "demo" },
          },
        ],
        ...custom,
      },
    },
  } as unknown as IssueRecord;
}

const props = (value: IssueRecord) => ({
  record: value,
  configuration,
  busy: false,
  write: async () => true,
  api: {} as KanbusClient,
  onError: () => {},
  onNavigatePipeline: () => {},
  onOpenIssue: () => {},
  focusNextAction: false,
});

test("a lead page has a pipeline breadcrumb, the lead's details and every working area", () => {
  const html = renderToStaticMarkup(createElement(LeadPage, props(record("someone-else"))));
  assert.match(html, /<nav[^>]*aria-label="Breadcrumb"[^>]*><a href="\/pipeline">Pipeline<\/a>/);
  assert.match(html, /<h1[^>]*>\s*Example Labs<\/h1>/);
  assert.match(html, /href="mailto:pat@example\.invalid"/);
  assert.match(html, /prsp-synthetic1/);
  assert.match(html, /Copy link/);
  assert.match(html, /The full text of the first message/);
  assert.match(html, /aria-label="Spam check"/);
  assert.match(html, /Name looks machine-generated/);
  for (const text of ["Not spam", "Spam", "Vendor"]) assert.match(html, new RegExp(`>${text}<`));
  assert.match(html, /aria-label="Submission details"/);
  assert.match(html, /Called, no answer/);
  assert.match(html, /aria-label="Conversation"/);
  assert.match(html, /name="next_action"/);
  assert.match(html, /name="followup"/);
  assert.match(html, /Save changes/);
  assert.match(html, /Move to Contacted/);
  assert.match(html, /Mark lost/);
  assert.doesNotMatch(html, /one-drawer"/);
});

test("a lead owned by someone else offers Take it; the member's own lead does not", () => {
  assert.match(renderToStaticMarkup(createElement(LeadPage, props(record("someone-else")))), />Take it</);
  assert.doesNotMatch(
    renderToStaticMarkup(createElement(LeadPage, props(record("synthetic-staff")))),
    />Take it</,
  );
  assert.match(renderToStaticMarkup(createElement(LeadPage, props(record("")))), />Take it</);
});

test("a missing lead says so and links back to the pipeline", () => {
  const html = renderToStaticMarkup(
    createElement(LeadPlaceholder, {
      message: "The item prsp-nope could not be found.",
      missing: true,
      onNavigatePipeline: () => {},
    }),
  );
  assert.match(html, /role="alert">The item prsp-nope could not be found\./);
  assert.match(html, /<a href="\/pipeline">Back to the pipeline<\/a>/);
});

test("an application link is a real anchor with the address", () => {
  const html = renderToStaticMarkup(
    createElement(AppLink, { href: "/pipeline/prsp-1", onNavigate: () => {}, children: "Example Labs" }),
  );
  assert.equal(html, '<a href="/pipeline/prsp-1">Example Labs</a>');
});

test("linking cards covers each shared card with a link to its lead and is repeatable", () => {
  class Element {
    children: Element[] = [];
    attributes: Record<string, string> = {};
    className = "";
    tabIndex = 0;
    dataset: Record<string, string>;
    constructor(
      public tag: string,
      dataset: Record<string, string> = {},
      public textContent = "",
    ) {
      this.dataset = dataset;
    }
    setAttribute(name: string, value: string) {
      this.attributes[name] = value;
    }
    getAttribute(name: string) {
      return this.attributes[name] ?? null;
    }
    appendChild(child: Element) {
      this.children.push(child);
    }
    querySelector(selector: string) {
      if (selector === "h3") return new Element("h3", {}, "Example Labs");
      return this.children.find((child) => child.tag === "a") ?? null;
    }
    querySelectorAll() {
      return cards;
    }
  }
  const cards = [new Element("div", { issueId: "prsp-a1" }), new Element("div", { issueId: "prsp-b2" })];
  const root = new Element("div");
  const created: Element[] = [];
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => {
      const element = new Element(tag);
      created.push(element);
      return element;
    },
  };
  linkIssueCards(root as unknown as HTMLElement);
  linkIssueCards(root as unknown as HTMLElement);
  delete (globalThis as { document?: unknown }).document;
  assert.equal(created.length, 2);
  assert.deepEqual(
    cards.map((card) => card.children[0].attributes.href),
    ["/pipeline/prsp-a1", "/pipeline/prsp-b2"],
  );
  assert.equal(cards[0].children[0].attributes["aria-label"], "Open Example Labs");
  assert.equal(cards[0].children[0].tabIndex, -1);
});
