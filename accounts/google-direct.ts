import { createHash, createPublicKey, verify, type JsonWebKey } from "node:crypto";
import { fail } from "./model";
import type { ProductRegistration } from "./auth";

/** Google's OpenID issuer as it appears in the Person key and in aliases. */
export const GOOGLE_ISSUER = "https://accounts.google.com";
const GOOGLE_ISSUERS = [GOOGLE_ISSUER, "accounts.google.com"];
export const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
export const GOOGLE_DIRECT_POLICY = "google-direct-v1";
/** Public OAuth client IDs look like `<digits>-<token>.apps.googleusercontent.com`; this is not a secret. */
export const GOOGLE_CLIENT_ID_PATTERN = /^[0-9]{6,20}-[a-z0-9]{1,64}\.apps\.googleusercontent\.com$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
const GOOGLE_USER_ID_PATTERN = /^[\x21-\x7e]{1,255}$/;
const MAXIMUM_TOKEN_LIFETIME_SECONDS = 7200;
const SKEW_SECONDS = 30;
const MINIMUM_KEY_CACHE_MS = 5 * 60_000;
const MAXIMUM_KEY_CACHE_MS = 24 * 3600_000;
const UNKNOWN_KID_REFETCH_MS = 60_000;

export const isGoogleDirect = (registration: Pick<ProductRegistration, "googleFederation">) =>
  registration.googleFederation?.policy === GOOGLE_DIRECT_POLICY;

/** Google's published signing keys, cached for the lifetime Google states, and refetched at most once a minute for an
 * unknown key ID. Only RSA signature keys are used and the response is size- and count-bounded.
 */
export class GoogleKeys {
  private keys: JsonWebKey[] = [];
  private expires = 0;
  private fetchedAt = -Infinity;
  constructor(
    private fetcher: typeof fetch = fetch,
    private clock: () => number = Date.now,
  ) {}
  async resolve(issuer: string, kid: string): Promise<JsonWebKey> {
    if (issuer !== GOOGLE_ISSUER) fail(401, "issuer", "Unsupported identity authority.");
    const now = this.clock();
    const stale = this.expires < now;
    const unknown = !this.keys.some((key) => key.kid === kid);
    if (stale || (unknown && now - this.fetchedAt >= UNKNOWN_KID_REFETCH_MS)) await this.refresh(now);
    const key = this.keys.find(
      (candidate) =>
        candidate.kid === kid &&
        candidate.kty === "RSA" &&
        candidate.use === "sig" &&
        candidate.alg === "RS256",
    );
    if (!key) fail(401, "keys", "Signing key unavailable.");
    return key;
  }
  private async refresh(now: number) {
    const response = await this.fetcher(GOOGLE_CERTS_URL, {
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    const text = await response.text();
    if (!response.ok || text.length > 64000) fail(401, "keys", "Identity keys unavailable.");
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed.keys) || parsed.keys.length > 10) fail(401, "keys", "Invalid identity keys.");
    const maxAge = Number(/max-age=(\d+)/.exec(response.headers.get("cache-control") ?? "")?.[1]);
    const lifetime = Number.isFinite(maxAge) ? maxAge * 1000 : MINIMUM_KEY_CACHE_MS;
    this.keys = parsed.keys;
    this.fetchedAt = now;
    this.expires = now + Math.min(MAXIMUM_KEY_CACHE_MS, Math.max(MINIMUM_KEY_CACHE_MS, lifetime));
  }
}

export type GoogleKeyResolver = (issuer: string, kid: string) => Promise<JsonWebKey>;

/** Verify a Google ID token for a google-direct registration. Returns claims only when every check passes:
 * RS256 signature from Google's published keys, issuer, exact single audience (the registered client), `azp`, expiry,
 * issue time, not-before, a verified email, a bounded subject and a well-formed nonce.
 * Freshness against a challenge is a separate, enrollment-only check.
 */
export async function googleIdTokenClaims(
  token: string | undefined,
  registration: ProductRegistration,
  keys: GoogleKeyResolver,
  now = Date.now() / 1000,
): Promise<Record<string, any>> {
  if (!token || token.length > 16384) fail(401, "human_required", "Verified identity evidence is required.");
  try {
    if (!isGoogleDirect(registration) || registration.issuer !== GOOGLE_ISSUER) throw new Error();
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (
      header.alg !== "RS256" ||
      typeof header.kid !== "string" ||
      header.kid.length > 128 ||
      header.jku ||
      header.jwk ||
      header.x5u ||
      header.x5c ||
      header.crit
    )
      throw new Error();
    const client = registration.googleFederation!.clientId;
    if (
      !GOOGLE_ISSUERS.includes(claims.iss) ||
      claims.aud !== client ||
      !registration.clientIds.includes(client) ||
      (claims.azp !== undefined && claims.azp !== client) ||
      claims.email_verified !== true ||
      typeof claims.sub !== "string" ||
      !GOOGLE_USER_ID_PATTERN.test(claims.sub) ||
      typeof claims.nonce !== "string" ||
      !NONCE_PATTERN.test(claims.nonce) ||
      !Number.isFinite(claims.exp) ||
      claims.exp <= now ||
      !Number.isFinite(claims.iat) ||
      claims.iat > now + SKEW_SECONDS ||
      claims.iat > claims.exp ||
      claims.exp - claims.iat > MAXIMUM_TOKEN_LIFETIME_SECONDS ||
      (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + SKEW_SECONDS))
    )
      throw new Error();
    const key = await keys(GOOGLE_ISSUER, header.kid);
    if (
      !verify(
        "RSA-SHA256",
        Buffer.from(`${parts[0]}.${parts[1]}`),
        createPublicKey({ key, format: "jwk" }),
        Buffer.from(parts[2], "base64url"),
      )
    )
      throw new Error();
    return claims;
  } catch {
    fail(401, "invalid_human", "Identity evidence could not be verified.");
  }
}

/** Session evidence for a Google-direct token. There is no Cognito login family, so the token's issue time and a
 * digest of its nonce stand in for `auth_time` and `origin_jti`.
 */
export const googleDirectSession = (claims: Record<string, any>) => ({
  clientId: claims.aud as string,
  authTime: claims.iat as number,
  lineageHash: createHash("sha256").update(JSON.stringify(claims.nonce)).digest("hex"),
});
