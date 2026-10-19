import {
  AccountsError,
  fail,
  UUID_PATTERN,
  type AccountAuthorization,
  type AccountSummary,
  type Context,
  type Membership,
  type Operation,
  type Person,
  type Role,
} from "./model";
import { context, type KeyResolver, type RestEvent } from "./auth";
import type { ValidatedRegistrations } from "./registration";
import { jsonResponse, parseJsonRequest } from "./request";

const ACCOUNT_REQUEST_MAXIMUM_BODY_BYTES = 12000;

export interface AccountsApi {
  resolve(context: Context): Promise<Person>;
  list(context: Context): Promise<{ person: Person | null; accounts: AccountSummary[] }>;
  create(context: Context, name: string, requestId: string): Promise<AccountSummary>;
  get(context: Context, accountId: string): Promise<AccountSummary>;
  authorize(context: Context, accountId: string, operation: Operation): Promise<AccountAuthorization>;
  setMembership(
    context: Context,
    accountId: string,
    personId: string,
    role: Role,
    status: Membership["status"],
  ): Promise<Membership>;
}

export function accountHandler(
  service: AccountsApi,
  products: ValidatedRegistrations,
  keys: KeyResolver,
  nowSeconds = () => Date.now() / 1000,
) {
  return async (event: RestEvent) => {
    try {
      const authenticated = await context(event, products, keys, nowSeconds());
      const { headers, body } = parseJsonRequest(event, ACCOUNT_REQUEST_MAXIMUM_BODY_BYTES);
      const fields = (allowed: string[]) => {
        if (Object.keys(body).some((key) => !allowed.includes(key)))
          fail(400, "unknown_fields", "Unsupported account fields.");
      };
      if (event.path === "/v1/identities/resolve" && event.httpMethod === "POST") {
        fields([]);
        return jsonResponse(200, { person: await service.resolve(authenticated) });
      }
      if (event.path === "/v1/accounts" && event.httpMethod === "GET") {
        fields([]);
        return jsonResponse(200, await service.list(authenticated));
      }
      if (event.path === "/v1/accounts" && event.httpMethod === "POST") {
        fields(["name"]);
        return jsonResponse(200, {
          account: await service.create(authenticated, body.name, headers["idempotency-key"] ?? ""),
        });
      }
      const route = /^\/v1\/accounts\/([a-f0-9-]{36})(?:\/(authorize|memberships))?$/.exec(event.path);
      if (!route) fail(404, "route", "Account route not found.");
      if (!route[2] && event.httpMethod === "GET") {
        fields([]);
        return jsonResponse(200, { account: await service.get(authenticated, route[1]) });
      }
      if (route[2] === "authorize" && event.httpMethod === "POST") {
        fields(["operation"]);
        if (!authenticated.capabilities.includes(body.operation))
          fail(403, "operation_forbidden", "Caller operation is not registered.");
        return jsonResponse(
          200,
          await service.authorize(authenticated, route[1], body.operation as Operation),
        );
      }
      if (route[2] === "memberships" && event.httpMethod === "POST") {
        fields(["personId", "role", "status"]);
        if (typeof body.personId !== "string" || !UUID_PATTERN.test(body.personId))
          fail(400, "person", "Known person ID required.");
        return jsonResponse(200, {
          membership: await service.setMembership(
            authenticated,
            route[1],
            body.personId,
            body.role as Role,
            body.status,
          ),
        });
      }
      fail(404, "route", "Account route not found.");
    } catch (error) {
      if (error instanceof AccountsError)
        return jsonResponse(error.status, { error: error.code, message: error.message });
      return jsonResponse(503, {
        error: "accounts_unavailable",
        message: "Account service unavailable. Retry with the same request key.",
      });
    }
  };
}
