/** Synthetic JSON-lines bridge for cross-language tests. No HTTP listener, AWS,
 * environment credentials or production persistence. Input supplies public keys.
 * requestContext fixtures are NOT proof of deployed SigV4 enforcement.
 */
import { createInterface } from "node:readline";
import type { JsonWebKey } from "node:crypto";
import { googleIdentityHandler } from "../google-identity";
import { canonicalAccountsHandler } from "../canonical-handler";
import { AccountsService } from "../service";
import { accountHandler } from "../handler";
import { googlePersonDirectory } from "../person-directory";
import { MemoryAccountStore } from "./memory-account-store";
import { registrations } from "../registration";
import { DurableGoogleIdentities } from "../durable-google-identities";
import { VirtuusIdentityFiles, VirtuusAccountFiles } from "../identity-files";
import { MemoryGoogleIdentities } from "./memory-google-identities";

let handler: ReturnType<typeof googleIdentityHandler> | undefined;
let now = 0;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  try {
    if (Buffer.byteLength(line) > 65536) throw new Error("Bounded synthetic request required");
    const message = JSON.parse(line);
    if (message.op === "configure" && !handler) {
      const products = registrations(message.products);
      if (
        products.some(
          (product) =>
            !/^https:\/\/cognito-idp\.us-east-1\.amazonaws\.com\/us-east-1_Synthetic[0-9A-Za-z]*$/.test(
              product.issuer,
            ) ||
            [
              product.roleArn,
              ...(product.executionDelegation ? [product.executionDelegation.roleArn] : []),
            ].some((role) => !/^arn:aws:iam::111111111111:role\/Synthetic[0-9A-Za-z]*$/.test(role)),
        )
      )
        throw new Error("Synthetic registrations only");
      if (!Number.isSafeInteger(message.nowSeconds) || !message.keys || typeof message.keys !== "object")
        throw new Error("Synthetic clock and public keys required");
      const publicKeys: Record<string, Record<string, JsonWebKey>> = message.keys;
      for (const issuer of Object.values(publicKeys))
        for (const key of Object.values(issuer)) {
          if (key.kty !== "RSA" || !key.n || !key.e || key.d || key.p || key.q)
            throw new Error("Public RSA keys only");
        }
      now = message.nowSeconds;
      const repository = message.filesystemRoot
        ? new DurableGoogleIdentities(new VirtuusIdentityFiles(message.filesystemRoot))
        : new MemoryGoogleIdentities();
      const keys = async (issuer: string, kid: string) => {
        const key = publicKeys[issuer]?.[kid];
        if (!key) throw new Error("Unknown synthetic key");
        return key;
      };
      const identities = googleIdentityHandler(repository, products, keys, () => now);
      if (message.durableAccounts === true && (!message.filesystemRoot || message.accountsFixture === true))
        throw new Error("Durable accounts require an isolated filesystem root, not memory accounts fixture");
      if (message.durableAccounts === true) {
        handler = canonicalAccountsHandler(
          new VirtuusIdentityFiles(message.filesystemRoot),
          new VirtuusAccountFiles(message.filesystemRoot),
          products,
          keys,
          () => now,
        );
      } else if (message.accountsFixture === true) {
        const directory = googlePersonDirectory(repository, products),
          clock = () => new Date(now * 1000).toISOString();
        const service = new AccountsService(new MemoryAccountStore(), clock, directory);
        const accounts = accountHandler(service, products, keys, () => now);
        handler = (event) => (event.path.startsWith("/v1/accounts") ? accounts(event) : identities(event));
      } else handler = identities;
      process.stdout.write(JSON.stringify({ configured: true }) + "\n");
    } else if (message.op === "request" && handler) {
      process.stdout.write(JSON.stringify(await handler(message.event)) + "\n");
    } else if (
      message.op === "advance" &&
      handler &&
      Number.isSafeInteger(message.seconds) &&
      message.seconds >= 0
    ) {
      now += message.seconds;
      process.stdout.write(JSON.stringify({ nowSeconds: now }) + "\n");
    } else throw new Error("Invalid synthetic operation");
  } catch {
    process.stdout.write(JSON.stringify({ harnessError: "Invalid synthetic harness input" }) + "\n");
  }
}
