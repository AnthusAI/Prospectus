import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalAccountsHandler } from "./canonical-handler";
import {
  VirtuusIdentityFiles,
  VirtuusAccountFiles,
  IdentityFileError,
  type IdentityFiles,
} from "./identity-files";
import { DurableGoogleIdentities } from "./durable-google-identities";
import { registrations, type ValidatedRegistrations } from "./registration";
import { context, type ProductRegistration, type RestEvent } from "./auth";
import { googleFixture } from "./testing/google-fixture";
const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});
const worker = "arn:aws:iam::111111111111:role/SyntheticWorker";
function paired(base: readonly ProductRegistration[]): ValidatedRegistrations {
  const products = structuredClone(base),
    delegatingRegistration = products[0];
  delegatingRegistration.capabilities = ["console:read", "console:write", "members:read", "members:write"];
  delegatingRegistration.executionDelegation = {
    roleArn: worker,
    enrollmentRoleArn: delegatingRegistration.roleArn,
    issuer: delegatingRegistration.issuer,
    clientId: delegatingRegistration.googleFederation!.clientId,
    enrollmentPolicyRevision: delegatingRegistration.googleFederation!.reviewedPolicyId,
    reviewedPolicyId: "synthetic-execution-review-v1",
  };
  return registrations(products);
}
async function fixture() {
  const identityFixture = googleFixture(),
    products = paired(identityFixture.products),
    root = await mkdtemp(join(tmpdir(), "prospectus-delegation-"));
  roots.push(root);
  const identities = new VirtuusIdentityFiles(root),
    accounts = new VirtuusAccountFiles(root);
  const make = (
    registry = products,
    identityFiles: IdentityFiles = identities,
    accountFiles: IdentityFiles = accounts,
  ) =>
    canonicalAccountsHandler(
      identityFiles,
      accountFiles,
      registry,
      identityFixture.keys,
      () => identityFixture.now,
    );
  const handler = make();
  const run = async (event: RestEvent, target = handler) => {
    const result = await target(event);
    return { status: result.statusCode, body: JSON.parse(result.body) };
  };
  const challenge = (await run(identityFixture.event(0, "/v1/identities/google/challenge"))).body;
  const proof = identityFixture.pair(0, challenge.nonce),
    enrolled = await run(
      identityFixture.event(
        0,
        "/v1/identities/google/resolve",
        { challengeId: challenge.challengeId },
        proof,
      ),
    );
  assert.equal(enrolled.status, 200);
  const create = identityFixture.event(0, "/v1/accounts", { name: "Synthetic execution account" }, proof);
  create.headers!["idempotency-key"] = randomUUID();
  const created = await run(create);
  assert.equal(created.status, 200);
  const id = created.body.account.id as string;
  const event = (path = "/v1/identities/me", method = "GET", body: unknown = {}, token = proof) => {
    const builtEvent = identityFixture.event(0, path, body, token, method);
    builtEvent.requestContext!.identity!.userArn =
      "arn:aws:sts::111111111111:assumed-role/SyntheticWorker/synthetic-session";
    // Execution needs only access evidence, never the callback ID proof.
    delete builtEvent.headers!["x-prospectus-identity-token"];
    return builtEvent;
  };
  return {
    identityFixture,
    products,
    identities,
    accounts,
    make,
    handler,
    run,
    proof,
    person: enrolled.body.person,
    id,
    event,
    authorize: (operation = "console:read") => event(`/v1/accounts/${id}/authorize`, "POST", { operation }),
  };
}
test("paired execution survives canonical restart without changing original provenance", async () => {
  const environment = await fixture(),
    repo = new DurableGoogleIdentities(environment.identities),
    before = await repo.find(environment.products[0].issuer, "synthetic-pool-person-0");
  assert.equal((await environment.run(environment.event())).body.person.id, environment.person.id);
  const result = await environment.run(environment.authorize("console:write"), environment.make());
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    allowed: true,
    accountId: environment.id,
    personId: environment.person.id,
    product: "cyclotron",
    role: "owner",
    operation: "console:write",
    revision: 1,
  });
  const verified = await context(
    environment.authorize(),
    environment.products,
    environment.identityFixture.keys,
    environment.identityFixture.now,
  );
  assert.equal(verified.principal, worker);
  assert.deepEqual(verified.capabilities, ["console:read", "console:write"]);
  assert.deepEqual(
    await new DurableGoogleIdentities(environment.identities).find(
      environment.products[0].issuer,
      "synthetic-pool-person-0",
    ),
    before,
  );
  assert.equal(before!.alias.sessions[0].binding.principal, environment.products[0].roleArn);
  assert.ok(!before!.alias.provenance.some((binding) => binding.principal === worker));
});
test("production composition fractional wall clock emits integer challenge expiry", async (testContext) => {
  const environment = await fixture(),
    now = environment.identityFixture.now + 0.625;
  testContext.mock.method(Date, "now", () => now * 1000);
  // Omit the fixture clock: exercise the production factory's actual default,
  // which passes fractional seconds into the identity handler.
  const production = canonicalAccountsHandler(
    environment.identities,
    environment.accounts,
    environment.products,
    environment.identityFixture.keys,
  );
  const issued = await environment.run(
    environment.identityFixture.event(0, "/v1/identities/google/challenge"),
    production,
  );
  assert.equal(issued.status, 200);
  const challenge = issued.body;
  assert.ok(Number.isSafeInteger(challenge.expiresAt));
  assert.equal(challenge.expiresAt, Math.floor(now) + 300);
  assert.ok(now < challenge.expiresAt);
  assert.ok(challenge.expiresAt <= now + 300);
  const stored = (await environment.identities.get(`logins/${challenge.challengeId}.json`))!;
  assert.equal(stored.value.challenge.issuedAt, Math.floor(now));
  assert.equal(stored.value.challenge.expiresAt, challenge.expiresAt);
  const proof = environment.identityFixture.pair(0, challenge.nonce);
  const resolved = await environment.run(
    environment.identityFixture.event(
      0,
      "/v1/identities/google/resolve",
      { challengeId: challenge.challengeId },
      proof,
    ),
    production,
  );
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.person.id, environment.person.id);
});
test("worker route/method/operation negative matrix denies before canonical writes", async (testContext) => {
  const environment = await fixture(),
    before = await environment.accounts.get(`accounts/${environment.id}.json`);
  let writes = 0;
  const observe = (files: IdentityFiles): IdentityFiles => ({
    get: (path) => files.get(path),
    list: (prefix) => files.list(prefix),
    commit: async (...args) => {
      writes++;
      return files.commit(...args);
    },
  });
  const target = environment.make(
    environment.products,
    observe(environment.identities),
    observe(environment.accounts),
  );
  const paths: Array<[string, string, unknown]> = [
    ["/v1/identities/google/challenge", "POST", {}],
    ["/v1/identities/google/resolve", "POST", { challengeId: randomUUID() }],
    ["/v1/identities/resolve", "POST", {}],
    ["/v1/identities/link", "POST", {}],
    ["/v1/accounts", "GET", {}],
    ["/v1/accounts", "POST", { name: "Denied" }],
    [`/v1/accounts/${environment.id}`, "GET", {}],
    [
      `/v1/accounts/${environment.id}/memberships`,
      "POST",
      { personId: environment.person.id, role: "owner", status: "active" },
    ],
    ["/v1/account-directory", "GET", {}],
    [`/v1/account-directory/${environment.id}`, "GET", {}],
    ["/v1/identities/me", "POST", {}],
    ["/v1/identities/me/", "GET", {}],
    [`/v1/accounts/${environment.id}/authorize`, "GET", {}],
    [`/v1/accounts/${environment.id}/authorize/extra`, "POST", {}],
    [`/v1/accounts/${"a".repeat(36)}/authorize`, "POST", { operation: "console:read" }],
  ];
  for (const [path, method, body] of paths)
    await testContext.test(`${method} ${path}`, async () =>
      assert.equal((await environment.run(environment.event(path, method, body), target)).status, 403),
    );
  for (const operation of ["members:read", "members:write"])
    await testContext.test(operation, async () =>
      assert.equal((await environment.run(environment.authorize(operation), target)).status, 403),
    );
  assert.deepEqual(await environment.accounts.get(`accounts/${environment.id}.json`), before);
  assert.equal(writes, 0);
});
test("unlisted, disabled and removed pairs fail closed on the next request", async (testContext) => {
  const environment = await fixture();
  const variants: Array<[string, (productRegistrations: ProductRegistration[]) => void]> = [
    ["removed", (productRegistrations) => delete productRegistrations[0].executionDelegation],
    ["disabled", (productRegistrations) => (productRegistrations[0].enabled = false)],
    [
      "different worker",
      (productRegistrations) =>
        (productRegistrations[0].executionDelegation!.roleArn =
          "arn:aws:iam::111111111111:role/SyntheticOtherWorker"),
    ],
    [
      "changed policy",
      (productRegistrations) => {
        productRegistrations[0].googleFederation!.reviewedPolicyId = "synthetic-review-v2";
        productRegistrations[0].executionDelegation!.enrollmentPolicyRevision = "synthetic-review-v2";
      },
    ],
    ["different product", (productRegistrations) => (productRegistrations[0].product = "other-product")],
    [
      "different enrolling principal",
      (productRegistrations) => {
        productRegistrations[0].roleArn = "arn:aws:iam::111111111111:role/SyntheticNewBff";
        productRegistrations[0].executionDelegation!.enrollmentRoleArn = productRegistrations[0].roleArn;
      },
    ],
    [
      "different registered client",
      (productRegistrations) => {
        productRegistrations[0].clientIds = ["newclient"];
        productRegistrations[0].googleFederation!.clientId = "newclient";
        productRegistrations[0].executionDelegation!.clientId = "newclient";
      },
    ],
    [
      "different registered issuer",
      (productRegistrations) => {
        productRegistrations[0].issuer = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_SyntheticNew";
        productRegistrations[0].executionDelegation!.issuer = productRegistrations[0].issuer;
      },
    ],
  ];
  for (const [name, change] of variants)
    await testContext.test(name, async () => {
      const productRegistrations = structuredClone([...environment.products]);
      change(productRegistrations);
      const handler = environment.make(registrations(productRegistrations));
      for (const event of [environment.event(), environment.authorize()]) {
        const result = await environment.run(event, handler);
        assert.ok(result.status >= 400 || result.body.person === null);
        assert.notEqual(result.body.allowed, true);
      }
    });
  for (const [name, arn, accountId] of [
    ["unknown", "arn:aws:sts::111111111111:assumed-role/Unknown/s", "111111111111"],
    ["cross-account", "arn:aws:sts::222222222222:assumed-role/SyntheticWorker/s", "222222222222"],
    ["static IAM", "arn:aws:iam::111111111111:role/SyntheticWorker", "111111111111"],
  ])
    await testContext.test(name, async () => {
      const builtEvent = environment.event();
      builtEvent.requestContext!.identity = { userArn: arn, accountId };
      assert.equal((await environment.run(builtEvent)).status, 403);
    });
  const readonlyProducts = structuredClone([...environment.products]);
  readonlyProducts[0].capabilities = ["console:read"];
  const readonly = registrations(readonlyProducts);
  assert.equal(
    (await environment.run(environment.authorize("console:write"), environment.make(readonly))).status,
    403,
  );
  assert.equal((await environment.run(environment.authorize(), environment.make(readonly))).status, 200);
  assert.equal(
    (
      await environment.run(
        environment.event(`/v1/accounts/${environment.id}/authorize`, "POST", {
          operation: "console:write",
          principal: environment.products[0].roleArn,
        }),
      )
    ).status,
    400,
  );
});
test("cross-product/client/issuer, session family and invalid access never authorize", async (testContext) => {
  const environment = await fixture();
  const cases: Array<[string, ReturnType<typeof environment.identityFixture.pair>]> = [
    ["cross product issuer", environment.identityFixture.pair(1, "irrelevant")],
    [
      "wrong client",
      environment.identityFixture.pair(0, "irrelevant", "synthetic-google-a", { client_id: "outside" }),
    ],
    [
      "wrong issuer",
      environment.identityFixture.pair(0, "irrelevant", "synthetic-google-a", {
        iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Outside",
      }),
    ],
    [
      "unknown subject",
      environment.identityFixture.pair(0, "irrelevant", "synthetic-google-a", { sub: "unknown" }),
    ],
    [
      "new family",
      environment.identityFixture.pair(0, "irrelevant", "synthetic-google-a", { origin_jti: "new-family" }),
    ],
    [
      "changed auth time",
      environment.identityFixture.pair(0, "irrelevant", "synthetic-google-a", {
        auth_time: environment.identityFixture.now - 1,
      }),
    ],
    [
      "missing family",
      environment.identityFixture.pair(0, "irrelevant", "synthetic-google-a", { origin_jti: null }),
    ],
    [
      "expired",
      environment.identityFixture.pair(0, "irrelevant", "synthetic-google-a", {
        exp: environment.identityFixture.now,
      }),
    ],
  ];
  const forged = {
    ...environment.proof,
    access:
      environment.proof.access.slice(0, environment.proof.access.lastIndexOf(".") + 1) +
      Buffer.alloc(256).toString("base64url"),
  };
  cases.push(["forged", forged]);
  for (const [name, proof] of cases)
    await testContext.test(name, async () => {
      const me = await environment.run(environment.event("/v1/identities/me", "GET", {}, proof));
      assert.ok(me.status >= 400 || me.body.person === null);
      assert.ok(
        (
          await environment.run(
            environment.event(
              `/v1/accounts/${environment.id}/authorize`,
              "POST",
              { operation: "console:write" },
              proof,
            ),
          )
        ).status >= 400,
      );
    });
  // Continuation accepts a renewed JWT only within the originally enrolled family.
  environment.identityFixture.advance(30);
  const renewed = environment.identityFixture.pair(0, "unused", "synthetic-google-a", {
    auth_time: environment.identityFixture.now - 30,
  });
  assert.equal(
    (await environment.run(environment.event("/v1/identities/me", "GET", {}, renewed))).body.person.id,
    environment.person.id,
  );
});
test("worker authorization reads current canonical role, revocation and entitlement", async () => {
  const environment = await fixture(),
    location = `accounts/${environment.id}.json`;
  for (const [role, status, entitlement, read, write] of [
    ["viewer", "active", "active", 200, 403],
    ["member", "active", "active", 200, 200],
    ["member", "revoked", "active", 403, 403],
    ["owner", "active", "disabled", 403, 403],
  ] as const) {
    const stored = (await environment.accounts.get(location))!,
      document = structuredClone(stored.value);
    // Synthetic canonical external administration; retain a different active owner.
    const other = randomUUID();
    document.memberships[other] = {
      accountId: environment.id,
      personId: other,
      role: "owner",
      status: "active",
    };
    document.memberships[environment.person.id] = {
      accountId: environment.id,
      personId: environment.person.id,
      role,
      status,
    };
    document.entitlements.cyclotron.status = entitlement;
    await environment.accounts.commit(location, randomUUID(), "a".repeat(64), document, stored.revision);
    assert.equal((await environment.run(environment.authorize(), environment.make())).status, read);
    assert.equal(
      (await environment.run(environment.authorize("console:write"), environment.make())).status,
      write,
    );
  }
  assert.equal((await environment.run(environment.event())).status, 200); // Identity alone never grants account access.
  assert.equal(
    (
      await environment.run(
        environment.event(`/v1/accounts/${randomUUID()}/authorize`, "POST", { operation: "console:read" }),
      )
    ).status,
    403,
  );
});
test("missing or unavailable canonical persistence cannot grant execution", async () => {
  const environment = await fixture(),
    down: IdentityFiles = {
      get: async () => {
        throw new IdentityFileError("unavailable");
      },
      list: async () => {
        throw new IdentityFileError("unavailable");
      },
      commit: async () => {
        throw new IdentityFileError("unavailable");
      },
    };
  assert.equal(
    (await environment.run(environment.event(), environment.make(environment.products, down))).status,
    503,
  );
  assert.equal(
    (
      await environment.run(
        environment.authorize(),
        environment.make(environment.products, environment.identities, down),
      )
    ).status,
    503,
  );
});
test("a different enrolled Person and another product account cannot inherit access", async () => {
  const environment = await fixture();
  const challenge = (
    await environment.run(environment.identityFixture.event(0, "/v1/identities/google/challenge"))
  ).body;
  const other = environment.identityFixture.pair(
    0,
    challenge.nonce,
    "synthetic-google-other",
    { sub: "synthetic-other-person" },
    { sub: "synthetic-other-person" },
  );
  assert.equal(
    (
      await environment.run(
        environment.identityFixture.event(
          0,
          "/v1/identities/google/resolve",
          { challengeId: challenge.challengeId },
          other,
        ),
      )
    ).status,
    200,
  );
  const me = await environment.run(environment.event("/v1/identities/me", "GET", {}, other));
  assert.equal(me.status, 200);
  assert.notEqual(me.body.person.id, environment.person.id);
  assert.equal(
    (
      await environment.run(
        environment.event(
          `/v1/accounts/${environment.id}/authorize`,
          "POST",
          { operation: "console:read" },
          other,
        ),
      )
    ).status,
    403,
  );
  const p1 = (await environment.run(environment.identityFixture.event(1, "/v1/identities/google/challenge")))
      .body,
    proof = environment.identityFixture.pair(1, p1.nonce);
  assert.equal(
    (
      await environment.run(
        environment.identityFixture.event(
          1,
          "/v1/identities/google/resolve",
          { challengeId: p1.challengeId },
          proof,
        ),
      )
    ).body.person.id,
    environment.person.id,
  );
  const create = environment.identityFixture.event(1, "/v1/accounts", { name: "Other product" }, proof);
  create.headers!["idempotency-key"] = randomUUID();
  const account = (await environment.run(create)).body.account;
  assert.equal(
    (
      await environment.run(
        environment.event(`/v1/accounts/${account.id}/authorize`, "POST", { operation: "console:read" }),
      )
    ).status,
    403,
  );
});
test("registry rejects ambiguous/transitive/unreviewed or mismatched pairs", async (testContext) => {
  const base = paired(googleFixture().products);
  const changes: Array<[string, (productRegistrations: ProductRegistration[]) => void]> = [
    [
      "self",
      (productRegistrations) =>
        (productRegistrations[0].executionDelegation!.roleArn = productRegistrations[0].roleArn),
    ],
    [
      "other product enrolling role",
      (productRegistrations) =>
        (productRegistrations[0].executionDelegation!.roleArn = productRegistrations[1].roleArn),
    ],
    [
      "STS path collision",
      (productRegistrations) =>
        (productRegistrations[0].executionDelegation!.roleArn = productRegistrations[0].roleArn.replace(
          "role/",
          "role/path/",
        )),
    ],
    [
      "duplicate product",
      (productRegistrations) => (productRegistrations[1].product = productRegistrations[0].product),
    ],
    [
      "enrollment principal mismatch",
      (productRegistrations) =>
        (productRegistrations[0].executionDelegation!.enrollmentRoleArn = productRegistrations[1].roleArn),
    ],
    [
      "issuer mismatch",
      (productRegistrations) =>
        (productRegistrations[0].executionDelegation!.issuer = productRegistrations[1].issuer),
    ],
    [
      "client mismatch",
      (productRegistrations) =>
        (productRegistrations[0].executionDelegation!.clientId = productRegistrations[1].clientIds[0]),
    ],
    [
      "policy mismatch",
      (productRegistrations) =>
        (productRegistrations[0].executionDelegation!.enrollmentPolicyRevision = "other-review"),
    ],
    [
      "review absent",
      (productRegistrations) => (productRegistrations[0].executionDelegation!.reviewedPolicyId = ""),
    ],
    ["no federation", (productRegistrations) => delete productRegistrations[0].googleFederation],
    ["directory principal", (productRegistrations) => (productRegistrations[0].accountDirectory = true)],
    [
      "extra authority",
      (productRegistrations) => ((productRegistrations[0].executionDelegation as any).allowEnrollment = true),
    ],
    [
      "transitive",
      (productRegistrations) => {
        productRegistrations[1].executionDelegation = {
          ...productRegistrations[0].executionDelegation!,
          roleArn: productRegistrations[0].roleArn,
          enrollmentRoleArn: productRegistrations[1].roleArn,
          issuer: productRegistrations[1].issuer,
          clientId: productRegistrations[1].googleFederation!.clientId,
        };
      },
    ],
  ];
  for (const [name, change] of changes)
    await testContext.test(name, () => {
      const productRegistrations = structuredClone([...base]);
      change(productRegistrations);
      assert.throws(() => registrations(productRegistrations));
    });
  assert.equal(registrations(base).length, 2);
});
