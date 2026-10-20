import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// The Anthus One customer portal (one.anth.us) is its own application: its own entry page and
// bundle, sharing only the account service and design tokens with the staff console.
export default defineConfig({
  root: resolve(__dirname, "portal"),
  publicDir: resolve(__dirname, "public"),
  envDir: __dirname,
  plugins: [react()],
  // The entry page lives in portal/; its code stays in src/portal/ beside the shared modules.
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [{ find: /^\/src\//, replacement: `${resolve(__dirname, "src")}/` }],
  },
  build: { outDir: resolve(__dirname, "dist-portal"), emptyOutDir: true },
  server: {
    proxy: {
      // dev:portal forwards account calls to the deployed API so the browser stays same-origin.
      ...(process.env.PROSPECTUS_CLOUD_API_ORIGIN
        ? {
            "/api": {
              target: process.env.PROSPECTUS_CLOUD_API_ORIGIN,
              changeOrigin: true,
              headers: { origin: "https://prospectus.anth.us" },
            },
          }
        : {}),
    },
  },
});
