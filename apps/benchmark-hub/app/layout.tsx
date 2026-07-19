import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Understudy Benchmark Hub",
  description: "Local benchmark hub: manifests, evidence, leaderboards, flags.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="light">
      <body className="min-h-screen antialiased">
        <nav className="lb-nav">
          <div className="lb-nav-in">
            <Link href="/" className="lb-brand">
              <span className="lb-pulse" aria-hidden />
              Understudy
              <span className="tag">LOCAL</span>
            </Link>
            <div className="lb-links mono">
              <Link href="/">Hub</Link>
              <a href="#insights">Insights</a>
              <a href="#evidence">Evidence</a>
              <a href="#docs">Docs</a>
            </div>
          </div>
        </nav>
        <main className="lb-wrap">{children}</main>
        <footer className="lb-footer" id="docs">
          <div className="lb-wrap">
            <span>Understudy · benchmark hub · local, single-user, evidence-first</span>
            <span className="mono">Overall = mean of category averages · cost = cost per successful task</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
