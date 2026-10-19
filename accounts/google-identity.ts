import { createHash, randomBytes, randomUUID } from "node:crypto";
import { caller, cognitoClaims, type KeyResolver, type ProductRegistration, type RestEvent } from "./auth";
import type { ValidatedRegistrations } from "./registration";
import { jsonResponse, parseJsonRequest } from "./request";
import { AccountsError, fail, UUID_PATTERN, type Person } from "./model";

export const GOOGLE_ISSUER = "https://accounts.google.com";
export const GOOGLE_CHALLENGE_SECONDS = 300;
const IDENTITY_REQUEST_MAXIMUM_BODY_BYTES = 1024;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface IdentityBinding {
  product: string;
  principal: string;
  issuer: string;
  clientId: string;
  policyRevision: string;
}
export interface LoginChallenge {
  challengeId: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  binding: IdentityBinding;
}
export interface GoogleAssociation {
  challengeId: string;
  nonce: string;
  fingerprint: string;
  binding: IdentityBinding;
  cognitoSubject: string;
  googleSubject: string;
  authTime: number;
  lineageHash: string;
  now: number;
}
export interface GoogleAlias {
  personId: string;
  issuer: string;
  subject: string;
  googleIssuer: typeof GOOGLE_ISSUER;
  googleSubject: string;
  createdAt: string;
  provenance: IdentityBinding[];
  sessions: Array<{ binding: IdentityBinding; authTime: number; lineageHash: string }>;
}
/** Recoverable enrollment: pending files may persist, but only a completed receipt
 * may expose a Person/session. Immutable identity reservations never overwrite
 * conflicting mappings. This is not an atomic multi-file storage transaction.
 */
export interface IdentitySession {
  binding: IdentityBinding;
  authTime: number;
  lineageHash: string;
}
export interface GoogleIdentityRepository {
  issue(challenge: LoginChallenge): Promise<void>;
  associate(proof: GoogleAssociation): Promise<Person>;
  find(
    issuer: string,
    subject: string,
    session?: IdentitySession,
  ): Promise<{ person: Person; alias: GoogleAlias } | null>;
  getPerson(id: string): Promise<Person | null>;
}
export function enrollmentBinding(registration: ProductRegistration, principal: string): IdentityBinding {
  const policy = registration.googleFederation;
  if (
    !policy ||
    policy.policy !== "google-only-unlinked-v1" ||
    !policy.reviewedPolicyId ||
    !registration.clientIds.includes(policy.clientId)
  )
    fail(403, "federation_policy", "Reviewed Google-only unlinked federation is required.");
  // Continuation reads the original binding without rewriting provenance.
  if (principal !== registration.roleArn && principal !== registration.executionDelegation?.roleArn)
    fail(403, "caller_forbidden", "Principal is not bound to this product.");
  return {
    product: registration.product,
    principal: registration.roleArn,
    issuer: registration.issuer,
    clientId: policy.clientId,
    policyRevision: policy.reviewedPolicyId,
  };
}
export const sameBinding = (a: IdentityBinding, b: IdentityBinding) =>
  a.product === b.product &&
  a.principal === b.principal &&
  a.issuer === b.issuer &&
  a.clientId === b.clientId &&
  a.policyRevision === b.policyRevision;
/** Fixed central transport: caller is IAM verified, JWTs stay in signed headers.
 * The BFF puts the returned nonce in its code+PKCE authorize request and retains
 * independent state. A new login needs a new challenge; refresh never enrolls.
 */
export function googleIdentityHandler(
  repository: GoogleIdentityRepository,
  products: ValidatedRegistrations,
  keys: KeyResolver,
  nowSeconds = () => Math.floor(Date.now() / 1000),
) {
  return async (event: RestEvent) => {
    try {
      const authenticated = caller(event, products);
      const scope = enrollmentBinding(authenticated.registration, authenticated.principal);
      const now = nowSeconds();
      const { headers, body } = parseJsonRequest(event, IDENTITY_REQUEST_MAXIMUM_BODY_BYTES);
      if (event.path === "/v1/identities/google/challenge" && event.httpMethod === "POST") {
        if (Object.keys(body).length) fail(400, "fields", "No authority fields are accepted.");
        // Public challenge timestamps are integer Unix seconds even when the
        // production composition supplies a subsecond freshness clock.
        const issuedAt = Math.floor(now);
        const challenge: LoginChallenge = {
          challengeId: randomUUID(),
          nonce: randomBytes(32).toString("base64url"),
          issuedAt,
          expiresAt: issuedAt + GOOGLE_CHALLENGE_SECONDS,
          binding: scope,
        };
        await repository.issue(challenge);
        return jsonResponse(200, {
          challengeId: challenge.challengeId,
          nonce: challenge.nonce,
          expiresAt: challenge.expiresAt,
        });
      }
      if (event.path === "/v1/identities/google/resolve" && event.httpMethod === "POST") {
        if (
          Object.keys(body).some((key) => key !== "challengeId") ||
          typeof body.challengeId !== "string" ||
          !UUID_PATTERN.test(body.challengeId)
        )
          fail(400, "fields", "Only a challenge ID is accepted.");
        const registration = { ...authenticated.registration, clientIds: [scope.clientId] };
        const [access, id] = await Promise.all([
          cognitoClaims(headers["x-prospectus-human-token"], registration, keys, "access", now),
          cognitoClaims(headers["x-prospectus-identity-token"], registration, keys, "id", now),
        ]);
        if (
          access.sub !== id.sub ||
          access.client_id !== id.aud ||
          !Number.isFinite(access.auth_time) ||
          access.auth_time !== id.auth_time ||
          access.auth_time > now + 30 ||
          access.auth_time > Math.min(access.iat, id.iat) + 30 ||
          now - access.auth_time > GOOGLE_CHALLENGE_SECONDS ||
          typeof access.origin_jti !== "string" ||
          !access.origin_jti ||
          access.origin_jti.length > 256 ||
          access.origin_jti !== id.origin_jti ||
          typeof id.nonce !== "string" ||
          id.nonce.length > 256
        )
          fail(401, "session_binding", "Fresh matching login evidence is required.");
        const identities = id.identities;
        if (
          !Array.isArray(identities) ||
          identities.length !== 1 ||
          !identities[0] ||
          identities[0].providerName !== "Google" ||
          identities[0].providerType !== "Google" ||
          typeof identities[0].userId !== "string" ||
          !/^[\x21-\x7e]{1,255}$/.test(identities[0].userId)
        )
          fail(401, "google_identity", "One unambiguous trusted Google identity is required.");
        const person = await repository.associate({
          challengeId: body.challengeId,
          nonce: id.nonce,
          fingerprint: digest([headers["x-prospectus-human-token"], headers["x-prospectus-identity-token"]]),
          binding: scope,
          cognitoSubject: id.sub,
          googleSubject: identities[0].userId,
          authTime: access.auth_time,
          lineageHash: digest(access.origin_jti),
          now,
        });
        return jsonResponse(200, { person });
      }
      if (event.path === "/v1/identities/me" && event.httpMethod === "GET") {
        if (Object.keys(body).length) fail(400, "fields", "No authority fields are accepted.");
        const access = await cognitoClaims(
          headers["x-prospectus-human-token"],
          { ...authenticated.registration, clientIds: [scope.clientId] },
          keys,
          "access",
          now,
        );
        if (
          !Number.isFinite(access.auth_time) ||
          access.auth_time > now + 30 ||
          typeof access.origin_jti !== "string" ||
          !access.origin_jti
        )
          fail(401, "session_binding", "Human session evidence required.");
        const existing = await repository.find(scope.issuer, access.sub, {
          binding: scope,
          authTime: access.auth_time,
          lineageHash: digest(access.origin_jti),
        });
        if (existing && !existing.alias.provenance.some((prior) => sameBinding(prior, scope)))
          fail(403, "reenrollment_required", "Current federation policy requires fresh enrollment.");
        if (
          existing &&
          !existing.alias.sessions.some(
            (session) =>
              sameBinding(session.binding, scope) &&
              session.authTime === access.auth_time &&
              session.lineageHash === digest(access.origin_jti),
          )
        )
          fail(401, "reenrollment_required", "This login requires a fresh identity challenge.");
        return jsonResponse(200, { person: existing?.person ?? null });
      }
      fail(404, "route", "Identity route not found.");
    } catch (error) {
      if (error instanceof AccountsError)
        return jsonResponse(error.status, { error: error.code, message: error.message });
      return jsonResponse(503, {
        error: "identity_unavailable",
        message: "Identity service unavailable; retry identical evidence before challenge expiry.",
      });
    }
  };
}
