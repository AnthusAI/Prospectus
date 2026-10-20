import { expect, test } from "@playwright/test";

test.beforeEach(() =>
  test.skip(!process.env.PROSPECTUS_LAN_TEST, "Run against the isolated LAN synthetic preview."),
);

test("LAN admin pipeline preserves inquiry, edits and customer handoff using shared surfaces", async ({
  page,
}) => {
  const name = `Organizer Synthetic ${Date.now()}`;
  const email = `organizer-${Date.now()}@example.invalid`;
  const requests: string[] = [];
  page.on("request", (request) => {
    requests.push(request.url());
    expect(request.headers().authorization).toBeUndefined();
  });
  await page.goto("/request-demo?utm_source=organizer-review");
  for (const [index, address] of [email, email.toUpperCase()].entries()) {
    if (index) await page.getByRole("button", { name: "Try another inquiry" }).click();
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel("Email", { exact: true }).fill(address);
    await page.getByLabel("What would you like to discuss?").fill(`Made-up organizer inquiry ${index + 1}.`);
    await page.getByRole("button", { name: "Send demo inquiry" }).click();
    await expect(page.getByRole("heading", { name: "Demo request received" })).toBeVisible();
  }
  await page.getByRole("link", { name: "Open synthetic workspace" }).click();
  await page.getByRole("searchbox", { name: "Search" }).fill(name);
  await expect(page.getByRole("link", { name: "Pipeline", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  const card = page.locator(".issue-card").filter({ hasText: name });
  await expect(card).toHaveCount(1);
  await expect(card).toHaveCSS("border-radius", "0px");
  await card.press("Enter");
  const panel = page.locator(".kb-issue-detail");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { name })).toBeFocused();
  await expect(page.getByRole("region", { name: "Conversation" })).toContainText(
    "Made-up organizer inquiry 2.",
  );
  await page.getByLabel("Next action", { exact: true }).fill("Synthetic onboarding check-in");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator(".notice")).toHaveText("Saved.");
  for (const stage of ["Contacted", "Qualified", "Proposal", "Customer success"]) {
    await page.getByRole("radio", { name: stage, exact: true }).check();
    const saved = page.waitForResponse((response) => response.request().method() === "PATCH");
    await page.getByRole("button", { name: "Save changes" }).click();
    expect((await saved).status()).toBe(200);
    await expect(page.getByRole("radio", { name: stage, exact: true })).toBeChecked();
    await expect(page.locator(".notice")).toHaveText("Saved.");
  }
  await page.reload();
  await page.getByRole("searchbox", { name: "Search" }).fill(name);
  await page.locator(".issue-card").filter({ hasText: name }).press("Enter");
  await expect(page.getByLabel("Next action", { exact: true })).toHaveValue("Synthetic onboarding check-in");
  await expect(page.getByRole("radio", { name: "Customer success", exact: true })).toBeChecked();
  expect(requests.every((url) => url.startsWith(process.env.PROSPECTUS_REVIEW_URL!))).toBe(true);
});

for (const [width, colorScheme] of [
  [375, "light"],
  [1024, "dark"],
] as const) {
  test(`organizer fits ${width} ${colorScheme} with readable focus and reduced motion`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.goto("/?view=pipeline");
    await expect(page.locator(".kb-grid")).toBeVisible();
    await expect(page.locator(".issue-card").first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator(".kb-grid").evaluate((node) => node.scrollLeft)).toBe(0);
    await expect(page.locator(".one")).toHaveCSS(
      "color",
      colorScheme === "dark" ? "rgb(243, 238, 248)" : "rgb(27, 20, 38)",
    );
    await expect(page.locator(".column-animate-in").first()).toHaveCSS("animation-name", "none");
    const card = page.locator(".issue-card").first();
    await card.focus();
    await expect(card).not.toHaveCSS("outline-style", "none");
    expect(await page.evaluate(() => document.fonts.check('16px "Geist"'))).toBe(true);
    await page.screenshot({ path: `test-results/organizer-${width}-${colorScheme}.png`, fullPage: true });
  });
}
