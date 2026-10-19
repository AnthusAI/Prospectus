import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ["react", "react-dom"] },
  server: {
    proxy: {
      "/api": process.env.PROSPECTUS_LOCAL_API_ORIGIN ?? "http://127.0.0.1:5418",
      "/intake": process.env.PROSPECTUS_LOCAL_INTAKE_ORIGIN ?? "http://127.0.0.1:5491",
    },
  },
});
