import { cognitoClaims, type ProductRegistration, type KeyResolver } from "./auth";
import { AccountsError, fail, UUID_PATTERN } from "./model";
import { jsonResponse, lowerCaseHeaders, parseJsonRequest } from "./request";
import { AccountsClientError, type AccountsClient } from "../packages/accounts-client/src/client";
const BFF_REQUEST_MAXIMUM_BODY_BYTES = 20000;

export interface BffEvent {
  rawPath: string;
  requestContext: { http: { method: string } };
  headers?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
}
export interface AccountsBffOptions {
  origin: string;
  registration: ProductRegistration;
  keys: KeyResolver;
  client: (access: string, id?: string) => AccountsClient;
  nowSeconds?: () => number;
}
/** JWT-protected, read-only account BFF. Never accepts a runtime role, endpoint,
 * subject, product, directory flag or account grant from browser input.
 */
export function accountsBffHandler(options: AccountsBffOptions) {
  return async (event: BffEvent) => {
    try {
      const headers = lowerCaseHeaders(event.headers);
      const access = /^Bearer ([^ ]+)$/.exec(headers.authorization ?? "")?.[1];
      const claims = await cognitoClaims(
        access,
        options.registration,
        options.keys,
        "access",
        options.nowSeconds?.(),
      );
      const method = event.requestContext.http.method;
      if (!["GET", "POST"].includes(method)) fail(405, "method", "Read-only accounts endpoint.");
      const { body } = parseJsonRequest(event, BFF_REQUEST_MAXIMUM_BODY_BYTES);
      if (method === "POST" && headers.origin !== options.origin)
        fail(403, "origin", "Request origin is not permitted.");
      if (method === "GET") {
        if (Object.keys(body).length) fail(400, "body", "Read payload must be empty.");
        const client = options.client(access!);
        if (event.rawPath === "/api/saas/operator/accounts")
          return jsonResponse(200, await client.operatorList());
        const operatorMatch = /^\/api\/saas\/operator\/accounts\/([a-f0-9-]{36})$/.exec(event.rawPath);
        if (operatorMatch) return jsonResponse(200, await client.operatorDetail(operatorMatch[1]));
        if (event.rawPath === "/api/saas/accounts") return jsonResponse(200, await client.directoryList());
        const match = /^\/api\/saas\/accounts\/([a-f0-9-]{36})$/.exec(event.rawPath);
        if (match) return jsonResponse(200, await client.directoryDetail(match[1]));
      }
      if (method === "POST" && event.rawPath === "/api/saas/identity/challenge") {
        if (Object.keys(body).length) fail(400, "body", "Challenge payload must be empty.");
        return jsonResponse(200, await options.client(access!).challenge());
      }
      if (method === "POST" && event.rawPath === "/api/saas/identity/resolve") {
        if (
          Object.keys(body).some((key) => !["challengeId", "idToken"].includes(key)) ||
          !UUID_PATTERN.test(body.challengeId) ||
          typeof body.idToken !== "string" ||
          body.idToken.length > 16384
        )
          fail(400, "body", "Fresh challenge and ID evidence required.");
        const identity = await cognitoClaims(
          body.idToken,
          options.registration,
          options.keys,
          "id",
          options.nowSeconds?.(),
        );
        if (identity.sub !== claims.sub)
          fail(401, "invalid_human", "Identity evidence does not match session.");
        return jsonResponse(200, await options.client(access!, body.idToken).resolveGoogle(body.challengeId));
      }
      fail(404, "route", "Account route not found.");
    } catch (error) {
      if (error instanceof AccountsError)
        return jsonResponse(error.status, { error: error.code, message: error.message });
      if (error instanceof AccountsClientError)
        return jsonResponse(error.status, {
          error: error.code,
          message:
            error.status === 403
              ? "Account access is not permitted."
              : "Account request could not be completed.",
        });
      return jsonResponse(503, {
        error: "accounts_unavailable",
        message: "Accounts are unavailable. Try again.",
      });
    }
  };
}
