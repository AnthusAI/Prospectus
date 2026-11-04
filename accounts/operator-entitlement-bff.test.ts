import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { directoryFixture } from "./testing/directory-fixture";
import { canonicalAccountsHandler } from "./canonical-handler";
import { VirtuusIdentityFiles, VirtuusAccountFiles } from "./identity-files";
import { registrations } from "./registration";
import { accountsBffHandler } from "./bff";
import { operatorGrants, operatorSubjectHash, type OperatorPermission } from "./operator-policy";
import { AccountsClient, decode } from "../packages/accounts-client/src/client";
import type { ProductRegistration } from "./auth";

/** The staff BFF in front of the real central handler, with the given reviewed operator permissions. */
async function staffBff(permissions: OperatorPermission[]) {
  const environment = await directoryFixture();
  const products: ProductRegistration[] = [
    ...environment.products,
    {
      ...environment.products[1],
      product: "cyclotron",
      roleArn: environment.products[1].roleArn.replace(/[^/]+$/, "SyntheticCyclotron"),
      accountDirectory: undefined,
      capabilities: ["console:read", "console:write"],
    },
  ];
  const central = canonicalAccountsHandler(
    new VirtuusIdentityFiles(environment.root),
    new VirtuusAccountFiles(environment.root),
    registrations(products),
    environment.identityFixture.keys,
    () => environment.identityFixture.now,
    operatorGrants(
      permissions.map((permission) => ({
        product: environment.outsider.context.product,
        issuer: environment.outsider.context.human.issuer,
        subjectHash: operatorSubjectHash(environment.outsider.context.human.subject),
        permission,
        reviewedGrantId: "synthetic-approval-v1",
      })),
    ),
  );
  const forwarded: string[] = [];
  const bff = (surface: "staff" | "customer" = "staff") =>
    accountsBffHandler({
      surface,
      origins: ["https://prospectus.anth.us"],
      registration: environment.products[0],
      keys: environment.identityFixture.keys,
      nowSeconds: () => environment.identityFixture.now,
      client: (access) =>
        new AccountsClient(async (path, method, body) => {
          forwarded.push(`${method} ${path}`);
          const event = environment.identityFixture.event(
            0,
            path,
            body ?? {},
            environment.outsider.proof,
            method,
          );
          event.headers!["x-prospectus-human-token"] = access;
          const response = await central(event);
          return decode(new Response(response.body, { status: response.statusCode }));
        }),
    });
  const path = (product: string, id = environment.account.id) =>
    `/api/saas/operator/accounts/${id}/entitlements/${product}`;
  const post = (rawPath: string, body: unknown, origin = "https://prospectus.anth.us") => ({
    rawPath,
    requestContext: { http: { method: "POST" } },
    headers: {
      authorization: `Bearer ${environment.outsider.proof.access}`,
      origin,
      "content-type": "application/json",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const entitlements = async () =>
    JSON.parse(
      (
        await central(
          environment.identityFixture.event(
            0,
            `/v1/account-directory/operator/accounts/${environment.account.id}`,
            {},
            environment.outsider.proof,
            "GET",
          ),
        )
      ).body,
    ).account.entitlements as Array<{ product: string; status: string }>;
  return { environment, bff, forwarded, path, post, entitlements };
}

test("the staff BFF turns a product on and off for an Account through central", async () => {
  const { environment, bff, path, post, entitlements } = await staffBff([
    "accounts:admin:read",
    "accounts:admin:entitlements",
  ]);
  try {
    const handler = bff();
    const on = await handler(post(path("cyclotron"), { status: "active" }));
    assert.equal(on.statusCode, 200);
    assert.equal(JSON.parse(on.body).entitlement.status, "active");
    assert.equal((await entitlements()).find((item) => item.product === "cyclotron")?.status, "active");
    const off = await handler(post(path("cyclotron"), { status: "disabled" }));
    assert.equal(off.statusCode, 200);
    assert.equal((await entitlements()).find((item) => item.product === "cyclotron")?.status, "disabled");
    assert.equal(
      (await entitlements()).find((item) => item.product === "papyrus")?.status,
      "active",
      "other products are unchanged",
    );
  } finally {
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("an operator without the entitlements permission is refused with a clear message and nothing changes", async () => {
  const { environment, bff, path, post, entitlements } = await staffBff(["accounts:admin:read"]);
  try {
    const response = await bff()(post(path("cyclotron"), { status: "active" }));
    assert.equal(response.statusCode, 403);
    assert.equal(JSON.parse(response.body).error, "operator_forbidden");
    assert.match(JSON.parse(response.body).message, /entitlements permission/);
    assert.ok(!(await entitlements()).some((item) => item.product === "cyclotron"));
    const unregistered = await bff()(post(path("unregistered"), { status: "active" }));
    assert.equal(unregistered.statusCode, 403, "permission is checked before the product");
  } finally {
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("the staff BFF reports an unregistered product and refuses anything but exactly a status", async () => {
  const { environment, bff, forwarded, path, post } = await staffBff([
    "accounts:admin:read",
    "accounts:admin:entitlements",
  ]);
  try {
    const handler = bff();
    const missing = await handler(post(path("unregistered"), { status: "active" }));
    assert.equal(missing.statusCode, 404);
    const before = forwarded.length;
    for (const body of [
      {},
      { status: "banned" },
      { status: "active", capabilities: ["members:write"] },
      { status: "active", extra: 1 },
      { status: 1 },
      "[]",
      "not json",
    ])
      assert.equal((await handler(post(path("cyclotron"), body))).statusCode, 400, JSON.stringify(body));
    assert.equal(
      (await handler(post(path("cyclotron"), { status: "active" }, "https://wrong.invalid"))).statusCode,
      403,
    );
    assert.equal((await handler(post(path("Cyclotron"), { status: "active" }))).statusCode, 404);
    assert.equal(
      (await handler(post(path("cyclotron", "not-a-uuid"), { status: "active" }))).statusCode,
      404,
    );
    assert.equal(forwarded.length, before, "nothing malformed reaches central");
  } finally {
    await rm(environment.root, { recursive: true, force: true });
  }
});
