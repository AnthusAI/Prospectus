import { isCognitoIssuer } from "./validation-rules";
import { createHash, createPublicKey, verify, type JsonWebKey } from "node:crypto";
import { fail, UUID_PATTERN, type Context, type Human, type Operation } from "./model";
import type { ValidatedRegistrations } from "./registration";
import { lowerCaseHeaders } from "./request";
import { labVerifierOf, siteForToken, type LabVerifier } from "./lab-verifier";
import { GOOGLE_ISSUER, googleDirectSession, googleIdTokenClaims, isGoogleDirect } from "./google-direct";
export interface ExecutionDelegation {
  roleArn: string;
  enrollmentRoleArn: string;
  issuer: string;
  clientId: string;
  enrollmentPolicyRevision: string;
  reviewedPolicyId: string;
}
export interface ProductRegistration {
  product: string;
  roleArn: string;
  issuer: string;
  clientIds: string[];
  capabilities: Operation[];
  enabled: boolean;
  accountDirectory?: true;
  /** A Papyrus site that only signs readers in: no capabilities, no directory, no delegation. */
  audience?: "public-reader";
  googleFederation?: {
    policy: "google-only-unlinked-v1" | "google-direct-v1";
    reviewedPolicyId: string;
    clientId: string;
  };
  executionDelegation?: ExecutionDelegation;
  /** Absent for every product except a public-reader Papyrus site, which receives pairwise site subjects only. */
  audience?: "public-reader";
}
export interface RestEvent {
  httpMethod: string;
  path: string;
  headers?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
  queryStringParameters?: Record<string, string | undefined> | null;
  multiValueQueryStringParameters?: Record<string, string[] | undefined> | null;
  requestContext?: { identity?: { userArn?: string; accountId?: string }; stage?: string };
}
export type VerifiedCaller =
  | {
      registration: ProductRegistration;
      principal: string;
      authority: "enrollment" | "execution";
      verifier?: undefined;
    }
  | { registration?: undefined; principal: string; authority: "verification"; verifier: LabVerifier };
const roleOf = (arn: string | undefined) =>
  /^arn:aws:iam::(\d{12}):role\/(?:[^/]+\/)*([^/]+)$/.exec(arn ?? "");
/** Session continuation and verification may check one enrolled session and one account decision, nothing else. */
function sessionChecksOnly(event: RestEvent, code: string, message: string) {
  const account = /^\/v1\/accounts\/([a-f0-9-]{36})\/authorize$/.exec(event.path);
  if (
    !(
      (event.httpMethod === "GET" && event.path === "/v1/identities/me") ||
      (event.httpMethod === "POST" && account && UUID_PATTERN.test(account[1]))
    )
  )
    fail(403, code, message);
}
export function caller(event: RestEvent, products: ValidatedRegistrations): VerifiedCaller {
  const callerArn = event.requestContext?.identity?.userArn;
  const accountId = event.requestContext?.identity?.accountId;
  const session = /^arn:aws:sts::(\d{12}):assumed-role\/([^/]+)\/[^/]+$/.exec(callerArn ?? "");
  if (!session || session[1] !== accountId)
    fail(403, "caller_forbidden", "A registered temporary runtime role is required.");
  for (const registration of products) {
    if (!registration.enabled) continue;
    for (const [authority, principal] of [
      ["enrollment", registration.roleArn],
      ["execution", registration.executionDelegation?.roleArn],
    ] as const) {
      const role = roleOf(principal);
      if (role?.[1] !== session[1] || role[2] !== session[2]) continue;
      if (authority === "execution")
        sessionChecksOnly(
          event,
          "execution_route_forbidden",
          "Execution principal may only check its enrolled session and current account authorization.",
        );
      return { registration, principal: principal!, authority };
    }
  }
  const verifier = labVerifierOf(products);
  const verifierRole = roleOf(verifier?.roleArn);
  if (verifier && verifierRole?.[1] === session[1] && verifierRole[2] === session[2]) {
    sessionChecksOnly(
      event,
      "verifier_route_forbidden",
      "The lab verifier may only check a Papyrus editor's session and current account authorization.",
    );
    return { principal: verifier.roleArn, authority: "verification", verifier };
  }
  fail(403, "caller_forbidden", "Calling product is not registered.");
}
export type KeyResolver = (issuer: string, kid: string) => Promise<JsonWebKey>;
export class CognitoKeys {
  private cache = new Map<string, { expires: number; keys: JsonWebKey[] }>();
  async resolve(issuer: string, kid: string): Promise<JsonWebKey> {
    if (!isCognitoIssuer(issuer)) fail(401, "issuer", "Unsupported identity authority.");
    let cached = this.cache.get(issuer);
    if (!cached || cached.expires < Date.now() || !cached.keys.some((key) => key.kid === kid)) {
      const response = await fetch(`${issuer}/.well-known/jwks.json`, {
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
      const text = await response.text();
      if (!response.ok || text.length > 64000) fail(401, "keys", "Identity keys unavailable.");
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed.keys) || parsed.keys.length > 10) fail(401, "keys", "Invalid identity keys.");
      cached = { expires: Date.now() + 300000, keys: parsed.keys };
      this.cache.set(issuer, cached);
    }
    const key = cached.keys.find(
      (key) => key.kid === kid && key.kty === "RSA" && key.use === "sig" && key.alg === "RS256",
    );
    if (!key) fail(401, "keys", "Signing key unavailable.");
    return key;
  }
}
/** Verify each Cognito token independently; no caller-supplied keys or issuers. */
export async function cognitoClaims(
  token: string | undefined,
  registration: ProductRegistration,
  keys: KeyResolver,
  purpose: "access" | "id",
  now = Date.now() / 1000,
): Promise<Record<string, any>> {
  if (!token || token.length > 16384) fail(401, "human_required", "Verified identity evidence is required.");
  try {
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
      header.crit
    )
      throw new Error();
    const client = purpose === "id" ? claims.aud : claims.client_id;
    if (
      claims.iss !== registration.issuer ||
      typeof client !== "string" ||
      !registration.clientIds.includes(client) ||
      claims.token_use !== purpose ||
      typeof claims.sub !== "string" ||
      !claims.sub ||
      claims.sub.length > 256 ||
      !Number.isFinite(claims.exp) ||
      claims.exp <= now ||
      !Number.isFinite(claims.iat) ||
      claims.iat > now + 30 ||
      claims.iat > claims.exp ||
      (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now))
    )
      throw new Error();
    const key = await keys(registration.issuer, header.kid);
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
export async function human(
  token: string | undefined,
  registration: ProductRegistration,
  keys: KeyResolver,
  now = Date.now() / 1000,
  maxAuthAge?: number,
): Promise<Human> {
  if (isGoogleDirect(registration)) {
    const claims = await googleIdTokenClaims(token, registration, keys, now);
    return { issuer: GOOGLE_ISSUER, subject: claims.sub, session: googleDirectSession(claims) };
  }
  const claims = await cognitoClaims(token, registration, keys, "access", now);
  if (
    maxAuthAge !== undefined &&
    (!Number.isFinite(claims.auth_time) || claims.auth_time > now + 30 || now - claims.auth_time > maxAuthAge)
  )
    fail(401, "invalid_human", "Recent authentication is required.");
  return {
    issuer: claims.iss,
    subject: claims.sub,
    ...(Number.isFinite(claims.auth_time) &&
    typeof claims.origin_jti === "string" &&
    claims.origin_jti &&
    claims.origin_jti.length <= 256
      ? {
          session: {
            clientId: claims.client_id,
            authTime: claims.auth_time,
            lineageHash: createHash("sha256").update(JSON.stringify(claims.origin_jti)).digest("hex"),
          },
        }
      : {}),
  };
}
export async function context(
  event: RestEvent,
  products: ValidatedRegistrations,
  keys: KeyResolver,
  now = Date.now() / 1000,
): Promise<Context> {
  const authenticated = caller(event, products);
  const headers = lowerCaseHeaders(event.headers);
  if (authenticated.authority === "verification") {
    // The token only proves who the person is. It is verified against the one registered Papyrus site that issued it;
    // authority is then evaluated for the verifier's product (cyclotron), with the site's capabilities as a ceiling.
    const token = headers["x-prospectus-human-token"];
    const site = siteForToken(authenticated.verifier, token);
    return {
      product: authenticated.verifier.entitlementProduct,
      principal: authenticated.principal,
      human: await human(token, site, keys, now),
      capabilities: authenticated.verifier.capabilities.filter((operation) =>
        site.capabilities.includes(operation),
      ),
      enrollmentProduct: site.product,
    };
  }
  const identity = await human(headers["x-prospectus-human-token"], authenticated.registration, keys, now);
  const capabilities =
    authenticated.authority === "execution"
      ? authenticated.registration.capabilities.filter(
          (operation) => operation === "console:read" || operation === "console:write",
        )
      : authenticated.registration.capabilities;
  return {
    product: authenticated.registration.product,
    principal: authenticated.principal,
    human: identity,
    capabilities,
  };
}
