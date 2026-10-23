// Provider-free Python stand-ins for the pinned dspy-gepa runtime. They mirror the
// DSPy 3.4 engine seam: dspy.LM refuses connection settings when given a custom
// engine and routes every call through engine.complete(Request) -> Response.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const dspyGepaRuntimeVersions = [
  ["dspy", "3.4.1"],
  ["gepa", "0.1.4"],
  ["cloudpickle", "3.1.2"],
  ["litellm", "1.106.2"],
];

export function writePythonDistributionMetadata(root, versions = dspyGepaRuntimeVersions) {
  for (const [name, version] of versions) {
    const metadataDir = join(root, `${name}-${version}.dist-info`);
    mkdirSync(metadataDir, { recursive: true });
    writeFileSync(
      join(metadataDir, "METADATA"),
      `Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\n`,
      "utf8",
    );
  }
}

// dspy.LM as the engine seam sees it. Request/response shapes follow dspy.lm15.
export const dspyLmStubSource = `
from types import SimpleNamespace

class LM:
    def __init__(self, model, engine=None, max_tokens=None, num_retries=3, **kwargs):
        for key in ("api_key", "api_base", "base_url"):
            if kwargs.get(key) is not None and engine is not None:
                raise ValueError(f"{key} configures a connection a custom engine owns")
        self.model = model
        self.engine = engine
        self.num_retries = num_retries
        self.kwargs = {
            "max_tokens": max_tokens,
            "temperature": kwargs.get("temperature"),
            "reasoning_effort": kwargs.get("reasoning_effort"),
        }
        _record_lm(self)
    def __call__(self, prompt=None, messages=None, **kwargs):
        return self.forward(prompt=prompt, messages=messages, **kwargs)
    def forward(self, prompt=None, messages=None, **kwargs):
        if self.num_retries != 0:
            raise AssertionError("retries were not disabled")
        request = SimpleNamespace(
            model=self.model,
            messages=messages or [{"role": "user", "content": prompt or ""}],
            config=SimpleNamespace(max_tokens=self.kwargs["max_tokens"], extensions={}),
        )
        try:
            return self.engine.complete(request)
        except Exception as error:
            # DSPy wraps anything raised inside an engine (LMUnexpectedError).
            raise RuntimeError("wrapped LM error") from error
`;

export function writeDspyClientsEngineStub(dspyRoot, completeBody) {
  mkdirSync(join(dspyRoot, "clients", "engines"), { recursive: true });
  writeFileSync(join(dspyRoot, "clients", "__init__.py"), "", "utf8");
  writeFileSync(join(dspyRoot, "clients", "engines", "__init__.py"), `
import os
from types import SimpleNamespace

class LiteLLMEngine:
    def __init__(self, api_key=None, api_base=None):
        self.api_key = api_key
        self.api_base = api_base
    def complete(self, request):
${completeBody}
`, "utf8");
}

// Stand-ins for the gepa package that record how the runtime configures them.
export function writeGepaPackageStubs(root) {
  const gepaPackage = join(root, "gepa");
  mkdirSync(join(gepaPackage, "utils"), { recursive: true });
  mkdirSync(join(gepaPackage, "strategies"), { recursive: true });
  writeFileSync(join(gepaPackage, "__init__.py"), "", "utf8");
  writeFileSync(join(gepaPackage, "utils", "__init__.py"), "", "utf8");
  writeFileSync(join(gepaPackage, "strategies", "__init__.py"), "", "utf8");
  writeFileSync(join(gepaPackage, "utils", "stop_condition.py"), `
class _Recorded:
    def __init__(self, *args):
        self.args = list(args)
    def describe(self):
        return [type(self).__name__, *self.args]

class FileStopper(_Recorded): pass
class NoImprovementStopper(_Recorded): pass
class ScoreThresholdStopper(_Recorded): pass
class TimeoutStopCondition(_Recorded): pass
`, "utf8");
  writeFileSync(join(gepaPackage, "strategies", "proposal_sampling.py"), `
class IndependentSampling:
    def __init__(self, count):
        self.count = count
    def describe(self):
        return ["IndependentSampling", self.count]
`, "utf8");
  writeFileSync(join(gepaPackage, "strategies", "proposal_selection.py"), `
class BestImprovement:
    def describe(self):
        return ["BestImprovement"]
`, "utf8");
}

export function writeScoreWithFeedbackStub(dspyRoot, gepaInit = "") {
  const gepaRoot = join(dspyRoot, "teleprompt", "gepa");
  mkdirSync(gepaRoot, { recursive: true });
  writeFileSync(join(dspyRoot, "teleprompt", "__init__.py"), "", "utf8");
  writeFileSync(join(gepaRoot, "__init__.py"), gepaInit, "utf8");
  writeFileSync(join(gepaRoot, "gepa_utils.py"), `
class ScoreWithFeedback:
    def __init__(self, score, feedback, objective_scores=None):
        self.score = score
        self.feedback = feedback
        self.objective_scores = objective_scores
`, "utf8");
}

// A signature-scaffold DSPy with a GEPA that records how the runtime configured it,
// replays GEPA 0.1.4 callbacks, and returns an "evolved" program. The evolved
// program answers "a2"; the seed program answers "a1".
export function writeMeteredDspyGepaStubs(stubRoot) {
  const dspyRoot = join(stubRoot, "dspy");
  mkdirSync(dspyRoot, { recursive: true });
  writePythonDistributionMetadata(stubRoot);
  writeGepaPackageStubs(stubRoot);
  writeScoreWithFeedbackStub(dspyRoot, `
class InstructionProposer:
    def __init__(self, **kwargs):
        self.kwargs = {key: [str(item) for item in value] if key == "skills" and value else value for key, value in kwargs.items()}
`);
  writeDspyClientsEngineStub(dspyRoot, `
        with open(os.environ["PROVIDER_SENTINEL"], "a", encoding="utf-8") as handle:
            handle.write("called\\n")
        if os.environ.get("STUB_ZERO_USAGE"):
            return SimpleNamespace(usage=SimpleNamespace(input_tokens=0, output_tokens=0))
        output_tokens = int(os.environ.get("STUB_OUTPUT_TOKENS", "5"))
        late_after = os.environ.get("STUB_LATE_AFTER_CALLS")
        if late_after is not None:
            # Calls after the first N (the sentinel counts them) answer longer.
            with open(os.environ["PROVIDER_SENTINEL"], encoding="utf-8") as handle:
                if sum(1 for _ in handle) > int(late_after):
                    output_tokens = int(os.environ["STUB_LATE_OUTPUT_TOKENS"])
        return SimpleNamespace(usage=SimpleNamespace(input_tokens=10, output_tokens=output_tokens))`);
  writeFileSync(join(dspyRoot, "__init__.py"), `
import copy
import json
import os
from types import SimpleNamespace

configured_lm = None

def configure(lm):
    global configured_lm
    configured_lm = lm

def _record_lm(lm):
    pass
${dspyLmStubSource}
class Signature:
    def __init__(self, value):
        self.value = value
        self.instructions = "seed instruction"

class Example:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)
    def with_inputs(self, *keys):
        return self

class Predict:
    def __init__(self, signature):
        self.signature = signature
    def named_predictors(self):
        return [("predict", self)]
    def __call__(self, **kwargs):
        configured_lm(prompt=str(kwargs))
        return SimpleNamespace(answer="a2" if "evolved" in self.signature.instructions else "a1")
    def dump_state(self, json_mode=False):
        if os.environ.get("STUB_DUMP_STATE_RAISES"):
            raise RuntimeError("dump_state bug")
        return {"predict": {"instructions": self.signature.instructions}}

class ChainOfThought(Predict):
    pass

COMPILES = []

class GEPA:
    def __init__(self, reflection_lm=None, **kwargs):
        self.reflection_lm = reflection_lm
        self.kwargs = kwargs
    def compile(self, student, trainset=None, valset=None):
        copied = copy.deepcopy(self.reflection_lm)
        compile_number = len(COMPILES) + 1
        # STUB_VALSET_EVAL: score candidates on the dev rows the way DSPy 3.4.1's
        # Evaluate does, swallowing a failed (refused) row as a 0 score while still
        # reporting every row as evaluated, and report each evaluation through
        # on_valset_evaluated. The seed is scored first, before any reflection.
        valset_eval = bool(os.environ.get("STUB_VALSET_EVAL"))
        if not valset_eval:
            copied(prompt="reflection")
        repo = os.path.dirname(os.environ["PROVIDER_SENTINEL"])
        # What a progress consumer could see while the optimizer is still running.
        state_dir = os.path.join(repo, ".understudy", "optimize-workload", "dspy-gepa")
        with open(os.path.join(state_dir, "run-state.json"), encoding="utf-8") as handle:
            live_state = json.load(handle)
        with open(os.path.join(state_dir, "events.jsonl"), encoding="utf-8") as handle:
            live_events = [json.loads(line)["event"] for line in handle]
        inner = self.kwargs.get("gepa_kwargs") or {}
        callbacks = inner.get("callbacks") or []
        for callback in ([] if os.environ.get("STUB_SKIP_REPLAY") else callbacks):
            callback.on_optimization_start({"trainset_size": 1, "valset_size": 1})
            callback.on_proposal_end({"iteration": 1, "new_instructions": {"predict": "evolved instruction"}})
            callback.on_valset_evaluated({
                "iteration": 1, "candidate_idx": 1, "candidate": {"predict": "evolved instruction"},
                "average_score": 0.75, "num_examples_evaluated": 1, "total_valset_size": 1, "is_best_program": True,
            })
            callback.on_candidate_accepted({"iteration": 1, "new_candidate_idx": 1, "new_score": 0.75, "parent_ids": [0]})
            callback.on_candidate_rejected({"iteration": 2, "old_score": 0.75, "new_score": 0.5, "reason": "not-better"})
            callback.on_error({"iteration": 3, "exception": ValueError("x"), "will_continue": True})
            callback.on_optimization_end({"best_candidate_idx": 1, "total_iterations": 3, "total_metric_calls": 2})
        # GEPA 0.1.4's loop: check the stoppers (any() short-circuits), then run an
        # iteration of one reflection call and one student call per dev row. GEPA
        # catches an iteration's exception and continues; STUB_RAISE_ON_REFUSAL
        # lets it escape compile instead. STUB_BURST_* makes one iteration far
        # costlier than the others.
        iterations = int(os.environ.get("STUB_ITERATIONS", "0"))
        state = SimpleNamespace(total_num_evals=0)
        live_stoppers = [stopper for stopper in inner.get("stop_callbacks", []) if callable(stopper)]
        best_instruction = "evolved instruction"
        iterations_run = 0
        burst_compile = os.environ.get("STUB_BURST_IN_COMPILE")

        def evaluate(program, burst=False):
            scores = []
            for index, example in enumerate(valset or []):
                try:
                    prediction = program(question=example.question)
                    scores.append(1.0 if prediction.answer == example.answer else 0.0)
                except Exception:
                    scores.append(0.0)
                if burst and index == 0:
                    # An unexpectedly expensive stretch right after the first row.
                    for _ in range(int(os.environ["STUB_BURST_CALLS"])):
                        try:
                            student(question="burst")
                        except Exception:
                            break
            state.total_num_evals += len(scores)
            return sum(scores) / len(scores)

        aggregate = []
        instructions = []

        def report(instruction, score, iteration):
            aggregate.append(score)
            instructions.append(instruction)
            for callback in callbacks:
                callback.on_valset_evaluated({
                    "iteration": iteration, "candidate_idx": len(aggregate) - 1,
                    "candidate": {"predict": instruction}, "average_score": score,
                    "num_examples_evaluated": len(valset), "total_valset_size": len(valset),
                    "is_best_program": score > max(aggregate[:-1], default=-1.0),
                })

        if valset_eval:
            report(student.signature.instructions, evaluate(student), 0)
        while iterations_run < iterations and not any(stopper(state) for stopper in live_stoppers):
            iterations_run += 1
            burst = iterations_run == int(os.environ.get("STUB_BURST_AT_ITERATION", "0")) and (
                burst_compile is None or int(burst_compile) == compile_number
            )
            if valset_eval:
                try:
                    copied(prompt="reflection")
                except Exception:
                    continue
                candidate = copy.deepcopy(student)
                candidate.signature.instructions = "evolved instruction " + str(iterations_run)
                report(candidate.signature.instructions, evaluate(candidate, burst), iterations_run)
                continue
            try:
                copied(prompt="reflection")
                for _ in range(int(os.environ["STUB_BURST_CALLS"]) if burst else len(valset or [])):
                    student(question="iteration")
                    state.total_num_evals += 1
            except Exception:
                if os.environ.get("STUB_RAISE_ON_REFUSAL"):
                    raise
                continue
            best_instruction = "evolved instruction " + str(iterations_run)
            for callback in callbacks:
                callback.on_valset_evaluated({
                    "iteration": iterations_run, "candidate_idx": iterations_run + 1,
                    "candidate": {"predict": best_instruction}, "average_score": 0.75,
                    "num_examples_evaluated": 1, "total_valset_size": 1, "is_best_program": True,
                })
        proposer = self.kwargs.get("instruction_proposer")
        COMPILES.append({
            "seed_instructions": student.signature.instructions,
            "log_dir": self.kwargs.get("log_dir"),
            "stoppers": [stopper.describe() for stopper in inner.get("stop_callbacks", [])],
            "sampling": inner["sampling_strategy"].describe() if "sampling_strategy" in inner else None,
            "selection": inner["selection_strategy"].describe() if "selection_strategy" in inner else None,
            "acceptance": inner.get("acceptance_criterion"),
            "use_cloudpickle": inner.get("use_cloudpickle"),
            "candidate_selection": self.kwargs.get("candidate_selection_strategy"),
            "use_merge": self.kwargs.get("use_merge"),
            "proposer": proposer.kwargs if proposer is not None else None,
            "iterations_run": iterations_run,
            "metric_calls": state.total_num_evals,
        })
        with open(os.environ["GEPA_KWARGS_PATH"], "w", encoding="utf-8") as handle:
            json.dump({
                "live_run_state": {"status": live_state["status"], "phase": live_state["phase"]},
                "live_events": live_events,
                "callback_count": len(callbacks),
                "compiles": COMPILES,
                "gepa": {key: value for key, value in self.kwargs.items() if key not in ("metric", "gepa_kwargs", "instruction_proposer")},
                "reflection_lm_kwargs": self.reflection_lm.kwargs,
                "reflection_model": self.reflection_lm.model,
            }, handle)
        if os.environ.get("STUB_TOUCH_STOP_FILE"):
            open(os.path.join(state_dir, "STOP"), "w", encoding="utf-8").close()
        evolved = copy.deepcopy(student)
        already_evolved = "evolved" in student.signature.instructions
        evolved.signature.instructions = best_instruction
        evolved.detailed_results = SimpleNamespace(
            val_aggregate_scores=[0.75, 0.75] if already_evolved else [0.25, 0.75],
            total_metric_calls=2,
            num_full_val_evals=2,
        )
        if valset_eval:
            # DSPy returns the candidate with the highest aggregate dev score.
            best = max(range(len(aggregate)), key=lambda index: aggregate[index])
            evolved.signature.instructions = instructions[best]
            evolved.detailed_results = SimpleNamespace(
                val_aggregate_scores=list(aggregate),
                total_metric_calls=state.total_num_evals,
                num_full_val_evals=len(aggregate),
            )
        return evolved
`, "utf8");
}

// A multi-predictor DSPy for task-spec runs: dict signatures with typed fields,
// dspy.Module attribute discovery ("name" for Predict, "name.predict" for
// ChainOfThought, as DSPy 3.4.1 names them), and a GEPA that calls the metric the
// way DSPy does (pred_name=None to score, then once per predictor for feedback).
// Seed predictors answer STUB_ANSWERS[output][0]; evolved ones answer [1]. An
// answer of "__unparseable__" raises AdapterParseError, as DSPy does for a label
// outside the Literal. Example and Prediction keep fields in a store, as DSPy's
// do, so attribute access returns their methods for names such as labels or items.
export function writeTaskSpecDspyStubs(stubRoot) {
  const dspyRoot = join(stubRoot, "dspy");
  mkdirSync(join(dspyRoot, "utils"), { recursive: true });
  writePythonDistributionMetadata(stubRoot);
  writeGepaPackageStubs(stubRoot);
  writeScoreWithFeedbackStub(dspyRoot);
  writeFileSync(join(dspyRoot, "utils", "__init__.py"), "", "utf8");
  writeFileSync(join(dspyRoot, "utils", "exceptions.py"), `
class AdapterParseError(Exception):
    def __init__(self, adapter_name, signature, lm_response, message=None, parsed_result=None):
        super().__init__(message or "parse failed")
        self.signature = signature
        self.lm_response = lm_response
        self.parsed_result = parsed_result
`, "utf8");
  writeDspyClientsEngineStub(dspyRoot, `
        with open(os.environ["PROVIDER_SENTINEL"], "a", encoding="utf-8") as handle:
            handle.write("called\\n")
        return SimpleNamespace(usage=SimpleNamespace(input_tokens=10, output_tokens=5))`);
  writeFileSync(join(dspyRoot, "__init__.py"), `
import copy
import json
import os
from types import SimpleNamespace

configured_lm = None
settings = SimpleNamespace(trace=None, max_trace_size=10000)

def configure(lm):
    global configured_lm
    configured_lm = lm

def _record_lm(lm):
    pass
${dspyLmStubSource}
class _Field:
    def __init__(self, kind):
        self.kind = kind

def InputField():
    return _Field("input")

def OutputField():
    return _Field("output")

class Signature:
    def __init__(self, fields, instructions=None):
        self.fields = dict(fields)
        self.instructions = instructions or "default instruction"
    def output_field(self):
        return [name for name, (_, field) in self.fields.items() if field.kind == "output"][0]

class Example:
    def __init__(self, **kwargs):
        self._store = dict(kwargs)
        self._input_keys = []
    def __getattr__(self, key):
        if key.startswith("_"):
            raise AttributeError(key)
        try:
            return self._store[key]
        except KeyError:
            raise AttributeError(key) from None
    def __getitem__(self, key):
        return self._store[key]
    def with_inputs(self, *keys):
        self._input_keys = list(keys)
        return self
    def inputs(self):
        return {key: self._store[key] for key in self._input_keys}
    def labels(self):
        return {key: value for key, value in self._store.items() if key not in self._input_keys}
    def items(self):
        return self._store.items()
    def keys(self):
        return self._store.keys()
    def values(self):
        return self._store.values()
    def get(self, key, default=None):
        return self._store.get(key, default)
    def to_metadata(self):
        # Stands in for a member a later dspy release adds; the runtime rechecks
        # field names against the installed classes.
        return {}

class Prediction(Example):
    pass

def _answers():
    return json.loads(os.environ.get("STUB_ANSWERS", "{}"))

class Predict:
    def __init__(self, signature):
        self.signature = signature
    def predictors(self):
        return [self]
    def __call__(self, **kwargs):
        configured_lm(prompt=str(sorted(kwargs)))
        output = self.signature.output_field()
        pair = _answers().get(output, ["seed", "evolved"])
        answer = pair[1] if "evolved" in self.signature.instructions else pair[0]
        if answer == "__unparseable__":
            from dspy.utils.exceptions import AdapterParseError
            raise AdapterParseError("ChatAdapter", self.signature, f"[[ ## {output} ## ]]\\nNot A Label")
        prediction = Prediction(**{output: answer})
        if settings.trace is not None:
            settings.trace.append((self, dict(kwargs), prediction))
        return prediction

class ChainOfThought:
    def __init__(self, signature):
        self.predict = Predict(signature)
    def predictors(self):
        return [self.predict]
    def __call__(self, **kwargs):
        return self.predict(**kwargs)

class Module:
    def __init__(self):
        self.callbacks = []
        self.history = []
    def named_predictors(self):
        found = []
        for name, value in vars(self).items():
            if isinstance(value, Predict):
                found.append((name, value))
            elif isinstance(value, ChainOfThought):
                found.append((name + ".predict", value.predict))
        return found
    def __call__(self, **kwargs):
        return self.forward(**kwargs)
    def dump_state(self, json_mode=False):
        return {name: {"instructions": predictor.signature.instructions} for name, predictor in self.named_predictors()}

def _plain(value):
    if isinstance(value, dict):
        return {key: _plain(item) for key, item in value.items()}
    return value

class GEPA:
    def __init__(self, metric=None, reflection_lm=None, **kwargs):
        self.metric = metric
        self.reflection_lm = reflection_lm
        self.kwargs = kwargs
    def compile(self, student, trainset=None, valset=None):
        copy.deepcopy(self.reflection_lm)(prompt="reflection")
        example = valset[0]
        settings.trace = []
        prediction = student(**example.inputs())
        trace = [
            {"predictor": name, "outputs": dict(entry[2].items())}
            for entry in settings.trace
            for name, predictor in student.named_predictors()
            if predictor is entry[0]
        ]
        settings.trace = None
        scored = self.metric(example, prediction, None, None, None)
        calls = [{"pred_name": None, "score": scored.score, "objective_scores": scored.objective_scores}]
        names = [name for name, _ in student.named_predictors()]
        for name in names:
            result = self.metric(example, prediction, None, name, None)
            calls.append({"pred_name": name, "score": result.score, "feedback": result.feedback})
        evolve = [item for item in os.environ.get("STUB_EVOLVE", ",".join(names)).split(",") if item]
        candidate = {
            name: ("evolved instruction" if name in evolve else predictor.signature.instructions)
            for name, predictor in student.named_predictors()
        }
        inner = self.kwargs.get("gepa_kwargs") or {}
        for callback in inner.get("callbacks") or []:
            callback.on_valset_evaluated({
                "iteration": 1, "candidate_idx": 1, "candidate": candidate, "average_score": 1.0,
                "num_examples_evaluated": len(valset), "total_valset_size": len(valset), "is_best_program": True,
            })
        with open(os.environ["GEPA_KWARGS_PATH"], "w", encoding="utf-8") as handle:
            json.dump({
                "metric_calls": calls,
                "trace": trace,
                "predictor_names": names,
                "seed_instructions": {name: predictor.signature.instructions for name, predictor in student.named_predictors()},
                "field_types": {
                    name: {field: str(annotation) for field, (annotation, _) in predictor.signature.fields.items()}
                    for name, predictor in student.named_predictors()
                },
                "component_selector": self.kwargs.get("component_selector"),
                "frontier_type": inner.get("frontier_type"),
                "trainset": len(trainset),
                "valset": len(valset),
            }, handle, default=str)
        evolved = copy.deepcopy(student)
        for name, predictor in evolved.named_predictors():
            predictor.signature.instructions = candidate[name]
        evolved.detailed_results = SimpleNamespace(
            val_aggregate_scores=[float(scored.score), 1.0], total_metric_calls=len(calls), num_full_val_evals=2,
        )
        return evolved
`, "utf8");
}
