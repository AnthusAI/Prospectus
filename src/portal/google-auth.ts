// Anthus One signs in with Google Identity Services: the browser receives a Google ID token whose nonce is a
// server-issued challenge, and sends that token as the bearer to the portal's accounts API. There is no Cognito pool,
// no redirect URI, no authorization code and no client secret in the browser.
import type { AccountsChallenge } from "../accounts-client";

const SESSION_KEY = "anthus-one.session";
const LOGIN_KEY = "anthus-one.login";
const GIS_SOURCE = "https://accounts.google.com/gsi/client";
/** Central Accounts accepts a challenge for 300 seconds; stay a little inside that. */
const CHALLENGE_LIFETIME_MS = 290_000;
/** Request a fresh credential this long before the current one expires. */
export const REFRESH_BEFORE_EXPIRY_MS = 5 * 60_000;

interface Session {
  idToken: string;
  expiresAt: number;
}
interface Login {
  state: string;
  challenge: AccountsChallenge;
  issuedAt: number;
}
interface GoogleCredentialResponse {
  credential?: string;
}
interface GoogleIdentity {
  initialize(configuration: Record<string, unknown>): void;
  renderButton(parent: HTMLElement, options: Record<string, unknown>): void;
  prompt(): void;
  disableAutoSelect(): void;
  cancel(): void;
}
declare global {
  interface Window {
    google?: { accounts: { id: GoogleIdentity } };
  }
}

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
/** Claims of a Google ID token. This only reads them; the accounts API verifies the signature on every request. */
export function decodeClaims(token: string): Record<string, any> | null {
  try {
    const payload = token.split(".")[1];
    return JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(payload.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0)),
      ),
    );
  } catch {
    return null;
  }
}
function read<T>(key: string): T | null {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? "null") as T | null;
  } catch {
    return null;
  }
}

/** The Google ID token for API calls, or null once it has expired (about an hour after it was issued). */
export function getIdToken(now = Date.now()): string | null {
  const session = read<Session>(SESSION_KEY);
  return session && typeof session.idToken === "string" && session.expiresAt - 10_000 > now
    ? session.idToken
    : null;
}
export function sessionExpiresAt(): number | null {
  const session = read<Session>(SESSION_KEY);
  return session && Number.isFinite(session.expiresAt) ? session.expiresAt : null;
}
export function clearPortalSession(): void {
  try {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(LOGIN_KEY);
  } catch {
    /* Storage can be unavailable; the in-memory page state still signs out. */
  }
}
/** Sanity checks the browser can make; the server does the real verification. Returns whether it was stored. */
export function acceptCredential(
  token: string | undefined,
  expectedNonce: string,
  clientId: string,
  now = Date.now(),
): boolean {
  const claims = token ? decodeClaims(token) : null;
  if (
    !token ||
    !claims ||
    claims.aud !== clientId ||
    claims.nonce !== expectedNonce ||
    claims.email_verified !== true ||
    !Number.isFinite(claims.exp) ||
    claims.exp * 1000 <= now
  )
    return false;
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ idToken: token, expiresAt: claims.exp * 1000 }));
  } catch {
    return false;
  }
  return true;
}

let loading: Promise<GoogleIdentity> | undefined;
export function loadGoogleIdentity(): Promise<GoogleIdentity> {
  if (window.google?.accounts?.id) return Promise.resolve(window.google.accounts.id);
  loading ??= new Promise<GoogleIdentity>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = GIS_SOURCE;
    script.async = true;
    script.onload = () =>
      window.google?.accounts?.id
        ? resolve(window.google.accounts.id)
        : reject(new Error("Google sign-in did not load."));
    script.onerror = () => {
      loading = undefined;
      reject(new Error("Google sign-in could not be loaded. Check your connection and try again."));
    };
    document.head.append(script);
  });
  return loading;
}

export interface CredentialRequest {
  clientId: string;
  /** First sign-in: the public challenge route, bound to the digest of this browser's login state. */
  loginChallenge(loginStateDigest: string): Promise<AccountsChallenge>;
  /** Renewal while signed in: the authenticated challenge route (needs the current token, takes no login state).
   * When given, the public route is not used, so open tabs never spend its shared rate limit.
   */
  authenticatedChallenge?: () => Promise<AccountsChallenge>;
  /** Called after a credential with the challenge nonce has been accepted and stored. */
  onCredential(): void;
  /** Where to draw the "Sign in with Google" button, if anywhere. */
  button?: HTMLElement | null;
  /** Also show One Tap, which can complete without a click for a returning person. */
  prompt?: boolean;
}
/** Ask Google for a credential whose nonce is a fresh server challenge. Each call replaces the previous request. */
export async function requestCredential(request: CredentialRequest): Promise<void> {
  let challenge: AccountsChallenge;
  if (request.authenticatedChallenge) {
    // A renewal enrolls nothing, so it keeps no login state and a stale login record must not outlive it.
    challenge = await request.authenticatedChallenge();
    sessionStorage.removeItem(LOGIN_KEY);
  } else {
    const state = encode(crypto.getRandomValues(new Uint8Array(32)));
    challenge = await request.loginChallenge(await sha256Hex(state));
    const login: Login = { state, challenge, issuedAt: Date.now() };
    sessionStorage.setItem(LOGIN_KEY, JSON.stringify(login));
  }
  const google = await loadGoogleIdentity();
  google.initialize({
    client_id: request.clientId,
    nonce: challenge.nonce,
    auto_select: true,
    cancel_on_tap_outside: false,
    use_fedcm_for_prompt: true,
    itp_support: true,
    callback: (response: GoogleCredentialResponse) => {
      if (acceptCredential(response.credential, challenge.nonce, request.clientId)) request.onCredential();
    },
  });
  if (request.button) {
    request.button.replaceChildren();
    google.renderButton(request.button, {
      type: "standard",
      theme: "outline",
      size: "large",
      text: "continue_with",
      shape: "rectangular",
      logo_alignment: "left",
      width: 300,
    });
  }
  if (request.prompt) google.prompt();
}

/** If the credential in hand answers a challenge issued moments ago, confirm it with the accounts API once. This
 * creates or links the Prospectus Person for this Google account and grants no workspace or product access.
 */
export async function enrollIfFresh(
  accountsBffUrl: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<boolean> {
  const login = read<Login>(LOGIN_KEY);
  const idToken = getIdToken(now);
  const claims = idToken ? decodeClaims(idToken) : null;
  if (
    !login ||
    !idToken ||
    claims?.nonce !== login.challenge.nonce ||
    now - login.issuedAt > CHALLENGE_LIFETIME_MS
  )
    return false;
  const response = await fetcher(`${accountsBffUrl.replace(/\/$/, "")}/identity/resolve`, {
    method: "POST",
    cache: "no-store",
    redirect: "error",
    headers: { authorization: `Bearer ${idToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      ...(login.challenge.challengeToken
        ? { challengeToken: login.challenge.challengeToken }
        : { challengeId: login.challenge.challengeId }),
      loginState: login.state,
    }),
  });
  sessionStorage.removeItem(LOGIN_KEY);
  return response.ok;
}

export function signOutOfPortal(): void {
  clearPortalSession();
  try {
    window.google?.accounts?.id.disableAutoSelect();
    window.google?.accounts?.id.cancel();
  } catch {
    /* Nothing to cancel. */
  }
}
