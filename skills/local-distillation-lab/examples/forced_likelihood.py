"""Kernel #1 — local MLX forced-likelihood scorer for Pedagogical RL.

Teacher-forces the STUDENT model over a given trajectory and emits, per
completion token: chosen logprob, argmax logprob, the paper's surprise gap
d_t = logπ(a_max) − logπ(τ_t), and the score_table "top-2 gap" (top1 − top2).
Feeds the existing first-party `pedagogical_reward.g_spike`.

This is the missing executor behind `fullcast_pedagogical_forced_likelihood.py`'s
`forced_token_logprobs_ref`. Pure-local, no provider calls.

Validation (run as __main__): full-pass gather == incremental teacher-forced
logp (proves no off-by-one), then prints d_t / top-2 gap / G_spike.
"""
from __future__ import annotations
import sys, time
from pathlib import Path
import mlx.core as mx
import mlx.nn as nn
from mlx_lm import load

# import the real first-party reward
sys.path.insert(0, str(Path(__file__).parent / "src"))
from understudy_agent.pedagogical_reward import g_spike, SpikeRewardConfig, spike_intensity


def forced_token_logprobs(model, prompt_ids: list[int], completion_ids: list[int]) -> list[dict]:
    """Single forward pass over prompt+completion; gather per-completion-token stats."""
    ids = mx.array([prompt_ids + completion_ids])
    logits = model(ids)[0]                      # [T, V]
    logp = nn.log_softmax(logits, axis=-1)
    P = len(prompt_ids)
    out = []
    for j, tid in enumerate(completion_ids):
        pos = P + j - 1                         # dist predicting completion token j
        row = logp[pos]
        chosen = float(row[tid])
        amax = float(mx.max(row))
        # top-2 gap (top1 - top2): mask argmax then take max again
        arg = int(mx.argmax(row))
        masked = mx.where(mx.arange(row.shape[0]) == arg, mx.array(-1e9), row)
        second = float(mx.max(masked))
        out.append({
            "token_id": tid, "logp": chosen,
            "argmax_logp": amax, "d_t": amax - chosen,        # paper surprise gap (>=0)
            "top2_gap": amax - second,                         # score_table feature
        })
    return out


def _incremental_logp(model, prompt_ids, completion_ids) -> list[float]:
    """Reference: feed growing prefixes, read last-position logp of each next token."""
    out = []
    for j, tid in enumerate(completion_ids):
        prefix = prompt_ids + completion_ids[:j]
        logits = model(mx.array([prefix]))[0]
        row = nn.log_softmax(logits[-1], axis=-1)
        out.append(float(row[tid]))
    return out


if __name__ == "__main__":
    model_id = sys.argv[1] if len(sys.argv) > 1 else "mlx-community/gemma-3-1b-it-4bit"
    print(f"loading {model_id} ...")
    model, tok = load(model_id)

    # realistic chat trajectory: a prompt + a model-style completion
    prompt = tok.apply_chat_template(
        [{"role": "user", "content": "In one short sentence, what is the capital of France and why is it famous?"}],
        add_generation_prompt=True,
    )
    completion_text = "Paris is the capital of France, famous for the Eiffel Tower and its art and cuisine. zqx"  # 'zqx' = deliberate spike
    completion = tok.encode(completion_text, add_special_tokens=False)

    t0 = time.time()
    stats = forced_token_logprobs(model, prompt, completion)
    dt = time.time() - t0

    # --- validation: full-pass == incremental ---
    ref = _incremental_logp(model, prompt, completion)
    maxerr = max(abs(s["logp"] - r) for s, r in zip(stats, ref))
    print(f"\nVALIDATION full-pass vs incremental: max abs logp err = {maxerr:.2e} "
          f"-> {'PASS' if maxerr < 1e-2 else 'FAIL'}  ({len(completion)} tokens, {dt*1000:.0f}ms forward)")

    chosen = [s["logp"] for s in stats]
    cfg = SpikeRewardConfig()
    gs = g_spike(chosen, cfg)
    print(f"G_spike(traj) = {gs:.4f} | spike_intensity = {spike_intensity(chosen, cfg):.4f}")
    print(f"mean top-2 gap = {sum(s['top2_gap'] for s in stats)/len(stats):.4f} | "
          f"mean d_t = {sum(s['d_t'] for s in stats)/len(stats):.4f} | "
          f"mean logp = {sum(chosen)/len(chosen):.4f}")
    print("\nper-token (last 8, watch the injected 'zqx' spike):")
    for s in stats[-8:]:
        print(f"  {tok.decode([s['token_id']])!r:14} logp={s['logp']:7.3f}  d_t={s['d_t']:6.3f}  top2_gap={s['top2_gap']:6.3f}")
