import assert from "node:assert/strict";
import test from "node:test";
import { labelStoredSpam, storedSpamChanges } from "../server/stored-spam";
import { TEMPLATE_ONLY } from "./fixtures/intake-spam";

const bot = {
  kind: "demo",
  name: "vqUTrGyfbTxyokSUXEM",
  email: "bot@example.com",
  company: "Xyzzy LLC",
  message: TEMPLATE_ONLY,
  form_signals: { elapsed_ms: 100 },
};
const person = {
  ...bot,
  name: "Alex Example",
  email: "alex@example.com",
  message: "We would like a demo of Papyrus for our newsroom please.",
  form_signals: { elapsed_ms: 40_000 },
};
const prospect = (changes: Record<string, unknown> = {}, custom: Record<string, unknown> = {}) => ({
  id: "prsp-example",
  type: "prospect",
  status: "new",
  labels: [] as string[],
  ...changes,
  custom: { inquiries: [bot], next_action: "Respond", next_follow_up_at: "2026-11-06", ...custom },
});

test("a stored bot prospect is labelled and loses its follow-up", () => {
  assert.deepEqual(storedSpamChanges(prospect({ labels: ["needs-review"] }), "new"), {
    labels: ["needs-review", "likely-spam"],
    custom: { next_action: null, next_follow_up_at: null, spam_status: "likely_spam" },
  });
});

test("anything a person decided, moved on or wrote is left alone", () => {
  for (const issue of [
    prospect({}, { inquiries: [person] }),
    prospect({}, { inquiries: [bot, person] }),
    prospect({}, { inquiries: [] }),
    prospect({ status: "contacted" }),
    prospect({ labels: ["likely-spam"] }),
    prospect({ labels: ["spam"] }),
    prospect({ labels: ["vendor"] }),
    prospect({}, { spam_review: { label: "not_spam" } }),
    prospect({ type: "task" }),
  ])
    assert.equal(storedSpamChanges(issue, "new"), null);
});

test("a dry run writes nothing, and apply writes once with the record's revision", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const issue = prospect();
  const request = async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return path.startsWith("/issues?") ? { issues: [{ issue, revision: "r1" }] } : { issue, revision: "r1" };
  };
  const options = { request, workspace: "example", initialStatus: "new" };
  assert.deepEqual(await labelStoredSpam({ ...options, apply: false }), {
    scanned: 1,
    labelled: ["prsp-example"],
  });
  assert.equal(calls.filter((call) => call.init?.method === "PATCH").length, 0);
  await labelStoredSpam({ ...options, apply: true });
  const patch = calls.find((call) => call.init?.method === "PATCH")!;
  assert.equal(new Headers(patch.init!.headers).get("if-match"), "r1");
});
