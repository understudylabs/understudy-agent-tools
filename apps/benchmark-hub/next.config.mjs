import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Unlike homescreen this app keeps the Node server: the flag route handler
  // appends to flags.jsonl on disk, so no static export.
  outputFileTracingRoot: appDir,
  reactStrictMode: true,
  devIndicators: false,
};

export default nextConfig;
