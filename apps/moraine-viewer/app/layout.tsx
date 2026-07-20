import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const plexSans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  weight: ["400", "500", "600"],
  subsets: ["latin"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  weight: ["400", "500"],
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Moraine Viewer — Understudy",
  description: "Explore your agent traces: map, river, anatomy, leaderboard.",
};

const NAV = [
  { href: "/timeline", label: "timeline" },
  { href: "/tasks", label: "tasks" },
  { href: "/map", label: "map" },
  { href: "/river", label: "river" },
  { href: "/anatomy", label: "anatomy" },
  { href: "/leaderboard", label: "leaderboard" },
];

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${plexSans.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <header className="flex items-center gap-6 px-6 py-3 border-b border-rule">
          <Link href="/" className="mono text-sm text-ink-bright tracking-wide">
            understudy<span className="text-stamp">/</span>moraine
          </Link>
          <nav className="mono flex gap-4 text-xs text-ink-muted">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className="hover:text-ink-bright transition-colors">
                {n.label}
              </Link>
            ))}
          </nav>
        </header>
        <main className="flex-1 flex flex-col">{children}</main>
      </body>
    </html>
  );
}
