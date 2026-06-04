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
6. Add a local smoke test or dry-run.
7. Run the public repo validator before opening a PR.

## Safer Replacement Language

Use `workload-001`, `example customer`, `synthetic support ticket`, `public
fixture`, or `repo-relative path` instead of real customer, account, or private
repo identifiers.
