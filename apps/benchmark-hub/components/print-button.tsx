"use client";

/** Print/save-as-PDF trigger for the client-presentable partner report. */
export function PrintButton() {
  return (
    <button
      type="button"
      className="u-chip no-print"
      onClick={() => window.print()}
      style={{ cursor: "pointer" }}
    >
      Print / save PDF
    </button>
  );
}
