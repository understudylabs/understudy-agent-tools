"""No-keys end-to-end demo: the launch gate catching an intermittent
output-contract regression through the REAL verifiers rollout loop.

Two scripted "models" (mock_model_server.py) play the task end to end —
tool call, account lookup, bare-JSON answer:

  incumbent — always honors the playbook's output contract
  candidate — same policy, but every 5th final answer arrives wrapped in
              markdown fences: valid JSON a structured-output parse can't
              use. 20% intermittent contract failure; zero HTTP errors.

Both arms run through verifiers' own client/rollout/scoring machinery
(`env.evaluate_sync`, rollouts_per_example=5 → 60 rollouts per arm). The
demo prints the per-axis rate table and asserts the gate BLOCKS the
candidate on structured_output_ok while quality stays flat — the exact
failure class that error/latency dashboards cannot see.

Run: uv run --with verifiers==0.2.0 --prerelease=allow --no-project demo_gate.py
"""

import os

from verifiers.types import ClientConfig

from event_categorizer import load_environment
from mock_model_server import start

AXES = ("structured_output_ok", "tool_calls_ok", "nonempty_ok")
ROLLOUTS_PER_TASK = 5


def run_arm(env, model_name, server):
    config = ClientConfig(
        client_type="openai_chat_completions",
        api_key_var="DEMO_NOOP_KEY",
        api_base_url=server.base_url,
    )
    results = env.evaluate_sync(
        config,
        model=model_name,
        rollouts_per_example=ROLLOUTS_PER_TASK,
        max_concurrent=8,
    )
    outputs = results["outputs"]
    rates = {
        axis: sum(out["metrics"][axis] for out in outputs) / len(outputs)
        for axis in AXES
    }
    rates["quality (reward)"] = sum(out["reward"] for out in outputs) / len(outputs)
    return rates, len(outputs)


def main():
    os.environ.setdefault("DEMO_NOOP_KEY", "demo")
    incumbent_server = start(fence_every=None)
    candidate_server = start(fence_every=5)
    env = load_environment()

    incumbent, n_inc = run_arm(env, "scripted-incumbent", incumbent_server)
    candidate, n_cand = run_arm(env, "scripted-candidate", candidate_server)

    print(f"\n{'axis':<24}{'incumbent':>12}{'candidate':>12}")
    for axis in [*AXES, "quality (reward)"]:
        print(f"{axis:<24}{incumbent[axis]:>12.2f}{candidate[axis]:>12.2f}")
    print(f"rollouts per arm: {n_inc} / {n_cand}")

    assert incumbent["structured_output_ok"] == 1.0, "incumbent arm must be contract-clean"
    assert incumbent["quality (reward)"] == 1.0, (
        "scripted policy must score 1.0 vs gold — env, tasks, and rubric agree"
    )
    assert candidate["structured_output_ok"] < incumbent["structured_output_ok"] - 0.01, (
        "gate FAILED to catch the fenced-JSON regression"
    )
    assert abs(candidate["quality (reward)"] - incumbent["quality (reward)"]) < 0.05, (
        "quality axes must NOT see this bug — that separation is the point"
    )

    print(
        "\nVERDICT: block — structured_output_ok "
        f"{incumbent['structured_output_ok']:.0%} → {candidate['structured_output_ok']:.0%} "
        "while quality stayed flat. The gate catches what dashboards can't."
    )


if __name__ == "__main__":
    main()
