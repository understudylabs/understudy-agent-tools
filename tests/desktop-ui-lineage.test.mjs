import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const cssPath = new URL("../apps/homescreen/app/globals.css", import.meta.url);
const layoutPath = new URL("../apps/homescreen/app/layout.tsx", import.meta.url);
const designPath = new URL("../apps/homescreen/app/design/page.tsx", import.meta.url);
const themePath = new URL("../apps/homescreen/app/lib/theme.tsx", import.meta.url);
const personaPath = new URL(
  "../apps/homescreen/components/ai-elements/persona.tsx",
  import.meta.url,
);
const tauriConfigPath = new URL(
  "../apps/homescreen/src-tauri/tauri.conf.json",
  import.meta.url,
);
const chatPath = new URL("../apps/homescreen/app/components/ChatPane.tsx", import.meta.url);
const messageScrollerPath = new URL(
  "../apps/homescreen/app/components/base-ui/message-scroller.tsx",
  import.meta.url,
);
const chatScrollControlsPath = new URL(
  "../apps/homescreen/app/components/ChatScrollControls.tsx",
  import.meta.url,
);
const classifierLibraryPath = new URL(
  "../apps/homescreen/app/components/LocalClassifierLibraryDialog.tsx",
  import.meta.url,
);
const trainingHaloPath = new URL(
  "../apps/homescreen/app/components/TrainingHalo.tsx",
  import.meta.url,
);
const evaluationRadarPath = new URL(
  "../apps/homescreen/app/components/EvaluationRadar.tsx",
  import.meta.url,
);
const csvTrainingPlanPath = new URL(
  "../apps/homescreen/app/components/CsvTrainingPlan.tsx",
  import.meta.url,
);
const sidebarPath = new URL("../apps/homescreen/app/components/Sidebar.tsx", import.meta.url);
const pagePath = new URL("../apps/homescreen/app/page.tsx", import.meta.url);
const runtimeRepairPromptPath = new URL(
  "../apps/homescreen/app/components/RuntimeRepairPrompt.tsx",
  import.meta.url,
);
const operationNoticePath = new URL(
  "../apps/homescreen/app/components/OperationNotice.tsx",
  import.meta.url,
);
const modelDownloadNoticePath = new URL(
  "../apps/homescreen/app/components/ModelDownloadNotice.tsx",
  import.meta.url,
);
const accountPanePath = new URL(
  "../apps/homescreen/app/components/AccountPane.tsx",
  import.meta.url,
);
const runtimeRepairLibPath = new URL(
  "../apps/homescreen/app/lib/runtime-repair.ts",
  import.meta.url,
);
const tauriLibPath = new URL(
  "../apps/homescreen/src-tauri/src/lib.rs",
  import.meta.url,
);
const attachmentLibPath = new URL(
  "../apps/homescreen/app/lib/chat-attachments.ts",
  import.meta.url,
);
const attachmentRustPath = new URL(
  "../apps/homescreen/src-tauri/src/chat_attachments.rs",
  import.meta.url,
);
const reviewViewPath = new URL(
  "../apps/homescreen/app/components/SupervisionReviewView.tsx",
  import.meta.url,
);
const reviewRustPath = new URL(
  "../apps/homescreen/src-tauri/src/supervision_review.rs",
  import.meta.url,
);
const tiebreakerRustPath = new URL(
  "../apps/homescreen/src-tauri/src/supervision_tiebreaker.rs",
  import.meta.url,
);
const tiebreakerCliPath = new URL(
  "../src/supervision/tiebreaker.ts",
  import.meta.url,
);
const toolProofRustPath = new URL(
  "../apps/homescreen/src-tauri/src/tool_proof.rs",
  import.meta.url,
);
const toolProofCliPath = new URL(
  "../src/desktop/tool-proof.ts",
  import.meta.url,
);
const statusPanePath = new URL(
  "../apps/homescreen/app/components/StatusPane.tsx",
  import.meta.url,
);
const modelsPanePath = new URL(
  "../apps/homescreen/app/components/ModelsPane.tsx",
  import.meta.url,
);
const modelCardDrawerPath = new URL(
  "../apps/homescreen/app/components/ModelCardDrawer.tsx",
  import.meta.url,
);
const modelCardLibPath = new URL(
  "../apps/homescreen/app/lib/model-cards.ts",
  import.meta.url,
);
const modelCardsPath = new URL(
  "../apps/homescreen/src-tauri/knowledge/model_cards.json",
  import.meta.url,
);
const modelAliasesPath = new URL(
  "../apps/homescreen/app/lib/model-aliases.ts",
  import.meta.url,
);
const rlmPanePath = new URL(
  "../apps/homescreen/app/components/RlmPane.tsx",
  import.meta.url,
);
const parityPath = new URL("../docs/desktop-product-parity.json", import.meta.url);
const modelMemoryPath = new URL(
  "../apps/homescreen/app/lib/model-memory.mjs",
  import.meta.url,
);
const streamPacerPath = new URL(
  "../apps/homescreen/app/lib/stream-pacer.mjs",
  import.meta.url,
);
const streamBatcherPath = new URL(
  "../apps/homescreen/app/lib/chat-stream-batcher.mjs",
  import.meta.url,
);
const desktopDbPath = new URL(
  "../apps/homescreen/src-tauri/src/db.rs",
  import.meta.url,
);
const desktopCommandsPath = new URL(
  "../apps/homescreen/src-tauri/src/commands.rs",
  import.meta.url,
);
const desktopMetricsPath = new URL(
  "../apps/homescreen/src-tauri/src/metrics.rs",
  import.meta.url,
);
const modelSelectionPath = new URL(
  "../apps/homescreen/app/lib/model-selection.mjs",
  import.meta.url,
);
const statusHookPath = new URL(
  "../apps/homescreen/app/lib/useStatus.ts",
  import.meta.url,
);
const workloadDropRustPath = new URL(
  "../apps/homescreen/src-tauri/src/workload_drop.rs",
  import.meta.url,
);
const workloadDropStatePath = new URL(
  "../apps/homescreen/app/lib/workload-drop-state.mjs",
  import.meta.url,
);
const localTrainingPath = new URL(
  "../apps/homescreen/app/components/LocalTrainingPanel.tsx",
  import.meta.url,
);
const localTrainingStatePath = new URL(
  "../apps/homescreen/app/lib/local-training-state.mjs",
  import.meta.url,
);
const captureImportPath = new URL("../src/capture-import.ts", import.meta.url);

test("public desktop preserves the reviewed Train interaction language", async () => {
  const [css, chat, sidebar, aliases, statusHook, page, runtimeRepairPrompt] = await Promise.all([
    readFile(cssPath, "utf8"),
    readFile(chatPath, "utf8"),
    readFile(sidebarPath, "utf8"),
    readFile(modelAliasesPath, "utf8"),
    readFile(statusHookPath, "utf8"),
    readFile(pagePath, "utf8"),
    readFile(runtimeRepairPromptPath, "utf8"),
  ]);

  assert.match(css, /understudy-agent@3f025022/);
  assert.match(css, /--mb-cyan:\s*#67e8f9/);
  assert.match(css, /--mb-mint:\s*#9edbd3/);
  assert.match(
    css,
    /::selection\s*\{[\s\S]*?background:\s*color-mix\(in srgb, var\(--mb-cyan\) 68%, transparent\);/,
  );
  assert.match(css, /\.composer-row\s*\{[\s\S]*?width:\s*100%;/);
  assert.match(
    css,
    /\.composer-row \.composer-row-body\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex:\s*1 1 0;/,
  );
  assert.match(css, /\.ai-chat-composer \.composer-submit\s*\{/);
  assert.match(
    css,
    /\.ai-chat-composer \.composer-submit\s*\{[\s\S]*?margin-left:\s*auto;/,
  );
  assert.match(css, /\.persona-halo\.supervised/);
  assert.match(chat, /className="composer-row"/);
  assert.match(chat, /<PromptInputBody className="composer-row-body">/);
  assert.match(chat, /className="composer-submit"/);
  assert.match(chat, /if \(!isTauri\(\)\) return;/);
  assert.match(statusHook, /if \(!isTauri\(\)\) return;/);
  assert.match(page, /if \(!isTauri\(\)\) return;/);
  assert.match(runtimeRepairPrompt, /const unlisten = isTauri\(\)/);
  assert.doesNotMatch(chat, /<ThinkingToggle/);
  assert.match(chat, /className="model-picker-controls"/);
  assert.match(aliases, /"gemma-4-e4b-it-qat-mlx-vlm-understudy": "understudy-balanced"/);
  assert.match(aliases, /"gemma-4-12b-it-qat-mlx-vlm-understudy": "understudy-quality"/);
  assert.match(
    chat,
    /Tried to hand off to a larger cloud model, but it is unavailable\. Continuing with the local model\./,
  );
  assert.match(chat, /msg\.stage === "cloud_fallback_local"/);

  assert.match(sidebar, /<div className="nav-section">\{showArchived \? "Archived" : "Chats"\}<\/div>/);
  assert.match(sidebar, /aria-label=\{showArchived \? "Archived chats" : "Recent chats"\}/);
  assert.match(sidebar, /visibleSessions\.map\(\(session\) =>/);
  assert.match(sidebar, /onSelectSession\(session\.session_id\)/);
  assert.match(sidebar, /onSelect\("account"\)/);
  assert.doesNotMatch(sidebar, /SERVING_NAV/);
  assert.doesNotMatch(sidebar, /label: "Status"/);
  assert.doesNotMatch(sidebar, /label: "Models"/);
  assert.doesNotMatch(sidebar, /label: "Experiments"/);
  assert.doesNotMatch(page, /titlebar-chat-history/);
});

test("reading pace is quiet, optional, and safe across teacher replacement", async () => {
  const [chat, css, pacer] = await Promise.all([
    readFile(chatPath, "utf8"),
    readFile(cssPath, "utf8"),
    readFile(streamPacerPath, "utf8"),
  ]);

  assert.match(chat, /turnPacer\?\.replace\(msg\.text\)/);
  assert.match(chat, /Show full answer/);
  assert.match(chat, /pacedBacklog > SKIP_HINT_THRESHOLD/);
  assert.match(chat, /turnPacer\?\.skip\(\)/);
  assert.match(css, /\.paced-answer-skip/);
  assert.match(pacer, /understudy\.pacing/);
  assert.match(pacer, /prefers-reduced-motion: reduce/);
  assert.match(pacer, /rejected student text can never survive in the hidden buffer/);
});

test("chat streaming batches paint work and only animates compositor-safe properties", async () => {
  const [chat, css, batcher, messageScroller, scrollControls] = await Promise.all([
    readFile(chatPath, "utf8"),
    readFile(cssPath, "utf8"),
    readFile(streamBatcherPath, "utf8"),
    readFile(messageScrollerPath, "utf8"),
    readFile(chatScrollControlsPath, "utf8"),
  ]);

  assert.match(chat, /new ChatStreamBatcher\(applyAssistantPatch/);
  assert.match(chat, /streamBatcher\.current\?\.flush\(\)/);
  assert.match(chat, /requestAnimationFrame\(\(\) =>/);
  assert.match(scrollControls, /const \{ scrollToMessage \} = useMessageScroller\(\)/);
  assert.match(scrollControls, /useMessageScrollerVisibility/);
  assert.match(scrollControls, /scrollToMessage\(anchor\.id,/);
  assert.match(scrollControls, /maximumTicks = 12/);
  assert.match(scrollControls, /sameTurnAnchors\(previous\.anchors, next\.anchors\)/);
  assert.match(chat, /defaultScrollPosition="last-anchor"/);
  assert.match(chat, /messageId=\{messageId\}/);
  assert.match(chat, /className=\{messageId === animatedMessageId \? "chat-message-enter" : undefined\}/);
  assert.match(messageScroller, /\[content-visibility:auto\]/);
  assert.match(messageScroller, /\[contain-intrinsic-size:auto_10rem\]/);
  assert.match(batcher, /this\.#scheduled = this\.#schedule\(\(\) =>/);
  assert.match(css, /@keyframes chat-message-enter\s*\{[\s\S]*?opacity:[\s\S]*?transform:/);
  assert.match(css, /\.chat-scroll-outline-tick/);
  const animationRule = css.match(/@keyframes chat-message-enter\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.doesNotMatch(animationRule, /height|margin|padding/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*?\.chat-message-enter/);
});

test("chat archive is reversible, excludes active history, and never deletes rows", async () => {
  const [page, sidebar, commands, db, native] = await Promise.all([
    readFile(pagePath, "utf8"),
    readFile(sidebarPath, "utf8"),
    readFile(desktopCommandsPath, "utf8"),
    readFile(desktopDbPath, "utf8"),
    readFile(tauriLibPath, "utf8"),
  ]);

  assert.match(page, /"chat_session_archive"/);
  assert.match(page, /"chat_session_restore"/);
  assert.match(page, /"chat_sessions_archive_all"/);
  assert.match(page, /Stop the current response before archiving/);
  assert.match(sidebar, /Archive all chats/);
  assert.match(sidebar, /remain on this Mac\. You can restore them anytime/);
  assert.match(sidebar, /aria-label=\{showArchived \? "Archived chats" : "Recent chats"\}/);
  assert.match(commands, /pub fn chat_session_archive/);
  assert.match(commands, /pub fn chat_session_restore/);
  assert.match(commands, /pub fn chat_sessions_archive_all/);
  assert.match(db, /archived_at TEXT/);
  assert.match(db, /archived_at IS NULL/);
  assert.match(db, /SET archived_at=NULL/);
  assert.doesNotMatch(db, /DELETE FROM chat_sessions/);
  assert.match(native, /commands::chat_session_archive/);
  assert.match(native, /commands::chat_session_restore/);
  assert.match(native, /commands::chat_sessions_archive_all/);
});

test("cold-start cloud fallback yields to local without overriding a human choice", async () => {
  const [chat, selection] = await Promise.all([
    readFile(chatPath, "utf8"),
    readFile(modelSelectionPath, "utf8"),
  ]);

  assert.match(chat, /selectedModelUserOwned/);
  assert.match(chat, /resolveChatModelSelection/);
  assert.match(chat, /selectedModelUserOwned\.current = true/);
  assert.match(selection, /if \(userSelected && currentExists\)/);
  assert.match(selection, /preferredLocalId/);
});

test("desktop omits the always-on-top pin and its capability", async () => {
  const [page, css, permissions] = await Promise.all([
    readFile(new URL("../apps/homescreen/app/page.tsx", import.meta.url), "utf8"),
    readFile(cssPath, "utf8"),
    readFile(
      new URL("../apps/homescreen/src-tauri/capabilities/default.json", import.meta.url),
      "utf8",
    ),
  ]);

  assert.doesNotMatch(page, /understudy\.alwaysOnTop/);
  assert.doesNotMatch(page, /setAlwaysOnTop/);
  assert.doesNotMatch(page, /PinIcon|PinOffIcon|titlebar-pin/);
  assert.doesNotMatch(css, /\.titlebar-pin/);
  assert.doesNotMatch(permissions, /core:window:allow-set-always-on-top/);
});

test("desktop stays dark and keeps the animated persona white by default", async () => {
  const [layout, css, design, persona, tauriConfig] = await Promise.all([
    readFile(layoutPath, "utf8"),
    readFile(cssPath, "utf8"),
    readFile(designPath, "utf8"),
    readFile(personaPath, "utf8"),
    readFile(tauriConfigPath, "utf8"),
  ]);

  assert.match(layout, /className=\{`\$\{plexMono\.variable\} dark`\}/);
  assert.match(layout, /data-theme="dark"/);
  assert.doesNotMatch(layout, /ThemeProvider|understudy-theme|data-sys|prefers-color-scheme/);
  assert.match(css, /@custom-variant dark/);
  assert.match(css, /color-scheme:\s*dark/);
  assert.doesNotMatch(css, /data-theme="light"|data-theme="system"|color-scheme:\s*light/);
  assert.doesNotMatch(design, /useTheme|setTheme|theme toggle|>light<|>system</);
  assert.match(persona, /color = \{ red: 255, green: 255, blue: 255 \}/);
  assert.match(persona, /viewModelInstanceColor\.setRgb\(color\.red, color\.green, color\.blue\)/);
  assert.doesNotMatch(persona, /getCurrentTheme|MutationObserver|prefers-color-scheme/);
  assert.equal(JSON.parse(tauriConfig).app.windows[0].theme, "Dark");
  await assert.rejects(readFile(themePath, "utf8"), { code: "ENOENT" });
});

test("desktop offers an explicit signed update check from macOS menus", async () => {
  const [native, prompt] = await Promise.all([
    readFile(tauriLibPath, "utf8"),
    readFile(runtimeRepairPromptPath, "utf8"),
  ]);

  assert.match(native, /SubmenuBuilder::new\(app, "Understudy"\)/);
  assert.match(native, /"Check for Updates…"/);
  assert.match(native, /CHECK_FOR_UPDATES_TRAY_ID/);
  assert.match(native, /app\.emit\(CHECK_FOR_UPDATES_EVENT/);
  assert.match(prompt, /listen\("check-for-updates"/);
  assert.match(prompt, /Understudy is up to date/);
  assert.match(prompt, /const HEALTH_REFRESH_MS = 15 \* 60 \* 1_000/);
});

test("desktop has one shared managed-operation notice surface", async () => {
  const [page, prompt, operationNotice, downloadNotice, accountPane, chat, repair, bootstrap, account, native] = await Promise.all([
    readFile(pagePath, "utf8"),
    readFile(runtimeRepairPromptPath, "utf8"),
    readFile(operationNoticePath, "utf8"),
    readFile(modelDownloadNoticePath, "utf8"),
    readFile(accountPanePath, "utf8"),
    readFile(chatPath, "utf8"),
    readFile(runtimeRepairLibPath, "utf8"),
    readFile(
      new URL("../apps/homescreen/src-tauri/src/bootstrap.rs", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../apps/homescreen/src-tauri/src/account.rs", import.meta.url),
      "utf8",
    ),
    readFile(tauriLibPath, "utf8"),
  ]);

  assert.match(page, /<RuntimeRepairPrompt quiet=\{chatTrainingActive\}\s*\/>/);
  assert.match(prompt, /if \(quiet \|\| !prompt\) return null/);
  assert.match(page, /<ModelDownloadNotice[\s\S]*?quiet=\{chatTrainingActive\}[\s\S]*?onOpenAccount=\{openFirstRunSignIn\}[\s\S]*?\/>/);
  assert.match(downloadNotice, /if \(quiet\) return null/);
  assert.match(downloadNotice, /quiet \|\| !shouldAutoPrepare/);
  assert.match(page, /className="operation-notice-stack"/);
  assert.match(prompt, /<OperationNotice/);
  assert.match(downloadNotice, /<OperationNotice/);
  assert.match(operationNotice, /aria-busy=\{state === "running"\}/);
  assert.match(prompt, /invoke<DesktopHealth>\("desktop_health"\)/);
  assert.match(prompt, /listen<RuntimeRepairRequest>\("runtime-repair-needed"/);
  assert.match(prompt, /"install_understudy_agent_tools"/);
  assert.match(prompt, /"install_mlx_runtime"/);
  assert.match(prompt, /"conversation_runtime_repair"/);
  assert.match(prompt, /check\(\{ timeout: 10_000 \}\)/);
  assert.match(prompt, /update\.downloadAndInstall/);
  assert.match(prompt, /invoke\("restart_app"\)/);
  assert.match(prompt, /percent.*downloaded/s);
  assert.match(prompt, /listen<NativeRepairProgress>\("runtime-repair-progress"/);
  assert.match(prompt, /listen\("conversation-runtime-ready"/);
  assert.match(prompt, /setTimeout\(\(\) => void refreshHealth\(\), 2_500\)/);
  assert.match(prompt, /Updating the version-coupled conversation runtime/);
  assert.match(prompt, /Verifying the CLI and local runtimes/);
  assert.match(prompt, /promptForRepairFailure\(activePrompt, error\)/);
  assert.doesNotMatch(prompt, /Run \$\{activePrompt\.command\} in Terminal/);
  assert.match(prompt, /elapsedSeconds/);
  assert.match(prompt, /busy \|\| progress\.status === "success"/);
  assert.match(prompt, /actionDisabled=\{busy \|\| progress\.status === "success"\}/);
  assert.match(downloadNotice, /"list_snapshot_downloads"/);
  assert.match(downloadNotice, /invoke<SnapshotModel\[\]>\("list_snapshot_models"\)/);
  assert.doesNotMatch(downloadNotice, /bootstrap_status|BootstrapStatus/);
  assert.match(downloadNotice, /"cancel_snapshot_download"/);
  assert.match(downloadNotice, /"start_snapshot_download"/);
  assert.match(downloadNotice, /"prepare_default_local_model"/);
  assert.match(downloadNotice, /Start with a local model/);
  assert.match(downloadNotice, /One-time download · stays on this Mac/);
  assert.match(downloadNotice, /Starting local model/);
  assert.match(downloadNotice, /Selected for chat/);
  assert.match(downloadNotice, /title="Set up Understudy"/);
  assert.match(downloadNotice, /Sign in for GLM 5\.2 now and prepare private local chat/);
  assert.match(downloadNotice, /secondaryActionLabel=\{starter \? \(actionBusy \? "Starting…" : "Local only"\) : null\}/);
  assert.match(downloadNotice, /starterDownloadRequest/);
  assert.match(operationNotice, /secondaryActionLabel/);
  assert.match(page, /downloadAfterSignIn/);
  assert.match(page, /setStarterDownloadRequest\(\(request\) => request \+ 1\)/);
  assert.match(accountPane, /onSignedIn\?\.\(\)/);
  assert.match(accountPane, /prioritizeSignIn \? signInCard : null/);
  assert.match(accountPane, /Use GLM 5\.2 immediately while Understudy prepares private local chat/);
  assert.match(page, /prioritizeSignIn=\{Boolean\(signInIntent\)\}/);
  assert.match(chat, /gatewaySignedIn \?\? Boolean\(/);
  assert.match(chat, /invoke<\{ signed_in\?: boolean \}>\("account_status"\)/);
  assert.doesNotMatch(
    account,
    /run_json\(&\["status",\s*"--json"\]\)/,
    "the frequently-polled account status path must not cold-start the bundled CLI",
  );
  assert.match(chat, /if \(!signedIn\)/);
  assert.match(chat, /onNeedsSignIn\?\.\(\)/);
  const sendStart = chat.indexOf("const send = async");
  const localLoadingGuard = chat.indexOf('if (choice.route === "local" && !choice.active)', sendStart);
  const draftClear = chat.indexOf('setInput("");', sendStart);
  assert.ok(localLoadingGuard > sendStart && draftClear > localLoadingGuard);
  assert.match(native, /commands::prepare_default_local_model/);
  assert.match(repair, /understudy models runtime repair/);
  assert.match(repair, /understudy runtime repair/);
  assert.match(repair, /reconnecting automatically/);
  assert.match(repair, /if \(reconnecting\) return null/);
  assert.match(prompt, /automaticRuntimeRepairAttempted/);
  assert.match(prompt, /conversation_runtime_repair/);
  assert.match(repair, /Reinstall Understudy Desktop/);
  assert.match(repair, /Install update/);
  assert.match(repair, /Automatic update stopped/);
  assert.match(repair, /The CLI is included with Understudy Desktop/);
  assert.match(repair, /Signed Tauri update/);
  assert.match(
    repair,
    /github\.com\/understudylabs\/understudy-agent-tools\/releases\/latest/,
  );
  assert.doesNotMatch(repair, /install\.sh|npm install/);
  assert.doesNotMatch(repair, /understudy update/);
  assert.match(bootstrap, /if !bundled_cli && cli_health\.available && !mlx_status\.managed/);
});

test("desktop first paint avoids heavyweight synchronous startup probes", async () => {
  const [downloadNotice, commands, metrics, native, repairPrompt] = await Promise.all([
    readFile(modelDownloadNoticePath, "utf8"),
    readFile(desktopCommandsPath, "utf8"),
    readFile(desktopMetricsPath, "utf8"),
    readFile(tauriLibPath, "utf8"),
    readFile(runtimeRepairPromptPath, "utf8"),
  ]);

  assert.doesNotMatch(downloadNotice, /bootstrap_status|BootstrapStatus/);
  assert.match(commands, /pub async fn get_status/);
  assert.match(commands, /spawn_blocking\(move \|\| status_snapshot\(&app\)\)/);
  assert.match(commands, /pub async fn bootstrap_status/);
  assert.match(commands, /spawn_blocking\(crate::bootstrap::status\)/);
  assert.match(metrics, /System::new_with_specifics/);
  assert.doesNotMatch(metrics, /System::new_all/);
  assert.match(native, /sleep\(Duration::from_millis\(500\)\)/);
  assert.match(native, /spawn_blocking\(move \|\|/);
  assert.match(native, /understudy startup: setup-ready=/);
  assert.match(repairPrompt, /initialHealthTimer = window\.setTimeout\(\(\) => void refreshHealth\(\), 900\)/);
});

test("desktop persists image references and retains them with chat history", async () => {
  const [chat, attachmentLib, attachmentRust] = await Promise.all([
    readFile(chatPath, "utf8"),
    readFile(attachmentLibPath, "utf8"),
    readFile(attachmentRustPath, "utf8"),
  ]);

  assert.match(chat, /"chat_attachments_store"/);
  assert.match(chat, /"chat_attachments_hydrate"/);
  assert.doesNotMatch(chat, /"chat_attachments_delete_session"/);
  assert.match(chat, /persistableChatMessages\(messages\)/);
  assert.match(attachmentLib, /previewUrl: _previewUrl/);
  assert.match(
    attachmentLib,
    /return previewUrl \? \{ \.\.\.attachment, previewUrl \} : attachment;/,
  );
  assert.match(attachmentRust, /join\("chat-attachments"\)/);
  assert.match(attachmentRust, /content_id\(&bytes\)/);
  assert.match(attachmentRust, /from_mode\(0o700\)/);
  assert.match(attachmentRust, /options\.mode\(0o600\)/);
  assert.match(attachmentRust, /migrate_legacy_messages/);
});

test("desktop starts fresh on launch and can reopen an exact Pi session", async () => {
  const [chat, page, sidebar, commands] = await Promise.all([
    readFile(chatPath, "utf8"),
    readFile(pagePath, "utf8"),
    readFile(sidebarPath, "utf8"),
    readFile(new URL("../apps/homescreen/src-tauri/src/commands.rs", import.meta.url), "utf8"),
  ]);

  assert.match(page, /const \[activeChatSessionId, setActiveChatSessionId\] = useState<string \| null>\(null\)/);
  assert.match(chat, /const restore = activeSessionId !== null/);
  assert.doesNotMatch(chat, /invoke<PersistedChatSession \| null>\("chat_session_latest"\)/);
  assert.match(page, /"chat_sessions_list"/);
  assert.match(chat, /"chat_session_get"/);
  assert.match(chat, /onSessionChange\?\.\(sessionId\)/);
  assert.match(page, /activeSessionId=\{activeChatSessionId\}/);
  assert.match(page, /setActiveChatSessionId\(null\);[\s\S]*?setChatResetToken/);
  assert.match(
    chat,
    /const restoreHistorySession = async[\s\S]*?finally \{[\s\S]*?setSessionHydrated\(true\);/,
  );
  assert.match(
    chat,
    /const resetDroppedWorkload = \(\) => \{[\s\S]*dropRequestGeneration\.current \+= 1;[\s\S]*dropInFlight\.current = false;[\s\S]*dispatchDrop\(\{ type: "reset" \}\);/,
  );
  assert.equal(chat.match(/resetDroppedWorkload\(\);/g)?.length, 2);
  assert.match(sidebar, /aria-label=\{showArchived \? "Archived chats" : "Recent chats"\}/);
  assert.doesNotMatch(sidebar, /No saved chats yet/);
  assert.doesNotMatch(page, /aria-label="Chat history"/);
  assert.match(commands, /pub fn chat_sessions_list/);
  assert.match(commands, /pub fn chat_session_get/);
});

test("desktop compiles one dropped path through the bounded public CLI", async () => {
  const [chat, css, persona, dropState, training, trainingHalo, trainingPlan, trainingState, bridge, compiler, parity] = await Promise.all([
    readFile(chatPath, "utf8"),
    readFile(cssPath, "utf8"),
    readFile(personaPath, "utf8"),
    readFile(workloadDropStatePath, "utf8"),
    readFile(localTrainingPath, "utf8"),
    readFile(trainingHaloPath, "utf8"),
    readFile(csvTrainingPlanPath, "utf8"),
    readFile(localTrainingStatePath, "utf8"),
    readFile(workloadDropRustPath, "utf8"),
    readFile(captureImportPath, "utf8"),
    readFile(parityPath, "utf8").then(JSON.parse),
  ]);

  assert.match(chat, /getCurrentWebview\(\)\s*\.onDragDropEvent/);
  assert.match(chat, /"compile_dropped_workload"/);
  assert.match(chat, /dropRequestGeneration\.current !== requestGeneration/);
  assert.match(chat, /dropRequestGeneration\.current \+= 1/);
  assert.match(chat, /Drop one file or folder/);
  assert.match(chat, /new Channel<WorkloadDropEvent>/);
  assert.match(chat, /onEvent: channel/);
  assert.match(chat, /workloadDropPersonaState\(dropPhase\)/);
  assert.match(chat, /droppedWorkload && !classificationDataset[\s\S]*\? "listening"/);
  assert.match(chat, /invoke<CsvInspection>\("inspect_dropped_csv"/);
  assert.match(chat, /const inspectTable = shouldInspectDroppedTable\(result\)/);
  assert.match(chat, /dispatchDrop\(\{ type: "inspection_started" \}\);[\s\S]*await inspectCsvWorkload/);
  assert.match(dropState, /export function shouldInspectDroppedTable/);
  assert.match(dropState, /\\\.\(\?:csv\|tsv\|tab\)/);
  assert.match(chat, /<CsvProfile/);
  assert.match(chat, /rowCount=\{csvInspection\.row_count\}/);
  assert.match(chat, /prepare_dropped_csv_classification/);
  assert.match(chat, /1 · data structure/);
  assert.match(chat, /2 · confirm the training plan/);
  assert.match(chat, /Train for \$\{mappingLabelColumn\}/);
  assert.match(chat, /<CsvTrainingPlan/);
  assert.match(trainingPlan, /Understand/);
  assert.match(trainingPlan, /Local ModernBERT/);
  assert.match(trainingPlan, /Works across every category/);
  assert.match(trainingPlan, /Compare with a simple baseline on separate test examples/);
  assert.match(chat, /groupColumn: mappingGroupColumn/);
  assert.match(chat, /Choose a reference column/);
  assert.match(chat, /mappingLabelColumn && !mappingGroupColumn/);
  assert.doesNotMatch(chat, /Adjust mapping/);
  assert.doesNotMatch(chat, /Select a column above/);
  assert.doesNotMatch(chat, /3 · train the model/);
  assert.match(chat, /datasetManifestPath=\{classificationDataset\.manifest_path\}[\s\S]*?autoStart/);
  assert.match(chat, /onVisualChange=\{setTrainingHaloVisual\}/);
  assert.match(training, /if \(autoStart\) return null/);
  assert.match(chat, /key=\{`\$\{sessionId\}:\$\{classificationDataset \? "training"/);
  assert.match(chat, /classificationDataset \|\| localTrainingActive \? " is-training-flow"/);
  assert.match(chat, /!classificationDataset \? \(/);
  assert.match(chat, /onSelectColumn=\{/);
  assert.doesNotMatch(chat, /Prepare training split/);
  assert.doesNotMatch(chat, /No normalized \{classificationDataset\.split_policy\.group_key\}/);
  assert.doesNotMatch(chat, /Inspect CSV locally/);
  assert.doesNotMatch(chat, /useState\(false\);[\s\S]{0,120}setDropHovering/);
  assert.doesNotMatch(chat, /workload-drop-overlay/);
  assert.match(dropState, /"hovering"[\s\S]*return "listening"/);
  assert.match(dropState, /BUSY_PHASES\.has\(phase\)[\s\S]*return "thinking"/);
  assert.match(dropState, /One file or folder · stays on this Mac/);
  assert.match(dropState, /Indexing metadata locally · contents remain unread/);
  assert.match(dropState, /Reading this table locally · source rows will not be copied/);
  assert.match(dropState, /Writing deterministic train, dev, and holdout examples on this Mac/);
  assert.match(css, /\.persona-stage\.workload-drop-active::before/);
  assert.match(css, /@keyframes workload-intake-ring/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*?\.persona-stage\.workload-drop-active::before/);
  assert.match(chat, /<TrainingHalo/);
  assert.match(trainingHalo, /modelIdentityTint\(visual\.modelId\)/);
  assert.match(training, /modelId: `classifier\.\$\{state\.runId\}`/);
  assert.match(trainingHalo, /const AMBER/);
  assert.match(trainingHalo, /const VIOLET/);
  assert.match(trainingHalo, /const GREEN/);
  assert.match(trainingHalo, /stepFraction: number \| null/);
  assert.match(trainingHalo, /className="training-halo-active is-indeterminate"/);
  assert.match(trainingHalo, /window\.setTimeout[\s\S]*?1_400/);
  assert.match(trainingHalo, /distilled from ModernBERT · yours/);
  assert.match(css, /\.ai-chat\.has-workload \.persona-stage/);
  assert.match(css, /\.csv-profile-columns/);
  assert.match(css, /\.csv-profile-columns\.is-spacious/);
  assert.match(css, /--profile-column-count/);
  assert.match(css, /\.csv-training-plan/);
  assert.match(chat, /const trainingPlanVisible = Boolean/);
  assert.match(chat, /trainingPlanVisible \? \(/);
  assert.match(chat, /className="ai-chat-composer training-plan-action"/);
  assert.match(chat, /className="btn primary training-plan-submit"/);
  assert.doesNotMatch(chat, /className="csv-analysis-proposal"[\s\S]{0,300}<button/);
  assert.match(css, /@keyframes csv-profile-enter/);
  assert.match(persona, /viewModelInstanceColor\.setRgb\(color\.red, color\.green, color\.blue\)/);
  assert.doesNotMatch(chat, /Review next steps|workloadReviewPrompt/);
  assert.match(chat, /className="btn ghost workload-generic-dismiss"/);
  assert.doesNotMatch(chat, /\/analyze-drop|\/drop-act/);
  assert.match(bridge, /CLI owns discovery, privacy boundaries, scan limits/);
  assert.match(bridge, /WorkloadDropEvent::Validating/);
  assert.match(bridge, /WorkloadDropEvent::Compiling/);
  assert.match(bridge, /"capture-import", "compile", "--source"/);
  assert.match(bridge, /"capture-import", "inspect-csv", "--source"/);
  assert.match(bridge, /"capture-import", "prepare-classification", "--source"/);
  assert.match(bridge, /"--group-column"/);
  assert.match(bridge, /"capture-import", "train-classification", "--manifest"/);
  assert.match(bridge, /"capture-import", "predict-classification", "--run-manifest"/);
  assert.match(bridge, /understudy\.capture_import\.classification_run\.v1/);
  assert.match(bridge, /verified_no_group_overlap/);
  assert.match(bridge, /source_rows_persisted/);
  assert.match(bridge, /statistics-and-label-aggregates/);
  assert.match(bridge, /value\.get\("local_only"\)/);
  assert.match(bridge, /value\.get\("payload_read"\)/);
  assert.match(compiler, /const MAX_SCAN_FILES = 5_000/);
  assert.match(compiler, /const MAX_CAPTURE_SOURCES = 1_000/);
  assert.match(compiler, /const MAX_CSV_BYTES = 16 \* 1024 \* 1024/);
  assert.match(compiler, /payload_read: false/);
  assert.match(compiler, /source_rows_persisted: false/);
  assert.match(compiler, /source_sha256/);
  assert.match(compiler, /deterministic-stratified-group-aware-v2/);
  assert.match(compiler, /holdout_reserved_for_final_validation: true/);
  assert.match(compiler, /source_rows_persisted_as_transformed_examples: true/);
  assert.match(training, /Train a local model/);
  assert.match(training, /start_local_classification_training/);
  assert.match(training, /cancel_local_classification_training/);
  assert.match(training, /local_classification_training_examples/);
  assert.match(training, /Verified training split · stays on this Mac/);
  assert.match(training, /Verified training example · split row \{example\.row_number\.toLocaleString\(\)\}/);
  assert.match(training, /Pace <b>\{compactDuration\(timing\.paceMs\)\} \/ epoch<\/b>/);
  assert.match(training, /Training done <b>about \{completionClock\(timing\.completionAt\)\}<\/b>/);
  assert.match(bridge, /The training split changed after preparation/);
  assert.match(bridge, /TRAINING_PREVIEW_MAX_BYTES/);
  assert.match(css, /\.local-training-example-stream/);
  assert.match(css, /@keyframes local-training-example-enter/);
  assert.match(css, /@keyframes local-training-example-leave/);
  assert.match(css, /local-training-example-enter 620ms cubic-bezier[\s\S]*?500ms both/);
  assert.match(css, /local-training-example-leave 420ms cubic-bezier/);
  assert.match(css, /@keyframes training-halo-mote/);
  assert.match(css, /@keyframes training-halo-bloom/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*?\.local-training-example-stream/);
  assert.match(training, /cancellationRequested\.current \|\| message\.toLowerCase\(\)\.includes\("cancel"\)/);
  assert.match(training, /predict_local_classification/);
  assert.match(training, /compare_local_classification_with_frontier/);
  assert.match(training, /Compare with GLM 5\.2 on the same/);
  assert.match(training, /Only held-out test examples are sent through Understudy/);
  assert.match(training, /confirmSpend: true/);
  assert.match(training, /budgetUsd: 1/);
  assert.match(training, /active inference vendor remains behind Understudy's authenticated service boundary/);
  assert.doesNotMatch(training, /Fireworks/);
  assert.match(training, /Maximum approved spend: \$1\.00/);
  assert.match(training, /<EvaluationRadar/);
  assert.match(training, /frontierComparison\.heldout\.weakest_classes\[0\] && state\.result\.heldout\.weakest_classes\[0\]/);
  assert.match(training, /baselineAccuracy=\{state\.result\.linear_baseline\.accuracy\}/);
  assert.match(training, /state\.result\.heldout\.macro_f1/);
  assert.match(training, /state\.result\.heldout\.latency_ms_p50/);
  assert.match(training, /state\.result\.model\.size_bytes/);
  assert.match(training, /Notable failures/);
  assert.match(training, /Hardest categories/);
  assert.match(training, /Try a new example/);
  assert.match(training, /window\.setInterval/);
  assert.doesNotMatch(training, /Math\.random/);
  assert.match(trainingState, /const RUNNER_PHASES/);
  assert.match(trainingState, /return \[epoch, measured\]/);
  assert.match(trainingState, /Improved, not ready/);
  assert.match(trainingState, /This dataset is too easy to show model value/);
  assert.match(trainingState, /Low confidence—review this prediction/);
  assert.doesNotMatch(trainingState, /percentage|percent/);
  assert.match(bridge, /compare-classification-frontier/);
  assert.match(bridge, /"--confirm-remote"/);
  assert.match(bridge, /"--confirm-spend"/);
  assert.match(bridge, /"--budget-usd"/);
  assert.match(bridge, /approved_budget_usd/);
  assert.match(bridge, /attributed_cost_usd/);
  assert.match(bridge, /exact_same_holdout/);
  const radar = await readFile(evaluationRadarPath, "utf8");
  assert.match(radar, /Same held-out examples/);
  assert.match(radar, /Local model versus/);
  assert.match(radar, /Correct answers/);
  assert.match(radar, /Across categories/);
  assert.match(radar, /Hardest category/);
  assert.match(radar, /Fast response/);
  assert.match(radar, /Your local model/);
  assert.match(radar, /Cloud required/);
  assert.match(radar, /this comparison/);
  assert.match(radar, /same examples/);
  assert.match(radar, /aria-label="Local and frontier comparison dimensions"/);
  assert.doesNotMatch(radar, />F1<|"F1"/);
  assert.equal(
    parity.features.find((feature) => feature.id === "drop-to-workload-compilation")?.status,
    "shipped",
  );
});

test("trained-model library is restart-safe and stays separate from chat models", async () => {
  const [chat, library, css, tauri] = await Promise.all([
    readFile(chatPath, "utf8"),
    readFile(classifierLibraryPath, "utf8"),
    readFile(cssPath, "utf8"),
    readFile(tauriLibPath, "utf8"),
  ]);

  assert.match(chat, /PromptInputActionMenuItem[\s\S]*?Trained models/);
  assert.match(library, /"list_local_classification_runs"/);
  assert.match(library, /"update_local_classification_run"/);
  assert.match(library, /"predict_local_classification"/);
  assert.match(library, /revealItemInDir/);
  assert.match(library, /They never appear in the chat-model picker/);
  assert.match(library, /Correct answers/);
  assert.match(library, /Separate test examples/);
  assert.match(library, /Archived/);
  assert.match(library, /source rows will not be copied|Local task models saved on this Mac/);
  assert.doesNotMatch(library, /training examples|raw rows|source payload/i);
  assert.match(css, /\.classifier-library-dialog/);
  assert.match(tauri, /workload_drop::list_local_classification_runs/);
  assert.match(tauri, /workload_drop::update_local_classification_run/);
});

test("desktop model downloads are app-owned, pausable, and resumable", async () => {
  const [statusPane, downloadNotice] = await Promise.all([
    readFile(statusPanePath, "utf8"),
    readFile(modelDownloadNoticePath, "utf8"),
  ]);

  assert.match(statusPane, /"start_snapshot_download"/);
  assert.match(statusPane, /"list_snapshot_downloads"/);
  assert.match(statusPane, /"cancel_snapshot_download"/);
  assert.match(statusPane, /Resume keeps partial files/);
  assert.match(statusPane, /busyActionLabel="Pause"/);
  assert.match(downloadNotice, /title = "Downloading model"/);
  assert.match(downloadNotice, /actionLabel = "Pause"/);
  assert.match(downloadNotice, /row\.resumable \? "Resume" : null/);
  assert.doesNotMatch(statusPane, /new Channel<DownloadEvent>/);
  assert.doesNotMatch(statusPane, /invoke\([^\n]*"download_snapshot_model"/);
  assert.doesNotMatch(statusPane, /sidekick\.parallel|Parallel sidekick|setupSidekick/);
});

test("large local models warn before consuming the residency budget", async () => {
  const { modelMemoryWarning } = await import(modelMemoryPath);
  const residencyPanel = await readFile(
    new URL("../apps/homescreen/app/components/ResidencyPanel.tsx", import.meta.url),
    "utf8",
  );
  const modelsPane = await readFile(modelsPanePath, "utf8");

  assert.equal(modelMemoryWarning("understudy-small", 3.6, 2), null);
  assert.equal(modelMemoryWarning("understudy-4b", 4.2, 8), null);
  assert.match(modelMemoryWarning("understudy-26b", 15.8, 8), /exceeds the 8\.0 GB/);
  assert.match(modelMemoryWarning("understudy-12b", 7.5, 40), /safer default/);
  assert.match(residencyPanel, /Prepare this model anyway\?/);
  assert.match(residencyPanel, /window\.confirm/);
  assert.match(modelsPane, /snapshotMemoryWarning/);
});

test("chat exposes compact, truthful model cards from the canonical local catalog", async () => {
  const [chat, drawer, cardLib, modelCards, parity] = await Promise.all([
    readFile(chatPath, "utf8"),
    readFile(modelCardDrawerPath, "utf8"),
    readFile(modelCardLibPath, "utf8"),
    readFile(modelCardsPath, "utf8").then(JSON.parse),
    readFile(parityPath, "utf8").then(JSON.parse),
  ]);

  assert.match(chat, /<ModelCardDrawer/);
  assert.match(chat, /modelId: slot\.model_id!/);
  assert.match(chat, /selectedChoice\.modelId/);
  assert.match(drawer, /What this is/);
  assert.match(drawer, /How it runs/);
  assert.match(drawer, /What we verified/);
  assert.match(drawer, /When to use it/);
  assert.match(drawer, /No frozen experiment is linked to this chat/);
  assert.doesNotMatch(drawer, /system_prompt/);
  assert.match(drawer, /isDetailedModelCard\(card\)/);
  assert.doesNotMatch(drawer, /decode_contract!|certification!|footprint!|routing_hints!/);
  assert.match(cardLib, /rawModelCards/);
  assert.match(cardLib, /while \(card\?\.alias_for/);
  assert.match(cardLib, /replaceAll\("-4-bit", "-4bit"\)/);
  assert.match(cardLib, /card\?\.provenance &&[\s\S]*?card\.routing_hints/);

  const ids = [
    "gemma-4-e2b-it-qat-mlx-vlm-understudy",
    "gemma-4-e4b-it-qat-mlx-vlm-understudy",
    "gemma-4-12b-it-qat-mlx-vlm-understudy",
    "gemma-4-26b-a4b-it-qat-mlx-vlm-understudy",
  ];
  for (const id of ids) {
    const card = modelCards.find((candidate) => candidate.id === id);
    assert.ok(card, `missing public model card for ${id}`);
    assert.equal(card.card_schema, "understudy.model_card.v2");
    assert.match(card.provenance.source_checkpoint, /qat-q4_0-unquantized$/);
    assert.match(card.provenance.understudy_training, /^None\./);
    assert.equal(card.decode_contract.temperature, 1);
    assert.equal(card.decode_contract.top_p, 0.95);
    assert.equal(card.decode_contract.top_k, 64);
    assert.deepEqual(card.decode_contract.required_server_flags, ["--top-logprobs-k", "20"]);
    assert.match(card.certification.scope, /not broad task-quality certification/);
    assert.doesNotMatch(card.system_prompt, /Your post-training was|quantized and post-trained/i);
  }
  assert.equal(
    modelCards.find((card) => card.id === ids[3]).provenance.conversion,
    "MLX 4-bit group-32 experts with 8-bit routers",
  );
  assert.equal(
    parity.features.find((feature) => feature.id === "model-card-transparency")?.status,
    "shipped",
  );
  assert.equal(
    parity.features.find((feature) => feature.id === "reading-pace-streaming")?.status,
    "shipped",
  );
});

test("Experiments is one guided review, strict compare, improve loop", async () => {
  const [review, compare, comparisonRules, reviewRust, proofRust, proofCli, rlmPane, css] = await Promise.all([
    readFile(reviewViewPath, "utf8"),
    readFile(new URL("../apps/homescreen/app/components/ExperimentCompareView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../apps/homescreen/app/lib/experiment-comparison.mjs", import.meta.url), "utf8"),
    readFile(reviewRustPath, "utf8"),
    readFile(toolProofRustPath, "utf8"),
    readFile(toolProofCliPath, "utf8"),
    readFile(rlmPanePath, "utf8"),
    readFile(cssPath, "utf8"),
  ]);

  assert.match(rlmPane, /<SupervisionReviewView onCompare=/);
  assert.match(rlmPane, /<ExperimentCompareView onReview=/);
  assert.match(review, /"supervision_review_queue"/);
  assert.match(review, /"record_supervisor_feedback"/);
  assert.match(review, /1 · Small model/);
  assert.match(review, /2 · Supervisor/);
  assert.match(review, /3 · \{interrupted \? "Teacher" : "After the nudge"\}/);
  assert.match(review, /Was this the right intervention\?/);
  assert.match(reviewRust, /RuntimeEvent::StudentInterruption/);
  assert.match(reviewRust, /RuntimeEvent::TeacherContinuation/);
  assert.match(reviewRust, /load_recent_persisted_traces/);
  assert.match(compare, /LOCAL_CANDIDATES = \["local-main", "local-fast"\]/);
  assert.match(compare, /modes: \["main-only"\]/);
  assert.match(compare, /compare the same model twice/);
  assert.match(compare, /"desktop_tool_proof_run"/);
  assert.match(compare, /"desktop_tool_proof_list"/);
  assert.match(compare, /"desktop_tool_proof_prepare"/);
  assert.doesNotMatch(compare, /gateway-supervised/);
  assert.match(comparisonRules, /full 30-task hard suite repeated three times/);
  assert.match(comparisonRules, /canonical event evidence is incomplete/);
  assert.match(proofRust, /CLI owns suite bytes, Pi execution, residency isolation, scoring/);
  assert.match(proofRust, /"--repetitions"/);
  assert.match(proofCli, /suite_hash_matches/);
  assert.match(proofCli, /eventFiles\.length === expectedRows/);
  assert.match(proofCli, /gepa_prompt_policy_first/);
  assert.match(css, /\.content:has\(\.supervision-review\)\s*\{[\s\S]*?overflow: hidden/);
  assert.match(css, /\.content:has\(\.experiment-compare\)\s*\{[\s\S]*?overflow: hidden/);
  assert.match(css, /grid-template-rows: auto minmax\(0, 1fr\) auto/);
});

test("remote review is opt-in, CLI-owned, and never replaces the human label", async () => {
  const [review, bridge, cli] = await Promise.all([
    readFile(reviewViewPath, "utf8"),
    readFile(tiebreakerRustPath, "utf8"),
    readFile(tiebreakerCliPath, "utf8"),
  ]);

  assert.match(review, /"supervision_tiebreaker_analyze"/);
  assert.match(review, /"record_tiebreaker_feedback"/);
  assert.match(review, /GLM second opinion/);
  assert.match(review, /Was this analysis useful\?/);
  assert.match(review, /Was this the right intervention\?/);
  assert.match(bridge, /Consent is bound to the destination/);
  assert.match(bridge, /"--confirm-remote"/);
  assert.doesNotMatch(bridge, /item\.after_output/);
  assert.match(cli, /TIEBREAKER_MODEL = "glm-5\.2"/);
  assert.match(cli, /served-model mismatch/);
  assert.match(cli, /writePrivateImmutable/);
  assert.match(cli, /recordTiebreakerFeedback/);
});

test("desktop migration claims stay tied to explicit product parity", async () => {
  const parity = JSON.parse(await readFile(parityPath, "utf8"));
  assert.equal(parity.release_authority, "apps/homescreen");
  assert.equal(parity.distribution_authority, "@understudylabs/understudy-agent-tools");
  assert.equal(parity.external_research_bridge_policy, "documented_uv_bridge_only");
  assert.equal(parity.legacy_desktop_policy, "extraction_only");
  const ids = parity.features.map((feature) => feature.id);
  assert.equal(new Set(ids).size, ids.length, "parity feature ids must remain unique");
  for (const required of [
    "offline-supervisor-fallback",
    "runtime-repair-experience",
    "signed-in-app-updates",
    "durable-image-and-chat-persistence",
    "resumable-model-downloads",
    "supervision-review-desk",
    "correction-pair-export-and-metrics",
    "remote-review-tiebreaker",
    "unified-experiment-hub",
    "experiment-ledger-first-run",
    "drop-to-workload-compilation",
    "model-card-transparency",
    "reading-pace-streaming",
    "heavy-model-preflight-and-process-reconciliation",
    "native-runtime-deletion",
  ]) {
    assert.ok(ids.includes(required), `parity manifest is missing ${required}`);
  }
  assert.equal(
    parity.features.find((feature) => feature.id === "runtime-repair-experience")?.status,
    "shipped",
  );
  assert.equal(
    parity.features.find((feature) => feature.id === "durable-image-and-chat-persistence")?.status,
    "shipped",
  );
  assert.equal(
    parity.features.find((feature) => feature.id === "resumable-model-downloads")?.status,
    "shipped",
  );
  assert.equal(
    parity.features.find((feature) => feature.id === "supervision-review-desk")?.status,
    "shipped",
  );
  assert.equal(
    parity.features.find((feature) => feature.id === "correction-pair-export-and-metrics")?.status,
    "shipped",
  );
  assert.equal(
    parity.features.find((feature) => feature.id === "model-card-transparency")?.status,
    "shipped",
  );
  assert.equal(
    parity.features.find((feature) => feature.id === "legacy-desktop-retirement-guard")?.status,
    "shipped",
  );
  for (const feature of parity.features) {
    assert.ok(parity.status_values.includes(feature.status), `${feature.id} has an unknown status`);
    assert.ok(feature.evidence.length > 20, `${feature.id} needs concrete evidence`);
  }
  const dispositionGroups = parity.legacy_inventory.groups;
  const legacyFiles = dispositionGroups.flatMap((group) => group.files);
  assert.equal(legacyFiles.length, parity.legacy_inventory.audited_file_count);
  assert.equal(new Set(legacyFiles).size, legacyFiles.length, "legacy files need one disposition");
  for (const group of dispositionGroups) {
    assert.ok(
      parity.legacy_inventory.disposition_values.includes(group.disposition),
      `unknown legacy disposition ${group.disposition}`,
    );
    if (group.disposition === "port_capability") {
      assert.ok(ids.includes(group.target_feature), `${group.target_feature} needs a parity feature`);
    } else {
      assert.ok(group.replacement.length > 20, `${group.disposition} needs a replacement rationale`);
    }
  }
  const actuallyComplete = parity.features.every((feature) =>
    ["shipped", "retired"].includes(feature.status),
  );
  assert.equal(parity.migration_complete, actuallyComplete);
});
