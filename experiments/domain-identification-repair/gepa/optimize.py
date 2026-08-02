#!/usr/bin/env python3
"""Prompt-only GEPA arm for the domain-identification slice."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
import re
import time
from pathlib import Path
from urllib.request import Request, urlopen

import dspy
import gepa
from gepa.core.adapter import EvaluationBatch

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_SYSTEM = """You operate business apps through two tools.
api_search — read-only endpoint discovery. arguments: {"query": string}
api_fetch  — apply ONE API call. arguments: {"method": string, "url": string, "body": object}

Reply with EXACTLY ONE JSON object and nothing else — no prose, no code fences, no second object:
  {"tool": "api_search", "arguments": {"query": "..."}}
  {"tool": "api_fetch", "arguments": {"method": "GET", "url": "/crm/contacts"}}
  {"tool": "finish", "arguments": {}}   <- when the requested change is complete

Read before you write: list the relevant collections first, then make the smallest set of writes that satisfies the request.
Writing to a record the request did not ask you to change scores zero for the whole task."""


def call_json(base, path, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    req = Request(f"{base}{path}", data=data, headers={"content-type": "application/json"} if data else {})
    with urlopen(req, timeout=120) as response:
        return json.loads(response.read())


def parse_action(text):
    visible = re.sub(r"<think>[\s\S]*?</think>", "", str(text or ""))
    visible = re.sub(r"^[\s\S]*</think>", "", visible)
    trimmed = re.sub(r"^```(?:json)?", "", visible.strip(), flags=re.I)
    trimmed = re.sub(r"```$", "", trimmed.strip())
    start, end = trimmed.find("{"), trimmed.rfind("}")
    if start < 0 or end <= start:
        return None, "no JSON object in reply"
    try:
        decoded = json.loads(trimmed[start : end + 1])
    except json.JSONDecodeError:
        return None, "reply is not valid JSON"
    name = decoded.get("tool") or decoded.get("name") or (decoded.get("function") or {}).get("name")
    if not isinstance(name, str):
        return None, "reply has no tool name"
    if name == "finish":
        return {"finish": True}, None
    if name not in ("api_search", "api_fetch"):
        return None, f"unknown tool: {name}"
    args = decoded.get("arguments", decoded.get("args", (decoded.get("function") or {}).get("arguments", {})))
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except json.JSONDecodeError:
            return None, "arguments are not valid JSON"
    if not isinstance(args, dict):
        return None, "arguments must be an object"
    return {"name": name, "arguments": args}, None


class PolicySignature(dspy.Signature):
    """Policy prompt is replaced by GEPA; output is the raw assistant message."""
    task_prompt: str = dspy.InputField()
    history: str = dspy.InputField()
    assistant_message: str = dspy.OutputField()


PolicySignature.instructions = DEFAULT_SYSTEM


class ContractAdapter:
    """GEPA adapter whose rollout is the exact rollout.mjs contract."""
    def __init__(self, sidecar, student_model="openai/nemotron-3-nano-base",
                 max_tokens=384, max_turns=10, malformed_tolerance=3, temperature=0):
        self.sidecar = sidecar
        self.student_model = student_model
        # Serving-contract knobs kept byte-for-byte in parity with rollout.mjs
        # CLI defaults (--max-tokens 384, --max-turns 10, --malformed-tolerance 3,
        # --temperature 0). Do NOT hard-code these in the loop.
        self.max_tokens = max_tokens
        self.max_turns = max_turns
        self.malformed_tolerance = malformed_tolerance
        self.temperature = temperature
        self.propose_new_texts = None
        import litellm
        self.litellm = litellm

    def rollout(self, task, system):
        session = call_json(self.sidecar, "/reset", {"taskId": task["task_id"]})["session"]
        messages = [{"role": "system", "content": system}, {"role": "user", "content": task["prompt"]}]
        # Two distinct counters, matching rollout.mjs: malformed_total is the
        # cumulative count reported for the episode; consecutive_malformed is the
        # streak that (only) resets on a good action and triggers termination.
        malformed_total = 0
        consecutive_malformed = 0
        ended = "budget"
        for _ in range(self.max_turns):
            response = self.litellm.completion(
                model=self.student_model,
                messages=messages,
                api_base="http://127.0.0.1:8099/v1",
                api_key="local-shim",
                temperature=self.temperature,
                max_tokens=self.max_tokens,
                stream=False,
            )
            text = response.choices[0].message.content or ""
            messages.append({"role": "assistant", "content": text})
            action, error = parse_action(text)
            if action and action.get("finish"):
                ended = "finish"
                break
            if error:
                malformed_total += 1
                consecutive_malformed += 1
                if consecutive_malformed >= self.malformed_tolerance:
                    ended = "malformed"
                    break
                messages.append({"role": "user", "content": f"rejected: {error}. Reply with exactly one JSON tool object."})
                continue
            consecutive_malformed = 0
            result = call_json(self.sidecar, "/step", {"session": session, "action": action})
            messages.append({"role": "user", "content": result["observation"][:4000]})
            if result["done"]:
                ended = "finish"
                break
        score = call_json(self.sidecar, "/score", {"session": session})
        return score["reward"], {
            "task_id": task["task_id"],
            "prompt": task["prompt"],
            "messages": messages,
            # cumulative total is the reported/reflection value (parity with rollout.mjs)
            "malformed": malformed_total,
            "malformed_total": malformed_total,
            "consecutive_malformed": consecutive_malformed,
            "ended": ended,
            "steps": score["steps"],
            "score": score["reward"],
        }

    def evaluate(self, batch, candidate, capture_traces=False):
        system = candidate["system_prompt"]
        with ThreadPoolExecutor(max_workers=6) as pool:
            completed = list(pool.map(lambda task: self.rollout(task, system), batch))
        outputs = [trace for _, trace in completed]
        scores = [float(score) for score, _ in completed]
        trajectories = [trace for _, trace in completed] if capture_traces else None
        return EvaluationBatch(outputs=outputs, scores=scores, trajectories=trajectories)

    def make_reflective_dataset(self, candidate, eval_batch, components_to_update):
        records = []
        for trace in eval_batch.trajectories or []:
            if trace["score"] >= 1:
                continue
            raw = trace["messages"][-1]["content"] if trace["messages"] else ""
            if trace["malformed"]:
                feedback = f"Malformed output: rejected {trace['malformed']} time(s). The strict parser strips think tags only, then requires one JSON object; output no thinking and JSON on the first line."
            else:
                feedback = f"Outcome reward was {trace['score']:.3f}. Preserve exact tool semantics and avoid unrequested writes."
            records.append({
                "Inputs": {"task_prompt": trace["prompt"], "history": "\n".join(m["content"][:1200] for m in trace["messages"][-4:])},
                "Generated Outputs": raw[:1600],
                "Feedback": feedback,
            })
        return {"system_prompt": records[:8]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sidecar", default="http://127.0.0.1:8787")
    parser.add_argument("--train-limit", type=int, default=24)
    parser.add_argument("--dev-limit", type=int, default=8)
    parser.add_argument("--max-metric-calls", type=int, default=40)
    parser.add_argument("--max-tokens", type=int, default=384)
    parser.add_argument("--max-turns", type=int, default=10)
    parser.add_argument("--malformed-tolerance", type=int, default=3)
    parser.add_argument("--temperature", type=float, default=0)
    parser.add_argument("--seed", type=int, default=178561)
    parser.add_argument("--out-dir", default=str(ROOT / "experiments/domain-identification-repair/gepa"))
    args = parser.parse_args()
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    train = call_json(args.sidecar, "/pool?split=train")["tasks"][: args.train_limit]
    dev = call_json(args.sidecar, "/pool?split=dev")["tasks"][: args.dev_limit]
    reflection_key = os.environ.get("UNDERSTUDY_API_KEY") or os.environ.get("FIREWORKS_API_KEY")
    if not reflection_key:
        raise RuntimeError("UNDERSTUDY_API_KEY or FIREWORKS_API_KEY is required")
    import litellm
    def reflection(messages):
        if isinstance(messages, str):
            messages = [{"role": "user", "content": messages}]
        response = litellm.completion(
            model="openai/kimi-k3",
            messages=messages,
            api_base="https://api.understudylabs.com/v1",
            api_key=reflection_key,
            temperature=1.0,
            max_tokens=8000,
            stream=True,
        )
        return "".join(
            chunk.choices[0].delta.content or ""
            for chunk in response
            if chunk.choices and chunk.choices[0].delta
        )
    adapter = ContractAdapter(
        args.sidecar,
        max_tokens=args.max_tokens,
        max_turns=args.max_turns,
        malformed_tolerance=args.malformed_tolerance,
        temperature=args.temperature,
    )
    optimizer_kwargs = {
        "seed_candidate": {"system_prompt": PolicySignature.instructions},
        "trainset": train,
        "valset": dev,
        "adapter": adapter,
        "reflection_lm": reflection,
        "max_metric_calls": args.max_metric_calls,
        "reflection_minibatch_size": 4,
        "candidate_selection_strategy": "current_best",
        "frontier_type": "instance",
        "skip_perfect_score": True,
        "run_dir": str(out_dir / "logs"),
        "seed": args.seed,
    }
    started = time.time()
    result = gepa.optimize(**optimizer_kwargs)
    prompt = result.best_candidate["system_prompt"]
    (out_dir / "optimized-system-prompt.txt").write_text(prompt.rstrip() + "\n")
    receipt = {
        "schema_version": "understudy.gepa_receipt.v1",
        "seed": args.seed,
        "dspy_version": dspy.__version__,
        "gepa_version": "0.0.27",
        "student_model": "openai/nemotron-3-nano-base",
        "reflection_model": "openai/kimi-k3",
        "metric_budget": args.max_metric_calls,
        "candidates_tried": len(result.candidates),
        "best_dev_score_gepa_observed": max(result.val_aggregate_scores),
        "train_tasks": len(train),
        "dev_tasks": len(dev),
        "train_split_sha256": call_json(args.sidecar, "/pool?split=train")["split_sha256"],
        "dev_split_sha256": call_json(args.sidecar, "/pool?split=dev")["split_sha256"],
        "holdout_executed": True,
        "gepa_holdout_executed": False,
        "fixture": "domain-identification-offline-v1",
        "wall_clock_s": round(time.time() - started),
        "reflection_key_source": "UNDERSTUDY_API_KEY" if os.environ.get("UNDERSTUDY_API_KEY") else "FIREWORKS_API_KEY",
    }
    (out_dir / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
