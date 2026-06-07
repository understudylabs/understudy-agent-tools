import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// Runs the Python self-test for the RL-handoff skill pipeline
// (author-rl-env, compare-trajectories, curate-trajectories, package-verifier-env):
// each example script's self-test, the curate index->select hygiene gates, the
// return-eval drift refusal, and the SKILL.md frontmatter/link lint.
test('RL-handoff skill examples self-test', () => {
  const py = process.env.PYTHON || 'python3';
  const res = spawnSync(py, [join(here, 'rl_skills_selftest.py')], { encoding: 'utf8' });
  if (res.error && res.error.code === 'ENOENT') {
    // No python3 on this runner — skip rather than fail the JS suite.
    console.warn('skipping: python3 not found');
    return;
  }
  if (res.status !== 0) {
    console.error(res.stdout);
    console.error(res.stderr);
  }
  assert.strictEqual(res.status, 0, 'rl_skills_selftest.py must pass');
});
