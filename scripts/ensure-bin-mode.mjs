#!/usr/bin/env node

import { chmodSync } from "node:fs";

if (process.platform !== "win32") {
  chmodSync(new URL("../dist/bin.js", import.meta.url), 0o755);
}
