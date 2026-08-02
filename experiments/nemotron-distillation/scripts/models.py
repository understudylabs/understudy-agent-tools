"""Serving contracts for the Phase A distillation smoke/eval harness."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

PROMPT_VARIANT = "nemotron-v1"
ACTION_PARSER_ID = "automationbench.parse_agent_action.v1"


@dataclass(frozen=True)
class ModelSpec:
    name: str
    base_model: str
    model_path: str | None
    renderer_name: str
    max_tokens: int = 192
    temperature: float = 0.0
    top_p: float = 1.0
    lora_rank: int | None = 32
    prompt_variant: str = PROMPT_VARIANT

    def serving_contract(
        self,
        adapter_path: str | None = None,
        temperature: float | None = None,
        stop_sequences: list[str] | None = None,
    ) -> dict[str, Any]:
        path = adapter_path if adapter_path is not None else self.model_path
        effective_temperature = self.temperature if temperature is None else temperature
        return {
            "model_spec": self.name,
            "base_model": self.base_model,
            "adapter_path": path,
            "renderer_name": self.renderer_name,
            "prompt_variant": self.prompt_variant,
            "stop_sequences": stop_sequences if stop_sequences is not None else [],
            "sampling_params": {
                "temperature": effective_temperature,
                "top_p": self.top_p,
                "max_tokens": self.max_tokens,
                "num_samples": 1,
            },
            "action_parser_id": ACTION_PARSER_ID,
            "lora_rank": self.lora_rank,
        }

    def to_json(self, adapter_path: str | None = None) -> dict[str, Any]:
        return asdict(self) | {"serving_contract": self.serving_contract(adapter_path)}


MODEL_SPECS: dict[str, ModelSpec] = {
    "teacher": ModelSpec(
        name="teacher",
        base_model="nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16",
        model_path="tinker://efb1352d-3e88-572f-8578-ab50ba51d0c6:train:0/sampler_weights/000020",
        renderer_name="nemotron3_disable_thinking",
    ),
    "teacher-base": ModelSpec(
        name="teacher-base",
        base_model="nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16",
        model_path=None,
        renderer_name="nemotron3_disable_thinking",
    ),
    "student-base": ModelSpec(
        name="student-base",
        base_model="Qwen/Qwen3.5-9B",
        model_path=None,
        renderer_name="qwen3_5_disable_thinking",
    ),
    "student-sft": ModelSpec(
        name="student-sft",
        base_model="Qwen/Qwen3.5-9B",
        model_path=None,
        renderer_name="qwen3_5_disable_thinking",
    ),
    "student-base-4b": ModelSpec(
        name="student-base-4b",
        base_model="Qwen/Qwen3.5-4B",
        model_path=None,
        renderer_name="qwen3_5_disable_thinking",
    ),
    "student-sft-4b": ModelSpec(
        name="student-sft-4b",
        base_model="Qwen/Qwen3.5-4B",
        model_path=None,
        renderer_name="qwen3_5_disable_thinking",
    ),
}


def get_model_spec(name: str, adapter_path: str | None = None) -> ModelSpec:
    try:
        spec = MODEL_SPECS[name]
    except KeyError as error:
        raise ValueError(f"unknown model spec: {name}; choose from {sorted(MODEL_SPECS)}") from error
    if adapter_path is None:
        return spec
    return ModelSpec(**(asdict(spec) | {"model_path": adapter_path}))
