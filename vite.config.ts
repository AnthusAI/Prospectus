import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { KANBUS_API_PATH } from "./src/board";
import { billingDeployment, consoleBillingDefine } from "./billing/deployment";

// One reviewed flag, billing/deployment.json, turns the backend routes and the console pages on together.
const billing = billingDeployment(JSON.parse(readFileSync("billing/deployment.json", "utf8")));

export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ["react", "react-dom"] },
  define: consoleBillingDefine(billing),
  server: {
    // dev:cloud --lan serves HTTPS at a network name so phones and tablets can sign in.
    ...(process.env.PROSPECTUS_DEV_TLS_CERT
      ? {
          https: {
            cert: readFileSync(process.env.PROSPECTUS_DEV_TLS_CERT),
            key: readFileSync(process.env.PROSPECTUS_DEV_TLS_KEY!),
          },
          allowedHosts: [process.env.PROSPECTUS_DEV_HOST!],
        }
      : {}),
    proxy: {
      // dev:cloud forwards API calls to the deployed API so the browser stays same-origin.
      [KANBUS_API_PATH]: process.env.PROSPECTUS_CLOUD_API_ORIGIN
        ? {
            target: process.env.PROSPECTUS_CLOUD_API_ORIGIN,
            changeOrigin: true,
            headers: { origin: "https://prospectus.anth.us" },
          }
        : (process.env.PROSPECTUS_LOCAL_API_ORIGIN ?? "http://127.0.0.1:5418"),
      ...(process.env.PROSPECTUS_CLOUD_API_ORIGIN
        ? {
            "/api/saas": {
              target: process.env.PROSPECTUS_CLOUD_API_ORIGIN,
              changeOrigin: true,
              headers: { origin: "https://prospectus.anth.us" },
            },
          }
        : {}),
      "/intake": process.env.PROSPECTUS_LOCAL_INTAKE_ORIGIN ?? "http://127.0.0.1:5491",
    },
  },
});
