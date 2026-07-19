import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Understudy Benchmark Hub",
  description: "Local benchmark hub: manifests, evidence, leaderboards, flags.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <header className="border-b border-rule px-6 py-4 flex items-baseline gap-3">
          <Link href="/" className="font-mono text-sm tracking-wide text-stamp font-semibold">
            understudy
          </Link>
          <span className="text-ink text-sm font-medium">Benchmark Hub</span>
          <span className="text-ink-muted text-xs">local · single-user · evidence-first</span>
        </header>
        <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
