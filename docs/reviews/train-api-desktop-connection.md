# Security review: Desktop → remote train-api connection

Status: **Ready for founder sign-off**
Scope: the desktop (Understudy Desktop, Tauri) connection to the hosted remote
training control plane at `https://train.understudylabs.com/api/train/v1`.
Reviewer: _(pending founder signature)_
Date opened: 2026-07-20

This review covers the surface that is de-experimentalized by defaulting the
desktop base URL to production without requiring an explicit
`UNDERSTUDY_TRAIN_API_BASE` override. All code paths are in
`apps/homescreen/src-tauri/src/remote_training.rs` unless noted.

The production control plane is disabled-by-default server-side
(`TRAIN_API_ENABLED`/founder-gated), and serverless execution stays OFF
(`TRAIN_SERVERLESS_ENABLED` off — capabilities exposes only the `managed`
provider). This review does not authorize enabling either flag.

---

## 1. Transport and endpoint pinning

- `train_api_base()` defaults to `DEFAULT_TRAIN_API_BASE`
  (`https://train.understudylabs.com/api/train/v1`). The `UNDERSTUDY_TRAIN_API_BASE`
  override remains for localhost/staging only.
- Fails closed: rejects any non-HTTPS URL except `http://127.0.0.1|localhost`;
  rejects URLs carrying a username or password.
- `validate_control_plane_url()` re-pins every server-returned control-plane URL
  (`status_url`, `events_url`, and the derived `actions` URL) to the same
  scheme, host, port, and path prefix as the base. A run receipt that points
  events/status/actions at a different host is rejected — the service cannot
  redirect the desktop to an attacker-controlled origin.
- Presigned upload URLs (`upload_artifact`) must parse as HTTPS or the upload is
  refused ("unsafe upload URL").

Checklist:
- [ ] HTTPS-only default confirmed; localhost is the only plaintext exception.
- [ ] Control-plane URL pinning covers status, events, and actions.
- [ ] No credentials accepted in the base URL.

## 2. Authentication

- Every control-plane call uses `bearer_auth(credentials.api_key)` — the
  `sk_`/session key resolved by `crate::creds::resolve()`
  (`api_credentials()`); if no key is present the flow refuses with
  "Sign in to Understudy before starting private remote training."
- Per-run calls additionally send `x-understudy-train-run-token`
  (`run_api_json()`), a run-scoped capability issued by the create-run receipt.
- `read_run()` rejects any persisted run whose `run_token` is shorter than 32
  chars or whose manifest path does not canonically bind to the run file.
- Founder gating is enforced server-side (`authenticateFounderTrainRequest`);
  the desktop key is presented but authorization is decided by the service.

Checklist:
- [ ] Bearer `sk_` + per-run token required on every request.
- [ ] Missing credentials fail closed before any upload.
- [ ] Run token length/binding integrity checked locally.

## 3. What leaves the machine (consent-gated, sha-bound)

- Uploads only proceed when `confirm_upload && confirm_spend` are both true
  (`start_remote_classification_training`); temporary-deployment consent is a
  separate `confirm_temporary_deployment` flag carried in the run's `consent`
  block.
- Only the approved plan artifacts are uploaded. Each is re-verified at send
  time:
  - `verify_remote_artifact()` canonicalizes the path and asserts it lives
    under a `remote-training/<plan-root>/` private root (path-escape guard),
    re-reads bytes and re-checks `sha256` + `size_bytes` + row count against the
    approved plan, and enforces `MAX_REMOTE_ARTIFACT_BYTES` (150 MiB).
  - `upload_artifact()` requires the upload-intent `sha256` to equal the
    artifact `sha256`, re-reads the file, and asserts the on-wire body length
    equals the declared `size_bytes` (defeats the Vercel Blob empty-object
    ack).
- The `consent` payload records `approved_artifact_sha256` for every artifact,
  so the server can bind the run to exactly the approved bytes.
- Local inspection/compile steps assert a "local-only"/"statistics-only"
  boundary before anything is eligible for upload
  (dataset/CSV inspection guards).

Checklist:
- [ ] No upload without explicit upload + spend consent.
- [ ] Every uploaded byte is sha256- and size-bound to the approved plan.
- [ ] Artifacts cannot escape the private plan root.
- [ ] Only train/validation/heldout splits leave — no raw prompts or rows in
      telemetry (server capability `raw_rows_in_telemetry: false`).

## 4. Spend caps

- `MAX_REMOTE_TRAINING_BUDGET_USD = 1_000.0`, enforced as a hard `0 < x <= 1000`
  range check on the plan's `maximum_spend_usd`; the plan compiles at `$0` and
  must be explicitly re-priced before a run.
- The run request sends `budget.max_usd` / `max_runtime_seconds` /
  `max_eval_examples`; the server capabilities envelope independently caps
  `max_budget_usd: 1000` and reserves spend server-side before work begins.
- `validate_capabilities()` checks the live capabilities against the plan
  before any upload, so a plan exceeding server limits fails before data moves.

Checklist:
- [ ] $1000 hard ceiling enforced client- and server-side.
- [ ] Spend reserved server-side before execution; run refused if unaffordable.
- [ ] Zero-budget plans cannot start a paid run.

## 5. Fail-closed behaviors

- Missing/invalid credentials, non-HTTPS base, credentialed URL, mismatched
  control-plane host, unsafe presigned URL, changed artifact bytes, malformed
  plan/run schema, non-`queued` run receipt — every one returns `Err` and
  aborts before or between phases.
- Capabilities are validated against the plan up front; the model profile and
  provider (`managed`) must be present and enabled.
- No secrets, dataset rows, prompts, signed URLs, or run tokens are logged
  (matches the service AGENTS.md "never log" boundary); error strings are
  truncated to 500 chars.

Checklist:
- [ ] Every remote step has an explicit failure path; none default to "proceed".
- [ ] No sensitive material reaches logs or telemetry.

## 6. Cleanup receipts

- If run creation fails after uploads have landed,
  `start_remote_classification_training` issues a best-effort
  `DELETE /uploads` with the uploaded `pathnames` so orphaned blobs are removed.
- Run/plan state is persisted under the private per-run root (`persist_run`),
  keeping receipts local and canonically bound.

Checklist:
- [ ] Failed runs clean up their uploads.
- [ ] Run receipts are stored privately and integrity-bound.

---

## Sign-off

By signing, the founder confirms the surface above is acceptable for the
production default and that widening data egress, auth, or spend requires a new
review.

- [ ] Founder sign-off: ______________________  Date: __________

## Companion change required (platform repo)

The canonical "experimental until security review" note lives in the **platform**
repo at `services/train-api/AGENTS.md`:

> "Desktop integration must use an explicit experimental base URL until this
> service has completed security and production-readiness review."

On sign-off, that line should be updated (separate platform PR) to reference
this completed review. This agent-tools PR does not touch the platform repo.
