import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("one cloud launch authorizes the bounded hosted workflow without repeated approval gates", async () => {
  const [agentPrompt, orchestrator, gateway, privacy, proposals, routeDecision] = await Promise.all([
    read("apps/homescreen/src-tauri/src/chat.rs"),
    read("skills/understudy/SKILL.md"),
    read("skills/use-understudy-gateway/SKILL.md"),
    read("docs/privacy-and-data-boundaries.md"),
    read("docs/environment-proposals.md"),
    read("src/route-decision.ts"),
  ]);

  for (const policy of [agentPrompt, orchestrator, gateway, privacy, proposals]) {
    assert.match(policy, /launch|activat/i);
    assert.match(policy, /upload/i);
    assert.match(policy, /provider/i);
    assert.match(policy, /cleanup/i);
  }
  assert.match(agentPrompt, /named launch action as authorization/);
  assert.match(orchestrator, /Do not add dry-run or[\s\S]*phase-by-phase approval gates/);
  assert.match(gateway, /Do not pause for another confirmation between those phases/);
  assert.match(privacy, /without another prompt/);
  assert.match(proposals, /No second\s+confirmation is required/);
  assert.match(routeDecision, /kind: "understudy"/);
  assert.match(routeDecision, /model: "auto"/);
  assert.doesNotMatch(routeDecision, /local-only until explicit approval/);
  assert.doesNotMatch(agentPrompt, /Work local-first/);
});

test("remote training uses live capabilities with explicit upload and spend consent", async () => {
  const [native, panel, localPanel, localSftPanel, tauriLib, portablePlan, bundledCli] = await Promise.all([
    read("apps/homescreen/src-tauri/src/remote_training.rs"),
    read("apps/homescreen/app/components/RemoteTrainingPanel.tsx"),
    read("apps/homescreen/app/components/LocalTrainingPanel.tsx"),
    read("apps/homescreen/app/components/LocalSftTrainingPanel.tsx"),
    read("apps/homescreen/src-tauri/src/lib.rs"),
    read("src/training-plan/index.ts"),
    read("apps/homescreen/src-tauri/resources/understudy-cli/bundle/understudy.js"),
  ]);

  assert.doesNotMatch(native, /UNDERSTUDY_REMOTE_TRAINING_EXPERIMENT/);
  assert.doesNotMatch(native, /off-by-default experiment/);
  assert.match(native, /if !confirm_upload \|\| !confirm_spend/);
  assert.match(native, /confirm_temporary_deployment/);
  assert.match(native, /sha256_bytes\(&bytes\) != artifact\.sha256/);
  assert.match(native, /leakage-group overlap/);
  assert.match(native, /raw_rows_in_telemetry/);
  assert.match(native, /max_upload_bytes/);
  assert.match(native, /MAX_REMOTE_TRAINING_BUDGET_USD: f64 = 1_000\.0/);
  assert.match(portablePlan, /MAX_PORTABLE_TRAINING_SPEND_USD = 1_000/);
  assert.match(bundledCli, /MAX_PORTABLE_TRAINING_SPEND_USD = 1000/);
  assert.doesNotMatch(portablePlan, /MAX_PORTABLE_TRAINING_SPEND_USD = 500/);
  assert.match(native, /Method::DELETE,[\s\S]*api_url\("uploads"\)/);
  assert.match(native, /existing_remote_classification_training/);
  assert.match(native, /existing_remote_training/);
  assert.match(native, /compile_remote_training_backends/);
  assert.match(native, /understudy training run-tinker-sft/);
  assert.match(native, /tinker_python_sdk/);
  assert.match(native, /one_hour_sampler_weights/);
  assert.match(native, /fn managed_capabilities/);
  assert.match(native, /value\["providers"\] = json!\(\[managed\]\)/);
  assert.match(native, /gsm8k_public_rows/);
  assert.match(native, /public_gsm8k_messages/);
  assert.match(native, /understudy\.remote_training\.recipe_inspection\.v1/);
  assert.match(native, /gsm8k_final_answer/);
  assert.match(native, /preference_optimization/);
  assert.match(native, /agentic_tool_use/);
  assert.match(native, /vision_language/);
  assert.match(native, /prepare_remote_training_recipe/);
  assert.match(native, /automatic_training_goal_card/);
  assert.match(native, /propose_training_environment_with_pi/);
  assert.match(native, /crate::chat::agent_metadata_chat/);
  assert.match(native, /<DATA>\{dataset_context\}<\/DATA>/);
  assert.match(native, /pi_dataset_context/);
  assert.match(native, /"" \| "csv" \| "tsv" \| "tab" \| "txt"/);
  assert.match(native, /dataset_context_shared_with_active_model/);
  assert.match(native, /"status": "analyzed"/);
  assert.match(native, /"environment_summary": environment_summary/);
  assert.match(native, /"validation_summary": validation_summary/);
  assert.match(native, /"inferring",[\s\S]*?agent_metadata_chat\([\s\S]*?"checking",[\s\S]*?pi_plan_check/);
  const chatNative = await read("apps/homescreen/src-tauri/src/chat.rs");
  assert.match(chatNative, /pub async fn agent_metadata_chat/);
  assert.match(chatNative, /request\["tools"\] = json!\(\[\]\)/);
  assert.match(chatNative, /request\["max_tool_rounds"\] = json!\(0\)/);
  assert.match(chatNative, /remove\("tool_executor_url"\)/);
  assert.match(chatNative, /METADATA_CHAT_TIMEOUT_SECS: u64 = 45/);
  assert.match(chatNative, /conversation_runtime_cancel\(session_id\.to_string\(\)\)/);
  assert.match(native, /Return JSON only \(max 400 tokens\)/);
  assert.match(native, /runtime_backend != "pi"/);
  assert.match(native, /remote_content_shared": remote_analysis/);
  assert.match(native, /"status": "proposed"/);
  assert.match(native, /"oracle_scores_one": false/);
  assert.match(native, /prepare_training_recipe/);
  assert.match(native, /prepare_classification_source_plan/);
  assert.doesNotMatch(native, /pub async fn prepare_remote_gsm8k_training/);
  assert.match(native, /duplicates a prompt and could leak across splits/);
  assert.match(native, /dropped dataset changed after recipe detection/i);

  assert.match(panel, /Nothing uploads until you review the exact artifacts and budget/);
  assert.match(panel, /\{plan\.artifacts\.length\} private splits · endpoint auto-deletes/);
  assert.match(panel, /remote_training_poll/);
  assert.match(panel, /cancel_remote_training/);
  assert.match(panel, /start_remote_training/);
  assert.match(panel, /existing_remote_training/);
  assert.match(panel, /compile_remote_training_backends/);
  assert.match(panel, /preparedPlan/);
  assert.match(panel, /Upload & train/);
  assert.doesNotMatch(panel, /Upload & train · \$/);
  assert.match(panel, /budget guardrail/);
  assert.match(panel, /remote-training-example-track/);
  assert.match(panel, /trainingExamples/);
  assert.doesNotMatch(panel, /fake/);
  assert.doesNotMatch(native, /"fake"/);
  assert.doesNotMatch(panel, /Approve & run/);
  assert.doesNotMatch(panel, /<summary>Details<\/summary>/);
  assert.match(panel, /<summary>Run details<\/summary>/);
  assert.match(panel, /provider_error/);
  assert.match(panel, /terminal_error/);
  assert.match(panel, /Provider spend/);
  assert.match(panel, /Budget accounted/);
  assert.match(panel, /This run predates detailed failure receipts/);
  assert.match(native, /join\("result\.json"\)/);
  assert.match(native, /Some\("completed" \| "failed" \| "cancelled"\)/);
  assert.match(panel, /private splits · endpoint auto-deletes/);
  assert.doesNotMatch(panel, /type="checkbox"/);
  assert.match(panel, /Where it still fails/);
  assert.match(panel, /understudy\/auto/);
  assert.match(panel, /provider\.id === "managed"/);
  assert.match(panel, /provider\.id === "managed" && provider\.enabled/);
  assert.match(panel, /recommendedManagedTrainingSpend\(capabilities\)/);
  assert.match(panel, /return maximumManagedTrainingSpend\(capabilities\)/);
  assert.match(panel, /remote_training_examples/);
  assert.match(native, /understudy\.remote_training\.example_stream\.v1/);
  assert.match(panel, /remoteTrainingArtifactLimitError/);
  assert.doesNotMatch(panel, /fireworks/i);
  assert.doesNotMatch(panel, /gemma-4/i);
  assert.match(native, /"model_profiles"/);
  const chat = await read("apps/homescreen/app/components/ChatPane.tsx");
  const globals = await read("apps/homescreen/app/globals.css");
  assert.match(chat, /inspect_remote_training_recipe/);
  assert.match(chat, /AutomaticGoalCard/);
  assert.match(chat, /StructuredDataProfile/);
  assert.match(chat, /StructuredTrainingPlan/);
  assert.match(chat, /structured-dataset-analysis/);
  assert.match(chat, /<StructuredDatasetProfilePage[\s\S]*?sourceName=\{droppedWorkload\.source_name\}/);
  assert.match(chat, /messageId=\{`\$\{sessionId\}:workload`\}[\s\S]*?scrollAnchor[\s\S]*?workload-scroller-item/);
  assert.match(chat, /autoScroll=\{!droppedWorkload\}/);
  assert.match(chat, /scrollMargin=\{droppedWorkload \? 24 : 0\}/);
  assert.match(chat, /automatic_training_goal_card/);
  assert.match(chat, /previewLimit: 2/);
  assert.match(chat, /propose_training_environment_with_pi/);
  assert.match(chat, /new Channel<PiDatasetAnalysisEvent>/);
  assert.match(chat, /automatic-goal-card-stages/);
  assert.match(chat, /Dataset analysis progress/);
  assert.match(chat, /Source examples/);
  assert.match(chat, /inspection\.row_preview/);
  assert.match(chat, /No readable examples found/);
  assert.match(chat, /automatic-goal-card-preview-grid/);
  assert.match(chat, /automatic-goal-card-skeleton/);
  assert.match(chat, /PiAnalysisElapsed/);
  assert.match(chat, /piDatasetAnalysisFailure/);
  assert.match(chat, /Retry analysis/);
  assert.match(chat, /environmentArchitectRetry/);
  assert.match(chat, /TableExampleCards/);
  assert.match(chat, /2 · Understudy analysis/);
  assert.match(chat, /3 · confirm the training plan/);
  assert.match(chat, /<PiAnalysisRail[\s\S]*?<PiDesignCards/);
  assert.match(chat, /StructuredDatasetProfilePage[\s\S]*?2 · Understudy analysis[\s\S]*?3 · confirm the training plan/);
  assert.match(chat, /datasetProfileConfirmed/);
  assert.match(chat, /Yes, analyze this dataset/);
  assert.match(chat, /!datasetProfileConfirmed/);
  assert.match(globals, /\.workload-scroller-item[\s\S]*?content-visibility: visible/);
  assert.match(globals, /\.automatic-goal-card-design > \.automatic-goal-card-error/);
  assert.match(globals, /\.pi-analysis-elapsed/);
  assert.match(globals, /\.csv-training-plan-step[\s\S]*?padding: 34px 18px 17px/);
  assert.match(globals, /@keyframes analysis-card-enter[\s\S]*?transform: translateY/);
  assert.doesNotMatch(chat, /<details className="automatic-goal-card-preview">/);
  assert.match(chat, /route: selectedChoice\.route/);
  assert.match(chat, /progress=\{environmentArchitectProgress\}/);
  assert.match(chat, /prepare_remote_training_recipe/);
  assert.match(chat, /recipeId: trainingRecipe\.recipe_id/);
  assert.match(chat, /backend\.id === "mlx-local" && backend\.compatible && backend\.execution_ready/);
  assert.doesNotMatch(chat, /trainingRecipe\.evaluator !== "gsm8k_final_answer"/);
  assert.doesNotMatch(chat, /GSM8K reasoning model|frontierModel:\s*"glm-5\.2"/);
  assert.match(chat, /if \(!remoteRecipePlan && trainingRecipe\?\.ready\) prepareDetectedRecipe\(\)/);
  assert.doesNotMatch(chat, /Prepare no-spend plan/);
  assert.match(chat, /<LocalSftTrainingPanel/);
  assert.match(chat, /recipeBackend === "managed"/);
  assert.match(chat, /<RemoteTrainingPanel/);
  assert.match(chat, /openManagedRecipeTraining/);
  assert.match(chat, /remote_training_capabilities/);
  assert.match(chat, /recommendedManagedTrainingSpend\(capabilities\)/);
  assert.match(chat, /remoteTrainingArtifactLimitError\(plan, capabilities\)/);
  assert.doesNotMatch(chat, /Continue to remote training/);
  assert.match(chat, /maximumSpendUsd:\s*0/);
  assert.doesNotMatch(chat, /maximumSpendUsd:\s*1/);
  assert.match(chat, /setRecipeBackend\("local"\)/);
  assert.match(chat, /plan=\{remoteRecipePlan\}/);
  assert.match(chat, /onActiveChange=\{setLocalTrainingActive\}/);
  assert.match(chat, /onRunViewChange=\{setRemoteTrainingView\}/);
  assert.match(chat, /trainingExamples=\{trainingRecipe\.row_preview\}/);
  assert.match(chat, /!remoteTrainingView && <AutomaticGoalCard/);
  assert.match(localSftPanel, /start_local_sft_training/);
  assert.match(localSftPanel, /compile_remote_training_backends/);
  assert.match(localSftPanel, /Training locally · \$0/);
  assert.match(localSftPanel, /Offline · no upload/);
  assert.match(localSftPanel, /Try cloud<\/button>/);
  assert.doesNotMatch(localSftPanel, /plan\.maximum_spend_usd\.toFixed/);
  assert.doesNotMatch(localSftPanel, /fireworks|fake endpoint/i);

  assert.match(localPanel, /remote_training_capabilities/);
  assert.doesNotMatch(localPanel, /remoteCapabilityState === "available" && !forceLocal/);
  assert.match(localPanel, /if \(autoStart\) return null;[\s\S]*?remoteCapabilityState === "available"/);
  assert.match(panel, /Train on this Mac/);
  assert.match(tauriLib, /remote_training::start_remote_classification_training/);
  assert.match(tauriLib, /remote_training::start_remote_training/);
  assert.match(tauriLib, /remote_training::existing_remote_training/);
  assert.match(tauriLib, /remote_training::compile_remote_training_backends/);
  assert.match(tauriLib, /remote_training::inspect_remote_training_recipe/);
  assert.match(tauriLib, /remote_training::automatic_training_goal_card/);
  assert.match(tauriLib, /remote_training::propose_training_environment_with_pi/);
  assert.match(tauriLib, /remote_training::prepare_remote_training_recipe/);
  assert.doesNotMatch(tauriLib, /remote_training::prepare_remote_gsm8k_training/);
  assert.match(tauriLib, /remote_training::start_local_sft_training/);
  assert.match(tauriLib, /remote_training::cancel_local_sft_training/);
});
