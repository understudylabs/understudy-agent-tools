#!/usr/bin/env python3
"""
replay.py — turn a captured agent case into a REPLAYABLE ENVIRONMENT so you can
try OTHER models against the same looped inputs/outputs.

Every captured request carries the full message history, and every tool the agent
called has its result RECORDED in that history. So one completed case = a recorded
environment: the initial task, the system prompt, the tool declarations, and an
ordered list of (tool_use -> recorded tool_result) steps. You can:

  - replay_recorded(): print the ground-truth trajectory the teacher (e.g. Opus) took.
  - drive(model_fn): feed the SAME task to a candidate model; when it calls a tool we
    have a recording for, serve the recorded result; loop until it stops or diverges.
    Compare its trajectory / final action to the teacher's.

This is local-only tooling: captures contain customer data. Display is redaction-safe
(sizes, not content); the recorded results are held in memory only to serve a model
under test, never printed.

Usage:
  replay.py <case.jsonl>                 # show the recorded trajectory (ground truth)
  replay.py <case.jsonl> --json          # dump the replayable case structure (redacted)
"""
import json, sys, os

def load_envelope(path):
    raw = open(path).read().strip()
    try: o = json.loads(raw)
    except json.JSONDecodeError: o = json.loads(raw.splitlines()[0])
    req = o.get("customer_request_body", o)
    if isinstance(req, str): req = json.loads(req)
    return o, req

def _tok(s): return len(s) // 4

def load_case(path):
    """Parse a completed capture into a replayable case (initial task + recorded steps)."""
    env, req = load_envelope(path)
    msgs = req.get("messages", [])
    # initial task = the leading user message(s) before the first assistant turn
    initial, i = [], 0
    while i < len(msgs) and msgs[i]["role"] == "user":
        initial.append(msgs[i]); i += 1
    # recorded steps: each assistant tool_use paired with the next user tool_result
    steps, pending = [], []
    for m in msgs[i:]:
        c = m.get("content")
        if m["role"] == "assistant" and isinstance(c, list):
            for b in c:
                if b.get("type") == "tool_use":
                    pending.append({"name": b.get("name"), "input": b.get("input", {}), "result": None})
        elif m["role"] == "user" and isinstance(c, list):
            results = [b for b in c if b.get("type") == "tool_result"]
            for p, r in zip(pending, results):
                p["result"] = r.get("content")
            steps.extend(pending); pending = []
    return {
        "model": req.get("model"), "system": req.get("system"),
        "tools": req.get("tools", []), "params": {k: req.get(k) for k in ("max_tokens","thinking","output_config")},
        "initial": initial, "steps": steps,
        "fixed_tok": _tok(json.dumps(req.get("tools", []))) + _tok(req.get("system","") if isinstance(req.get("system"),str) else json.dumps(req.get("system",""))),
    }

class RecordedEnv:
    """Serves recorded tool_results to a model under test. Matches by tool name, in order;
    falls back to name-only. Reports a DIVERGENCE if the model calls a tool we never recorded."""
    def __init__(self, case):
        self.steps = case["steps"]; self.idx = 0
        self.by_name = {}
        for s in self.steps:
            self.by_name.setdefault(s["name"], []).append(s["result"])
        self._used = {}
        self.divergences = []
    def call(self, name, _input=None):
        # in-order match first
        if self.idx < len(self.steps) and self.steps[self.idx]["name"] == name:
            r = self.steps[self.idx]["result"]; self.idx += 1; return r, True
        # name-only fallback
        seen = self._used.get(name, 0)
        if name in self.by_name and seen < len(self.by_name[name]):
            self._used[name] = seen + 1; return self.by_name[name][seen], True
        self.divergences.append(name)
        return f"[no recorded result for tool '{name}' — model diverged from the teacher trajectory]", False

def replay_recorded(case):
    print(f"# Recorded environment  ·  teacher model: {case['model']}")
    print(f"  fixed system+tools overhead: ~{case['fixed_tok']:,} tok/turn")
    it = sum(_tok(b.get("text","")) for m in case["initial"] for b in (m["content"] if isinstance(m["content"],list) else [{'text':m['content']}]))
    print(f"  initial task: ~{it:,} tok\n  recorded steps (teacher trajectory):")
    ctx = it
    for n, s in enumerate(case["steps"], 1):
        rtok = _tok(json.dumps(s["result"])) if s["result"] is not None else 0
        ctx += rtok
        print(f"   {n:>2}. CALL {s['name']:<26} → recorded result ~{rtok:>6,} tok   (context now ~{case['fixed_tok']+ctx:,})")
    print(f"\n  total steps: {len(case['steps'])}  ·  final context ~{case['fixed_tok']+ctx:,} tok")

def drive(case, model_fn, max_turns=12):
    """Feed the task to a candidate model; serve recorded tool_results; track the trajectory.
    model_fn(messages, system, tools) -> dict like {'text':..., 'tool_calls':[{'name','input'}], 'stop':bool}.
    Returns {trajectory, matched, diverged, reached_end}."""
    env = RecordedEnv(case)
    messages = [dict(m) for m in case["initial"]]
    traj, matched = [], 0
    for _ in range(max_turns):
        out = model_fn(messages, case["system"], case["tools"])
        calls = out.get("tool_calls") or []
        if not calls or out.get("stop"):
            return {"trajectory": traj, "matched": matched, "diverged": env.divergences,
                    "reached_end": True, "turns": len(traj)}
        messages.append({"role": "assistant", "content": [{"type":"tool_use","name":c["name"],"input":c.get("input",{})} for c in calls]})
        results = []
        for c in calls:
            r, ok = env.call(c["name"], c.get("input"))
            matched += int(ok); traj.append((c["name"], ok))
            results.append({"type":"tool_result","content": r})
        messages.append({"role":"user","content":results})
    return {"trajectory": traj, "matched": matched, "diverged": env.divergences, "reached_end": False, "turns": len(traj)}

if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args: print(__doc__); sys.exit(2)
    case = load_case(args[0])
    if "--json" in sys.argv:
        red = {"model": case["model"], "fixed_tok": case["fixed_tok"],
               "n_steps": len(case["steps"]),
               "trajectory": [s["name"] for s in case["steps"]],
               "result_tokens": [(_tok(json.dumps(s["result"])) if s["result"] else 0) for s in case["steps"]]}
        print(json.dumps(red, indent=2))
    else:
        replay_recorded(case)
