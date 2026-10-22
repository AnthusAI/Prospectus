import { expect, test } from "@playwright/test";
import { KANBUS_API_PATH } from "../../src/board";

const token = process.env.PROSPECTUS_TEST_TOKEN;

test("shared column collapse survives layout switching and reload", async ({ page }) => {
  test.skip(!token, "Run with the isolated local proof fixture.");
  await page.goto("/");
  await page.getByLabel("Local access token").fill(token!);
  await page.getByRole("button", { name: "Open local workspace" }).click();
  await page.getByRole("link", { name: "Pipeline", exact: true }).click();
  const collapse = page.getByRole("button", { name: "Collapse New", exact: true });
  await collapse.click();
  await expect(page.getByRole("button", { name: "Expand New", exact: true })).toBeVisible();
  const layout = page.getByRole("group", { name: "Layout", exact: true });
  await layout.getByRole("button", { name: "List" }).click();
  await layout.getByRole("button", { name: "Board" }).click();
  await expect(page.getByRole("button", { name: "Expand New", exact: true })).toBeVisible();
  await page.reload();
  const expand = page.getByRole("button", { name: "Expand New", exact: true });
  await expect(expand).toBeVisible();
  await expand.focus();
  await expand.press("Enter");
  await expect(collapse).toBeVisible();
});
const apiOrigin = process.env.PROSPECTUS_LOCAL_API_ORIGIN ?? "http://127.0.0.1:5418";

test("a signed-in identity without membership sees only access pending, never the admin console", async ({
  page,
}) => {
  test.skip(!token, "Run with the isolated local proof fixture.");
  const issueRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/issues")) issueRequests.push(request.url());
  });
  await page.route("**/api/config", (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ error: "forbidden", message: "Project membership is required." }),
    }),
  );
  await page.goto("/");
  await page.getByLabel("Local access token").fill(token!);
  await page.getByRole("button", { name: "Open local workspace" }).click();
  await expect(page.getByRole("heading", { name: "Workspace access pending" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "New prospect", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "View SaaS accounts" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Admin" })).toHaveCount(0);
  // A deep link into the console still shows only the access-pending screen.
  await page.goto("/?view=accounts");
  await expect(page.getByRole("heading", { name: "Workspace access pending" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Admin" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Accounts", exact: true })).toHaveCount(0);
  expect(issueRequests).toEqual([]);
});

test("anonymous visitors see sign-in without requesting CRM records", async ({ page }) => {
  const crmRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/issues")) crmRequests.push(request.url());
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Prospectus", exact: true })).toBeVisible();
  await expect(
    page.getByText(
      /Private workspace · Sign in with Google, then request workspace access\.|Local preview · Google sign-in is off here\./,
    ),
  ).toBeVisible();
  expect(crmRequests).toEqual([]);
});

test("real backend retains a prospect through sales, handoff, notes and reload", async ({
  page,
  request,
}) => {
  test.skip(!token, "Set PROSPECTUS_TEST_TOKEN and run the real Kanbus API on port 5418.");
  const unauthorized = await request.get(`${apiOrigin}${KANBUS_API_PATH}/issues`);
  expect(unauthorized.status()).toBe(401);
  await page.goto("/");
  await page.getByLabel("Local access token").fill(token!);
  await page.getByRole("button", { name: "Open local workspace" }).click();
  await expect(page.getByRole("button", { name: "New prospect", exact: true })).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Admin" });
  for (const label of [
    "Today",
    "Pipeline",
    "Accounts",
    "Engagements",
    "Usage and billing",
    "Anthus team",
    "Settings",
  ])
    await expect(nav.getByRole("link", { name: label })).toBeVisible();
  await expect(nav.getByRole("link", { name: /^Today/ })).toHaveAttribute("aria-current", "page");
  await nav.getByRole("link", { name: "Engagements" }).click();
  await expect(page.getByRole("note")).toContainText("Not yet available");
  await nav.getByRole("link", { name: "Pipeline", exact: true }).click();
  await expect(page).toHaveURL(/view=pipeline/);
  await expect(page.getByText("Loading workspace…", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "New prospect", exact: true }).click();
  const title = `Proof contact ${Date.now()}`;
  await page.getByLabel("Contact name", { exact: true }).fill(title);
  await page.getByLabel("Company").fill("Example research team");
  await page.getByLabel("Email").fill("proof@example.invalid");
  await page.getByLabel("Follow up on").fill("2026-01-01");
  await page.getByRole("checkbox", { name: "Papyrus" }).check();
  await page
    .getByLabel("First note", { exact: true })
    .fill("Asked for a demonstration. Synthetic local test record.");
  await page.getByRole("button", { name: "Add to New", exact: true }).click();
  await expect(
    page.locator("aside").getByRole("heading", { name: "Example research team", exact: true }),
  ).toBeVisible();
  const identifier = await page.locator("aside .kb-detail-id").textContent();
  await page.getByRole("link", { name: /^Today/ }).click();
  await expect(page.getByRole("region", { name: "Your follow-ups" })).toContainText("Example research team");
  await page
    .getByRole("region", { name: "Your follow-ups" })
    .locator(".one-row", { hasText: title })
    .getByRole("checkbox")
    .click();
  await expect(page).toHaveURL(/\/pipeline\/prsp-/);
  await expect(page.getByLabel("Next action", { exact: true })).toBeFocused();
  await expect(page.locator("aside .kb-detail-id")).toHaveText(identifier!);
  for (const stage of ["Contacted", "Qualified", "Proposal", "Customer success"]) {
    await page.getByRole("radio", { name: stage, exact: true }).check();
    const response = page.waitForResponse(
      (response) => response.request().method() === "PATCH" && response.url().includes("/api/issues/"),
    );
    await page.getByRole("button", { name: "Save changes" }).click();
    expect((await response).ok()).toBe(true);
    await expect(page.getByRole("radio", { name: stage, exact: true })).toBeChecked();
  }
  await page.getByLabel("Owner", { exact: true }).fill("customer-success");
  const handoff = page.waitForResponse(
    (response) => response.request().method() === "PATCH" && response.url().includes("/api/issues/"),
  );
  await page.getByRole("button", { name: "Save changes" }).click();
  expect((await handoff).ok()).toBe(true);
  await page.getByLabel("Add a note").fill("Customer success owns the next check-in.");
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  await expect(page.getByText("Customer success owns the next check-in.", { exact: true })).toBeVisible();
  await page.reload();
  await page
    .getByRole("group", { name: "Layout", exact: true })
    .getByRole("button", { name: "List" })
    .click();
  await page.getByText(title, { exact: true }).click();
  await expect(page.locator("aside .kb-detail-id")).toHaveText(identifier!);
  await expect(page.getByLabel("Owner", { exact: true })).toHaveValue("customer-success");
  await expect(page.getByText("proof@example.invalid", { exact: true })).toBeVisible();
  await expect(page.getByText("Customer success owns the next check-in.", { exact: true })).toBeVisible();
  const persisted = await request.get(`${apiOrigin}${KANBUS_API_PATH}/issues/${identifier}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(persisted.ok()).toBe(true);
  const record = (await persisted.json()).issue;
  expect(record.id).toBe(identifier);
  expect(record.status).toBe("customer");
  expect(record.assignee).toBe("customer-success");
  expect(record.comments.at(-1).text).toBe("Customer success owns the next check-in.");
  expect(record.custom.interests).toEqual(["papyrus"]);
  await page.screenshot({ path: "test-results/prospectus-local-proof.png", fullPage: true });
});
