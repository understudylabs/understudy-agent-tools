import Link from "next/link";

const DIRECTIONS = [
  {
    href: "/map",
    title: "Concept map",
    color: "var(--model-violet)",
    body: "Every session as a point in space. Clusters are the tasks you repeat — the future home of personalized benchmarks.",
  },
  {
    href: "/river",
    title: "History river",
    color: "var(--model-cyan)",
    body: "Your work over time — sessions, harnesses, models, tokens — as a navigable temporal landscape.",
  },
  {
    href: "/anatomy",
    title: "Trace anatomy",
    color: "var(--model-mint)",
    body: "One session dissected: turns, tool calls, reasoning, tokens — a flow, not a chat log.",
  },
  {
    href: "/leaderboard",
    title: "Benchmark overlay",
    color: "var(--model-amber)",
    body: "Task clusters colored by which open-weight model wins them. The recommendation surface itself.",
  },
];

export default function Home() {
  return (
    <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-4 p-6 max-w-5xl mx-auto w-full content-center">
      {DIRECTIONS.map((d) => (
        <Link
          key={d.href}
          href={d.href}
          className="group rounded-[16px] border border-rule bg-card p-6 hover:bg-hover transition-colors"
        >
          <div className="flex items-center gap-3">
            <span
              className="inline-block size-2.5 rounded-full breath"
              style={{ background: d.color }}
            />
            <h2 className="mono text-sm text-ink-bright">{d.title}</h2>
          </div>
          <p className="mt-3 text-sm text-ink-muted leading-relaxed">{d.body}</p>
        </Link>
      ))}
      <p className="md:col-span-2 mono text-xs text-ink-muted text-center mt-4">
        four directions, real local data, read-only · pick one to go deep
      </p>
    </div>
  );
}
