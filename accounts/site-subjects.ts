import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { caller, type ProductRegistration, type RestEvent } from "./auth";
import { AccountsError, UUID_PATTERN } from "./model";
import type { ValidatedRegistrations } from "./registration";
import { jsonResponse } from "./request";
import { hmacSha256 } from "./challenge-signer";
import { isPlainRecord, isProductName, matchesStringPattern } from "./validation-rules";

/** A pairwise subject: "ss1_" and the unpadded base64url of one HMAC-SHA-256 output (32 bytes, 43 characters). */
export const SITE_SUBJECT_PATTERN = /^ss1_[A-Za-z0-9_-]{43}$/;
export const SITE_SUBJECT_PREFIX = "ss1_";
export const SITE_SUBJECT_DOMAIN = "prospectus-site-subject:v1\n";
export const MINIMUM_SITE_SUBJECT_SECRET_BYTES = 32;
const SITE_SUBJECT_PARAMETER_PATTERN = /^\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*\/v1$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** Reviewed deployment configuration. Only v1 exists: a new version is a migration to new subjects (ss2_), never a
 * rotation under the same subjects. */
export interface SiteSubjectSecretConfiguration {
  version: "v1";
  parameterName: string;
}

export function siteSubjectSecretConfiguration(value: unknown): SiteSubjectSecretConfiguration {
  if (
    isPlainRecord(value) &&
    Object.keys(value).sort().join(",") === "parameterName,version" &&
    value.version === "v1" &&
    matchesStringPattern(value.parameterName, SITE_SUBJECT_PARAMETER_PATTERN)
  )
    return { version: "v1", parameterName: value.parameterName };
  throw new Error("The site subject secret must be a reviewed v1 Parameter Store name ending in /v1.");
}

/** The v1 secret, as one HMAC. It throws whenever the secret cannot be used, so callers fail closed. */
export interface SiteSubjectSecret {
  /** Resolves once the secret is loaded and usable; throws otherwise. */
  ready(): Promise<void>;
  mac(bytes: Uint8Array): Promise<Buffer>;
}

/** HMAC-SHA-256 in process with an SSM SecureString (aws/ssm key). The secret is cached for the life of the Lambda
 * instance because it never changes under its name; a failed read is not cached. The value is never logged. */
export class ParameterStoreSiteSubjectSecret implements SiteSubjectSecret {
  private secret?: Buffer;
  constructor(
    private configuration: SiteSubjectSecretConfiguration,
    private client: Pick<SSMClient, "send"> = new SSMClient({ region: "us-east-1" }),
  ) {}
  private async load() {
    if (this.secret) return this.secret;
    const result = await this.client.send(
      new GetParameterCommand({ Name: this.configuration.parameterName, WithDecryption: true }),
    );
    const value = result.Parameter?.Value;
    if (typeof value !== "string" || !matchesStringPattern(value, BASE64_PATTERN))
      throw new Error("The site subject secret parameter is missing or is not base64.");
    const secret = Buffer.from(value, "base64");
    if (secret.length < MINIMUM_SITE_SUBJECT_SECRET_BYTES)
      throw new Error("The site subject secret is shorter than 32 bytes.");
    this.secret = secret;
    return secret;
  }
  async ready() {
    await this.load();
  }
  async mac(bytes: Uint8Array) {
    return hmacSha256(await this.load(), bytes);
  }
}

/** The person's subject on one site. Inputs are checked so a wrong argument can never yield a valid-looking value. */
export async function siteSubject(secret: SiteSubjectSecret, product: string, personId: string) {
  if (!isProductName(product)) throw new Error("A site subject needs a registered product name.");
  if (!matchesStringPattern(personId, UUID_PATTERN)) throw new Error("A site subject needs a Person ID.");
  const mac = await secret.mac(Buffer.from(`${SITE_SUBJECT_DOMAIN}${product}\n${personId}`, "utf8"));
  if (mac.length !== 32) throw new Error("A site subject needs an HMAC-SHA-256 output.");
  const subject = `${SITE_SUBJECT_PREFIX}${mac.toString("base64url")}`;
  if (!SITE_SUBJECT_PATTERN.test(subject)) throw new Error("A site subject has an unexpected form.");
  return subject;
}

export const isPublicReader = (registration: ProductRegistration | undefined) =>
  registration?.audience === "public-reader";

const unavailable = () =>
  jsonResponse(503, {
    error: "identity_unavailable",
    message: "Identity service unavailable; retry identical evidence before challenge expiry.",
  });

type Response = ReturnType<typeof jsonResponse>;

/** The one route a reader site has beyond the identity routes: its own retired subjects. It lies under the existing
 * GET/v1/accounts/* access-policy pattern, so the API resource policy does not grow; this gate refuses it to every
 * caller but a public-reader site. */
export const RETIRED_SITE_SUBJECTS_PATH = "/v1/accounts/site-subjects/retired";
export interface RetiredSiteSubjectsRoute {
  respond(event: RestEvent, product: string, nowSeconds: number): Promise<Response>;
}

/** Response keys a reader caller may receive on a successful call, per route. Anything else fails closed. */
const readerSuccessShapes: Record<string, { keys: readonly string[]; person: boolean }> = {
  "POST /v1/identities/google/challenge": {
    keys: ["challengeId", "nonce", "expiresAt", "challengeToken"],
    person: false,
  },
  "POST /v1/identities/google/resolve": { keys: ["person"], person: true },
  "POST /v1/identities/resolve": { keys: ["person"], person: true },
  "GET /v1/identities/me": { keys: ["person"], person: true },
  "GET /v1/accounts": { keys: ["person", "accounts"], person: true },
};

async function readerPerson(secret: SiteSubjectSecret, product: string, person: unknown) {
  if (person === null) return null;
  if (!isPlainRecord(person) || !matchesStringPattern(person.id, UUID_PATTERN))
    throw new Error("A reader response carried an unexpected person.");
  // Only the pairwise subject. createdAt is identical on every site and would link the subjects; Prospectus holds no
  // display name, and email and the Google subject are cross-site identifiers.
  return { siteSubject: await siteSubject(secret, product, person.id) };
}

/** Rewrites one successful response for a reader caller, or throws so the caller gets a 503. Errors keep only their
 * code and message, which are fixed strings. */
async function readerResponse(
  response: Response,
  event: RestEvent,
  product: string,
  secret: SiteSubjectSecret,
): Promise<Response> {
  const body = JSON.parse(response.body);
  if (!isPlainRecord(body)) throw new Error("A reader response must be an object.");
  if (response.statusCode !== 200) {
    if (
      !Number.isSafeInteger(response.statusCode) ||
      typeof body.error !== "string" ||
      typeof body.message !== "string"
    )
      throw new Error("A reader error must carry a code and a message.");
    return jsonResponse(response.statusCode, { error: body.error, message: body.message });
  }
  const shape = readerSuccessShapes[`${event.httpMethod} ${event.path}`];
  if (!shape || Object.keys(body).some((key) => !shape.keys.includes(key)))
    throw new Error("A reader response has an unexpected shape.");
  if (!shape.person) return jsonResponse(200, body);
  if (!Object.hasOwn(body, "person")) throw new Error("A reader response must carry a person.");
  if (Object.hasOwn(body, "accounts") && !(Array.isArray(body.accounts) && body.accounts.length === 0))
    throw new Error("A reader caller holds no accounts.");
  const person = await readerPerson(secret, product, body.person);
  const projected = { ...body, person };
  const text = JSON.stringify(projected);
  // Defense in depth: the original Person fields may not survive anywhere in the projected body.
  if (isPlainRecord(body.person))
    for (const value of [body.person.id, body.person.createdAt])
      if (typeof value === "string" && text.includes(value))
        throw new Error("A reader response still carries a Person field.");
  return jsonResponse(200, projected);
}

/** The single gate for public-reader sites. Every reader request passes through here: the secret must be usable
 * before any work is done, Person IDs are replaced by the site's subject, and the retired-subject list is served.
 * Every other caller reaches `inner` unchanged. */
export function publicReaderHandler(
  inner: (event: RestEvent) => Promise<Response>,
  products: ValidatedRegistrations,
  secret: SiteSubjectSecret | undefined,
  retirements?: RetiredSiteSubjectsRoute,
  nowSeconds = () => Date.now() / 1000,
) {
  return async (event: RestEvent): Promise<Response> => {
    let registration: ProductRegistration | undefined;
    try {
      registration = caller(event, products).registration;
    } catch {
      registration = undefined;
    }
    if (!isPublicReader(registration)) {
      if (event.path === RETIRED_SITE_SUBJECTS_PATH)
        return jsonResponse(403, {
          error: "reader_route_forbidden",
          message: "Only public-reader sites list retired site subjects.",
        });
      return inner(event);
    }
    const product = registration!.product;
    try {
      if (!secret) return unavailable();
      await secret.ready();
      if (event.path === RETIRED_SITE_SUBJECTS_PATH) {
        if (!retirements) return unavailable();
        return await retirements.respond(event, product, nowSeconds());
      }
      return await readerResponse(await inner(event), event, product, secret);
    } catch (error) {
      if (error instanceof AccountsError)
        return jsonResponse(error.status, { error: error.code, message: error.message });
      return unavailable();
    }
  };
}
