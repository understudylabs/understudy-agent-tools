#!/usr/bin/env python3
"""
sim_env.py — a SIMULATED sales-intelligence environment (AutomationBench / verifiers style).

Synthetic data only — committable, no customer content. This unblocks whole-case agentic
RLM: you can't run a different model against a RECORDED env (it takes its own tool path and
there are no recordings for novel calls). A *simulated* env implements the tools against
seeded state, so ANY model can run the full loop, every tool returns a real result, and the
FINAL STATE is validated (did it write the right observations?).

Mirrors a real sales-intelligence agent workload's shape: read a sales call + graph context, extract
observations, write them back. Score = recall / precision / policy vs a gold set.

  env = SalesIntelEnv()
  result = env.run(model_fn)          # drive any model through the loop
  print(env.score())                  # recall / precision after the run

A model_fn(prompt:str) -> dict like {"action":"<tool>","input":{...}} or {"action":"done"}.
This is what an arena 'whole-case' round runs, and what rlm.py solves.
"""
import json, re

# ---------- seeded synthetic state (no customer data) ----------
DEALS = [
    {"id": "D-1", "name": "Acme Corp", "stage": "Negotiation", "owner": "sam@us", "last_activity": "2026-05-01"},
    {"id": "D-2", "name": "Globex",    "stage": "Discovery",   "owner": "lee@us", "last_activity": "2026-05-20"},
]
CATALOG = [{"sku": "PLAT", "name": "Platform"}, {"sku": "SOC2", "name": "SOC 2 Report"}, {"sku": "SSO", "name": "SSO add-on"}]
TRANSCRIPT = """[00:01] Buyer (Acme): Good news — finance approved the budget for the Platform.
[00:02] Rep: Great. Anything blocking us from signing this quarter?
[00:03] Buyer (Acme): Legal still has to review the MSA, so realistically close slips to next quarter.
[00:04] Buyer (Acme): Also, before we sign we'll need your SOC 2 report for our security team.
[00:05] Buyer (Acme): And full transparency, we're still evaluating Initech as an alternative.
[00:06] Rep: Understood. I'll get you the SOC 2 and follow up on the MSA timeline."""
# gold observations the call implies (entity, type, keywords that must appear in a good summary)
GOLD = [
    {"entity": "D-1", "type": "budget",     "keys": ["budget", "approved"]},
    {"entity": "D-1", "type": "risk",       "keys": ["legal", "next quarter"]},
    {"entity": "D-1", "type": "request",    "keys": ["soc 2"]},
    {"entity": "D-1", "type": "competitor", "keys": ["initech"]},
]
SCHEMA = "(:Deal {id,name,stage,owner,last_activity})-[:HAS_ACTIVITY]->(:Activity)\n(:Deal)-[:HAS_OBSERVATION]->(:Observation {type,summary,created_at})"

class SalesIntelEnv:
    def __init__(self):
        self.written = []          # observations the agent wrote (mutated state)
        self.calls = []            # tool-call log
        self.divergences = []      # tools we couldn't simulate

    # ---------- tool implementations (lenient, intent-based) ----------
    def _tool(self, name, inp):
        inp = inp or {}
        n = name.split("__")[-1].lower()        # tolerate mcp__common-tools__ prefixes
        if "schema" in n:
            return SCHEMA
        if "parse_vtt" in n:
            return {"participants": ["Buyer (Acme)", "Rep"], "activity_date": "2026-05-22"}
        if "lookup_catalog" in n:
            q = str(inp.get("name", "")).lower()
            return [c for c in CATALOG if q in c["name"].lower()] or CATALOG
        if any(k in n for k in ("query_graph", "load_graph_data", "retrieve_context")):
            # return deals (and any prior observations) — lenient: ignore the exact query
            return {"deals": DEALS, "observations": self.written}
        if "get_observation_history" in n:
            return self.written
        if n in ("read",) or "read" in n:
            return TRANSCRIPT        # the transcript is the file the agent reads
        if any(k in n for k in ("write_observations", "bulk_write", "upsert_context")):
            obs = inp.get("observations") or inp.get("data") or inp
            if isinstance(obs, dict): obs = [obs]
            if isinstance(obs, list):
                for o in obs:
                    if isinstance(o, dict):
                        self.written.append(o)
                return {"ok": True, "written": len(obs)}
            return {"ok": False, "error": "expected a list of observations"}
        if n in ("write", "edit", "taskcreate", "taskupdate", "bash"):
            return {"ok": True}
        self.divergences.append(name)
        return {"error": f"tool '{name}' is not available in this environment"}

    def call(self, name, inp):
        self.calls.append(name)
        return self._tool(name, inp)

    # ---------- the agentic loop ----------
    TASK = ("A sales call just happened for deal D-1 (Acme Corp). "
            "Read the call transcript, extract the key observations (budget, risks, requests, competitor mentions), "
            "and write them to the graph by calling write_observations with a list of "
            "{entity, type, summary} objects. Then reply done. Use one tool per step.")
    TOOLS = ["load_graph_schema", "query_graph_database", "parse_vtt_participants",
             "retrieve_context_from_relational_database", "lookup_catalog_items",
             "Read(file_path) -> the call transcript", "write_observations(observations:[{entity,type,summary}])"]

    def run(self, model_fn, budget=10, on_step=None):
        scratch = []
        for step in range(1, budget + 1):
            prompt = (f"{self.TASK}\n\nTOOLS (pick ONE per step):\n- " + "\n- ".join(self.TOOLS) +
                      f"\n\nNOTES SO FAR:\n{chr(10).join(scratch) or '(none)'}\n\n"
                      'Reply with ONE JSON object: {"action":"<tool>","input":{...}} or {"action":"done"}.')
            d = model_fn(prompt)
            act = (d or {}).get("action", "done")
            if on_step: on_step(step, d)
            if act == "done":
                return {"steps": step - 1, "calls": self.calls, "diverged": self.divergences}
            res = self.call(act, d.get("input"))
            s = json.dumps(res)
            scratch.append(f"step {step}: {act} -> {s[:300]}")
        return {"steps": budget, "calls": self.calls, "diverged": self.divergences}

    # ---------- final-state validator ----------
    def score(self):
        def matches(o, g):
            if str(o.get("entity", "")).upper().replace("ACME", "D-1") not in (g["entity"], "D-1"):
                # be lenient on entity (accept name or id)
                if "acme" not in json.dumps(o).lower() and g["entity"] not in json.dumps(o).lower():
                    return False
            text = json.dumps(o).lower()
            return all(k in text for k in g["keys"])
        matched = 0
        for g in GOLD:
            if any(matches(o, g) for o in self.written):
                matched += 1
        recall = matched / len(GOLD)
        precision = matched / max(1, len(self.written))
        return {"gold": len(GOLD), "written": len(self.written), "matched": matched,
                "recall": round(recall, 2), "precision": round(precision, 2),
                "f1": round(2 * recall * precision / max(1e-9, recall + precision), 2)}

# ---------- a scripted ORACLE agent (to verify env + scorer mechanics) ----------
def oracle_model_fn():
    script = [
        {"action": "Read", "input": {"file_path": "/workspace/transcript.vtt"}},
        {"action": "write_observations", "input": {"observations": [
            {"entity": "D-1", "type": "budget",     "summary": "Finance approved the budget for the Platform"},
            {"entity": "D-1", "type": "risk",       "summary": "Legal MSA review slips close to next quarter"},
            {"entity": "D-1", "type": "request",    "summary": "Buyer needs the SOC 2 report before signing"},
            {"entity": "D-1", "type": "competitor", "summary": "Acme is still evaluating Initech"},
        ]}},
        {"action": "done"},
    ]
    it = iter(script)
    return lambda prompt: next(it, {"action": "done"})

if __name__ == "__main__":
    env = SalesIntelEnv()
    env.run(oracle_model_fn(), on_step=lambda s, d: print(f"  step {s}: {d.get('action')}"))
    print("score (oracle):", env.score())
