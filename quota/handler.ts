import { caller, type RestEvent } from "../accounts/auth";
import { AccountsError, fail } from "../accounts/model";
import type { ValidatedRegistrations } from "../accounts/registration";
import { jsonResponse, parseJsonRequest } from "../accounts/request";
import { logRefusal } from "../accounts/refusal-log";
import type { Quota } from "./service";

const QUOTA_REQUEST_MAXIMUM_BODY_BYTES = 2000;
const ACCOUNT = "([a-f0-9-]{36})";

/** The product behind a SigV4 call: a registered, enabled enrollment role carrying the quota flag. Anything else, a
 * missing or non-role caller, an execution role, the lab verifier or a product without the flag, is refused. */
function quotaProduct(event: RestEvent, products: ValidatedRegistrations): string {
  const authenticated = caller(event, products);
  if (authenticated.authority !== "enrollment" || authenticated.registration.quota !== true)
    fail(403, "quota_forbidden", "This product is not registered to use quota.");
  return authenticated.registration.product;
}

/**
 * `/v1/quota/...`, called by a product's server role (not by a person):
 *
 * - `POST /v1/quota/accounts/{account}/reservations` with `operationId`, `maxCents`, `expiresInSeconds`
 * - `POST /v1/quota/accounts/{account}/reservations/{reservation}/settle` with `operationId`, `actualCents`,
 *   optional `allowOverage`
 * - `POST /v1/quota/accounts/{account}/reservations/{reservation}/release` with `operationId`
 *
 * A store failure answers 503 and never success.
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
        fields(["operationId", "maxCents", "expiresInSeconds"]);
        return jsonResponse(200, (await quota.reserve({ product }, reserve[1], body)).result);
      }
      const close = new RegExp(
        `^/v1/quota/accounts/${ACCOUNT}/reservations/${ACCOUNT}/(settle|release)$`,
      ).exec(event.path);
      if (close?.[3] === "settle") {
        fields(["operationId", "actualCents", "allowOverage"]);
        return jsonResponse(200, (await quota.settle({ product }, close[1], close[2], body)).result);
      }
      if (close?.[3] === "release") {
        fields(["operationId"]);
        return jsonResponse(200, (await quota.release({ product }, close[1], close[2], body)).result);
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
