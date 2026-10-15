import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser",
  fullyParallel: false,
  workers: 1,
  use: { baseURL: process.env.PROSPECTUS_REVIEW_URL ?? "http://127.0.0.1:5417", viewport: { width: 1440, height: 1000 }, trace: "off", launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } },
  webServer: process.env.PROSPECTUS_LAN_TEST ? undefined : { command: "npm run dev", url: process.env.PROSPECTUS_REVIEW_URL ?? "http://127.0.0.1:5417", reuseExistingServer: !process.env.CI },
});
