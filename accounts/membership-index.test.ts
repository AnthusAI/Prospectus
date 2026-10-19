import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DurableAccountsService, membershipLookupMode, type MembershipLookup } from "./durable-accounts";
import { VirtuusAccountFiles, VirtuusIdentityFiles, type IdentityFiles } from "./identity-files";
import { type Context, type Person, roleOperations } from "./model";
import { directoryFixture } from "./testing/directory-fixture";
import { canonicalAccountsHandler } from "./canonical-handler";
const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});
const at = "2030-03-17T17:46:40.000Z";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "prospectus-membership-index-"));
  roots.push(root);
  const people: Record<string, Person> = Object.fromEntries(
    ["alice", "bob", "carol"].map((subject) => [subject, { id: randomUUID(), createdAt: at }]),
  );
  const contexts = Object.fromEntries(
    Object.keys(people).map((subject) => [
      subject,
      {
        product: "cyclotron",
        principal: "synthetic-runtime",
        human: { issuer: "synthetic", subject },
        capabilities: [...roleOperations.owner],
      } as Context,
    ]),
  );
  const directory = {
    resolve: async (context: Context) => people[context.human.subject] ?? null,
    get: async (id: string) => Object.values(people).find((person) => person.id === id) ?? null,
  };
  const files = new VirtuusAccountFiles(root);
  const service = (membershipLookup: MembershipLookup, storage: IdentityFiles = files) =>
    new DurableAccountsService(storage, directory, () => at, membershipLookup);
  return { root, people, contexts, files, service };
}
function recordingFiles(inner: IdentityFiles, extraAccountPaths: string[] = []) {
  const listedPrefixes: string[] = [],
    readPaths: string[] = [];
  const files: IdentityFiles = {
    get: async (path) => {
      readPaths.push(path);
      return inner.get(path);
    },
    list: async (prefix) => {
      listedPrefixes.push(prefix);
      return [...(await inner.list(prefix)), ...(prefix === "accounts/" ? extraAccountPaths : [])];
    },
    commit: inner.commit.bind(inner),
  };
  return { files, listedPrefixes, readPaths };
}

test("indexed lookup reads only the person's own accounts, even past the full-scan budget", async () => {
  const environment = await fixture(),
    indexed = environment.service("indexed");
  const bobOwn = await indexed.create(environment.contexts.bob, "Bob own", randomUUID()),
    shared = await indexed.create(environment.contexts.alice, "Shared", randomUUID());
  for (let index = 0; index < 5; index++)
    await indexed.create(environment.contexts.alice, `Alice only ${index}`, randomUUID());
  await indexed.setMembership(
    environment.contexts.alice,
    shared.id,
    environment.people.bob.id,
    "viewer",
    "active",
  );
  const unrelatedAccountPaths = Array.from({ length: 300 }, () => `accounts/${randomUUID()}.json`);
  const recorded = recordingFiles(environment.files, unrelatedAccountPaths);
  const listed = await environment.service("indexed", recorded.files).list(environment.contexts.bob);
  assert.deepEqual(listed.accounts.map((account) => account.id).sort(), [bobOwn.id, shared.id].sort());
  assert.deepEqual(recorded.listedPrefixes, [`members/${environment.people.bob.id}/`]);
  assert.deepEqual(
    recorded.readPaths.sort(),
    [`accounts/${bobOwn.id}.json`, `accounts/${shared.id}.json`].sort(),
  );
  await assert.rejects(
    environment.service("scan", recorded.files).list(environment.contexts.bob),
    (error: any) => error.code === "account_read_budget",
  );
});

test("a revoked membership is not listed although its marker remains", async () => {
  const environment = await fixture(),
    indexed = environment.service("indexed");
  const account = await indexed.create(environment.contexts.alice, "Revocable", randomUUID());
  await indexed.setMembership(
    environment.contexts.alice,
    account.id,
    environment.people.bob.id,
    "member",
    "active",
  );
  assert.deepEqual(
    (await indexed.list(environment.contexts.bob)).accounts.map((listed) => listed.id),
    [account.id],
  );
  await indexed.setMembership(
    environment.contexts.alice,
    account.id,
    environment.people.bob.id,
    "member",
    "revoked",
  );
  assert.deepEqual(await environment.files.list(`members/${environment.people.bob.id}/`), [
    `members/${environment.people.bob.id}/${account.id}.json`,
  ]);
  assert.deepEqual((await indexed.list(environment.contexts.bob)).accounts, []);
  await indexed.setMembership(
    environment.contexts.alice,
    account.id,
    environment.people.bob.id,
    "viewer",
    "active",
  );
  assert.equal((await indexed.list(environment.contexts.bob)).accounts[0].role, "viewer");
});

test("a marker whose account never published is skipped", async () => {
  const environment = await fixture(),
    indexed = environment.service("indexed"),
    accountId = randomUUID();
  await environment.files.commit(
    `members/${environment.people.carol.id}/${accountId}.json`,
    `membership-marker:${environment.people.carol.id}:${accountId}`,
    "0".repeat(64),
    { version: 1, kind: "membership-marker", personId: environment.people.carol.id, accountId },
    null,
  );
  assert.deepEqual((await indexed.list(environment.contexts.carol)).accounts, []);
});

test("rebuilding the index for accounts published before markers existed matches the full scan", async () => {
  const environment = await fixture();
  const filesWithoutMarkers: IdentityFiles = {
    get: environment.files.get.bind(environment.files),
    list: environment.files.list.bind(environment.files),
    commit: async (path, operationId, requestHash, value, revision) =>
      path.startsWith("members/")
        ? { value, revision: "skipped" }
        : environment.files.commit(path, operationId, requestHash, value, revision),
  };
  const scan = environment.service("scan", filesWithoutMarkers);
  const first = await scan.create(environment.contexts.alice, "First", randomUUID()),
    second = await scan.create(environment.contexts.bob, "Second", randomUUID());
  await scan.setMembership(
    environment.contexts.alice,
    first.id,
    environment.people.carol.id,
    "admin",
    "active",
  );
  await scan.setMembership(
    environment.contexts.bob,
    second.id,
    environment.people.carol.id,
    "viewer",
    "active",
  );
  await scan.setMembership(
    environment.contexts.alice,
    first.id,
    environment.people.bob.id,
    "member",
    "active",
  );
  await scan.setMembership(
    environment.contexts.alice,
    first.id,
    environment.people.bob.id,
    "member",
    "revoked",
  );
  const indexed = environment.service("indexed");
  assert.deepEqual((await indexed.list(environment.contexts.carol)).accounts, []);
  assert.deepEqual(await indexed.rebuildMembershipIndex(), { accounts: 2, markers: 4 });
  assert.deepEqual(await indexed.rebuildMembershipIndex(), { accounts: 2, markers: 4 });
  for (const subject of ["alice", "bob", "carol"])
    assert.deepEqual(
      await indexed.list(environment.contexts[subject]),
      await scan.list(environment.contexts[subject]),
    );
});

test("the personal account directory reads through the index", async () => {
  const environment = await directoryFixture();
  try {
    await environment.service.rebuildMembershipIndex();
    const recorded = recordingFiles(new VirtuusAccountFiles(environment.root));
    const handler = canonicalAccountsHandler(
      new VirtuusIdentityFiles(environment.root),
      recorded.files,
      environment.products,
      environment.identityFixture.keys,
      () => environment.identityFixture.now,
      [],
      "indexed",
    );
    const response = await handler(
      environment.identityFixture.event(
        environment.memberDirectory.index,
        "/v1/account-directory",
        {},
        environment.memberDirectory.proof,
        "GET",
      ),
    );
    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      JSON.parse(response.body).accounts.map((account: { id: string }) => account.id),
      [environment.account.id],
    );
    assert.deepEqual(recorded.listedPrefixes, [`members/${environment.member.person.id}/`]);
  } finally {
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("deployment lookup mode accepts only scan or indexed and defaults to scan", () => {
  assert.equal(membershipLookupMode(undefined), "scan");
  assert.equal(membershipLookupMode("indexed"), "indexed");
  assert.throws(() => membershipLookupMode("everything"));
});
