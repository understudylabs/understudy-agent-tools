#!/usr/bin/env python3
"""GRPO rung of the multi-base bake-off, on Tinker.

Group-relative policy optimisation directly against the bake-off verifier: for
each train-split task the policy rolls a group of episodes through
`env-service.mjs`, the terminal `partialCredit` of each episode is its reward,
and the group mean is the baseline. There is no shaped reward and no second
scorer — the number the ladder is ranked by is the number being optimised.

The environment service is started for the train split only, so an RL rollout
cannot touch dev or the sealed holdout. Every base runs this identical script
against the identical service; only `--base-model`, `--renderer`, and the
initial checkpoint change.

  TINKER_API_KEY=... python experiments/multi-base-bakeoff/grpo-train.py \
      --env-url http://127.0.0.1:8200 \
      --base-model Qwen/Qwen3.5-9B --renderer qwen3_5_disable_thinking \
      --init-checkpoint tinker://... --group-size 8 --groups-per-batch 12 \
      --steps 8 --out outputs/bakeoff/grpo/qwen3.5-9b-receipt.json
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import signal
import time
from pathlib import Path

import httpx

if os.environ.get("TINKER_DISABLE_PYQWEST") == "1":
    import tinker._base_client as _tinker_base_client

    _tinker_base_client._default_pyqwest_transport = lambda: httpx.AsyncHTTPTransport(retries=2)

import chz  # noqa: E402
import tinker  # noqa: E402
from tinker_cookbook.renderers import Message, get_renderer  # noqa: E402
from tinker_cookbook.rl import train as train_rl  # noqa: E402
from tinker_cookbook.rl.message_env import EnvFromMessageEnv, MessageEnv, MessageStepResult  # noqa: E402
from tinker_cookbook.rl.types import Env, EnvGroupBuilder, Metrics, RLDataset, RLDatasetBuilder, Trajectory  # noqa: E402
from tinker_cookbook.tokenizer_utils import get_tokenizer  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--env-url", default="http://127.0.0.1:8200")
parser.add_argument("--base-model", required=True)
parser.add_argument("--renderer", required=True)
parser.add_argument("--init-checkpoint", default=None, help="tinker:// state checkpoint to start from (usually the SFT rung)")
parser.add_argument("--group-size", type=int, default=8)
parser.add_argument("--groups-per-batch", type=int, default=12)
parser.add_argument("--steps", type=int, default=8)
parser.add_argument("--learning-rate", type=float, default=2e-5)
parser.add_argument("--lora-rank", type=int, default=32)
parser.add_argument("--temperature", type=float, default=1.0)
parser.add_argument("--max-turns", type=int, default=14)
parser.add_argument("--max-tokens", type=int, default=2000)
parser.add_argument("--max-trajectory-tokens", type=int, default=24000)
parser.add_argument("--malformed-tolerance", type=int, default=3)
parser.add_argument("--seed", type=int, default=7)
parser.add_argument("--save-every", type=int, default=2)
parser.add_argument("--log-path", default=None)
parser.add_argument("--out", required=True)
args = parser.parse_args()

CONTRACT = httpx.get(f"{args.env_url}/contract", timeout=30).json()
TASKS = httpx.get(f"{args.env_url}/tasks", timeout=30).json()
if CONTRACT["split"] != "train":
    raise SystemExit(f"env service is serving split={CONTRACT['split']!r}; RL rollouts must use train")
SYSTEM: str = CONTRACT["system"]


class BakeoffEnv(MessageEnv):
    """One episode of the offline fixture, driven message-by-message.

    Parsing, stepping, and scoring all happen inside the environment service,
    which runs the contract's own parser and the shared verifier: this class
    only shuttles messages.
    """

    def __init__(self, task: dict, client: httpx.AsyncClient, max_turns: int, malformed_tolerance: int):
        self.task = task
        self.client = client
        self.max_turns = max_turns
        self.malformed_tolerance = malformed_tolerance
        self.example_id = task["task_id"]
        self.episode_id: str | None = None
        # EnvFromMessageEnv re-renders whatever `next_messages` holds as the next
        # prompt, so this must always be the whole conversation, not the delta.
        self.messages: list[Message] = []
        self.turns = 0
        self.malformed = 0
        self.consecutive_malformed = 0
        self.reward: float | None = None
        self.forbidden_effects = 0
        self.steps = 0

    async def initial_observation(self) -> list[Message]:
        payload = (await self.client.post("/reset", json={"task_id": self.task["task_id"]})).json()
        if "episode_id" not in payload:
            raise RuntimeError(f"reset failed: {payload}")
        self.episode_id = payload["episode_id"]
        self.messages = [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": payload["prompt"]},
        ]
        return list(self.messages)

    async def _score(self) -> float:
        payload = (await self.client.post("/finish", json={"episode_id": self.episode_id})).json()
        self.reward = float(payload["reward"])
        self.forbidden_effects = int(payload.get("forbidden_effects", 0))
        self.steps = int(payload.get("steps", 0))
        return self.reward

    def _metrics(self, ended: str) -> Metrics:
        return {
            "env/ended_" + ended: 1.0,
            "env/malformed_turns": float(self.malformed),
            "env/forbidden_effects": float(self.forbidden_effects),
            "env/env_steps": float(self.steps),
            "env/turns": float(self.turns),
        }

    async def step(self, message: Message) -> MessageStepResult:
        self.turns += 1
        content = message.get("content") if isinstance(message, dict) else getattr(message, "content", "")
        if isinstance(content, list):
            content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
        self.messages.append({"role": "assistant", "content": content or ""})
        result = (await self.client.post("/act", json={"episode_id": self.episode_id, "text": content or ""})).json()
        if os.environ.get("BAKEOFF_TRACE_ROLLOUTS") == "1":
            print(f"[rollout turn {self.turns} {result.get('kind')}] {content!r}", flush=True)

        if result.get("kind") == "finish":
            return MessageStepResult(reward=await self._score(), episode_done=True, next_messages=[], metrics=self._metrics("finish"))
        if result.get("kind") == "rejected":
            self.malformed += 1
            self.consecutive_malformed += 1
            if self.consecutive_malformed >= self.malformed_tolerance or self.turns >= self.max_turns:
                ended = "malformed" if self.consecutive_malformed >= self.malformed_tolerance else "budget"
                return MessageStepResult(reward=await self._score(), episode_done=True, next_messages=[], metrics=self._metrics(ended))
            self.messages.append({"role": "user", "content": result["message"]})
            return MessageStepResult(reward=0.0, episode_done=False, next_messages=list(self.messages), metrics={})

        self.consecutive_malformed = 0
        if result.get("done") or self.turns >= self.max_turns:
            return MessageStepResult(reward=await self._score(), episode_done=True, next_messages=[], metrics=self._metrics("budget"))
        self.messages.append({"role": "user", "content": result["observation"]})
        return MessageStepResult(reward=0.0, episode_done=False, next_messages=list(self.messages), metrics={})


class TaskGroupBuilder(EnvGroupBuilder):
    """`group_size` independent episodes of one task — the GRPO group."""

    def __init__(self, task: dict, group_size: int, renderer, client: httpx.AsyncClient):
        self.task = task
        self.group_size = group_size
        self.renderer = renderer
        self.client = client

    async def make_envs(self) -> list[Env]:
        return [
            EnvFromMessageEnv(
                renderer=self.renderer,
                message_env=BakeoffEnv(self.task, self.client, args.max_turns, args.malformed_tolerance),
                max_trajectory_tokens=args.max_trajectory_tokens,
                max_generation_tokens=args.max_tokens,
                terminate_on_parse_error=False,
            )
            for _ in range(self.group_size)
        ]

    def logging_tags(self) -> list[str]:
        return [self.task["band"], self.task["tier"], self.task["family"]]

    async def compute_group_rewards(self, trajectory_group: list[Trajectory], env_group) -> list[tuple[float, Metrics]]:
        return [(0.0, {}) for _ in trajectory_group]


class BakeoffDataset(RLDataset):
    def __init__(self, tasks: list[dict], renderer, client: httpx.AsyncClient, batches: list[list[dict]]):
        self.tasks = tasks
        self.renderer = renderer
        self.client = client
        self.batches = batches

    def get_batch(self, index: int) -> list[EnvGroupBuilder]:
        return [TaskGroupBuilder(task, args.group_size, self.renderer, self.client) for task in self.batches[index]]

    def __len__(self) -> int:
        return len(self.batches)


@chz.chz
class BakeoffDatasetBuilder(RLDatasetBuilder):
    base_model: str = ""
    renderer_name: str = ""

    async def __call__(self) -> tuple[RLDataset, None]:
        renderer = get_renderer(self.renderer_name, get_tokenizer(self.base_model))
        client = httpx.AsyncClient(base_url=args.env_url, timeout=120)
        rng = random.Random(args.seed)
        # Each step draws its own sample of tasks without replacement inside a
        # step, cycling the shuffled pool so every task is visited before any is
        # repeated.
        order: list[dict] = []
        batches: list[list[dict]] = []
        for _ in range(args.steps):
            batch = []
            while len(batch) < args.groups_per_batch:
                if not order:
                    order = TASKS[:]
                    rng.shuffle(order)
                batch.append(order.pop())
            batches.append(batch)
        return BakeoffDataset(TASKS, renderer, client, batches), None


log_path = args.log_path or f"/tmp/understudy-bakeoff-grpo/{args.base_model.replace('/', '_')}-{int(time.time())}"
config = train_rl.Config(
    log_path=log_path,
    model_name=args.base_model,
    recipe_name="understudy_bakeoff_verifier_grpo",
    renderer_name=args.renderer,
    load_checkpoint_path=args.init_checkpoint,
    dataset_builder=BakeoffDatasetBuilder(base_model=args.base_model, renderer_name=args.renderer),
    learning_rate=args.learning_rate,
    lora_rank=args.lora_rank,
    max_tokens=args.max_tokens,
    temperature=args.temperature,
    # A group where every episode earned the same reward carries no gradient
    # signal; dropping it keeps the batch spent on tasks that still discriminate.
    remove_constant_reward_groups=True,
    evaluator_builders=[],
    eval_every=0,
    save_every=args.save_every,
)


def final_checkpoint(directory: str) -> tuple[str | None, str | None]:
    log = Path(directory) / "checkpoints.jsonl"
    if not log.exists():
        return None, None
    entries = [json.loads(line) for line in log.read_text().splitlines() if line.strip()]
    if not entries:
        return None, None
    last = entries[-1]
    return last.get("sampler_path"), last.get("state_path") or last.get("path")


# A terminated step must record the same receipt an interrupted one does, so
# SIGTERM is routed through the cancellation path rather than killing the
# process silently.
signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))

started = time.time()
status = "completed"
try:
    asyncio.run(train_rl.main(config))
except KeyboardInterrupt:
    # A cancellation still owes a receipt: the run bought provider time and the
    # last saved checkpoint is real, so record both instead of vanishing.
    status = "cancelled"
elapsed = round(time.time() - started, 1)

sampler_path, state_path = final_checkpoint(log_path)
receipt = {
    "schema_version": "understudy.bakeoff.train_receipt.v1",
    "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "rung": "grpo",
    "status": status,
    "backend": "tinker",
    "base_model": args.base_model,
    "renderer": args.renderer,
    "init_checkpoint": args.init_checkpoint,
    "contract_id": CONTRACT["contract_id"],
    "contract_sha256": CONTRACT["contract_sha256"],
    "fixture_sha256": CONTRACT["fixture_sha256"],
    "train_split_sha256": CONTRACT["split_sha256"],
    "reward": "terminal partialCredit from the shared verifier; no shaping",
    "hyperparameters": {
        "group_size": args.group_size,
        "groups_per_batch": args.groups_per_batch,
        "steps": args.steps,
        "learning_rate": args.learning_rate,
        "lora_rank": args.lora_rank,
        "temperature": args.temperature,
        "max_turns": args.max_turns,
        "max_tokens": args.max_tokens,
        "seed": args.seed,
        "remove_constant_reward_groups": True,
    },
    "log_path": log_path,
    "checkpoint": sampler_path,
    "state_checkpoint": state_path,
    "wall_clock_s": elapsed,
}
out = Path(args.out)
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps(receipt, indent=2))
if status == "cancelled":
    raise SystemExit(130)
