import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Ship as a static bundle Tauri serves from the WKWebView — no Node server.
  output: "export",
  outputFileTracingRoot: appDir,
  // No Next image server in a static export.
  images: { unoptimized: true },
  // Tauri dev server lives on 1420; allow it to drive the webview.
  reactStrictMode: true,
  // The in-app shell already has native chrome; hide Next's dev-mode badge.
  devIndicators: false,
};

export default nextConfig;
