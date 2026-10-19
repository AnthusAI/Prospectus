export type Role = "owner" | "admin" | "member" | "viewer";
export type Operation = "console:read" | "console:write" | "members:read" | "members:write";
export interface Person {
  id: string;
  createdAt: string;
}
export interface AccountSummary {
  id: string;
  name: string;
  role: Role;
  entitlement: {
    accountId: string;
    product: string;
    status: "active" | "disabled";
    capabilities: Operation[];
  };
}
export interface AccountsList {
  person: Person | null;
  accounts: AccountSummary[];
}
export interface Authorization {
  allowed: true;
  accountId: string;
  personId: string;
  product: string;
  role: Role;
  operation: Operation;
  revision: number;
}
export type Transport = (
  path: string,
  method: "GET" | "POST",
  body?: unknown,
  requestKey?: string,
) => Promise<unknown>;
export class AccountsClientError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function decode(response: Response): Promise<any> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new AccountsClientError(
      response.status,
      body.error ?? "request_failed",
      body.message ?? "Account request failed.",
    );
  return body;
}
import type { DirectoryList, DirectoryDetail, OperatorList, OperatorDetail } from "./directory.js";
export class AccountsClient {
  constructor(private transport: Transport) {}
  operatorList(): Promise<OperatorList> {
    return this.transport("/v1/account-directory/operator/accounts", "GET") as Promise<OperatorList>;
  }
  operatorDetail(id: string): Promise<{ account: OperatorDetail }> {
    return this.transport(
      `/v1/account-directory/operator/accounts/${encodeURIComponent(id)}`,
      "GET",
    ) as Promise<{ account: OperatorDetail }>;
  }
  directoryList(): Promise<DirectoryList> {
    return this.transport("/v1/account-directory", "GET") as Promise<DirectoryList>;
  }
  directoryDetail(id: string): Promise<{ account: DirectoryDetail }> {
    return this.transport(`/v1/account-directory/${encodeURIComponent(id)}`, "GET") as Promise<{
      account: DirectoryDetail;
    }>;
  }
  challenge(
    loginStateDigest?: string,
  ): Promise<{ challengeId: string; nonce: string; expiresAt: number; challengeToken?: string }> {
    return this.transport(
      "/v1/identities/google/challenge",
      "POST",
      loginStateDigest ? { loginStateDigest } : {},
    ) as any;
  }
  resolveGoogle(
    challenge: string | { challengeToken: string },
    loginState?: string,
  ): Promise<{ person: Person }> {
    return this.transport("/v1/identities/google/resolve", "POST", {
      ...(typeof challenge === "string" ? { challengeId: challenge } : challenge),
      ...(loginState ? { loginState } : {}),
    }) as Promise<{
      person: Person;
    }>;
  }
  resolve(): Promise<{ person: Person }> {
    return this.transport("/v1/identities/resolve", "POST", {}) as Promise<{ person: Person }>;
  }
  list(): Promise<AccountsList> {
    return this.transport("/v1/accounts", "GET") as Promise<AccountsList>;
  }
  create(name: string, requestKey: string): Promise<{ account: AccountSummary }> {
    return this.transport("/v1/accounts", "POST", { name }, requestKey) as Promise<{
      account: AccountSummary;
    }>;
  }
  get(accountId: string): Promise<{ account: AccountSummary }> {
    return this.transport(`/v1/accounts/${encodeURIComponent(accountId)}`, "GET") as Promise<{
      account: AccountSummary;
    }>;
  }
  authorize(accountId: string, operation: Operation): Promise<Authorization> {
    return this.transport(`/v1/accounts/${encodeURIComponent(accountId)}/authorize`, "POST", {
      operation,
    }) as Promise<Authorization>;
  }
  setMembership(accountId: string, personId: string, role: Role, status: "active" | "revoked") {
    return this.transport(`/v1/accounts/${encodeURIComponent(accountId)}/memberships`, "POST", {
      personId,
      role,
      status,
    });
  }
}
/** Browser requests go only to the host's BFF, which owns authentication and IAM. */
export function browserAccountsClient(
  base = "/api/prospectus",
  fetcher: typeof fetch = fetch,
): AccountsClient {
  if (!base.startsWith("/") || base.startsWith("//") || /[?#]/.test(base))
    throw new Error("Use a same-origin account BFF path.");
  return new AccountsClient(async (path, method, body, requestKey) =>
    decode(
      await fetcher(`${base.replace(/\/$/, "")}${path}`, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(requestKey ? { "Idempotency-Key": requestKey } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
    ),
  );
}
