import type { Metadata } from "next";
import { IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "./lib/theme";
import { TooltipProvider } from "./components/base-ui/tooltip";

const plexMono = IBM_Plex_Mono({
  weight: ["300", "400", "500", "600"],
  subsets: ["latin"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Understudy",
  description: "Local models, gateway, and agent traces.",
};

// Set theme before paint to avoid FOUC. Default dark; "system" follows OS.
const noFlash = `(function(){try{var t=localStorage.getItem('understudy-theme')||'dark';var s=t==='system'?(window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'):t;var r=document.documentElement;r.setAttribute('data-theme',t);r.setAttribute('data-sys',s);}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={plexMono.variable}
      data-theme="dark"
      data-sys="dark"
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: noFlash }} />
      </head>
      <body>
        <ThemeProvider>
          <TooltipProvider>{children}</TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
