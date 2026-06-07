"""Faithful live-rollout GEPA for the AutomationBench `simple` system prompt.

Student rollouts run locally (free) via auto-bench --toolset limited_zapier.
Reflection = Opus 4.8 (BYO) with a hard spend cap. Train/dev only; holdout sealed.
"""
from __future__ import annotations
import json, os, subprocess, sys, tempfile, time
from dataclasses import dataclass
import gepa
from gepa.core.adapter import GEPAAdapter, EvaluationBatch
import anthropic

ROOT = "/Users/luis/Developer/understudy/testing-environments/AutomationBench"
EV = f"{ROOT}/.understudy/capture-evidence"
LOCAL_MODEL = "/Users/luis/.understudy/models/gemma-4-e2b-it-mlx-vlm-4bit"
BASE_URL = "http://127.0.0.1:8081/v1"
REFLECT_MODEL = "claude-opus-4-8"
SPEND_CAP_USD = 2.8
IN_C, OUT_C = 5e-6, 25e-6  # opus 4.x per-token

splits = json.load(open(f"{EV}/splits.json"))
TRAIN = splits["train"]["rows"]
DEV = splits["dev"]["rows"]
DEFAULT_PROMPT = (
    "You are a workflow automation agent. Execute the requested task using the available tools.\n"
    "- Do not ask clarifying questions. Take action instead.\n"
    "- Referenced data (spreadsheets, policies, guidelines, rosters) exists in the simulated "
    "environment — discover it by searching email, listing spreadsheets, querying calendars, etc. "
    "If the prompt says 'our current X policy' or 'the Y guidelines,' search for it.\n"
    "- Never respond with a list of missing information."
)

def run_rollouts(prompt: str, tasks: list[str]) -> dict:
    """Run auto-bench on exactly `tasks` with the candidate prompt injected. Returns {name: rec}."""
    env = dict(os.environ); env["AB_SIMPLE_SYSTEM_PROMPT"] = prompt
    with tempfile.NamedTemporaryFile("r", suffix=".json", delete=False) as tf:
        out = tf.name
    cmd = ["uv", "run", "auto-bench", "--model", LOCAL_MODEL, "--base-url", BASE_URL,
           "--api-key", "local", "--api", "chat_completions", "--domains", "simple",
           "--toolset", "limited_zapier", "--tasks", ",".join(tasks), "--max-steps", "30",
           "--max-concurrent", "4", "--input-cost", "0", "--output-cost", "0",
           "--export-json", out]
    subprocess.run(cmd, cwd=ROOT, env=env, capture_output=True, text=True, timeout=900)
    recs = {}
    try:
        for r in json.load(open(out))["tasks"]:
            recs[r["name"]] = r
    except Exception:
        pass
    os.unlink(out)
    return recs

def diagnose(rec: dict) -> str:
    """Natural-language feedback tied to the failing rollout step."""
    if rec is None:
        return "Rollout failed to run (no output). The agent may have returned an empty response; instruct it to always call a tool or state a result."
    if rec.get("passed"):
        return "PASS: final state correct."
    msgs = rec.get("messages", [])
    last = next((m for m in reversed(msgs) if m.get("role") == "assistant"), {})
    txt = (last.get("content") or "").lower()
    toolresults = " ".join(str(m.get("content", "")) for m in msgs if m.get("role") == "tool").lower()
    if any(m.get("role") == "assistant" and not m.get("content") and not m.get("tool_calls") for m in msgs):
        return "FAIL: agent emitted an empty turn (no content, no tool call). Instruct it to never end a turn empty — always call a tool or state the completed result."
    if "no handler" in toolresults or "404" in toolresults:
        return "FAIL: called an endpoint from the WRONG app (404/no handler). Instruct it to verify the endpoint's service matches the app named in the task before calling, and to re-search with a more specific query if the app is wrong."
    if any(w in txt for w in ("unable", "could not find", "no suitable", "cannot find", "not able")):
        return "FAIL: agent gave up early without completing the write. Instruct it to persist across multiple steps and keep refining its search until the target record is actually updated."
    ar = rec.get("assertion_results") or []
    miss = [a for a in ar if not (a.get("passed", True))]
    if miss:
        d = miss[0].get("description") or miss[0].get("name") or "a required assertion"
        return f"FAIL: final state missing required change — {d}. Instruct the agent to complete the specific write the task asks for and verify it before finishing."
    return "FAIL: task not completed correctly; required final-state change is missing. Be explicit about completing and verifying the requested write."

class ABAdapter(GEPAAdapter):
    def evaluate(self, batch, candidate, capture_traces=False):
        prompt = candidate["system_prompt"]
        recs = run_rollouts(prompt, list(batch))
        scores, outputs, trajs = [], [], []
        for name in batch:
            rec = recs.get(name)
            sc = float(rec.get("score", 0.0)) if rec else 0.0
            scores.append(sc)
            outputs.append({"name": name, "passed": bool(rec and rec.get("passed")), "score": sc})
            trajs.append({"name": name, "task": (rec or {}).get("messages", [{}, {}])[1].get("content", name)
                          if rec else name, "feedback": diagnose(rec), "score": sc})
        return EvaluationBatch(outputs=outputs, scores=scores,
                               trajectories=trajs if capture_traces else None, objective_scores=None)

    def make_reflective_dataset(self, candidate, eval_batch, components_to_update):
        items = []
        for tr in (eval_batch.trajectories or []):
            items.append({
                "Inputs": str(tr.get("task"))[:600],
                "Generated Outputs": f"score={tr['score']:.2f} passed={tr['score']>=1.0}",
                "Feedback": tr["feedback"],
            })
        return {c: items for c in components_to_update}

# --- reflection LM: Opus with spend cap ---
_client = anthropic.Anthropic()
_spend = {"in": 0, "out": 0, "calls": 0}
def reflect(prompt: str) -> str:
    if _spend["in"] * IN_C + _spend["out"] * OUT_C > SPEND_CAP_USD:
        # budget exhausted: return the prompt unchanged-ish to let GEPA wind down
        return prompt
    r = _client.messages.create(model=REFLECT_MODEL, max_tokens=1500,
                                messages=[{"role": "user", "content": prompt}])
    _spend["in"] += r.usage.input_tokens; _spend["out"] += r.usage.output_tokens; _spend["calls"] += 1
    print(f"[reflect #{_spend['calls']}] spend=${_spend['in']*IN_C+_spend['out']*OUT_C:.3f}", file=sys.stderr)
    return "".join(b.text for b in r.content if getattr(b, "type", "") == "text")

if __name__ == "__main__":
    budget = int(os.environ.get("GEPA_MAX_METRIC_CALLS", "150"))
    t0 = time.time()
    result = gepa.optimize(
        seed_candidate={"system_prompt": DEFAULT_PROMPT},
        trainset=TRAIN, valset=DEV, adapter=ABAdapter(),
        reflection_lm=reflect, max_metric_calls=budget, reflection_minibatch_size=3,
        display_progress_bar=False,
    )
    best = result.best_candidate["system_prompt"]
    out = {"best_system_prompt": best,
           "val_score": getattr(result, "val_aggregate_scores", None),
           "reflect_calls": _spend["calls"],
           "reflect_spend_usd": round(_spend["in"]*IN_C + _spend["out"]*OUT_C, 3),
           "elapsed_s": round(time.time()-t0, 1)}
    json.dump(out, open(f"{EV}/gepa-result.json", "w"), indent=2)
    print(json.dumps({k: v for k, v in out.items() if k != "best_system_prompt"}))
    print("---BEST PROMPT---"); print(best)
