import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname, "portal"),
  publicDir: resolve(__dirname, "public"),
  envDir: __dirname,
  plugins: [react()],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [{ find: /^\/src\//, replacement: `${resolve(__dirname, "src")}/` }],
  },
  build: { outDir: resolve(__dirname, "dist-portal"), emptyOutDir: true },
  server: {
    proxy: {
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
