import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountsError } from "../accounts/model";
import { jsonResponse, lowerCaseHeaders, parseJsonRequest } from "../accounts/request";

const MAXIMUM_BODY_BYTES = 16;

function failureOf(action: () => unknown) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof AccountsError);
    return { status: error.status, code: error.code };
  }
  assert.fail("expected the request to be rejected");
}

test("header names are lower-cased and ambiguous duplicates are rejected", () => {
  assert.deepEqual(lowerCaseHeaders({ "Content-Type": "a", "X-Other": "b" }), {
    "content-type": "a",
    "x-other": "b",
  });
  assert.deepEqual(
    failureOf(() => lowerCaseHeaders({ "X-Same": "a", "x-same": "b" })),
    {
      status: 400,
      code: "headers",
    },
  );
});

test("an empty body parses to an empty object without needing a content type", () => {
  assert.deepEqual(parseJsonRequest({ body: null }, MAXIMUM_BODY_BYTES).body, {});
});

test("a JSON object body is parsed with its charset-qualified content type", () => {
  const parsed = parseJsonRequest(
    { headers: { "Content-Type": "application/json; charset=utf-8" }, body: '{"a":1}' },
    MAXIMUM_BODY_BYTES,
  );
  assert.deepEqual(parsed.body, { a: 1 });
});

test("oversized, base64, non-JSON, malformed and non-object bodies are rejected", () => {
  const jsonHeaders = { "content-type": "application/json" };
  assert.deepEqual(
    failureOf(() =>
      parseJsonRequest({ headers: jsonHeaders, body: `{"a":"${"x".repeat(32)}"}` }, MAXIMUM_BODY_BYTES),
    ),
    { status: 400, code: "body" },
  );
  assert.deepEqual(
    failureOf(() =>
      parseJsonRequest({ headers: jsonHeaders, body: "{}", isBase64Encoded: true }, MAXIMUM_BODY_BYTES),
    ),
    { status: 400, code: "body" },
  );
  assert.deepEqual(
    failureOf(() => parseJsonRequest({ body: "{}" }, MAXIMUM_BODY_BYTES)),
    {
      status: 415,
      code: "json_required",
    },
  );
  assert.deepEqual(
    failureOf(() => parseJsonRequest({ headers: jsonHeaders, body: "{" }, MAXIMUM_BODY_BYTES)),
    {
      status: 400,
      code: "body",
    },
  );
  for (const body of ["[]", "null", "1"])
    assert.deepEqual(
      failureOf(() => parseJsonRequest({ headers: jsonHeaders, body }, MAXIMUM_BODY_BYTES)),
      {
        status: 400,
        code: "body",
      },
    );
});

test("responses are uncacheable JSON", () => {
  const response = jsonResponse(201, { ok: true });
  assert.equal(response.statusCode, 201);
  assert.equal(response.headers["Cache-Control"], "no-store");
  assert.equal(response.headers["X-Content-Type-Options"], "nosniff");
  assert.equal(response.body, '{"ok":true}');
});
