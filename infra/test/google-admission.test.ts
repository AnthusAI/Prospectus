import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error JavaScript runtime module; behavior tested without Google credentials.
import { createAdmissionHandler } from "../../amplify/auth-admission/admission.mjs";
const event = () => ({ region: "us-east-1", userPoolId: "us-east-1_TestPool", triggerSource: "PreSignUp_ExternalProvider", userName: "Google_12345", request: { userAttributes: { email: "member@example.invalid", email_verified: "true" } }, response: {} });
const member = { Enabled: true, Username: "invited-id", UserStatus: "FORCE_CHANGE_PASSWORD", Attributes: [{ Name: "email", Value: "member@example.invalid" }] };
function fixture(overrides: Record<string, unknown> = {}) {
  const links: unknown[][] = [];
  const operations = {
    describePool: async () => ({ Name: "prospectus-cyclotron-members" }),
    findUsers: async () => ({ Users: [member] }),
    listGroups: async () => ({ Groups: [{ GroupName: "prospectus-members" }] }),
    link: async (...args: unknown[]) => { links.push(args); },
    ...overrides,
  };
  return { handler: createAdmissionHandler(operations), links };
}
test("verified Google member links to existing invitation without granting membership", async () => {
  const { handler, links } = fixture(); const input = event();
  assert.equal(await handler(input), input);
  assert.deepEqual(links, [["us-east-1_TestPool", "invited-id", "12345"]]);
  assert.deepEqual(input.response, {});
});
for (const [name, mutation, overrides] of [
  ["unverified email", (e: ReturnType<typeof event>) => { e.request.userAttributes.email_verified = "false"; }, {}],
  ["another provider", (e: ReturnType<typeof event>) => { e.userName = "Facebook_123"; }, {}],
  ["another pool", () => {}, { describePool: async () => ({ Name: "another-project" }) }],
  ["uninvited account", () => {}, { findUsers: async () => ({ Users: [] }) }],
  ["ambiguous email", () => {}, { findUsers: async () => ({ Users: [member, member] }) }],
  ["incomplete search", () => {}, { findUsers: async () => ({ Users: [member], PaginationToken: "more" }) }],
  ["disabled invitation", () => {}, { findUsers: async () => ({ Users: [{ ...member, Enabled: false }] }) }],
  ["nonmember", () => {}, { listGroups: async () => ({ Groups: [] }) }],
] as const) test(`Google admission denies ${name} before identity linking`, async () => {
  const input = event(); mutation(input); const { handler, links } = fixture(overrides);
  await assert.rejects(handler(input), /explicitly invited/); assert.deepEqual(links, []);
});
test("authorized admin invitation passes without creating an identity link", async () => {
  const input = event(); input.triggerSource = "PreSignUp_AdminCreateUser";
  const { handler, links } = fixture(); assert.equal(await handler(input), input); assert.deepEqual(links, []);
});
