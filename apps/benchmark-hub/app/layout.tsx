import type { Metadata } from "next";
import { headers } from "next/headers";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-plex-sans",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
});

export const metadata: Metadata = {
  title: "Understudy Benchmark Hub",
  description: "Local benchmark hub: manifests, evidence, leaderboards, flags.",
};

/** TEMPORARY (wave 2′ accent preview): ?accent=stamp|cyan|mint via middleware. */
const PREVIEW_ACCENTS = new Set(["stamp", "cyan", "mint"]);

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const requested = (await headers()).get("x-accent-preview") ?? "stamp";
  const accent = PREVIEW_ACCENTS.has(requested) ? requested : "stamp";

  return (
    <html
      lang="en"
      data-theme="dark"
      data-accent={accent}
      className={`${plexSans.variable} ${plexMono.variable}`}
    >
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
