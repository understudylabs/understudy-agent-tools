// Pure logic for the workload Configuration pane. Faithful port of the web
// control plane's override-state derivation
// (apps/web/app/p/[project_slug]/_components/override-state.ts) and the
// route-save validation that lived in the `applyWorkloadRoutingAction`
// server action (apps/web/app/p/[project_slug]/routing/actions.ts). On
// desktop the server action becomes a client-side plan step; keeping the
// validation here (plus a mirror check in the Tauri command) preserves the
// routed-% invariants the server action used to enforce.

/** Sentinel for selects — Radix/base-ui Select can't carry a null value. */
export const PRIMARY = "__primary__";

/**
 * Derives the human-facing override state of a workload from its stored
 * routing columns. Mirrors `chooseTarget(workload, hash)` in the gateway's
 * route pipeline:
 *
 *   - `primary`  — no deployment configured; passthrough.
 *   - `override` — model configured and pct >= 100; full cutover.
 *   - `split`    — model configured and 0 < pct < 100.
 *   - `hold`     — model configured but pct <= 0; pointer kept, all
 *                  traffic serves primary (clean rollback that preserves
 *                  the model selection).
 *
 * Configured intent, not observed delivery.
 */
export function deriveOverrideState(workload) {
  const modelId = workload.route_model_id ?? null;
  const pct = workload.route_traffic_pct;
  const configured =
    (workload.route_deployment_id ?? null) !== null || modelId !== null;

  if (!configured) {
    return { kind: "primary", modelId: null, trafficPct: pct };
  }
  if (pct <= 0) {
    return { kind: "hold", modelId, trafficPct: pct };
  }
  if (pct >= 100) {
    return { kind: "override", modelId, trafficPct: pct };
  }
  return { kind: "split", modelId, trafficPct: pct };
}

/**
 * Validation ported from `applyWorkloadRoutingAction`: traffic must be a
 * whole number 0–100. Returns `{ ok: true, pct }` or `{ ok: false, error }`.
 */
export function validateTrafficPct(value) {
  const pct = typeof value === "number" ? value : Number(value);
  if (
    typeof value === "string" && value.trim() === "" ||
    !Number.isInteger(pct) ||
    pct < 0 ||
    pct > 100
  ) {
    return { ok: false, error: "Traffic must be a whole number from 0 to 100." };
  }
  return { ok: true, pct };
}

/**
 * Plan a route save. Mirrors the web RouteEditor's save() + the server
 * action's body construction: `model_id` is tri-state on the wire —
 * omitted leaves the route untouched, so it is only included when the
 * selection actually changed; `route_traffic_pct` is always sent.
 *
 * Returns:
 *   { ok: false, error }                      — invalid input
 *   { ok: true, dirty: false }                — nothing to save
 *   { ok: true, dirty: true, body }           — PATCH body to send
 */
export function planRouteSave({ workload, selectedModel, trafficPct }) {
  if (selectedModel === PRIMARY) {
    // The web UI disables Save for primary; rollback is its own action.
    return { ok: false, error: "Pick a model, or use Roll back to primary." };
  }
  const parsed = validateTrafficPct(trafficPct);
  if (!parsed.ok) return parsed;

  const currentModel = workload.route_model_id ?? PRIMARY;
  const modelChanged = selectedModel !== currentModel;
  const pctChanged = parsed.pct !== workload.route_traffic_pct;
  if (!modelChanged && !pctChanged) return { ok: true, dirty: false };

  const body = { route_traffic_pct: parsed.pct };
  if (modelChanged) body.model_id = selectedModel;
  return { ok: true, dirty: true, body };
}

/**
 * Roll back to primary: clear the route. The admin API resets
 * route_model_id, route_deployment_id, and route_traffic_pct in one PATCH.
 */
export function planRollback() {
  return { model_id: null };
}

/**
 * Default traffic % shown in the editor. New routes default to a full
 * cutover (100%) — matches the route endpoint's own default rather than
 * the D1 column default of 5.
 */
export function initialTrafficPct(workload) {
  return workload.route_model_id !== null ? workload.route_traffic_pct : 100;
}

/** The "after save" preview line, ported verbatim from the web RouteEditor. */
export function afterSaveLabel(selectedModel, parsedPct) {
  if (selectedModel === PRIMARY) {
    return "primary — the model your code sends";
  }
  if (parsedPct >= 100) return `${selectedModel} @ 100%`;
  if (parsedPct <= 0) return `${selectedModel} held @ 0% (serving primary)`;
  return `${selectedModel} @ ${parsedPct}%; ${100 - parsedPct}% stays on primary`;
}
