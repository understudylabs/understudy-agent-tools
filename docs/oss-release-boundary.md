# OSS Release Boundary

Use this checklist when moving work from private Understudy repos into this
public repository.

## Public By Default

- local-only CLI commands;
- public skills and templates;
- synthetic fixtures;
- public provider docs and public research citations;
- repo-relative artifact schemas;
- public-safe examples with no real customer payloads.

The OSS MVP path should work without registration:

```text
capture evidence -> attach harness/environment
  -> confirm metric/validator/holdout -> rerun baseline
  -> validate and optimize -> value report
```

`register` and `login` are allowed only as CLI or hosted upsell language, not
as a gate for the OSS MVP. The hosted path is:

```text
register/login -> credits/project -> gateway routing
```

## Keep Private

- customer names, domains, volumes, prompts, completions, labels, or traces;
- private runbooks and incident notes;
- hosted control-plane details;
- production admin surfaces;
- private provider terms, account arrangements, and capacity tactics;
- internal margin logic or proprietary route policy;
- patent-sensitive methodology details.

## Extraction Checklist

1. Replace customer-specific examples with synthetic fixtures.
2. Remove private repo paths and local usernames.
3. Remove raw prompts, completions, trace payloads, labels, and datasets.
4. Replace private provider terms with public source links.
5. Preserve public model ids, provider names, and dated public source URLs when
   they are necessary for reproducibility.
6. Confirm the metric, validator, and holdout boundary before any optimization
   or route comparison.
7. Rerun the baseline after harness, environment, metric, validator, or split
   changes. Store `harness_sha256`, `metric_sha256`, and `splits_sha256` in
   `baseline.json` so stale baselines fail by hash, not by file presence.
8. Keep GEPA and other optimizers on train/dev only; reserve holdout for final
   validation and claim support.
9. Require a claim packet before publishing savings, latency, quality, or
   route-superiority claims. `claim.json` must cite the hash-bound baseline
   contract and the frozen candidate hash.
10. Add a local smoke test or dry-run.
11. Run the public repo validator before opening a PR.

Do not port private optimizer, evaluator, or workload-compiler implementations
into this repo. Public commands may prompt for the upstream `gepa` package when
the developer explicitly requests optimization, but they should keep the
Understudy-specific work in public adapters, metric feedback, local artifact
gates, and report writers. See
[`optimize-workload-contract.md`](optimize-workload-contract.md).

## Safer Replacement Language

Use `workload-001`, `example customer`, `synthetic support ticket`, `public
fixture`, or `repo-relative path` instead of real customer, account, or private
repo identifiers.

Use `scenario sizing`, `measured baseline rerun`, `candidate validation`, and
`claim packet required` instead of unsupported savings language.
