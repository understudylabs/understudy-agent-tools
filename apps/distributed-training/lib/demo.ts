export type JobStatus = "open" | "running" | "complete" | "removed";
export type JobKind = "inference" | "rollout" | "logprob" | "eval";
export type Priority = "low" | "normal" | "high";

export type Claim = {
  _id: string;
  workerName: string;
  status: "active" | "submitted" | "released";
  targetRollouts: number;
  submittedRollouts: number;
};

export type Submission = {
  _id: string;
  workerName: string;
  rolloutCount: number;
  artifactUri?: string;
};

export type RolloutJob = {
  _id: string;
  title: string;
  slug: string;
  status: JobStatus;
  kind: JobKind;
  priority: Priority;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  targetRollouts: number;
  completedRollouts: number;
  activeClaims: number;
  rewardUsd?: number;
  lineageParentId?: string;
  model: string;
  weights?: string;
  promptSet: string[];
  schemaVersion: string;
  jobSpec: string;
  claims: Claim[];
  submissions: Submission[];
};

export const jobSchema = {
  schema_version: "understudy.distributed_rollout_job.v1",
  required: ["title", "kind", "target_rollouts", "model", "prompt_set"],
  properties: {
    title: "Human-readable job title",
    kind: "inference | rollout | logprob | eval",
    target_rollouts: "Number of trajectories requested",
    model: "Model id or route id",
    weights: "Optional checkpoint or adapter reference",
    prompt_set: "Array of prompt strings or prompt ids",
    lineage_parent: "Optional parent job id for follow-up jobs",
    output_contract: "Trajectory, logprob, and metadata fields expected in submissions",
  },
};

export const seedJobs: RolloutJob[] = [
  {
    _id: "job_demo_gemma_local_ladder",
    title: "Gemma 4 local ladder rollouts",
    slug: "gemma-4-local-ladder-rollouts",
    status: "running",
    kind: "rollout",
    priority: "high",
    createdBy: "understudy",
    createdAt: Date.now() - 1000 * 60 * 60 * 8,
    updatedAt: Date.now() - 1000 * 60 * 12,
    targetRollouts: 100,
    completedRollouts: 36,
    activeClaims: 3,
    rewardUsd: 500,
    model: "gemma-4-26b-a4b-it-qat-mlx-vlm-4bit-understudy",
    weights: "understudy-signed-snapshot",
    promptSet: ["legal-redline-smoke", "tool-use-simple-8", "finance-extract-10"],
    schemaVersion: "understudy.distributed_rollout_job.v1",
    jobSpec: JSON.stringify({
      title: "Gemma 4 local ladder rollouts",
      kind: "rollout",
      target_rollouts: 100,
      model: "gemma-4-26b-a4b-it-qat-mlx-vlm-4bit-understudy",
      output_contract: ["trajectory.jsonl", "logprobs.jsonl", "run_metadata.json"],
    }, null, 2),
    claims: [
      { _id: "claim_1", workerName: "Luis", status: "active", targetRollouts: 20, submittedRollouts: 12 },
      { _id: "claim_2", workerName: "Codex bench box", status: "active", targetRollouts: 10, submittedRollouts: 0 },
    ],
    submissions: [{ _id: "sub_1", workerName: "Luis", rolloutCount: 12, artifactUri: "ipfs://demo" }],
  },
  {
    _id: "job_demo_glm_logprobs",
    title: "GLM 5.2 logprob comparison traces",
    slug: "glm-5-2-logprob-comparison",
    status: "open",
    kind: "logprob",
    priority: "normal",
    createdBy: "understudy",
    createdAt: Date.now() - 1000 * 60 * 60 * 24,
    updatedAt: Date.now() - 1000 * 60 * 60 * 2,
    targetRollouts: 80,
    completedRollouts: 0,
    activeClaims: 0,
    rewardUsd: 300,
    model: "glm-5.2",
    promptSet: ["agentic-tool-call-repair"],
    schemaVersion: "understudy.distributed_rollout_job.v1",
    jobSpec: JSON.stringify({
      title: "GLM 5.2 logprob comparison traces",
      kind: "logprob",
      target_rollouts: 80,
      model: "glm-5.2",
      output_contract: ["base_trajectory.jsonl", "token_logprobs.jsonl"],
    }, null, 2),
    claims: [],
    submissions: [],
  },
];
