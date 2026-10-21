import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { KANBUS_API_PATH } from "../../src/board";

const token = process.env.PROSPECTUS_TEST_TOKEN;
const apiOrigin = process.env.PROSPECTUS_LOCAL_API_ORIGIN ?? "http://127.0.0.1:5418";

const hostileMessage =
  '<script>window.injected = true</script><img src=x onerror="window.injected = true">\n[markdown link](https://evil.example.com) **not bold**\nLast line';

async function seed(request: APIRequestContext, body: Record<string, unknown>): Promise<string> {
  const response = await request.post(`${apiOrigin}${KANBUS_API_PATH}/issues`, {
    headers: { Authorization: `Bearer ${token}`, "X-Operation-Id": randomUUID() },
    data: { type: "prospect", assignee: "synthetic-owner", ...body },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()).issue.id;
}

async function openWorkspace(page: Page, path: string) {
  await page.goto(path);
  await page.getByLabel("Local access token").fill(token!);
  await page.getByRole("button", { name: "Open local workspace" }).click();
}

test("every item has a shareable address that opens its complete submission details", async ({
  page,
  request,
  context,
}) => {
  test.skip(!token, "Set PROSPECTUS_TEST_TOKEN and run the real Kanbus API on port 5418.");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const source = {
    site_id: "anthus-website",
    form_id: "demo",
    page_path: "/papyrus/pricing",
    campaign: { utm_source: "newsletter" },
  };
  const stamp = Date.now();
  const prospectId = await seed(request, {
    title: `Link Prospect ${stamp}`,
    custom: {
      company: `Link Company ${stamp}`,
      contact_email: "link-prospect@example.com",
      next_action: "Reply to the demo request",
      next_follow_up_at: "2026-12-01",
      first_source: source,
      latest_source: source,
      inquiries: [
        {
          id: "older",
          kind: "waitlist",
          name: "Older Person",
          email: "older@example.com",
          company: "Older Co",
          message: "Older waitlist message",
          received_at: "2026-09-01T10:00:00.000Z",
          source: { ...source, form_id: "waitlist" },
          notice_version: "2026-09",
          marketing_opt_in: false,
          attributes: {},
        },
        {
          id: "newer",
          kind: "demo",
          name: "Newer Person",
          email: "newer@example.com",
          company: "Newer Co",
          message: hostileMessage,
          received_at: "2026-10-01T15:04:00.000Z",
          source,
          notice_version: "2026-10",
          marketing_opt_in: true,
          attributes: { team_size: "12" },
        },
      ],
    },
  });
  const reviewId = await seed(request, {
    title: `Needs review: Review Person ${stamp}`,
    labels: ["needs-review"],
    custom: {
      company: `Review Company ${stamp}`,
      review_contact_email: "review-person@example.com",
      review_reason: "duplicate_contact",
      review_related_issue: prospectId,
      first_source: source,
      latest_source: source,
      inquiries: [
        {
          id: "review",
          kind: "demo",
          name: "Review Person",
          email: "review-person@example.com",
          company: "Review Co",
          message: "Message that was filed for review",
          received_at: "2026-10-02T09:00:00.000Z",
          source,
          notice_version: "2026-10",
          marketing_opt_in: false,
          attributes: {},
        },
      ],
    },
  });

  await openWorkspace(page, `/pipeline/${prospectId}`);
  await expect(page).toHaveURL(new RegExp(`/pipeline/${prospectId}$`));
  const panel = page.locator("aside .kb-issue-detail");
  await expect(panel.locator(".kb-detail-id")).toHaveText(prospectId);
  await expect(page.getByRole("link", { name: "Pipeline", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(panel.getByRole("link", { name: "link-prospect@example.com" })).toHaveAttribute(
    "href",
    "mailto:link-prospect@example.com",
  );
  const submissions = page.getByRole("region", { name: "Submission details" });
  const inquiries = submissions.locator(".one-inquiry");
  await expect(inquiries).toHaveCount(2);
  await expect(inquiries.nth(0)).toContainText("Demo request");
  await expect(inquiries.nth(1)).toContainText("Waitlist signup");
  await expect(inquiries.nth(0).getByRole("link", { name: "newer@example.com" })).toHaveAttribute(
    "href",
    "mailto:newer@example.com",
  );
  await expect(inquiries.nth(0).getByRole("link", { name: "/papyrus/pricing" })).toHaveAttribute(
    "href",
    "https://anth.us/papyrus/pricing",
  );
  await expect(inquiries.nth(0)).toContainText("utm_source: newsletter");
  await expect(inquiries.nth(0)).toContainText("Marketing opt-in");
  await expect(inquiries.nth(0)).toContainText("2026-10");
  await expect(inquiries.nth(0)).toContainText("team_size: 12");
  await expect(submissions).toContainText("Next action");
  await expect(submissions).toContainText("2026-12-01");
  const message = inquiries.nth(0).locator(".one-message");
  await expect(message).toHaveText(hostileMessage);
  await expect(message).toHaveCSS("white-space", "pre-wrap");
  expect(await submissions.locator("script, img, svg").count()).toBe(0);
  await expect(message.getByRole("link")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { injected?: boolean }).injected)).toBeUndefined();

  await panel.getByRole("button", { name: "Copy link" }).click();
  await expect(panel.getByText("Link copied")).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(`${new URL(page.url()).origin}/pipeline/${prospectId}`);

  await page.screenshot({ path: "test-results/prospect-detail.png", fullPage: true });

  await panel.getByRole("button", { name: "Close issue details" }).click();
  await expect(page).toHaveURL(/\/\?view=pipeline$/);
  await expect(page.locator("aside .kb-issue-detail")).toHaveCount(0);

  await page.goto(`/pipeline/${reviewId}`);
  const review = page.getByRole("region", { name: "Submission details" });
  await expect(review.getByRole("note")).toContainText("Needs review: duplicate contact");
  await expect(page.locator("aside .kb-detail-id")).toHaveText(reviewId);
  await expect(
    page.locator(".one-contact").getByRole("link", { name: "review-person@example.com" }),
  ).toHaveAttribute("href", "mailto:review-person@example.com");
  await expect(review).toContainText("Message that was filed for review");
  await page.screenshot({ path: "test-results/review-detail.png", fullPage: true });
  await review.getByRole("link", { name: `Open related item ${prospectId}` }).click();
  await expect(page).toHaveURL(new RegExp(`/pipeline/${prospectId}$`));
  await expect(page.locator("aside .kb-detail-id")).toHaveText(prospectId);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/pipeline/${reviewId}$`));
  await expect(page.locator("aside .kb-detail-id")).toHaveText(reviewId);

  await page.getByRole("button", { name: "Close issue details" }).click();
  await page
    .locator(".issue-card")
    .filter({ hasText: `Link Prospect ${stamp}` })
    .click();
  await expect(page).toHaveURL(new RegExp(`/pipeline/${prospectId}$`));

  await page.goto("/pipeline/prsp-00000000");
  await expect(page.getByRole("alert")).toContainText("could not be found");
  await expect(page).toHaveURL(/\/\?view=pipeline$/);
});

test("a shared address for someone without workspace access shows only access pending", async ({ page }) => {
  test.skip(!token, "Set PROSPECTUS_TEST_TOKEN and run the real Kanbus API on port 5418.");
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
  await openWorkspace(page, "/pipeline/prsp-2241529c");
  await expect(page.getByRole("heading", { name: "Workspace access pending" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Admin" })).toHaveCount(0);
  expect(issueRequests).toEqual([]);
});

test("an unauthenticated visitor to a shared address sees sign-in and no CRM data", async ({ page }) => {
  const crmRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/issues")) crmRequests.push(request.url());
  });
  await page.goto("/pipeline/prsp-2241529c");
  await expect(page.getByRole("heading", { name: "Prospectus", exact: true })).toBeVisible();
  await expect(page.getByLabel("Local access token")).toBeVisible();
  expect(crmRequests).toEqual([]);
});
