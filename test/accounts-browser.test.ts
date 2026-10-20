import { test } from "node:test";
import assert from "node:assert/strict";
import { accountsBrowser, DirectoryError } from "../src/accounts-client";
test("accounts browser uses bearer BFF reads and preserves actual account response fields", async () => {
  const account = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Persisted account",
    role: "viewer",
    products: [{ product: "cyclotron", status: "active" }],
  };
  const calls: string[] = [];
  const client = accountsBrowser(
    "https://bff.example.invalid/api/saas",
    async (input, init) => {
      calls.push(String(input));
      assert.equal((init?.headers as any).authorization, "Bearer synthetic-token");
      assert.equal(init?.cache, "no-store");
      return new Response(
        JSON.stringify(
          calls.length === 1
            ? { person: { id: "p", createdAt: "2030-01-01" }, accounts: [account] }
            : {
                account: {
                  ...account,
                  entitlements: [],
                  memberships: [],
                  membershipsVisible: false,
                  revision: 3,
                  createdAt: "2030-01-01",
                },
              },
        ),
      );
    },
    () => "synthetic-token",
  );
  assert.equal((await client.list()).accounts[0].name, account.name);
  assert.equal((await client.detail(account.id)).revision, 3);
  assert.equal(calls.length, 2);
});
test("unconfigured account service never invents accounts or attempts network", async () => {
  let requested = false;
  const client = accountsBrowser(
    undefined,
    async () => {
      requested = true;
      throw new Error();
    },
    () => "synthetic",
  );
  assert.equal(client.configured, false);
  await assert.rejects(client.list(), /not been configured/);
  assert.equal(requested, false);
});
test("account authorization errors remain errors rather than empty success", async () => {
  for (const status of [401, 403, 503]) {
    const client = accountsBrowser(
      "https://bff.invalid",
      async () => new Response("{}", { status }),
      () => "synthetic",
    );
    await assert.rejects(
      client.list(),
      (error) => error instanceof DirectoryError && error.status === status,
    );
  }
});
test("malformed successful account responses become errors", async () => {
  const client = accountsBrowser(
    "https://bff.invalid",
    async () => new Response("{}"),
    () => "synthetic",
  );
  await assert.rejects(client.list(), /Invalid account response/);
  await assert.rejects(client.detail("11111111-1111-4111-8111-111111111111"), /Invalid account response/);
});
test("account creation posts only the name and request key and surfaces the server's plain message", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const client = accountsBrowser(
    "https://bff.example.invalid/api/saas",
    async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return calls.length === 1
        ? new Response(JSON.stringify({ message: "Enter an account name of 2 to 80 characters." }), {
            status: 400,
          })
        : new Response(
            JSON.stringify({ account: { id: "a", name: "Data Parade", role: "owner", products: [] } }),
          );
    },
    () => "synthetic-token",
  );
  await assert.rejects(client.create("x", "key-1"), /2 to 80 characters/);
  assert.equal((await client.create("Data Parade", "key-2")).role, "owner");
  assert.deepEqual(
    calls.map((call) => call.url),
    Array(2).fill("https://bff.example.invalid/api/saas/accounts"),
  );
  assert.deepEqual(calls[1].body, { name: "Data Parade", requestKey: "key-2" });
});
