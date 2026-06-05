# Appendix skills

These are real, working skills that are **not part of the MVP discovered
surface**. The public MVP is intentionally three skills — `understudy`
(orchestrator) → `understand-workload` → `validate-and-optimize` — so a developer
isn't routing through 24 descriptions to reach the first win.

Everything here is kept, not deleted. It falls into two groups:

**Folded into the MVP workers.** Their operative content now lives in the
workers' `reference.md`; the full originals are preserved here:
- `understudy-workload-discovery`, `understudy-capture-import` → `skills/understand-workload/reference.md`
- `understudy-evaluate`, `understudy-optimize`, `understudy-decision-packet` → `skills/validate-and-optimize/reference.md`

**Adjacent tooling, deferred.** Useful, but not on the first-win path — promote
into discovery (move back under `skills/`) as real usage shows we need them:
- setup / first-touch: `understudy-bootstrap`, `understudy-provider-keys`, `understudy-local-proxy`, `understudy-demo`
- post-training & models: `understudy-train`, `understudy-local-models`, `understudy-model-lookup`
- evaluation depth: `understudy-blind-review`, `understudy-latency-triage`, `understudy-output-control`, `understudy-lab`
- providers & output: `understudy-provider-integrations`, `understudy-publish-results`, `understudy-value-reporting`, `understudy-deslop`, `understudy-tufte`

## Promoting an appendix skill

1. `git mv appendix/<skill> skills/<skill>`.
2. Make it pass `scripts/validate_public_skills.py` (frontmatter, `## Safety Gates`,
   ≤150-line SKILL.md or a `reference.md`, no private terms/secrets).
3. Add it to `skills/README.md` and route to it from `skills/understudy/SKILL.md`.

Until promoted, appendix skills are not validated by the public-skill gate or
auto-discovered; treat them as drafts to polish.
