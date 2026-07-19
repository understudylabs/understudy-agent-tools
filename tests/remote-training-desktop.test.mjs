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
  assert.match(native, /max_upload_bytes/);
  assert.match(native, /Method::DELETE,[\s\S]*api_url\("uploads"\)/);
  assert.match(native, /existing_remote_classification_training/);
  assert.match(native, /understudy\.remote_training\.recipe_inspection\.v1/);
  assert.match(native, /gsm8k_final_answer/);
  assert.match(native, /preference_optimization/);
  assert.match(native, /agentic_tool_use/);
  assert.match(native, /vision_language/);
  assert.match(native, /prepare_remote_gsm8k_training/);
  assert.match(native, /duplicates a prompt and could leak across splits/);
  assert.match(native, /dropped dataset changed after recipe detection/i);

  assert.match(panel, /Nothing uploads until you review the exact artifacts and budget/);
  assert.match(panel, /Upload only these three private split artifacts/);
  assert.match(panel, /reported estimate reaches/);
  assert.match(panel, /temporary endpoint for held-out comparison/);
  assert.match(panel, /then always remove it/);
  assert.match(panel, /remote_training_poll/);
  assert.match(panel, /cancel_remote_training/);
  assert.match(panel, /Where it still fails/);
  assert.match(panel, /understudy\/auto/);
  assert.match(panel, /provider\.id === "managed"/);
  assert.doesNotMatch(panel, /fireworks/i);
  assert.doesNotMatch(panel, /gemma-4/i);
  assert.match(native, /"model_profiles"/);
  const chat = await read("apps/homescreen/app/components/ChatPane.tsx");
  assert.match(chat, /inspect_remote_training_recipe/);
  assert.match(chat, /detected use case/);
  assert.match(chat, /Held-out evaluator/);
  assert.match(chat, /before any upload or spend/);

  assert.match(localPanel, /remote_training_capabilities/);
  assert.match(localPanel, /remoteCapabilityState === "available" && !forceLocal/);
  assert.match(panel, /Train on this Mac/);
  assert.match(tauriLib, /remote_training::start_remote_classification_training/);
  assert.match(tauriLib, /remote_training::inspect_remote_training_recipe/);
  assert.match(tauriLib, /remote_training::prepare_remote_gsm8k_training/);
});
