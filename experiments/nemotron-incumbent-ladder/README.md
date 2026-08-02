# Nemotron incumbent ladder

This experiment record is a public, synthetic smoke record for a reusable
verifier and artifact contract. The workload shape is a high-volume
event-driven email orchestration workload whose policy model selects a small
set of tools from long context and emits a tiny response. The production
incumbent was `gpt-4o`; its economic baseline was 470,404 requests, about
$14,887.93 customer cost, 2,277 ms average latency, and approximately 20.2K
input / 114 output tokens per request.

The mirror was repaired before candidate comparison. Blind adjudication found
that some labels encoded an unstated terminal-summary convention rather than a
defensible first-turn action. The generator was repaired to state single-turn,
terminal-summary, multi-call, and specialist-path conventions explicitly. The
repaired incumbent measured 0.750 aggregate on dev (1.000 shortcut, 0.833
playbook, 0.476 judgment), so the mirror was not saturated.

The first candidate measurements were invalidated by a local serving shim that
discarded rendered `<tool_call>` blocks when the renderer classified them as
non-native calls. A raw-output inspection and a parser revision corrected that
path. The fixed parser accepts native provider calls and rendered calls after a
reasoning preamble. The parser revision and hash are carried by every evidence
row.

The complete fixed-path dev record contains the incumbent, Nemotron base,
GEPA, and the first serving-order-corrected SFT arm. The incumbent scored
0.750 aggregate (1.000/0.833/0.476 by band), the base scored 0.157, GEPA
scored 0.057, and SFT v2 scored 0.018. GEPA is explicitly marked
selection-invalidated because its selection happened before the shim/parser
correction; its fixed-path result is retained only for audit. SFT v2 showed
terminal-call repetition and single-call collapse.

The one authorized higher-rate SFT retrain used 1e-4, five epochs, rank 32,
and 150 steps. It was evaluated on five train rows first and reproduced 0/5
targets, so no dev evaluation was run for that arm. It is recorded as a
train-smoke-only arm in the evidence row rather than being assigned a
fabricated dev score.

The fixed shim passes `renderer.get_stop_sequences()` to
`SamplingParams(stop=...)`. Direct inspection of the higher-rate checkpoint
terminated with `stop_sequence`; the raw completion contained one terminal
`<|im_end|>` only at the end, not mid-stream. The repeated calls therefore
were not caused by an omitted stop parameter or generation continuing past a
mid-stream stop token.

Tinker has no available price schedule. Its usage is therefore reported as
unpriced with token counts and wall-clock measurements, never as zero cost.
The incumbent production numbers above are distinct from the cheaper
synthetic-mirror measurement.

**Promotion decision:** do not promote from this dev-only evidence. The
candidate did not establish a production replacement claim, and no holdout
row was executed. The claim boundary is: *this record is a dev-only
optimization lead; holdout remains clean and must be gated separately after a
candidate is frozen.*

The committed fixture is only the 12-row fully synthetic smoke mirror. It
contains no captures, customer identifiers, entity mapping, adjudication
payloads, or raw model outputs.
