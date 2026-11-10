import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ViteDevServer } from "vite";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { SYNTHETIC_ACCOUNT_IDS } from "../src/billing/synthetic";

const [HARBOR] = SYNTHETIC_ACCOUNT_IDS;
const RUN = Boolean(process.env.PROSPECTUS_ACCOUNTS_UI);

async function serve(mode: string, bff = false): Promise<ViteDevServer> {
  const server = await createServer({
    configFile: false,
    mode,
    root: process.cwd(),
    server: { host: "127.0.0.1", port: 0 },
    resolve: { dedupe: ["react", "react-dom"] },
    logLevel: "error",
    // A deployment whose Accounts service is reachable but has no billing routes.
    ...(bff ? { define: { "import.meta.env.VITE_ACCOUNTS_BFF_URL": JSON.stringify("/bff") } } : {}),
  });
  await server.listen();
  return server;
}

/** The Kanbus API the shell needs to start: a configuration and an empty pipeline. */
async function stubKanbus(page: Page) {
  await page.route("**/cyclotron/prospectus/api/**", async (route) => {
    const body = route.request().url().includes("/config")
      ? {
          actor_id: "reviewer@example.invalid",
          initial_status: "new",
          types: ["prospect"],
          statuses: [
            { key: "new", name: "New", category: "To do", semantic_category: "todo" },
            { key: "lost", name: "Closed", category: "Done", semantic_category: "done" },
          ],
          categories: [{ name: "To do", color: "grey" }],
          priorities: {},
        }
      : { issues: [], next_cursor: null };
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
}

/** The Accounts service of a deployment that has accounts but no billing routes. */
async function stubAccounts(page: Page) {
  const created = "2026-01-15T12:00:00Z";
  const account = {
    id: HARBOR,
    name: "Synthetic Example Co",
    createdAt: created,
    revision: 1,
    products: [],
    activeMembers: 1,
  };
  const person = { id: "synthetic-operator", createdAt: created };
  await page.route("**/bff/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = path.endsWith("/bff/accounts")
      ? { person, accounts: [], operatorAccess: true }
      : path.endsWith("/bff/operator/accounts")
        ? { person, accounts: [account] }
        : {
            account: {
              ...account,
              entitlements: [],
              memberships: [],
              quota: { state: "none", planId: null, allowanceOverrideUnits: null },
            },
          };
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
}

/** Everything the page logs, so a test can prove nothing billing-related reaches the console. */
function watchConsole(page: Page) {
  const messages: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (/^\[vite\]|React DevTools/.test(text)) return;
    messages.push(`${message.type()}: ${text}`);
  });
  page.on("pageerror", (error) => messages.push(`pageerror: ${error.message}`));
  return messages;
}

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test(
  "the synthetic billing pages show the fixture, enforce the form rules and need no console",
  { skip: !RUN },
  async () => {
    const server = await serve("synthetic-review");
    const browser: Browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    });
    try {
      const origin = server.resolvedUrls!.local[0].replace(/\/$/, "");
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const page = await context.newPage();
      await page.clock.setFixedTime(new Date("2026-11-05T12:00:00"));
      await stubKanbus(page);
      const messages = watchConsole(page);

      // An invoice address loads directly on a fresh visit.
      await page.goto(`${origin}/invoices/202610-003`);
      await expect(page.getByRole("heading", { level: 1, name: "202610-003" })).toBeVisible();
      await expect(page.getByText("5 days past due")).toBeVisible();
      await expect(page.getByLabel("Amounts")).toContainText("$4,000.00");
      await expect(page.getByRole("button", { name: "Void" })).toBeDisabled();
      await expect(page.getByText(/An invoice with payments applied can.t be voided\./)).toBeVisible();
      await expect(page.getByRole("button", { name: "Download PDF" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "How the balance got here" })).toBeVisible();
      assert.ok((await page.locator("tbody tr").count()) >= 4);
      // Billing never offers to suspend.
      assert.equal(await page.getByText(/suspend/i).count(), 0);

      // Rows are real links, and back and forward work.
      await page.goto(`${origin}/?view=billing`);
      await expect(page.getByRole("heading", { name: "Usage and billing" })).toBeVisible();
      await expect(page.locator(".one-stats")).toContainText("$19,900.00");
      const link = page.getByRole("link", { name: "202610-003" }).first();
      expect(await link.getAttribute("href")).toBe("/invoices/202610-003");
      await link.click();
      await expect(page).toHaveURL(`${origin}/invoices/202610-003`);
      await page.goBack();
      await expect(page).toHaveURL(`${origin}/billing`);
      await expect(page.getByRole("heading", { name: "Usage and billing" })).toBeVisible();
      await page.goForward();
      await expect(page.getByRole("heading", { level: 1, name: "202610-003" })).toBeVisible();

      // The invoice filters and tabs.
      await page.goto(`${origin}/?view=billing`);
      await page.getByRole("button", { name: /^Past due/ }).click();
      await expect(page.locator("tbody tr")).toHaveCount(2);
      await page.getByRole("button", { name: /^Payments/ }).click();
      await expect(page.getByRole("link", { name: "Nov 3" })).toBeVisible();
      await page.getByRole("button", { name: /^By account/ }).click();
      await expect(page.getByRole("link", { name: "Harbor Lantern Media" })).toBeVisible();

      // Account billing: its own address, masked contact until revealed.
      await page.goto(`${origin}/accounts/${HARBOR}/billing`);
      await expect(page.getByRole("heading", { level: 1, name: "Harbor Lantern Media" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Billing", exact: true })).toHaveAttribute(
        "aria-current",
        "page",
      );
      const contact = page.getByTestId("billing-contact");
      await expect(contact.nth(1)).toHaveText("a•••••••@harborlantern.example");
      assert.equal(await page.getByText("accounts@harborlantern.example").count(), 0);
      await page.getByRole("button", { name: "Reveal" }).click();
      await expect(contact.nth(1)).toHaveText("accounts@harborlantern.example");
      await page.getByRole("button", { name: "Hide" }).click();
      assert.equal(await page.getByText("accounts@harborlantern.example").count(), 0);
      // Past due offers the follow-up and the existing entitlement action, never suspension.
      await expect(page.getByRole("link", { name: "Apps and access" })).toBeVisible();
      await page.getByRole("link", { name: "Overview" }).click();
      await expect(page.getByRole("heading", { name: "Apps and access" })).toBeVisible();
      await expect(page.getByLabel("Billing summary")).toContainText("$10,500.00");

      // Record a payment: money is integer cents, over-allocation is blocked, the split updates both balances.
      await page.goto(`${origin}/payments/new?account=${HARBOR}`);
      await page.getByLabel("Amount (USD)").fill("12.345");
      await expect(page.getByRole("alert")).toContainText("at most two decimal places");
      await expect(page.getByRole("button", { name: /^Record/ })).toBeDisabled();
      await page.getByLabel("Amount (USD)").fill("5000");
      await page.getByRole("button", { name: "Oldest first" }).click();
      await expect(page.getByLabel("Amount to apply to invoice 202610-003")).toHaveValue("4000.00");
      await expect(page.getByLabel("Amount to apply to invoice 202611-002")).toHaveValue("1000.00");
      await page.getByLabel("Amount to apply to invoice 202610-003").fill("4000.01");
      await expect(page.getByText("This invoice only has $4,000.00 open.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Record $5,000.00" })).toBeDisabled();
      await page.getByLabel("Amount to apply to invoice 202610-003").fill("4000");
      await page.getByLabel("Amount to apply to invoice 202611-002").fill("1200");
      await expect(page.getByRole("alert").filter({ hasText: "more than the payment" })).toContainText(
        "$5,000.00",
      );
      await expect(page.getByRole("button", { name: "Record $5,000.00" })).toBeDisabled();
      await page.getByLabel("Amount to apply to invoice 202611-002").fill("1000");
      await page.getByLabel("Reference").fill("No. 1099");
      await page.getByRole("button", { name: "Record $5,000.00" }).click();
      await expect(page.getByRole("heading", { name: "Payment recorded" })).toBeVisible();
      await expect(page.getByText("$1,000.00 applied to 202611-002.")).toBeVisible();
      await page.goto(`${origin}/invoices/202610-003`);
      // A fresh page load resets the in-memory fixture, so the balance is back to its starting point.
      await expect(page.getByLabel("Amounts")).toContainText("$4,000.00");

      // Raise an invoice: one per period, naming the existing one; Stripe stays off until connected.
      await page.goto(`${origin}/invoices/new?account=${HARBOR}`);
      await page.getByRole("combobox", { name: /^Period/ }).selectOption("2026-11");
      await expect(page.getByRole("alert")).toContainText("202611-002 already bills November 2026");
      await expect(page.getByRole("button", { name: /^Issue/ })).toBeDisabled();
      await expect(page.getByLabel(/Stripe, with a payment page/)).toBeDisabled();
      await expect(page.getByLabel(/Stripe, with a payment page/)).toHaveAccessibleName(/not connected yet/);
      await page.getByRole("combobox", { name: /^Period/ }).selectOption("2026-12");
      await expect(page.getByRole("button", { name: "Issue $6,500.00" })).toBeEnabled();
      await page.getByLabel("Unit price").first().fill("5000.001");
      await expect(page.getByRole("alert")).toContainText("at most two decimal places");
      await page.getByLabel("Unit price").first().fill("5000");
      await page.getByRole("button", { name: "Issue $6,500.00" }).click();
      await expect(page.getByRole("heading", { name: "202611-003 issued" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Download PDF" })).toBeVisible();

      // Write off with a reason, and the reversal of a payment from its own address.
      await page.goto(`${origin}/invoices/202609-001`);
      await expect(page.getByRole("heading", { level: 1, name: "202609-001" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Write off" })).toHaveCount(0);
      await page.goto(`${origin}/invoices/202610-002`);
      await page.getByRole("button", { name: "Write off", exact: true }).click();
      const confirm = page.getByRole("button", { name: /^Write off \$/ });
      await expect(confirm).toBeDisabled();
      await page.getByLabel("Reason").fill("Client closed");
      await confirm.click();
      await expect(page.locator(".billing-status", { hasText: "Written off" })).toBeVisible();
      await expect(page.getByText("Wrote off 202610-002: Client closed.")).toBeVisible();

      // A payment has its own address: allocate the remainder, then reverse it with a reason.
      await page.goto(`${origin}/?view=billing`);
      await page.getByRole("button", { name: /^Payments/ }).click();
      await page.getByRole("link", { name: "Nov 3" }).click();
      await expect(page).toHaveURL(/\/payments\/[0-9a-f-]{36}$/);
      await expect(page.getByRole("heading", { level: 1 })).toContainText("$4,000.00");
      await page.getByLabel("Amount to apply to invoice 202611-002").fill("1500.01");
      await expect(page.getByRole("button", { name: /^Apply/ })).toBeDisabled();
      await page.getByLabel("Amount to apply to invoice 202611-002").fill("1500");
      await page.getByRole("button", { name: "Apply $1,500.00" }).click();
      await expect(page.locator(".billing-applied").filter({ hasText: "202611-002" })).toContainText(
        "$1,500.00",
      );
      await expect(page.getByRole("heading", { name: "Apply it to invoices" })).toHaveCount(0);
      await page.getByRole("button", { name: "Reverse this payment" }).click();
      await page.getByLabel("Reason").fill("Returned by the bank");
      await page.getByRole("button", { name: "Reverse payment" }).click();
      await expect(page.locator(".billing-status", { hasText: "Reversed" })).toBeVisible();
      await expect(page.getByText("Reversed Nov 5 by Sam Rivera: Returned by the bank.")).toBeVisible();
      await expect(page.getByText("Reversed check 1042 for $4,000.00: Returned by the bank.")).toBeVisible();

      // Settings: the Stripe sender is not connected and no key is ever shown.
      await page.goto(`${origin}/settings/billing`);
      await expect(page.getByRole("heading", { name: "Billing settings" })).toBeVisible();
      await expect(page.getByText("Not connected. When it is, this shows test or live mode.")).toBeVisible();
      await page.getByLabel("Footer note").fill("Thanks.");
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
      assert.equal(await page.locator("text=/sk_(live|test)_|whsec_/").count(), 0);

      // Accounts shows what is owed, with a Past due filter; Today shows the past due total and follow-ups.
      await page.goto(`${origin}/?view=accounts`);
      await expect(page.getByRole("columnheader", { name: "Owed" })).toBeVisible();
      await expect(page.getByRole("row", { name: /Harbor Lantern Media/ })).toContainText(
        "$4,000.00 past due",
      );
      await page.getByRole("button", { name: /^Past due/ }).click();
      await expect(page.locator("tbody tr")).toHaveCount(2);
      await page.goto(`${origin}/?view=today`);
      await expect(page.locator(".one-stats")).toContainText("$6,400");
      await expect(
        page.getByRole("link", { name: /Chase 202610-003: \$4,000.00 open, 5 days late/ }),
      ).toHaveAttribute("href", "/invoices/202610-003");
      await expect(
        page.getByRole("link", { name: /Apply the \$1,500.00 left from check 1042/ }),
      ).toBeVisible();

      // Every action is a button, never a menu item, and there are no emoji.
      await page.goto(`${origin}/invoices/202610-003`);
      assert.equal(
        await page
          .locator('[role="menuitem"], [role="menu"] button, select option:has-text("Write off")')
          .count(),
        0,
      );
      assert.equal(/\p{Extended_Pictographic}/u.test(await page.locator("main").innerText()), false);

      assert.deepEqual(messages, [], "nothing billing-related is logged in the browser console");
      await context.close();
    } finally {
      await browser.close();
      await server.close();
    }
  },
);

test(
  "engagements: the page, the account, Raise an invoice and Today follow-ups",
  { skip: !RUN },
  async () => {
    const server = await serve("synthetic-review");
    const browser: Browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    });
    try {
      const origin = server.resolvedUrls!.local[0].replace(/\/$/, "");
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const page = await context.newPage();
      await page.clock.setFixedTime(new Date("2026-11-05T12:00:00"));
      await stubKanbus(page);
      const messages = watchConsole(page);

      // The page has its own address, filters with counts, and each engagement's kind, lead and amount.
      await page.goto(`${origin}/engagements`);
      await expect(page.getByRole("heading", { level: 1, name: "Engagements" })).toBeVisible();
      await expect(page.getByRole("button", { name: /^Active 3/ })).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByRole("button", { name: /^Ongoing 2/ })).toBeVisible();
      await expect(page.getByRole("button", { name: /^Setup packages 1/ })).toBeVisible();
      await expect(page.getByRole("button", { name: /^Proposed 1/ })).toBeVisible();
      const desk = page.locator(".engagement-row", { hasText: "Reporting Desk support" });
      await expect(desk).toContainText("Ongoing");
      await expect(desk).toContainText("Harbor Lantern Media");
      await expect(desk).toContainText("Diego C. leads");
      await expect(desk).toContainText("$8,000.00 / month");
      await expect(desk).toContainText("October 2026 not invoiced yet");
      await expect(page.locator(".engagement-row", { hasText: "Newsroom setup" })).toContainText(
        "Training · week 2 of 6",
      );
      await page.getByRole("button", { name: /^Proposed/ }).click();
      await page.getByRole("button", { name: "Start" }).click();
      await expect(page.getByRole("button", { name: /^Proposed 0/ })).toBeVisible();
      await expect(page.getByRole("button", { name: /^Active 4/ })).toBeVisible();

      // A new ongoing engagement: amounts are dollars and cents, and the form names what is missing.
      await page.getByRole("button", { name: "New engagement" }).click();
      await page.getByLabel("Account").selectOption({ label: "Northfield Press" });
      await page.getByLabel("Name").fill("Editorial agents");
      await expect(page.getByRole("alert")).toContainText("Say who leads it.");
      await page.getByLabel("Anthus lead").fill("Sam Rivera");
      await page.getByLabel("Starts").fill("2026-11-01");
      await page.getByLabel("Monthly amount").fill("1500.001");
      await expect(page.getByRole("button", { name: "Start engagement" })).toBeDisabled();
      await page.getByLabel("Monthly amount").fill("1500");
      await page.getByRole("button", { name: "Start engagement" }).click();
      await page.getByRole("button", { name: /^Active/ }).click();
      await expect(page.locator(".engagement-row", { hasText: "Editorial agents" })).toContainText(
        "$1,500.00 / month",
      );

      // The Account page lists the account's engagements and counts them.
      await page.goto(`${origin}/accounts/${HARBOR}`);
      await expect(page.getByRole("heading", { name: "Services engagements" })).toBeVisible();
      await expect(page.locator(".engagement-row")).toHaveCount(2);
      await expect(page.locator(".one-stats")).toContainText("1 to invoice");

      // Today and Usage and billing raise the month still waiting for an invoice.
      await page.goto(`${origin}/?view=today`);
      await expect(
        page.getByRole("link", { name: "Invoice Reporting Desk support for October 2026" }),
      ).toHaveAttribute("href", `/invoices/new?account=${HARBOR}`);
      await page.goto(`${origin}/?view=billing`);
      await expect(page.locator(".billing-attention", { hasText: "To invoice" }).first()).toBeVisible();

      // Raise an invoice offers the account's engagements; the retainer bills the month that is waiting.
      await page.goto(`${origin}/invoices/new?account=${HARBOR}`);
      await page.getByRole("combobox", { name: "Kind of invoice" }).selectOption("other");
      const offers = page.getByRole("group", { name: "Add from this account" });
      await expect(offers.getByRole("button")).toHaveCount(2);
      await offers.getByRole("button", { name: "Reporting Desk support retainer" }).click();
      await expect(page.getByLabel("Description").first()).toHaveValue(
        "Reporting Desk support, monthly retainer",
      );
      await expect(page.getByLabel("Service dates").first()).toHaveValue("October 2026");
      await expect(offers.getByRole("button", { name: "Reporting Desk support retainer" })).toBeDisabled();
      await page.getByLabel("Already sent outside Prospectus").check();
      await page.getByLabel("Number it was sent with").fill("202610-009");
      await page.getByLabel("Issued").fill("2026-10-31");
      await page.getByRole("button", { name: "Record 202610-009" }).click();
      await expect(page.getByRole("heading", { name: "202610-009 issued" })).toBeVisible();

      // The engagement now shows it as last invoiced, and nothing waits.
      await page
        .getByRole("navigation", { name: "Admin" })
        .getByRole("link", { name: /^Engagements/ })
        .click();
      const billed = page.locator(".engagement-row", { hasText: "Reporting Desk support" });
      await expect(billed).toContainText("Last invoiced Oct 31");
      await expect(billed.getByRole("link", { name: "202610-009" })).toHaveAttribute(
        "href",
        "/invoices/202610-009",
      );

      // Ending asks once more, then the engagement leaves the active list.
      await billed.getByRole("button", { name: "End Reporting Desk support" }).click();
      await billed.getByRole("button", { name: "End today" }).click();
      await expect(page.locator(".engagement-row", { hasText: "Reporting Desk support" })).toHaveCount(0);

      // It fits a phone.
      await page.setViewportSize({ width: 375, height: 812 });
      assert.ok((await overflow(page)) <= 0, "no horizontal scroll on a phone");
      assert.deepEqual(messages, [], "nothing is logged in the browser console");
      await context.close();
    } finally {
      await browser.close();
      await server.close();
    }
  },
);

test("a read-only operator sees the same pages with no actions", { skip: !RUN }, async () => {
  const server = await serve("synthetic-review");
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  try {
    const origin = server.resolvedUrls!.local[0].replace(/\/$/, "");
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
    await page.clock.setFixedTime(new Date("2026-11-05T12:00:00"));
    await stubKanbus(page);
    await page.goto(`${origin}/?view=billing&access=read`);
    await expect(page.getByRole("heading", { name: "Usage and billing" })).toBeVisible();
    await expect(page.locator(".one-stats")).toContainText("$19,900.00");
    for (const name of ["Record a payment", "Raise an invoice"])
      await expect(page.getByRole("button", { name })).toHaveCount(0);
    await page.goto(`${origin}/accounts/${HARBOR}/billing?access=read`);
    await expect(page.getByRole("heading", { name: "Invoices" })).toBeVisible();
    for (const name of ["Raise an invoice", "Record a payment", "Edit"])
      await expect(page.getByRole("button", { name })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Allocate" })).toHaveCount(0);
    await page.goto(`${origin}/invoices/202610-003?access=read`);
    for (const name of ["Write off", "Void", "Record a payment"])
      await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Download PDF" })).toBeVisible();
    await page.goto(`${origin}/payments/new?access=read`);
    await expect(page.getByText("Recording a payment needs the billing permission.")).toBeVisible();
    await page.goto(`${origin}/invoices/new?access=read`);
    await expect(page.getByText("Raising an invoice needs the billing permission.")).toBeVisible();
    await page.goto(`${origin}/settings/billing?access=read`);
    await expect(page.getByText("Changing them needs the billing permission.")).toBeVisible();
    await expect(page.getByLabel("Legal name")).toHaveJSProperty("readOnly", true);
    await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(0);
  } finally {
    await browser.close();
    await server.close();
  }
});

test("billing pages fit a phone, in light and dark, with visible focus", { skip: !RUN }, async () => {
  const server = await serve("synthetic-review");
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  try {
    const origin = server.resolvedUrls!.local[0].replace(/\/$/, "");
    const paths = [
      "/?view=billing",
      `/accounts/${HARBOR}/billing`,
      "/invoices/202610-003",
      `/payments/new?account=${HARBOR}`,
      `/invoices/new?account=${HARBOR}`,
      "/settings/billing",
      "/?view=accounts",
      "/?view=today",
    ];
    for (const [width, scheme] of [
      [375, "light"],
      [1440, "dark"],
    ] as const) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: scheme,
      });
      const page = await context.newPage();
      await page.clock.setFixedTime(new Date("2026-11-05T12:00:00"));
      await stubKanbus(page);
      for (const path of paths) {
        await page.goto(`${origin}${path}`);
        await expect(page.locator("main h1, main h2").first()).toBeVisible();
        await page.waitForTimeout(150);
        assert.equal(await overflow(page), 0, `${path} overflows horizontally at ${width}px`);
      }
      // Focus is visible on a link, a button and an input.
      await page.goto(`${origin}/payments/new?account=${HARBOR}`);
      await page.getByLabel("Amount (USD)").focus();
      const outline = await page
        .getByLabel("Amount (USD)")
        .evaluate((element) => getComputedStyle(element).outlineStyle);
      assert.notEqual(outline, "none");
      await page.goto(`${origin}/?view=billing`);
      await page.getByRole("button", { name: /^By account/ }).focus();
      assert.notEqual(
        await page
          .getByRole("button", { name: /^By account/ })
          .evaluate((element) => getComputedStyle(element).outlineStyle),
        "none",
      );
      // The wide table scrolls inside its own box, which can be reached from the keyboard.
      const box = page.locator(".one-table-wrap").first();
      await expect(box).toHaveAttribute("tabindex", "0");
      await context.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
});

test(
  "a signed-in operator on a deployment with no billing routes sees no figures, no actions and no billing request",
  { skip: !RUN },
  async () => {
    const server = await serve("development", true);
    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    });
    try {
      const origin = server.resolvedUrls!.local[0].replace(/\/$/, "");
      const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
      await stubKanbus(page);
      await stubAccounts(page);
      const messages = watchConsole(page);
      const requests: string[] = [];
      page.on("request", (request) => {
        if (["fetch", "xhr"].includes(request.resourceType())) requests.push(request.url());
      });
      await page.goto(`${origin}/`);
      await page.getByLabel("Local access token").fill("synthetic-local-token");
      await page.getByRole("button", { name: "Open local workspace" }).click();
      await expect(page.getByRole("heading", { name: /^Good (morning|afternoon|evening)/ })).toBeVisible();
      await expect(page.locator(".one-stats")).toContainText("Needs billing data");
      for (const path of [
        "/?view=billing",
        "/invoices/202610-003",
        "/invoices/new",
        "/payments/new",
        `/payments/${["5a1b2c3d", "0000", "4000", "8000", "00000000abcd"].join("-")}`,
        `/accounts/${HARBOR}/billing`,
        "/settings/billing",
      ]) {
        await page.goto(`${origin}${path}`);
        await expect(page.getByText("Not yet available").first()).toBeVisible();
        const text = await page.locator("main").innerText();
        assert.equal(/\$\d/.test(text), false, `${path} shows an amount`);
        for (const name of [
          "Record a payment",
          "Raise an invoice",
          "Write off",
          "Save changes",
          "Download PDF",
        ])
          await expect(page.getByRole("button", { name })).toHaveCount(0);
        assert.equal(await page.locator("text=Harbor Lantern").count(), 0);
      }
      // Accounts still lists, but its billing columns are unavailable and no billing route is called.
      await page.goto(`${origin}/?view=accounts`);
      await expect(page.getByRole("row", { name: /Synthetic Example Co/ })).toContainText(
        "Not yet available",
      );
      await expect(page.getByRole("button", { name: /^Past due/ })).toBeDisabled();
      assert.deepEqual(
        requests.filter((url) => /billing|invoices|payments|issuer/.test(new URL(url).pathname)),
        [],
        "no billing route is requested",
      );
      assert.deepEqual(messages, []);
    } finally {
      await browser.close();
      await server.close();
    }
  },
);

test("starting a billing profile takes the billing contact", { skip: !RUN }, async () => {
  const server = await serve("synthetic-review");
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  try {
    const origin = server.resolvedUrls!.local[0].replace(/\/$/, "");
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
    await page.clock.setFixedTime(new Date("2026-11-05T12:00:00"));
    await stubKanbus(page);
    const kestrel = SYNTHETIC_ACCOUNT_IDS[SYNTHETIC_ACCOUNT_IDS.length - 1];
    await page.goto(`${origin}/accounts/${kestrel}/billing`);
    await page.getByRole("button", { name: "Set up billing profile" }).click();
    await page.getByRole("button", { name: "Save profile" }).click();
    await expect(page.getByRole("alert")).toHaveText("Enter the billing contact's name and email.");
    await page.getByLabel("Name", { exact: true }).fill("Example Payables");
    await page.getByLabel("Email", { exact: true }).fill("payables@kestrel.example");
    await page.getByLabel("Street (optional)").fill("6 Example Street");
    await page.getByRole("button", { name: "Save profile" }).click();
    await expect(page.getByRole("alert")).toContainText("A postal address needs");
    await page.getByLabel("Street (optional)").fill("");
    await page.getByRole("button", { name: "Save profile" }).click();
    await expect(page.getByRole("heading", { name: "This account isn’t billable yet" })).toHaveCount(0);
    await expect(page.getByText("Billing contact", { exact: true })).toBeVisible();
  } finally {
    await browser.close();
    await server.close();
  }
});
