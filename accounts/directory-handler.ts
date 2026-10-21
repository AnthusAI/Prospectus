import { context, type KeyResolver, type RestEvent } from "./auth";
import type { ValidatedRegistrations } from "./registration";
import { isGoogleDirect } from "./google-direct";
import { jsonResponse } from "./request";
import { AccountsError, fail, roleOperations } from "./model";
import { DurableAccountsService, type AccountDocument } from "./durable-accounts";
import { canReadOperatorDirectory, hasOperatorPermission, type OperatorGrant } from "./operator-policy";
import type {
  OperatorAccount,
  OperatorDetail,
  DirectoryAccount,
  DirectoryDetail,
} from "../packages/accounts-client/src/directory";
/** Personal reads require membership. Operator reads require a separate reviewed
 * human permission and current canonical session proof; neither authorizes app use.
 */
export function accountDirectoryHandler(
  service: DurableAccountsService,
  products: ValidatedRegistrations,
  keys: KeyResolver,
  clock = () => Date.now() / 1000,
  grants: readonly OperatorGrant[] = [],
) {
  const summary = (document: AccountDocument, personId: string): DirectoryAccount | null => {
    const membership = document.memberships[personId];
    if (!membership || membership.status !== "active") return null;
    return {
      id: document.account.id,
      name: document.account.name,
      role: membership.role,
      products: Object.values(document.entitlements)
        .map(({ product, status }) => ({ product, status }))
        .sort((left, right) => left.product.localeCompare(right.product)),
    };
  };
  return async (event: RestEvent) => {
    try {
      const authenticated = await context(event, products, keys, clock());
      if (
        !products.some(
          (product) =>
            product.enabled &&
            product.product === authenticated.product &&
            product.roleArn === authenticated.principal &&
            product.accountDirectory === true,
        ) ||
        !authenticated.capabilities.includes("console:read")
      )
        fail(403, "directory_forbidden", "Account directory access is not registered.");
      // A google-direct product (the customer portal) reads only the caller's own accounts: never operator routes.
      const product = products.find((item) => item.enabled && item.product === authenticated.product);
      if (product && isGoogleDirect(product) && event.path.startsWith("/v1/account-directory/operator/"))
        fail(403, "operator_forbidden", "This product cannot use operator routes.");
      const entitlementRoute =
        /^\/v1\/account-directory\/operator\/accounts\/([a-f0-9-]{36})\/entitlements\/([a-z][a-z0-9-]{0,39})$/.exec(
          event.path,
        );
      if (entitlementRoute && event.httpMethod === "POST") {
        const operator = await service.person(authenticated);
        if (!hasOperatorPermission(authenticated, grants, "accounts:admin:entitlements"))
          fail(403, "operator_forbidden", "Explicit central entitlements permission is required.");
        const contentType = Object.entries(event.headers ?? {}).find(
          ([name]) => name.toLowerCase() === "content-type",
        )?.[1];
        if (event.isBase64Encoded || Buffer.byteLength(event.body ?? "") > 12000)
          fail(400, "body", "Unsupported entitlement payload.");
        if (contentType?.split(";")[0] !== "application/json") fail(415, "json_required", "JSON required.");
        let requested: unknown;
        try {
          requested = JSON.parse(event.body ?? "");
        } catch {
          fail(400, "invalid_entitlement", "JSON body with status required.");
        }
        if (!requested || typeof requested !== "object" || Object.keys(requested).join(",") !== "status")
          fail(400, "invalid_entitlement", "Body must contain only status.");
        const registeredProduct = products.find(
          (product) => product.enabled && product.product === entitlementRoute[2],
        );
        if (!registeredProduct) fail(404, "unknown_product", "Product is not registered.");
        const entitlement = await service.setEntitlement(
          authenticated,
          entitlementRoute[1],
          registeredProduct,
          (requested as { status: "active" | "disabled" }).status,
        );
        return jsonResponse(200, { person: operator, entitlement });
      }
      if (event.httpMethod !== "GET" || (event.body && event.body !== "{}"))
        fail(400, "read_only", "Account directory supports read requests only.");
      let person;
      try {
        person = await service.person(authenticated);
      } catch (error) {
        if (
          error instanceof AccountsError &&
          error.code === "identity_enrollment_required" &&
          event.path === "/v1/account-directory"
        )
          return jsonResponse(200, { person: null, accounts: [] });
        throw error;
      }
      const operatorAccess = canReadOperatorDirectory(authenticated, grants);
      if (event.path.startsWith("/v1/account-directory/operator/")) {
        if (!operatorAccess)
          fail(403, "operator_forbidden", "Explicit central Accounts administrator permission is required.");
        const operatorSummary = (document: AccountDocument): OperatorAccount => ({
          id: document.account.id,
          name: document.account.name,
          createdAt: document.account.createdAt,
          revision: document.account.revision,
          products: Object.values(document.entitlements)
            .map(({ product, status }) => ({ product, status }))
            .sort((left, right) => left.product.localeCompare(right.product)),
          activeMembers: Object.values(document.memberships).filter((member) => member.status === "active")
            .length,
        });
        if (event.path === "/v1/account-directory/operator/accounts") {
          const accounts = (await service.allAccounts()).map(operatorSummary);
          return jsonResponse(200, {
            person,
            accounts: accounts.sort(
              (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
            ),
          });
        }
        const match = /^\/v1\/account-directory\/operator\/accounts\/([a-f0-9-]{36})$/.exec(event.path);
        if (!match) fail(404, "route", "Operator directory route not found.");
        const stored = await service.read(match[1]);
        if (!stored) fail(404, "account_missing", "Account not found.");
        const account: OperatorDetail = {
          ...operatorSummary(stored.value),
          entitlements: structuredClone(Object.values(stored.value.entitlements)),
          memberships: structuredClone(Object.values(stored.value.memberships)),
        };
        return jsonResponse(200, { account });
      }
      if (event.path === "/v1/account-directory") {
        const accounts = (await service.candidateAccounts(person.id))
          .map((document) => summary(document, person.id))
          .filter((account): account is DirectoryAccount => account !== null);
        return jsonResponse(200, {
          person,
          operatorAccess,
          accounts: accounts.sort(
            (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
          ),
        });
      }
      const match = /^\/v1\/account-directory\/([a-f0-9-]{36})$/.exec(event.path);
      if (!match) fail(404, "route", "Account directory route not found.");
      const stored = await service.read(match[1]),
        account = stored ? summary(stored.value, person.id) : null;
      if (!account || !stored) fail(403, "forbidden", "Account details are not permitted.");
      const membershipsVisible =
        authenticated.capabilities.includes("members:read") &&
        roleOperations[account.role].includes("members:read");
      const detail: DirectoryDetail = {
        ...account,
        createdAt: stored.value.account.createdAt,
        revision: stored.value.account.revision,
        entitlements: structuredClone(Object.values(stored.value.entitlements)),
        memberships: structuredClone(
          membershipsVisible
            ? Object.values(stored.value.memberships)
            : [stored.value.memberships[person.id]],
        ),
        membershipsVisible,
      };
      return jsonResponse(200, { account: detail });
    } catch (error) {
      if (error instanceof AccountsError)
        return jsonResponse(error.status, { error: error.code, message: error.message });
      return jsonResponse(503, {
        error: "accounts_unavailable",
        message: "Accounts are unavailable. Try again.",
      });
    }
  };
}
