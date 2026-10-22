import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Issue } from "../src/client";
import { SubmissionDetails } from "../src/admin/SubmissionDetails";
import { mailtoHref, submissionDetails, websitePageHref } from "../src/admin/submissions";

const source = {
  site_id: "anthus-website",
  form_id: "demo",
  page_path: "/papyrus/pricing?plan=team",
  campaign: { utm_source: "newsletter", utm_campaign: "launch" },
};

function inquiry(overrides: Record<string, unknown> = {}) {
  return {
    id: "inq-1",
    kind: "demo",
    name: "Pat Example",
    email: "pat@example.com",
    company: "Example Labs",
    message: "First line\nSecond line",
    received_at: "2026-10-01T15:04:00.000Z",
    source,
    notice_version: "2026-09",
    marketing_opt_in: true,
    attributes: { team_size: "12" },
    ...overrides,
  };
}

function issue(custom: Record<string, unknown>, labels: string[] = []): Issue {
  return { id: "prsp-1", title: "Pat Example", status: "new", labels, custom } as unknown as Issue;
}

const render = (value: Issue) =>
  renderToStaticMarkup(
    createElement(SubmissionDetails, { details: submissionDetails(value), onOpenIssue: () => {} }),
  );

test("a prospect lists every inquiry newest first with full submission information", () => {
  const html = render(
    issue({
      contact_email: "pat@example.com",
      company: "Example Labs",
      next_action: "Reply today",
      next_follow_up_at: "2026-10-02",
      first_source: source,
      latest_source: { ...source, page_path: "/waitlist" },
      inquiries: [
        inquiry({
          id: "old",
          kind: "waitlist",
          message: "Older message",
          received_at: "2026-09-01T10:00:00Z",
        }),
        inquiry({ id: "new" }),
      ],
    }),
  );
  assert.ok(html.indexOf("First line") < html.indexOf("Older message"));
  assert.match(html, /Demo request/);
  assert.match(html, /Waitlist signup/);
  assert.match(html, /<time dateTime="2026-10-01T15:04:00.000Z">/);
  assert.match(html, /<a href="mailto:pat@example.com">pat@example.com<\/a>/);
  assert.match(html, /First line\nSecond line/);
  assert.match(html, /href="https:\/\/anth.us\/papyrus\/pricing\?plan=team"/);
  assert.match(html, /utm_source: newsletter · utm_campaign: launch/);
  assert.match(html, /Marketing opt-in<\/dt><dd>Yes/);
  assert.match(html, /Notice version<\/dt><dd>2026-09/);
  assert.match(html, /team_size: 12/);
  assert.match(html, /anthus-website \/ demo · \/papyrus\/pricing\?plan=team/);
  assert.match(html, /anthus-website \/ demo · \/waitlist/);
  assert.match(html, /Reply today/);
  assert.match(html, /2026-10-02/);
});

test("a review record shows why it needs review, links to the related item and shows its contact email", () => {
  const value = issue(
    {
      company: "Example Labs",
      review_contact_email: "pat@example.com",
      review_reason: "duplicate_contact",
      review_related_issue: "prsp-9",
      inquiries: [inquiry()],
    },
    ["needs-review"],
  );
  const details = submissionDetails(value);
  assert.equal(details.contactEmail, "pat@example.com");
  assert.equal(details.needsReview, true);
  const html = render(value);
  assert.match(html, /Needs review: duplicate contact/);
  assert.match(html, /href="\/pipeline\/prsp-9"/);
  assert.match(html, /First line/);
});

test("a prospect with no submission data renders nothing extra", () => {
  assert.equal(render(issue({ contact_email: "pat@example.com" })), "");
});

test("submitted markup and markdown stay inert text", () => {
  const hostile =
    "<script>alert(1)</script> <img src=x onerror=alert(2)> [click](https://evil.example.com) **bold**";
  const html = render(
    issue({
      contact_email: "pat@example.com",
      inquiries: [
        inquiry({
          message: hostile,
          name: "<b>Name</b>",
          company: '"><svg onload=alert(3)>',
          source: { ...source, page_path: "//evil.example.com/x", campaign: { utm_source: "<i>x</i>" } },
          attributes: { note: "<script>alert(4)</script>" },
        }),
      ],
    }),
  );
  assert.ok(!/<script/i.test(html));
  assert.ok(!/<img/i.test(html));
  assert.ok(!/<svg/i.test(html));
  assert.ok(!/<b>/i.test(html));
  assert.ok(!/<i>/i.test(html));
  assert.ok(!/href="[^"]*evil/.test(html));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("[click](https://evil.example.com)"));
  assert.ok(html.includes("**bold**"));
  assert.equal((html.match(/<a /g) ?? []).length, 1);
});

test("email and page links accept only safe values", () => {
  assert.equal(mailtoHref("pat@example.com"), "mailto:pat@example.com");
  for (const bad of [
    "",
    "pat",
    "a b@example.com",
    "pat@example.com?bcc=x@example.org",
    '"x"@example.com',
    "<a>@x.com",
  ])
    assert.equal(mailtoHref(bad), null, bad);
  assert.equal(websitePageHref("anthus-website", "/a/b?c=d"), "https://anth.us/a/b?c=d");
  for (const [site, path] of [
    ["other-site", "/a"],
    ["anthus-website", "//evil.example.com"],
    ["anthus-website", "https://evil.example.com"],
    ["anthus-website", "/\\evil.example.com"],
    ["anthus-website", "/a b"],
    ["anthus-website", ""],
  ] as const)
    assert.equal(websitePageHref(site, path), null, `${site} ${path}`);
});

test("inquiries without a parseable time sort after dated ones and keep their raw time", () => {
  const details = submissionDetails(
    issue({
      inquiries: [
        inquiry({ id: "a", received_at: "not a date", message: "undated" }),
        inquiry({ id: "b", message: "dated" }),
      ],
    }),
  );
  assert.deepEqual(
    details.inquiries.map((entry) => entry.message),
    ["dated", "undated"],
  );
  assert.equal(details.inquiries[1].receivedAtLabel, "not a date");
});

test("a prospect shows its newsletter subscriptions with status and consent times", () => {
  const html = render(
    issue({
      contact_email: "pat@example.com",
      newsletters: {
        "papyrus-newsletter-v1": {
          list: "Papyrus",
          status: "active",
          requested_at: "2026-10-21T12:00:00.000Z",
          confirmed_at: "2026-10-21T13:00:00.000Z",
          notice_version: "papyrus-newsletter-v1",
          source_page: "/blog/hello",
        },
      },
    }),
  );
  assert.match(html, /Newsletters/);
  assert.match(html, /<strong>Papyrus<\/strong> · Subscribed/);
  assert.match(html, /papyrus-newsletter-v1/);
  assert.match(html, /\/blog\/hello/);
  assert.match(html, /Confirmed/);
});
