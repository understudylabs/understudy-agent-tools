/**
 * `understudy training doctor` — walk the remote-training chain and
 * report the FIRST broken link with an actionable next step.
 *
 * The chain (workload mode):
 *
 *   workload-card.json → table inspection artifact → dataset-manifest.json
 *   (+ split files, sha256/row counts) → remote-training plan.json
 *   (verifyPortableTrainingPlan) → environment-proposal.json
 *   (validateEnvironmentProposal) → run.json → live training service.
 *
 * Plan mode (`--plan`) starts mid-chain at the plan link.
 *
 * Privacy: this module never prints tokens, signed URLs, or dataset
 * rows — statistics and statuses only.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { readCredentials } from "../config/credentials.js";
import { validateEnvironmentProposal } from "../environment-proposal/index.js";
import { verifyPortableTrainingPlan } from "../training-plan/index.js";

export const TRAINING_DOCTOR_SCHEMA = "understudy.training.doctor.v1";

/** Same resolution the desktop uses (remote_training.rs). */
export const DEFAULT_TRAIN_API_BASE = "https://train.understudylabs.com/api/train/v1";
const TRAIN_API_SCHEMA = "understudy-train-v1";
const RUN_SCHEMA = "understudy.remote_training.run.v1";
const HTTP_TIMEOUT_MS = 10_000;

export type DoctorCheckStatus = "pass" | "fail" | "pending" | "skipped";

export type DoctorCheck = {
  id: string;
  label: string;
  status: DoctorCheckStatus;
  detail: string;
  next?: string;
};

export type TrainingDoctorReport = {
  schema_version: typeof TRAINING_DOCTOR_SCHEMA;
  mode: "workload" | "plan";
  healthy: boolean;
  first_failure: string | null;
  checks: DoctorCheck[];
};

export type TrainingDoctorOptions = {
  workloadRoot?: string;
  planPath?: string;
  expectRun?: boolean;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function readJson(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function trainApiBase(): URL {
  const raw = process.env.UNDERSTUDY_TRAIN_API_BASE ?? DEFAULT_TRAIN_API_BASE;
  const url = new URL(`${raw.replace(/\/+$/, "")}/`);
  const localHttp = url.protocol === "http:"
    && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("Remote training requires HTTPS, except on localhost.");
  }
  if (url.username || url.password) {
    throw new Error("The remote training API URL cannot contain credentials.");
  }
  return url;
}

/** Desktop-equivalent credential resolution: `~/.understudy/credentials.json`. */
function resolveApiKey(): string | null {
  if (process.env.UNDERSTUDY_API_KEY) return process.env.UNDERSTUDY_API_KEY;
  const credentials = readCredentials();
  if (!credentials) return null;
  if (credentials.api_key) return credentials.api_key;
  const orgs = Object.values(credentials.orgs);
  return orgs.length === 1 ? orgs[0]!.api_key : null;
}

/** Same-control-plane guard the desktop applies to saved run URLs. */
function assertControlPlaneUrl(value: string, base: URL): void {
  const url = new URL(value);
  if (
    url.protocol !== base.protocol
    || url.hostname !== base.hostname
    || url.port !== base.port
    || !url.pathname.startsWith(base.pathname)
  ) {
    throw new Error("run.json names a control-plane URL outside the configured training service");
  }
}

/** Bounded search for `remote-training/<run>/plan.json` under a root. */
function findPlanPaths(root: string, depth = 5): string[] {
  const found: string[] = [];
  const walk = (dir: string, remaining: number): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      if (entry === "remote-training") {
        for (const runDir of readdirSync(path)) {
          const planPath = join(path, runDir, "plan.json");
          if (existsSync(planPath)) found.push(planPath);
        }
      } else if (remaining > 0) {
        walk(path, remaining - 1);
      }
    }
  };
  walk(root, depth);
  return found.sort(
    (left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs,
  );
}

/** Bounded search for dataset-manifest.json files under a root. */
function findDatasetManifests(root: string, depth = 4): string[] {
  const found: string[] = [];
  const walk = (dir: string, remaining: number): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isFile() && entry === "dataset-manifest.json") {
        found.push(path);
      } else if (stat.isDirectory() && entry !== "remote-training" && remaining > 0) {
        walk(path, remaining - 1);
      }
    }
  };
  walk(root, depth);
  return found.sort(
    (left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs,
  );
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json", ...headers },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`the training service returned malformed JSON (HTTP ${response.status})`);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`the training service returned a non-object response (HTTP ${response.status})`);
  }
  return { status: response.status, body: body as Record<string, unknown> };
}

type ChainState = {
  checks: DoctorCheck[];
  firstFailure: string | null;
};

function record(
  state: ChainState,
  check: DoctorCheck,
): void {
  state.checks.push(check);
  if (check.status === "fail" && state.firstFailure === null) {
    state.firstFailure = check.id;
  }
}

function skip(state: ChainState, id: string, label: string, reason: string): void {
  record(state, { id, label, status: "skipped", detail: reason });
}

export async function runTrainingDoctor(
  options: TrainingDoctorOptions,
): Promise<TrainingDoctorReport> {
  const mode: TrainingDoctorReport["mode"] = options.planPath ? "plan" : "workload";
  const fetchImpl = options.fetchImpl ?? fetch;
  const state: ChainState = { checks: [], firstFailure: null };
  const broken = () => state.firstFailure !== null;

  let planPath: string | null = options.planPath ? resolve(options.planPath) : null;

  if (mode === "workload") {
    const root = resolve(options.workloadRoot!);

    // 1. workload-card.json
    const cardPath = join(root, "workload-card.json");
    if (!existsSync(cardPath)) {
      record(state, {
        id: "workload_card",
        label: "workload-card.json",
        status: "fail",
        detail: `missing at ${cardPath}`,
        next: "Run `understudy capture-import compile --source <path>` (or point --workload at the artifact root it prints).",
      });
    } else {
      try {
        const card = readJson(cardPath);
        if (typeof card.workload_id !== "string" || typeof card.workload_name !== "string") {
          throw new Error("missing workload_id/workload_name");
        }
        record(state, {
          id: "workload_card",
          label: "workload-card.json",
          status: "pass",
          detail: `workload "${card.workload_name}"`,
        });
      } catch (error) {
        record(state, {
          id: "workload_card",
          label: "workload-card.json",
          status: "fail",
          detail: `invalid: ${(error as Error).message}`,
          next: "Re-run `understudy capture-import compile` to regenerate the workload card.",
        });
      }
    }

    // 2. table inspection artifact
    if (broken()) {
      skip(state, "inspection", "table inspection artifact", "blocked by earlier failure");
    } else {
      const inspectionPath = join(root, "csv-inspection.json");
      if (!existsSync(inspectionPath)) {
        record(state, {
          id: "inspection",
          label: "table inspection artifact",
          status: "fail",
          detail: `missing csv-inspection.json in ${root}`,
          next: "Run `understudy capture-import inspect-csv --source <table> --artifact-root <root>` on the CSV/XLSX source.",
        });
      } else {
        try {
          const inspection = readJson(inspectionPath);
          if (inspection.schema_version !== "understudy.capture_import.csv_inspection.v1") {
            throw new Error(`unsupported schema_version ${String(inspection.schema_version)}`);
          }
          record(state, {
            id: "inspection",
            label: "table inspection artifact",
            status: "pass",
            detail: "csv-inspection.json present",
          });
        } catch (error) {
          record(state, {
            id: "inspection",
            label: "table inspection artifact",
            status: "fail",
            detail: `invalid: ${(error as Error).message}`,
            next: "Re-run `understudy capture-import inspect-csv` against the current source table.",
          });
        }
      }
    }

    // 3. dataset-manifest.json + split files
    if (broken()) {
      skip(state, "dataset_manifest", "dataset manifest and splits", "blocked by earlier failure");
    } else {
      const manifests = findDatasetManifests(root);
      if (manifests.length === 0) {
        record(state, {
          id: "dataset_manifest",
          label: "dataset manifest and splits",
          status: "fail",
          detail: `no dataset-manifest.json found under ${root}`,
          next: "Run `understudy capture-import prepare-classification` to build the frozen splits.",
        });
      } else {
        const manifestPath = manifests[0]!;
        try {
          const manifest = readJson(manifestPath);
          const splits = manifest.splits as Record<
            string,
            { path?: string; row_count?: number; sha256?: string }
          > | undefined;
          if (!splits || typeof splits !== "object") throw new Error("manifest has no splits");
          const names = Object.keys(splits);
          if (names.length === 0) throw new Error("manifest has no splits");
          let totalRows = 0;
          for (const [name, split] of Object.entries(splits)) {
            const splitPath = split.path ? resolve(dirname(manifestPath), split.path) : null;
            if (!splitPath || !existsSync(splitPath)) {
              throw new Error(`${name} split file is missing`);
            }
            const content = readFileSync(splitPath);
            if (split.sha256 && sha256(content) !== split.sha256) {
              throw new Error(`${name} split sha256 does not match the manifest`);
            }
            const rows = content.toString("utf8").split("\n").filter(Boolean).length;
            if (typeof split.row_count === "number" && rows !== split.row_count) {
              throw new Error(`${name} split has ${rows} rows; manifest says ${split.row_count}`);
            }
            totalRows += rows;
          }
          record(state, {
            id: "dataset_manifest",
            label: "dataset manifest and splits",
            status: "pass",
            detail: `${names.length} split(s), ${totalRows} rows, hashes match`,
          });
        } catch (error) {
          record(state, {
            id: "dataset_manifest",
            label: "dataset manifest and splits",
            status: "fail",
            detail: `${manifestPath}: ${(error as Error).message}`,
            next: "Re-run `understudy capture-import prepare-classification`; the split artifacts changed after preparation.",
          });
        }
      }
    }

    // Locate the newest remote-training plan for the later links.
    if (!broken()) {
      const plans = findPlanPaths(root);
      planPath = plans[0] ?? null;
    }
  }

  // 4. plan.json verifies
  let planRoot: string | null = null;
  if (broken()) {
    skip(state, "plan", "training plan (plan.json)", "blocked by earlier failure");
  } else if (!planPath) {
    record(state, {
      id: "plan",
      label: "training plan (plan.json)",
      status: "fail",
      detail: "no remote-training/*/plan.json found",
      next: "Prepare a remote training plan from Understudy Desktop (or pass --plan <path> directly).",
    });
  } else if (!existsSync(planPath)) {
    record(state, {
      id: "plan",
      label: "training plan (plan.json)",
      status: "fail",
      detail: `missing at ${planPath}`,
      next: "Point --plan at an existing remote-training plan.json.",
    });
  } else {
    try {
      const verified = verifyPortableTrainingPlan(planPath);
      planRoot = verified.root;
      record(state, {
        id: "plan",
        label: "training plan (plan.json)",
        status: "pass",
        detail: `recipe ${verified.plan.recipe_id}, `
          + `${verified.artifacts.train.row_count}/${verified.artifacts.validation.row_count}/${verified.artifacts.heldout.row_count} `
          + "train/validation/heldout rows verified",
      });
    } catch (error) {
      record(state, {
        id: "plan",
        label: "training plan (plan.json)",
        status: "fail",
        detail: `${planPath}: ${(error as Error).message}`,
        next: "The immutable plan no longer verifies; prepare a fresh remote training plan.",
      });
    }
  }

  // 5. environment-proposal.json validates
  if (broken()) {
    skip(state, "environment_proposal", "environment proposal", "blocked by earlier failure");
  } else {
    const proposalPath = join(planRoot!, "environment-proposal.json");
    if (!existsSync(proposalPath)) {
      record(state, {
        id: "environment_proposal",
        label: "environment proposal",
        status: "fail",
        detail: `missing at ${proposalPath}`,
        next: `Run \`understudy training goal-card --plan ${planPath}\` to build and validate the environment proposal.`,
      });
    } else {
      try {
        const validation = validateEnvironmentProposal(proposalPath);
        if (validation.executable) {
          record(state, {
            id: "environment_proposal",
            label: "environment proposal",
            status: "pass",
            detail: `executable; ${Object.keys(validation.gates).length} gates green`,
          });
        } else {
          record(state, {
            id: "environment_proposal",
            label: "environment proposal",
            status: "fail",
            detail: `needs verifier; blocking gates: ${validation.blockers.join(", ")}`,
            next: "Resolve the blocking gates (or rebuild the proposal with `understudy training goal-card`).",
          });
        }
      } catch (error) {
        record(state, {
          id: "environment_proposal",
          label: "environment proposal",
          status: "fail",
          detail: `${proposalPath}: ${(error as Error).message}`,
          next: `Rebuild it with \`understudy training goal-card --plan ${planPath}\`.`,
        });
      }
    }
  }

  // 6. run.json
  let run: { run_id: string; status_url: string; run_token: string } | null = null;
  if (broken()) {
    skip(state, "run_manifest", "run receipt (run.json)", "blocked by earlier failure");
  } else {
    const runPath = join(planRoot!, "run.json");
    if (!existsSync(runPath)) {
      if (options.expectRun) {
        record(state, {
          id: "run_manifest",
          label: "run receipt (run.json)",
          status: "fail",
          detail: `no run.json in ${planRoot} (--expect-run set)`,
          next: "Start the remote training run from Understudy Desktop; run.json is written when the service accepts it.",
        });
      } else {
        record(state, {
          id: "run_manifest",
          label: "run receipt (run.json)",
          status: "pending",
          detail: "no run started yet (not an error; pass --expect-run to require one)",
        });
      }
    } else {
      try {
        const manifest = readJson(runPath);
        if (
          manifest.schema_version !== RUN_SCHEMA
          || typeof manifest.run_id !== "string"
          || typeof manifest.status_url !== "string"
          || typeof manifest.run_token !== "string"
        ) {
          throw new Error("run receipt is missing required fields");
        }
        run = {
          run_id: manifest.run_id,
          status_url: manifest.status_url,
          run_token: manifest.run_token,
        };
        record(state, {
          id: "run_manifest",
          label: "run receipt (run.json)",
          status: "pass",
          detail: `run ${run.run_id}`,
        });
      } catch (error) {
        record(state, {
          id: "run_manifest",
          label: "run receipt (run.json)",
          status: "fail",
          detail: `${runPath}: ${(error as Error).message}`,
          next: "Remove the corrupt run.json and restart the run from Understudy Desktop.",
        });
      }
    }
  }

  // 7. live training service: capabilities
  if (broken()) {
    skip(state, "server_capabilities", "training service capabilities", "blocked by earlier failure");
    skip(state, "run_status", "live run status", "blocked by earlier failure");
    return finish(state, mode);
  }

  let base: URL;
  try {
    base = trainApiBase();
  } catch (error) {
    record(state, {
      id: "server_capabilities",
      label: "training service capabilities",
      status: "fail",
      detail: (error as Error).message,
      next: "Fix UNDERSTUDY_TRAIN_API_BASE (or unset it to use the default endpoint).",
    });
    skip(state, "run_status", "live run status", "blocked by earlier failure");
    return finish(state, mode);
  }

  const apiKey = resolveApiKey();
  if (!apiKey) {
    record(state, {
      id: "server_capabilities",
      label: "training service capabilities",
      status: "fail",
      detail: "no Understudy credentials found",
      next: "Run `understudy login` to create ~/.understudy/credentials.json.",
    });
    skip(state, "run_status", "live run status", "blocked by earlier failure");
    return finish(state, mode);
  }

  try {
    const { status, body } = await fetchJson(
      fetchImpl,
      new URL("capabilities", base).toString(),
      { authorization: `Bearer ${apiKey}` },
    );
    if (status < 200 || status >= 300) {
      throw new Error(`the training service rejected the request (HTTP ${status})`);
    }
    if (body.schema_version !== TRAIN_API_SCHEMA) {
      throw new Error("the training service returned an unsupported capability contract");
    }
    const providers = Array.isArray(body.providers) ? body.providers : [];
    const managed = providers.find(
      (provider) => provider && typeof provider === "object"
        && (provider as Record<string, unknown>).id === "managed"
        && (provider as Record<string, unknown>).enabled === true,
    );
    if (!managed) {
      throw new Error("the managed training provider is unavailable");
    }
    record(state, {
      id: "server_capabilities",
      label: "training service capabilities",
      status: "pass",
      detail: `reachable at ${base.host}; managed provider enabled`,
    });
  } catch (error) {
    record(state, {
      id: "server_capabilities",
      label: "training service capabilities",
      status: "fail",
      detail: (error as Error).message,
      next: "Check network access and credentials, then retry (`understudy login` refreshes the key).",
    });
    skip(state, "run_status", "live run status", "blocked by earlier failure");
    return finish(state, mode);
  }

  // 8. live run status
  if (!run) {
    skip(state, "run_status", "live run status", "no run started yet");
    return finish(state, mode);
  }
  try {
    assertControlPlaneUrl(run.status_url, base);
    const { status, body } = await fetchJson(fetchImpl, run.status_url, {
      authorization: `Bearer ${apiKey}`,
      "x-understudy-train-run-token": run.run_token,
    });
    if (status < 200 || status >= 300) {
      throw new Error(`the training service rejected the run status request (HTTP ${status})`);
    }
    const workflowStatus = typeof body.workflow_status === "string"
      ? body.workflow_status
      : "unknown";
    if (workflowStatus === "failed" || workflowStatus === "cancelled") {
      record(state, {
        id: "run_status",
        label: "live run status",
        status: "fail",
        detail: `run ${run.run_id} is ${workflowStatus}`,
        next: "Inspect the run result in Understudy Desktop and start a fresh run.",
      });
    } else {
      record(state, {
        id: "run_status",
        label: "live run status",
        status: "pass",
        detail: `run ${run.run_id} is ${workflowStatus}`,
      });
    }
  } catch (error) {
    record(state, {
      id: "run_status",
      label: "live run status",
      status: "fail",
      detail: (error as Error).message,
      next: "The saved run receipt no longer reaches the service; check the run in Understudy Desktop.",
    });
  }

  return finish(state, mode);
}

function finish(state: ChainState, mode: TrainingDoctorReport["mode"]): TrainingDoctorReport {
  return {
    schema_version: TRAINING_DOCTOR_SCHEMA,
    mode,
    healthy: state.firstFailure === null,
    first_failure: state.firstFailure,
    checks: state.checks,
  };
}

export function renderTrainingDoctorReport(report: TrainingDoctorReport): string {
  const lines: string[] = [];
  for (const check of report.checks) {
    const mark = check.status === "pass"
      ? "✓"
      : check.status === "fail"
        ? "✗"
        : check.status === "pending"
          ? "…"
          : "-";
    lines.push(`${mark} ${check.label}: ${check.detail}`);
    if (check.status === "fail" && check.id === report.first_failure && check.next) {
      lines.push(`  next: ${check.next}`);
    }
  }
  lines.push(
    report.healthy
      ? "training chain: healthy"
      : `training chain: broken at ${report.first_failure}`,
  );
  return `${lines.join("\n")}\n`;
}
