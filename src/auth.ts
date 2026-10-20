import type { AccountsChallenge } from "./accounts-client";
const SESSION_KEY = "prospectus.session";
const LOGIN_KEY = "prospectus.login";
const ACCOUNTS_CONFIRMATION_ATTEMPTED_KEY = "prospectus.accounts-confirmation-attempted";
export const ACCOUNTS_CONFIRMATION_FAILED_MESSAGE =
  "You are signed in, but Google confirmation for Accounts could not be completed. Continue with Google on the Accounts tab to try again.";

export class AccountsConfirmationError extends Error {
  constructor() {
    super(ACCOUNTS_CONFIRMATION_FAILED_MESSAGE);
  }
}
interface Session {
  accessToken: string;
  expiresAt: number;
}
interface Login {
  state: string;
  verifier: string;
  accounts?: AccountsChallenge;
  accountsChallengeBoundToLoginState?: boolean;
}
export interface AuthenticationConfiguration {
  domain: string;
  clientId: string;
  redirectUri: string;
  logoutUri: string;
  accountsBffUrl?: string;
}

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function getAccessToken(): string | null {
  try {
    const session = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "null") as Session | null;
    return session && session.expiresAt > Date.now() ? session.accessToken : null;
  } catch {
    return null;
  }
}

export function setLocalToken(token: string): void {
  if (!import.meta.env.DEV) throw new Error("Local authentication is unavailable.");
  sessionStorage.setItem(
    SESSION_KEY,
    JSON.stringify({ accessToken: token, expiresAt: Date.now() + 3_600_000 }),
  );
}

export function clearSession(): void {
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(ACCOUNTS_CONFIRMATION_ATTEMPTED_KEY);
}

export function hasAttemptedAccountsConfirmation(): boolean {
  try {
    return sessionStorage.getItem(ACCOUNTS_CONFIRMATION_ATTEMPTED_KEY) === "true";
  } catch {
    return true;
  }
}

export async function signIn(
  configuration: AuthenticationConfiguration,
  accounts?: AccountsChallenge,
): Promise<void> {
  const state = encode(crypto.getRandomValues(new Uint8Array(32)));
  const verifier = encode(crypto.getRandomValues(new Uint8Array(64)));
  const challenge = encode(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  let accountsChallengeBoundToLoginState = false;
  if (!accounts && configuration.accountsBffUrl) {
    try {
      const { accountsBrowser } = await import("./accounts-client");
      const stateDigest = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state))),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      accounts = await accountsBrowser(configuration.accountsBffUrl).loginChallenge(stateDigest);
      accountsChallengeBoundToLoginState = true;
    } catch {
      accounts = undefined;
    }
  }
  sessionStorage.setItem(
    LOGIN_KEY,
    JSON.stringify({
      state,
      verifier,
      ...(accounts ? { accounts } : {}),
      ...(accountsChallengeBoundToLoginState ? { accountsChallengeBoundToLoginState } : {}),
    }),
  );
  if (accounts) sessionStorage.setItem(ACCOUNTS_CONFIRMATION_ATTEMPTED_KEY, "true");
  const destination = new URL("/oauth2/authorize", configuration.domain);
  destination.search = new URLSearchParams({
    client_id: configuration.clientId,
    identity_provider: "Google",
    response_type: "code",
    scope: "openid email profile",
    redirect_uri: configuration.redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  if (accounts) {
    destination.searchParams.set("nonce", accounts.nonce);
    destination.searchParams.set("prompt", "login");
  }
  window.location.assign(destination);
}

/**
 * Completes the Google redirect. `onSession` runs as soon as the access token is stored, so the CRM can load
 * while a sign-in-bound Accounts confirmation finishes. Only an explicit Accounts confirmation opens Accounts
 * or reports an Accounts error; for an ordinary sign-in a failed confirmation is retried from Accounts.
 */
export async function finishSignIn(
  configuration: AuthenticationConfiguration,
  onSession?: () => void,
): Promise<boolean> {
  const parameters = new URLSearchParams(window.location.search);
  if (!parameters.has("code") && !parameters.has("error")) return false;
  let login: Login | null = null;
  try {
    login = JSON.parse(sessionStorage.getItem(LOGIN_KEY) ?? "null") as Login | null;
  } catch {
    /* Reject invalid saved login below. */
  }
  sessionStorage.removeItem(LOGIN_KEY);
  window.history.replaceState({}, "", "/");
  if (
    !login ||
    typeof login.state !== "string" ||
    !login.state ||
    typeof login.verifier !== "string" ||
    !login.verifier ||
    parameters.get("state") !== login.state
  )
    throw new Error("Sign-in could not be verified. Please try again.");
  if (parameters.has("error"))
    throw new Error(
      `Sign-in was not completed: ${parameters.get("error_description") || parameters.get("error")}.`,
    );
  if (!parameters.get("code")) throw new Error("Sign-in failed. Please try again.");
  const response = await fetch(new URL("/oauth2/token", configuration.domain), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: configuration.clientId,
      redirect_uri: configuration.redirectUri,
      code: parameters.get("code")!,
      code_verifier: login.verifier,
    }),
  });
  const result = (await response.json()) as { access_token?: string; id_token?: string; expires_in?: number };
  if (!response.ok || !result.access_token || !result.expires_in)
    throw new Error("Sign-in failed. Please try again.");
  sessionStorage.setItem(
    SESSION_KEY,
    JSON.stringify({ accessToken: result.access_token, expiresAt: Date.now() + result.expires_in * 1000 }),
  );
  onSession?.();
  if (login.accounts) {
    const explicit = !login.accountsChallengeBoundToLoginState;
    try {
      if (!result.id_token || !configuration.accountsBffUrl)
        throw new Error("Accounts sign-in evidence is unavailable.");
      const { accountsBrowser } = await import("./accounts-client");
      await accountsBrowser(configuration.accountsBffUrl).resolve(
        login.accounts,
        result.id_token,
        result.access_token,
        login.accountsChallengeBoundToLoginState ? login.state : undefined,
      );
    } catch {
      if (!explicit) return true;
      window.history.replaceState({}, "", "/?view=accounts");
      throw new AccountsConfirmationError();
    }
    sessionStorage.removeItem(ACCOUNTS_CONFIRMATION_ATTEMPTED_KEY);
    if (explicit) window.history.replaceState({}, "", "/?view=accounts");
  }
  return true;
}

export function signOut(configuration: AuthenticationConfiguration | null): void {
  clearSession();
  if (!configuration) {
    window.location.assign("/");
    return;
  }
  const destination = new URL("/logout", configuration.domain);
  destination.search = new URLSearchParams({
    client_id: configuration.clientId,
    logout_uri: configuration.logoutUri,
  }).toString();
  window.location.assign(destination);
}
