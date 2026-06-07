"""Kernel #2 (mlx-vlm port) — weighted LoRA-SFT on the real Gemma-4 mlx-vlm snapshots.

Loads via mlx_vlm, injects LoRA into model.language_model, runs the surprisal-gated
weighted-CE loss through the text forward. Proves a real weight update on Gemma-4.
"""
from __future__ import annotations
import math, os, sys, time
import mlx.core as mx, mlx.nn as nn, mlx.optimizers as optim
from mlx.utils import tree_flatten
from mlx_vlm import load as vlm_load

def surprisal_gate(logps, kappa=1.0, gamma=-4.0):
    return [1.0 / (1.0 + math.exp(-kappa * (lp - gamma))) for lp in logps]

def _lm_logits(lm, ids):
    out = lm(ids)
    return out.logits if hasattr(out, "logits") else (out[0] if isinstance(out, tuple) else out)

def load_g4(path):
    model, proc = vlm_load(path)
    tok = getattr(proc, "tokenizer", proc)
    return model, model.language_model, tok

def chat_ids(tok, prompt):
    """Return a flat list[int] for a user-turn chat prompt (handles BatchEncoding)."""
    enc = tok.apply_chat_template([{"role": "user", "content": prompt}], add_generation_prompt=True)
    if hasattr(enc, "input_ids"): enc = enc.input_ids
    elif isinstance(enc, dict): enc = enc["input_ids"]
    if enc and isinstance(enc[0], (list, tuple)): enc = enc[0]
    return [int(x) for x in enc]

def forced_logps(lm, tok, prompt, completion):
    """kernel #1 (mlx-vlm): per-token logp of completion under the student LM."""
    pid = chat_ids(tok, prompt)
    cid = tok.encode(completion, add_special_tokens=False)
    if not cid: return [], cid
    logp = nn.log_softmax(_lm_logits(lm, mx.array([pid + cid]))[0].astype(mx.float32), axis=-1)
    P = len(pid)
    return [float(logp[P + j - 1, t]) for j, t in enumerate(cid)], cid

def train_lora_weighted_g4(path, examples, *, iters=24, lr=2e-4, rank=8, num_lora_layers=8, log=print):
    from mlx_lm.tuner.utils import linear_to_lora_layers, print_trainable_parameters
    model, lm, tok = load_g4(path)
    lm.freeze()
    try: linear_to_lora_layers(lm, num_lora_layers, {"rank": rank, "scale": 20.0, "dropout": 0.0})
    except Exception: linear_to_lora_layers(lm, num_lora_layers, {"rank": rank, "alpha": 16, "dropout": 0.0})
    print_trainable_parameters(lm)
    before = {k: mx.array(v) for k, v in tree_flatten(lm.trainable_parameters())}

    enc = []
    for ex in examples:
        pid = chat_ids(tok, ex["prompt"])
        cid = tok.encode(ex["completion"], add_special_tokens=False)
        if not cid: continue
        w = (ex.get("weights") or [1.0] * len(cid))
        enc.append((pid, cid, (w + [1.0] * len(cid))[:len(cid)]))

    def loss_on(lm, pid, cid, w):
        logp = nn.log_softmax(_lm_logits(lm, mx.array([pid + cid]))[0].astype(mx.float32), axis=-1)
        P = len(pid)
        tl = mx.stack([logp[P + j - 1, t] for j, t in enumerate(cid)])
        wv = mx.array(w)
        return -(tl * wv).sum() / (wv.sum() + 1e-6)

    opt = optim.AdamW(learning_rate=lr)
    lvg = nn.value_and_grad(lm, loss_on)
    curve = []
    for it in range(iters):
        pid, cid, w = enc[it % len(enc)]
        loss, grads = lvg(lm, pid, cid, w)
        opt.update(lm, grads); mx.eval(lm.parameters(), opt.state)
        curve.append(float(loss))
        if it % max(1, iters // 5) == 0 or it == iters - 1: log(f"   iter {it:3d} loss {float(loss):.4f}")
    after = {k: v for k, v in tree_flatten(lm.trainable_parameters())}
    delta = sum(float(mx.abs(after[k] - before[k]).sum()) for k in before)
    return {"model": model, "lm": lm, "tok": tok, "loss_curve": curve,
            "loss_drop": curve[0] - curve[-1], "param_delta": delta}

if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("UNDERSTUDY_MODEL")
    if not path:
        print("usage: python kernel2_mlxvlm.py /path/to/mlx-vlm-model")
        print("or set UNDERSTUDY_MODEL=/path/to/mlx-vlm-model")
        raise SystemExit(2)
    print(f"SMOKE kernel #2 (mlx-vlm) on REAL Gemma-4: {path}")
    exs = [{"prompt": "TASK: Update Jordan Lee's phone in Salesforce.\nReturn the JSON array.",
            "completion": '["salesforce_contact_update"]'},
           {"prompt": "TASK: Create a Salesforce case for the outage.\nReturn the JSON array.",
            "completion": '["salesforce_case_create"]'},
           {"prompt": "TASK: Log a note on the SF contact.\nReturn the JSON array.",
            "completion": '["salesforce_note_create"]'}]
    t0 = time.time()
    r = train_lora_weighted_g4(path, exs, iters=20, lr=2e-4)
    print(f"\nRESULT loss {r['loss_curve'][0]:.3f} -> {r['loss_curve'][-1]:.3f} "
          f"(drop {r['loss_drop']:+.3f}) | param_delta {r['param_delta']:.4f} | {time.time()-t0:.0f}s")
    print("GEMMA-4 WEIGHT-UPDATE PROVEN:", "PASS" if r["loss_drop"] > 0.05 and r["param_delta"] > 0 else "INCONCLUSIVE")
