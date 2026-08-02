"""Cookbook GRPO runner for the AutomationBench Tinker arm.

The environment is intentionally a thin HTTP-backed wrapper around the Node
AutomationBench evaluator. The cookbook owns rollout, token-level
importance-sampling, group-relative advantages, and checkpointing.

This is structurally a Verifiers-style MultiTurnEnv, but does not install the
verifiers package: the local Node evaluator is the verifier and terminal
reward is its ``partialCredit`` result reached over HTTP.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import random
import statistics
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Sequence

import chz
import tinker
from tinker_cookbook import renderers
from tinker_cookbook.completers import StopCondition
from tinker_cookbook.renderers import Message, get_text_content
from tinker_cookbook.rl import rollouts, train
from tinker_cookbook.rl.types import (
    ActionExtra,
    Env,
    EnvGroupBuilder,
    Metrics,
    RLDataset,
    RLDatasetBuilder,
    StepResult,
    Trajectory,
)
from tinker_cookbook.tokenizer_utils import get_tokenizer

from env_client import close_service, get_service
from receipts import snapshot_usage_async, usage_delta
from rollout import (
    LORA_RANK,
    MAX_MODEL_TURNS,
    MAX_TOKENS,
    MODEL_NAME,
    RENDERER_DEVIATION,
    RENDERER_NAME,
    parse_agent_action,
)

REPO = Path(__file__).resolve().parents[2]
EXPERIMENT_DIR = Path(__file__).resolve().parent
ARTIFACT_DIR = EXPERIMENT_DIR / "artifacts"
SFT_STATE_PATH = (
    "tinker://9d8f6a98-d663-5627-8dd7-96571e243b4c:train:0/weights/sft-epoch4-state"
)
GROUP_SIZE = 8
GROUPS_PER_BATCH = 8
DATASET_SEED = 7
LEARNING_RATE = 1e-5

RL_DEVIATION = (
    "This is a Verifiers-style MultiTurnEnv in structure, but the verifiers "
    "package is intentionally not installed. The Node AutomationBench service "
    "is the verifier; its terminal reward is literally partialCredit from "
    "src/automationbench-offline.ts reached over HTTP, so remote reward equals "
    "local reward by construction."
)


@dataclass
class StepTelemetry:
    step: int
    started_at: float
    groups: int = 0
    constant_groups: int = 0
    rewards: list[float] = field(default_factory=list)
    sampled_tokens: int = 0
    prompt_tokens: int = 0
    last_group_at: float | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "step": self.step,
            "groups": self.groups,
            "constant_groups": self.constant_groups,
            "constant_group_fraction": (
                self.constant_groups / self.groups if self.groups else 0.0
            ),
            "mean_group_reward": (
                statistics.fmean(self.rewards) if self.rewards else None
            ),
            "sampled_tokens": self.sampled_tokens,
            "prompt_tokens": self.prompt_tokens,
            "wall_clock_seconds": (
                (self.last_group_at - self.started_at)
                if self.last_group_at is not None
                else None
            ),
        }


@dataclass
class RLTelemetry:
    steps: dict[int, StepTelemetry] = field(default_factory=dict)
    total_groups: int = 0
    total_constant_groups: int = 0
    exemplar: dict[str, Any] | None = None

    def begin_step(self, step: int) -> None:
        self.steps[step] = StepTelemetry(step=step, started_at=time.monotonic())

    def record_group(
        self,
        step: int,
        rewards: list[float],
        trajectories: Sequence[Trajectory],
        envs: Sequence["AutomationBenchEnv"],
    ) -> None:
        telemetry = self.steps.setdefault(
            step, StepTelemetry(step=step, started_at=time.monotonic())
        )
        telemetry.groups += 1
        telemetry.rewards.extend(rewards)
        telemetry.sampled_tokens += sum(
            len(transition.ac.tokens)
            for trajectory in trajectories
            for transition in trajectory.transitions
        )
        telemetry.prompt_tokens += sum(
            transition.ob.length
            for trajectory in trajectories
            for transition in trajectory.transitions
        )
        telemetry.last_group_at = time.monotonic()
        self.total_groups += 1
        if len(set(rewards)) == 1:
            telemetry.constant_groups += 1
            self.total_constant_groups += 1
        if self.exemplar is None and envs:
            self.exemplar = {
                "step": step,
                "task_id": envs[0].task["task_id"],
                "reward": rewards[0] if rewards else None,
                "messages": list(envs[0].messages),
            }

    def as_dict(self) -> dict[str, Any]:
        return {
            "steps": [self.steps[key].as_dict() for key in sorted(self.steps)],
            "total_groups": self.total_groups,
            "total_constant_groups": self.total_constant_groups,
            "constant_group_fraction": (
                self.total_constant_groups / self.total_groups
                if self.total_groups
                else 0.0
            ),
            "exemplar": self.exemplar,
        }


RL_TELEMETRY = RLTelemetry()


def _prompt_token_count(model_input: tinker.ModelInput) -> int:
    return sum(
        len(getattr(chunk, "tokens", []))
        for chunk in model_input.chunks
        if hasattr(chunk, "tokens")
    )


class AutomationBenchEnv(Env):
    """One single-use AutomationBench episode."""

    def __init__(
        self,
        task: dict[str, Any],
        repo: str,
        renderer: renderers.Renderer,
        service: Any,
        training_step: int,
    ):
        self.task = task
        self.repo = repo
        self.renderer = renderer
        self.service = service
        self.training_step = training_step
        self.episode_id: str | None = None
        self.messages: list[Message] = []
        self.model_turns = 0
        self.env_steps = 0
        self.terminal: dict[str, Any] | None = None

    async def initial_observation(
        self,
    ) -> tuple[tinker.ModelInput, StopCondition]:
        reset = await asyncio.to_thread(self.service.reset, self.task["task_id"], None)
        self.episode_id = reset["episode_id"]
        self.messages = [
            {"role": "system", "content": reset["system_prompt"]},
            {"role": "user", "content": reset["prompt"]},
        ]
        return self.renderer.build_generation_prompt(self.messages), self.renderer.get_stop_sequences()

    async def _finish(self) -> dict[str, Any]:
        if self.terminal is None:
            if self.episode_id is None:
                raise RuntimeError("cannot finish an episode before reset")
            self.terminal = await asyncio.to_thread(self.service.finish, self.episode_id)
        return self.terminal

    async def step(
        self,
        action: list[int],
        *,
        extra: ActionExtra | None = None,
    ) -> StepResult:
        del extra
        self.model_turns += 1
        assistant_message, _termination = self.renderer.parse_response(action)
        assistant_text = get_text_content(assistant_message)
        self.messages.append({"role": "assistant", "content": assistant_text})
        parsed = parse_agent_action(assistant_text)

        if "error" in parsed:
            self.messages.append(
                {
                    "role": "tool",
                    "content": json.dumps(
                        {
                            "error": (
                                f"{parsed['error']}. Reply with exactly one JSON object."
                            )
                        },
                        separators=(",", ":"),
                    ),
                }
            )
            if self.model_turns >= MAX_MODEL_TURNS:
                terminal = await self._finish()
                return self._terminal_result(terminal, "max_turns")
            return self._next_result(
                reward=0.0,
                episode_done=False,
                metrics={"parse_error": 1, "reward_weight": 0.0},
            )

        if parsed.get("finish") is True:
            terminal = await self._finish()
            return self._terminal_result(terminal, "completed")

        if self.episode_id is None:
            raise RuntimeError("episode was not reset before step")
        step_result = await asyncio.to_thread(
            self.service.step,
            self.episode_id,
            parsed["name"],
            parsed["arguments"],
        )
        self.env_steps += 1
        self.messages.append({"role": "tool", "content": step_result["observation"]})
        if self.model_turns >= MAX_MODEL_TURNS:
            terminal = await self._finish()
            return self._terminal_result(terminal, "max_turns")
        return self._next_result(
            reward=0.0,
            episode_done=False,
            metrics={"env_steps": self.env_steps, "reward_weight": 0.0},
        )

    def _next_result(
        self,
        reward: float,
        episode_done: bool,
        metrics: Metrics,
    ) -> StepResult:
        return StepResult(
            reward=reward,
            episode_done=episode_done,
            next_observation=self.renderer.build_generation_prompt(self.messages),
            next_stop_condition=self.renderer.get_stop_sequences(),
            metrics=metrics,
        )

    def _terminal_result(self, terminal: dict[str, Any], reason: str) -> StepResult:
        return self._next_result(
            reward=float(terminal["reward"]),
            episode_done=True,
            metrics={
                "terminal_reward": float(terminal["reward"]),
                "env_steps": self.env_steps,
                "forbidden_effects": len(terminal.get("forbidden_effects", [])),
                f"stop/{reason}": 1.0,
            },
        )

    async def close(self) -> None:
        if self.episode_id is not None:
            try:
                await asyncio.to_thread(self.service.delete_episode, self.episode_id)
            finally:
                self.episode_id = None


class AutomationBenchGroupBuilder(EnvGroupBuilder):
    """Builds one same-task group so advantages are within-task."""

    def __init__(
        self,
        task: dict[str, Any],
        repo: str,
        renderer_name: str,
        model_name: str,
        group_size: int,
        training_step: int,
    ):
        self.task = task
        self.repo = repo
        self.renderer_name = renderer_name
        self.model_name = model_name
        self.group_size = group_size
        self.training_step = training_step
        self._envs: list[AutomationBenchEnv] = []

    async def make_envs(self) -> Sequence[Env]:
        if self.task.get("split") != "train":
            raise RuntimeError(
                f"RL dataset attempted non-train task: {self.task.get('task_id')}"
            )
        service = get_service(self.repo)
        tokenizer = get_tokenizer(self.model_name)
        renderer = renderers.get_renderer(
            self.renderer_name,
            tokenizer,
            model_name=self.model_name,
        )
        self._envs = [
            AutomationBenchEnv(
                task=self.task,
                repo=self.repo,
                renderer=renderer,
                service=service,
                training_step=self.training_step,
            )
            for _ in range(self.group_size)
        ]
        return self._envs

    async def compute_group_rewards(
        self,
        trajectory_group: list[Trajectory],
        env_group: Sequence[Env],
    ) -> list[tuple[float, Metrics]]:
        rewards = [
            sum(transition.reward for transition in trajectory.transitions)
            for trajectory in trajectory_group
        ]
        envs = [env for env in env_group if isinstance(env, AutomationBenchEnv)]
        RL_TELEMETRY.record_group(self.training_step, rewards, trajectory_group, envs)
        group_mean = statistics.fmean(rewards) if rewards else 0.0
        # Terminal rewards are returned by Env.step. This hook adds no reward.
        return [
            (
                0.0,
                {
                    "group_mean_reward": group_mean,
                    "terminal_reward": reward,
                },
            )
            for reward in rewards
        ]

    async def cleanup(self) -> None:
        await asyncio.gather(*(env.close() for env in self._envs))
        self._envs = []

    def logging_tags(self) -> list[str]:
        return ["automationbench", self.task["task_id"], self.task["band"]]


class AutomationBenchRLDataset(RLDataset):
    """Train-only cyclic dataset with deterministic per-epoch shuffling."""

    def __init__(
        self,
        tasks: list[dict[str, Any]],
        groups_per_batch: int,
        group_size: int,
        max_steps: int,
        seed: int,
        repo: str,
        renderer_name: str,
        model_name: str,
    ):
        if any(task.get("split") != "train" for task in tasks):
            raise RuntimeError("AutomationBenchRLDataset received a non-train task")
        self.tasks = tasks
        self.groups_per_batch = groups_per_batch
        self.group_size = group_size
        self.max_steps = max_steps
        self.seed = seed
        self.repo = repo
        self.renderer_name = renderer_name
        self.model_name = model_name
        self.batches_per_epoch = (len(tasks) + groups_per_batch - 1) // groups_per_batch

    def __len__(self) -> int:
        return self.max_steps

    def get_batch(self, index: int) -> Sequence[EnvGroupBuilder]:
        epoch = index // self.batches_per_epoch
        batch_index = index % self.batches_per_epoch
        order = list(self.tasks)
        random.Random(self.seed + epoch).shuffle(order)
        start = batch_index * self.groups_per_batch
        selected = order[start : start + self.groups_per_batch]
        if len(selected) != self.groups_per_batch:
            raise RuntimeError("train task batch was unexpectedly incomplete")
        RL_TELEMETRY.begin_step(index)
        return [
            AutomationBenchGroupBuilder(
                task=task,
                repo=self.repo,
                renderer_name=self.renderer_name,
                model_name=self.model_name,
                group_size=self.group_size,
                training_step=index,
            )
            for task in selected
        ]


@chz.chz
class AutomationBenchRLDatasetBuilder(RLDatasetBuilder):
    groups_per_batch: int = GROUPS_PER_BATCH
    group_size: int = GROUP_SIZE
    max_steps: int = 2
    seed: int = DATASET_SEED
    repo: str = str(REPO)
    renderer_name: str = RENDERER_NAME
    model_name: str = MODEL_NAME

    async def __call__(self) -> tuple[RLDataset, RLDataset | None]:
        service = get_service(self.repo)
        tasks = service.tasks("train")
        if len(tasks) != 48:
            raise RuntimeError(f"expected 48 train tasks, got {len(tasks)}")
        if any(task.get("split") != "train" for task in tasks):
            raise RuntimeError("dataset builder received a non-train task")
        return (
            AutomationBenchRLDataset(
                tasks=tasks,
                groups_per_batch=self.groups_per_batch,
                group_size=self.group_size,
                max_steps=self.max_steps,
                seed=self.seed,
                repo=self.repo,
                renderer_name=self.renderer_name,
                model_name=self.model_name,
            ),
            None,
        )


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", choices=("1", "2"), default="1")
    parser.add_argument("--max-steps", type=int)
    parser.add_argument("--log-path")
    parser.add_argument("--load-checkpoint-path", default=SFT_STATE_PATH)
    return parser.parse_args()


def _checkpoint_records(log_path: Path) -> list[dict[str, Any]]:
    path = log_path / "checkpoints.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


async def _run_stage(args: argparse.Namespace) -> None:
    max_steps = args.max_steps or (2 if args.stage == "1" else 40)
    if max_steps < 1:
        raise SystemExit("--max-steps must be positive")
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    log_path = Path(args.log_path or (ARTIFACT_DIR / f"grpo-stage{args.stage}-log"))
    log_path.mkdir(parents=True, exist_ok=True)

    service_client = tinker.ServiceClient()
    rest_client = service_client.create_rest_client()
    usage_before = await snapshot_usage_async(rest_client)
    started = time.monotonic()
    try:
        config = train.Config(
            learning_rate=LEARNING_RATE,
            dataset_builder=AutomationBenchRLDatasetBuilder(
                groups_per_batch=GROUPS_PER_BATCH,
                group_size=GROUP_SIZE,
                max_steps=max_steps,
                seed=DATASET_SEED,
            ),
            model_name=MODEL_NAME,
            recipe_name="automationbench_qwen3_grpo",
            max_tokens=MAX_TOKENS,
            log_path=str(log_path),
            eval_every=0,
            save_every=5,
            load_checkpoint_path=args.load_checkpoint_path,
            renderer_name=RENDERER_NAME,
            kl_penalty_coef=0.0,
            loss_fn="importance_sampling",
            num_substeps=1,
            lora_rank=LORA_RANK,
            temperature=1.0,
            remove_constant_reward_groups=True,
            max_steps=max_steps,
            rollout_json_export=True,
        )
        await train.main(config)
    finally:
        close_service()
    elapsed = time.monotonic() - started
    usage_after = await snapshot_usage_async(rest_client)

    telemetry = RL_TELEMETRY.as_dict()
    telemetry.update(
        {
            "stage": args.stage,
            "max_steps": max_steps,
            "wall_clock_seconds": elapsed,
            "model": MODEL_NAME,
            "renderer": RENDERER_NAME,
            "lora_rank": LORA_RANK,
            "max_tokens": MAX_TOKENS,
            "group_size": GROUP_SIZE,
            "groups_per_batch": GROUPS_PER_BATCH,
            "dataset_seed": DATASET_SEED,
            "load_checkpoint_path": args.load_checkpoint_path,
            "remove_constant_reward_groups": True,
            "constant_group_rationale": (
                "Most groups are already saturated after SFT; removing constant "
                "reward groups saves budget and is standard GRPO practice."
            ),
            "rl_deviation": RL_DEVIATION,
        }
    )
    telemetry_path = ARTIFACT_DIR / f"grpo-stage{args.stage}-telemetry.json"
    telemetry_path.write_text(json.dumps(telemetry, indent=2, sort_keys=True) + "\n")
    receipt = {
        "phase": f"grpo-stage{args.stage}",
        "before": usage_before,
        "after": usage_after,
        "delta": usage_delta(usage_before, usage_after),
    }
    (ARTIFACT_DIR / f"grpo-stage{args.stage}.usage.json").write_text(
        json.dumps(receipt, indent=2, sort_keys=True) + "\n"
    )
    checkpoint_records = _checkpoint_records(log_path)
    (ARTIFACT_DIR / f"grpo-stage{args.stage}-checkpoints.json").write_text(
        json.dumps(
            {
                "log_path": str(log_path),
                "records": checkpoint_records,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n"
    )
    if args.stage == "1":
        steps = telemetry["steps"]
        sampled = [item["sampled_tokens"] for item in steps]
        wall = [item["wall_clock_seconds"] for item in steps]
        projection = {
            "measured_steps": len(steps),
            "mean_sampled_tokens_per_step": statistics.fmean(sampled) if sampled else 0.0,
            "mean_rollout_wall_clock_seconds_per_step": (
                statistics.fmean(wall) if wall else 0.0
            ),
            "projected_40_step_sampled_tokens": (
                statistics.fmean(sampled) * 40 if sampled else 0.0
            ),
            "projected_40_step_rollout_wall_clock_seconds": (
                statistics.fmean(wall) * 40 if wall else 0.0
            ),
        }
        (ARTIFACT_DIR / "grpo-stage1-projection.json").write_text(
            json.dumps(projection, indent=2, sort_keys=True) + "\n"
        )
    print(json.dumps({"telemetry": telemetry, "checkpoints": checkpoint_records}, indent=2))


def _evaluate_stage2_checkpoints(log_path: Path) -> None:
    records = _checkpoint_records(log_path)
    table: list[dict[str, Any]] = []
    for step in (10, 20, 30, 40):
        matches = [
            record
            for record in records
            if int(record.get("batch", -1)) == step and record.get("sampler_path")
        ]
        if not matches:
            raise RuntimeError(f"missing sampler checkpoint for step {step}")
        checkpoint = matches[-1]
        output = ARTIFACT_DIR / f"grpo-step{step}-dev.jsonl"
        command = [
            sys.executable,
            str(EXPERIMENT_DIR / "evaluate.py"),
            "--split",
            "dev",
            "--model-path",
            checkpoint["sampler_path"],
            "--label",
            f"grpo-step{step}-dev",
            "--temperature",
            "0.0",
            "--samples",
            "1",
            "--out",
            str(output),
        ]
        import subprocess

        subprocess.run(command, cwd=REPO, check=True)
        summary = json.loads(output.with_suffix(".summary.json").read_text())
        table.append(
            {
                "step": step,
                "sampler_path": checkpoint["sampler_path"],
                "mean_reward": summary["mean_reward"],
                "strict_pass_rate": summary["strict_pass_rate"],
                "summary_path": str(output.with_suffix(".summary.json")),
            }
        )
    sft_dev = json.loads(
        (ARTIFACT_DIR / "sft-epoch4-dev.summary.json").read_text()
    )
    (ARTIFACT_DIR / "grpo-dev-table.json").write_text(
        json.dumps(
            {
                "sft_epoch4": {
                    "mean_reward": sft_dev["mean_reward"],
                    "strict_pass_rate": sft_dev["strict_pass_rate"],
                    "summary_path": str(ARTIFACT_DIR / "sft-epoch4-dev.summary.json"),
                },
                "grpo_checkpoints": table,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n"
    )


async def main() -> None:
    args = _parse_args()
    await _run_stage(args)
    if args.stage == "2":
        _evaluate_stage2_checkpoints(
            Path(args.log_path or (ARTIFACT_DIR / "grpo-stage2-log"))
        )


if __name__ == "__main__":
    asyncio.run(main())
