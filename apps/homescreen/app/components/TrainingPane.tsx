"use client";

export function TrainingPane() {
  return (
    <>
      <div className="pane-head">
        <h1 className="pane-title">Training</h1>
        <p className="pane-sub">Adapters, datasets, eval gates, and local fine-tuning jobs.</p>
      </div>

      <div className="pane-body">
        <div className="card">
          <div className="card-row">
            <div>
              <div className="card-title">No active jobs</div>
              <div className="card-sub">Start with a captured workload, pick an eval gate, then train only when routing and prompting cannot close the gap.</div>
            </div>
            <span className="svc-state">idle</span>
          </div>
        </div>

        <div className="card">
          <div className="card-title" style={{ marginBottom: 10 }}>Workflow</div>
          <TrainingStep title="Dataset" body="Collect task traces, remove secrets, and split train/eval examples." />
          <TrainingStep title="Gate" body="Define the acceptance metric before spending local or cloud training time." />
          <TrainingStep title="Adapter" body="Run a small adapter job, then compare against the base route and prompt-only baseline." />
        </div>
      </div>
    </>
  );
}

function TrainingStep({ title, body }: { title: string; body: string }) {
  return (
    <div className="svc">
      <span className="dot loading" />
      <div>
        <div className="svc-name">{title}</div>
        <div className="svc-desc">{body}</div>
      </div>
    </div>
  );
}
