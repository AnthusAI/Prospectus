import assert from "node:assert/strict";
import test from "node:test";
import { createEvaluationHandler, type EvaluationEvent } from "../server/evaluation-handler";
import { canonicalRequest } from "../server/canonical-invoke";
import { IntakeError } from "../server/intake";

const event: EvaluationEvent = { rawPath: "/intake/demo", requestContext: { http: { method: "POST" } }, headers: { origin: "https://prospectus.anth.us", "content-type": "application/json" }, body: "{}" };

test("evaluation rejects origin, method, content type, body size and encoding before service access", async () => {
  let opened = 0;
  const handler = createEvaluationHandler({ allowedOrigin: "https://prospectus.anth.us", open: async () => { opened++; throw new Error("must not open"); } });
  for (const [change, expected] of [
    [{ rawPath: "/api/issues" }, 404],
    [{ requestContext: { http: { method: "GET" } } }, 404],
    [{ headers: { ...event.headers, origin: "https://other.invalid" } }, 403],
    [{ headers: { ...event.headers, "content-type": "text/plain" } }, 415],
    [{ body: "x".repeat(16385) }, 400],
    [{ isBase64Encoded: true }, 400],
    [{ body: "{" }, 400],
  ] as const) assert.equal((await handler({ ...event, ...change })).statusCode, expected);
  assert.equal(opened, 0);
});

test("evaluation returns only the service receipt and closes its owned cache", async () => {
  let closed = false;
  const handler = createEvaluationHandler({ allowedOrigin: "https://prospectus.anth.us", open: async () => ({ submit: async () => ({ receipt: "synthetic-receipt", message: "Received" }), close: async () => { closed = true; } }) });
  const result = await handler(event);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body), { receipt: "synthetic-receipt", message: "Received" });
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(closed, true);
});

test("evaluation hides unexpected backend details while preserving safe validation errors", async () => {
  for (const [failure, status, message] of [[new Error("private credential or record"), 503, "The evaluation inquiry could not be confirmed. Retry the same receipt."], [new IntakeError(400, "Use a synthetic email."), 400, "Use a synthetic email."]] as const) {
    let closed = false;
    const handler = createEvaluationHandler({ allowedOrigin: "https://prospectus.anth.us", open: async () => ({ submit: async () => { throw failure; }, close: async () => { closed = true; } }) });
    const result = await handler(event);
    assert.equal(result.statusCode, status);
    assert.equal(JSON.parse(result.body).message, message);
    assert.equal(closed, true);
  }
});

test("trusted canonical adapter fixes the actor, strips bearer headers and retains revision/operation claims", async () => {
  let captured: any;
  const request = canonicalRequest(async payload => { captured = payload; return { statusCode: 200, body: JSON.stringify({ issue: { id: "synthetic-id" }, revision: "opaque" }) }; });
  await request("/issues/synthetic-id", { method: "PATCH", headers: { authorization: "must-not-forward", "if-match": "opaque", "x-operation-id": "stable-operation" }, body: JSON.stringify({ custom: { next_action: "Synthetic action" } }) });
  assert.equal(captured.rawPath, "/api/issues/synthetic-id");
  assert.equal(captured.headers.authorization, undefined);
  assert.equal(captured.headers["if-match"], "opaque");
  assert.equal(captured.headers["x-operation-id"], "stable-operation");
  assert.equal(captured.requestContext.authorizer.jwt.claims.sub, "prospectus-intake-evaluation");
  for (const [path, method] of [["/config", "GET"], ["/issues/id/events", "GET"], ["/issues/id", "DELETE"], ["/members", "POST"]]) await assert.rejects(request(path, { method }), /Unsupported/);
});

test("trusted canonical adapter retains explicit revision conflict and hides private error details", async () => {
  const request = canonicalRequest(async () => ({ statusCode: 409, body: JSON.stringify({ error: "revision_conflict", message: "private detail" }) }));
  await assert.rejects(request("/issues/id", { method: "PATCH" }), error => error instanceof IntakeError && error.status === 409 && error.code === "revision_conflict" && !error.message.includes("private detail"));
});
