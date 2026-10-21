import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { KANBUS_API_PATH } from "../../src/board";

const token = process.env.PROSPECTUS_TEST_TOKEN;
const apiOrigin = process.env.PROSPECTUS_LOCAL_API_ORIGIN ?? "http://127.0.0.1:5418";

test("likely spam is hidden behind a visible toggle, explained in the detail view and restored with Not spam", async ({
  page,
  request,
}) => {
  test.skip(!token, "Run with the isolated local proof fixture.");
  const title = `Spam check proof ${Date.now()}`;
  const created = await request.post(`${apiOrigin}${KANBUS_API_PATH}/issues`, {
    headers: { Authorization: `Bearer ${token}`, "X-Operation-Id": randomUUID() },
    data: {
      title,
      type: "prospect",
      assignee: "intake-queue",
      description: "Synthetic likely-spam record.",
      labels: ["likely-spam"],
      custom: {
        company: "Synthetic Review Co",
        contact_email: `spam-proof-${Date.now()}@example.com`,
        spam_status: "likely_spam",
        inquiries: [
          {
            id: randomUUID(),
            kind: "demo",
            name: title,
            email: "spam-proof@example.com",
            company: "Synthetic Review Co",
            message: "Synthetic message",
            received_at: "2026-10-20T10:00:00.000Z",
            spam_score: 0.784,
            spam_verdict: "likely_spam",
            spam_reasons: ["gibberish_name", "template_only_message", "gmail_dot_scatter"],
            spam_hints: [],
            spam_rules_version: "intake-spam-rules-1",
            spam_mode: "label",
            spam_protected: false,
          },
        ],
      },
    },
  });
  expect(created.ok()).toBe(true);
  const identifier = (await created.json()).issue.id as string;

  await page.goto("/");
  await page.getByLabel("Local access token").fill(token!);
  await page.getByRole("button", { name: "Open local workspace" }).click();
  await page.getByRole("link", { name: "Pipeline", exact: true }).click();
  await expect(page.getByText("Loading workspace…", { exact: true })).toHaveCount(0);
  await page
    .getByRole("group", { name: "Layout", exact: true })
    .getByRole("button", { name: "List" })
    .click();
  const hidden = page.locator(".one-spam-hidden");
  await expect(hidden).toContainText(/\d+ hidden as likely spam or spam\./);
  await expect(page.getByText(title, { exact: true })).toHaveCount(0);
  await hidden.getByRole("button", { name: "Show" }).click();
  await page.getByText(title, { exact: true }).click();

  const check = page.getByRole("region", { name: "Spam check", exact: true });
  await expect(check).toContainText("Likely spam");
  await expect(check).toContainText("score 0.78");
  await expect(check).toContainText("Name looks machine-generated");
  await expect(check).toContainText("Message is only the form's prompts");
  await expect(check).toContainText("Gmail address with scattered dots");
  await expect(check).toContainText("intake-spam-rules-1");

  await page.screenshot({ path: "test-results/spam-review-local-proof.png" });
  const saved = page.waitForResponse(
    (response) => response.request().method() === "PATCH" && response.url().includes(identifier),
  );
  await check.getByRole("button", { name: "Not spam", exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await expect(page.getByText("Saved.", { exact: false })).toBeVisible();

  const persisted = await request.get(`${apiOrigin}${KANBUS_API_PATH}/issues/${identifier}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const record = (await persisted.json()).issue;
  expect(record.labels ?? []).toEqual([]);
  expect(record.custom.next_action).toBe("Respond to demo request");
  expect(record.custom.next_follow_up_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(record.custom.spam_review.label).toBe("not_spam");
  expect(record.custom.spam_review.machine.verdict).toBe("likely_spam");
  expect(record.custom.spam_corrections).toHaveLength(1);

  // Once restored it is no longer hidden, and the detail view shows the review.
  await hidden
    .getByRole("button", { name: "Hide" })
    .click()
    .catch(() => undefined);
  await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Reviewed as Not spam", { exact: false })).toBeVisible();
});
