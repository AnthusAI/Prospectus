import { fail } from "./model";

export type RequestHeaders = Record<string, string | undefined>;

export interface JsonRequestEvent {
  headers?: RequestHeaders;
  body?: string | null;
  isBase64Encoded?: boolean;
}

export interface ParsedJsonRequest {
  headers: RequestHeaders;
  body: Record<string, any>;
}

export function lowerCaseHeaders(headers: RequestHeaders | undefined): RequestHeaders {
  const lowerCased: RequestHeaders = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lowerCasedName = name.toLowerCase();
    if (Object.hasOwn(lowerCased, lowerCasedName)) fail(400, "headers", "Ambiguous headers.");
    lowerCased[lowerCasedName] = value;
  }
  return lowerCased;
}

export function parseJsonRequest(event: JsonRequestEvent, maximumBodyBytes: number): ParsedJsonRequest {
  const headers = lowerCaseHeaders(event.headers);
  if (event.isBase64Encoded || Buffer.byteLength(event.body ?? "") > maximumBodyBytes)
    fail(400, "body", "Unsupported request payload.");
  if (!event.body) return { headers, body: {} };
  if (headers["content-type"]?.split(";")[0] !== "application/json")
    fail(415, "json_required", "JSON required.");
  let body: unknown;
  try {
    body = JSON.parse(event.body);
  } catch {
    fail(400, "body", "Invalid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) fail(400, "body", "Object required.");
  return { headers, body: body as Record<string, any> };
}

export function jsonResponse(statusCode: number, value: unknown) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
    body: JSON.stringify(value),
  };
}
