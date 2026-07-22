import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

type PackageJson = {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type RepoSignal = {
  path: string;
  kind: string;
};

type UnderstandCheck = {
  schema_version: "understudy.understand_check.v1";
  repo: string;
  mode: "local-only";
  generated_at: string;
  package_manager: string | null;
  runtime: {
    node: string;
  };
  signals: {
    lockfiles: string[];
    package_scripts: string[];
    likely_harnesses: RepoSignal[];
    likely_metrics: RepoSignal[];
    likely_eval_inputs: RepoSignal[];
    source_roots: string[];
  };
  artifacts: {
    check: string;
    workload_card: string;
  };
  approval_gates: string[];
};

type WorkloadCard = {
  schema_version: "understudy.workload_card.v1";
  workload_id: string;
  workload_name: string | null;
  owner: null;
  candidate_id: string;
  source_path: string | null;
  mode: "local-only";
  workload_shape: string[];
  value_lens: string[];
  success_metric: null;
  validator: {
    name: string | null;
    type: "unit|golden|llm-judge|human-review|custom";
    source_path: string | null;
    approval_required_for_payload_access: true;
  };
  harness: {
    name: string | null;
    command: string | null;
    source_path: string | null;
    environment: {
      runtime: string | null;
      dependencies_lockfile: string | null;
      provider_keys_required: false;
      network_required: false;
    };
  };
  baseline: {
    provider: null;
    model: null;
    latency_ms: null;
    input_tokens: null;
    output_tokens: null;
    cost_usd: null;
    rerun_required: true;
    rerun_reason: string;
    rerun_artifact: null;
    harness_sha256: null;
    metric_sha256: null;
    splits_sha256: null;
  };
  data_class: "source-metadata-only";
  split_boundary: {
    train: null;
    dev: null;
    holdout: null;
  };
  evaluation_inputs: RepoSignal[];
  promotion_gate: null;
  fallback_route: null;
  route_requirements: {
    privacy_boundary: "workflow-bound cloud unless Local is selected";
    latency_target_ms: null;
    structured_output_required: boolean;
    tool_calling_required: boolean;
    pricing_source_required_before_hosted_recommendation: true;
    supplier_profile_required_before_hosted_recommendation: true;
  };
  optimization_rules: {
    gepa_uses_train_dev_only: true;
    holdout_reserved_for_final_validation: true;
  };
  approval_gates: string[];
  discovery: {
    check_artifact: string;
    generated_from: "understudy understand check";
    signals: UnderstandCheck["signals"];
  };
};

const ignoredDirs = new Set([
  ".git",
  ".pytest_cache",
  ".understudy",
  ".tmp",
  "coverage",
  "dist",
  "node_modules",
  "__pycache__",
]);

const approvalGates = [
  "expanding the activated data classes or destination",
  "increasing the activated spend or retention envelope",
  "adding production writes not shown in the activated plan",
];

function readPackageJson(repo: string): PackageJson | null {
  const path = join(repo, "package.json");
  if (!existsSync(path)) {
    return null;
  }
  return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
}

function detectPackageManager(repo: string): string | null {
  for (const [lockfile, manager] of [
    ["package-lock.json", "npm"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
  ] as const) {
    if (existsSync(join(repo, lockfile))) {
      return manager;
    }
  }
  return null;
}

function collectRepoSignals(repo: string): Omit<UnderstandCheck["signals"], "package_scripts"> {
  const lockfiles: string[] = [];
  const likelyHarnesses: RepoSignal[] = [];
  const likelyMetrics: RepoSignal[] = [];
  const likelyEvalInputs: RepoSignal[] = [];
  const sourceRoots: string[] = [];

  const visit = (dir: string, depth: number): void => {
    if (depth > 4) {
      return;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (ignoredDirs.has(entry.name)) {
          continue;
        }
        const child = join(dir, entry.name);
        const rel = relative(repo, child);
        if (["src", "tests", "test", "evals", "fixtures", "prompts"].includes(entry.name)) {
          sourceRoots.push(rel);
        }
        visit(child, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const path = join(dir, entry.name);
      const rel = relative(repo, path);
      const lower = rel.toLowerCase();
      const ext = extname(entry.name).toLowerCase();

      if (["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"].includes(entry.name)) {
        lockfiles.push(rel);
      }
      if (lower.includes("test") || lower.includes("spec") || lower.includes("eval") || lower.includes("harness")) {
        likelyHarnesses.push({ path: rel, kind: ext || "file" });
      }
      if (lower.includes("metric") || lower.includes("rubric") || lower.includes("judge") || lower.includes("validator")) {
        likelyMetrics.push({ path: rel, kind: ext || "file" });
      }
      if (
        lower.includes("fixture") ||
        lower.includes("golden") ||
        lower.includes("dataset") ||
        [".jsonl", ".csv"].includes(ext)
      ) {
        likelyEvalInputs.push({ path: rel, kind: ext || "file" });
      }
    }
  };

  visit(repo, 0);
  const byPath = (left: RepoSignal, right: RepoSignal): number => left.path.localeCompare(right.path);
  const harnessScore = (signal: RepoSignal): number => {
    const lower = signal.path.toLowerCase();
    if (lower.includes("/test") || lower.includes(".test.") || lower.includes(".spec.")) {
      return 0;
    }
    if (lower.includes("harness")) {
      return 1;
    }
    if (lower.includes("eval")) {
      return 2;
    }
    return 3;
  };

  return {
    lockfiles: lockfiles.sort(),
    likely_harnesses: likelyHarnesses
      .sort((left, right) => harnessScore(left) - harnessScore(right) || byPath(left, right))
      .slice(0, 25),
    likely_metrics: likelyMetrics.sort(byPath).slice(0, 25),
    likely_eval_inputs: likelyEvalInputs.sort(byPath).slice(0, 25),
    source_roots: [...new Set(sourceRoots)].sort(),
  };
}

function artifactPath(repo: string, rel: string): string {
  return join(repo, rel);
}

function ensureRepo(repo: string): string {
  const resolved = resolve(repo);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`Repo path does not exist or is not a directory: ${repo}`);
  }
  return resolved;
}

function writeJson(path: string, payload: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function runUnderstandCheck(repoInput: string): UnderstandCheck {
  const repo = ensureRepo(repoInput);
  const packageJson = readPackageJson(repo);
  const checkRel = ".understudy/capture-evidence/check.json";
  const cardRel = ".understudy/workload-discovery/workload-card.json";
  const signals = {
    ...collectRepoSignals(repo),
    package_scripts: Object.keys(packageJson?.scripts ?? {}).sort(),
  };
  const payload: UnderstandCheck = {
    schema_version: "understudy.understand_check.v1",
    repo: basename(repo),
    mode: "local-only",
    generated_at: new Date().toISOString(),
    package_manager: detectPackageManager(repo),
    runtime: {
      node: process.version,
    },
    signals,
    artifacts: {
      check: checkRel,
      workload_card: cardRel,
    },
    approval_gates: approvalGates,
  };
  writeJson(artifactPath(repo, checkRel), payload);
  return payload;
}

function inferWorkloadShape(signals: UnderstandCheck["signals"]): string[] {
  const shapes = new Set<string>();
  if (signals.likely_eval_inputs.some((signal) => signal.path.endsWith(".jsonl") || signal.path.endsWith(".json"))) {
    shapes.add("structured-output");
  }
  if (signals.likely_harnesses.some((signal) => signal.path.includes("test") || signal.path.includes("spec"))) {
    shapes.add("code-or-test");
  }
  if (signals.likely_eval_inputs.some((signal) => signal.path.endsWith(".csv"))) {
    shapes.add("tabular-eval");
  }
  return shapes.size > 0 ? [...shapes].sort() : ["local-repo-workload"];
}

function chooseHarness(signals: UnderstandCheck["signals"]): { command: string | null; source_path: string | null } {
  const preferredScript = ["test", "check", "typecheck"].find((script) => signals.package_scripts.includes(script));
  const source = signals.likely_harnesses[0]?.path ?? null;
  return {
    command: preferredScript ? `npm run ${preferredScript}` : null,
    source_path: source,
  };
}

export function runUnderstandWorkloadCard(repoInput: string): WorkloadCard {
  const check = runUnderstandCheck(repoInput);
  const repo = ensureRepo(repoInput);
  const harness = chooseHarness(check.signals);
  const cardRel = check.artifacts.workload_card;
  const card: WorkloadCard = {
    schema_version: "understudy.workload_card.v1",
    workload_id: "workload-001",
    workload_name: null,
    owner: null,
    candidate_id: "candidate-001",
    source_path: check.signals.source_roots[0] ?? null,
    mode: "local-only",
    workload_shape: inferWorkloadShape(check.signals),
    value_lens: ["quality", "latency", "cost"],
    success_metric: null,
    validator: {
      name: null,
      type: "unit|golden|llm-judge|human-review|custom",
      source_path: check.signals.likely_metrics[0]?.path ?? null,
      approval_required_for_payload_access: true,
    },
    harness: {
      name: harness.command,
      command: harness.command,
      source_path: harness.source_path,
      environment: {
        runtime: "node",
        dependencies_lockfile: check.signals.lockfiles[0] ?? null,
        provider_keys_required: false,
        network_required: false,
      },
    },
    baseline: {
      provider: null,
      model: null,
      latency_ms: null,
      input_tokens: null,
      output_tokens: null,
      cost_usd: null,
      rerun_required: true,
      rerun_reason: "required after harness, metric, validator, or split confirmation",
      rerun_artifact: null,
      harness_sha256: null,
      metric_sha256: null,
      splits_sha256: null,
    },
    data_class: "source-metadata-only",
    split_boundary: {
      train: null,
      dev: null,
      holdout: null,
    },
    evaluation_inputs: check.signals.likely_eval_inputs,
    promotion_gate: null,
    fallback_route: null,
    route_requirements: {
      privacy_boundary: "workflow-bound cloud unless Local is selected",
      latency_target_ms: null,
      structured_output_required: check.signals.likely_eval_inputs.some((signal) => signal.path.endsWith(".jsonl")),
      tool_calling_required: false,
      pricing_source_required_before_hosted_recommendation: true,
      supplier_profile_required_before_hosted_recommendation: true,
    },
    optimization_rules: {
      gepa_uses_train_dev_only: true,
      holdout_reserved_for_final_validation: true,
    },
    approval_gates: approvalGates,
    discovery: {
      check_artifact: check.artifacts.check,
      generated_from: "understudy understand check",
      signals: check.signals,
    },
  };
  writeJson(artifactPath(repo, cardRel), card);
  return card;
}
