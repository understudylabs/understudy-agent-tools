/**
 * Designed empty state: one sentence of what this is + one concrete next
 * action rendered in mono. `done` renders the all-reviewed/success variant.
 */
export function EmptyState({
  what,
  next,
  done,
}: {
  what: React.ReactNode;
  next?: React.ReactNode;
  done?: boolean;
}) {
  return (
    <div className={"u-empty" + (done ? " done" : "")}>
      <p className="what">{what}</p>
      {next && <span className="next">{next}</span>}
    </div>
  );
}
