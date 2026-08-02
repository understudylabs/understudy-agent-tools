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
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Sequence

import chz
import tinker
from tinker_cookbook import renderers
from tinker_cookbook.completers import StopCondition
from tinker_cookbook.eval.evaluators import SamplingClientEvaluator
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
    rollout_task,
    RolloutConfig,
)

REPO = Path(__file__).resolve().parents[2]
EXPERIMENT_DIR = Path(__file__).resolve().parent
ARTIFACT_DIR = EXPERIMENT_DIR / "artifacts"
SFT_STATE_PATH = (
    "tinker://e3e3d392-c8f0-5889-9f91-423a28a12163:train:0/weights/sft-epoch4-state"
)
GROUP_SIZE = 8
GROUPS_PER_BATCH = 8
DATASET_SEED = 7
LEARNING_RATE = 1e-5
EXPECTED_TRAIN_TASKS = 48
DEV_EVAL_EVERY = 15
DEV_PLATEAU_PATIENCE = 3
DEV_PLATEAU_FLOOR = 100
CAP_MULT = 0.20

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
    raw_rewards: list[float] = field(default_factory=list)
    shaped_rewards: list[float] = field(default_factory=list)
    env_steps: list[float] = field(default_factory=list)
    model_turns: list[float] = field(default_factory=list)
    parse_errors: list[float] = field(default_factory=list)
    explicit_finishes: list[float] = field(default_factory=list)
    forbidden_rollouts: list[float] = field(default_factory=list)

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
            "mean_group_raw_reward": (
                statistics.fmean(self.raw_rewards) if self.raw_rewards else None
            ),
            "mean_group_shaped_reward": (
                statistics.fmean(self.shaped_rewards) if self.shaped_rewards else None
            ),
            "mean_env_steps": statistics.fmean(self.env_steps) if self.env_steps else 0.0,
            "mean_model_turns": statistics.fmean(self.model_turns) if self.model_turns else 0.0,
            "mean_parse_error_count": (
                statistics.fmean(self.parse_errors) if self.parse_errors else 0.0
            ),
            "explicit_finish_rate": (
                statistics.fmean(self.explicit_finishes)
                if self.explicit_finishes
                else 0.0
            ),
            "forbidden_effect_rate": (
                statistics.fmean(self.forbidden_rollouts)
                if self.forbidden_rollouts
                else 0.0
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
        for env in envs:
            metrics = env.rollout_metrics
            if metrics is None:
                continue
            telemetry.raw_rewards.append(metrics["terminal_reward"])
            telemetry.shaped_rewards.append(metrics["shaped_reward"])
            telemetry.env_steps.append(metrics["env_steps"])
            telemetry.model_turns.append(metrics["model_turns"])
            telemetry.parse_errors.append(metrics["parse_errors"])
            telemetry.explicit_finishes.append(metrics["explicit_finish"])
            telemetry.forbidden_rollouts.append(metrics["forbidden_effects"] > 0)
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
        oracle_steps: dict[str, int],
        lambda_step: float,
        lambda_noexit: float,
        lambda_fw: float,
        cap_mult: float,
    ):
        self.task = task
        self.repo = repo
        self.renderer = renderer
        self.service = service
        self.training_step = training_step
        self.oracle_steps = oracle_steps
        self.lambda_step = lambda_step
        self.lambda_noexit = lambda_noexit
        self.lambda_fw = lambda_fw
        self.cap_mult = cap_mult
        self.episode_id: str | None = None
        self.messages: list[Message] = []
        self.model_turns = 0
        self.env_steps = 0
        self.terminal: dict[str, Any] | None = None
        self.rollout_metrics: dict[str, float] | None = None

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
        terminal_reward = float(terminal["reward"])
        forbidden_effects = len(terminal.get("forbidden_effects", []))
        oracle_steps = self.oracle_steps.get(self.task["task_id"])
        if oracle_steps is None:
            raise RuntimeError(f"missing oracle step count for {self.task['task_id']}")
        excess_ratio = max(
            0.0,
            min(1.0, (self.env_steps - oracle_steps) / max(1, oracle_steps)),
        )
        noexit = 1.0 if reason == "max_turns" else 0.0
        soft_penalty = min(
            self.cap_mult,
            self.lambda_step * excess_ratio + self.lambda_noexit * noexit,
        )
        shaped_reward = terminal_reward * (1.0 - soft_penalty) - self.lambda_fw * min(
            1, forbidden_effects
        )
        self.rollout_metrics = {
            "terminal_reward": terminal_reward,
            "shaped_reward": shaped_reward,
            "soft_penalty": soft_penalty,
            "length_penalty": self.lambda_step * excess_ratio,
            "noexit_penalty": self.lambda_noexit * noexit,
            "forbidden_write_penalty": self.lambda_fw * min(1, forbidden_effects),
            "env_steps": float(self.env_steps),
            "model_turns": float(self.model_turns),
            "parse_errors": float(sum(1 for message in self.messages if message["role"] == "tool" and '"error"' in message["content"])),
            "explicit_finish": float(reason == "completed"),
            "forbidden_effects": float(forbidden_effects),
        }
        return self._next_result(
            reward=shaped_reward,
            episode_done=True,
            metrics={
                "terminal_reward": terminal_reward,
                "shaped_reward": shaped_reward,
                "soft_penalty": soft_penalty,
                "length_penalty": self.lambda_step * excess_ratio,
                "noexit_penalty": self.lambda_noexit * noexit,
                "forbidden_write_penalty": self.lambda_fw * min(1, forbidden_effects),
                "env_steps": self.env_steps,
                "forbidden_effects": forbidden_effects,
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
        oracle_steps: dict[str, int],
        lambda_step: float,
        lambda_noexit: float,
        lambda_fw: float,
        cap_mult: float,
    ):
        self.task = task
        self.repo = repo
        self.renderer_name = renderer_name
        self.model_name = model_name
        self.group_size = group_size
        self.training_step = training_step
        self.oracle_steps = oracle_steps
        self.lambda_step = lambda_step
        self.lambda_noexit = lambda_noexit
        self.lambda_fw = lambda_fw
        self.cap_mult = cap_mult
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
                oracle_steps=self.oracle_steps,
                lambda_step=self.lambda_step,
                lambda_noexit=self.lambda_noexit,
                lambda_fw=self.lambda_fw,
                cap_mult=self.cap_mult,
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
        return [
            (
                0.0,
                {
                    "group_mean_reward": group_mean,
                    **(
                        env.rollout_metrics
                        if env.rollout_metrics is not None
                        else {"terminal_reward": reward, "shaped_reward": reward}
                    ),
                },
            )
            for reward, env in zip(rewards, envs, strict=True)
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
        oracle_steps: dict[str, int],
        lambda_step: float,
        lambda_noexit: float,
        lambda_fw: float,
        cap_mult: float,
        expected_train_tasks: int,
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
        self.oracle_steps = oracle_steps
        self.lambda_step = lambda_step
        self.lambda_noexit = lambda_noexit
        self.lambda_fw = lambda_fw
        self.cap_mult = cap_mult
        self.expected_train_tasks = expected_train_tasks
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
                oracle_steps=self.oracle_steps,
                lambda_step=self.lambda_step,
                lambda_noexit=self.lambda_noexit,
                lambda_fw=self.lambda_fw,
                cap_mult=self.cap_mult,
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
    oracle_steps: dict[str, int] = chz.field(default_factory=dict)
    lambda_step: float = 0.0
    lambda_noexit: float = 0.0
    lambda_fw: float = 0.0
    cap_mult: float = CAP_MULT
    expected_train_tasks: int = EXPECTED_TRAIN_TASKS

    async def __call__(self) -> tuple[RLDataset, RLDataset | None]:
        service = get_service(self.repo)
        tasks = service.tasks("train")
        if len(tasks) != self.expected_train_tasks:
            raise RuntimeError(
                f"expected {self.expected_train_tasks} train tasks, got {len(tasks)}"
            )
        if any(task.get("split") != "train" for task in tasks):
            raise RuntimeError("dataset builder received a non-train task")
        oracle_steps = self.oracle_steps or _load_oracle_steps(
            self.repo,
            ARTIFACT_DIR / "oracle-train.jsonl",
            self.expected_train_tasks,
        )
        missing = [task["task_id"] for task in tasks if task["task_id"] not in oracle_steps]
        if missing:
            raise RuntimeError(f"missing oracle step counts for train tasks: {missing}")
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
                oracle_steps=oracle_steps,
                lambda_step=self.lambda_step,
                lambda_noexit=self.lambda_noexit,
                lambda_fw=self.lambda_fw,
                cap_mult=self.cap_mult,
                expected_train_tasks=self.expected_train_tasks,
            ),
            None,
        )


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", choices=("1", "2"), default="1")
    parser.add_argument("--max-steps", type=int)
    parser.add_argument("--log-path")
    parser.add_argument("--load-checkpoint-path", default=SFT_STATE_PATH)
    parser.add_argument("--lora-rank", type=int, default=LORA_RANK)
    parser.add_argument("--group-size", type=int, default=GROUP_SIZE)
    parser.add_argument("--groups-per-batch", type=int, default=GROUPS_PER_BATCH)
    parser.add_argument("--learning-rate", type=float, default=LEARNING_RATE)
    parser.add_argument("--run-label")
    parser.add_argument("--expected-train-tasks", type=int, default=EXPECTED_TRAIN_TASKS)
    parser.add_argument("--lambda-step", type=float, default=0.0)
    parser.add_argument("--lambda-noexit", type=float, default=0.0)
    parser.add_argument("--lambda-fw", type=float, default=0.0)
    parser.add_argument("--cap-mult", type=float, default=CAP_MULT)
    return parser.parse_args()


def _load_oracle_steps(
    repo: str,
    oracle_path: Path,
    expected_train_tasks: int,
) -> dict[str, int]:
    oracle_path.parent.mkdir(parents=True, exist_ok=True)
    if not oracle_path.exists():
        subprocess.run(
            [
                "node",
                "scripts/automationbench-oracle-trajectories.mjs",
                "--out",
                str(oracle_path),
            ],
            cwd=repo,
            check=True,
        )
    rows = [
        json.loads(line)
        for line in oracle_path.read_text().splitlines()
        if line.strip()
    ]
    if len(rows) != expected_train_tasks:
        raise RuntimeError(
            f"expected {expected_train_tasks} oracle rows, got {len(rows)}"
        )
    result: dict[str, int] = {}
    for row in rows:
        if row.get("split") != "train":
            raise RuntimeError(f"oracle row is not train-only: {row.get('task_id')}")
        if row.get("reward") != 1:
            raise RuntimeError(f"oracle reward is not 1.0: {row.get('task_id')}")
        calls = [
            message
            for message in row.get("messages", [])
            if message.get("role") == "assistant"
            and not (
                isinstance(message.get("content"), str)
                and '"finish":true' in message["content"].replace(" ", "")
            )
        ]
        if not calls:
            raise RuntimeError(f"oracle has no tool calls: {row.get('task_id')}")
        result[row["task_id"]] = len(calls)
    return result


def _checkpoint_records(log_path: Path) -> list[dict[str, Any]]:
    path = log_path / "checkpoints.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


class DevPlateauStop(RuntimeError):
    """Raised when raw reward and behavior metrics plateau together."""


class DevEvaluator(SamplingClientEvaluator):
    def __init__(
        self,
        service: Any,
        tasks: list[dict[str, Any]],
        model_name: str,
        renderer_name: str,
        output_path: Path,
        run_label: str,
    ):
        if any(task.get("split") != "dev" for task in tasks):
            raise RuntimeError("dev evaluator received a non-dev task")
        self.service = service
        self.tasks = tasks
        self.model_name = model_name
        self.renderer_name = renderer_name
        self.output_path = output_path
        self.run_label = run_label
        prior_rows = (
            [
                json.loads(line)
                for line in output_path.read_text().splitlines()
                if line.strip()
            ]
            if output_path.exists()
            else []
        )
        self.eval_index = len(prior_rows)
        self.best_mean = max(
            (float(row["mean_reward"]) for row in prior_rows),
            default=float("-inf"),
        )
        self.stale_evals = int(prior_rows[-1].get("stale_evals", 0)) if prior_rows else 0
        self.behavior_stale_evals = (
            int(prior_rows[-1].get("behavior_stale_evals", 0))
            if prior_rows
            else 0
        )
        self.previous_behavior: tuple[float, float, float, float] | None = None
        if prior_rows:
            previous = prior_rows[-1]
            self.previous_behavior = (
                float(previous["mean_env_steps"]),
                float(previous["explicit_finish_rate"]),
                float(previous["forbidden_effect_rate"]),
                float(previous["parse_error_rate"]),
            )

    async def __call__(self, sampling_client: tinker.SamplingClient) -> dict[str, float]:
        tokenizer = get_tokenizer(self.model_name)
        renderer = renderers.get_renderer(
            self.renderer_name,
            tokenizer,
            model_name=self.model_name,
        )
        records = await asyncio.gather(
            *[
                rollout_task(
                    self.service,
                    sampling_client,
                    renderer,
                    task,
                    RolloutConfig(temperature=0.0),
                )
                for task in self.tasks
            ]
        )
        mean_reward = statistics.fmean(record["reward"] for record in records)
        behavior = (
            statistics.fmean(record["env_steps"] for record in records),
            statistics.fmean(record["finished_explicitly"] for record in records),
            statistics.fmean(bool(record["forbidden_effects"]) for record in records),
            statistics.fmean(bool(record["parse_errors"]) for record in records),
        )
        if mean_reward > self.best_mean:
            self.best_mean = mean_reward
            self.stale_evals = 0
        else:
            self.stale_evals += 1
        if self.previous_behavior is not None and all(
            abs(current - previous) <= 1e-9
            for current, previous in zip(behavior, self.previous_behavior)
        ):
            self.behavior_stale_evals += 1
        else:
            self.behavior_stale_evals = 0
        self.previous_behavior = behavior
        row = {
            "run_label": self.run_label,
            "step": self.eval_index * DEV_EVAL_EVERY,
            "mean_reward": mean_reward,
            "strict_pass_rate": sum(
                record["reward"] == 1.0 for record in records
            )
            / len(records),
            "mean_env_steps": statistics.fmean(
                record["env_steps"] for record in records
            ),
            "mean_model_turns": statistics.fmean(
                record["model_turns"] for record in records
            ),
            "parse_error_rate": statistics.fmean(
                bool(record["parse_errors"]) for record in records
            ),
            "explicit_finish_rate": statistics.fmean(
                record["finished_explicitly"] for record in records
            ),
            "forbidden_effect_rate": statistics.fmean(
                bool(record["forbidden_effects"]) for record in records
            ),
            "stale_evals": self.stale_evals,
            "behavior_stale_evals": self.behavior_stale_evals,
            "records": records,
        }
        self.output_path.parent.mkdir(parents=True, exist_ok=True)
        with self.output_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, separators=(",", ":")) + "\n")
        self.eval_index += 1
        if (
            row["step"] >= DEV_PLATEAU_FLOOR
            and self.stale_evals >= DEV_PLATEAU_PATIENCE
            and self.behavior_stale_evals >= DEV_PLATEAU_PATIENCE
        ):
            raise DevPlateauStop(
                "raw dev mean and dev behavior metrics plateaued for "
                f"{DEV_PLATEAU_PATIENCE} evaluations"
            )
        return {
            "dev/raw_mean_reward": mean_reward,
            "dev/mean_env_steps": row["mean_env_steps"],
            "dev/forbidden_effect_rate": row["forbidden_effect_rate"],
        }


async def _run_stage(args: argparse.Namespace) -> None:
    max_steps = args.max_steps or (2 if args.stage == "1" else 40)
    if max_steps < 1:
        raise SystemExit("--max-steps must be positive")
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    def artifact_name(suffix: str) -> str:
        return f"{args.run_label}-{suffix}" if args.run_label else suffix
    log_path = Path(
        args.log_path
        or (ARTIFACT_DIR / artifact_name(f"grpo-stage{args.stage}-log"))
    )
    log_path.mkdir(parents=True, exist_ok=True)
    oracle_path = ARTIFACT_DIR / artifact_name("oracle-train.jsonl")
    oracle_steps = _load_oracle_steps(
        str(REPO), oracle_path, args.expected_train_tasks
    )

    service_client = tinker.ServiceClient()
    rest_client = service_client.create_rest_client()
    usage_before = await snapshot_usage_async(rest_client)
    started = time.monotonic()
    stopped_early = False
    try:
        service = get_service(str(REPO))
        dev_tasks = service.tasks("dev")

        def build_dev_evaluator() -> SamplingClientEvaluator:
            return DevEvaluator(
                service=service,
                tasks=dev_tasks,
                model_name=MODEL_NAME,
                renderer_name=RENDERER_NAME,
                output_path=ARTIFACT_DIR / artifact_name("dev-curve.jsonl"),
                run_label=args.run_label or f"grpo-stage{args.stage}",
            )

        config = train.Config(
            learning_rate=args.learning_rate,
            dataset_builder=AutomationBenchRLDatasetBuilder(
                groups_per_batch=args.groups_per_batch,
                group_size=args.group_size,
                max_steps=max_steps,
                seed=DATASET_SEED,
                oracle_steps=oracle_steps,
                lambda_step=args.lambda_step,
                lambda_noexit=args.lambda_noexit,
                lambda_fw=args.lambda_fw,
                cap_mult=args.cap_mult,
                expected_train_tasks=args.expected_train_tasks,
            ),
            model_name=MODEL_NAME,
            recipe_name="automationbench_nemotron_grpo",
            max_tokens=MAX_TOKENS,
            log_path=str(log_path),
            eval_every=DEV_EVAL_EVERY,
            save_every=5,
            load_checkpoint_path=args.load_checkpoint_path,
            renderer_name=RENDERER_NAME,
            kl_penalty_coef=0.0,
            loss_fn="importance_sampling",
            num_substeps=1,
            lora_rank=args.lora_rank,
            temperature=1.0,
            remove_constant_reward_groups=True,
            max_steps=max_steps,
            rollout_json_export=True,
            evaluator_builders=[build_dev_evaluator],
        )
        try:
            await train.main(config)
        except DevPlateauStop:
            stopped_early = True
    finally:
        close_service()
    elapsed = time.monotonic() - started
    usage_after = await snapshot_usage_async(rest_client)

    telemetry = RL_TELEMETRY.as_dict()
    telemetry.update(
        {
            "stage": args.stage,
            "max_steps": max_steps,
            "stopped_early": stopped_early,
            "run_label": args.run_label,
            "wall_clock_seconds": elapsed,
            "model": MODEL_NAME,
            "renderer": RENDERER_NAME,
            "lora_rank": args.lora_rank,
            "max_tokens": MAX_TOKENS,
            "group_size": args.group_size,
            "groups_per_batch": args.groups_per_batch,
            "dataset_seed": DATASET_SEED,
            "expected_train_tasks": args.expected_train_tasks,
            "load_checkpoint_path": args.load_checkpoint_path,
            "lambda_step": args.lambda_step,
            "lambda_noexit": args.lambda_noexit,
            "lambda_fw": args.lambda_fw,
            "cap_mult": args.cap_mult,
            "remove_constant_reward_groups": True,
            "constant_group_rationale": (
                "Most groups are already saturated after SFT; removing constant "
                "reward groups saves budget and is standard GRPO practice."
            ),
            "rl_deviation": RL_DEVIATION,
        }
    )
    telemetry_path = ARTIFACT_DIR / artifact_name(f"grpo-stage{args.stage}-telemetry.json")
    telemetry_path.write_text(json.dumps(telemetry, indent=2, sort_keys=True) + "\n")
    receipt = {
        "phase": artifact_name(f"grpo-stage{args.stage}"),
        "before": usage_before,
        "after": usage_after,
        "delta": usage_delta(usage_before, usage_after),
    }
    (ARTIFACT_DIR / artifact_name(f"grpo-stage{args.stage}.usage.json")).write_text(
        json.dumps(receipt, indent=2, sort_keys=True) + "\n"
    )
    checkpoint_records = _checkpoint_records(log_path)
    (ARTIFACT_DIR / artifact_name(f"grpo-stage{args.stage}-checkpoints.json")).write_text(
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
        (ARTIFACT_DIR / artifact_name("grpo-stage1-projection.json")).write_text(
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


if __name__ == "__main__":
    asyncio.run(main())
