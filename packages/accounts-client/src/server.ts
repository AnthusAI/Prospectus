import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { SignatureV4 } from "@smithy/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";
import { Sha256 } from "@aws-crypto/sha256-js";
import { AccountsClient, decode } from "./client.js";
export interface TemporaryCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}
export interface ServerClientOptions {
  endpoint: string;
  region: string;
  humanToken: () => string | Promise<string>;
  identityToken?: () => string | Promise<string>;
  credentials?: () => Promise<TemporaryCredentials>;
  fetcher?: typeof fetch;
}
/** Server-only entry point: IAM SigV4 with SDK/runtime temporary credentials. */
export function serverAccountsClient(options: ServerClientOptions): AccountsClient {
  const endpoint = new URL(options.endpoint);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error("Use an HTTPS account API endpoint.");
  const provider = options.credentials ?? defaultProvider();
  return new AccountsClient(async (path, method, body, requestKey) => {
    const credentials = await provider();
    if (
      !credentials.sessionToken ||
      (credentials.expiration && credentials.expiration.getTime() <= Date.now())
    )
      throw new Error("Runtime temporary credentials are required; static access keys are refused.");
    const token = await options.humanToken();
    if (!token) throw new Error("A verified session access token is required.");
    const url = new URL(`${endpoint.toString().replace(/\/$/, "")}${path}`);
    const payload = body ? JSON.stringify(body) : undefined;
    const identityToken =
      path === "/v1/identities/google/resolve" ? await options.identityToken?.() : undefined;
    const headers = {
      host: url.host,
      ...(identityToken ? { "x-prospectus-identity-token": identityToken } : {}),
      "x-prospectus-human-token": token,
      ...(body ? { "content-type": "application/json" } : {}),
      ...(requestKey ? { "idempotency-key": requestKey } : {}),
    };
    const signer = new SignatureV4({
      service: "execute-api",
      region: options.region,
      credentials,
      sha256: Sha256,
    });
    const signed = await signer.sign(
      new HttpRequest({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port ? Number(url.port) : undefined,
        path: url.pathname,
        method,
        headers,
        body: payload,
      }),
    );
    return decode(
      await (options.fetcher ?? fetch)(url, {
        method,
        headers: signed.headers,
        body: payload,
        cache: "no-store",
        redirect: "error",
      }),
    );
  });
}
