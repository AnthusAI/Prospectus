import { getAccessToken } from "./auth";
import type {
  OperatorReader,
  OperatorDetail,
  OperatorList,
  DirectoryReader,
  DirectoryDetail,
  DirectoryList,
} from "../packages/accounts-client/src/directory";
export class DirectoryError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface AccountsBrowser extends DirectoryReader, OperatorReader {
  configured: boolean;
  challenge(): Promise<{ challengeId: string; nonce: string }>;
  /** Pre-sign-in challenge bound to the digest of this browser's login state. Needs no session. */
  loginChallenge(loginStateDigest: string): Promise<{ challengeId: string; nonce: string }>;
  resolve(challengeId: string, idToken: string, accessToken: string, loginState?: string): Promise<void>;
}
export function accountsBrowser(
  base: string | undefined,
  fetcher: typeof fetch = fetch,
  token: () => string | null = getAccessToken,
): AccountsBrowser {
  const root = base?.replace(/\/$/, "");
  async function request(path: string, method = "GET", body?: unknown, access = token()) {
    if (!root) throw new DirectoryError(503, "The Accounts service has not been configured.");
    if (!access) throw new DirectoryError(401, "Sign in again to view accounts.");
    const response = await fetcher(`${root}${path}`, {
      method,
      cache: "no-store",
      redirect: "error",
      headers: { authorization: `Bearer ${access}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const value = await response.json().catch(() => null);
    if (!response.ok)
      throw new DirectoryError(
        response.status,
        response.status === 403
          ? "You do not have access to this account."
          : response.status === 401
            ? "Sign in again to view accounts."
            : "Accounts could not be loaded. Try again.",
      );
    return value;
  }
  return {
    configured: !!root,
    operatorList: async () => {
      const value = await request("/operator/accounts");
      if (
        !value ||
        typeof value.person?.id !== "string" ||
        !Array.isArray(value.accounts) ||
        value.accounts.some(
          (account: any) =>
            typeof account.id !== "string" ||
            typeof account.name !== "string" ||
            !Array.isArray(account.products) ||
            !Number.isSafeInteger(account.activeMembers),
        )
      )
        throw new DirectoryError(503, "Invalid operator response.");
      return value as OperatorList;
    },
    operatorDetail: async (id: string) => {
      const value = (await request(`/operator/accounts/${encodeURIComponent(id)}`))?.account;
      if (
        value?.id !== id ||
        typeof value.name !== "string" ||
        !Array.isArray(value.entitlements) ||
        !Array.isArray(value.memberships) ||
        !Number.isSafeInteger(value.revision)
      )
        throw new DirectoryError(503, "Invalid operator response.");
      return value as OperatorDetail;
    },
    list: async () => {
      const value = await request("/accounts");
      if (
        !value ||
        !Array.isArray(value.accounts) ||
        !(value.person === null || typeof value.person?.id === "string") ||
        value.accounts.some(
          (account: any) =>
            typeof account.id !== "string" ||
            typeof account.name !== "string" ||
            !["owner", "admin", "member", "viewer"].includes(account.role) ||
            !Array.isArray(account.products),
        )
      )
        throw new DirectoryError(503, "Invalid account response.");
      return value as DirectoryList;
    },
    detail: async (id: string) => {
      const value = (await request(`/accounts/${encodeURIComponent(id)}`))?.account;
      if (
        value?.id !== id ||
        typeof value.name !== "string" ||
        !Array.isArray(value.entitlements) ||
        !Array.isArray(value.memberships) ||
        typeof value.membershipsVisible !== "boolean" ||
        !Number.isSafeInteger(value.revision)
      )
        throw new DirectoryError(503, "Invalid account response.");
      return value as DirectoryDetail;
    },
    challenge: () => request("/identity/challenge", "POST", {}),
    loginChallenge: async (loginStateDigest) => {
      if (!root) throw new DirectoryError(503, "The Accounts service has not been configured.");
      const response = await fetcher(`${root}/identity/login-challenge`, {
        method: "POST",
        cache: "no-store",
        redirect: "error",
        credentials: "omit",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ loginStateDigest }),
      });
      const value = await response.json().catch(() => null);
      if (!response.ok || typeof value?.challengeId !== "string" || typeof value?.nonce !== "string")
        throw new DirectoryError(response.status || 503, "A sign-in challenge could not be issued.");
      return { challengeId: value.challengeId, nonce: value.nonce };
    },
    resolve: async (challengeId, idToken, access, loginState) => {
      await request(
        "/identity/resolve",
        "POST",
        { challengeId, idToken, ...(loginState ? { loginState } : {}) },
        access,
      );
    },
  };
}
