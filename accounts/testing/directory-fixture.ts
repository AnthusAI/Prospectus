import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { googleFixture } from "./google-fixture";
import { VirtuusIdentityFiles, VirtuusAccountFiles } from "../identity-files";
import { DurableGoogleIdentities } from "../durable-google-identities";
import { DurableAccountsService } from "../durable-accounts";
import { googlePersonDirectory } from "../person-directory";
import { canonicalAccountsHandler } from "../canonical-handler";
import { registrations } from "../registration";
import { context } from "../auth";
import type { ChallengeSigner } from "../challenge-signer";
/** Real RSA + pinned Virtuus files, disposable synthetic only. */
export async function directoryFixture(challengeSigner?: ChallengeSigner) {
  const root = await mkdtemp(join(tmpdir(), "accounts-directory-")),
    identityFixture = googleFixture(challengeSigner);
  const products = registrations(
    identityFixture.products.map((product, index) => ({
      ...product,
      ...(index === 0 ? { product: "prospectus-directory", accountDirectory: true as const } : {}),
      capabilities: ["console:read", "console:write", "members:read", "members:write"],
    })),
  );
  const repository = new DurableGoogleIdentities(new VirtuusIdentityFiles(root)),
    files = new VirtuusAccountFiles(root);
  const service = new DurableAccountsService(files, googlePersonDirectory(repository, products));
  const handler = () =>
    canonicalAccountsHandler(
      new VirtuusIdentityFiles(root),
      new VirtuusAccountFiles(root),
      products,
      identityFixture.keys,
      () => identityFixture.now,
      [],
      "scan",
      challengeSigner,
    );
  async function enroll(index: number, name: string, groups: string[] = []) {
    const challenge = JSON.parse(
      (await handler()(identityFixture.event(index, "/v1/identities/google/challenge"))).body,
    );
    const proof = identityFixture.pair(
      index,
      challenge.nonce,
      `synthetic-google-${name}`,
      { sub: `synthetic-${name}-${index}`, "cognito:groups": groups },
      { sub: `synthetic-${name}-${index}` },
    );
    const result = await handler()(
      identityFixture.event(
        index,
        "/v1/identities/google/resolve",
        challenge.challengeToken
          ? { challengeToken: challenge.challengeToken }
          : { challengeId: challenge.challengeId },
        proof,
      ),
    );
    if (result.statusCode !== 200) throw new Error("Synthetic enrollment failed");
    return {
      proof,
      person: JSON.parse(result.body).person,
      context: await context(
        identityFixture.event(index, "/v1/accounts", {}, proof),
        products,
        identityFixture.keys,
        identityFixture.now,
      ),
      index,
    };
  }
  const owner = await enroll(1, "owner"),
    member = await enroll(1, "member"),
    outsider = await enroll(0, "outsider", ["admin"]),
    ownerDirectory = await enroll(0, "owner"),
    memberDirectory = await enroll(0, "member");
  const account = await service.create(owner.context, "Persisted Papyrus organization", randomUUID());
  await service.setMembership(owner.context, account.id, member.person.id, "member", "active");
  return {
    root,
    identityFixture,
    products,
    files,
    repository,
    service,
    handler,
    enroll,
    account,
    owner,
    member,
    outsider,
    ownerDirectory,
    memberDirectory,
  };
}
