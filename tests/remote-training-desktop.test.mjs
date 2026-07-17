import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("remote training remains an off-by-default explicit-consent experiment", async () => {
  const [native, panel, localPanel, tauriLib] = await Promise.all([
    read("apps/homescreen/src-tauri/src/remote_training.rs"),
    read("apps/homescreen/app/components/RemoteTrainingPanel.tsx"),
    read("apps/homescreen/app/components/LocalTrainingPanel.tsx"),
    read("apps/homescreen/src-tauri/src/lib.rs"),
  ]);

  assert.match(native, /UNDERSTUDY_REMOTE_TRAINING_EXPERIMENT/);
  assert.match(native, /Remote training is an off-by-default experiment/);
  assert.match(native, /if !confirm_upload \|\| !confirm_spend/);
  assert.match(native, /confirm_temporary_deployment/);
  assert.match(native, /sha256_bytes\(&bytes\) != artifact\.sha256/);
  assert.match(native, /leakage-group overlap/);
  assert.match(native, /raw_rows_in_telemetry/);
  assert.match(native, /Method::DELETE,[\s\S]*api_url\("uploads"\)/);
  assert.match(native, /existing_remote_classification_training/);

  assert.match(panel, /Nothing uploads until you review the exact artifacts and budget/);
  assert.match(panel, /Upload only these three private split artifacts/);
  assert.match(panel, /never spend more than/);
  assert.match(panel, /temporary endpoint for held-out comparison/);
  assert.match(panel, /remote_training_poll/);
  assert.match(panel, /cancel_remote_training/);
  assert.match(panel, /Where it still fails/);

  assert.match(localPanel, /remote_training_capabilities/);
  assert.match(localPanel, /remoteCapabilityState === "available" && !forceLocal/);
  assert.match(panel, /Train on this Mac/);
  assert.match(tauriLib, /remote_training::start_remote_classification_training/);
});
