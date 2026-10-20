import assert from "node:assert/strict";
import test from "node:test";
import { contactChanges, isActiveStage, validateFollowUp } from "../src/prospect";
import type { Configuration, Issue } from "../src/client";

const configuration = {
  statuses: [
    { key: "customer", semantic_category: "in_progress" },
    { key: "lost", semantic_category: "done" },
  ],
} as Configuration;
test("customer handoff requires an owner and dated action; closed follow-ups are excluded", () => {
  assert.equal(isActiveStage("customer", configuration), true);
  assert.equal(isActiveStage("lost", configuration), false);
  assert.ok(validateFollowUp("customer", "seller", "", "2026-10-15", configuration));
  assert.ok(validateFollowUp("customer", "", "Onboard", "2026-10-15", configuration));
  assert.ok(validateFollowUp("customer", "seller", "Onboard", "", configuration));
  assert.equal(validateFollowUp("customer", "success-owner", "Onboard", "2026-10-15", configuration), null);
  assert.equal(validateFollowUp("lost", "seller", "", "", configuration), null);
});

test("contact correction normalizes email while preserving inquiry and conversion provenance", () => {
  const fields = new FormData();
  for (const [name, value] of Object.entries({
    company: "New Example",
    email: " ALEX@EXAMPLE.INVALID ",
    next_action: " Call Alex ",
    followup: "2026-10-15",
  }))
    fields.set(name, value);
  const inquiries = [{ id: "receipt" }];
  const custom = contactChanges(fields, {
    id: "prsp-test",
    title: "Example",
    type: "prospect",
    status: "customer",
    priority: 2,
    custom: { inquiries, converted_at: "2026-10-14", first_source: "review" },
  } as Issue);
  assert.equal(custom.contact_email, "alex@example.invalid");
  assert.equal(custom.next_action, "Call Alex");
  assert.deepEqual(custom.inquiries, inquiries);
  assert.equal(custom.converted_at, "2026-10-14");
});

test("follow-ups bucket by local date and interests round-trip through the form", async () => {
  const { followUpBucket, addDays, interestChanges, prospectInterests } = await import("../src/prospect");
  const { initials } = await import("../src/shared/initials");
  assert.equal(followUpBucket("2026-10-18", "2026-10-19"), "overdue");
  assert.equal(followUpBucket("2026-10-19", "2026-10-19"), "today");
  assert.equal(followUpBucket("2026-10-25", "2026-10-19"), "week");
  assert.equal(followUpBucket("2026-10-26", "2026-10-19"), "later");
  assert.equal(followUpBucket("", "2026-10-19"), null);
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  const fields = new FormData();
  assert.deepEqual(interestChanges(fields), {});
  fields.set("interests_field", "1");
  fields.append("interests", "papyrus");
  fields.append("interests", "papyrus");
  assert.deepEqual(interestChanges(fields), { interests: ["papyrus"] });
  assert.deepEqual(prospectInterests({ custom: { interests: ["cyclotron", 4] } } as unknown as Issue), [
    "cyclotron",
  ]);
  assert.equal(initials("Ryan Porter"), "RP");
  assert.equal(initials("customer-success"), "CS");
});
