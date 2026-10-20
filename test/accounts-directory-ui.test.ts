import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
test(
  "Accounts UI renders loading, error and confirmation, and shows no customer memberships to non-administrators",
  { skip: !process.env.PROSPECTUS_ACCOUNTS_UI },
  async () => {
    const server = await createServer({
      configFile: false,
      root: process.cwd(),
      server: { host: "127.0.0.1", port: 0 },
      resolve: { dedupe: ["react", "react-dom"] },
      logLevel: "error",
    });
    await server.listen();
    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    });
    try {
      const page = await browser.newPage(),
        errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      let mode = "loading",
        release: (() => void) | undefined;
      const posts: Array<{ name: string; requestKey: string }> = [];
      let failNextCreate = false;
      await page.route("**/directory-fixture/accounts**", async (route) => {
        if (route.request().method() === "POST") {
          posts.push(route.request().postDataJSON());
          if (failNextCreate) {
            failNextCreate = false;
            await route.fulfill({
              status: 503,
              body: JSON.stringify({ message: "Accounts are unavailable. Try again." }),
            });
            return;
          }
          await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
              account: {
                id: "22222222-2222-4222-8222-222222222222",
                name: posts.at(-1)!.name,
                role: "owner",
                products: [],
              },
            }),
          });
          return;
        }
        if (mode === "loading")
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        if (mode === "error") {
          await route.fulfill({ status: 503, body: "{}" });
          return;
        }
        const account = {
          id: "11111111-1111-4111-8111-111111111111",
          name: "Synthetic Alpha",
          role: mode === "admin" ? "admin" : "viewer",
          products: [{ product: "cyclotron", status: "active" }],
        };
        const detail = route.request().url().endsWith(account.id);
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(
            detail
              ? {
                  account: {
                    ...account,
                    createdAt: "2030-01-01",
                    revision: 1,
                    entitlements: [
                      {
                        accountId: account.id,
                        product: "cyclotron",
                        status: "active",
                        capabilities: ["console:read"],
                      },
                    ],
                    memberships: [{ personId: "synthetic-person", role: account.role, status: "active" }],
                    membershipsVisible: mode === "admin",
                  },
                }
              : {
                  person: mode === "identity" ? null : { id: "synthetic-person", createdAt: "2030-01-01" },
                  accounts: ["empty", "identity"].includes(mode) ? [] : [account],
                },
          ),
        });
      });
      const url = `${server.resolvedUrls!.local[0]}test/accounts-directory-fixture/index.html`;
      await page.goto(url);
      await expect(page.getByRole("status")).toHaveText("Loading accounts…");
      mode = "empty";
      release!();
      await expect(page.getByRole("status")).toContainText(
        "explicitly assigned central Accounts administrator permission",
      );
      mode = "error";
      await page.getByRole("button", { name: "Refresh accounts" }).click();
      await expect(page.getByRole("alert")).toContainText("could not be loaded");
      mode = "identity";
      await page.getByRole("button", { name: "Refresh accounts" }).click();
      await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
      const connect = page.getByRole("button", { name: "Continue with Google" });
      await expect(page.getByRole("heading", { name: "Finish signing in to Accounts" })).toBeVisible();
      const styles = await connect.evaluate((element) => {
        const style = getComputedStyle(element);
        return { border: style.borderTopWidth, padding: style.paddingLeft, minHeight: style.minHeight };
      });
      assert.deepEqual(styles, { border: "1px", padding: "14px", minHeight: "44px" });
      await expect(page.locator(".account-empty p")).toHaveCSS("user-select", "text");
      let connectCalls = 0,
        releaseConnect: (() => void) | undefined;
      await page.route("**/connect-fixture", async (route) => {
        connectCalls++;
        await new Promise<void>((resolve) => {
          releaseConnect = resolve;
        });
        await route.fulfill({ status: 503, body: "{}" });
      });
      await connect.dblclick({ force: true });
      await expect(page.getByRole("button", { name: "Opening Google…" })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Refresh accounts" })).toBeDisabled();
      releaseConnect!();
      await expect(page.getByRole("alert")).toContainText("Google confirmation could not be completed");
      await expect(connect).toBeEnabled();
      assert.equal(connectCalls, 1);
      // A customer with memberships but no administrator permission sees none of them in the staff console.
      mode = "viewer";
      await page.getByRole("button", { name: "Refresh accounts" }).click();
      await expect(page.getByRole("status")).toContainText(
        "explicitly assigned central Accounts administrator permission",
      );
      await expect(page.getByText("Synthetic Alpha")).toHaveCount(0);
      // Any signed-in person can create an organization; a failed submit retries with the same request key.
      const nameField = page.getByLabel("Organization name");
      const createButton = page.getByRole("button", { name: "Create organization" });
      await expect(createButton).toBeDisabled();
      await nameField.fill("  Data Parade ");
      failNextCreate = true;
      await createButton.click();
      await expect(page.getByRole("alert")).toContainText("Accounts are unavailable");
      await createButton.click();
      await expect(page.getByRole("status").filter({ hasText: "Created Data Parade." })).toBeVisible();
      assert.equal(posts.length, 2);
      assert.equal(posts[0].name, "Data Parade");
      assert.match(posts[0].requestKey, /^[0-9a-f-]{36}$/);
      assert.equal(posts[1].requestKey, posts[0].requestKey);
      await expect(nameField).toHaveValue("");
      await nameField.fill("Distinctive Mark");
      await createButton.click();
      await expect(page.getByRole("status").filter({ hasText: "Created Distinctive Mark." })).toBeVisible();
      assert.notEqual(posts[2].requestKey, posts[0].requestKey);
      await expect(page.getByRole("button", { name: "My memberships" })).toHaveCount(0);
      await page.goto(`${url}?mode=unconfigured`);
      await expect(page.getByRole("alert")).toContainText("not been configured");
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await server.close();
    }
  },
);

test(
  "operator directory is separate from memberships and reacts to denied access",
  { skip: !process.env.PROSPECTUS_ACCOUNTS_UI },
  async () => {
    const server = await createServer({
      configFile: false,
      root: process.cwd(),
      server: { host: "127.0.0.1", port: 0 },
      resolve: { dedupe: ["react", "react-dom"] },
      logLevel: "error",
    });
    await server.listen();
    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    });
    try {
      const page = await browser.newPage();
      let mode = "allowed",
        operatorReads = 0;
      const id = "22222222-2222-4222-8222-222222222222",
        person = { id: "synthetic-operator", createdAt: "2030-01-01" };
      const account = {
        id,
        name: "Synthetic customer organization",
        createdAt: "2030-01-01",
        revision: 3,
        activeMembers: 2,
        products: [{ product: "papyrus", status: "active" }],
      };
      await page.route("**/directory-fixture/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/directory-fixture/accounts") {
          await route.fulfill({ json: { person, accounts: [], operatorAccess: mode !== "denied" } });
          return;
        }
        operatorReads++;
        if (mode === "error") {
          await route.fulfill({ status: 503, json: {} });
          return;
        }
        if (mode === "denied") {
          await route.fulfill({ status: 403, json: {} });
          return;
        }
        const detail = path.endsWith(id);
        await route.fulfill({
          json: detail
            ? {
                account: {
                  ...account,
                  entitlements: [
                    { accountId: id, product: "papyrus", status: "active", capabilities: ["console:read"] },
                  ],
                  memberships: [
                    { accountId: id, personId: "synthetic-owner", role: "owner", status: "active" },
                    { accountId: id, personId: "synthetic-revoked", role: "viewer", status: "revoked" },
                  ],
                },
              }
            : { person, accounts: mode === "empty" ? [] : [account] },
        });
      });
      await page.goto(`${server.resolvedUrls!.local[0]}test/accounts-directory-fixture/index.html`);
      await page.getByRole("button", { name: /Synthetic customer organization/ }).click();
      await expect(page.getByRole("heading", { name: "Organization memberships" })).toBeVisible();
      await expect(page.getByText(/synthetic-revoked/)).toBeVisible();
      await expect(page.getByText(/read-only and does not make you a member/)).toBeVisible();
      await page
        .getByRole("navigation", { name: "Breadcrumb" })
        .getByRole("button", { name: "Accounts" })
        .click();
      await expect(page.getByRole("button", { name: /Synthetic customer organization/ })).toBeVisible();
      await expect(page.getByRole("button", { name: "My memberships" })).toHaveCount(0);
      mode = "error";
      await page.getByRole("button", { name: "Refresh directory" }).click();
      await expect(page.getByRole("alert")).toContainText("permission may have changed");
      mode = "empty";
      await page.getByRole("button", { name: "Refresh directory" }).click();
      await expect(page.getByRole("status")).toContainText("No organizations have been created");
      mode = "denied";
      const before = operatorReads;
      await page.getByRole("button", { name: "Refresh accounts" }).click();
      await expect(page.getByRole("status")).toContainText(
        "explicitly assigned central Accounts administrator permission",
      );
      assert.equal(operatorReads, before);
      // The directory itself stays read-only: the only write control is the organization creation form.
      await expect(page.getByRole("button", { name: /Delete|Invite|Save/ })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /Create/ })).toHaveText(["Create organization"]);
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
