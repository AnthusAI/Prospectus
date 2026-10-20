import { IntakeError } from "./intake";
import { KANBUS_API_PATH, KANBUS_BOARD_GROUP } from "../src/board";

/** The trusted runtime invokes only the issue operations required by intake. */
export function canonicalRequest(invoke: (event: unknown) => Promise<unknown>) {
  return async (path: string, init: RequestInit = {}) => {
    const url = new URL(path, "https://private.invalid");
    const method = init.method ?? "GET";
    const issue = /^\/issues\/[^/]+$/.test(url.pathname);
    if (
      !(
        (method === "GET" && (url.pathname === "/issues" || issue)) ||
        (method === "POST" && url.pathname === "/issues") ||
        (method === "PATCH" && issue)
      )
    )
      throw new IntakeError(400, "Unsupported intake operation.");
    const inputHeaders = new Headers(init.headers);
    const headers: Record<string, string> = {};
    for (const key of ["content-type", "x-operation-id", "if-match"]) {
      const value = inputHeaders.get(key);
      if (value) headers[key] = value;
    }
    const result = (await invoke({
      rawPath: `${KANBUS_API_PATH}${url.pathname}`,
      queryStringParameters: Object.fromEntries(url.searchParams),
      headers,
      body: typeof init.body === "string" ? init.body : undefined,
      isBase64Encoded: false,
      requestContext: {
        http: { method },
        authorizer: {
          jwt: { claims: { sub: "prospectus-intake-evaluation", "cognito:groups": KANBUS_BOARD_GROUP } },
        },
      },
    })) as { statusCode?: number; body?: string };
    if (!Number.isInteger(result?.statusCode) || typeof result.body !== "string")
      throw new IntakeError(503, "Private CRM response was not confirmed.");
    let body;
    try {
      body = JSON.parse(result.body);
    } catch {
      throw new IntakeError(503, "Private CRM response was not confirmed.");
    }
    if (result.statusCode! >= 400)
      throw new IntakeError(result.statusCode!, "Private CRM operation was not confirmed.", body.error);
    return body;
  };
}
