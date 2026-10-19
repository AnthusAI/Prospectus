import { createHash, randomBytes, randomUUID } from "node:crypto";
import { caller, cognitoClaims, type KeyResolver, type ProductRegistration, type RestEvent } from "./auth";
import type { ValidatedRegistrations } from "./registration";
import { jsonResponse, parseJsonRequest } from "./request";
import { AccountsError, fail, UUID_PATTERN, type Person } from "./model";
import { issueChallengeToken, verifyChallengeToken, type ChallengeMacSigner } from "./challenge-token";
import { failWith, matchesStringPattern, requireRules, rule, type ValidationRule } from "./validation-rules";

export const GOOGLE_ISSUER = "https://accounts.google.com";
export const GOOGLE_CHALLENGE_SECONDS = 300;
const IDENTITY_REQUEST_MAXIMUM_BODY_BYTES = 4096;
const LOGIN_STATE_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const CHALLENGE_TOKEN_PATTERN = /^v1\.[A-Za-z0-9_-]{1,1500}\.[A-Za-z0-9_-]{1,100}$/;
const LOGIN_STATE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");
const MAXIMUM_ORIGIN_JTI_LENGTH = 256;
const MAXIMUM_NONCE_LENGTH = 256;
const ALLOWED_CLOCK_SKEW_SECONDS = 30;
const GOOGLE_USER_ID_PATTERN = /^[\x21-\x7e]{1,255}$/;
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
  loginStateDigest?: string;
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
  loginStateDigest?: string;
  challenge?: LoginChallenge;
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
function principalIsBoundToProduct(registration: ProductRegistration, principal: string) {
  return principal === registration.roleArn || principal === registration.executionDelegation?.roleArn;
}

export function enrollmentBinding(registration: ProductRegistration, principal: string): IdentityBinding {
  const policy = registration.googleFederation;
  if (!policy) fail(403, "federation_policy", "A reviewed Google federation policy is required.");
  if (policy.policy !== "google-only-unlinked-v1")
    fail(403, "federation_policy", "Google-only unlinked federation is required.");
  if (!policy.reviewedPolicyId)
    fail(403, "federation_policy", "A reviewed federation policy identifier is required.");
  if (!registration.clientIds.includes(policy.clientId))
    fail(403, "federation_policy", "The federation client is not registered for this product.");
  // Continuation reads the original binding without rewriting provenance.
  if (!principalIsBoundToProduct(registration, principal))
    fail(403, "caller_forbidden", "Principal is not bound to this product.");
  return {
    product: registration.product,
    principal: registration.roleArn,
    issuer: registration.issuer,
    clientId: policy.clientId,
    policyRevision: policy.reviewedPolicyId,
  };
}
export const sameLoginState = (challenge: LoginChallenge, proof: GoogleAssociation) =>
  challenge.loginStateDigest === proof.loginStateDigest;
export const sameBinding = (binding: IdentityBinding, otherBinding: IdentityBinding) =>
  binding.product === otherBinding.product &&
  binding.principal === otherBinding.principal &&
  binding.issuer === otherBinding.issuer &&
  binding.clientId === otherBinding.clientId &&
  binding.policyRevision === otherBinding.policyRevision;

type Claims = Record<string, any>;

interface SessionEvidence {
  access: Claims;
  now: number;
}

interface LoginEvidence extends SessionEvidence {
  id: Claims;
}

const loginTimeIsNumeric = rule<SessionEvidence>(
  ({ access }) => Number.isFinite(access.auth_time),
  "The access token must carry a login time.",
);
const loginTimeIsNotInTheFuture = rule<SessionEvidence>(
  ({ access, now }) => !(access.auth_time > now + ALLOWED_CLOCK_SKEW_SECONDS),
  "The login time must not be in the future.",
);
const originTokenIdIsString = rule<SessionEvidence>(
  ({ access }) => typeof access.origin_jti === "string",
  "The access token must carry an origin token ID.",
);
const originTokenIdIsNotEmpty = rule<SessionEvidence>(
  ({ access }) => !!access.origin_jti,
  "The access token origin token ID must not be empty.",
);

const sessionEvidenceRules: ValidationRule<SessionEvidence>[] = [
  loginTimeIsNumeric,
  loginTimeIsNotInTheFuture,
  originTokenIdIsString,
  originTokenIdIsNotEmpty,
];

const loginEvidenceRules: ValidationRule<LoginEvidence>[] = [
  rule(
    ({ access, id }) => access.sub === id.sub,
    "The access and ID tokens must belong to the same subject.",
  ),
  rule(
    ({ access, id }) => access.client_id === id.aud,
    "The access token client must match the ID token audience.",
  ),
  loginTimeIsNumeric,
  rule(
    ({ access, id }) => access.auth_time === id.auth_time,
    "The access and ID tokens must carry the same login time.",
  ),
  loginTimeIsNotInTheFuture,
  rule(
    ({ access, id }) => !(access.auth_time > Math.min(access.iat, id.iat) + ALLOWED_CLOCK_SKEW_SECONDS),
    "The login time must not be later than the tokens were issued.",
  ),
  rule(
    ({ access, now }) => !(now - access.auth_time > GOOGLE_CHALLENGE_SECONDS),
    "The login is older than the challenge window.",
  ),
  originTokenIdIsString,
  originTokenIdIsNotEmpty,
  rule(
    ({ access }) => !(access.origin_jti.length > MAXIMUM_ORIGIN_JTI_LENGTH),
    "The access token origin token ID is too long.",
  ),
  rule(
    ({ access, id }) => access.origin_jti === id.origin_jti,
    "The access and ID tokens must share one origin token ID.",
  ),
  rule(({ id }) => typeof id.nonce === "string", "The ID token must carry the challenge nonce."),
  rule(({ id }) => !(id.nonce.length > MAXIMUM_NONCE_LENGTH), "The ID token nonce is too long."),
];

const googleIdentityRules: ValidationRule<unknown>[] = [
  rule((identities) => Array.isArray(identities), "The ID token must list its linked identities."),
  rule((identities) => (identities as any[]).length === 1, "Exactly one linked identity is required."),
  rule((identities) => !!(identities as any[])[0], "The linked identity must be an object."),
  rule(
    (identities) => (identities as any[])[0].providerName === "Google",
    "The linked identity provider name must be Google.",
  ),
  rule(
    (identities) => (identities as any[])[0].providerType === "Google",
    "The linked identity provider type must be Google.",
  ),
  rule(
    (identities) => typeof (identities as any[])[0].userId === "string",
    "The linked Google user ID must be a string.",
  ),
  rule(
    (identities) => matchesStringPattern((identities as any[])[0].userId, GOOGLE_USER_ID_PATTERN),
    "The linked Google user ID must be 1 to 255 printable characters.",
  ),
];
const challengeRequestRules: ValidationRule<Record<string, any>>[] = [
  rule(
    (body) => Object.keys(body).every((key) => key === "loginStateDigest"),
    "No authority fields are accepted.",
  ),
  rule(
    (body) => body.loginStateDigest === undefined || typeof body.loginStateDigest === "string",
    "The login state digest must be a string.",
  ),
  rule(
    (body) =>
      body.loginStateDigest === undefined ||
      matchesStringPattern(body.loginStateDigest, LOGIN_STATE_DIGEST_PATTERN),
    "The login state digest must be lowercase SHA-256 hexadecimal.",
  ),
];

const resolveRequestRules: ValidationRule<Record<string, any>>[] = [
  rule(
    (body) => Object.keys(body).every((key) => ["challengeId", "challengeToken", "loginState"].includes(key)),
    "Only a challenge reference and login state are accepted.",
  ),
  rule(
    (body) => (body.challengeId === undefined) !== (body.challengeToken === undefined),
    "Exactly one of a challenge ID or a challenge token is required.",
  ),
  rule(
    (body) => body.challengeId === undefined || matchesStringPattern(body.challengeId, UUID_PATTERN),
    "The challenge ID must be a UUID.",
  ),
  rule(
    (body) =>
      body.challengeToken === undefined || matchesStringPattern(body.challengeToken, CHALLENGE_TOKEN_PATTERN),
    "The challenge token must be a versioned base64url token.",
  ),
  rule(
    (body) => body.loginState === undefined || typeof body.loginState === "string",
    "The login state must be a string.",
  ),
  rule(
    (body) => body.loginState === undefined || matchesStringPattern(body.loginState, LOGIN_STATE_PATTERN),
    "The login state is malformed.",
  ),
];
/** Fixed central transport: caller is IAM verified, JWTs stay in signed headers.
 * The BFF puts the returned nonce in its code+PKCE authorize request and retains
 * independent state. A new login needs a new challenge; refresh never enrolls.
 */
export function googleIdentityHandler(
  repository: GoogleIdentityRepository,
  products: ValidatedRegistrations,
  keys: KeyResolver,
  nowSeconds = () => Math.floor(Date.now() / 1000),
  challengeSigner?: ChallengeMacSigner,
) {
  return async (event: RestEvent) => {
    try {
      const authenticated = caller(event, products);
      const scope = enrollmentBinding(authenticated.registration, authenticated.principal);
      const now = nowSeconds();
      const { headers, body } = parseJsonRequest(event, IDENTITY_REQUEST_MAXIMUM_BODY_BYTES);
      if (event.path === "/v1/identities/google/challenge" && event.httpMethod === "POST") {
        requireRules(
          body,
          challengeRequestRules,
          failWith(400, "fields", "The challenge request is invalid"),
        );
        // Public challenge timestamps are integer Unix seconds even when the
        // production composition supplies a subsecond freshness clock.
        const issuedAt = Math.floor(now);
        const challenge: LoginChallenge = {
          challengeId: randomUUID(),
          nonce: randomBytes(32).toString("base64url"),
          issuedAt,
          expiresAt: issuedAt + GOOGLE_CHALLENGE_SECONDS,
          binding: scope,
          ...(body.loginStateDigest ? { loginStateDigest: body.loginStateDigest } : {}),
        };
        const challengeToken = challengeSigner
          ? await issueChallengeToken(challengeSigner, challenge)
          : undefined;
        if (!challengeToken) await repository.issue(challenge);
        return jsonResponse(200, {
          challengeId: challenge.challengeId,
          nonce: challenge.nonce,
          expiresAt: challenge.expiresAt,
          ...(challengeToken ? { challengeToken } : {}),
        });
      }
      if (event.path === "/v1/identities/google/resolve" && event.httpMethod === "POST") {
        requireRules(body, resolveRequestRules, failWith(400, "fields", "The resolve request is invalid"));
        const registration = { ...authenticated.registration, clientIds: [scope.clientId] };
        const [access, id] = await Promise.all([
          cognitoClaims(headers["x-prospectus-human-token"], registration, keys, "access", now),
          cognitoClaims(headers["x-prospectus-identity-token"], registration, keys, "id", now),
        ]);
        requireRules(
          { access, id, now },
          loginEvidenceRules,
          failWith(401, "session_binding", "Fresh matching login evidence is required"),
        );
        const identities = id.identities;
        requireRules(
          identities,
          googleIdentityRules,
          failWith(401, "google_identity", "One unambiguous trusted Google identity is required"),
        );
        const signedChallenge =
          body.challengeToken === undefined
            ? undefined
            : challengeSigner
              ? await verifyChallengeToken(challengeSigner, body.challengeToken)
              : fail(401, "challenge_invalid", "Signed challenges are not accepted by this service.");
        const person = await repository.associate({
          challengeId: signedChallenge?.challengeId ?? body.challengeId,
          ...(signedChallenge ? { challenge: signedChallenge } : {}),
          nonce: id.nonce,
          fingerprint: digest([headers["x-prospectus-human-token"], headers["x-prospectus-identity-token"]]),
          binding: scope,
          cognitoSubject: id.sub,
          googleSubject: identities[0].userId,
          authTime: access.auth_time,
          lineageHash: digest(access.origin_jti),
          now,
          ...(body.loginState ? { loginStateDigest: sha256Hex(body.loginState) } : {}),
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
        requireRules(
          { access, now },
          sessionEvidenceRules,
          failWith(401, "session_binding", "Human session evidence required"),
        );
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
