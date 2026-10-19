import { expect, test } from "@playwright/test";

test("a demo request receipt never implies a booked appointment", async ({ page }) => {
  await page.route("**/intake/demo", (route) =>
    route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ receipt: "synthetic-receipt-0001" }),
    }),
  );
  await page.goto("/request-demo");
  await page.getByLabel("Name", { exact: true }).fill("Alex Example");
  await page.getByLabel("Email", { exact: true }).fill("alex@example.invalid");
  await page.getByLabel("What would you like to discuss?").fill("A synthetic demo request.");
  await page.getByRole("button", { name: "Send demo inquiry" }).click();
  const receiptStatus = page.getByRole("status");
  await expect(receiptStatus.getByRole("heading", { name: "Demo request received" })).toBeVisible();
  await expect(receiptStatus).toContainText("This is a follow-up request, not a booked appointment.");
  await expect(receiptStatus).toContainText("No meeting time has been scheduled.");
  await expect(receiptStatus).not.toContainText(/confirmed|calendar invite/i);
});
