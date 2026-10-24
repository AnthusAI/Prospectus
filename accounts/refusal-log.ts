import { AccountsError } from "./model";
import { isProductName, matchesStringPattern } from "./validation-rules";

/** Route templates operators may see. Any other path is logged as {unrecognized}, so free text never reaches logs. */
const LOGGED_ROUTE_TEMPLATES = new Set([
  "/v1/identities/google/challenge",
  "/v1/identities/google/resolve",
  "/v1/identities/me",
  "/v1/identities/resolve",
  "/v1/accounts",
  "/v1/accounts/{account}",
  "/v1/accounts/{account}/authorize",
  "/v1/accounts/{account}/memberships",
  "/v1/accounts/site-subjects/retired",
  "/v1/account-directory",
  "/v1/account-directory/{account}",
  "/v1/account-directory/operator/accounts",
  "/v1/account-directory/operator/accounts/{account}",
  "/v1/account-directory/operator/accounts/{account}/entitlements/{product}",
]);
const ACCOUNT_ID_SEGMENT_PATTERN = /^[a-f0-9-]{36}$/i;
const HTTP_METHOD_PATTERN = /^[A-Z]{3,7}$/;
const ERROR_LABEL_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const MAXIMUM_LOGGED_MESSAGE_LENGTH = 300;

export interface LoggedRequest {
  httpMethod?: string;
  path?: string;
}

/** `<METHOD> <template>` with account IDs as {account} and an entitlement's product as {product}. */
export function loggedRoute(event: LoggedRequest) {
  const method = matchesStringPattern(event.httpMethod, HTTP_METHOD_PATTERN) ? event.httpMethod : "{method}";
  const segments = (typeof event.path === "string" ? event.path : "").split("/");
  const template = segments
    .map((segment, index) =>
      ACCOUNT_ID_SEGMENT_PATTERN.test(segment)
        ? "{account}"
        : segments[index - 1] === "entitlements" && isProductName(segment)
          ? "{product}"
          : segment,
    )
    .join("/");
  return `${method} ${LOGGED_ROUTE_TEMPLATES.has(template) ? template : "{unrecognized}"}`;
}

/** A class name or code shaped like an identifier, never free text that could carry request data. */
function errorLabel(value: unknown) {
  return matchesStringPattern(value, ERROR_LABEL_PATTERN) ? value : undefined;
}

function unexpectedErrorName(error: unknown) {
  if (!error || typeof error !== "object") return typeof error;
  const name = (error as Error).name;
  return (
    (name && name !== "Error" ? errorLabel(name) : undefined) ??
    errorLabel(error.constructor?.name) ??
    "Error"
  );
}

/** One JSON line per refused request. Rule messages are static strings; nothing from the request is logged but its
 * route template, and an unexpected error contributes only its class name and code, never its message or stack. */
export function logRefusal(event: LoggedRequest, error: unknown) {
  const route = loggedRoute(event);
  const errorCode =
    error && typeof error === "object" && "code" in error ? errorLabel(error.code) : undefined;
  const line =
    error instanceof AccountsError
      ? {
          event: "accounts.refusal",
          route,
          status: error.status,
          code: errorLabel(error.code) ?? "{code}",
          message: String(error.message).slice(0, MAXIMUM_LOGGED_MESSAGE_LENGTH),
        }
      : {
          event: "accounts.unavailable",
          route,
          errorName: unexpectedErrorName(error),
          ...(errorCode ? { errorCode } : {}),
        };
  try {
    console.info(JSON.stringify(line));
  } catch {}
}
