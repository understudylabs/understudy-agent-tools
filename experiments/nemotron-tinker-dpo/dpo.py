"""Train a small DPO arm from the exact #402 SFT checkpoint."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import tinker
import torch

EXPERIMENT_DIR = Path(__file__).resolve().parent
REPO = EXPERIMENT_DIR.parents[1]
SIBLING_DIR = REPO / "experiments" / "nemotron-tinker-grpo"
if str(SIBLING_DIR) not in sys.path:
    # Reuse #402's renderer-adjacent Python glue without copying it.
    sys.path.insert(0, str(SIBLING_DIR))

from rollout import MODEL_NAME, RENDERER_NAME  # noqa: E402
from tinker_client import create_service_client  # noqa: E402

from tinker_cookbook import renderers  # noqa: E402
from tinker_cookbook.preference.train_dpo import compute_dpo_loss  # noqa: E402
from tinker_cookbook.supervised.common import datum_from_model_input_weights  # noqa: E402
from tinker_cookbook.tokenizer_utils import get_tokenizer  # noqa: E402

SFT_STATE = (
    "tinker://e3e3d392-c8f0-5889-9f91-423a28a12163:train:0/"
    "weights/sft-epoch4-state"
)
SFT_SAMPLER = (
    "tinker://e3e3d392-c8f0-5889-9f91-423a28a12163:train:0/"
    "sampler_weights/sft-epoch4"
)


def _args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pairs", type=Path, default=EXPERIMENT_DIR / "artifacts/dpo-pairs.jsonl")
    parser.add_argument("--out-dir", type=Path, default=EXPERIMENT_DIR / "artifacts")
    parser.add_argument("--state-path", default=SFT_STATE)
    parser.add_argument("--reference-path", default=SFT_SAMPLER)
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--batch-pairs", type=int, default=4)
    parser.add_argument("--learning-rate", type=float, default=1e-5)
    parser.add_argument("--dpo-beta", type=float, default=0.1)
    parser.add_argument("--max-length", type=int, default=4096)
    return parser.parse_args()


def _messages(value: list[dict[str, Any]]) -> list[Any]:
    return [
        {
            "role": item["role"],
            "content": item["content"],
        }
        for item in value
    ]


def _datum(
    renderer: Any,
    prompt: list[dict[str, Any]],
    completion: list[dict[str, Any]],
    max_length: int,
) -> tinker.Datum:
    model_input, weights = renderer.build_supervised_example(
        _messages(prompt + completion)
    )
    return datum_from_model_input_weights(model_input, weights, max_length, reduction="none")


def _load_pairs(path: Path) -> list[dict[str, Any]]:
    pairs = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    for pair in pairs:
        if pair.get("split") != "train":
            raise RuntimeError(f"non-train pair reached DPO training: {pair.get('task_id')}")
    return pairs


def _reference_logprobs(reference: Any, datum: tinker.Datum) -> torch.Tensor:
    target_tokens = datum.loss_fn_inputs["target_tokens"].data
    sequence = datum.model_input
    if target_tokens:
        sequence = sequence.append_int(int(target_tokens[-1]))
    values = reference.compute_logprobs(sequence).result()
    return torch.tensor([value if value is not None else 0.0 for value in values[1:]])


def _train_batch(
    training_client: Any,
    reference: Any,
    data: list[tinker.Datum],
    reference_logprobs: list[torch.Tensor],
    beta: float,
) -> dict[str, float]:
    chosen_data = data[::2]
    rejected_data = data[1::2]
    chosen_ref = reference_logprobs[::2]
    rejected_ref = reference_logprobs[1::2]

    def loss_fn(
        batch: list[tinker.Datum], policy_logprobs: list[torch.Tensor]
    ) -> tuple[torch.Tensor, dict[str, float]]:
        chosen_policy: list[torch.Tensor] = []
        rejected_policy: list[torch.Tensor] = []
        chosen_reference: list[torch.Tensor] = []
        rejected_reference: list[torch.Tensor] = []
        for index in range(len(chosen_data)):
            chosen_weights = torch.tensor(chosen_data[index].loss_fn_inputs["weights"].data)
            rejected_weights = torch.tensor(rejected_data[index].loss_fn_inputs["weights"].data)
            chosen_policy.append(
                torch.dot(policy_logprobs[2 * index].float(), chosen_weights.float())
            )
            rejected_policy.append(
                torch.dot(policy_logprobs[2 * index + 1].float(), rejected_weights.float())
            )
            chosen_reference.append(torch.dot(chosen_ref[index].float(), chosen_weights.float()))
            rejected_reference.append(
                torch.dot(rejected_ref[index].float(), rejected_weights.float())
            )
        return compute_dpo_loss(
            chosen_policy,
            rejected_policy,
            chosen_reference,
            rejected_reference,
            beta,
        )

    result = training_client.forward_backward_custom(data, loss_fn).result()
    return {key: float(value) for key, value in result.metrics.items()}


def main() -> None:
    args = _args()
    pairs = _load_pairs(args.pairs)
    if not pairs:
        raise RuntimeError("no preference pairs available")
    out_dir = args.out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    tokenizer = get_tokenizer(MODEL_NAME)
    renderer = renderers.get_renderer(RENDERER_NAME, tokenizer=tokenizer)
    service_client = create_service_client()
    training_client = service_client.create_training_client_from_state(args.state_path)
    reference_client = service_client.create_sampling_client(model_path=args.reference_path)

    datums: list[tinker.Datum] = []
    for pair in pairs:
        datums.extend(
            [
                _datum(renderer, pair["prompt_conversation"], pair["chosen"], args.max_length),
                _datum(renderer, pair["prompt_conversation"], pair["rejected"], args.max_length),
            ]
        )
    reference_logprobs = [_reference_logprobs(reference_client, datum) for datum in datums]

    metrics: list[dict[str, Any]] = []
    candidates: list[dict[str, str]] = []
    for epoch in range(1, args.epochs + 1):
        epoch_metrics: list[dict[str, float]] = []
        for start in range(0, len(pairs), args.batch_pairs):
            pair_start = start
            pair_end = min(start + args.batch_pairs, len(pairs))
            data_start = 2 * pair_start
            data_end = 2 * pair_end
            batch_metrics = _train_batch(
                training_client,
                reference_client,
                datums[data_start:data_end],
                reference_logprobs[data_start:data_end],
                args.dpo_beta,
            )
            training_client.optim_step(
                tinker.AdamParams(
                    learning_rate=args.learning_rate,
                    beta1=0.9,
                    beta2=0.95,
                    eps=1e-8,
                )
            ).result()
            batch_metrics.update(
                epoch=epoch,
                batch=(start // args.batch_pairs) + 1,
                learning_rate=args.learning_rate,
            )
            epoch_metrics.append(batch_metrics)
            metrics.append(batch_metrics)
        sampler = training_client.save_weights_for_sampler(
            f"dpo-epoch{epoch}", ttl_seconds=604800
        ).result()
        state = training_client.save_state(
            f"dpo-epoch{epoch}-state", ttl_seconds=604800
        ).result()
        candidates.append({"epoch": str(epoch), "sampler_path": sampler.path, "state_path": state.path})
        print(json.dumps({"epoch": epoch, "metrics": epoch_metrics, "sampler_path": sampler.path}))

    result = {
        "model_name": MODEL_NAME,
        "renderer": RENDERER_NAME,
        "warm_start_state": args.state_path,
        "reference_sampler": args.reference_path,
        "lora_rank": 32,
        "learning_rate": args.learning_rate,
        "dpo_beta": args.dpo_beta,
        "epochs": args.epochs,
        "pair_count": len(pairs),
        "metrics": metrics,
        "candidates": candidates,
    }
    (out_dir / "dpo-training-metrics.json").write_text(
        json.dumps(result, indent=2, sort_keys=True) + "\n"
    )


if __name__ == "__main__":
    main()
