import { createHmac, timingSafeEqual } from "node:crypto";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

/**
 * Confirmation and unsubscribe links carry a signed token, never the email address:
 *
 *   n1.<purpose>.<listId>.<subscription>.<expires>.<mac>
 *
 * purpose is "c" (confirm) or "u" (unsubscribe); subscription is the 64-hex hash that names the
 * subscription record; expires is Unix seconds, or 0 for an unsubscribe token, which never expires
 * (an unsubscribe link in an old email must keep working); mac is unpadded base64url
 * HMAC-SHA-256 over "prospectus-newsletter-token:v1\n" plus the other fields joined by "\n".
 */
export type TokenPurpose = "confirm" | "unsubscribe";
export interface NewsletterToken {
  purpose: TokenPurpose;
  listId: string;
  subscription: string;
  /** Unix seconds; 0 never expires (unsubscribe only). */
  expires: number;
}

export const CONFIRM_TOKEN_SECONDS = 7 * 24 * 60 * 60;
export const MINIMUM_TOKEN_SECRET_BYTES = 32;
const PURPOSE_CODES: Record<TokenPurpose, string> = { confirm: "c", unsubscribe: "u" };
const TOKEN =
  /^n1\.([cu])\.([a-z0-9][a-z0-9-]{1,63})\.([a-f0-9]{64})\.(0|[1-9][0-9]{0,11})\.([A-Za-z0-9_-]{43})$/;

/** Supplies the HMAC key; throws when it cannot, so signing and verifying fail closed. */
export type TokenSecret = () => Promise<Buffer>;

const mac = (secret: Buffer, token: NewsletterToken) =>
  createHmac("sha256", secret)
    .update(
      [
        "prospectus-newsletter-token:v1",
        PURPOSE_CODES[token.purpose],
        token.listId,
        token.subscription,
        String(token.expires),
      ].join("\n"),
    )
    .digest("base64url");

export async function signToken(secret: TokenSecret, token: NewsletterToken): Promise<string> {
  if (token.purpose === "unsubscribe" ? token.expires !== 0 : token.expires <= 0)
    throw new Error("Only an unsubscribe token may be permanent.");
  const value = `n1.${PURPOSE_CODES[token.purpose]}.${token.listId}.${token.subscription}.${token.expires}`;
  const signed = `${value}.${mac(await secret(), token)}`;
  if (!TOKEN.test(signed)) throw new Error("Token fields are invalid.");
  return signed;
}

/**
 * The token's claims when it is well formed, correctly signed, of the expected purpose and not
 * expired; otherwise null. Only a failure to load the secret throws.
 */
export async function verifyToken(
  secret: TokenSecret,
  value: unknown,
  purpose: TokenPurpose,
  nowSeconds: number,
): Promise<NewsletterToken | null> {
  if (typeof value !== "string" || value.length > 200) return null;
  const match = value.match(TOKEN);
  if (!match || match[1] !== PURPOSE_CODES[purpose]) return null;
  const token: NewsletterToken = {
    purpose,
    listId: match[2],
    subscription: match[3],
    expires: Number(match[4]),
  };
  if (purpose === "unsubscribe" ? token.expires !== 0 : token.expires === 0) return null;
  const expected = Buffer.from(mac(await secret(), token));
  const presented = Buffer.from(match[5]);
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) return null;
  if (token.expires !== 0 && token.expires <= nowSeconds) return null;
  return token;
}

/**
 * The key from an SSM SecureString (aws/ssm key), base64, at least 32 bytes. A loaded key is cached
 * for the life of the Lambda instance (it never changes under its name); failures are not cached.
 * The key is never logged.
 */
export function parameterStoreTokenSecret(
  name: string,
  client: Pick<SSMClient, "send"> = new SSMClient({ region: "us-east-1" }),
): TokenSecret {
  let cached: Promise<Buffer> | undefined;
  return () =>
    (cached ??= (async () => {
      const result = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
      const value = result.Parameter?.Value;
      if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
        throw new Error("The newsletter token key is missing or is not base64.");
      const secret = Buffer.from(value, "base64");
      if (secret.length < MINIMUM_TOKEN_SECRET_BYTES)
        throw new Error("The newsletter token key is shorter than 32 bytes.");
      return secret;
    })().catch((error) => {
      cached = undefined;
      throw error;
    }));
}
