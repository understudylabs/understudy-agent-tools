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

- **Gemma 4 E2B doesn't load on mlx_lm 0.31.3.** Its MLX quants store per-layer
  `k_proj`/`v_proj` for the 20 KV-shared layers, but the `gemma4_text` loader
  shares them → `ValueError: Received 140 parameters not in model`. Use
  `gemma-3-1b-it-4bit` as the smallest Google chat model that loads today; revisit
  Gemma 4 when mlx_lm updates. Multimodal Gemma repos (no `-text`) also fail under
  text-only `mlx_lm`.
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
