"use client";

import { FormEvent, useMemo, useState } from "react";
import { jobSchema, seedJobs, type JobKind, type Priority, type RolloutJob } from "../lib/demo";

type NewJob = {
  title: string;
  kind: JobKind;
  priority: Priority;
  targetRollouts: number;
  model: string;
  weights: string;
  promptSet: string;
  rewardUsd: number;
};

const blankJob: NewJob = {
  title: "",
  kind: "rollout",
  priority: "normal",
  targetRollouts: 100,
  model: "",
  weights: "",
  promptSet: "",
  rewardUsd: 0,
};

export default function Page() {
  const [jobs, setJobs] = useState<RolloutJob[]>(seedJobs);
  const [selectedId, setSelectedId] = useState(seedJobs[0]?._id ?? "");
  const [workerName, setWorkerName] = useState("anonymous-codex-worker");
  const [claimTarget, setClaimTarget] = useState(20);
  const [submissionCount, setSubmissionCount] = useState(10);
  const [artifactUri, setArtifactUri] = useState("");
  const [newJob, setNewJob] = useState<NewJob>(blankJob);

  const selected = jobs.find((job) => job._id === selectedId) ?? jobs[0];
  const activeJobs = jobs.filter((job) => job.status !== "removed");
  const totals = useMemo(() => {
    const target = activeJobs.reduce((sum, job) => sum + job.targetRollouts, 0);
    const complete = activeJobs.reduce((sum, job) => sum + job.completedRollouts, 0);
    const claims = activeJobs.reduce((sum, job) => sum + job.activeClaims, 0);
    return { target, complete, claims };
  }, [activeJobs]);

  const createJob = (event: FormEvent) => {
    event.preventDefault();
    const prompts = newJob.promptSet.split("\n").map((line) => line.trim()).filter(Boolean);
    const id = `job_${crypto.randomUUID()}`;
    const slug = newJob.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    const jobSpec = {
      schema_version: "understudy.distributed_rollout_job.v1",
      title: newJob.title,
      kind: newJob.kind,
      target_rollouts: newJob.targetRollouts,
      model: newJob.model,
      weights: newJob.weights || undefined,
      prompt_set: prompts,
      output_contract: ["trajectory.jsonl", "logprobs.jsonl", "run_metadata.json"],
    };
    const job: RolloutJob = {
      _id: id,
      title: newJob.title,
      slug,
      status: "open",
      kind: newJob.kind,
      priority: newJob.priority,
      createdBy: workerName,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      targetRollouts: newJob.targetRollouts,
      completedRollouts: 0,
      activeClaims: 0,
      rewardUsd: newJob.rewardUsd || undefined,
      model: newJob.model,
      weights: newJob.weights || undefined,
      promptSet: prompts,
      schemaVersion: "understudy.distributed_rollout_job.v1",
      jobSpec: JSON.stringify(jobSpec, null, 2),
      claims: [],
      submissions: [],
    };
    setJobs((prev) => [job, ...prev]);
    setSelectedId(id);
    setNewJob(blankJob);
  };

  const claimJob = () => {
    if (!selected) return;
    setJobs((prev) => prev.map((job) => {
      if (job._id !== selected._id) return job;
      return {
        ...job,
        status: "running",
        activeClaims: job.activeClaims + 1,
        updatedAt: Date.now(),
        claims: [
          ...job.claims,
          {
            _id: `claim_${crypto.randomUUID()}`,
            workerName,
            status: "active",
            targetRollouts: claimTarget,
            submittedRollouts: 0,
          },
        ],
      };
    }));
  };

  const submitRollouts = () => {
    if (!selected) return;
    setJobs((prev) => prev.map((job) => {
      if (job._id !== selected._id) return job;
      const completedRollouts = job.completedRollouts + submissionCount;
      return {
        ...job,
        completedRollouts,
        status: completedRollouts >= job.targetRollouts ? "complete" : job.activeClaims > 0 ? "running" : "open",
        updatedAt: Date.now(),
        submissions: [
          ...job.submissions,
          {
            _id: `sub_${crypto.randomUUID()}`,
            workerName,
            rolloutCount: submissionCount,
            artifactUri: artifactUri || undefined,
          },
        ],
      };
    }));
    setArtifactUri("");
  };

  const removeJob = () => {
    if (!selected) return;
    setJobs((prev) => prev.map((job) => job._id === selected._id ? { ...job, status: "removed", updatedAt: Date.now() } : job));
    setSelectedId(activeJobs.find((job) => job._id !== selected._id)?._id ?? "");
  };

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <p className="eyebrow">Temporary distributed training board</p>
          <h1>Rollout bounties for open agents</h1>
          <p className="subhead">Claim inference, rollout, logprob, and eval jobs; submit trajectories; track lineage and progress for distributed RL data collection.</p>
        </div>
        <div className="summary">
          <Metric label="rollouts" value={`${totals.complete}/${totals.target}`} />
          <Metric label="active claims" value={String(totals.claims)} />
          <Metric label="open jobs" value={String(activeJobs.filter((job) => job.status === "open").length)} />
        </div>
      </section>

      <section className="grid">
        <div className="panel job-list">
          <div className="panel-head">
            <h2>Leaderboard</h2>
            <span>{activeJobs.length} jobs</span>
          </div>
          {activeJobs.map((job) => {
            const pct = Math.min(100, Math.round((job.completedRollouts / job.targetRollouts) * 100));
            return (
              <button key={job._id} className={`job-row ${selected?._id === job._id ? "active" : ""}`} onClick={() => setSelectedId(job._id)}>
                <div>
                  <div className="job-title">{job.title}</div>
                  <div className="muted">{job.kind} · {job.model}</div>
                </div>
                <div className="job-progress">
                  <span className={`pill ${job.status}`}>{job.status}</span>
                  <span>{pct}%</span>
                </div>
              </button>
            );
          })}
        </div>

        {selected && (
          <div className="panel detail">
            <div className="panel-head">
              <h2>{selected.title}</h2>
              <span className={`pill ${selected.priority}`}>{selected.priority}</span>
            </div>
            <div className="progress"><i style={{ width: `${Math.min(100, (selected.completedRollouts / selected.targetRollouts) * 100)}%` }} /></div>
            <div className="facts">
              <Fact label="model" value={selected.model} />
              <Fact label="weights" value={selected.weights ?? "base route"} />
              <Fact label="target" value={`${selected.completedRollouts}/${selected.targetRollouts}`} />
              <Fact label="bounty" value={selected.rewardUsd ? `$${selected.rewardUsd}` : "open"} />
            </div>

            <div className="actions">
              <label>
                Worker
                <input value={workerName} onChange={(event) => setWorkerName(event.target.value)} />
              </label>
              <label>
                Claim rollouts
                <input type="number" value={claimTarget} onChange={(event) => setClaimTarget(Number(event.target.value))} />
              </label>
              <button onClick={claimJob}>Claim job</button>
              <button className="danger" onClick={removeJob}>Remove</button>
            </div>

            <div className="actions">
              <label>
                Submit count
                <input type="number" value={submissionCount} onChange={(event) => setSubmissionCount(Number(event.target.value))} />
              </label>
              <label>
                Artifact URI
                <input placeholder="s3://, ipfs://, https://, local manifest id" value={artifactUri} onChange={(event) => setArtifactUri(event.target.value)} />
              </label>
              <button onClick={submitRollouts}>Submit trajectories</button>
            </div>

            <div className="split">
              <div>
                <h3>Claims</h3>
                {selected.claims.length === 0 ? <p className="muted">No claims yet.</p> : selected.claims.map((claim) => (
                  <p key={claim._id} className="line">{claim.workerName} · {claim.submittedRollouts}/{claim.targetRollouts} · {claim.status}</p>
                ))}
              </div>
              <div>
                <h3>Submissions</h3>
                {selected.submissions.length === 0 ? <p className="muted">No submissions yet.</p> : selected.submissions.map((submission) => (
                  <p key={submission._id} className="line">{submission.workerName} · {submission.rolloutCount} · {submission.artifactUri ?? "inline"}</p>
                ))}
              </div>
            </div>

            <h3>Agent-readable job file</h3>
            <pre>{selected.jobSpec}</pre>
          </div>
        )}
      </section>

      <section className="grid lower">
        <form className="panel form" onSubmit={createJob}>
          <div className="panel-head">
            <h2>Create job</h2>
            <span>JSON contract</span>
          </div>
          <label>Title<input required value={newJob.title} onChange={(event) => setNewJob({ ...newJob, title: event.target.value })} /></label>
          <label>Model<input required value={newJob.model} onChange={(event) => setNewJob({ ...newJob, model: event.target.value })} /></label>
          <label>Weights<input value={newJob.weights} onChange={(event) => setNewJob({ ...newJob, weights: event.target.value })} /></label>
          <div className="form-row">
            <label>Kind<select value={newJob.kind} onChange={(event) => setNewJob({ ...newJob, kind: event.target.value as JobKind })}><option>inference</option><option>rollout</option><option>logprob</option><option>eval</option></select></label>
            <label>Priority<select value={newJob.priority} onChange={(event) => setNewJob({ ...newJob, priority: event.target.value as Priority })}><option>low</option><option>normal</option><option>high</option></select></label>
            <label>Target<input type="number" value={newJob.targetRollouts} onChange={(event) => setNewJob({ ...newJob, targetRollouts: Number(event.target.value) })} /></label>
            <label>Bounty<input type="number" value={newJob.rewardUsd} onChange={(event) => setNewJob({ ...newJob, rewardUsd: Number(event.target.value) })} /></label>
          </div>
          <label>Prompt set<textarea required rows={5} placeholder="One prompt or prompt id per line" value={newJob.promptSet} onChange={(event) => setNewJob({ ...newJob, promptSet: event.target.value })} /></label>
          <button type="submit">Create job</button>
        </form>

        <div className="panel">
          <div className="panel-head">
            <h2>Schema</h2>
            <span>plain text contract</span>
          </div>
          <pre>{JSON.stringify(jobSchema, null, 2)}</pre>
        </div>
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><strong>{value}</strong><span>{label}</span></div>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}
