const SMALL_MODEL_MARKERS = ["understudy-small", "e2b"];

export function modelMemoryWarning(modelId, modelMemoryGb, residencyBudgetGb) {
  const normalized = modelId.toLowerCase();
  if (SMALL_MODEL_MARKERS.some((marker) => normalized.includes(marker))) return null;
  if (!Number.isFinite(modelMemoryGb) || modelMemoryGb < 6) return null;

  const memory = modelMemoryGb.toFixed(1);
  if (
    residencyBudgetGb != null &&
    Number.isFinite(residencyBudgetGb) &&
    residencyBudgetGb > 0 &&
    modelMemoryGb > residencyBudgetGb
  ) {
    return `Heavy for this Mac: ~${memory} GB model memory exceeds the ${residencyBudgetGb.toFixed(1)} GB residency budget. Preparing it may stop other models or fail.`;
  }
  return `Large local model: ~${memory} GB model memory. Preparing it may cool other warm models; the smallest certified rung is the safer default on constrained Macs.`;
}
