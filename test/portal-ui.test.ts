import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";

const ALPHA = "11111111-1111-4111-8111-111111111111";
const BETA = "22222222-2222-4222-8222-222222222222";

test(
  "the Anthus One portal shows only the signed-in person's own workspaces",
  { skip: !process.env.PROSPECTUS_ACCOUNTS_UI },
  async () => {
    process.env.VITE_ACCOUNTS_BFF_URL = "/directory-fixture";
    const server = await createServer({
      configFile: resolve("vite.portal.config.ts"),
      server: { host: "127.0.0.1", port: 0 },
      logLevel: "error",
    });
    await server.listen();
    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      let mode: "unconfirmed" | "none" | "two" = "two";
      const accounts = [
        {
          id: ALPHA,
          name: "Synthetic Harbor",
          role: "owner",
          products: [
            { product: "papyrus-p-apyr-us", status: "active" },
            { product: "cyclotron", status: "active" },
          ],
        },
        {
          id: BETA,
          name: "Synthetic Personal",
          role: "viewer",
          products: [{ product: "kanbus", status: "disabled" }],
        },
      ];
      await page.route("**/directory-fixture/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.includes("/operator/"))
          throw new Error("The portal must never call the operator directory.");
        if (path === "/directory-fixture/accounts")
          return route.fulfill({
            json: {
              person: mode === "unconfirmed" ? null : { id: "synthetic-person", createdAt: "2030-01-01" },
              accounts: mode === "two" ? accounts : [],
            },
          });
        const account = accounts.find((item) => path.endsWith(item.id))!;
        const owner = account.role === "owner";
        return route.fulfill({
          json: {
            account: {
              ...account,
              createdAt: "2030-01-02",
              revision: 1,
              entitlements: account.products.map((product) => ({
                accountId: account.id,
                product: product.product,
                status: product.status,
                capabilities: ["console:read"],
              })),
              memberships: owner
                ? [
                    { accountId: account.id, personId: "synthetic-person", role: "owner", status: "active" },
                    {
                      accountId: account.id,
                      personId: "synthetic-colleague",
                      role: "member",
                      status: "active",
                    },
                  ]
                : [{ accountId: account.id, personId: "synthetic-person", role: "viewer", status: "active" }],
              membershipsVisible: owner,
            },
          },
        });
      });
      const root = server.resolvedUrls!.local[0];

      await page.goto(root);
      await expect(page.getByRole("heading", { name: "Every Anthus app, in one place." })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

      await page.evaluate(() =>
        sessionStorage.setItem(
          "prospectus.session",
          JSON.stringify({ accessToken: "synthetic", expiresAt: Date.now() + 3_600_000 }),
        ),
      );
      mode = "unconfirmed";
      await page.reload();
      await expect(page.getByRole("heading", { name: "Confirm it’s you" })).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Portal" })).toHaveCount(0);

      mode = "none";
      await page.reload();
      await expect(page.getByRole("heading", { name: "You don’t have a workspace yet" })).toBeVisible();

      mode = "two";
      await page.reload();
      const nav = page.getByRole("navigation", { name: "Portal" });
      await expect(nav.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
      await expect(page.getByRole("link", { name: /Open Papyrus/ })).toHaveAttribute(
        "href",
        "https://p.apyr.us",
      );
      await expect(page.getByRole("link", { name: /Open Cyclotron/ })).toHaveAttribute(
        "href",
        "https://lab.cyclotron.anth.us",
      );
      await expect(page.getByText("This month’s quota")).toBeVisible();
      await expect(page.getByRole("note").first()).toContainText("Not yet available");
      await expect(page.getByRole("combobox", { name: "Workspace" }).locator("option")).toHaveText([
        "Synthetic Harbor",
        "Synthetic Personal",
      ]);

      await nav.getByRole("link", { name: "People and bots" }).click();
      await expect(page).toHaveURL(new RegExp(`page=people&workspace=${ALPHA}`));
      await expect(page.getByText("synthetic-colleague")).toBeVisible();
      await page.getByRole("combobox", { name: "Workspace" }).selectOption(BETA);
      await expect(page).toHaveURL(new RegExp(`workspace=${BETA}`));
      await expect(page.getByText(/Only owners and admins can see everyone/)).toBeVisible();
      await expect(page.getByText("synthetic-colleague")).toHaveCount(0);

      await nav.getByRole("link", { name: "Apps" }).click();
      await expect(page.getByRole("heading", { name: "Kanbus" })).toBeVisible();
      await expect(page.getByText("Turning apps on or off from here is not yet available.")).toBeVisible();

      await nav.getByRole("link", { name: "Settings" }).click();
      await expect(page.getByText(BETA, { exact: true })).toBeVisible();
      await page.getByRole("radio", { name: "Dark" }).click();
      await expect(page.locator(".one").first()).toHaveAttribute("data-theme", "dark");
      await page.reload();
      await expect(page.locator(".one").first()).toHaveAttribute("data-theme", "dark");

      for (const key of ["Usage", "Plan and billing", "API keys"]) {
        await nav.getByRole("link", { name: key }).click();
        await expect(page.getByRole("heading", { name: key, level: 1 })).toBeVisible();
        await expect(page.getByRole("note")).toContainText("Not yet available");
      }

      await page.setViewportSize({ width: 375, height: 800 });
      await nav.getByRole("link", { name: "Home" }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
