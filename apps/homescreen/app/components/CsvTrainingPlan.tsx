"use client";

type Props = {
  rowCount: number;
  labelCount: number | null;
  inputColumns: string[];
  labelColumn: string | null;
  groupColumn: string | null;
};

function compactColumns(columns: string[]): string {
  if (columns.length === 0) return "Choose inputs";
  if (columns.length <= 2) return columns.join(" + ");
  return `${columns[0]} + ${columns.length - 1} more`;
}

export function CsvTrainingPlan({
  rowCount,
  labelCount,
  inputColumns,
  labelColumn,
  groupColumn,
}: Props) {
  return (
    <div className="csv-training-plan" role="list" aria-label="Proposed local training plan">
      <div className="csv-training-plan-step" role="listitem">
        <span>Understand</span>
        <strong>{compactColumns(inputColumns)} → {labelColumn ?? "target"}</strong>
        <small>
          {rowCount.toLocaleString()} rows · {labelCount === null ? "choose a target" : `${labelCount.toLocaleString()} labels`}
        </small>
      </div>
      <div className="csv-training-plan-step" role="listitem">
        <span>Train</span>
        <strong>Local ModernBERT</strong>
        <small>{groupColumn ? `Keep related ${groupColumn} rows together` : "Choose a grouping field"}</small>
      </div>
      <div className="csv-training-plan-step" role="listitem">
        <span>Prove</span>
        <strong>Works across every category</strong>
        <small>Compare with a simple baseline on separate test examples</small>
      </div>
    </div>
  );
}
