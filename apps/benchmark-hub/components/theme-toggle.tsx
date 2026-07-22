"use client";

import { useEffect, useState } from "react";

type Theme = "system" | "light" | "dark";
const ORDER: Theme[] = ["system", "light", "dark"];
const LABEL: Record<Theme, string> = { system: "AUTO", light: "LIGHT", dark: "DARK" };

/**
 * Cycling theme toggle (system → light → dark). Persists as a `theme` cookie
 * so the server layout can render `data-theme` on <html> (curl-testable with
 * `-H 'Cookie: theme=light'`); default is system via `color-scheme: light dark`.
 */
export function ThemeToggle({ initial }: { initial: Theme }) {
  const [theme, setTheme] = useState<Theme>(initial);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") delete root.dataset.theme;
    else root.dataset.theme = theme;
    document.cookie = `theme=${theme}; path=/; max-age=31536000; samesite=lax`;
  }, [theme]);

  const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];
  return (
    <button
      type="button"
      className="u-theme-toggle mono"
      aria-label={`Theme: ${theme}. Switch to ${next}.`}
      title={`Theme: ${theme} — click for ${next}`}
      onClick={() => setTheme(next)}
    >
      ◐ {LABEL[theme]}
    </button>
  );
}
