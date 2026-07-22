import type { Metadata } from "next";
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" className={`${plexSans.variable} ${plexMono.variable}`}>
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
