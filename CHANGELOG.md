# Changelog

Notable, user-facing changes to the Understudy skills + CLI. Versions track the
plugin: `package.json`, `.claude-plugin/plugin.json`,
`.claude-plugin/marketplace.json`, `.cursor-plugin/plugin.json`,
`.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`,
`.opencode/adapter.json`, `.hermes/adapter.json`, and `.devin/adapter.json` are
bumped together on any release that changes the skill catalog, CLI surface, or
agent-platform adapter surface, because an installed plugin has no other
staleness signal. After upgrading, reload or enable the plugin in your coding
agent.

The format follows [Keep a Changelog](https://keepachangelog.com/); this project
uses semantic-ish versioning (minor = new skill or new capability, patch = fixes).

## [Unreleased]

### Removed

- **Understudy Desktop.** The Tauri app in `apps/homescreen`, its
  `desktop-release` workflow, the `desktop:*` and `runtime:desktop-readiness`
  npm scripts, the release tooling under `scripts/`, and the tests that covered
  only the app are removed. The last release is `desktop-v0.3.44-mvp`; the
  updater pointer no longer advances, so installed apps will not receive
  updates. See `docs/desktop-deprecation.md`.

### Deprecated

- **`understudy desktop ...` commands.** The command group still works against
  an already-installed app but now prints a one-line deprecation warning to
  stderr and will be removed in a future release. stdout is unchanged.

### Added

- **`dspy-gepa` spend governor.** Runs now stop gracefully before
  `--budget-usd` instead of failing near it. The spend ledger throttles: a call
  that would fit once in-flight calls settle waits for them (bounded at 90 s,
  under DSPy's 120 s straggler timeout) instead of ending the run
  `budget-blocked`. With `--evaluate-holdout`, optimization runs under the cap
  minus a holdout reserve (the 90th-percentile settled student call x the
  observed parse-fallback calls per predictor invocation, calibrated from the
  baseline call) and the holdout runs under the full cap. A call left over from
  optimization (still waiting, or from a straggler thread DSPy abandoned) is
  refused once the phase changes (`late-call-refused`), and in-flight calls are
  drained before spend evidence is sampled. A dev evaluation during which calls
  were refused (DSPy scores them as 0 rows) is marked `partial`, never becomes
  best-so-far, and is left out of `gepa_stats`; a run with no fully scored
  candidate fails `budget-blocked` (`no-candidate-fully-scored`). A new
  GEPA stop callback ends optimization between iterations when the next one
  could cross that limit; the run then finalizes with GEPA's best candidate
  (`stopped_by: "spend-governor"` in `candidate.json`, the proof packet, run
  state and payload), scores the holdout, and exits 0 with `candidate-created`.
  New events `spend-rate` (per iteration: committed, in-flight and attributed
  spend, USD/min over the run and the last minute, projected spend for the
  metric-call budget, minutes to the limit), `spend-throttled`, `budget-stop`
  and a one-time `spend-projection-warning`; `--progress` prints one spend line
  per iteration, and `spend_evidence.spend_governor` carries the latest
  snapshot. The hard guarantee is unchanged: committed spend plus every
  in-flight reservation never exceeds the cap. A call the full cap cannot fit
  still ends the run `budget-blocked` (exit 4) or the holdout
  `incomplete-budget`. Set the cap to what you are willing to spend; no padding
  for threads or the holdout. The stopper keeps one worst-case call of
  headroom, so keep `--reflection-max-tokens` at 2,048-4,096: a 16,000-token
  cap reserves several times what proposals use and ends a capped run early.
- **`dspy-gepa` multi-predictor task specs.** `--task-spec PATH`
  (`understudy.dspy_gepa_task_spec.v1`) declares several typed predictors over
  shared inputs, the shape of DSPy's GEPA Facility Support Analyzer tutorial,
  without user Python: `label` outputs become `Literal[...]`, `label-set`
  outputs `list[Literal[...]]`, and `text` stays a matched string. Gold values
  are checked against the spec before any provider call (a label set may be a
  label list or the tutorial's `{label: bool}` object; errors name the row
  index, never its content). The metric averages per-predictor scores, returns
  them as `objective_scores`, and routes tutorial-style feedback to the
  predictor GEPA is rewriting. New `--frontier-type
  instance|objective|hybrid|cartesian` (objective modes need a spec);
  `--component-selector` and the frontier are recorded in `search` and the
  config hash, as is the spec's content. Candidates and holdout evaluations
  report instructions and scores per predictor, and `--seed-instructions`
  accepts spec names. The Facility Support spec ships as
  `docs/dspy-gepa-facility-support-task-spec.json`; see
  `docs/dspy-gepa-hill-climbing.md`.
- **`dspy-gepa` streams and can climb.** Runs now stream
  `dspy-gepa/events.jsonl`, a live `run-state.json` (`status: running` plus the
  current `phase`), and `best-so-far.json` instead of writing everything at the
  end; `--progress` prints live lines and `touch dspy-gepa/STOP` stops a run
  gracefully. Climb controls: `--rounds`/`--min-round-gain` (each round in its
  own resume log), `--seed-instructions`, `--stop-after-stale`,
  `--stop-at-score`, `--max-minutes`, `--proposals-per-iteration`, and
  `--proposer-skill`/`--proposer-note`/`--proposer-max-chars`, all hash-bound
  into the resume config. Spend: `--reflection-max-tokens`, reflection prices,
  repeatable `--model-price`, `--prices-from-gateway auto|off|require` for
  gateway-routed roles, and an observe-only `--no-spend-ledger` for plain
  sample runs. `--evaluate-holdout` scores baseline and optimized once after
  `candidate.json` is frozen and writes `dspy-gepa/holdout-evaluation.json`;
  `--match-mode case-insensitive` fixes a metric trap found in a live run,
  where exact match read 29.4% to 77.9% on a task whose baseline was already
  88.2% once casing was ignored. Holdout results always report both scores.
  Candidates record the evolved instruction text, `instructions_changed`,
  `gepa_stats`, rounds, and search settings. Measured results and the flag
  map are in `docs/dspy-gepa-hill-climbing.md`.
- **Trace-level hosted capture exports.** `understudy traces export <trace-id>`
  calls the customer trace request-ID lookup and hands every returned ID to the
  existing resumable request capture exporter. Explicit `--trace-ids-file`
  batches are supported; the CLI never scans project capture history and has no
  unbounded all-traces mode. Full payloads remain file-only behind
  `--include-payload --yes`, with per-request and per-trace retry manifests.
- **Hosted trace retrieval skill.** The new `export-trace` worker owns requests
  such as "get this trace" when the developer supplies a `trace_id`, then hands
  private local files to `ingest-traces` or the trace viewer. Its intent was
  checked against `use-understudy-gateway` (auth/routing) and `ingest-traces`
  (already-local processing) before adding a new top-level skill.
- **Resumable customer capture batches.** `understudy captures export` now
  accepts `--request-ids-file` for one-request-id-per-line exports using the
  signed-in customer's existing capture access. Batch downloads use bounded
  concurrency, retry transient failures, skip completed files by default, and
  write `failed-request-ids.txt` for a clean retry handoff. Payload export
  remains file-only and requires `--include-payload --yes`. Shared
  authorization failures stop the batch immediately, and failed forced
  refreshes quarantine the previous file so a later resume cannot trust it.
  Summary and payload modes use disjoint filename suffixes. Temporary files are
  randomized and created exclusively before replacement.
- **The benchmark lab comes to the Desktop.** Desktop/runtime 0.3.41 and CLI
  0.6.38 bridge the app to the benchmark/experiment spine: experiment lineage
  cards trace every result back to the run, dataset, and prompt that produced
  it; the drag-drop training flow gains an upload approval gate so nothing
  leaves your machine without an explicit yes; a benchmark linkage pane shows
  which benchmark and split each experiment scored against; and the embedded
  Pi chat gets benchmark tools alongside the new `operate-benchmark-lab`
  skill for driving the whole lab conversationally.
- **A tidier sidebar.** New chat is unnested to the top level, clipped and
  overlapping items are fixed, and leftover UI artifacts are removed.
- **Smart defaults instead of per-call nagging.** The bundled CLI replaces
  repeated per-call approval prompts with a one-time trust posture you set
  once and can revisit.
- **The full benchmark CLI spine.** `benchmarks from-dataset` turns labeled
  datasets into first-class benchmarks; the partner report produces the
  honest benchmark-and-savings deliverable; trivial-agent calibration arms,
  majority-class floors, and the ABC rigor report keep scores honest; and
  GEPA-style prompt evolution runs over prompt-override experiment arms.

- **Sign in as yourself, right from the app.** Desktop/runtime 0.3.40 and CLI
  0.6.37 add browser-based user sign-in (WorkOS AuthKit, PKCE): Account →
  "Sign in with browser" opens your default browser, and the app picks up the
  session with no keys to paste. Signed-in users regain workload-scoped
  capture browsing and get a "signed in as" identity ahead of in-app
  management edits; the existing org API-key flow keeps working unchanged
  for headless and reporting-only use.
- **A calmer, clearer Desktop.** The app now follows the Understudy design
  language across every pane — mint as the single operational accent (the
  legacy orange is retired to vendor identity), cyan for live trace flow,
  violet for search/lineage views, amber for training and data-taking. The
  sidebar consolidates into Capture / Training / Chats / Manage, opens by
  default, shows your organization at bottom-left, and the Workloads view is
  one table with error rate and traffic allocation alongside cost and cache
  reads. Pane scrolling on tall views works again, and abandoned training
  runs no longer linger in the sidebar.

- **See and manage your whole Understudy account from the app.** Desktop/runtime
  0.3.39 and CLI 0.6.36 bring the management control plane into Understudy
  Desktop: without leaving the app you can see your organization and project at
  a glance, read analytics and reporting on usage, cost, and errors, inspect
  each workload's configuration and its live traffic dial, browse captures,
  list your API keys and models, and reach billing, setup, and settings. This
  first release is view-oriented — it surfaces what your account is doing today
  in one place, ahead of in-app editing — and it sits alongside the on-your-own-
  data training work described below, which carries forward unchanged.
- **Train on your own data, end to end.** Desktop/runtime 0.3.38 and CLI
  0.6.35 let you drop a spreadsheet (`.xlsx` workbooks now work, alongside CSV
  and other tables) onto Understudy Desktop and go all the way to a trained
  model: the app reads your file, proposes a training plan in plain language,
  and — only after you approve — runs the training in the cloud. Before
  anything is uploaded or any money is spent, a consent receipts card shows
  exactly what will leave your machine and what it will cost, and you choose
  between training locally or in the cloud. Messy data is handled gracefully:
  empty or ambiguous rows are set aside with a note instead of failing the
  whole import.
- **Dataset focus mode.** While you prepare and launch a training run, the
  training card becomes the whole window — no sidebars or clutter — and the
  window sizes itself to the content.
- **One decision at a time.** Training is now a notebook of quick questions —
  "Does this look like your data?", "Is this the plan you want?" — one card
  at a time with a progress rail below. Your answered cards stay on screen as
  a running record, you can go back and change any answer, and the training
  goal itself is editable, including how accurate the model must be before
  it counts as done. When rows had to be set aside (empty or conflicting
  labels), a review card shows you what and why.
- **Training threads.** Every training run lives in the left-hand sidebar
  like a chat: active runs resume exactly where you left off — even after
  quitting the app — and finished runs reopen as a complete, read-only record
  of every decision you made.
- **Start Moraine from inside the app.** If the local trace explorer is
  down, a Start button in the Explore pane brings it back — no terminal
  needed.
- **Watch your training run, step by step.** A live timeline shows each
  readiness gate as it is checked (with honest results, not spinners), and once
  training starts you get granular status: a loss curve sparkline, a header
  that names the current phase, and a running plain-language narration of what
  is happening. When the run finishes, a training outcome summary connects the
  results back to your evals.
- **`understudy training doctor`.** One CLI command walks the whole
  remote-training chain and reports the first broken link, so "why isn't my
  training working" has a one-step answer.
- **Sturdier app plumbing.** The Desktop's local API server is now supervised:
  it reports why it stopped, restarts itself with capped backoff, and
  health-checks itself, so background features recover without an app restart.
- **Truthful model cards in Chat.** One quiet info action beside the selected
  model now shows its QAT source, MLX conversion, decode contract, scoped
  certification, footprint, routing hints, and current slot state without
  leaving the conversation. The four `-understudy` cards explicitly distinguish
  compression and runtime certification from SFT or RL, and unknown provider or
  local routes stay neutral instead of receiving invented provenance.
- **Truthful native Rust migration baseline.** `understudy runtime conformance
  --backend native` now uses the owner-only authenticated Desktop API to force
  the one-release Rust fallback against a named warm slot. It passes only the
  exact prompt-only case the legacy headless boundary actually supports and
  records richer frozen scenarios as explicit gaps, preventing synthetic
  wrapper events from overstating image, tool, cancellation, compaction,
  restart, or supervision parity.
- **Understudy Desktop agent control plane.** The public CLI now discovers the
  owner-only Desktop capability file and exposes a versioned OpenAPI 3.1
  contract for capabilities, models, downloads, residency, canonical turns,
  exact cancellation/replay, and supervisor feedback. Agent turns can pair a
  small local slot with a distinct local supervisor slot while preserving
  student, supervisor, and teacher events and usage. A frozen synthetic
  grocery-marketplace proof compares small, main, and supervised routes without
  uploads, provider calls, or an LLM judge.
- **Supervisor-decision labeling.** Runtime 0.3.1 gives every supervisor verdict
  a stable marker, including accepted `continue` and `stop` decisions, so human
  feedback can measure missed errors as well as bad nudges and takeovers.

### Changed

- **`dspy-gepa` `--num-threads` defaults to 16** (was 1) for sample and
  task-spec runs, in the CLI and the runtime, and stays part of the hash-bound
  config. Live runs at 32 threads through the Understudy gateway had no
  failures, and the spend governor throttles threads near the cap.
  `--program-bridge` runs keep 1: bridge workload Python may hold stateful tools
  and the bridge contract promises no thread safety. Because the thread count is
  hash-bound, a run started before this change (an in-progress `--log-dir`, or
  an admission receipt) fails `resume-log-config-mismatch` /
  `admission-receipt-config-hash-mismatch` on the identical command; pass
  `--num-threads 1` to resume it.
- **`dspy-gepa` runs on DSPy 3.4.1 and GEPA 0.1.4.** The v2 runtime now pins
  `dspy==3.4.1`, `gepa[dspy]==0.1.4`, and `cloudpickle==3.1.2` with a bounded
  `litellm>=1.83,<2` on Python 3.13, and records all four in its package
  receipt. Spend is metered at DSPy's engine seam (`complete(Request)`), which
  survives DSPy 3.5's removal of `BaseLM.forward()` overrides; zero input and
  zero output usage fails closed as missing usage, a budget or usage failure
  that DSPy wraps is still reported as `budget-blocked` or
  `spend-evidence-error`, and no later call in that run reaches a provider. The
  student `--max-tokens` default rises from 256 to 2048 and reflection gets its
  own `--reflection-max-tokens` (default 2048): a 256-token reflection cap
  truncated GEPA's JSON proposals and silently left the seed prompt unchanged.
  The ledger now settles each completed call's reservation to a conservative
  billable bound; only in-flight and usage-ambiguous calls hold their worst
  case. Holding every call at its full output cap blocked a live run at $5.91
  reserved against $0.23 spent.
- **`check-routing-health` now leads with the new reporting endpoints.**
  The skill's primary path is one org-wide grounding call to
  `/admin/v1/orgs/:org_id/reporting` (usage/cost series across all projects,
  `group_by` project|workload|model, windows to 30d or custom date ranges to
  366d) followed by `workload-status` (per-workload health with declared
  config vs observed route shares, `rerouted_pct`, served-model shares,
  error rate, example request ids). The skill teaches the canonical routing
  vocabulary (`primary` / `understudy` / `fallback` route outcomes;
  `pin`/`steer`/`none` declared config; `anthropic`/`openai`/`managed`
  provider labels), requires grounding every diagnosis in the org-wide
  spend/requests ranking, and calls out declared-vs-observed drift (declared
  split with ~0 observed `understudy` share) as a finding. The rest of the
  `sk_*` self-service surface stays documented as project-scoped
  alternatives: `usage-summary` (computed `cache_read_pct`, per-group error
  rate, multi-dimension grouping) and the captures metadata list (request
  ids/timestamps only — capture content stays behind the dashboard login).
  The legacy `routing-status` / `provider-health` / `status` endpoints stay
  documented as deprecated for older deployments.

### Fixed

- **`dspy-gepa` spend settles to what may have been billed.** A completed call
  used to settle to the price of its reported input and output tokens, but
  DSPy's usage counters are provider-verbatim: Gemini and xAI leave reasoning
  out of `output_tokens` and Anthropic leaves cache writes out of
  `input_tokens`. Settling now keeps the larger of output and `total_tokens`
  minus input, adds separately reported reasoning when the total adds nothing,
  and adds reported cache writes (attribute or nested dict usage), capped at
  the reservation and recorded per entry as `settled_upper_bound_usd`; the
  overrun check reads `total_tokens` too. The fail-closed latch and the refusal
  that sets it now happen under the reservation lock, so a concurrent call can
  no longer reserve in between. Gateway prices apply only to roles whose bound
  base URL is the gateway's, not to any bridge route that names itself
  `understudy-gateway`.
- **`dspy-gepa` task specs read values, not methods, and survive parse
  failures.** Spec outputs and inputs are read by key, since attribute access
  on `dspy.Example`/`Prediction` returns methods for names such as `labels` or
  `items`; those member names, `_`-prefixed names, `model_*`, `signature`,
  `instructions`, `fields`, and the arguments `dspy.Predict` consumes
  (`config`, `demos`, `lm`, `prediction`) are refused in the CLI and the
  runtime, which also rechecks the installed DSPy's members. A predictor whose
  answer fails to parse (`Low` for the label `low`) now scores 0 for that
  predictor with format feedback instead of failing the whole row, so every row
  reports all `objective_scores` and objective frontiers no longer favor
  candidates that fail most rows. Spec rows are validated before the gateway
  price lookup. The docs now say `--match-mode` applies to `text` predictors
  only.
- **`dspy-gepa` keeps the holdout unseen and its artifacts honest.** A train or
  dev split naming the holdout (`--dev-split Holdout`), or equal train and dev
  splits, is refused in the CLI and the runtime, which also asserts holdout rows
  are disjoint from train and dev before any provider call. A seed inside
  `.understudy/optimize-workload/` or the `--log-dir` is refused, since the run
  rewrites it and the identical command could never resume; copy it out first.
  `holdout-evaluation.json` is removed when optimizing starts and listed only
  when this run wrote it, and `best-so-far.json` now carries `run_id` and
  `config_sha256` and is removed unless it belongs to the same config. A
  bridge's context-window gate must report `max_tokens` at least the run's
  student or reflection output cap.
- **Honest backend readiness for the same training plan.** Compiling a portable
  plan no longer claims a backend can run a recipe it has no executor for:
  `adapter_implemented` now comes from the local MLX and Tinker executor
  registries, and the blocked reason names the command that would have to grow
  the recipe. Managed (Fireworks) compilation reports the train API request
  bounds it would be rejected for — model profile, output model name, epochs,
  LoRA rank, context length, runtime, and the 5–500 evaluation-example range —
  instead of implying the plan only needs consent and a live check. Tinker
  compilation blocks on an expired bundled price basis, sends its LoRA scope
  explicitly, rejects a run receipt that reports a different scope, and
  discloses in the new `portability_notes` that a `train_unembed` adapter cannot
  be hosted as a Fireworks LoRA addon. See
  [`docs/training-backend-portability.md`](docs/training-backend-portability.md).

- **Desktop window controls are simpler and updates are easier to verify.**
  Desktop/runtime 0.3.18 and CLI 0.6.15 remove the persisted always-on-top
  titlebar pin and its native capability. The macOS application menu and
  menu-bar tray now both expose **Check for Updates…**, with current,
  available, and failed checks reported through the shared operation notice.
  Automatic availability checks still run at launch and every 15 minutes.

- **Desktop chat is direct by default and releases can update in place.**
  Desktop/runtime 0.3.17 and CLI 0.6.14 stop attaching the experimental
  supervisor to ordinary model-picker turns. Explicit evaluation and agent API
  supervision remain available. This release also bootstraps Tauri's signed
  updater: future Desktop releases can download, verify, install, and restart
  through the shared in-app operation notice, with a manual signed-download
  fallback if an update cannot be applied.

- **Desktop installation no longer depends on npm or a machine-local Node.**
  Desktop/runtime 0.3.16 and CLI 0.6.13 ship one version-coupled cohort: a
  pinned Node 22.23.0 runtime, bundled CLI, Pi conversation sidecar, public
  package resources, and the two external runtime modules needed for HTTP and
  image handling. In-app repair verifies that signed local cohort instead of
  downloading an installer, and release checks verify its versions, hashes,
  dependencies, and Node license before publication.

- **Completed supervisor nudges replace the student answer cleanly.**
  Desktop/runtime 0.3.15 and CLI 0.6.12 preserve the original nudge verdict,
  interruption reason, and teacher continuation while replacing a completed
  structured answer instead of appending a second payload. Streaming nudges
  can still resume the student in place.

- **Desktop API conversations now count toward the exact-release migration
  cohort.** Desktop/runtime 0.3.14 and CLI 0.6.11 record versioned API turns in
  the same local route ledger as GUI turns, including caller-owned run and
  session identity, provider usage, tool rounds, supervision, compaction,
  latency, memory, and terminal status. Canonical traces can no longer succeed
  while the release monitor incorrectly remains at zero observed turns.

- **Every canonical-runtime build has an unambiguous CLI distribution
  identity.** Desktop/runtime 0.3.13 requires CLI 0.6.10. Reusing 0.6.9 after
  its runtime advanced from 0.3.12 to 0.3.13 would have let an installed older
  sidecar look current, so the release gate now audits the entire first-parent
  runtime transition rather than only the last public Desktop tag. A newly
  installed app cannot repair itself back to the older 0.6.8 command surface
  that lacks proof-scoped correction handoff, the GEPA spend fuse, and the
  portable fail-closed grocery proof.

- **CLI installs expose one honest staleness signal for the current command
  surface.** CLI and adapter manifests advance to 0.6.9 after the
  proof-scoped correction handoff, GEPA spend fuse, and portable fail-closed
  grocery proof landed. Desktop's required CLI floor advances with them, so an
  older 0.6.8 checkout can no longer look current while missing those commands.

- **macOS memory headroom stays conservative without collapsing to zero under
  compression.** Desktop 0.3.12 updates the pinned system-memory reader to the
  current Apple XNU available-memory calculation. Model warming still keeps
  the runtime multiplier, 16 GB dynamic reserve, heavy-model exclusivity, and
  GPU teardown delay, but active compressed-memory workloads no longer turn a
  nonzero safe margin into a misleading `0.0 GB`. CLI and adapter manifests
  advance to 0.6.8 with runtime/Desktop 0.3.12.

- **Healthy runtimes reconnect instead of asking for repair.** Desktop 0.3.11
  quietly rebinds the CLI-owned conversation runtime to the current
  authenticated Desktop tool session at launch. A healthy process with a
  stale tool credential is described as reconnecting, the UI clears the
  transient state after readiness, and genuine repair failures remain
  actionable. CLI and adapter manifests advance to 0.6.7 with runtime/Desktop
  0.3.11.

- **Desktop and its canonical sidecar now release as one compatibility unit.**
  CLI and adapter manifests advance to 0.6.6 with runtime/Desktop 0.3.10, and
  Desktop requires that CLI release. The release gate now rejects a runtime
  version bump unless the distributed CLI also advances and the Desktop CLI
  floor matches it, preventing a signed app from repairing back to an older
  sidecar.

- **Desktop repair now installs the ConversationRuntime version the app
  requires.** CLI and adapter manifests advance to 0.6.5 with runtime 0.3.8,
  and Desktop 0.3.8 requires that CLI release. The health check can no longer
  accept a stale 0.6.4 checkout and repeatedly repair back to runtime 0.3.7.

- **Dropped Workload Card review no longer asks a local model to open an
  inaccessible filesystem path.** Desktop now passes only the bounded,
  metadata-only summary into chat, treats its fields as untrusted data, and
  frames a frozen behavior benchmark instead of a file-count check. Structured
  eval rows plus a prompt produce a 10-example incumbent-versus-candidate plan
  while source payloads remain unread until the user explicitly continues.
- **Runtime conformance can no longer pass with ambiguous token attribution.**
  Runtime 0.3.5 requires every usage event to name its exact model, records the
  supervisor model on every verdict, and makes the frozen takeover gate prove
  separate student, supervisor, and teacher usage whose model identities match
  the emitted deltas and teacher continuation. Reference traces must also carry
  the exact frozen user message and image identity instead of merely containing
  similarly named event types. The suite id and fixture hashes changed so older
  evidence fails closed instead of satisfying the release deletion gate.

- **Desktop restart no longer strands tool calls on a stale sidecar token.**
  Idempotent runtime start now compares an injected Desktop tool credential
  with the owner-only stored credential using a timing-safe comparison. If the
  Desktop token rotated while the sidecar stayed healthy, the CLI replaces the
  sidecar before the next turn instead of allowing post-restart tool execution
  to fail with 401.
- **The curl installer can no longer finish looking successful with zero
  coding-agent adapters installed.** `install.sh` now logs the raw agent-menu
  answer and the resolved `--agents` selection to the install log ("Agent
  adapter selection: …"), records installed / skipped / failed per adapter,
  and prints an adapter summary after step 2. The final "Where this goes next"
  section only shows per-agent next steps (e.g. `/reload-plugins` +
  `/understudy:onboard`) for adapters that actually installed. When adapters
  were requested (anything other than `--agents none`) but none installed, or
  an explicitly requested adapter failed on a missing CLI/manifest, the
  installer prints a loud warning with per-platform manual install commands
  and exits with the new status code 3 instead of a clean 0. Adapters the
  user disabled themselves (e.g. `--agents claude-code --no-claude`) count as
  intentional CLI-only installs, not failures, and still exit 0. An
  incomplete adapter step is no longer marked resumable-complete, so
  `--resume` retries adapter installation instead of skipping past it.
- **`understudy setup` crash.** The legacy Claude-compatible skill-copy path
  crashed with `ENOENT ... skills/onboard/frontmatter.md` on every run:
  `frontmatter.md` was folded into `skills/onboard/SKILL.md` in the
  plugin-first onboarding change (0.2.0) without updating `setup.ts`, so every
  release 0.2.0–0.6.0 shipped the command broken. `setup` now installs
  `SKILL.md` directly, rewriting the frontmatter `name` to match the installed
  `understudy-onboard` directory and the `description` to carry both trigger
  surfaces the loose copy serves (first-run onboarding *and* the historical
  "convert to Understudy" / "add GEPA" conversion phrases), appending a short
  routing section that points conversion requests at `setup-code.md`, and
  copying the per-stack recipes and reference docs alongside it, mirroring
  `skills/onboard/` so relative links keep working. README now presents the
  Claude Code plugin install as the primary path with `understudy setup` as
  the legacy loose-copy fallback.

## [0.6.0] — 2026-06-22

### Added

- **Hermes Agent adapter support.** Added a `.hermes/adapter.json` sentinel,
  registry entry, installer autodetection, and `--agents hermes`. The installer
  registers the shared `skills/` tree in `skills.external_dirs`
  (`~/.hermes/config.yaml`) through a durable `~/.understudy/skills` symlink, so
  Hermes discovers the same `SKILL.md` files natively — no copies, no Python
  plugin. Config edits are idempotent and back up `config.yaml`; activation is
  `/reload-skills` (no restart needed).
- **OpenCode adapter support.** Added native OpenCode skill discovery through
  `.opencode/skills`, a `/understudy-onboard` command, installer autodetection,
  and `--agents opencode`.

### Changed

- **Unified agent-adapter setup.** Added `install-agent-adapter` as the canonical
  install/update/verify/uninstall skill for Claude Code, Cursor, Codex, OpenCode,
  and Hermes Agent. The older platform-specific install skills now route to it as
  compatibility shims.
- `understudy doctor` now includes OpenCode and Hermes adapter version drift
  checks, the installer can launch OpenCode when it is the selected launchable
  adapter, and Cursor adapter install now preserves unexpected existing plugin
  paths.
- Clarified that OpenCode support is a native skills/commands adapter, not a
  JS/TS OpenCode plugin, and documented the symlink/restart behavior.
- OpenCode installs now end with a manual TUI handoff instead of auto-launching
  `opencode` from the curl-piped installer, avoiding Bun/OpenCode TTY failures.

## [0.5.0] — 2026-06-19

### Added

- **`ladder` remote model picker.** The ladder now builds remote lanes from the
  Understudy gateway catalog when org context is available, falls back to the
  public remote model list, and supports explicit existing model ids via
  `UNDERSTUDY_LADDER_REMOTE_MODELS` (for example `glm-5.2`). The viewer consumes
  `/models` as the source of truth instead of hard-coding only `glm-5.1`.

### Changed

- `understudy run` now injects the non-secret `UNDERSTUDY_ORG_ID` when known so
  local tools can discover org-scoped hosted metadata without reading
  credentials from disk.

## [0.4.0] — 2026-06-19

### Added

- **Multi-agent plugin adapters.** Added a shared adapter registry and
  `understudy platforms` so Claude Code, Cursor, and Codex can expose the same
  `skills/` tree without platform-specific forks.
- **Cursor plugin support.** Added `.cursor-plugin/plugin.json`, an
  `install-cursor-plugin` skill, installer autodetect/linking into
  `~/.cursor/plugins/local/understudy`, and README/docs activation guidance.
- **Codex plugin support.** Added `.codex-plugin/plugin.json`, a local Codex
  marketplace at `.agents/plugins/marketplace.json`, an `install-codex-plugin`
  skill, installer marketplace registration, and `/plugins` activation
  guidance.

### Changed

- `install.sh` now supports `--agents auto|all|claude-code|cursor|codex|none`
  and `UNDERSTUDY_AGENT_PLATFORMS` so the curl installer can autodetect or
  explicitly target multiple coding-agent harnesses.
- `understudy doctor` now checks version consistency across Claude Code,
  Cursor, and Codex plugin metadata.

### Fixed

- **`ladder` scoring integrity.** Wired the `no_extra_writes` anti-shotgun check
  into all three hard tasks (it existed but was used by none), so a model that
  does the right work but also shotguns — extra emails, or touching the
  `sla_route` P2 decoy ticket `T-556` — now loses `strict`. The numeric
  `body_contains` match is digit-bounded (`3808` is no longer satisfied by
  `38080`), and a task with only negative assertions is rejected at load. Verified:
  the gold trajectory and the frontier (`glm-5.1`) still score `strict=1.0`; a
  shotgun trajectory now fails.

## [0.3.0] — 2026-06-16

### Added

- **`ladder` skill** — a local web UI for an immediate local-vs-frontier model
  comparison (the onboarding "climb"): a local mlx model and a frontier gateway
  model run the same task with live thinking + tool-call traces, scored against a
  synthetic world. Skill catalog goes from 21 to 22. (Existing installs need this
  release to pick it up — see the note at the top.)
- **`ingest-traces`** gained a LOTUS semantic-triage reference and orchestrator
  routing for developers who already have production traces.

### Changed

- **`recursive-language-model`** now measures the decomposition *process*, not
  just the outcome.
- Folded June-2026 local-model + gateway benchmark learnings into the
  `run-local-model-lab`, `manage-local-models`, and gateway-touching skills.
- **Gateway inference always streams** across the skills, recipes, and CLI (the
  edge cuts long non-streaming calls), so frontier and routed runs are reliable.
- Installer glow-up with an agent-native two-phase login for a demoable,
  agent-first sign-up; `install.sh` bash 3.2 fix.
- CLI workload admin commands (`list`/`create`/`update`) moved to `/admin/v1`;
  hosted-contract docs linked from the README and gateway-touching skills.

## [0.2.0] — 2026-06-11

### Added

- **Plugin staleness signal** so updates actually reach existing installs:
  `install-plugin` compares the installed version against the repo's
  `plugin.json`, `understudy doctor` fails if the three version files drift, and
  the release checklist requires the joint bump.
- Telemetry disclosure in the CLI (`status` shows a telemetry line; login prints
  the opt-out once) and a global `--json` flag surfaced in every subcommand.

### Changed

- Consolidated the skill catalog from 32 to 21 focused skills.
