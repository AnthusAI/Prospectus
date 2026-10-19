import { registrations } from "./registration";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DurableAccountsService, type AccountDocument } from "./durable-accounts";
import { VirtuusAccountFiles, VirtuusIdentityFiles } from "./identity-files";
import { type Context, type Person, roleOperations } from "./model";
import { directoryFixture } from "./testing/directory-fixture";
import { canonicalAccountsHandler } from "./canonical-handler";
import { operatorSubjectHash, operatorGrants, type OperatorPermission } from "./operator-policy";
import type { ProductRegistration } from "./auth";
const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});
const fixedTimestamp = "2030-03-17T17:46:40.000Z";
const forbidden = (error: any) => error.code === "forbidden";
async function serviceFixture() {
  const root = await mkdtemp(join(tmpdir(), "prospectus-product-entitlements-"));
  roots.push(root);
  const people: Record<string, Person> = Object.fromEntries(
    ["owner", "member", "operator"].map((subject) => [
      subject,
      { id: randomUUID(), createdAt: fixedTimestamp },
    ]),
  );
  const contextFor = (subject: string, product: string): Context => ({
    product,
    principal: "synthetic-runtime",
    human: { issuer: "synthetic", subject },
    capabilities: [...roleOperations.owner],
  });
  const directory = {
    resolve: async (context: Context) => people[context.human.subject] ?? null,
    get: async (id: string) => Object.values(people).find((person) => person.id === id) ?? null,
  };
  const files = new VirtuusAccountFiles(root),
    service = new DurableAccountsService(files, directory, () => fixedTimestamp);
  return { people, contextFor, files, service };
}

test("granting a product lets members use it and disabling it denies only that product", async () => {
  const environment = await serviceFixture(),
    cyclotronLab = { product: "cyclotron", capabilities: ["console:read", "console:write"] as const };
  const account = await environment.service.create(
    environment.contextFor("owner", "papyrus"),
    "Newsroom",
    randomUUID(),
  );
  await environment.service.setMembership(
    environment.contextFor("owner", "papyrus"),
    account.id,
    environment.people.member.id,
    "member",
    "active",
  );
  await assert.rejects(
    environment.service.authorize(environment.contextFor("member", "cyclotron"), account.id, "console:read"),
    forbidden,
  );
  const granted = await environment.service.setEntitlement(
    environment.contextFor("operator", "prospectus-directory"),
    account.id,
    cyclotronLab,
    "active",
  );
  assert.deepEqual(granted, {
    accountId: account.id,
    product: "cyclotron",
    status: "active",
    capabilities: ["console:read", "console:write"],
  });
  assert.equal(
    (
      await environment.service.authorize(
        environment.contextFor("member", "cyclotron"),
        account.id,
        "console:write",
      )
    ).personId,
    environment.people.member.id,
  );
  await assert.rejects(
    environment.service.authorize(environment.contextFor("owner", "cyclotron"), account.id, "members:write"),
    forbidden,
  );
  assert.deepEqual(
    await environment.service.setEntitlement(
      environment.contextFor("operator", "prospectus-directory"),
      account.id,
      cyclotronLab,
      "active",
    ),
    granted,
  );
  await environment.service.setEntitlement(
    environment.contextFor("operator", "prospectus-directory"),
    account.id,
    cyclotronLab,
    "disabled",
  );
  await assert.rejects(
    environment.service.authorize(environment.contextFor("member", "cyclotron"), account.id, "console:read"),
    forbidden,
  );
  assert.equal(
    (
      await environment.service.authorize(
        environment.contextFor("member", "papyrus"),
        account.id,
        "console:write",
      )
    ).personId,
    environment.people.member.id,
  );
  const stored = (await environment.files.get<AccountDocument>(`accounts/${account.id}.json`))!.value;
  assert.equal(stored.memberships[environment.people.member.id].status, "active");
  assert.deepEqual(
    stored.audit.map((event) => [event.type, event.target, event.status, event.actor]).slice(2),
    [
      ["entitlement.changed", "cyclotron", "active", environment.people.operator.id],
      ["entitlement.changed", "cyclotron", "disabled", environment.people.operator.id],
    ],
  );
  assert.equal(stored.account.revision, 4);
});

test("granting a product to a missing account or with an unknown status is refused", async () => {
  const environment = await serviceFixture(),
    operator = environment.contextFor("operator", "prospectus-directory");
  await assert.rejects(
    environment.service.setEntitlement(
      operator,
      randomUUID(),
      { product: "cyclotron", capabilities: ["console:read"] },
      "active",
    ),
    (error: any) => error.code === "account_missing",
  );
  const account = await environment.service.create(
    environment.contextFor("owner", "papyrus"),
    "Newsroom",
    randomUUID(),
  );
  await assert.rejects(
    environment.service.setEntitlement(
      operator,
      account.id,
      { product: "cyclotron", capabilities: ["console:read"] },
      "deleted" as any,
    ),
    (error: any) => error.code === "invalid_entitlement",
  );
});

test("account reads, creation and membership refuse an array-wrapped or numeric identifier", async () => {
  const environment = await serviceFixture(),
    owner = environment.contextFor("owner", "papyrus");
  const account = await environment.service.create(owner, "Newsroom", randomUUID());
  const arrayWrappedAccountId = [account.id] as any,
    arrayWrappedPersonId = [environment.people.member.id] as any,
    arrayWrappedRequestId = [randomUUID()] as any;
  await assert.rejects(
    environment.service.read(arrayWrappedAccountId),
    (error: any) => error.status === 400 && error.code === "account",
  );
  await assert.rejects(
    environment.service.read(5 as any),
    (error: any) => error.status === 400 && error.code === "account",
  );
  await assert.rejects(
    environment.service.create(owner, "Other", arrayWrappedRequestId),
    (error: any) => error.status === 400 && error.code === "invalid",
  );
  await assert.rejects(
    environment.service.create(owner, "Other", 5 as any),
    (error: any) => error.status === 400 && error.code === "invalid",
  );
  for (const personId of [arrayWrappedPersonId, 5 as any]) {
    await assert.rejects(
      environment.service.setMembership(owner, account.id, personId, "member", "active"),
      (error: any) => error.status === 400 && error.code === "invalid_membership",
    );
  }
});

test("granting a product refuses a missing or non-string product name", async () => {
  const environment = await serviceFixture(),
    operator = environment.contextFor("operator", "prospectus-directory");
  const account = await environment.service.create(
    environment.contextFor("owner", "papyrus"),
    "Newsroom",
    randomUUID(),
  );
  for (const product of [undefined, null, 5, ["cyclotron"]]) {
    await assert.rejects(
      environment.service.setEntitlement(
        operator,
        account.id,
        { product, capabilities: ["console:read"] } as any,
        "active",
      ),
      (error: any) => error.code === "invalid_entitlement" && error.status === 400,
    );
  }
});

test("the operator entitlement route requires the reviewed entitlements permission and a registered product", async () => {
  const environment = await directoryFixture();
  try {
    const products: ProductRegistration[] = [
      ...environment.products,
      {
        ...environment.products[1],
        product: "cyclotron",
        roleArn: "arn:aws:iam::111111111111:role/SyntheticCyclotron",
        accountDirectory: undefined,
        capabilities: ["console:read", "console:write"],
      },
    ];
    const grantFor = (permission: OperatorPermission) => ({
      product: environment.outsider.context.product,
      issuer: environment.outsider.context.human.issuer,
      subjectHash: operatorSubjectHash(environment.outsider.context.human.subject),
      permission,
      reviewedGrantId: "synthetic-approval-v1",
    });
    const central = (permissions: OperatorPermission[]) =>
      canonicalAccountsHandler(
        new VirtuusIdentityFiles(environment.root),
        new VirtuusAccountFiles(environment.root),
        registrations(products),
        environment.identityFixture.keys,
        () => environment.identityFixture.now,
        operatorGrants(permissions.map(grantFor)),
      );
    const entitlementPath = (product: string) =>
      `/v1/account-directory/operator/accounts/${environment.account.id}/entitlements/${product}`;
    const post = (
      handler: ReturnType<typeof central>,
      path: string,
      body: unknown,
      proof = environment.outsider.proof,
    ) => handler(environment.identityFixture.event(0, path, body, proof, "POST"));
    assert.equal(
      (await post(central(["accounts:admin:read"]), entitlementPath("cyclotron"), { status: "active" }))
        .statusCode,
      403,
      "read access never grants products",
    );
    const operator = central(["accounts:admin:read", "accounts:admin:entitlements"]);
    assert.equal(
      (
        await post(
          operator,
          entitlementPath("cyclotron"),
          { status: "active" },
          environment.ownerDirectory.proof,
        )
      ).statusCode,
      403,
      "account owners cannot grant products",
    );
    assert.equal(
      (await post(operator, entitlementPath("unregistered"), { status: "active" })).statusCode,
      404,
    );
    assert.equal(
      (
        await post(operator, entitlementPath("cyclotron"), {
          status: "active",
          capabilities: ["members:write"],
        })
      ).statusCode,
      400,
    );
    const withoutJsonContentType = environment.identityFixture.event(
      0,
      entitlementPath("cyclotron"),
      { status: "active" },
      environment.outsider.proof,
      "POST",
    );
    withoutJsonContentType.headers!["content-type"] = "text/plain";
    assert.equal((await operator(withoutJsonContentType)).statusCode, 415);
    assert.equal(
      (
        await operator({
          ...environment.identityFixture.event(
            0,
            entitlementPath("cyclotron"),
            { status: "active" },
            environment.outsider.proof,
            "POST",
          ),
          isBase64Encoded: true,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (await post(operator, entitlementPath("cyclotron"), { status: "active", padding: "x".repeat(12001) }))
        .statusCode,
      400,
    );
    const granted = await post(operator, entitlementPath("cyclotron"), { status: "active" });
    assert.equal(granted.statusCode, 200);
    assert.deepEqual(JSON.parse(granted.body).entitlement, {
      accountId: environment.account.id,
      product: "cyclotron",
      status: "active",
      capabilities: ["console:read", "console:write"],
    });
    const memberProducts = async () =>
      JSON.parse(
        (
          await operator(
            environment.identityFixture.event(
              0,
              "/v1/account-directory",
              {},
              environment.memberDirectory.proof,
              "GET",
            ),
          )
        ).body,
      ).accounts[0].products;
    assert.deepEqual(await memberProducts(), [
      { product: "cyclotron", status: "active" },
      { product: "papyrus", status: "active" },
    ]);
    assert.equal(
      (await post(operator, entitlementPath("cyclotron"), { status: "disabled" })).statusCode,
      200,
    );
    assert.deepEqual(await memberProducts(), [
      { product: "cyclotron", status: "disabled" },
      { product: "papyrus", status: "active" },
    ]);
  } finally {
    await rm(environment.root, { recursive: true, force: true });
  }
});
