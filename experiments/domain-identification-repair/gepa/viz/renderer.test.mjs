// Provider-free renderer assertions for the surgical white-active convention.
// Run: node renderer.test.mjs
import assert from "node:assert";
import {
  visualStateOf, backgroundClassOf, backgroundColorOf, BG,
  ACTIVE_STATUSES, SUCCESS_STATUSES, FAILURE_STATUSES,
} from "./renderer.mjs";

let n = 0;
const ok = (name, cond) => { assert.ok(cond, `FAIL: ${name}`); console.log(`  ok: ${name}`); n++; };

// queued keeps the existing (idle) background — never white, never green/red.
ok("queued -> idle background", visualStateOf({ status: "queued" }) === "idle");
ok("idle background is the existing neutral, not white/green/red",
   BG.idle !== BG.active && BG.idle !== BG.success && BG.idle !== BG.failure);

// Every active status -> white.
for (const s of ACTIVE_STATUSES) {
  ok(`active status '${s}' -> white`,
     visualStateOf({ status: s }) === "active" && backgroundColorOf({ status: s }) === "#ffffff");
}

// Upstream 'started' maps to running -> active/white.
ok("upstream 'started' -> active/white", visualStateOf({ status: "started" }) === "active");

// Terminal success -> green; terminal failure -> red.
for (const s of SUCCESS_STATUSES) {
  ok(`terminal '${s}' -> green`, backgroundColorOf({ status: s }) === "#16a34a");
}
for (const s of FAILURE_STATUSES) {
  ok(`terminal '${s}' -> red`, backgroundColorOf({ status: s }) === "#dc2626");
}

// No cyan anywhere in the palette.
ok("no cyan in palette", !Object.values(BG).some(c => /cyan|#0ff|#00ffff/i.test(c)));

// backgroundClassOf emits a stable, state-specific class (identity preserved by
// caller; class only encodes the background state).
ok("active class", backgroundClassOf("active") === "exp-node exp-node--active");
ok("success class", backgroundClassOf("success") === "exp-node exp-node--success");
ok("failure class", backgroundClassOf("failure") === "exp-node exp-node--failure");

// Injected active -> terminal transition sequence for one node (identity fixed):
// queued -> screening(white) -> reflecting(white) -> evaluating(white) ->
// confirming(white) -> completed(green). A separate branch ends failed(red).
function transition(node_id, statuses) {
  const seen = [];
  for (const status of statuses) {
    const node = { node_id, status };          // SAME node_id throughout
    seen.push(visualStateOf(node));
  }
  return seen;
}
const promoted = transition("wave2-branchA",
  ["queued", "screening", "reflecting", "evaluating", "confirming", "completed"]);
ok("promoted branch transition idle->active(x4)->success",
   JSON.stringify(promoted) === JSON.stringify(
     ["idle", "active", "active", "active", "active", "success"]));
const failed = transition("wave2-branchB",
  ["queued", "screening", "reflecting", "failed"]);
ok("failed branch transition idle->active->active->failure",
   JSON.stringify(failed) === JSON.stringify(["idle", "active", "active", "failure"]));

// In-progress must never be shown as green/red before finalizing.
ok("in-progress confirming is not success/failure",
   ["success", "failure"].indexOf(visualStateOf({ status: "confirming" })) === -1);

console.log(`\nALL ${n} RENDERER ASSERTIONS PASSED`);
