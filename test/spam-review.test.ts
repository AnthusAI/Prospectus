import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Configuration, Issue } from "../src/client";
import { hiddenAsSpam, spamReviewChanges, spamSummary } from "../src/spam-review";

const configuration = {
  actor_id: "member-1",
  initial_status: "new",
  types: ["prospect"],
  statuses: [
    { key: "new", name: "New", category: "To do", semantic_category: "todo" },
    { key: "contacted", name: "Contacted", category: "In progress", semantic_category: "in_progress" },
    { key: "lost", name: "Closed", category: "Done", semantic_category: "done" },
  ],
  workflows: { default: { new: ["contacted", "lost"], contacted: ["lost"], lost: ["new"] } },
} as unknown as Configuration;

const scoredInquiry = {
  id: "inq-1",
  kind: "demo",
  name: "Synthetic Example",
  email: "casey@example.com",
  message: "Synthetic message",
  received_at: "2026-10-20T10:00:00.000Z",
  spam_score: 0.784,
  spam_verdict: "likely_spam",
  spam_reasons: ["gibberish_name", "template_only_message", "gmail_dot_scatter"],
  spam_hints: [],
  spam_rules_version: "intake-spam-rules-1",
  spam_mode: "label",
  spam_protected: false,
};

const prospect = (changes: Partial<Issue> = {}): Issue =>
  ({
    id: "prsp-1",
    title: "Synthetic Example",
    type: "prospect",
    status: "new",
    priority: 2,
    labels: ["likely-spam", "app-babulus"],
    custom: { contact_email: "casey@example.com", spam_status: "likely_spam", inquiries: [scoredInquiry] },
    ...changes,
  }) as Issue;

test("the summary names the verdict, score, plain-word reasons and rules version", () => {
  const summary = spamSummary(prospect());
  assert.equal(summary.verdictText, "Likely spam");
  assert.equal(summary.score, 0.784);
  assert.deepEqual(
    summary.reasons.map((reason) => reason.text),
    [
      "Name looks machine-generated",
      "Message is only the form's prompts",
      "Gmail address with scattered dots",
    ],
  );
  assert.equal(summary.rulesVersion, "intake-spam-rules-1");
  assert.equal(summary.label, "likely-spam");
  assert.equal(summary.inquiryId, "inq-1");
  assert.equal(spamSummary(prospect({ custom: {} })).verdict, null);
});

test("likely-spam and spam are hidden; vendor and clean prospects are not", () => {
  assert.equal(hiddenAsSpam(prospect()), true);
  assert.equal(hiddenAsSpam(prospect({ labels: ["spam"] })), true);
  assert.equal(hiddenAsSpam(prospect({ labels: ["vendor"] })), false);
  assert.equal(hiddenAsSpam(prospect({ labels: [] })), false);
  assert.equal(hiddenAsSpam(prospect({ labels: undefined })), false);
});

test("Not spam removes the label, restores the follow-up and records the correction", () => {
  const changes = spamReviewChanges(prospect(), "not_spam", configuration, new Date("2026-10-23T15:00:00Z"));
  assert.deepEqual(changes.labels, ["app-babulus"]);
  assert.equal(changes.status, undefined);
  assert.equal(changes.custom.next_action, "Respond to demo request");
  assert.equal(changes.custom.next_follow_up_at, "2026-10-26");
  assert.equal(changes.custom.contact_email, "casey@example.com", "other custom fields are kept");
  const correction = {
    label: "not_spam",
    reviewer: "member-1",
    at: "2026-10-23T15:00:00.000Z",
    inquiry_id: "inq-1",
    rules_version: "intake-spam-rules-1",
    machine: {
      score: 0.784,
      verdict: "likely_spam",
      reasons: ["gibberish_name", "template_only_message", "gmail_dot_scatter"],
    },
  };
  assert.deepEqual(changes.custom.spam_review, correction);
  assert.deepEqual(changes.custom.spam_corrections, [correction]);
  // Not spam on a confirmed-spam prospect reopens it from Closed.
  assert.equal(
    spamReviewChanges(prospect({ status: "lost", labels: ["spam"] }), "not_spam", configuration).status,
    "new",
  );
  // A waitlist-only prospect gets no follow-up, as intake would have given it none.
  const waitlist = prospect({
    custom: { inquiries: [{ ...scoredInquiry, kind: "waitlist" }] },
  });
  assert.equal("next_follow_up_at" in spamReviewChanges(waitlist, "not_spam", configuration).custom, false);
});

test("Spam and Vendor move to Closed, clear the follow-up, keep the record and append corrections", () => {
  const spam = spamReviewChanges(prospect(), "spam", configuration, new Date("2026-10-23T15:00:00Z"));
  assert.deepEqual(spam.labels, ["app-babulus", "spam"]);
  assert.equal(spam.status, "lost");
  assert.equal(spam.custom.next_follow_up_at, null);
  assert.deepEqual(spam.custom.inquiries, [scoredInquiry], "nothing is deleted");
  const reviewed = prospect({ labels: spam.labels, status: "lost", custom: spam.custom });
  const vendor = spamReviewChanges(reviewed, "vendor", configuration, new Date("2026-10-24T09:00:00Z"));
  assert.deepEqual(vendor.labels, ["app-babulus", "vendor"]);
  assert.equal(vendor.status, undefined, "already Closed");
  assert.deepEqual(
    (vendor.custom.spam_corrections as Array<{ label: string }>).map((correction) => correction.label),
    ["spam", "vendor"],
  );
  // Mark as spam works on any clean prospect too.
  const clean = prospect({
    labels: [],
    custom: { inquiries: [{ ...scoredInquiry, spam_verdict: "clean" }] },
  });
  const marked = spamReviewChanges(clean, "spam", configuration);
  assert.deepEqual(marked.labels, ["spam"]);
  assert.equal((marked.custom.spam_review as { machine: { verdict: string } }).machine.verdict, "clean");
});

test("the corrections history is bounded", () => {
  let issue = prospect();
  for (let index = 0; index < 60; index++)
    issue = {
      ...issue,
      custom: spamReviewChanges(issue, index % 2 ? "spam" : "not_spam", configuration).custom,
    };
  assert.equal((issue.custom!.spam_corrections as unknown[]).length, 50);
});

test("the pipeline hides likely spam behind a visible toggle and Today leaves it out of new leads", () => {
  const pipeline = readFileSync("src/admin/PipelineView.tsx", "utf8");
  assert.match(pipeline, /hidden as likely spam or spam/);
  assert.match(pipeline, /<SpamReview /);
  assert.match(readFileSync("src/admin/TodayView.tsx", "utf8"), /!hiddenAsSpam\(record\.issue\)/);
});
