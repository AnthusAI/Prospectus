import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { registrations } from "./registration";
import { DurableAccountsService, createdAccountId, type AccountDocument } from "./durable-accounts";
import {
  VirtuusAccountFiles,
  VirtuusIdentityFiles,
  IdentityFileError,
  type IdentityFiles,
} from "./identity-files";
import { type Context, type Person, roleOperations } from "./model";
import { DurableGoogleIdentities } from "./durable-google-identities";
import { googlePersonDirectory, type PersonDirectory } from "./person-directory";
import { googleIdentityHandler } from "./google-identity";
import { googleFixture } from "./testing/google-fixture";
import { accountHandler } from "./handler";
const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});
const fixedTimestamp = "2030-03-17T17:46:40.000Z";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "prospectus-account-files-"));
  roots.push(root);
  const people: Record<string, Person> = Object.fromEntries(
    ["alice", "bob", "carol"].map((subject) => [subject, { id: randomUUID(), createdAt: fixedTimestamp }]),
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
  const files = new VirtuusAccountFiles(root),
    service = (storage: IdentityFiles = files) =>
      new DurableAccountsService(storage, directory, () => fixedTimestamp);
  return { root, people, contexts, directory, files, service };
}
async function worker(message: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "accounts/testing/durable-account-worker.ts"], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        assert.equal(code, 0);
        resolve(JSON.parse(output));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(message));
  });
}
const code = (expected: string) => (error: any) => error.code === expected;

test("account discovery overlaps at most four canonical reads and observes membership revocation", async () => {
  const environment = await fixture(),
    accounts = [];
  for (let index = 0; index < 7; index++)
    accounts.push(
      await environment.service().create(environment.contexts.alice, `Synthetic ${index}`, randomUUID()),
    );
  await environment
    .service()
    .setMembership(environment.contexts.alice, accounts[0].id, environment.people.bob.id, "viewer", "active");
  let active = 0,
    maximum = 0;
  const files: IdentityFiles = {
    get: async (path) => {
      active++;
      maximum = Math.max(maximum, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return await environment.files.get(path);
      } finally {
        active--;
      }
    },
    list: environment.files.list.bind(environment.files),
    commit: async () => {
      throw new Error("Discovery must never write");
    },
  };
  const service = environment.service(files),
    listed = await service.list(environment.contexts.bob);
  assert.deepEqual(
    listed.accounts.map((account) => account.id),
    [accounts[0].id],
  );
  assert.ok(maximum > 1, `Expected overlapping reads, observed ${maximum}`);
  assert.ok(maximum <= 4, `Expected bounded overlap, observed ${maximum}`);
  await environment
    .service()
    .setMembership(
      environment.contexts.alice,
      accounts[0].id,
      environment.people.bob.id,
      "viewer",
      "revoked",
    );
  assert.deepEqual((await service.list(environment.contexts.bob)).accounts, []);
});
test("actual Virtuus account creation and authorization survive independent process restart", async () => {
  const environment = await fixture(),
    requestId = randomUUID();
  const first = await worker({
    root: environment.root,
    people: environment.people,
    context: environment.contexts.alice,
    op: "create",
    name: "Synthetic account",
    requestId,
  });
  assert.ok(first.value.id);
  const restarted = await worker({
    root: environment.root,
    people: environment.people,
    context: environment.contexts.alice,
    op: "authorize",
    accountId: first.value.id,
    operation: "console:write",
  });
  assert.equal(restarted.value.personId, environment.people.alice.id);
  assert.equal((await environment.service().list(environment.contexts.alice)).accounts[0].id, first.value.id);
  const retry = await worker({
    root: environment.root,
    people: environment.people,
    context: environment.contexts.alice,
    op: "create",
    name: "Synthetic account",
    requestId,
  });
  assert.equal(retry.value.id, first.value.id);
  await assert.rejects(
    environment.service().create(environment.contexts.alice, "Changed", requestId),
    code("idempotency_conflict"),
  );
  assert.equal((await environment.files.list("accounts/")).length, 1);
});
test("concurrent independent create retries publish one canonical account and frozen receipt", async () => {
  const environment = await fixture(),
    requestId = randomUUID();
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      worker({
        root: environment.root,
        people: environment.people,
        context: environment.contexts.alice,
        op: "create",
        name: "Same",
        requestId,
      }),
    ),
  );
  const final = await environment.service().create(environment.contexts.alice, "Same", requestId);
  for (const result of results) if (result.value) assert.equal(result.value.id, final.id);
  assert.ok(results.some((result) => result.value));
  const stored = await environment.files.get<AccountDocument>(`accounts/${final.id}.json`);
  assert.equal(stored!.value.audit.length, 1);
  assert.equal((await environment.files.list("accounts/")).length, 1);
});
test("memberships are many-to-many and permissions are selected-account and product scoped", async () => {
  const environment = await fixture(),
    service = environment.service();
  const first = await service.create(environment.contexts.alice, "First", randomUUID()),
    second = await service.create(environment.contexts.alice, "Second", randomUUID()),
    third = await service.create(environment.contexts.bob, "Bob own", randomUUID());
  await service.setMembership(
    environment.contexts.alice,
    first.id,
    environment.people.bob.id,
    "viewer",
    "active",
  );
  await service.setMembership(
    environment.contexts.alice,
    second.id,
    environment.people.bob.id,
    "member",
    "active",
  );
  assert.equal((await service.list(environment.contexts.bob)).accounts.length, 3);
  await assert.rejects(
    service.authorize(environment.contexts.bob, first.id, "console:write"),
    code("forbidden"),
  );
  assert.equal(
    (await service.authorize(environment.contexts.bob, second.id, "console:write")).personId,
    environment.people.bob.id,
  );
  await assert.rejects(
    service.setMembership(
      environment.contexts.bob,
      second.id,
      environment.people.carol.id,
      "viewer",
      "active",
    ),
    code("forbidden"),
  );
  await service.setMembership(
    environment.contexts.alice,
    first.id,
    environment.people.bob.id,
    "viewer",
    "revoked",
  );
  await assert.rejects(service.get(environment.contexts.bob, first.id), code("forbidden"));
  assert.equal((await service.list(environment.contexts.bob)).accounts.length, 2);
  assert.ok(await service.get(environment.contexts.bob, third.id));
  await assert.rejects(
    service.get({ ...environment.contexts.alice, product: "papyrus" }, second.id),
    code("forbidden"),
  );
  await assert.rejects(
    service.get({ ...environment.contexts.alice, capabilities: [] }, second.id),
    code("forbidden"),
  );
  await assert.rejects(service.get(environment.contexts.carol, second.id), code("forbidden"));
});
test("two independent owners cannot concurrently demote the last remaining owner", async () => {
  const environment = await fixture(),
    account = await environment.service().create(environment.contexts.alice, "Owners", randomUUID());
  await environment
    .service()
    .setMembership(environment.contexts.alice, account.id, environment.people.bob.id, "owner", "active");
  const results = await Promise.all(
    ["alice", "bob"].map((subject) =>
      worker({
        root: environment.root,
        people: environment.people,
        context: environment.contexts[subject],
        op: "member",
        accountId: account.id,
        personId: environment.people[subject].id,
        role: "member",
        status: "active",
      }),
    ),
  );
  assert.equal(results.filter((result) => result.value).length, 1);
  assert.equal(
    results.filter((result) => result.error?.code === "last_owner").length,
    1,
    JSON.stringify(results),
  );
  const stored = (await environment.files.get<AccountDocument>(`accounts/${account.id}.json`))!.value;
  assert.equal(
    Object.values(stored.memberships).filter(
      (member) => member.role === "owner" && member.status === "active",
    ).length,
    1,
  );
});
test("revocation wins against a stale authorized writer before canonical CAS", async () => {
  const environment = await fixture(),
    account = await environment.service().create(environment.contexts.alice, "Stale actor", randomUUID());
  await environment
    .service()
    .setMembership(environment.contexts.alice, account.id, environment.people.bob.id, "admin", "active");
  let injected = false;
  const storage: IdentityFiles = {
    get: environment.files.get.bind(environment.files),
    list: environment.files.list.bind(environment.files),
    commit: async (...args) => {
      if (!injected) {
        injected = true;
        await environment
          .service()
          .setMembership(
            environment.contexts.alice,
            account.id,
            environment.people.bob.id,
            "admin",
            "revoked",
          );
      }
      return environment.files.commit(...args);
    },
  };
  await assert.rejects(
    environment
      .service(storage)
      .setMembership(environment.contexts.bob, account.id, environment.people.carol.id, "viewer", "active"),
    code("forbidden"),
  );
  const document = (await environment.files.get<AccountDocument>(`accounts/${account.id}.json`))!.value;
  assert.ok(!Object.hasOwn(document.memberships, environment.people.carol.id));
  assert.equal(document.audit.length, 3);
});
function countingDirectory(directory: PersonDirectory) {
  const counts = { resolutions: 0, targetLookups: 0 };
  const countedDirectory: PersonDirectory = {
    resolve: async (context) => {
      counts.resolutions++;
      return directory.resolve(context);
    },
    get: async (id) => {
      counts.targetLookups++;
      return directory.get(id);
    },
  };
  return { counts, countedDirectory };
}
test("one request resolves the canonical Person once while later requests resolve it again", async () => {
  const environment = await fixture(),
    account = await environment
      .service()
      .create(environment.contexts.alice, "Resolution count", randomUUID());
  const { counts, countedDirectory } = countingDirectory(environment.directory);
  const service = new DurableAccountsService(environment.files, countedDirectory, () => fixedTimestamp);
  await service.setMembership(
    environment.contexts.alice,
    account.id,
    environment.people.bob.id,
    "viewer",
    "active",
  );
  assert.equal(counts.resolutions, 1);
  await service.get({ ...environment.contexts.alice }, account.id);
  assert.equal(counts.resolutions, 2);
  const requestContext = { ...environment.contexts.alice };
  await service.list(requestContext);
  await service.authorize(requestContext, account.id, "console:read");
  await service.get(requestContext, account.id);
  assert.equal(counts.resolutions, 3);
  await service.get({ ...environment.contexts.alice }, account.id);
  assert.equal(counts.resolutions, 4);
});
test("a canonical account conflict rereads the account but not the Person or the target lookup", async () => {
  const environment = await fixture(),
    account = await environment.service().create(environment.contexts.alice, "Conflict count", randomUUID());
  const { counts, countedDirectory } = countingDirectory(environment.directory);
  let injectedConflicts = 0;
  const accountReads: string[] = [];
  const storage: IdentityFiles = {
    get: async (path) => {
      accountReads.push(path);
      return environment.files.get(path);
    },
    list: environment.files.list.bind(environment.files),
    commit: async (...args) => {
      const isAccountDocument = args[0] === `accounts/${account.id}.json`;
      if (isAccountDocument && injectedConflicts < 2) {
        injectedConflicts++;
        throw new IdentityFileError("conflict");
      }
      return environment.files.commit(...args);
    },
  };
  const service = new DurableAccountsService(storage, countedDirectory, () => fixedTimestamp);
  const membership = await service.setMembership(
    environment.contexts.alice,
    account.id,
    environment.people.bob.id,
    "viewer",
    "active",
  );
  assert.equal(membership.role, "viewer");
  assert.equal(injectedConflicts, 2);
  assert.equal(accountReads.filter((path) => path === `accounts/${account.id}.json`).length, 3);
  assert.equal(counts.resolutions, 1);
  assert.equal(counts.targetLookups, 1);
});
test("admins cannot grant ownership or change an owner; final owner remains protected", async () => {
  const environment = await fixture(),
    account = await environment.service().create(environment.contexts.alice, "Ownership", randomUUID());
  await environment
    .service()
    .setMembership(environment.contexts.alice, account.id, environment.people.bob.id, "admin", "active");
  await assert.rejects(
    environment
      .service()
      .setMembership(environment.contexts.bob, account.id, environment.people.carol.id, "owner", "active"),
    code("owner_required"),
  );
  await assert.rejects(
    environment
      .service()
      .setMembership(environment.contexts.bob, account.id, environment.people.alice.id, "viewer", "active"),
    code("owner_required"),
  );
  await assert.rejects(
    environment
      .service()
      .setMembership(environment.contexts.alice, account.id, environment.people.alice.id, "owner", "revoked"),
    code("last_owner"),
  );
});
test("pending and unknown canonical people cause no account publication", async () => {
  const environment = await fixture(),
    context = { ...environment.contexts.alice, human: { issuer: "synthetic", subject: "pending" } };
  await assert.rejects(
    environment.service().create(context, "No account", randomUUID()),
    code("identity_enrollment_required"),
  );
  assert.equal((await environment.files.list("accounts/")).length, 0);
  const account = await environment.service().create(environment.contexts.alice, "Known", randomUUID());
  await assert.rejects(
    environment
      .service()
      .setMembership(environment.contexts.alice, account.id, randomUUID(), "member", "active"),
    code("unknown_person"),
  );
});
test("canonical account copy works without source journal or reciprocal membership indexes", async () => {
  const environment = await fixture(),
    account = await environment.service().create(environment.contexts.alice, "Copy", randomUUID());
  await environment
    .service()
    .setMembership(environment.contexts.alice, account.id, environment.people.bob.id, "viewer", "active");
  const destination = await mkdtemp(join(tmpdir(), "prospectus-account-copy-"));
  roots.push(destination);
  await cp(join(environment.root, "local", "accounts"), join(destination, "local", "accounts"), {
    recursive: true,
  });
  const copied = new DurableAccountsService(
    new VirtuusAccountFiles(destination),
    environment.directory,
    () => fixedTimestamp,
  );
  assert.equal((await copied.list(environment.contexts.bob)).accounts[0].id, account.id);
  await assert.rejects(
    copied.authorize(environment.contexts.bob, account.id, "console:write"),
    code("forbidden"),
  );
});
for (const point of ["before_publication", "after_publication"] as const)
  test(`native create interruption ${point} preserves all-or-none account authorization`, async () => {
    const environment = await fixture(),
      requestId = randomUUID(),
      id = createdAccountId(environment.people.alice.id, environment.contexts.alice.product, requestId);
    const interrupted = environment.service(
      new VirtuusAccountFiles(environment.root, undefined, { path: `accounts/${id}.json`, point }),
    );
    if (point === "before_publication")
      await assert.rejects(
        interrupted.create(environment.contexts.alice, "Interrupted", requestId),
        code("uncertain"),
      );
    else
      assert.equal((await interrupted.create(environment.contexts.alice, "Interrupted", requestId)).id, id);
    if (point === "before_publication") {
      await assert.rejects(environment.service().get(environment.contexts.alice, id), code("forbidden"));
      await assert.rejects(
        environment.service().create(environment.contexts.alice, "Interrupted", requestId),
        code("uncertain"),
      );
    } else {
      assert.equal(
        (await environment.service().create(environment.contexts.alice, "Interrupted", requestId)).id,
        id,
      );
      assert.equal(
        (await environment.service().authorize(environment.contexts.alice, id, "console:write")).personId,
        environment.people.alice.id,
      );
    }
  });
test("lost membership response retries without duplicating audit and revocation persists", async () => {
  const environment = await fixture(),
    account = await environment.service().create(environment.contexts.alice, "Lost", randomUUID());
  let remaining = 4;
  const storage: IdentityFiles = {
    get: environment.files.get.bind(environment.files),
    list: environment.files.list.bind(environment.files),
    commit: async (...args) => {
      const result = await environment.files.commit(...args);
      if (remaining-- > 0) throw new IdentityFileError("uncertain");
      return result;
    },
  };
  await assert.rejects(
    environment
      .service(storage)
      .setMembership(environment.contexts.alice, account.id, environment.people.bob.id, "viewer", "active"),
  );
  await environment
    .service()
    .setMembership(environment.contexts.alice, account.id, environment.people.bob.id, "viewer", "active");
  assert.equal(
    (await environment.files.get<AccountDocument>(`accounts/${account.id}.json`))!.value.audit.length,
    2,
  );
  await environment
    .service()
    .setMembership(environment.contexts.alice, account.id, environment.people.bob.id, "viewer", "revoked");
  await assert.rejects(environment.service().get(environment.contexts.bob, account.id), code("forbidden"));
});
test("malformed canonical permissions and audit capacity fail closed", async () => {
  const environment = await fixture(),
    account = await environment.service().create(environment.contexts.alice, "Bounds", randomUUID()),
    location = `accounts/${account.id}.json`;
  let stored = (await environment.files.get<AccountDocument>(location))!;
  const full = structuredClone(stored.value);
  for (let revision = 2; revision <= 128; revision++)
    full.audit.push({
      type: "membership.changed",
      revision,
      actor: environment.people.alice.id,
      target: environment.people.bob.id,
      role: "viewer",
      status: "active",
      product: "cyclotron",
      principal: "synthetic-runtime",
      at: fixedTimestamp,
    });
  full.account.revision = 128;
  await environment.files.commit(location, randomUUID(), "a".repeat(64), full, stored.revision);
  await assert.rejects(
    environment
      .service()
      .setMembership(environment.contexts.alice, account.id, environment.people.carol.id, "viewer", "active"),
    code("account_capacity"),
  );
  stored = (await environment.files.get<AccountDocument>(location))!;
  const malformed = structuredClone(stored.value);
  malformed.memberships[environment.people.alice.id].status = "revoked";
  await environment.files.commit(location, randomUUID(), "b".repeat(64), malformed, stored.revision);
  await assert.rejects(
    environment.service().authorize(environment.contexts.alice, account.id, "console:read"),
    code("account_inconsistent"),
  );
});
const inconsistentMessage = (reason: string) => (error: any) =>
  error.code === "account_inconsistent" &&
  error.message === `Canonical account document is inconsistent: ${reason}`;
const tamperedAccountCases: Array<[string, (document: AccountDocument, ownerId: string) => void, string]> = [
  ["blank name", (document) => (document.account.name = "   "), "Account name must not be blank."],
  [
    "unknown membership role",
    (document, ownerId) => ((document.memberships[ownerId] as any).role = "emperor"),
    "Membership role must be known.",
  ],
  [
    "revoked only owner",
    (document, ownerId) => (document.memberships[ownerId].status = "revoked"),
    "Account must retain an active owner.",
  ],
  [
    "unknown entitlement status",
    (document) => ((document.entitlements.cyclotron as any).status = "paused"),
    "Entitlement status must be active or disabled.",
  ],
  [
    "revision ahead of audit history",
    (document) => (document.account.revision = 2),
    "Audit history length must equal the account revision.",
  ],
  [
    "first audit event is not the creation",
    (document) => ((document.audit[0] as any).type = "membership.changed"),
    "The first audit event must be the account creation.",
  ],
];
for (const [name, tamper, reason] of tamperedAccountCases)
  test(`canonical account with ${name} fails closed naming the broken rule`, async () => {
    const environment = await fixture(),
      account = await environment.service().create(environment.contexts.alice, "Tampered", randomUUID()),
      location = `accounts/${account.id}.json`,
      stored = (await environment.files.get<AccountDocument>(location))!,
      tampered = structuredClone(stored.value);
    tamper(tampered, environment.people.alice.id);
    await environment.files.commit(location, randomUUID(), "e".repeat(64), tampered, stored.revision);
    await assert.rejects(
      environment.service().authorize(environment.contexts.alice, account.id, "console:read"),
      inconsistentMessage(reason),
    );
  });
const invalidInputMessage = (expected: string) => (error: any) =>
  error.status === 400 && error.message === expected;
test("account creation and membership inputs name the rule they break", async () => {
  const environment = await fixture(),
    account = await environment.service().create(environment.contexts.alice, "Inputs", randomUUID());
  await assert.rejects(
    environment.service().create(environment.contexts.alice, "Named", "not-a-uuid"),
    invalidInputMessage("UUID idempotency key required."),
  );
  await assert.rejects(
    environment.service().create(environment.contexts.alice, "   ", randomUUID()),
    invalidInputMessage("Non-blank account name required."),
  );
  await assert.rejects(
    environment.service().create(environment.contexts.alice, "x".repeat(151), randomUUID()),
    invalidInputMessage("Account name must be at most 150 characters."),
  );
  await assert.rejects(
    environment
      .service()
      .setMembership(environment.contexts.alice, account.id, "not-a-uuid", "viewer", "active"),
    invalidInputMessage("Person UUID required for membership."),
  );
  await assert.rejects(
    environment
      .service()
      .setMembership(
        environment.contexts.alice,
        account.id,
        environment.people.bob.id,
        "emperor" as any,
        "active",
      ),
    invalidInputMessage("Known membership role required."),
  );
  await assert.rejects(
    environment
      .service()
      .setMembership(
        environment.contexts.alice,
        account.id,
        environment.people.bob.id,
        "viewer",
        "paused" as any,
      ),
    invalidInputMessage("Membership status must be active or revoked."),
  );
});
test("real RSA identity and actual REST account handlers share durable Person/account state after restart", async () => {
  const environment = await fixture(),
    identityFixture = googleFixture();
  const products = registrations(
    identityFixture.products.map((product) => ({ ...product, capabilities: [...roleOperations.owner] })),
  );
  const handlers = () => {
    const repository = new DurableGoogleIdentities(new VirtuusIdentityFiles(environment.root)),
      directory = googlePersonDirectory(repository, products);
    return {
      identity: googleIdentityHandler(repository, products, identityFixture.keys, () => identityFixture.now),
      accounts: accountHandler(
        new DurableAccountsService(
          new VirtuusAccountFiles(environment.root),
          directory,
          () => fixedTimestamp,
        ),
        products,
        identityFixture.keys,
        () => identityFixture.now,
      ),
    };
  };
  const enrolled = [];
  for (let index = 0; index < 2; index++) {
    const h = handlers(),
      challenge = JSON.parse(
        (await h.identity(identityFixture.event(index, "/v1/identities/google/challenge"))).body,
      ),
      pair = identityFixture.pair(index, challenge.nonce);
    const response = await h.identity(
      identityFixture.event(
        index,
        "/v1/identities/google/resolve",
        { challengeId: challenge.challengeId },
        pair,
      ),
    );
    assert.equal(response.statusCode, 200);
    enrolled.push({ pair, person: JSON.parse(response.body).person });
  }
  assert.equal(enrolled[0].person.id, enrolled[1].person.id);
  const create = identityFixture.event(0, "/v1/accounts", { name: "Durable handler" }, enrolled[0].pair);
  create.headers!["idempotency-key"] = randomUUID();
  const created = await handlers().accounts(create);
  assert.equal(created.statusCode, 200);
  const account = JSON.parse(created.body).account;
  const listed = await handlers().accounts(
    identityFixture.event(0, "/v1/accounts", {}, enrolled[0].pair, "GET"),
  );
  assert.equal(JSON.parse(listed.body).accounts[0].id, account.id);
  assert.equal(JSON.parse(listed.body).person.id, enrolled[0].person.id);
  const denied = await handlers().accounts(
    identityFixture.event(1, `/v1/accounts/${account.id}`, {}, enrolled[1].pair, "GET"),
  );
  assert.equal(denied.statusCode, 403);
  const granted = await handlers().accounts(
    identityFixture.event(
      0,
      `/v1/accounts/${account.id}/authorize`,
      { operation: "console:write" },
      enrolled[0].pair,
    ),
  );
  assert.equal(granted.statusCode, 200);
  assert.equal(JSON.parse(granted.body).personId, enrolled[0].person.id);
  assert.equal((await handlers().accounts(create)).body, created.body);
});
test("canonical product entitlement revocation denies even an active owner", async () => {
  const environment = await fixture(),
    account = await environment.service().create(environment.contexts.alice, "Entitlement", randomUUID()),
    location = `accounts/${account.id}.json`,
    stored = (await environment.files.get<AccountDocument>(location))!;
  const revoked = structuredClone(stored.value);
  revoked.entitlements.cyclotron.status = "disabled";
  await environment.files.commit(location, randomUUID(), "d".repeat(64), revoked, stored.revision);
  await assert.rejects(
    environment.service().authorize(environment.contexts.alice, account.id, "console:read"),
    code("forbidden"),
  );
  assert.deepEqual((await environment.service().list(environment.contexts.alice)).accounts, []);
});
test("actual central JSON-lines process restart preserves identity plus both product accounts", async () => {
  const environment = await fixture(),
    identityFixture = googleFixture(),
    keys: Record<string, any> = {};
  for (const product of identityFixture.products)
    keys[product.issuer] = {
      "synthetic-access": await identityFixture.keys(product.issuer, "synthetic-access"),
      "synthetic-id": await identityFixture.keys(product.issuer, "synthetic-id"),
    };
  const start = async () => {
    const child = spawn(process.execPath, ["--import", "tsx", "accounts/testing/google-harness.ts"], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let buffer = "";
    const queue: Array<(value: any) => void> = [];
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (let index; (index = buffer.indexOf("\n")) >= 0; ) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        queue.shift()!(JSON.parse(line));
      }
    });
    const call = (message: any) =>
      new Promise<any>((resolve) => {
        queue.push(resolve);
        child.stdin.write(JSON.stringify(message) + "\n");
      });
    const configured = await call({
      op: "configure",
      nowSeconds: identityFixture.now,
      products: identityFixture.products,
      keys,
      filesystemRoot: environment.root,
      durableAccounts: true,
    });
    assert.equal(configured.configured, true);
    return {
      call,
      request: (event: any) => call({ op: "request", event }),
      stop: () =>
        new Promise<void>((resolve) => {
          child.once("close", () => resolve());
          child.stdin.end();
        }),
    };
  };
  let central = await start();
  const enrolled: Array<{
    pair: ReturnType<typeof identityFixture.pair>;
    person: Person;
    create: ReturnType<typeof identityFixture.event>;
    account: { id: string };
  }> = [];
  try {
    for (let index = 0; index < 2; index++) {
      const challenge = JSON.parse(
          (await central.request(identityFixture.event(index, "/v1/identities/google/challenge"))).body,
        ),
        pair = identityFixture.pair(index, challenge.nonce);
      const resolved = await central.request(
        identityFixture.event(
          index,
          "/v1/identities/google/resolve",
          { challengeId: challenge.challengeId },
          pair,
        ),
      );
      assert.equal(resolved.statusCode, 200);
      const create = identityFixture.event(
        index,
        "/v1/accounts",
        { name: `Synthetic product ${index}` },
        pair,
      );
      create.headers!["idempotency-key"] = randomUUID();
      const response = await central.request(create);
      assert.equal(response.statusCode, 200);
      enrolled.push({
        pair,
        person: JSON.parse(resolved.body).person,
        create,
        account: JSON.parse(response.body).account,
      });
    }
    assert.equal(enrolled[0].person.id, enrolled[1].person.id);
    assert.notEqual(enrolled[0].account.id, enrolled[1].account.id);
    await central.stop();
    central = await start();
    for (let index = 0; index < 2; index++) {
      const state = enrolled[index];
      const listed = await central.request(
        identityFixture.event(index, "/v1/accounts", {}, state.pair, "GET"),
      );
      assert.equal(listed.statusCode, 200);
      assert.equal(JSON.parse(listed.body).person.id, state.person.id);
      assert.deepEqual(
        JSON.parse(listed.body).accounts.map((account: any) => account.id),
        [state.account.id],
      );
      const retry = await central.request(state.create);
      assert.equal(JSON.parse(retry.body).account.id, state.account.id);
      const other = await central.request(
        identityFixture.event(index, `/v1/accounts/${enrolled[1 - index].account.id}`, {}, state.pair, "GET"),
      );
      assert.equal(other.statusCode, 403);
    }
  } finally {
    await central.stop();
  }
});

test("native accounts and identity bridges refuse each other's canonical domain", async () => {
  const environment = await fixture();
  await assert.rejects(environment.files.get(`google/${"a".repeat(64)}.json`), code("invalid"));
  await assert.rejects(
    new VirtuusIdentityFiles(environment.root).get(`accounts/${randomUUID()}.json`),
    code("invalid"),
  );
});
