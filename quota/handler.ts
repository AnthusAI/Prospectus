import { caller, type RestEvent } from "../accounts/auth";
import { AccountsError, fail } from "../accounts/model";
import type { ValidatedRegistrations } from "../accounts/registration";
import { jsonResponse, parseJsonRequest } from "../accounts/request";
import { logRefusal } from "../accounts/refusal-log";
import type { Quota } from "./service";

const QUOTA_REQUEST_MAXIMUM_BODY_BYTES = 16000;
const ACCOUNT = "([a-f0-9-]{36})";

/** The product behind a SigV4 call: a registered, enabled enrollment role or quota caller role of a product carrying
 * the quota flag. Anything else, a missing or non-role caller, an execution role, the lab verifier or a product
 * without the flag, is refused. */
function quotaProduct(event: RestEvent, products: ValidatedRegistrations): string {
  const authenticated = caller(event, products);
  if (
    (authenticated.authority !== "enrollment" && authenticated.authority !== "quota") ||
    authenticated.registration.quota !== true
  )
    fail(403, "quota_forbidden", "This product is not registered to use quota.");
  return authenticated.registration.product;
}

/**
 * `/v1/quota/...`, called by a product's server role (not by a person). Products send billable items, never money;
 * responses carry no units, rates or amounts.
 *
 * - `POST .../accounts/{account}/reservations` with `operationId`, `items`, `expiresInSeconds`
 * - `POST .../accounts/{account}/reservations/{reservation}/settle` with `operationId`, `items`
 * - `POST .../accounts/{account}/reservations/{reservation}/release` with `operationId`
 * - `POST .../accounts/{account}/usage` with `operationId`, `items` (pay after)
 * - `POST .../accounts/{account}/check` with `{}`
 *
 * A store or rate table failure answers 503 and never success.
 */
export function quotaHandler(quota: Quota | undefined, products: ValidatedRegistrations) {
  return async (event: RestEvent) => {
    try {
      const product = quotaProduct(event, products);
      if (!quota) return unavailable();
      const { body } = parseJsonRequest(event, QUOTA_REQUEST_MAXIMUM_BODY_BYTES);
      const fields = (allowed: string[]) => {
        if (Object.keys(body).some((key) => !allowed.includes(key)))
          fail(400, "unknown_fields", "Unsupported quota fields.");
      };
      if (event.httpMethod !== "POST") fail(405, "method", "Quota routes accept POST only.");
      const reserve = new RegExp(`^/v1/quota/accounts/${ACCOUNT}/reservations$`).exec(event.path);
      if (reserve) {
        fields(["operationId", "items", "expiresInSeconds"]);
        return jsonResponse(200, (await quota.reserve({ product }, reserve[1], body)).result);
      }
      const close = new RegExp(
        `^/v1/quota/accounts/${ACCOUNT}/reservations/${ACCOUNT}/(settle|release)$`,
      ).exec(event.path);
      if (close?.[3] === "settle") {
        fields(["operationId", "items"]);
        return jsonResponse(200, (await quota.settle({ product }, close[1], close[2], body)).result);
      }
      if (close?.[3] === "release") {
        fields(["operationId"]);
        return jsonResponse(200, (await quota.release({ product }, close[1], close[2], body)).result);
      }
      const usage = new RegExp(`^/v1/quota/accounts/${ACCOUNT}/usage$`).exec(event.path);
      if (usage) {
        fields(["operationId", "items"]);
        return jsonResponse(200, (await quota.record({ product }, usage[1], body)).result);
      }
      const check = new RegExp(`^/v1/quota/accounts/${ACCOUNT}/check$`).exec(event.path);
      if (check) {
        fields([]);
        return jsonResponse(200, (await quota.check({ product }, check[1])).result);
      }
      fail(404, "route", "Quota route not found.");
    } catch (error) {
      logRefusal(event, error);
      if (error instanceof AccountsError)
        return jsonResponse(error.status, { error: error.code, message: error.message });
      return unavailable();
    }
  };
}

const unavailable = () =>
  jsonResponse(503, {
    error: "quota_unavailable",
    message: "Quota is unavailable. Do not spend; retry with the same operation ID.",
  });
