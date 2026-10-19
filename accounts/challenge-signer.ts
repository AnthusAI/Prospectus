import { createHmac, timingSafeEqual } from "node:crypto";
import { GenerateMacCommand, KMSClient, VerifyMacCommand } from "@aws-sdk/client-kms";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { matchesStringPattern } from "./validation-rules";

export const CHALLENGE_KEY_ID_PATTERN = /^[a-z0-9]{1,16}$/;
export const CHALLENGE_PARAMETER_PREFIX_PATTERN = /^\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*\/$/;
export const KMS_CHALLENGE_KEY_ID = "kms";
export const MINIMUM_CHALLENGE_SECRET_BYTES = 32;
export const CHALLENGE_SECRET_CACHE_MILLISECONDS = 15 * 60 * 1000;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** Signs with the current key and verifies with the current key or, during a rotation, the previous one. */
export interface ChallengeSigner {
  currentKeyId: string;
  sign(bytes: Uint8Array): Promise<Buffer>;
  verify(keyId: string, bytes: Uint8Array, mac: Uint8Array): Promise<boolean>;
}

export type LoginChallengeSignerConfiguration =
  | { kind: "kms" }
  | { kind: "parameter-store"; parameterPrefix: string; currentKeyId: string; previousKeyId?: string };

export function loginChallengeSignerConfiguration(value: unknown): LoginChallengeSignerConfiguration {
  const candidate = value as Record<string, unknown> | null;
  if (candidate?.kind === "kms" && Object.keys(candidate).length === 1) return { kind: "kms" };
  if (
    candidate?.kind === "parameter-store" &&
    Object.keys(candidate).every((key) =>
      ["kind", "parameterPrefix", "currentKeyId", "previousKeyId"].includes(key),
    ) &&
    matchesStringPattern(candidate.parameterPrefix, CHALLENGE_PARAMETER_PREFIX_PATTERN) &&
    matchesStringPattern(candidate.currentKeyId, CHALLENGE_KEY_ID_PATTERN) &&
    (candidate.previousKeyId === undefined ||
      (matchesStringPattern(candidate.previousKeyId, CHALLENGE_KEY_ID_PATTERN) &&
        candidate.previousKeyId !== candidate.currentKeyId))
  )
    return {
      kind: "parameter-store",
      parameterPrefix: candidate.parameterPrefix as string,
      currentKeyId: candidate.currentKeyId as string,
      ...(candidate.previousKeyId ? { previousKeyId: candidate.previousKeyId as string } : {}),
    };
  throw new Error("The login challenge signer must be a reviewed kms or parameter-store configuration.");
}

export const challengeParameterName = (
  configuration: Extract<LoginChallengeSignerConfiguration, { kind: "parameter-store" }>,
  keyId: string,
) => `${configuration.parameterPrefix}${keyId}`;

/** One AWS KMS HMAC_256 key. The Lambda holds only GenerateMac and VerifyMac on it. */
export class KmsChallengeSigner implements ChallengeSigner {
  readonly currentKeyId = KMS_CHALLENGE_KEY_ID;
  constructor(
    private keyId: string,
    private client: Pick<KMSClient, "send"> = new KMSClient({ region: "us-east-1" }),
  ) {}
  async sign(bytes: Uint8Array) {
    const result = await this.client.send(
      new GenerateMacCommand({ KeyId: this.keyId, Message: bytes, MacAlgorithm: "HMAC_SHA_256" }),
    );
    if (!result.Mac) throw new Error("The challenge MAC was not produced.");
    return Buffer.from(result.Mac);
  }
  async verify(keyId: string, bytes: Uint8Array, mac: Uint8Array) {
    if (keyId !== KMS_CHALLENGE_KEY_ID) return false;
    try {
      const result = await this.client.send(
        new VerifyMacCommand({ KeyId: this.keyId, Message: bytes, Mac: mac, MacAlgorithm: "HMAC_SHA_256" }),
      );
      return result.MacValid === true;
    } catch (error) {
      if ((error as { name?: string }).name === "KMSInvalidMacException") return false;
      throw error;
    }
  }
}

export const hmacSha256 = (secret: Uint8Array, bytes: Uint8Array) =>
  createHmac("sha256", secret).update(bytes).digest();

export function macsAreEqual(expected: Uint8Array, presented: Uint8Array) {
  return expected.length === presented.length && timingSafeEqual(expected, presented);
}

/** HMAC-SHA-256 in process with a secret held in an SSM SecureString (aws/ssm key) and cached for a bounded time.
 * Any failure to obtain a secret of at least 32 bytes throws, so signing fails closed. The secret and the MAC are never logged.
 */
export class ParameterStoreChallengeSigner implements ChallengeSigner {
  readonly currentKeyId: string;
  private cache = new Map<string, { secret: Buffer; loadedAt: number }>();
  constructor(
    private configuration: Extract<LoginChallengeSignerConfiguration, { kind: "parameter-store" }>,
    private client: Pick<SSMClient, "send"> = new SSMClient({ region: "us-east-1" }),
    private now: () => number = Date.now,
    private cacheMilliseconds = CHALLENGE_SECRET_CACHE_MILLISECONDS,
  ) {
    this.currentKeyId = configuration.currentKeyId;
  }
  private async secret(keyId: string) {
    const cached = this.cache.get(keyId);
    if (cached && this.now() - cached.loadedAt < this.cacheMilliseconds) return cached.secret;
    this.cache.delete(keyId);
    const result = await this.client.send(
      new GetParameterCommand({
        Name: challengeParameterName(this.configuration, keyId),
        WithDecryption: true,
      }),
    );
    const value = result.Parameter?.Value;
    if (typeof value !== "string" || !matchesStringPattern(value, BASE64_PATTERN))
      throw new Error("The challenge secret parameter is missing or is not base64.");
    const secret = Buffer.from(value, "base64");
    if (secret.length < MINIMUM_CHALLENGE_SECRET_BYTES)
      throw new Error("The challenge secret is shorter than 32 bytes.");
    this.cache.set(keyId, { secret, loadedAt: this.now() });
    return secret;
  }
  async sign(bytes: Uint8Array) {
    return hmacSha256(await this.secret(this.currentKeyId), bytes);
  }
  async verify(keyId: string, bytes: Uint8Array, mac: Uint8Array) {
    if (keyId !== this.configuration.currentKeyId && keyId !== this.configuration.previousKeyId) return false;
    return macsAreEqual(hmacSha256(await this.secret(keyId), bytes), mac);
  }
}

export function challengeSignerFromConfiguration(
  configuration: LoginChallengeSignerConfiguration,
  kmsKeyArn?: string,
): ChallengeSigner {
  if (configuration.kind === "kms") {
    if (!matchesStringPattern(kmsKeyArn, /^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key\/[a-f0-9-]{36}$/))
      throw new Error("The kms challenge signer requires its key ARN.");
    return new KmsChallengeSigner(kmsKeyArn as string);
  }
  return new ParameterStoreChallengeSigner(configuration);
}
