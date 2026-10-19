import { CHALLENGE_KEY_ID_PATTERN, type ChallengeSigner } from "./challenge-signer";
import { fail, UUID_PATTERN } from "./model";
import type { LoginChallenge } from "./google-identity";
import { failWith, matchesStringPattern, requireRules, rule, type ValidationRule } from "./validation-rules";

export const CHALLENGE_TOKEN_VERSION = "v1";
export const CHALLENGE_TOKEN_MAXIMUM_LENGTH = 2048;
const CHALLENGE_TOKEN_DOMAIN = "prospectus-login-challenge-v1";
const CHALLENGE_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** The signed payload is a fixed-position JSON array, so key order and whitespace cannot vary. */
const payloadOf = (challenge: LoginChallenge) =>
  JSON.stringify([
    CHALLENGE_TOKEN_DOMAIN,
    challenge.challengeId,
    challenge.nonce,
    challenge.issuedAt,
    challenge.expiresAt,
    challenge.loginStateDigest ?? "",
    challenge.binding.product,
    challenge.binding.principal,
    challenge.binding.issuer,
    challenge.binding.clientId,
    challenge.binding.policyRevision,
  ]);

const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

export async function issueChallengeToken(signer: ChallengeSigner, challenge: LoginChallenge) {
  const payload = new TextEncoder().encode(payloadOf(challenge));
  const mac = await signer.sign(payload);
  return `${CHALLENGE_TOKEN_VERSION}.${signer.currentKeyId}.${encode(payload)}.${encode(mac)}`;
}

const isText = (value: unknown, maximumLength: number) =>
  typeof value === "string" && value.length > 0 && value.length <= maximumLength;

const payloadRules: ValidationRule<unknown[]>[] = [
  rule((fields) => fields.length === 11, "The challenge payload must have eleven fields."),
  rule((fields) => fields[0] === CHALLENGE_TOKEN_DOMAIN, "The challenge payload has the wrong domain."),
  rule((fields) => matchesStringPattern(fields[1], UUID_PATTERN), "The challenge ID must be a UUID."),
  rule((fields) => isText(fields[2], 256), "The challenge nonce must be present."),
  rule(
    (fields) => Number.isSafeInteger(fields[3]) && Number.isSafeInteger(fields[4]),
    "The challenge times must be integers.",
  ),
  rule(
    (fields) => fields[5] === "" || matchesStringPattern(fields[5], CHALLENGE_DIGEST_PATTERN),
    "The login state digest must be empty or lowercase SHA-256 hexadecimal.",
  ),
  rule(
    (fields) => fields.slice(6).every((field) => isText(field, 512)),
    "The challenge binding fields must be present.",
  ),
];

const invalid = failWith(401, "challenge_invalid", "The challenge token is not valid");

/** Verifies the MAC before the payload is interpreted. Expiry, nonce, binding and login state are
 * checked by the repository exactly as for a stored challenge.
 */
export async function verifyChallengeToken(signer: ChallengeSigner, token: string): Promise<LoginChallenge> {
  const parts = token.split(".");
  requireRules(
    { token, parts },
    [
      rule(({ token }) => token.length <= CHALLENGE_TOKEN_MAXIMUM_LENGTH, "The token is too long."),
      rule(({ parts }) => parts.length === 4, "The token must have four parts."),
      rule(({ parts }) => parts[0] === CHALLENGE_TOKEN_VERSION, "The token version is not supported."),
      rule(
        ({ parts }) => matchesStringPattern(parts[1], CHALLENGE_KEY_ID_PATTERN),
        "The token key ID is malformed.",
      ),
      rule(
        ({ parts }) => matchesStringPattern(parts[2], BASE64_URL_PATTERN),
        "The token payload is not base64url.",
      ),
      rule(
        ({ parts }) => matchesStringPattern(parts[3], BASE64_URL_PATTERN),
        "The token MAC is not base64url.",
      ),
    ],
    invalid,
  );
  const payload = Buffer.from(parts[2], "base64url");
  if (!(await signer.verify(parts[1], payload, Buffer.from(parts[3], "base64url"))))
    fail(401, "challenge_invalid", "The challenge token is not valid: its MAC does not verify.");
  let fields: unknown;
  try {
    fields = JSON.parse(payload.toString("utf8"));
  } catch {
    fail(401, "challenge_invalid", "The challenge token is not valid: the payload is not JSON.");
  }
  requireRules(
    fields as unknown[],
    [rule((value) => Array.isArray(value), "The challenge payload must be an array."), ...payloadRules],
    invalid,
  );
  const [
    ,
    challengeId,
    nonce,
    issuedAt,
    expiresAt,
    loginStateDigest,
    product,
    principal,
    issuer,
    clientId,
    policyRevision,
  ] = fields as [string, string, string, number, number, string, string, string, string, string, string];
  return {
    challengeId,
    nonce,
    issuedAt,
    expiresAt,
    binding: { product, principal, issuer, clientId, policyRevision },
    ...(loginStateDigest ? { loginStateDigest } : {}),
  };
}
