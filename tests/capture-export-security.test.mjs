import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { writePrivateText } from "../dist/commands/captures.js";

test(
  "capture exports do not follow predictable temporary-file symlinks",
  { skip: process.platform === "win32" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "understudy-capture-export-"));
    try {
      const outputPath = join(root, "capture.json");
      const victimPath = join(root, "victim.txt");
      const predictablePartialPath = `${outputPath}.${process.pid}.partial`;
      writeFileSync(victimPath, "unchanged\n");
      symlinkSync(victimPath, predictablePartialPath);

      writePrivateText(outputPath, "private capture\n");

      assert.equal(readFileSync(outputPath, "utf8"), "private capture\n");
      assert.equal(readFileSync(victimPath, "utf8"), "unchanged\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
