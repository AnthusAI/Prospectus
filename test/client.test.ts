import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, KanbusClient } from "../src/client";

test("anonymous reads fail before sending a request", async () => {
  let called = false;
  const client = new KanbusClient("/api", () => null, async () => { called = true; return new Response(); });
  await assert.rejects(client.config(), /Sign in/);
  assert.equal(called, false);
});

test("a stale write preserves the revision and surfaces a conflict", async () => {
  let headers = new Headers();
  const client = new KanbusClient("/api", () => "member-token", async (_url, options) => {
    headers = new Headers(options?.headers);
    return Response.json({ error: "conflict", message: "Revision changed" }, { status: 409 });
  });
  await assert.rejects(client.update("prsp-1", "old-revision", { status: "qualified" }),
    (error: unknown) => error instanceof ApiError && error.status === 409);
  assert.equal(headers.get("If-Match"), "old-revision");
  assert.equal(headers.get("Authorization"), "Bearer member-token");
  assert.ok(headers.get("X-Operation-Id"));
});

test("follow-up filtering stays a generic Kanbus request", async () => {
  let url = "";
  const client = new KanbusClient("/api", () => "token", async (input) => {
    url = String(input);
    return Response.json({ issues: [], next_cursor: null });
  });
  await client.issues({ type: "prospect", assignee: "seller", fields: [{ field: "custom.next_follow_up_at", operator: "lte", value: "2026-10-15" }] });
  const query = new URL(url, "http://localhost").searchParams;
  assert.equal(query.get("type"), "prospect");
  assert.equal(query.get("assignee"), "seller");
  assert.deepEqual(JSON.parse(query.get("fields")!), [{ field: "custom.next_follow_up_at", operator: "lte", value: "2026-10-15" }]);
});
