import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DurableAccountsService, accountCreationLimits, type MembershipLookup } from "./durable-accounts";
import { VirtuusAccountFiles } from "./identity-files";
import { roleOperations, type Context, type Person } from "./model";

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function fixture(
  lookup: MembershipLookup,
  limits = accountCreationLimits({ default: 3, cyclotron: 1 }),
) {
  const root = await mkdtemp(join(tmpdir(), "prospectus-creation-limit-"));
  roots.push(root);
  const people: Record<string, Person> = Object.fromEntries(
    ["ada", "grace"].map((subject) => [subject, { id: randomUUID(), createdAt: "2030-03-17T17:46:40.000Z" }]),
  );
  const directory = {
    resolve: async (context: Context) => people[context.human.subject] ?? null,
    get: async (id: string) => Object.values(people).find((person) => person.id === id) ?? null,
  };
  const service = new DurableAccountsService(
    new VirtuusAccountFiles(root),
    directory,
    () => "2030-03-17T17:46:40.000Z",
    lookup,
    limits,
  );
  const as = (subject: string, product: string): Context => ({
    product,
    principal: "synthetic-runtime",
    human: { issuer: "synthetic", subject },
    capabilities: [...roleOperations.owner],
  });
  return { service, as };
}

for (const lookup of ["scan", "indexed"] as const)
  test(`a Person can create only the configured number of accounts per product (${lookup} lookup)`, async () => {
    const { service, as } = await fixture(lookup);
    const keys = [randomUUID(), randomUUID(), randomUUID()];
    for (const [index, key] of keys.entries())
      await service.create(as("ada", "anthus-one"), `Workspace ${index}`, key);
    await assert.rejects(service.create(as("ada", "anthus-one"), "One too many", randomUUID()), {
      status: 409,
      code: "account_limit",
    });
    // Replaying a request key that already created an account is not a new account.
    const replay = await service.create(as("ada", "anthus-one"), "Workspace 0", keys[0]);
    assert.equal(replay.name, "Workspace 0");
    // The limit is per Person and per product, and a product may have its own.
    await service.create(as("grace", "anthus-one"), "Grace's workspace", randomUUID());
    await service.create(as("ada", "cyclotron"), "Lab", randomUUID());
    await assert.rejects(service.create(as("ada", "cyclotron"), "Second lab", randomUUID()), {
      code: "account_limit",
    });
    // Listing still works and shows exactly what was created.
    assert.equal((await service.list(as("ada", "anthus-one"))).accounts.length, 3);
  });

test("without configured limits creation is unbounded, as before", async () => {
  const { service, as } = await fixture("scan", {});
  for (let index = 0; index < 5; index++)
    await service.create(as("ada", "anthus-one"), `W${index}`, randomUUID());
  assert.equal((await service.list(as("ada", "anthus-one"))).accounts.length, 5);
});

test("limits must be whole numbers for named products", () => {
  assert.deepEqual(accountCreationLimits({ default: 3, "anthus-one": 2 }), { default: 3, "anthus-one": 2 });
  assert.deepEqual(accountCreationLimits(undefined), {});
  for (const bad of [
    null,
    [],
    { default: 0 },
    { default: 1.5 },
    { default: "3" },
    { "Bad Name": 3 },
    { x: 99 },
  ])
    assert.throws(() => accountCreationLimits(bad), Error);
});
