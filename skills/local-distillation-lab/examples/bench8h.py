"""Local pedagogical-distillation bench on REAL Gemma-4 (mlx-vlm) — 8h, all local.

Student = gemma-4-e2b mlx-vlm snapshot (trained via kernel #2 mlx-vlm).
Teacher / STaR samples via :8081 router. Eval via mlx_vlm.generate.
Arms B/S/O/P with eval-checkpointed learning curves (sample-efficiency).
Expanded advisor data (simple train/dev + held-out sales OOD). Budgeted + checkpointed.
"""
from __future__ import annotations
import json, math, os, re, sys, time, traceback, urllib.request
from pathlib import Path
import mlx.core as mx, mlx.nn as nn, mlx.optimizers as optim
from mlx.utils import tree_flatten
from mlx_vlm import load as vlm_load, generate as vlm_generate
from mlx_lm.tuner.utils import linear_to_lora_layers

ROOT = Path("/Users/luis/Developer/understudy/testing-environments/AutomationBench")
EV = ROOT / ".understudy/capture-evidence"
PED = Path("/Users/luis/Developer/understudy/worktrees/pedagogical-rl/src"); sys.path.insert(0, str(PED))
from understudy_agent.pedagogical_reward import g_spike, SpikeRewardConfig
ENDPOINT = "http://127.0.0.1:8081/v1/chat/completions"
RUN = EV / "bench8h-g4"; RUN.mkdir(parents=True, exist_ok=True)
SMOKE = "--smoke" in sys.argv
BUDGET_S = 1000 if SMOKE else int(os.environ.get("BENCH_BUDGET_S", 8 * 3600))
T0 = time.time(); CFG = SpikeRewardConfig()
STUDENT = "/Users/luis/.understudy/models/gemma-4-e2b-it-mlx-vlm-4bit"
STUDENT_SERVE = STUDENT
TEACHER_SERVE = STUDENT  # privileged SELF-teacher (E2B + ICL gold); robust + OPSD/SDFT-faithful

# ---- data: expanded advisor (simple train/dev + held-out sales OOD) ----
allrows = json.load(open(EV / "advisor-all-domains.json"))
catalog = json.load(open(EV / "tool-catalog.json"))
simple = [r for r in allrows if r["domain"] == "simple"]; sales = [r for r in allrows if r["domain"] == "sales"]
TRAIN, DEV, OOD = simple[:140], simple[140:170], sales[:30]
if SMOKE: TRAIN, DEV, OOD = simple[:6], simple[140:143], sales[:2]
apps = {t.split("_")[0] for r in (TRAIN + DEV + OOD) for t in r["gold_tools"]}
RCAT = [t for t in catalog if t["name"].split("_")[0] in apps]; RNAMES = {t["name"] for t in RCAT}
CAT = "\n".join(f"- {t['name']}: {t['description']}" for t in RCAT)
ICL = "\n".join(f'TASK: {r["instruction"][:140]}\nTOOLS: {json.dumps(r["gold_tools"])}' for r in TRAIN[:3])

def log(m):
    line = f"[{time.strftime('%H:%M:%S')} +{(time.time()-T0)/60:.0f}m] {m}"
    print(line, flush=True); open(RUN / "progress.log", "a").write(line + "\n")
def budget_left(): return BUDGET_S - (time.time() - T0)

def sysmsg(icl): return ("You are a tool-retrieval advisor. Return ONLY a JSON array of tool names from "
                         "the catalog needed for the task (minimal, app must match)."
                         + (f"\n\nEXAMPLES:\n{ICL}" if icl else "") + f"\n\nCATALOG ({len(RCAT)}):\n{CAT}")
def msgs_for(instr, icl): return [{"role": "system", "content": sysmsg(icl)},
                                  {"role": "user", "content": f"TASK: {instr}\nReturn the JSON array."}]
def parse(txt):
    m = re.search(r"\[.*?\]", txt, re.S)
    try: p = [str(x) for x in json.loads(m.group(0))] if m else []
    except Exception: p = re.findall(r"[a-z0-9_]+_[a-z0-9_]+", txt)
    return [x for x in p if x in RNAMES]
def recall(pred, gold): g = set(gold); p = set(pred); return len(p & g) / len(g) if g else 1.0

def serve_gen(model_id, instr, icl=False, temperature=0.0):
    body = {"model": model_id, "messages": msgs_for(instr, icl), "max_tokens": 80, "temperature": temperature}
    for attempt in range(3):
        try:
            req = urllib.request.Request(ENDPOINT, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
            return json.load(urllib.request.urlopen(req, timeout=180))["choices"][0]["message"]["content"] or ""
        except Exception:
            if attempt == 2: raise
            time.sleep(2)

def chat_ids(tok, messages):
    enc = tok.apply_chat_template(messages, add_generation_prompt=True)
    if hasattr(enc, "input_ids"): enc = enc.input_ids
    elif isinstance(enc, dict): enc = enc["input_ids"]
    if enc and isinstance(enc[0], (list, tuple)): enc = enc[0]
    return [int(x) for x in enc]
def lm_logits(lm, ids):
    o = lm(ids); return o.logits if hasattr(o, "logits") else (o[0] if isinstance(o, tuple) else o)

def mem_gen(model, proc, instr, icl=False):
    prompt = proc.tokenizer.apply_chat_template(msgs_for(instr, icl), add_generation_prompt=True, tokenize=False)
    out = vlm_generate(model, proc, prompt=prompt, max_tokens=80, verbose=False)
    return out if isinstance(out, str) else getattr(out, "text", str(out))
def eval_both(model, proc):
    d = sum(recall(parse(mem_gen(model, proc, r["instruction"])), r["gold_tools"]) for r in DEV) / len(DEV)
    o = sum(recall(parse(mem_gen(model, proc, r["instruction"])), r["gold_tools"]) for r in OOD) / len(OOD)
    return {"dev": round(d, 3), "ood": round(o, 3)}

def fresh_student(rank=8, layers=8):
    model, proc = vlm_load(STUDENT); lm = model.language_model; lm.freeze()
    try: linear_to_lora_layers(lm, layers, {"rank": rank, "scale": 20.0, "dropout": 0.0})
    except Exception: linear_to_lora_layers(lm, layers, {"rank": rank, "alpha": 16, "dropout": 0.0})
    return model, proc, lm

def student_logps(lm, tok, messages, completion):
    pid = chat_ids(tok, messages); cid = tok.encode(completion, add_special_tokens=False)
    if not cid: return [], cid
    logp = nn.log_softmax(lm_logits(lm, mx.array([pid + cid]))[0].astype(mx.float32), axis=-1)
    ch, dts = [], []
    for j, t in enumerate(cid):
        row = logp[len(pid) + j - 1]; c = float(row[t]); ch.append(c); dts.append(float(mx.max(row)) - c)
    return ch, dts, cid

def train_arm(name, examples, *, chunk=40, max_iters, lr=5e-5):
    """Train fresh student on examples; eval at iter checkpoints -> learning curve."""
    model, proc, lm = fresh_student()
    enc = []
    for ex in examples:
        pid = chat_ids(proc.tokenizer, ex["messages"]); cid = proc.tokenizer.encode(ex["completion"], add_special_tokens=False)
        if not cid: continue
        w = (ex.get("weights") or [1.0] * len(cid)); enc.append((pid, cid, (w + [1.0] * len(cid))[:len(cid)]))
    if not enc: return {"error": "no data"}
    def loss_on(lm, pid, cid, w):
        logp = nn.log_softmax(lm_logits(lm, mx.array([pid + cid]))[0].astype(mx.float32), axis=-1)
        P = len(pid); tl = mx.stack([logp[P + j - 1, t] for j, t in enumerate(cid)])
        wv = mx.array(w); return -(tl * wv).sum() / (wv.sum() + 1e-6)
    opt = optim.AdamW(learning_rate=lr); lvg = nn.value_and_grad(lm, loss_on)
    curve = [{"iter": 0, **eval_both(model, proc)}]; it = 0
    log(f"   [{name}] iter 0: {curve[0]}")
    while it < max_iters and budget_left() > (40 if SMOKE else 120):
        for _ in range(chunk):
            pid, cid, w = enc[it % len(enc)]
            loss, g = lvg(lm, pid, cid, w); opt.update(lm, g); mx.eval(lm.parameters(), opt.state); it += 1
            if it >= max_iters: break
        ev = eval_both(model, proc); curve.append({"iter": it, **ev})
        log(f"   [{name}] iter {it}: dev={ev['dev']} ood={ev['ood']}")
    best = max(curve, key=lambda c: c["dev"]) if curve else None
    return {"curve": curve, "final": curve[-1] if curve else None, "best": best, "n": len(enc)}

results = {"student": STUDENT, "teacher": TEACHER_SERVE, "arms": {}}
log(f"START bench8h-g4 | budget={BUDGET_S/3600:.1f}h smoke={SMOKE} | rcat={len(RCAT)} train={len(TRAIN)} dev={len(DEV)} ood={len(OOD)}")
MAXIT = 24 if SMOKE else 560  # ~4 epochs over 140

try:
    # baseline
    bm, bp = vlm_load(STUDENT)
    results["arms"]["B_baseline"] = eval_both(bm, bp); log(f"B baseline {results['arms']['B_baseline']}")
    del bm; (mx.clear_cache() if hasattr(mx, "clear_cache") else None)

    # build data
    log("building arm data (STaR via student :8081, teacher via :8081 ICL)")
    s_ex, t_ex = [], []
    for r in TRAIN:
        if budget_left() < (90 if SMOKE else 300): break
        try:                                  # STaR: student's own passing samples
            sg = serve_gen(STUDENT_SERVE, r["instruction"], icl=False, temperature=0.7)
            if recall(parse(sg), r["gold_tools"]) >= 0.999:
                s_ex.append({"messages": msgs_for(r["instruction"], False), "completion": json.dumps(parse(sg))})
        except Exception as e: log(f"  STaR gen skip {r['name']}: {str(e)[:60]}")
        try:                                  # privileged self-teacher (student + ICL gold)
            tg = serve_gen(STUDENT_SERVE, r["instruction"], icl=True, temperature=0.0)
            if parse(tg):
                t_ex.append({"messages": msgs_for(r["instruction"], False), "completion": json.dumps(parse(tg)), "gold": r["gold_tools"]})
        except Exception as e: log(f"  teacher gen skip {r['name']}: {str(e)[:60]}")
    log(f"data: STaR={len(s_ex)} teacher={len(t_ex)}")
    json.dump({"s": s_ex, "t": t_ex}, open(RUN / "arm_data.json", "w"))

    if s_ex and budget_left() > (150 if SMOKE else 600):
        results["arms"]["S_star"] = train_arm("S", s_ex, max_iters=MAXIT)
        json.dump(results, open(RUN / "results.json", "w"), indent=2)
    if t_ex and budget_left() > (150 if SMOKE else 600):
        results["arms"]["O_offpolicy"] = train_arm("O", [{"messages": d["messages"], "completion": d["completion"]} for d in t_ex], max_iters=MAXIT)
        json.dump(results, open(RUN / "results.json", "w"), indent=2)
    if t_ex and budget_left() > (150 if SMOKE else 600):
        log("scoring arm-P surprisal weights via kernel #1 (fresh student lm)")
        _, sp, slm = fresh_student()
        p_ex = []; _dts_all = []
        for d in t_ex:
            lps, dts, _ = student_logps(slm, sp.tokenizer, d["messages"], d["completion"])
            from kernel2_mlxvlm import surprisal_gate
            _dts_all.extend(dts)
            p_ex.append({"messages": d["messages"], "completion": d["completion"],
                         "weights": surprisal_gate(lps) if lps else None})
        del slm; (mx.clear_cache() if hasattr(mx, "clear_cache") else None)
        pe = train_arm("P", p_ex, max_iters=MAXIT)
        pe["teacher_mean_d_t"] = round(sum(_dts_all)/max(len(_dts_all),1), 3)
        results["arms"]["P_pedagogical"] = pe
        json.dump(results, open(RUN / "results.json", "w"), indent=2)
except Exception as e:
    results["error"] = str(e); log(f"FAILED: {e}\n{traceback.format_exc()[:500]}")
json.dump(results, open(RUN / "results.json", "w"), indent=2)

# report
def fin(a): v = results["arms"].get(a, {}); return v.get("final") or v if isinstance(v, dict) else {}
rows_md = []
for a in ["B_baseline", "S_star", "O_offpolicy", "P_pedagogical"]:
    v = results["arms"].get(a, {})
    f = v.get("final") if isinstance(v, dict) and "final" in v else v
    dev = f.get("dev", "—") if isinstance(f, dict) else "—"; ood = f.get("ood", "—") if isinstance(f, dict) else "—"
    rows_md.append(f"| {a} | {dev} | {ood} | {v.get('n','—') if isinstance(v,dict) else '—'} |")
mins = (time.time() - T0) / 60
report = f"""# Gemma-4 pedagogical-distillation bench — results
runtime {mins:.0f}m | budget {BUDGET_S/3600:.1f}h | student gemma-4-e2b (mlx-vlm) | teacher {TEACHER_SERVE}
reduced catalog {len(RCAT)} tools | train {len(TRAIN)} / dev {len(DEV)} / OOD-sales {len(OOD)}

## Final dev/OOD recall by arm
| arm | dev | ood | n |
|---|---|---|---|
{chr(10).join(rows_md)}

Arms: B baseline · S rejection-sampling SFT · O off-policy distill (ICL teacher) · P pedagogical (surprisal-gated).
Read: P>O → spike gating helps · O>S → bigger in-family teacher adds signal · OOD col → cross-domain transfer.

## Learning curves
```json
{json.dumps({a: results['arms'].get(a, {}).get('curve') for a in ['S_star','O_offpolicy','P_pedagogical']}, indent=1)[:3000]}
```
## Next
Promote winning arm to multi-round on-policy loop; fuse best adapter and serve on :8081; extend to E4B student.
"""
open(RUN / "REPORT.md", "w").write(report)
log(f"DONE {mins:.0f}m -> {RUN/'REPORT.md'}")
print("\n" + report)
