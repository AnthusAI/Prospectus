import { generateKeyPairSync, randomUUID, sign, type JsonWebKey } from "node:crypto";
import { googleIdentityHandler } from "../google-identity";
import { MemoryGoogleIdentities } from "./memory-google-identities";
import { registrations } from "../registration";
import type { RestEvent } from "../auth";
import type { ChallengeMacSigner } from "../challenge-token";

const accessKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const idKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
/** Synthetic cryptographic fixture, never production credentials or IAM proof. */
export function googleFixture(challengeSigner?: ChallengeMacSigner) {
  let now = 1900000000;
  const products = registrations(
    ["cyclotron", "papyrus"].map((product, index) => ({
      product,
      roleArn: `arn:aws:iam::111111111111:role/Synthetic${index}`,
      issuer: `https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Synthetic${index}`,
      clientIds: [`synthetic${index}`],
      capabilities: ["console:read"],
      enabled: true,
      googleFederation: {
        policy: "google-only-unlinked-v1",
        reviewedPolicyId: "synthetic-review-v1",
        clientId: `synthetic${index}`,
      },
    })),
  );
  const repository = new MemoryGoogleIdentities();
  const keys = async (issuer: string, kid: string): Promise<JsonWebKey> => {
    if (
      !products.some((product) => product.issuer === issuer) ||
      !["synthetic-access", "synthetic-id"].includes(kid)
    )
      throw new Error("Unknown synthetic key");
    return (kid === "synthetic-id" ? idKeys : accessKeys).publicKey.export({ format: "jwk" });
  };
  const handler = googleIdentityHandler(repository, products, keys, () => now, challengeSigner);
  function token(claims: Record<string, unknown>, purpose: "access" | "id") {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: `synthetic-${purpose}` })).toString(
      "base64url",
    );
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), (purpose === "id" ? idKeys : accessKeys).privateKey).toString("base64url")}`;
  }
  function pair(
    index: number,
    nonce: string,
    googleSubject = "synthetic-google-a",
    accessOverrides: Record<string, unknown> = {},
    idOverrides: Record<string, unknown> = {},
  ) {
    const shared = {
      iss: products[index].issuer,
      sub: `synthetic-pool-person-${index}`,
      auth_time: now,
      origin_jti: `synthetic-family-${index}`,
      iat: now,
      exp: now + 3600,
    };
    return {
      access: token(
        {
          ...shared,
          client_id: products[index].clientIds[0],
          token_use: "access",
          jti: randomUUID(),
          ...accessOverrides,
        },
        "access",
      ),
      id: token(
        {
          ...shared,
          aud: products[index].clientIds[0],
          token_use: "id",
          jti: randomUUID(),
          nonce,
          email: "same-email@example.invalid",
          identities: [
            { providerName: "Google", providerType: "Google", userId: googleSubject, primary: "true" },
          ],
          ...idOverrides,
        },
        "id",
      ),
    };
  }
  function event(
    index: number,
    path: string,
    body: unknown = {},
    proof?: { access: string; id: string },
    method = "POST",
  ): RestEvent {
    return {
      httpMethod: method,
      path,
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        ...(proof
          ? { "x-prospectus-human-token": proof.access, "x-prospectus-identity-token": proof.id }
          : {}),
      },
      requestContext: {
        identity: {
          userArn: `arn:aws:sts::111111111111:assumed-role/Synthetic${index}/synthetic-session`,
          accountId: "111111111111",
        },
      },
    };
  }
  async function request(
    index: number,
    path: string,
    body: unknown = {},
    proof?: { access: string; id: string },
    method = "POST",
  ) {
    const response = await handler(event(index, path, body, proof, method));
    return { status: response.statusCode, body: JSON.parse(response.body) };
  }
  const challenge = async (index = 0, body: unknown = {}) =>
    (await request(index, "/v1/identities/google/challenge", body)).body as {
      challengeId: string;
      nonce: string;
      expiresAt: number;
      challengeToken?: string;
    };
  const resolve = (
    index: number,
    challenge: string | { challengeToken: string },
    proof: { access: string; id: string },
  ) =>
    request(
      index,
      "/v1/identities/google/resolve",
      typeof challenge === "string" ? { challengeId: challenge } : challenge,
      proof,
    );
  return {
    products,
    repository,
    keys,
    handler,
    pair,
    event,
    request,
    challenge,
    resolve,
    get now() {
      return now;
    },
    advance: (seconds: number) => {
      now += seconds;
    },
  };
}
