#!/usr/bin/env python3
"""Self-test for the RL-handoff skill pipeline example scripts.

Covers the four skills added together: author-rl-env, compare-trajectories,
curate-trajectories, package-verifier-env. Exits non-zero on any failure so it
can gate CI (see tests/rl-skills.test.mjs). Stdlib + python3 only; no network,
no provider keys, no model calls.

Run from the repo root:
    python3 tests/rl_skills_selftest.py
"""
from __future__ import annotations
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SK = os.path.join(ROOT, "skills")
PY = sys.executable
NEW_SKILLS = ["author-rl-env", "compare-trajectories", "curate-trajectories", "package-verifier-env"]
fails: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    print(f"  [{'ok' if cond else 'FAIL'}] {name}" + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        fails.append(name)


def run(args, **kw):
    return subprocess.run([PY, *args], capture_output=True, text=True, **kw)


# 1. Unit self-tests embedded in the example scripts -------------------------
print("== example self-tests ==")
r = run([f"{SK}/author-rl-env/examples/rl_env_wrapper.py"])
check("rl_env_wrapper smoke", r.returncode == 0 and "round-trip" in r.stdout, r.stderr)

r = run([f"{SK}/compare-trajectories/examples/traj_diff.py"])
check("traj_diff classifier selftest", r.returncode == 0 and "selftest ok" in r.stdout, r.stderr)
check("traj_diff finds all 3 gap classes",
      all(c in r.stdout for c in ("persistence/recovery", "knowledge", "format/parsing")), r.stdout)


# 2. curate-trajectories integration: index -> select (clean + blocked) ------
print("== curate-trajectories integration ==")
with tempfile.TemporaryDirectory() as T:
    # Real AutomationBench schema: task id in `name` (not `id`), provenance
    # backfilled from run-level `meta` (no per-row seed), splits use `rows`.
    names = [f"simple.task_{i}" for i in range(6)]
    rows = [{"id": i + 1, "name": names[i], "passed": True, "score": 1.0, "finish_reasons": ["stop"],
             "messages": [{"role": "assistant",
                           "tool_calls": [json.dumps({"name": "api_fetch",
                                                      "arguments": json.dumps({"url": "/x"})})]}],
             "end_state": {}} for i in range(6)]
    json.dump({"meta": {"model": "gemma-4-e2b", "toolset": "api", "domains": ["simple"]}, "tasks": rows},
              open(f"{T}/run.json", "w"))
    json.dump({"seed": 7, "train": {"rows": names[:4]},
               "dev": {"rows": [names[4]]}, "holdout": {"rows": [names[5]]}, "splits_sha256": "DUMMY"},
              open(f"{T}/splits.json", "w"))
    r = run([f"{SK}/curate-trajectories/examples/index_trajectories.py", f"{T}/run.json",
             "--out", f"{T}/index.jsonl"])
    idx = json.loads(r.stdout) if r.returncode == 0 else {}
    check("index builds", r.returncode == 0 and idx.get("n_rows") == 6, r.stderr)
    check("provenance complete from meta (no false seed flag)",
          idx.get("incomplete_provenance") == [], f"incomplete: {idx.get('incomplete_provenance')}")

    r = run([f"{SK}/curate-trajectories/examples/select.py", "--index", f"{T}/index.jsonl",
             "--splits", f"{T}/splits.json", "--name", "safe", "--expr", "split == 'train'",
             "--guarded", "--out-dir", f"{T}/sel"])
    check("clean guarded selection exits 0", r.returncode == 0, r.stderr)
    check("clean selection has 4 train rows, no leak",
          r.returncode == 0 and json.loads(r.stdout)["counts_by_split"] == {"train": 4, "dev": 0, "holdout": 0, "none": 0},
          r.stdout)

    r = run([f"{SK}/curate-trajectories/examples/select.py", "--index", f"{T}/index.jsonl",
             "--splits", f"{T}/splits.json", "--name", "leaky", "--expr", "toolset == 'api'",
             "--guarded", "--out-dir", f"{T}/sel"])
    check("holdout-leaking guarded selection is BLOCKED (exit 2)", r.returncode == 2, f"rc={r.returncode}")

    # The restricted filter evaluator must reject non-allowlisted names.
    r = run([f"{SK}/curate-trajectories/examples/select.py", "--index", f"{T}/index.jsonl",
             "--splits", f"{T}/splits.json", "--name", "evil", "--expr", "__import__('os')",
             "--out-dir", f"{T}/sel"])
    check("unsafe filter expr is rejected", r.returncode != 0)


# 3. package-verifier-env: return-eval attestation + drift refusal -----------
print("== package-verifier-env return-eval ==")
with tempfile.TemporaryDirectory() as W:
    ev = f"{W}/.understudy/capture-evidence"
    os.makedirs(ev)
    json.dump({"seed": 7, "holdout": {"row_ids": ["h0", "h1"]}}, open(f"{ev}/splits.json", "w"))
    sha = hashlib.sha256(open(f"{ev}/splits.json", "rb").read()).hexdigest()
    json.dump({"score": 0.5, "metric": "final_state", "splits_sha256": sha},
              open(f"{ev}/baseline.json", "w"))
    env = {**os.environ, "UNDERSTUDY_WORKLOAD_ROOT": W}
    r = run([f"{SK}/package-verifier-env/examples/return_eval.py", "POL"], env=env)
    ok = r.returncode == 0 and json.loads(r.stdout)["attestation"]["same_rows"] is True
    check("return_eval runs on matching hash + attests", ok, r.stderr)

    # tamper splits.json -> hash drift -> must refuse
    open(f"{ev}/splits.json", "w").write('{"seed":7,"holdout":{"row_ids":["h0","h1","h2"]}}')
    r = run([f"{SK}/package-verifier-env/examples/return_eval.py", "POL"], env=env)
    check("return_eval REFUSES on holdout drift", r.returncode != 0 and "REFUSED" in (r.stdout + r.stderr))

    r = run([f"{SK}/package-verifier-env/examples/pi_verifiers_env.py"], env=env)
    check("pi_verifiers_env skeleton runs", r.returncode == 0 and "conformance" in r.stdout, r.stderr)


# 4. SKILL.md frontmatter + intra-repo link lint -----------------------------
print("== frontmatter + link lint ==")
existing = {d for d in os.listdir(SK) if os.path.isdir(f"{SK}/{d}")}
for s in NEW_SKILLS:
    txt = open(f"{SK}/{s}/SKILL.md").read()
    m = re.match(r"^---\n(.*?)\n---\n", txt, re.S)
    fm = m.group(1) if m else ""
    name_m = re.search(r"^name:\s*(\S+)", fm, re.M)
    check(f"{s}: frontmatter present + name matches dir",
          bool(m) and name_m and name_m.group(1) == s)
    check(f"{s}: required metadata keys",
          all(k in fm for k in ("description:", "mode:", "safety:", "cli_required:")))
    broken = [l for l in re.findall(r"\]\(\.\./([a-z0-9-]+)/SKILL\.md\)", txt) if l not in existing]
    check(f"{s}: all skill links resolve", not broken, f"broken: {broken}")


print()
if fails:
    print(f"FAILED ({len(fails)}): {fails}")
    sys.exit(1)
print("ALL RL-SKILL SELF-TESTS PASSED")
