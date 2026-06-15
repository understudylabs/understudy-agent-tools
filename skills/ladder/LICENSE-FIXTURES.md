# License & Provenance — No-Data Ladder Fixtures

This directory (`skills/ladder/`) is part of a public, MIT-licensed repository.
Every fixture, dataset row, task, and line of engine code here is **original
synthetic work**. This file states that clearly and records what it is — and is
not — derived from.

## Attestation

- **All fixtures are original synthetic content** authored for this prototype in
  the invented **Larkfield** world. Brands are invented (`TravelPro`,
  `AcmeRoast`, `NorthPeak`); every email address and domain is under the reserved
  example namespace `*.larkfield.example`.
- **Zero upstream bytes.** No dataset rows, prompts, completions, labels,
  trajectories, tool schemas, or world states were copied from AutomationBench,
  Harvey, the Amazon ESCI / Shopping Queries dataset, or any customer or private
  data. Nothing of any user's was read or included.
- **The engine is an independent re-implementation inspired by upstream
  *mechanism*, not a derivative work.** The WorldState + tool + assertion +
  strict-mode design in `env/world.py`, the scripted oracle in `env/oracle.py`,
  the reward-hacking sentinels in `env/sentinels.py`, and the streaming/replay
  viewer in `viewer/ladder.html` re-implement well-known patterns (stateful
  tool environments, final-state scoring, reward-hacking sentinels, an
  event-stream rollout UI) from scratch. No upstream source code was copied; the
  similarity is at the level of approach, which is not protected expression.
- **Determinism and honesty.** The frozen report is
  `understudy.ladder_report.v1` with `synthetic: true`, `judge_model: null`,
  `seed: 7`, `temperature: 0.0`. It is explicitly directional and is **not** a
  `value_report.v1` savings claim; it carries no `harness_sha256`,
  `validated_on_holdout`, or `candidate_sha256`.

## License

The code and fixtures in this directory are released under the repository's
**MIT License** (see the top-level [`LICENSE`](../../LICENSE)). Because every
fixture is original, the MIT grant applies cleanly with no third-party dataset
license to propagate.

## Upstream inspiration (cited by URL only)

These projects and datasets informed the *mechanism and task shapes* we
re-implemented. They are cited for reproducibility and credit. **No content from
them is present in this repository** — follow the links to the originals.

- **AutomationBench** — stateful, multi-tool agentic tasks scored on final world
  state. Mechanism re-implemented for the HARD tier; no tasks, tools, or states
  copied. https://github.com/ServiceNow/AutomationBench
- **verifiers (Prime Intellect)** — the dataset · parser · rubric · rollout
  decomposition and the "score the whole rollout" framing.
  https://github.com/PrimeIntellect-ai/verifiers ·
  https://www.primeintellect.ai/blog/environments
- **Amazon ESCI / Shopping Queries Dataset** — the Exact / Substitute /
  Complement / Irrelevant relevance taxonomy used (as a *taxonomy only*) by the
  MEDIUM tier. No ESCI query/product rows are included; the MEDIUM beat is
  pre-baked synthetic. https://github.com/amazon-science/esci-data
- **Harvey** — referenced only as a real-world agentic-workflow motivation. No
  Harvey data, prompts, or artifacts are present. https://www.harvey.ai/

## Boundary checklist (what a reviewer can verify)

- `grep -ri 'larkfield' skills/ladder` — every fixture entity lives in the
  invented world; domains are `*.larkfield.example`.
- `grep -riE 'esci|automationbench|harvey|amazon-science' skills/ladder` — hits
  appear **only** in this file (`LICENSE-FIXTURES.md`) and in `PROVENANCE.json`'s
  `world_note` (which names AutomationBench / Harvey / ESCI as the *excluded*
  upstreams). They are URL-only citations and prose disclaimers — never data, never
  in any fixture row, tool schema, world state, prompt, or label.
- No real customer names, domains, volumes, prompts, completions, labels, or
  traces appear anywhere under `skills/ladder/`.
- Per-file author-method and recoverability notes are in
  [`PROVENANCE.json`](PROVENANCE.json).
