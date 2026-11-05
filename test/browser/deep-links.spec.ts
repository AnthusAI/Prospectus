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
  const lead = page.getByRole("main", { name: "Lead" });
  await expect(lead.locator(".lead-id")).toHaveText(prospectId);
  await expect(page).toHaveTitle(`Link Company ${stamp} · Prospectus · Anthus`);
  await expect(page.locator("aside .kb-issue-detail")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Pipeline", exact: true }).first()).toBeVisible();
  await expect(lead.getByRole("link", { name: "link-prospect@example.com" })).toHaveAttribute(
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

  await lead.getByRole("button", { name: "Copy link" }).click();
  await expect(lead.getByText("Link copied")).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(`${new URL(page.url()).origin}/pipeline/${prospectId}`);

  await page.screenshot({ path: "test-results/prospect-detail.png", fullPage: true });

  await lead.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Pipeline" }).click();
  await expect(page).toHaveURL(/\/pipeline$/);
  await expect(page.getByRole("main", { name: "Lead" })).toHaveCount(0);

  await page.goto(`/pipeline/${reviewId}`);
  const review = page.getByRole("region", { name: "Submission details" });
  await expect(review.getByRole("note")).toContainText("Needs review: duplicate contact");
  await expect(page.locator(".lead-page .lead-id")).toHaveText(reviewId);
  await expect(
    page.locator(".one-contact").getByRole("link", { name: "review-person@example.com" }),
  ).toHaveAttribute("href", "mailto:review-person@example.com");
  await expect(review).toContainText("Message that was filed for review");
  await page.screenshot({ path: "test-results/review-detail.png", fullPage: true });
  await review.getByRole("link", { name: `Open related item ${prospectId}` }).click();
  await expect(page).toHaveURL(new RegExp(`/pipeline/${prospectId}$`));
  await expect(page.locator(".lead-page .lead-id")).toHaveText(prospectId);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/pipeline/${reviewId}$`));
  await expect(page.locator(".lead-page .lead-id")).toHaveText(reviewId);
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/pipeline/${prospectId}$`));

  // Every card on the board is a real link to its lead page.
  await page.goto("/pipeline");
  const cardLink = page.getByRole("link", { name: `Open Link Prospect ${stamp}` });
  await expect(cardLink).toHaveAttribute("href", `/pipeline/${prospectId}`);
  await cardLink.click();
  await expect(page).toHaveURL(new RegExp(`/pipeline/${prospectId}$`));

  await page.goto("/pipeline/prsp-00000000");
  await expect(page.getByRole("alert")).toContainText("could not be found");
  await expect(page).toHaveURL(/\/pipeline\/prsp-00000000$/);
  await expect(page).toHaveTitle("Lead not found · Prospectus · Anthus");
  await page.getByRole("link", { name: "Back to the pipeline" }).click();
  await expect(page).toHaveURL(/\/pipeline$/);
});

test("every console page has its own address that survives reload, back and forward", async ({ page }) => {
  test.skip(!token, "Set PROSPECTUS_TEST_TOKEN and run the real Kanbus API on port 5418.");
  await openWorkspace(page, "/engagements");
  await expect(page).toHaveURL(/\/engagements$/);
  await expect(page).toHaveTitle("Engagements · Prospectus · Anthus");
  const nav = page.getByRole("navigation", { name: "Admin" });
  await expect(nav.getByRole("link", { name: "Engagements" })).toHaveAttribute("aria-current", "page");
  const pages = [
    ["Today", "/today"],
    ["Pipeline", "/pipeline"],
    ["Accounts", "/accounts"],
    ["Engagements", "/engagements"],
    ["Usage and billing", "/billing"],
    ["Anthus team", "/team"],
    ["Settings", "/settings"],
  ] as const;
  for (const [label, path] of pages) {
    await expect(nav.getByRole("link", { name: new RegExp(`^${label}`) })).toHaveAttribute("href", path);
    await nav.getByRole("link", { name: new RegExp(`^${label}`) }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(nav.getByRole("link", { name: new RegExp(`^${label}`) })).toHaveAttribute(
      "aria-current",
      "page",
    );
  }
  await page.goBack();
  await expect(page).toHaveURL(/\/team$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/settings$/);
});

test("older ?view= links are replaced with their path", async ({ page }) => {
  test.skip(!token, "Set PROSPECTUS_TEST_TOKEN and run the real Kanbus API on port 5418.");
  await openWorkspace(page, "/?view=pipeline");
  await expect(page).toHaveURL(/\/pipeline$/);
  await page.goto("/?view=accounts&account=00000000-0000-4000-8000-000000000000");
  await expect(page).toHaveURL(/\/accounts\/00000000-0000-4000-8000-000000000000$/);
  await page.goto("/?view=followups");
  await expect(page).toHaveURL(/\/today$/);
  await page.goto("/?view=customers");
  await expect(page).toHaveURL(/\/pipeline$/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/today$/);
  // The older address is not left behind in history.
  await page.goBack();
  await expect(page).not.toHaveURL(/view=/);
});

test("Today links every lead to its page, including leads owned by someone else, and keeps Take it", async ({
  page,
  request,
}) => {
  test.skip(!token, "Set PROSPECTUS_TEST_TOKEN and run the real Kanbus API on port 5418.");
  const stamp = Date.now();
  const source = { site_id: "anthus-website", form_id: "demo" };
  const inquiry = (message: string) => ({
    id: randomUUID(),
    kind: "demo",
    name: "Today Person",
    email: "today-person@example.invalid",
    message,
    received_at: new Date().toISOString(),
    source,
    attributes: {},
  });
  const owned = await seed(request, {
    title: `Today Owned ${stamp}`,
    custom: { company: `Today Owned Co ${stamp}`, inquiries: [inquiry("Owned lead message")] },
  });
  const spam = await seed(request, {
    title: `Today Spam ${stamp}`,
    labels: ["likely-spam"],
    custom: {
      company: `Today Spam Co ${stamp}`,
      inquiries: [{ ...inquiry("Spam lead message"), spam_verdict: "likely_spam", spam_score: 0.9 }],
    },
  });
  await openWorkspace(page, "/today");
  const card = page.locator(".one-lead").filter({ hasText: `Today Owned Co ${stamp}` });
  const link = card.getByRole("link", { name: `Today Owned Co ${stamp}` });
  await expect(link).toHaveAttribute("href", `/pipeline/${owned}`);
  await expect(card.getByRole("button", { name: /^Take / })).toBeVisible();
  // Likely spam stays out of Today, but its direct link still opens.
  await expect(page.getByText(`Today Spam Co ${stamp}`)).toHaveCount(0);
  // A modified click opens the same address in a new tab and leaves this page where it is.
  const [tab] = await Promise.all([
    page.context().waitForEvent("page"),
    link.click({ modifiers: ["ControlOrMeta"] }),
  ]);
  expect(new URL(tab.url()).pathname).toBe(`/pipeline/${owned}`);
  await tab.close();
  await expect(page).toHaveURL(/\/today$/);
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/pipeline/${owned}$`));
  await page.goBack();
  await expect(page).toHaveURL(/\/today$/);
  await page.goto(`/pipeline/${spam}`);
  await expect(page.getByRole("region", { name: "Spam check" })).toContainText("Likely spam");
  await expect(page).toHaveTitle(`Today Spam Co ${stamp} · Prospectus · Anthus`);
});

test("a lead page takes the lead and reports a competing edit as a conflict", async ({ page, request }) => {
  test.skip(!token, "Set PROSPECTUS_TEST_TOKEN and run the real Kanbus API on port 5418.");
  const stamp = Date.now();
  const id = await seed(request, {
    title: `Conflict Person ${stamp}`,
    assignee: "someone-else",
    custom: { company: `Conflict Co ${stamp}`, next_action: "Reply", next_follow_up_at: "2026-12-01" },
  });
  await openWorkspace(page, `/pipeline/${id}`);
  const lead = page.getByRole("main", { name: "Lead" });
  await lead.getByRole("button", { name: /^Take / }).click();
  await expect(page.locator(".notice")).toHaveText("Saved.");
  await expect(lead.getByRole("button", { name: /^Take / })).toHaveCount(0);
  const current = await (
    await request.get(`${apiOrigin}${KANBUS_API_PATH}/issues/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json();
  expect(current.issue.assignee).not.toBe("someone-else");
  // Another person saves first; this page still holds the older revision.
  const competing = await request.patch(`${apiOrigin}${KANBUS_API_PATH}/issues/${id}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "If-Match": current.revision,
      "X-Operation-Id": randomUUID(),
    },
    data: { custom: { next_action: "Changed by someone else" } },
  });
  expect(competing.ok()).toBe(true);
  await lead.getByLabel("Next action", { exact: true }).fill("My change");
  await lead.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("alert")).toContainText("Someone changed this prospect");
  await page.getByRole("button", { name: "Reload latest record" }).click();
  await expect(lead.getByLabel("Next action", { exact: true })).toHaveValue("Changed by someone else");
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
