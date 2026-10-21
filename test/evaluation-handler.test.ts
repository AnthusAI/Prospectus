import assert from "node:assert/strict";
import test from "node:test";
import {
  createEvaluationHandler,
  diagnoseUnconfirmedSubmission,
  type EvaluationEvent,
} from "../server/evaluation-handler";
import { canonicalRequest } from "../server/canonical-invoke";
import { IntakeError, IntakeService } from "../server/intake";
import { VirtuusS3ControlStore, type ControlRequest } from "../server/s3-control-store";
import { REAL_CONTACT_POLICY } from "../server/intake-contact-policy";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UnconfirmedSubmissionDiagnostic } from "../server/evaluation-handler";

const event: EvaluationEvent = {
  rawPath: "/intake/demo",
  requestContext: { http: { method: "POST" } },
  headers: { origin: "https://prospectus.anth.us", "content-type": "application/json" },
  body: "{}",
};

test("evaluation rejects origin, method, content type, body size and encoding before service access", async () => {
  let opened = 0;
  const handler = createEvaluationHandler({
    allowedOrigins: ["https://prospectus.anth.us"],
    open: async () => {
      opened++;
      throw new Error("must not open");
    },
  });
  for (const [change, expected] of [
    [{ rawPath: "/api/issues" }, 404],
    [{ requestContext: { http: { method: "GET" } } }, 404],
    [{ headers: { ...event.headers, origin: "https://other.invalid" } }, 403],
    [{ headers: { "content-type": "application/json" } }, 403],
    [{ headers: { ...event.headers, "content-type": "text/plain" } }, 415],
    [{ body: "x".repeat(16385) }, 400],
    [{ isBase64Encoded: true }, 400],
    [{ body: "{" }, 400],
  ] as const)
    assert.equal((await handler({ ...event, ...change })).statusCode, expected);
  assert.equal(opened, 0);
});

test("evaluation returns only the service receipt and closes its owned cache", async () => {
  let closed = false;
  const handler = createEvaluationHandler({
    allowedOrigins: ["https://prospectus.anth.us"],
    open: async () => ({
      submit: async () => ({ receipt: "synthetic-receipt", message: "Received" }),
      close: async () => {
        closed = true;
      },
    }),
  });
  const result = await handler(event);
  assert.equal(result.statusCode, 202);
  assert.deepEqual(JSON.parse(result.body), { receipt: "synthetic-receipt", message: "Received" });
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(closed, true);
});

test("evaluation hides unexpected backend details while preserving safe validation errors", async () => {
  for (const [failure, status, message] of [
    [
      new Error("private credential or record"),
      503,
      "The inquiry could not be confirmed. Retry the same receipt.",
    ],
    [new IntakeError(400, "Use a synthetic email."), 400, "Use a synthetic email."],
  ] as const) {
    let closed = false;
    const handler = createEvaluationHandler({
      allowedOrigins: ["https://prospectus.anth.us"],
      open: async () => ({
        submit: async () => {
          throw failure;
        },
        close: async () => {
          closed = true;
        },
      }),
    });
    const result = await handler(event);
    assert.equal(result.statusCode, status);
    assert.equal(JSON.parse(result.body).message, message);
    assert.equal(closed, true);
  }
});

test("trusted canonical adapter fixes the actor, strips bearer headers and retains revision/operation claims", async () => {
  let captured: any;
  const request = canonicalRequest(async (payload) => {
    captured = payload;
    return { statusCode: 200, body: JSON.stringify({ issue: { id: "synthetic-id" }, revision: "opaque" }) };
  });
  await request("/issues/synthetic-id", {
    method: "PATCH",
    headers: {
      authorization: "must-not-forward",
      "if-match": "opaque",
      "x-operation-id": "stable-operation",
    },
    body: JSON.stringify({ custom: { next_action: "Synthetic action" } }),
  });
  assert.equal(captured.rawPath, "/cyclotron/prospectus/api/issues/synthetic-id");
  assert.equal(
    captured.requestContext.authorizer.jwt.claims["cognito:groups"],
    "kanbus:cyclotron/prospectus",
  );
  assert.equal(captured.headers.authorization, undefined);
  assert.equal(captured.headers["if-match"], "opaque");
  assert.equal(captured.headers["x-operation-id"], "stable-operation");
  assert.equal(captured.requestContext.authorizer.jwt.claims.sub, "prospectus-intake-evaluation");
  for (const [path, method] of [
    ["/config", "GET"],
    ["/issues/id/events", "GET"],
    ["/issues/id", "DELETE"],
    ["/members", "POST"],
  ])
    await assert.rejects(request(path, { method }), /Unsupported/);
});

test("trusted canonical adapter forwards list filters in the HTTP API v2 rawQueryString", async () => {
  let captured: any;
  const request = canonicalRequest(async (payload) => {
    captured = payload;
    return { statusCode: 200, body: JSON.stringify({ issues: [] }) };
  });
  const fields = JSON.stringify([
    { field: "custom.contact_email", operator: "eq", value: "a+b c@example.invalid" },
  ]);
  await request(`/issues?type=prospect&limit=2&fields=${encodeURIComponent(fields)}`);
  assert.equal(captured.rawPath, "/cyclotron/prospectus/api/issues");
  // The Kanbus Lambda adapter parses only rawQueryString (form-urlencoded); it must carry every filter.
  const parsed = Object.fromEntries(new URLSearchParams(captured.rawQueryString));
  assert.deepEqual(parsed, { type: "prospect", limit: "2", fields });
  assert.deepEqual(captured.queryStringParameters, parsed);
  await request("/issues/synthetic-id");
  assert.equal(captured.rawQueryString, "");
});

test("trusted canonical adapter retains explicit revision conflict and hides private error details", async () => {
  const request = canonicalRequest(async () => ({
    statusCode: 409,
    body: JSON.stringify({ error: "revision_conflict", message: "private detail" }),
  }));
  await assert.rejects(
    request("/issues/id", { method: "PATCH" }),
    (error) =>
      error instanceof IntakeError &&
      error.status === 409 &&
      error.code === "revision_conflict" &&
      !error.message.includes("private detail"),
  );
});

test("evaluation accepts every configured form origin and nothing else", async () => {
  const handler = createEvaluationHandler({
    allowedOrigins: ["https://prospectus.anth.us", "https://anth.us"],
    open: async () => ({
      submit: async () => ({ receipt: "receipt", message: "Received" }),
      close: async () => undefined,
    }),
  });
  for (const [origin, expected] of [
    ["https://anth.us", 202],
    ["https://prospectus.anth.us", 202],
    ["https://www.anth.us", 403],
    ["https://anth.us.invalid", 403],
  ] as const) {
    assert.equal((await handler({ ...event, headers: { ...event.headers, origin } })).statusCode, expected);
  }
});

const realContactSubmission = () => ({
  submission_id: "2f6b7c52-3d1e-4a52-9b0e-6a1a1f0c9d11",
  name: "Alex Example",
  email: "alex@example.com",
  company: "Example Studio",
  message: "Please show the demo.",
  website: "",
  notice_version: REAL_CONTACT_POLICY.noticeVersion,
  marketing_opt_in: false,
  page_path: "/contact",
  campaign: {},
});

const storageWithoutListPermission = (writesAvailable: boolean) => {
  const workspace = "test/prospectus";
  const objects = new Map<string, { bytes: string; revision: string }>();
  return new VirtuusS3ControlStore(workspace, async (request: ControlRequest) => {
    const base = { version: 1, workspace, path: request.path };
    const stored = objects.get(request.path);
    if (request.operation === "get") {
      if (stored) return { ...base, status: "ok", object: stored };
      return { ...base, status: "unavailable" };
    }
    if (!writesAvailable) return { ...base, status: "unavailable" };
    if (request.condition && "absent" in request.condition && stored) return { ...base, status: "conflict" };
    const object = { bytes: request.bytes!, revision: `"etag-${objects.size + 1}"` };
    objects.set(request.path, object);
    return { ...base, status: "ok", object };
  });
};

const submitRealContactThrough = async (writesAvailable: boolean) => {
  const diagnostics: UnconfirmedSubmissionDiagnostic[] = [];
  let reachedCanonicalWrite = false;
  const handler = createEvaluationHandler({
    allowedOrigins: ["https://anth.us"],
    reportUnconfirmed: (diagnostic) => diagnostics.push(diagnostic),
    open: async () => {
      const directory = await mkdtemp(join(tmpdir(), "prospectus-intake-test-"));
      const service = await IntakeService.open({
        directory,
        workspace: "test/prospectus",
        owner: "intake-queue",
        siteId: REAL_CONTACT_POLICY.siteId,
        formId: REAL_CONTACT_POLICY.formId,
        contactPolicy: REAL_CONTACT_POLICY,
        identityStore: storageWithoutListPermission(writesAvailable),
        request: async () => {
          reachedCanonicalWrite = true;
          throw new IntakeError(503, "stop after the first canonical call");
        },
      });
      return {
        submit: service.submit.bind(service),
        close: async () => {
          await service.close();
          await rm(directory, { recursive: true, force: true });
        },
      };
    },
  });
  const result = await handler({
    ...event,
    headers: { origin: "https://anth.us", "content-type": "application/json" },
    body: JSON.stringify(realContactSubmission()),
  });
  return { result, diagnostics, reachedCanonicalWrite };
};

test("a first submission reaches the canonical write although reading an absent claim is denied", async () => {
  const { diagnostics, reachedCanonicalWrite } = await submitRealContactThrough(true);
  assert.equal(reachedCanonicalWrite, true);
  assert.ok(diagnostics.every((diagnostic) => diagnostic.errorClass === "IntakeError"));
});

test("an unavailable claim write returns the generic 503 with a data-free diagnostic", async () => {
  const { result, diagnostics, reachedCanonicalWrite } = await submitRealContactThrough(false);
  assert.equal(result.statusCode, 503);
  assert.equal(
    JSON.parse(result.body).message,
    "The inquiry could not be confirmed. Retry the same receipt.",
  );
  assert.equal(reachedCanonicalWrite, false);
  assert.deepEqual(diagnostics, [
    { event: "intake-submission-unconfirmed", errorClass: "ControlTransportError", outcome: "unavailable" },
  ]);
  assert.ok(!JSON.stringify(diagnostics).includes("alex@example.com"));
});

test("unexpected failures are reported by class only, never by message", () => {
  assert.deepEqual(diagnoseUnconfirmedSubmission(new TypeError("alex@example.com")), {
    event: "intake-submission-unconfirmed",
    errorClass: "TypeError",
  });
  assert.deepEqual(diagnoseUnconfirmedSubmission("alex@example.com"), {
    event: "intake-submission-unconfirmed",
    errorClass: "string",
  });
});
