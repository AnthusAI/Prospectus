import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}", "./.build/kanbus/packages/ui/dist/**/*.{js,jsx}"],
  theme: { extend: { colors: {
    background: "var(--background)", card: "var(--card)", "card-muted": "var(--card-muted)",
    frame: "var(--frame)", column: "var(--column)", foreground: "var(--text-foreground)",
    muted: "var(--text-muted)", selected: "var(--text-selected)", border: "var(--border)",
  } } },
  plugins: [],
} satisfies Config;
