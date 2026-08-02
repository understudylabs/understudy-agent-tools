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

The ladder attempted a strict prompt/GEPA rung and an initial SFT rung. GEPA
reduced malformed output under the broken path, but its selection is not
interpretable after the shim correction. The first SFT run was under-trained
(one epoch, 1e-5, 30 steps); its corrected-path behavior showed terminal-call
repetition. A token-level round-trip check confirmed the renderer stop token
was present, supervised, and preceded by masked prompt positions. One
time-boxed higher-rate retrain was then run separately; its result belongs in
the local receipt and is not used to justify a promotion here.

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
