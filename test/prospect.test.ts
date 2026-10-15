import assert from "node:assert/strict";
import test from "node:test";
import { contactChanges, isActiveStage, validateFollowUp } from "../src/prospect";
import type { Configuration, Issue } from "../src/client";

const configuration = { statuses: [{ key: "customer", semantic_category: "in_progress" }, { key: "lost", semantic_category: "done" }] } as Configuration;
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
  for (const [name, value] of Object.entries({ company: "New Example", email: " ALEX@EXAMPLE.INVALID ", next_action: " Call Alex ", followup: "2026-10-15" })) fields.set(name, value);
  const inquiries = [{ id: "receipt" }];
  const custom = contactChanges(fields, { id: "prsp-test", title: "Example", type: "prospect", status: "customer", priority: 2, custom: { inquiries, converted_at: "2026-10-14", first_source: "review" } } as Issue);
  assert.equal(custom.contact_email, "alex@example.invalid"); assert.equal(custom.next_action, "Call Alex");
  assert.deepEqual(custom.inquiries, inquiries); assert.equal(custom.converted_at, "2026-10-14");
});
