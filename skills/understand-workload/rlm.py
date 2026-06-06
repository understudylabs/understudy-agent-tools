#!/usr/bin/env python3
"""
rlm.py — a Recursive Language Model loop (the decomposition harness).

The teacher does one giant agentic prompt: ~25 tool declarations + a context that
compounds to ~60k+ tokens as raw tool_results pile up (see replay.py). A small model
drowns in that. The RLM swap keeps context SMALL by construction:

  state = { task, scratchpad (short notes), step_no }
  loop until done or budget:
    1. show the model ONLY: the task + a TOOL SUBSET for this step + the short scratchpad
    2. model proposes ONE next action (a tool call) or 'done'
    3. execute it (against replay.RecordedEnv, or live tools)
    4. SUMMARIZE the (possibly 24k-token) result into a few lines -> append to scratchpad
       (the raw result never enters the next prompt)
    5. step_no += 1
  the 'recursive' part: a step may itself be 'spawn a sub-RLM on sub-task X' (like the
  teacher's Agent sub-agents) — a fresh small-context loop whose summary returns.

What it measures vs the teacher (replay.py recorded trajectory):
  - decomposition_factor = small-model steps / teacher steps to reach the same final state
  - peak context tokens (RLM stays ~flat; teacher grows ~linearly)
  - cost/latency at parity

This is a SKELETON: wire `model_fn` and `summarize_fn` to a real endpoint (MLX local or
the Understudy gateway). It runs against replay.RecordedEnv so no live side-effects fire.
Local-only: operates on captured customer data.
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from replay import load_case, RecordedEnv, _tok

STEP_PROMPT = """You are solving one step of a larger task. Do the SMALLEST next action.

TASK:
{task}

NOTES SO FAR (what previous steps found):
{scratchpad}

TOOLS YOU MAY CALL THIS STEP (pick at most one):
{tools}

Reply with ONE JSON object only:
  {{"action": "<tool_name>", "input": {{...}}, "why": "<one line>"}}
  or {{"action": "done", "answer": "<final result>"}} when the task is complete.
"""

def default_tool_subset(case, scratchpad, step_no):
    """Pick the few tools plausibly relevant to this step (keeps the prompt small).
    Stub: name + 1-line purpose for every tool. Replace with a real relevance filter
    (e.g. embeddings over tool descriptions, or a cheap router call)."""
    out = []
    for t in case["tools"]:
        desc = (t.get("description","") or "").split(".")[0][:60]
        out.append(f'- {t["name"]}: {desc}')
    return "\n".join(out)

def naive_summarize(result, model_fn=None, cap=400):
    """Compress a tool result to a few hundred chars. Replace with a model_fn call that
    extracts only the fields the task needs (this is where recall is won or lost)."""
    s = result if isinstance(result, str) else json.dumps(result)
    return s[:cap] + (f" …[+{len(s)-cap} chars elided]" if len(s) > cap else "")

def rlm_solve(case, model_fn, summarize_fn=naive_summarize, tool_subset_fn=default_tool_subset,
              budget_steps=20, on_step=None):
    """Drive a small model through the task as bounded steps against the recorded env."""
    env = RecordedEnv(case)
    task = "\n".join(b.get("text","") for m in case["initial"]
                     for b in (m["content"] if isinstance(m["content"], list) else [{"text": m["content"]}]))
    scratch, trajectory, prompt_tok = [], [], 0
    for step in range(1, budget_steps + 1):
        tools = tool_subset_fn(case, scratch, step)
        prompt = STEP_PROMPT.format(task=task[:4000], scratchpad="\n".join(scratch) or "(nothing yet)", tools=tools)
        prompt_tok += _tok(prompt)
        decision = model_fn(prompt)            # -> dict {"action":..., "input":..., "answer":...}
        if on_step: on_step(step, decision, len(scratch))
        action = decision.get("action")
        if action == "done":
            return {"solved": True, "steps": step - 1, "trajectory": trajectory,
                    "peak_prompt_tok": prompt_tok // max(1, step), "diverged": env.divergences,
                    "answer": decision.get("answer")}
        result, ok = env.call(action, decision.get("input"))
        trajectory.append((action, ok))
        scratch.append(f"step {step}: {action} -> {summarize_fn(result)}")
    return {"solved": False, "steps": budget_steps, "trajectory": trajectory,
            "peak_prompt_tok": prompt_tok // budget_steps, "diverged": env.divergences}

# --- example model_fn wiring (fill in to actually run) ---
def mlx_model_fn(base="http://127.0.0.1:8081/v1", model="mlx-community/gemma-3-1b-it-4bit"):
    """Returns a model_fn that asks a local MLX model for the next-step JSON."""
    from openai import OpenAI
    import re as _re
    client = OpenAI(base_url=base, api_key="mlx")
    def _extract_json(txt):
        # strip reasoning + code fences, then scan for the first balanced {...}
        txt = _re.sub(r"<think>.*?</think>", "", txt, flags=_re.S)
        txt = txt.replace("```json", "").replace("```", "")
        i = txt.find("{")
        while i != -1:
            depth = 0
            for j in range(i, len(txt)):
                if txt[j] == "{": depth += 1
                elif txt[j] == "}":
                    depth -= 1
                    if depth == 0:
                        try: return json.loads(txt[i:j+1])
                        except Exception: break
            i = txt.find("{", i+1)
        return None
    def fn(prompt):
        r = client.chat.completions.create(model=model, max_tokens=700, temperature=0,
                                            messages=[{"role":"user","content":prompt}])
        d = _extract_json(r.choices[0].message.content or "")
        return d if isinstance(d, dict) and "action" in d else {"action": "done"}
    return fn

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(2)
    case = load_case(sys.argv[1])
    print(f"teacher: {len(case['steps'])} steps, fixed overhead ~{case['fixed_tok']:,} tok, "
          f"context grows to ~{case['fixed_tok'] + sum(_tok(json.dumps(s['result'])) for s in case['steps']):,} tok")
    print("RLM target: same final state in a bounded loop with ~flat, small context.")
    print("To run a candidate:  rlm_solve(case, mlx_model_fn())  — wire a real summarize_fn for recall.")
