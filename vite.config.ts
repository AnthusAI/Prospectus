import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { KANBUS_API_PATH } from "./src/board";

export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ["react", "react-dom"] },
  server: {
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
