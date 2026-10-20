import { useEffect, useState } from "react";

export type PortalTheme = "system" | "light" | "dark";
const THEME_KEY = "anthus-one.theme";

/** A per-browser appearance preference; storage may be unavailable, so it always falls back to system. */
export function usePortalTheme(): [PortalTheme, (theme: PortalTheme) => void] {
  const [theme, setTheme] = useState<PortalTheme>(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      return saved === "light" || saved === "dark" ? saved : "system";
    } catch {
      return "system";
    }
  });
  useEffect(() => {
    try {
      if (theme === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch {}
  }, [theme]);
  return [theme, setTheme];
}
