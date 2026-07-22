import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { ThemeToggle } from "@/components/theme-toggle";
import "./globals.css";

export const metadata: Metadata = {
  title: "Understudy Benchmark Hub",
  description: "Local benchmark hub: manifests, evidence, leaderboards, flags.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Theme contract: default is system (`color-scheme: light dark`); an
  // explicit choice persists as a `theme` cookie and renders as
  // <html data-theme="light|dark"> per the trace-viewer contract.
  const cookieTheme = (await cookies()).get("theme")?.value;
  const theme = cookieTheme === "light" || cookieTheme === "dark" ? cookieTheme : "system";
  return (
    <html lang="en" {...(theme === "system" ? {} : { "data-theme": theme })}>
      <body className="min-h-screen antialiased">
        <nav className="u-nav">
          <div className="u-nav-in">
            <Link href="/" className="u-brand">
              <span className="u-pulse" aria-hidden />
              Understudy
              <span className="tag">LOCAL</span>
            </Link>
            <div className="u-links mono">
              <Link href="/">Hub</Link>
              <a href="#docs">Docs</a>
              <ThemeToggle initial={theme} />
            </div>
          </div>
        </nav>
        <main className="u-wrap">{children}</main>
        <footer className="u-footer" id="docs">
          <div className="u-wrap">
            <span>Understudy · benchmark hub · local, single-user, evidence-first</span>
            <span className="mono">Overall = mean strict score over scored rows · cost = cost per successful task</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
