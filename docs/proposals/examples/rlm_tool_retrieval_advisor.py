"""Tool-retrieval advisor v0 — stateless, catalog-prefix, scored vs gold zapier_tools.

Measures whether a (local) model can retrieve the right ~2 tools from 549.
No rollouts: pure recall/precision against gold. The catalog is a stable prefix
(the cacheable part); only the task query varies per call.
"""
from __future__ import annotations
import json, re, sys, time
import urllib.request

ROOT = "/Users/luis/Developer/understudy/testing-environments/AutomationBench"
EV = f"{ROOT}/.understudy/capture-evidence"
ENDPOINT = "http://127.0.0.1:8081/v1/chat/completions"
MODEL = sys.argv[1] if len(sys.argv) > 1 else "/Users/luis/.understudy/models/gemma-4-e2b-it-mlx-vlm-4bit"
SPLIT = sys.argv[2] if len(sys.argv) > 2 else "dev"

rows = json.load(open(f"{EV}/simple-gold-tools.json"))
catalog = json.load(open(f"{EV}/tool-catalog.json"))
splits = json.load(open(f"{EV}/splits.json"))
sel = set(splits[SPLIT]["rows"]) if SPLIT in splits else None
work = [r for r in rows if (sel is None or r["name"] in sel)]

CATALOG_TEXT = "\n".join(f"- {t['name']}: {t['description']}" for t in catalog)
SYS = (
    "You are a tool-retrieval advisor. Given a task, return ONLY the tool names from the "
    "catalog that are needed to complete it, as a compact JSON array of strings.\n"
    "Rules: prefer the minimal set (usually 1-3). The tool's app/service MUST match the "
    "system named in the task (e.g. a Salesforce task needs salesforce_* tools, not slack_*). "
    "Return ONLY the JSON array, nothing else.\n\n"
    f"CATALOG ({len(catalog)} tools):\n{CATALOG_TEXT}"
)

def ask(instruction: str):
    body = json.dumps({"model": MODEL, "messages": [
        {"role": "system", "content": SYS},
        {"role": "user", "content": f"TASK: {instruction}\n\nReturn the JSON array of needed tool names."},
    ], "max_tokens": 200, "temperature": 0}).encode()
    req = urllib.request.Request(ENDPOINT, data=body, headers={"Content-Type": "application/json"})
    r = json.load(urllib.request.urlopen(req, timeout=120))
    txt = r["choices"][0]["message"]["content"] or ""
    usage = r.get("usage", {})
    m = re.search(r"\[.*?\]", txt, re.S)
    try:
        pred = json.loads(m.group(0)) if m else []
        pred = [str(x).strip() for x in pred if isinstance(x, (str,))]
    except Exception:
        pred = re.findall(r"[a-z0-9_]+_[a-z0-9_]+", txt)
    return pred, usage

names = {t["name"] for t in catalog}
R = P = EX = 0.0; n = len(work); per = []
t0 = time.time(); in_tok = 0
for r in work:
    pred, usage = ask(r["instruction"])
    pred = [p for p in pred if p in names]          # keep only real tool names
    gold = set(r["gold_tools"]); ps = set(pred)
    rec = len(ps & gold) / len(gold) if gold else 1.0
    prec = len(ps & gold) / len(ps) if ps else 0.0
    ex = 1.0 if ps == gold else 0.0
    R += rec; P += prec; EX += ex; in_tok += usage.get("prompt_tokens", 0)
    per.append({"name": r["name"], "gold": sorted(gold), "pred": pred, "recall": rec, "precision": round(prec, 2)})
out = {"split": SPLIT, "model": MODEL, "n": n,
       "recall": round(R/n, 3), "precision": round(P/n, 3), "exact_set_match": round(EX/n, 3),
       "avg_prompt_tokens": int(in_tok/n), "catalog_tools": len(catalog),
       "cacheable_prefix_frac": round(len(SYS)/(len(SYS)+200), 3), "elapsed_s": round(time.time()-t0, 1)}
json.dump({"summary": out, "per_task": per}, open(f"{EV}/advisor-{SPLIT}.json", "w"), indent=1)
print(json.dumps(out))
for p in per[:6]:
    print(f"  {p['recall']:.2f}r/{p['precision']:.2f}p  gold={p['gold']}  pred={p['pred']}")
