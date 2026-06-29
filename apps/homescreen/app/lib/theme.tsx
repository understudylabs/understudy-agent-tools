"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

export type Theme = "dark" | "light" | "system";

type ThemeContextValue = { theme: Theme; setTheme: (t: Theme) => void };
const ThemeContext = createContext<ThemeContextValue>({
  theme: "dark",
  setTheme: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

function sysPrefersLight() {
  return typeof window !== "undefined"
    ? window.matchMedia("(prefers-color-scheme: light)").matches
    : false;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("dark");

  // Apply a theme to <html>: set data-theme, and data-sys so CSS can resolve "system".
  const apply = useCallback((t: Theme) => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    root.setAttribute("data-theme", t);
    root.setAttribute(
      "data-sys",
      t === "system" ? (sysPrefersLight() ? "light" : "dark") : t,
    );
  }, []);

  useEffect(() => {
    const stored = (localStorage.getItem("understudy-theme") as Theme) || "dark";
    setThemeState(stored);
    apply(stored);
  }, [apply]);

  // React to OS changes only while in "system" mode.
  useEffect(() => {
    if (theme !== "system" || typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => apply("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme, apply]);

  const setTheme = useCallback(
    (t: Theme) => {
      localStorage.setItem("understudy-theme", t);
      setThemeState(t);
      apply(t);
    },
    [apply],
  );

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
