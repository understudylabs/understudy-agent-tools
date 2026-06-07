# mlx-arena — reference

Deeper notes for the [`mlx-arena`](SKILL.md) skill.

## Finding MLX models

`mlx-community` on Hugging Face hosts MLX-converted, pre-quantized open weights.
Query the Hub API (no auth needed) and bias to the smallest 4-bit text-instruct:

```bash
curl -s "https://huggingface.co/api/models?author=mlx-community&search=gemma&limit=100" \
  | python3 -c "import json,sys; [print(m['id']) for m in json.load(sys.stdin)]"
curl -s "https://huggingface.co/api/models?author=mlx-community&search=nemotron&limit=100" \
  | python3 -c "import json,sys; [print(m['id']) for m in json.load(sys.stdin)]"
```

Pick `*-it-*` (instruct), prefer `*-4bit`, and **avoid `*-assistant`** repos —
those are speculative-decoding drafters, not standalone models.

## Known model-compat gotchas (hard-won)

- **Gemma 4 E2B doesn't load on the tested MLX stack.**
  `mlx-community/Gemma4-E2B-IT-Text-int4` downloads at about 2.7 GB, but both
  `mlx_lm.generate` and `mlx_vlm.generate` fail on `mlx-lm 0.31.3` /
  `mlx-vlm 0.6.2`. Root cause: the config puts `num_kv_shared_layers: 20` under
  `text_config`, while `mlx_lm` reads top-level `ModelArgs` defaults; the loader
  then treats layers 15-34 as KV-shared and rejects their per-layer `k_proj` /
  `v_proj` weights (`ValueError: Received 140 parameters not in model`). Adding a
  top-level `num_kv_shared_layers: 0` makes K/V weights fit but breaks the
  double-wide MLP shapes on those layers, so this needs a loader/config fix, not
  a one-line runtime override. Keep `gemma-3-1b-it-4bit` as the smallest verified
  Google chat model until Gemma 4 E2B loads cleanly.
- **Reasoning models (e.g. Nemotron 3 Nano) need token headroom.** They emit a
  hidden/visible reasoning trace before the answer; with a tiny `max_tokens` the
  visible `content` comes back empty. Give ≥256 tokens. Expect higher latency than
  a same-size non-reasoning model — that is a real cost to weigh, not a bug.
- **Stop tokens.** Some quants ship an empty `generation_config.json` and a
  tokenizer whose `eos` is `<eos>` but whose chat turn ends with `<end_of_turn>`
  (id 106) — the model answers, then spews `<end_of_turn>`. Fix by writing
  `generation_config.json` with `{"eos_token_id": [1, 106]}` into the snapshot, or
  by passing `stop` in the request.
- **Custom architectures need `--trust-remote-code`** (Nemotron-H ships
  `modeling_nemotron_h.py`). The arena passes it by default.
