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
  assert.match(native, /existing_remote_training/);
  assert.match(native, /compile_remote_training_backends/);
  assert.match(native, /gsm8k_public_rows/);
  assert.match(native, /public_gsm8k_messages/);
  assert.match(native, /understudy\.remote_training\.recipe_inspection\.v1/);
  assert.match(native, /gsm8k_final_answer/);
  assert.match(native, /preference_optimization/);
  assert.match(native, /agentic_tool_use/);
  assert.match(native, /vision_language/);
  assert.match(native, /prepare_remote_gsm8k_training/);
  assert.match(native, /duplicates a prompt and could leak across splits/);
  assert.match(native, /dropped dataset changed after recipe detection/i);

  assert.match(panel, /Nothing uploads until you review the exact artifacts and budget/);
  assert.match(panel, /Uploads \{plan\.artifacts\.length\} split files/);
  assert.match(panel, /deletes the evaluation endpoint/);
  assert.match(panel, /remote_training_poll/);
  assert.match(panel, /cancel_remote_training/);
  assert.match(panel, /start_remote_training/);
  assert.match(panel, /existing_remote_training/);
  assert.match(panel, /compile_remote_training_backends/);
  assert.match(panel, /Portable backend recipe/);
  assert.match(panel, /preparedPlan/);
  assert.match(panel, /Run proof/);
  assert.doesNotMatch(panel, /Approve & run/);
  assert.match(panel, /<summary>Details<\/summary>/);
  assert.match(panel, /no provider spend/);
  assert.doesNotMatch(panel, /type="checkbox"/);
  assert.match(panel, /Where it still fails/);
  assert.match(panel, /understudy\/auto/);
  assert.match(panel, /provider\.id === "managed"/);
  assert.doesNotMatch(panel, /fireworks/i);
  assert.doesNotMatch(panel, /gemma-4/i);
  assert.match(native, /"model_profiles"/);
  const chat = await read("apps/homescreen/app/components/ChatPane.tsx");
  assert.match(chat, /inspect_remote_training_recipe/);
  assert.match(chat, /prepare_remote_gsm8k_training/);
  assert.match(chat, /if \(!remoteRecipePlan && trainingRecipe\?\.ready\) prepareDetectedRecipe\(\)/);
  assert.doesNotMatch(chat, /Prepare no-spend plan/);
  assert.match(chat, /preparedPlan=\{remoteRecipePlan\}/);
  assert.match(chat, /onActiveChange=\{setLocalTrainingActive\}/);

  assert.match(localPanel, /remote_training_capabilities/);
  assert.match(localPanel, /remoteCapabilityState === "available" && !forceLocal/);
  assert.match(panel, /Train on this Mac/);
  assert.match(tauriLib, /remote_training::start_remote_classification_training/);
  assert.match(tauriLib, /remote_training::start_remote_training/);
  assert.match(tauriLib, /remote_training::existing_remote_training/);
  assert.match(tauriLib, /remote_training::compile_remote_training_backends/);
  assert.match(tauriLib, /remote_training::inspect_remote_training_recipe/);
  assert.match(tauriLib, /remote_training::prepare_remote_gsm8k_training/);
});
