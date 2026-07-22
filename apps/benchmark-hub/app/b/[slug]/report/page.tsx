import Link from "next/link";
import { notFound } from "next/navigation";
import { getEntry } from "@/lib/data";
import { derivePartnerReport, type PartnerArm, type PartnerReport } from "@/lib/partner-report-core";
import { PrintButton } from "@/components/print-button";

export const dynamic = "force-dynamic";

/* Formatting mirrors the CLI renderer (same derivation, same idioms). */
const pct = (f: number | null | undefined) => (f == null ? "—" : `${(f * 100).toFixed(1)}%`);
const usd = (v: number | null | undefined) =>
  v == null ? "—" : v === 0 ? "$0" : v < 0.01 ? `$${v.toFixed(5).replace(/0+$/, "").replace(/\.$/, "")}` : `$${v.toFixed(v < 1 ? 3 : 2)}`;
const ms = (v: number | null | undefined) => (v == null ? "—" : v >= 10_000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`);
const ciText = (arm: PartnerArm) => (arm.ci == null ? "—" : `[${(arm.ci.lo * 100).toFixed(1)}–${(arm.ci.hi * 100).toFixed(1)}%]`);

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="u-sec">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export default async function PartnerReportPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const entry = getEntry(slug);
  if (!entry || entry.kind !== "ok") notFound();

  let report: PartnerReport;
  try {
    report = derivePartnerReport(entry.dir);
  } catch {
    notFound();
  }

  const floorLabel: Record<string, string> = {
    null_agent: "a do-nothing agent",
    spam_agent: "a ritual tool-spamming agent",
    majority_class: "always answering the majority class",
  };
  const s = report.projected_savings;

  return (
    <div className="u-page print-report">
      {/* Print stylesheet: the report is the client-presentable artifact —
          chrome (nav, buttons, background field) drops out on paper. */}
      <style>{`
        @media print {
          .no-print, nav, .u-footer { display: none !important; }
          .u-page::before { display: none !important; }
          body, .u-page { background: #fff !important; color: #000 !important; }
          .print-report .u-tbl-scroll { max-height: none; overflow: visible; box-shadow: none; }
          .print-report a { color: inherit; text-decoration: none; }
          .print-report .u-sec { break-inside: avoid; }
        }
      `}</style>

      <header className="u-head">
        <p className="u-eyebrow no-print" style={{ marginBottom: 10 }}>
          <Link href={`/b/${slug}`}>← {report.workload.name}</Link>
        </p>
        <div className="u-title-row">
          <h1>Benchmark &amp; savings report — {report.workload.name}</h1>
          <PrintButton />
        </div>
        <p className="u-desc">
          Generated {report.generated_at} from local benchmark artifacts only (no new runs, no network). Every number is
          derived from persisted eval rows — the same derivation as <code>understudy benchmarks report</code>.
        </p>
        <p className="u-desc mono" style={{ fontSize: 11 }}>
          benchmark <code>{report.benchmark_id}</code> · {report.workload.task_count} tasks (
          {Object.entries(report.workload.split_counts).map(([k, v]) => `${k}: ${v}`).join(", ")}) · threshold {report.workload.threshold} ·
          scope: <strong>{report.workload.scope === "holdout" ? "sealed holdout rows only" : "all rows (no holdout rows exist)"}</strong>
        </p>
      </header>

      <Section title="Baselines and floors (read these first)">
        <ul>
          {report.floors.map((floor) => (
            <li key={floor.arm_kind}>
              {floor.floor === null ? (
                <>
                  <strong>{floor.arm_kind}</strong>: never run — this trivial floor is unmeasured.
                </>
              ) : (
                <>
                  <strong>{floor.arm_kind}</strong>: {floorLabel[floor.arm_kind] ?? floor.arm_kind} scores {pct(floor.floor)} (
                  {floor.passed_tasks}/{floor.task_n} tasks){floor.exceeded ? " — FLOOR EXCEEDED: some tasks are trivially satisfiable" : ""} —
                  results below are measured against that floor.
                </>
              )}
            </li>
          ))}
          <li>
            {report.incumbent != null ? (
              <>
                <strong>Incumbent ceiling</strong>: {report.incumbent.model} scores {pct(report.incumbent.quality_mean)}{" "}
                {ciText(report.incumbent)} on rerun.
              </>
            ) : (
              <>
                <strong>Incumbent ceiling</strong>: not measured in scope — no current-state baseline exists in this report.
              </>
            )}
          </li>
        </ul>
      </Section>

      <Section title="Headline results">
        <p className="exp">
          Quality is the macro-average of per-task mean scores; the 95% CI is a seeded percentile bootstrap over per-task
          means. <strong>Cost per correct task</strong> = total measured cost ÷ tasks passed at the threshold.
        </p>
        <div className="u-tbl-scroll">
          <table className="u-tbl">
            <thead>
              <tr>
                <th className="l">Arm</th>
                <th className="l">Kind</th>
                <th>Quality</th>
                <th>95% CI</th>
                <th>Cost / correct</th>
                <th>Latency</th>
                <th>Tasks</th>
                <th>Rows</th>
                <th>Passed</th>
              </tr>
            </thead>
            <tbody>
              {report.arms.map((arm) => (
                <tr key={arm.model}>
                  <td className="l">
                    {arm.model}
                    {arm.tie_group != null ? ` (tie ${String.fromCharCode(65 + arm.tie_group)})` : ""}
                  </td>
                  <td className="l">{arm.arm_kind}</td>
                  <td>{pct(arm.quality_mean)}</td>
                  <td>{ciText(arm)}</td>
                  <td>{arm.cost_per_correct_usd != null ? usd(arm.cost_per_correct_usd) : "n/a"}</td>
                  <td>{ms(arm.latency_mean_ms)}</td>
                  <td>{arm.task_n}</td>
                  <td>{arm.row_n}</td>
                  <td>{arm.passed_tasks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {report.arms
          .filter((arm) => arm.cost_per_correct_note != null)
          .map((arm) => (
            <p key={arm.model} className="u-foot-note">
              {arm.model}: {arm.cost_per_correct_note}
            </p>
          ))}
        {report.tie_note != null ? (
          <p>
            <strong>No winner is claimed.</strong> {report.tie_note}.
          </p>
        ) : report.winner_is_significant && report.best_candidate != null ? (
          <p>
            <strong>{report.best_candidate.model}</strong> leads with non-overlapping 95% CIs on the sealed holdout.
          </p>
        ) : report.best_candidate != null ? (
          <p>{report.best_candidate.model} ranks first on quality, but the ordering is not statistically separated.</p>
        ) : null}
      </Section>

      <Section title="Projected savings">
        {s != null ? (
          <>
            <p>
              <strong>EXTRAPOLATED</strong> — measured cost-per-correct-task × a stated monthly volume (
              {s.monthly_volume.toLocaleString("en-US")} tasks/month, from{" "}
              {s.volume_source === "flag" ? "the --monthly-volume flag" : "the benchmark manifest"}), not a measured bill delta.
            </p>
            <div className="u-tbl-scroll">
              <table className="u-tbl">
                <thead>
                  <tr>
                    <th className="l"></th>
                    <th>Cost / correct task</th>
                    <th>× monthly volume</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="l">Incumbent ({s.incumbent_model})</td>
                    <td>{usd(s.incumbent_cost_per_correct_usd)}</td>
                    <td>{usd(s.incumbent_cost_per_correct_usd * s.monthly_volume)}</td>
                  </tr>
                  <tr>
                    <td className="l">Candidate ({s.candidate_model})</td>
                    <td>{usd(s.candidate_cost_per_correct_usd)}</td>
                    <td>{usd(s.candidate_cost_per_correct_usd * s.monthly_volume)}</td>
                  </tr>
                  <tr>
                    <td className="l">
                      <strong>Projected monthly savings</strong>
                    </td>
                    <td></td>
                    <td>
                      <strong>
                        {usd(s.monthly_savings_usd)} ({s.savings_percent.toFixed(1)}%)
                      </strong>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p>
            Not projected. A savings projection requires a measured incumbent cost-per-correct-task, a candidate
            cost-per-correct-task, and a monthly volume (<code>--monthly-volume</code> or a <code>monthly_volume</code>{" "}
            manifest field). Whatever is missing is missing on purpose — this report does not invent numbers.
          </p>
        )}
      </Section>

      {report.failure_clusters.length > 0 && (
        <Section title="Where the best candidate fails">
          <ul>
            {report.failure_clusters.map((cluster) => (
              <li key={cluster.obligation_kind}>
                {cluster.obligation_kind}: {cluster.failing_tasks} failing task(s)
              </li>
            ))}
          </ul>
        </Section>
      )}

      {report.class_errors.length > 0 && (
        <Section title="Top per-class errors">
          <div className="u-tbl-scroll">
            <table className="u-tbl">
              <thead>
                <tr>
                  <th className="l">Arm</th>
                  <th className="l">Gold</th>
                  <th className="l">Predicted</th>
                  <th>Count</th>
                </tr>
              </thead>
              <tbody>
                {report.class_errors.map((err, i) => (
                  <tr key={i}>
                    <td className="l">{err.arm}</td>
                    <td className="l">{err.gold}</td>
                    <td className="l">{err.predicted}</td>
                    <td>{err.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      <Section title="Rigor attestation">
        {report.rigor != null ? (
          <>
            <p>
              <strong>{report.rigor.verdict}</strong> (full detail in the benchmark&apos;s rigor-report.md).
            </p>
            <ul>
              {report.rigor.items.map((item) => (
                <li key={item.item}>
                  {item.status}: {item.item} — {item.value}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p>Rigor checklist could not be derived from this directory&apos;s artifacts.</p>
        )}
      </Section>

      <Section title="Holdout governance">
        <p>{report.holdout_governance.statement}</p>
        <p className="u-foot-note">Holdout rows used for this report: {report.holdout_governance.holdout_rows_used}</p>
        <p className="u-foot-note mono">benchmark.json sha256: {report.holdout_governance.benchmark_sha256 ?? "unavailable"}</p>
        <p className="u-foot-note mono">tasks.jsonl sha256: {report.holdout_governance.tasks_sha256 ?? "unavailable"}</p>
      </Section>

      {report.experiments.length > 0 && (
        <Section title="Experiment lineage">
          <ul>
            {report.experiments.map((exp) => (
              <li key={exp.experiment_id}>
                <code>{exp.experiment_id}</code> ({exp.status}): {exp.hypothesis}
                {exp.verdict ? (
                  <>
                    {" "}
                    → <strong>{exp.verdict}</strong>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Limitations">
        <ul>
          {report.limitations.length === 0 && <li>none auto-detected (which is itself unusual — read the rigor attestation).</li>}
          {report.limitations.map((limitation, i) => (
            <li key={i}>{limitation}</li>
          ))}
        </ul>
        <p className="u-foot-note">
          Privacy: customer-identifying strings were scrubbed at generation time ({report.scrub.replacements.names} name,{" "}
          {report.scrub.replacements.emails} email, {report.scrub.replacements.urls} URL, {report.scrub.replacements.domains}{" "}
          domain replacement(s)). Aggregate metrics and task/obligation identifiers only — no prompts, no completions, no traces.
        </p>
      </Section>
    </div>
  );
}
