import { expect, test } from "@playwright/test";

const token = process.env.PROSPECTUS_TEST_TOKEN;
test("synthetic CTA inquiry persists through private follow-up and customer handoff", async ({ page }) => {
  test.skip(
    !process.env.PROSPECTUS_INTAKE_TEST || !token,
    "Run the owned local intake and real API proof environment.",
  );
  const name = `Synthetic inquiry ${Date.now()}`;
  const email = `review-${Date.now()}@example.invalid`;
  const crmRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/")) crmRequests.push(request.url());
  });
  await page.goto("/request-demo?utm_source=prospectus-web&utm_medium=local-review&utm_campaign=mvp");
  await expect(page.getByRole("heading", { name: "Try a demo inquiry" })).toBeVisible();
  await expect(page.getByRole("checkbox")).not.toBeChecked();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Email", { exact: true }).fill("alex@example.com");
  expect(
    await page
      .getByLabel("Email", { exact: true })
      .evaluate((input) => (input as HTMLInputElement).validity.patternMismatch),
  ).toBe(true);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Company", { exact: false }).fill("Example Studio");
  await page.getByLabel("What would you like to discuss?").fill("Synthetic request to explore the CRM.");
  await page.getByRole("button", { name: "Send demo inquiry" }).click();
  await expect(page.getByRole("heading", { name: "Demo request received" })).toBeVisible();
  expect(crmRequests).toEqual([]);
  await page.getByRole("button", { name: "Try another inquiry" }).click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Email", { exact: true }).fill(email.toUpperCase());
  await page.getByLabel("What would you like to discuss?").fill("A second synthetic question.");
  await page.getByRole("button", { name: "Send demo inquiry" }).click();
  await expect(page.getByRole("heading", { name: "Demo request received" })).toBeVisible();
  await page.getByRole("link", { name: "Open synthetic workspace" }).click();
  await page.getByLabel("Local access token").fill(token!);
  await page.getByRole("button", { name: "Open local workspace" }).click();
  await page.getByRole("searchbox", { name: "Search" }).fill(name);
  await page
    .getByRole("group", { name: "Layout", exact: true })
    .getByRole("button", { name: "List" })
    .click();
  await expect(page.getByText(name, { exact: true })).toHaveCount(1);
  await page.getByText(name, { exact: true }).click();
  const identifier = await page.locator("aside .kb-detail-id").textContent();
  await expect(page.getByLabel("Next action", { exact: true })).toHaveValue("Respond to demo request");
  await expect(page.getByRole("region", { name: "Conversation" })).toContainText("prospectus-web-review");
  await expect(page.getByRole("region", { name: "Conversation" })).toContainText(
    "A second synthetic question.",
  );
  await page.getByText("Contact details", { exact: true }).click();
  await page.getByLabel("Email", { exact: true }).fill("corrected-review@example.invalid");
  await page.getByLabel("Next action", { exact: true }).fill("Confirm requirements");
  await page.getByLabel("Follow up on", { exact: true }).fill("2026-01-01");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator(".notice")).toHaveText("Saved.");
  for (const stage of ["Contacted", "Qualified", "Proposal", "Customer success"]) {
    await page.getByRole("radio", { name: stage, exact: true }).check();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("radio", { name: stage, exact: true })).toBeChecked();
  }
  await page.getByLabel("Owner", { exact: true }).fill("customer-success");
  await page.getByLabel("Next action", { exact: true }).fill("Onboarding check-in");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator(".notice")).toHaveText("Saved.");
  await page.reload();
  await page
    .getByRole("group", { name: "Layout", exact: true })
    .getByRole("button", { name: "List" })
    .click();
  await page.getByRole("searchbox", { name: "Search" }).fill(name);
  await page.getByText(name, { exact: true }).click();
  await expect(page.locator("aside .kb-detail-id")).toHaveText(identifier!);
  await page.getByText("Contact details", { exact: true }).click();
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue("corrected-review@example.invalid");
  await expect(page.getByLabel("Owner", { exact: true })).toHaveValue("customer-success");
  await expect(page.getByLabel("Next action", { exact: true })).toHaveValue("Onboarding check-in");
  await expect(page.getByRole("region", { name: "Conversation" })).toContainText(
    "Synthetic request to explore the CRM.",
  );
});

test("local intake is keyboard accessible and fits narrow and wide light/dark layouts", async ({ page }) => {
  test.skip(!process.env.PROSPECTUS_INTAKE_TEST, "Run the local intake review environment.");
  for (const [width, scheme] of [
    [375, "light"],
    [1440, "dark"],
  ] as const) {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await page.goto("/request-demo");
    await expect(page.getByRole("button", { name: "Send demo inquiry" })).toBeVisible();
    if (scheme === "dark")
      await expect(page.getByRole("main")).toHaveCSS("background-color", "rgb(24, 32, 29)");
    const bounds = await page.getByRole("main").boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Name", { exact: true })).toBeFocused();
    await page.screenshot({ path: `test-results/intake-${width}-${scheme}.png`, fullPage: true });
  }
});
