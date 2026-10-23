// dspy-gepa multi-predictor task specs: spec and gold validation, typed fields,
// per-predictor metric and feedback, pred_name routing, flags, config binding, and
// end-to-end runs against provider-free stand-ins (and, opt-in, the real pinned
// DSPy 3.4.1 / GEPA 0.1.4 against a local OpenAI-compatible mock).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import { writeTaskSpecDspyStubs } from "./helpers/dspy-gepa-stubs.mjs";

const cli = ["node", resolve("dist/bin.js")];
const pythonAvailable = spawnSync("python3", ["--version"], { encoding: "utf8" }).status === 0;
// Opt-in: a Python with dspy==3.4.1 and gepa==0.1.4 installed runs the real engine.
const realDspyPython = process.env.UNDERSTUDY_TEST_DSPY_PYTHON;
const baseEnv = { ...process.env };
delete baseEnv.UNDERSTUDY_API_KEY;
delete baseEnv.UNDERSTUDY_GATEWAY_URL;
delete baseEnv.FORCE_COLOR;

const optimizeDir = (repo) => join(repo, ".understudy", "optimize-workload");
const runDir = (repo) => join(optimizeDir(repo), "dspy-gepa");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const spendArgs = ["--budget-usd", "1", "--input-usd-per-million", "1", "--output-usd-per-million", "2"];

const categories = ["emergency_repair_services", "general_inquiries", "facility_management_issues"];

// The Facility Support shape: two labels and a label set over one input.
function facilitySpec(overrides = {}) {
  return {
    schema_version: "understudy.dspy_gepa_task_spec.v1",
    inputs: ["message"],
    module: "cot",
    predictors: [
      {
        name: "urgency",
        output: "urgency",
        instructions: "Read the provided message and determine the urgency.",
        type: { kind: "label", labels: ["low", "medium", "high"] },
      },
      {
        name: "sentiment",
        output: "sentiment",
        instructions: "Read the provided message and determine the sentiment.",
        type: { kind: "label", labels: ["positive", "neutral", "negative"] },
      },
      {
        name: "categories",
        output: "categories",
        instructions: "Read the provided message and determine the set of categories applicable to the message.",
        type: { kind: "label-set", labels: categories },
      },
    ],
    ...overrides,
  };
}

// Gold alternates between the tutorial's {label: bool} object and a label list.
function facilityRows() {
  return Array.from({ length: 8 }, (_, index) => ({
    message: `private-message-${index}`,
    urgency: "high",
    sentiment: "negative",
    categories: index % 2
      ? Object.fromEntries(categories.map((label) => [label, label === "emergency_repair_services"]))
      : ["emergency_repair_services"],
    split: index < 2 ? "train" : index < 4 ? "dev" : index < 6 ? "holdout" : "unused",
  }));
}

// Seed predictors miss every label; evolved ones answer correctly.
const stubAnswers = {
  urgency: ["low", "high"],
  sentiment: ["neutral", "negative"],
  categories: [["general_inquiries"], ["emergency_repair_services"]],
};

function run(args, env = baseEnv) {
  return spawnSync(cli[0], [cli[1], ...args], { cwd: process.cwd(), encoding: "utf8", env });
}

function withRepo(fn) {
  const repo = mkdtempSync(join(tmpdir(), "understudy-dspy-gepa-spec-"));
  try {
    return fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function writeJson(repo, name, value) {
  const path = join(repo, name);
  writeFileSync(path, JSON.stringify(value, null, 2));
  return path;
}

function writeRuntime(repo) {
  const samples = writeJson(repo, "scaffold-samples.json", [{ q: "x", a: "y" }]);
  const scaffold = run([
    "optimize-workload", "adapter", "run", "--repo", repo, "--adapter", "dspy-gepa", "--samples", samples,
    "--input-keys", "q", "--output-keys", "a", "--model", "student", "--reflection-model", "reflection",
  ]);
  assert.equal(scaffold.status, 1);
  return join(optimizeDir(repo), "uv-runtime", "optimizer_runtime.py");
}

// Writes the runtime with the CLI, then runs it directly against the task-spec stubs.
function runSpec(repo, { spec = facilitySpec(), rows = facilityRows(), args = [], env = {} } = {}) {
  const runtime = writeRuntime(repo);
  const stubRoot = join(repo, "task-spec-stubs");
  if (!existsSync(stubRoot)) writeTaskSpecDspyStubs(stubRoot);
  const specPath = writeJson(repo, "task-spec.json", spec);
  const samplesPath = writeJson(repo, "samples.json", rows);
  const sentinel = join(repo, "provider-call-count");
  const gepaPath = join(repo, "gepa-seen.json");
  const result = spawnSync("python3", [
    runtime, "dspy-gepa", "--repo", repo, "--samples", samplesPath, "--task-spec", specPath,
    "--model", "student", "--reflection-model", "reflection", "--max-metric-calls", "4",
    "--track-stats", "true", "--prices-from-gateway", "off", ...spendArgs, ...args,
  ], {
    encoding: "utf8",
    env: {
      ...baseEnv,
      PYTHONPATH: stubRoot,
      PROVIDER_SENTINEL: sentinel,
      GEPA_KWARGS_PATH: gepaPath,
      STUB_ANSWERS: JSON.stringify(stubAnswers),
      UNDERSTUDY_API_KEY: "fixture-key",
      UNDERSTUDY_GATEWAY_URL: "http://127.0.0.1:9",
      UNDERSTUDY_AUTH_SOURCE: "fixture",
      ...env,
    },
  });
  return {
    result,
    runtime,
    stubRoot,
    sentinel,
    specPath,
    samplesPath,
    seen: () => readJson(gepaPath),
    payload: () => JSON.parse(result.stdout),
  };
}

// Loads the generated runtime as a module and prints one JSON value from a script.
function runtimeScript(runtime, body, env = baseEnv) {
  const script = `
import importlib.util, json, sys
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location("rt", sys.argv[1])
rt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rt)
${body}
`;
  const result = spawnSync("python3", ["-c", script, runtime], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const cliBase = (repo, specPath, samplesPath) => [
  "optimize-workload", "adapter", "run", "--repo", repo, "--adapter", "dspy-gepa", "--samples", samplesPath,
  "--task-spec", specPath, "--model", "student", "--reflection-model", "reflection", "--execute", ...spendArgs,
];

describe("dspy-gepa task spec validation", () => {
  it("rejects malformed specs and conflicting flags in the CLI before touching auth", () =>
    withRepo((repo) => {
      const samples = writeJson(repo, "samples.json", facilityRows());
      const predictor = facilitySpec().predictors[0];
      const cases = [
        [{ ...facilitySpec(), schema_version: "v0" }, [], /schema_version must be understudy\.dspy_gepa_task_spec\.v1/],
        [{ ...facilitySpec(), extra: 1 }, [], /spec has unknown keys: extra/],
        [facilitySpec({ inputs: [] }), [], /inputs must be a non-empty list/],
        [facilitySpec({ module: "react" }), [], /module must be predict or cot/],
        [facilitySpec({ predictors: [predictor, predictor] }), [], /repeats another predictor's name/],
        [facilitySpec({ predictors: [{ ...predictor, name: "forward" }] }), [], /not be a dspy\.Module member/],
        [facilitySpec({ predictors: [{ ...predictor, name: "Urgency" }] }), [], /name must match/],
        [facilitySpec({ predictors: [{ ...predictor, output: "message" }] }), [], /output must be a field name that is not reserved, an input/],
        [facilitySpec({ predictors: [{ ...predictor, output: "reasoning" }] }), [], /output must be a field name that is not reserved/],
        // dspy.Example/Prediction members read back as methods; the others fail late in DSPy.
        ...["labels", "items", "_private", "model_config", "model_extra", "signature", "instructions", "fields", "config", "lm"].map(
          (output) => [facilitySpec({ predictors: [{ ...predictor, output }] }), [], /output must be a field name that is not reserved/],
        ),
        ...["items", "inputs", "demos", "prediction", "_message"].map(
          (input) => [facilitySpec({ inputs: [input] }), [], /inputs must be a non-empty list of unique, non-reserved field names/],
        ),
        [facilitySpec({ predictors: [{ ...predictor, type: { kind: "label-set" } }] }), [], /labels must be 1 to 256 unique/],
        [facilitySpec({ predictors: [{ ...predictor, type: { kind: "label", labels: ["a", "A"] } }] }), [], /labels must be 1 to 256 unique/],
        [facilitySpec({ predictors: [{ ...predictor, type: { kind: "label", labels: [" a"] } }] }), [], /without surrounding whitespace/],
        [facilitySpec({ predictors: [{ ...predictor, type: { kind: "text", labels: ["a"] } }] }), [], /labels is not allowed for text/],
        [facilitySpec({ predictors: [{ ...predictor, type: { kind: "json" } }] }), [], /type\.kind must be label, label-set, or text/],
        [facilitySpec({ predictors: [{ ...predictor, instructions: " " }] }), [], /instructions must be non-empty text/],
        [facilitySpec(), ["--output-keys", "urgency"], /--task-spec and --output-keys are mutually exclusive/],
        [facilitySpec(), ["--input-keys", "message"], /--task-spec defines the input keys/],
        [facilitySpec(), ["--module", "predict"], /--module predict differs from the task spec's module \(cot\)/],
        [facilitySpec(), ["--frontier-type", "pareto"], /--frontier-type must be one of: instance, objective, hybrid, cartesian/],
      ];
      for (const [spec, extra, pattern] of cases) {
        const specPath = writeJson(repo, "spec.json", spec);
        const result = run([...cliBase(repo, specPath, samples), ...extra]);
        assert.notEqual(result.status, 0, String(pattern));
        assert.match(result.stderr, pattern);
        assert.doesNotMatch(result.stderr, /login|api key|uv run/i, String(pattern));
      }
      const notJson = join(repo, "not-json.json");
      writeFileSync(notJson, "{");
      assert.match(run(cliBase(repo, notJson, samples)).stderr, /--task-spec must contain valid JSON/);
      const linked = join(repo, "linked.json");
      symlinkSync(writeJson(repo, "real-spec.json", facilitySpec()), linked);
      assert.match(run(cliBase(repo, linked, samples)).stderr, /--task-spec must point to a non-symlink regular file/);
      if (process.getuid?.() !== 0) {
        const locked = writeJson(repo, "locked.json", facilitySpec());
        chmodSync(locked, 0o200);
        assert.match(run(cliBase(repo, locked, samples)).stderr, /--task-spec must be readable by its owner/);
      }
    }));

  it("needs a task spec for objective frontiers and refuses one for program bridges", () =>
    withRepo((repo) => {
      const samples = writeJson(repo, "samples.json", [{ q: "x", a: "y" }]);
      for (const frontier of ["objective", "hybrid", "cartesian"]) {
        const result = run([
          "optimize-workload", "adapter", "run", "--repo", repo, "--adapter", "dspy-gepa", "--samples", samples,
          "--input-keys", "q", "--output-keys", "a", "--model", "student", "--reflection-model", "reflection",
          "--frontier-type", frontier, "--execute", ...spendArgs,
        ]);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, new RegExp(`--frontier-type ${frontier} requires --task-spec`));
      }
      const bridge = join(repo, "bridge.py");
      const bridgeConfig = writeJson(repo, "bridge-config.json", { schema_version: "understudy.dspy_gepa_bridge_config.v1" });
      writeFileSync(bridge, "\n");
      const specPath = writeJson(repo, "spec.json", facilitySpec());
      const result = run([
        "optimize-workload", "adapter", "run", "--repo", repo, "--adapter", "dspy-gepa",
        "--program-bridge", bridge, "--program-bridge-config", bridgeConfig, "--admission-only",
        "--task-spec", specPath, "--model", "student", "--reflection-model", "reflection", "--execute", ...spendArgs,
      ]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /--task-spec is not supported with --program-bridge/);
    }));

  it("forwards the spec path, its module and the search flags to the runtime", () =>
    withRepo((repo) => {
      const fakeBin = join(repo, "fake-bin");
      const uvArgsPath = join(repo, "uv-args.txt");
      mkdirSync(fakeBin);
      writeFileSync(join(fakeBin, "uv"), `#!/bin/sh
printf '%s\\n' "$@" > "$UV_ARGS_SENTINEL"
printf '%s\\n' '{"schema_version":"fixture.uv.v1","status":"fixture-ok"}'
`, { encoding: "utf8", mode: 0o755 });
      const specPath = writeJson(repo, "spec.json", facilitySpec());
      const samples = writeJson(repo, "samples.json", facilityRows());
      const result = run([...cliBase(repo, specPath, samples), "--frontier-type", "hybrid", "--component-selector", "all"], {
        ...baseEnv,
        PATH: `${fakeBin}:${baseEnv.PATH}`,
        UV_ARGS_SENTINEL: uvArgsPath,
        UNDERSTUDY_API_KEY: "fixture-key",
        UNDERSTUDY_GATEWAY_URL: "http://127.0.0.1:9",
        UNDERSTUDY_TELEMETRY: "0",
      });
      assert.equal(result.status, 0, result.stderr);
      const uvArgs = readFileSync(uvArgsPath, "utf8").trim().split("\n");
      const flagValue = (flag) => uvArgs[uvArgs.indexOf(flag) + 1];
      assert.equal(flagValue("--task-spec"), specPath);
      assert.equal(flagValue("--module"), "cot");
      assert.equal(flagValue("--frontier-type"), "hybrid");
      assert.equal(flagValue("--component-selector"), "all");
      assert.equal(uvArgs.includes("--input-keys"), false);
      assert.equal(uvArgs.includes("--output-keys"), false);
    }));

  it("re-validates the spec in the runtime, before any provider call", { skip: !pythonAvailable }, () =>
    withRepo((repo) => {
      const runtime = writeRuntime(repo);
      const seen = runtimeScript(runtime, `
base = ${JSON.stringify(facilitySpec())}
def check(mutate):
    import copy
    raw = copy.deepcopy(base)
    mutate(raw)
    try:
        return rt.validate_task_spec(raw)
    except rt.TaskSpecError as error:
        return "error: " + str(error)
def drop_module(raw): raw.pop("module")
def text_predictor(raw): raw["predictors"] = [{"name": "summary", "type": {"kind": "text"}}]
def reserved(raw): raw["predictors"][0]["name"] = "named_predictors"
def dup_output(raw): raw["predictors"][1]["output"] = "urgency"
def bad_labels(raw): raw["predictors"][2]["type"]["labels"] = ["a", 3]
def unknown_type_key(raw): raw["predictors"][0]["type"]["values"] = []
print(json.dumps({
    "ok": check(lambda raw: None),
    "default_module": check(drop_module)["module"],
    "text": check(text_predictor)["predictors"],
    "reserved": check(reserved),
    "dup_output": check(dup_output),
    "bad_labels": check(bad_labels),
    "unknown_type_key": check(unknown_type_key),
}))
`);
      assert.equal(seen.ok.module, "cot");
      assert.deepEqual(seen.ok.inputs, ["message"]);
      assert.deepEqual(seen.ok.predictors[2].type, { kind: "label-set", labels: categories });
      assert.equal(seen.default_module, "predict");
      // output defaults to the predictor name; instructions stay optional.
      assert.deepEqual(seen.text, [{ name: "summary", output: "summary", instructions: null, type: { kind: "text" } }]);
      assert.match(seen.reserved, /^error: task-spec-invalid: predictors\[0\]\.name is reserved by dspy\.Module/);
      assert.match(seen.dup_output, /predictors\[1\]\.output repeats another predictor's output/);
      assert.match(seen.bad_labels, /predictors\[2\]\.type\.labels must be/);
      assert.match(seen.unknown_type_key, /predictors\[0\]\.type has unknown keys/);
    }));

  it("rejects field names DSPy reads back as methods or rejects late, also against the installed dspy", { skip: !pythonAvailable }, () =>
    withRepo((repo) => {
      const runtime = writeRuntime(repo);
      const stubRoot = join(repo, "task-spec-stubs");
      writeTaskSpecDspyStubs(stubRoot);
      const seen = runtimeScript(runtime, `
import copy, dspy
base = ${JSON.stringify(facilitySpec())}
def rejected(mutate):
    raw = copy.deepcopy(base)
    mutate(raw)
    try:
        rt.validate_task_spec(raw)
        return False
    except rt.TaskSpecError:
        return True
names = ["labels", "items", "keys", "values", "inputs", "get", "copy", "toDict", "without", "with_inputs",
         "completions", "from_completions", "get_lm_usage", "set_lm_usage", "_private", "model_config",
         "model_extra", "signature", "instructions", "fields", "config", "demos", "lm", "new_signature", "prediction"]
def as_output(name):
    def mutate(raw): raw["predictors"][0]["output"] = name
    return mutate
def as_input(name):
    def mutate(raw): raw["inputs"] = [name]
    return mutate
# A member the static list does not know (a later dspy) is caught when the program is built.
later = rt.validate_task_spec({**base, "inputs": ["to_metadata"]})
try:
    rt.build_task_spec_program(dspy, later)
    later_member = "built"
except rt.TaskSpecError as error:
    later_member = str(error)
store = dspy.Prediction(labels=["a"], items="x")
print(json.dumps({
    "output_rejected": [name for name in names if not rejected(as_output(name))],
    "input_rejected": [name for name in names if not rejected(as_input(name))],
    "plain_ok": not rejected(as_output("Label_2")),
    "later_member": later_member,
    "attribute_is_method": callable(store.labels),
    "by_key": [rt.field_value(store, "labels"), rt.field_value(store, "items"), rt.field_value(store, "nope")],
    "namespace": rt.field_value(SimpleNamespace(urgency="high"), "urgency"),
}))
`, { ...baseEnv, PYTHONPATH: stubRoot });
      assert.deepEqual(seen.output_rejected, []);
      assert.deepEqual(seen.input_rejected, []);
      assert.equal(seen.plain_ok, true);
      assert.equal(seen.later_member, "task-spec-invalid: field name to_metadata is a dspy.Example or dspy.Prediction member");
      // Attribute access returns the store's method; the runtime reads values by key.
      assert.equal(seen.attribute_is_method, true);
      assert.deepEqual(seen.by_key, [["a"], "x", null]);
      assert.equal(seen.namespace, "high");
    }));

  it("fails closed on a bad gold value, naming the row index and never its content", { skip: !pythonAvailable }, () =>
    withRepo((repo) => {
      const cases = [
        [(rows) => { rows[3].urgency = "SECRET-critical"; }, /^task-spec-gold-invalid: sample row 3, predictor urgency: label is not in the spec's label set$/],
        [(rows) => { rows[1].categories = { SECRET_label: true }; }, /^task-spec-gold-invalid: sample row 1, predictor categories: label is not in the spec's label set$/],
        [(rows) => { rows[1].categories = { emergency_repair_services: "SECRET-yes" }; }, /sample row 1, predictor categories: label-set object values must be true or false/],
        [(rows) => { rows[0].categories = ["general_inquiries", "general_inquiries"]; }, /sample row 0, predictor categories: label-set list repeats a label/],
        [(rows) => { rows[2].sentiment = ["SECRET"]; }, /sample row 2, predictor sentiment: expected a string label/],
        [(rows) => { delete rows[2].sentiment; }, /sample row 2 has no gold sentiment for predictor sentiment/],
        [(rows) => { delete rows[0].message; }, /sample row 0 is missing input message/],
      ];
      for (const [mutate, pattern] of cases) {
        const caseRepo = mkdtempSync(join(repo, "case-"));
        const rows = facilityRows();
        mutate(rows);
        const { result, sentinel, payload } = runSpec(caseRepo, { rows });
        assert.equal(result.status, 3, result.stderr);
        assert.equal(payload().status, "error");
        assert.match(payload().reason, pattern);
        assert.equal(payload().provider_calls, false);
        assert.equal(existsSync(sentinel), false);
        assert.equal(result.stdout.includes("SECRET"), false);
        assert.equal(readFileSync(join(runDir(caseRepo), "events.jsonl"), "utf8").includes("SECRET"), false);
      }
      // Holdout rows are checked only when the holdout is evaluated; unused splits never.
      const rows = facilityRows();
      rows[4].urgency = "SECRET-critical";
      rows[7].urgency = "SECRET-critical";
      const skipped = runSpec(mkdtempSync(join(repo, "skip-")), { rows });
      assert.equal(skipped.result.status, 0, skipped.result.stderr);
      const evaluated = runSpec(mkdtempSync(join(repo, "eval-")), { rows, args: ["--evaluate-holdout"] });
      assert.equal(evaluated.result.status, 3);
      assert.match(evaluated.payload().reason, /sample row 4, predictor urgency/);
      assert.equal(existsSync(evaluated.sentinel), false);
    }));

  it("rejects input/output keys, objective frontiers without a spec, and a module mismatch in the runtime", { skip: !pythonAvailable }, () =>
    withRepo((repo) => {
      for (const [args, spec, pattern] of [
        [["--output-keys", "urgency"], facilitySpec(), /^invalid-runtime-input$/],
        [["--module", "predict"], facilitySpec(), /^task-spec-invalid: --module differs from the spec's module$/],
        [["--frontier-type", "weird"], facilitySpec(), /^invalid-runtime-input$/],
      ]) {
        const { result, sentinel, payload } = runSpec(mkdtempSync(join(repo, "case-")), { spec, args });
        assert.equal(result.status, 3, result.stderr);
        assert.match(payload().reason, pattern);
        assert.equal(existsSync(sentinel), false);
      }
      const runtime = writeRuntime(repo);
      const samples = writeJson(repo, "plain.json", [{ q: "x", a: "y" }, { q: "z", a: "w" }]);
      const plain = spawnSync("python3", [
        runtime, "dspy-gepa", "--repo", repo, "--samples", samples, "--input-keys", "q", "--output-keys", "a",
        "--model", "student", "--reflection-model", "reflection", "--frontier-type", "hybrid", ...spendArgs,
      ], { encoding: "utf8", env: { ...baseEnv, UNDERSTUDY_API_KEY: "fixture-key" } });
      assert.equal(plain.status, 3);
      assert.equal(JSON.parse(plain.stdout).reason, "invalid-runtime-input");
    }));
});

describe("dspy-gepa task spec metric", () => {
  it("builds typed output fields: label, label-set and text", { skip: !pythonAvailable }, () =>
    withRepo((repo) => {
      const runtime = writeRuntime(repo);
      const seen = runtimeScript(runtime, `
def kind(kind, labels=None):
    predictor = {"type": {"kind": kind, **({"labels": labels} if labels else {})}}
    return str(rt.task_spec_output_type(predictor))
print(json.dumps({
    "label": kind("label", ["low", "medium", "high"]),
    "one": kind("label", ["only"]),
    "set": kind("label-set", ["a", "b"]),
    "text": kind("text"),
}))
`);
      assert.equal(seen.label, "typing.Literal['low', 'medium', 'high']");
      assert.equal(seen.one, "typing.Literal['only']");
      assert.equal(seen.set, "list[typing.Literal['a', 'b']]");
      assert.equal(seen.text, "<class 'str'>");
    }));

  it("scores each predictor, averages them, and routes feedback by pred_name", { skip: !pythonAvailable }, () =>
    withRepo((repo) => {
      const { runtime, stubRoot } = runSpec(repo);
      const spec = facilitySpec({
        predictors: [...facilitySpec().predictors, { name: "summary", type: { kind: "text" } }],
      });
      const seen = runtimeScript(runtime, `
spec = rt.validate_task_spec(${JSON.stringify(spec)})
labels = spec["predictors"][2]
gold_dict = {"emergency_repair_services": True, "general_inquiries": True, "facility_management_issues": False}
gold = SimpleNamespace(
    urgency="high", sentiment="negative", summary="Water leak",
    categories=rt.task_spec_gold(labels, gold_dict),
)
routing = {"urgency.predict": "urgency", "sentiment.predict": "sentiment", "categories.predict": "categories", "summary.predict": "summary"}
pred = SimpleNamespace(urgency="high", sentiment="positive", categories=["general_inquiries", "facility_management_issues"], summary="water leak")
def result(pred_name, mode="exact", prediction=pred):
    out = rt.task_spec_feedback(spec, routing, gold, prediction, mode, pred_name)
    return {"score": out.score, "feedback": out.feedback, "objective_scores": out.objective_scores}
perfect = SimpleNamespace(urgency="high", sentiment="negative", categories=["emergency_repair_services", "general_inquiries"], summary="Water leak")
print(json.dumps({
    "gold_from_dict": gold.categories,
    "gold_from_list": rt.task_spec_gold(labels, ["general_inquiries", "emergency_repair_services"]),
    "none": result(None),
    "urgency": result("urgency.predict"),
    "sentiment": result("sentiment.predict"),
    "categories": result("categories.predict"),
    "summary": result("summary.predict"),
    "summary_ci": result("summary.predict", "case-insensitive"),
    "plain_name": result("sentiment")["feedback"],
    "unknown": result("other.predict")["feedback"],
    "perfect": result("categories.predict", prediction=perfect),
    "outside": result("categories.predict", prediction=SimpleNamespace(**{**vars(perfect), "categories": ["emergency_repair_services", "general_inquiries", "made_up"]}))["feedback"],
}))
`, { ...baseEnv, PYTHONPATH: stubRoot });
      // A {label: bool} gold becomes its true labels in spec order.
      assert.deepEqual(seen.gold_from_dict, ["emergency_repair_services", "general_inquiries"]);
      assert.deepEqual(seen.gold_from_list, ["emergency_repair_services", "general_inquiries"]);
      // categories: emergency missed, general hit, facility wrongly included -> 1/3 agreement;
      // the summary differs only in letter case, so it misses under exact match.
      const objectives = { urgency: 1, sentiment: 0, categories: 1 / 3, summary: 0 };
      assert.deepEqual(seen.none.objective_scores, objectives);
      assert.equal(seen.none.score, (1 + 0 + 1 / 3 + 0) / 4);
      assert.match(seen.none.feedback, /^urgency: You correctly classified/m);
      assert.match(seen.none.feedback, /^summary: /m);
      // Every pred_name call returns the module-level score with that predictor's feedback.
      for (const name of ["urgency", "sentiment", "categories", "summary"]) {
        assert.equal(seen[name].score, seen.none.score);
        assert.deepEqual(seen[name].objective_scores, objectives);
      }
      assert.equal(
        seen.urgency.feedback,
        "You correctly classified the urgency of the message as `high`. This message is indeed of `high` urgency.",
      );
      assert.equal(
        seen.sentiment.feedback,
        "You incorrectly classified the sentiment of the message as `positive`. The correct sentiment is `negative`. "
          + "Think about how you could have reasoned to get the correct sentiment label.",
      );
      assert.match(seen.categories.feedback, /^The categories classification is not perfect\. You correctly identified that the message falls under the following categories: `\['general_inquiries'\]`\./);
      assert.match(seen.categories.feedback, /However, you incorrectly identified that the message falls under the following categories: `\['facility_management_issues'\]`\. The message DOES NOT fall under these categories\./);
      assert.match(seen.categories.feedback, /Additionally, you didn't identify the following categories that the message actually falls under: `\['emergency_repair_services'\]`\./);
      assert.match(seen.summary.feedback, /expected summary is `Water leak`\. It differs only in letter case\./);
      assert.equal(seen.summary_ci.objective_scores.summary, 1);
      assert.equal(seen.plain_name, seen.sentiment.feedback);
      assert.match(seen.unknown, /^urgency: .*\nsentiment: /s);
      assert.equal(seen.perfect.objective_scores.categories, 1);
      assert.match(seen.perfect.feedback, /^The categories classification is perfect\./);
      assert.match(seen.outside, /These values are not valid categories labels: `\['made_up'\]`/);
    }));

  it("maps DSPy predictor names to spec names for cot and predict layouts", { skip: !pythonAvailable }, () =>
    withRepo((repo) => {
      const { runtime, stubRoot } = runSpec(repo);
      const seen = runtimeScript(runtime, `
import dspy
out = {}
for module in ("cot", "predict"):
    spec = rt.validate_task_spec({**${JSON.stringify(facilitySpec())}, "module": module})
    program = rt.build_task_spec_program(dspy, spec)
    out[module] = rt.task_spec_predictor_routing(program, spec)
print(json.dumps(out))
`, { ...baseEnv, PYTHONPATH: stubRoot });
      assert.deepEqual(seen.cot, { "urgency.predict": "urgency", "sentiment.predict": "sentiment", "categories.predict": "categories" });
      assert.deepEqual(seen.predict, { urgency: "urgency", sentiment: "sentiment", categories: "categories" });
    }));
});

describe("dspy-gepa task spec runs", () => {
  it("optimizes every predictor and reports instructions and holdout scores per predictor", { skip: !pythonAvailable }, () =>
    withRepo((repo) => {
      const { result, seen, payload, sentinel } = runSpec(repo, {
        args: ["--evaluate-holdout", "--frontier-type", "hybrid", "--component-selector", "all"],
        env: { STUB_EVOLVE: "urgency.predict,categories.predict" },
      });
      assert.equal(result.status, 0, result.stderr);
      const gepa = seen();
      // Typed fields reached DSPy, one ChainOfThought per predictor.
      assert.deepEqual(gepa.predictor_names, ["urgency.predict", "sentiment.predict", "categories.predict"]);
      assert.equal(gepa.field_types["urgency.predict"].urgency, "typing.Literal['low', 'medium', 'high']");
      assert.equal(gepa.field_types["categories.predict"].categories, `list[typing.Literal[${categories.map((c) => `'${c}'`).join(", ")}]]`);
      assert.equal(gepa.field_types["urgency.predict"].message, "<class 'str'>");
      assert.equal(gepa.seed_instructions["sentiment.predict"], "Read the provided message and determine the sentiment.");
      assert.equal(gepa.frontier_type, "hybrid");
      assert.equal(gepa.component_selector, "all");
      assert.deepEqual([gepa.trainset, gepa.valset], [2, 2]);
      // GEPA scored with pred_name=None, then asked each predictor for feedback.
      assert.deepEqual(gepa.metric_calls.map((call) => call.pred_name), [null, "urgency.predict", "sentiment.predict", "categories.predict"]);
      assert.deepEqual(gepa.metric_calls[0].objective_scores, { urgency: 0, sentiment: 0, categories: 1 / 3 });
      assert.match(gepa.metric_calls[2].feedback, /^You incorrectly classified the sentiment/);

      const candidate = readJson(join(optimizeDir(repo), "candidate.json"));
      assert.equal(candidate.module, "cot");
      assert.deepEqual(candidate.input_keys, ["message"]);
      assert.deepEqual(candidate.output_keys, ["urgency", "sentiment", "categories"]);
      assert.equal(candidate.instructions_changed, true);
      assert.deepEqual(candidate.instructions_changed_by_predictor, { urgency: true, sentiment: false, categories: true });
      assert.deepEqual(candidate.predictors.sentiment, {
        dspy_predictor: "sentiment.predict",
        output: "sentiment",
        kind: "label",
        baseline_instructions: "Read the provided message and determine the sentiment.",
        optimized_instructions: "Read the provided message and determine the sentiment.",
        instructions_changed: false,
      });
      assert.equal(candidate.predictors.urgency.optimized_instructions, "evolved instruction");
      assert.equal(candidate.optimized_instructions["urgency.predict"], "evolved instruction");
      assert.deepEqual(candidate.baseline_first_objective_scores, { urgency: 0, sentiment: 0, categories: 1 / 3 });
      assert.equal(candidate.search.frontier_type, "hybrid");
      assert.equal(candidate.search.component_selector, "all");
      assert.equal(candidate.task_spec.spec.predictors.length, 3);
      assert.deepEqual(payload().instructions_changed_by_predictor, candidate.instructions_changed_by_predictor);

      // best-so-far is keyed by DSPy predictor name, so it can seed a later run.
      const best = readJson(join(runDir(repo), "best-so-far.json"));
      assert.deepEqual(Object.keys(best.instructions).sort(), ["categories.predict", "sentiment.predict", "urgency.predict"]);

      const evaluation = readJson(join(runDir(repo), "holdout-evaluation.json"));
      assert.equal(evaluation.aggregate, "mean-of-predictor-scores");
      assert.deepEqual(evaluation.predictors, ["urgency", "sentiment", "categories"]);
      assert.equal(evaluation.count, 2);
      assert.deepEqual(evaluation.baseline.by_predictor.urgency, { score: 0, by_match: { exact: 0, "case-insensitive": 0 } });
      assert.equal(evaluation.optimized.by_predictor.urgency.score, 1);
      assert.equal(evaluation.optimized.by_predictor.sentiment.score, 0);
      assert.equal(evaluation.optimized.by_predictor.categories.score, 1);
      assert.equal(evaluation.optimized.score, 2 / 3);
      assert.deepEqual(evaluation.delta_by_predictor, { urgency: 1, sentiment: 0, categories: 1 - 1 / 3 });
      assert.deepEqual(evaluation.rows[0].expected, { urgency: "high", sentiment: "negative", categories: ["emergency_repair_services"] });
      assert.deepEqual(evaluation.rows[0].optimized, { urgency: "high", sentiment: "neutral", categories: ["emergency_repair_services"] });
      // Inputs stay out of every artifact.
      for (const path of [join(optimizeDir(repo), "candidate.json"), join(runDir(repo), "holdout-evaluation.json"), join(runDir(repo), "events.jsonl")]) {
        assert.equal(readFileSync(path, "utf8").includes("private-message"), false, path);
      }
      // Baseline row, reflection, the stub GEPA's scoring row, then 2 holdout rows per
      // program; every row costs one call per predictor.
      assert.equal(readFileSync(sentinel, "utf8").trim().split("\n").length, 3 + 1 + 3 + 3 * 2 * 2);
    }));

  it("scores an unparseable answer 0 for that predictor instead of failing the row", { skip: !pythonAvailable }, () =>
    withRepo((repo) => {
      // The seed urgency predictor answers outside its Literal, so DSPy raises
      // AdapterParseError; the evolved one answers correctly.
      const answers = { ...stubAnswers, urgency: ["__unparseable__", "high"] };
      const { result, seen, payload } = runSpec(repo, {
        args: ["--evaluate-holdout", "--frontier-type", "objective"],
        env: { STUB_ANSWERS: JSON.stringify(answers) },
      });
      assert.equal(result.status, 0, result.stderr);
      const gepa = seen();
      // The row still reports every objective, so GEPA's objective frontier averages
      // over every row instead of only the rows that parsed.
      assert.deepEqual(gepa.metric_calls[0].objective_scores, { urgency: 0, sentiment: 0, categories: 1 / 3 });
      const urgency = gepa.metric_calls.find((call) => call.pred_name === "urgency.predict");
      assert.equal(
        urgency.feedback,
        "Your urgency answer could not be parsed as one of the allowed labels: `['low', 'medium', 'high']`. "
          + "The correct urgency is `high`. Answer with labels copied exactly as listed, with the same letter case "
          + "and spelling, and nothing else.",
      );
      // The failed predictor still leaves a trace entry with the raw response to reflect on.
      assert.deepEqual(gepa.trace.find((entry) => entry.predictor === "urgency.predict").outputs, {
        urgency: "[[ ## urgency ## ]]\nNot A Label",
      });
      assert.deepEqual(gepa.trace.find((entry) => entry.predictor === "sentiment.predict").outputs, { sentiment: "neutral" });
      const evaluation = readJson(join(runDir(repo), "holdout-evaluation.json"));
      assert.equal(evaluation.baseline.errors, 0);
      assert.equal(evaluation.baseline.by_predictor.urgency.score, 0);
      assert.equal(evaluation.optimized.by_predictor.urgency.score, 1);
      assert.equal(evaluation.rows[0].baseline.urgency, "");
      assert.equal(payload().status, "candidate-created");

      // Only parse errors are caught: a spend stop inside a predictor still ends the run.
      const blocked = runSpec(mkdtempSync(join(repo, "blocked-")), {
        args: ["--budget-usd", "0.000001"],
        env: { STUB_ANSWERS: JSON.stringify(answers) },
      });
      assert.equal(blocked.result.status, 4, blocked.result.stderr);
      assert.equal(blocked.payload().status, "budget-blocked");
    }));

  it("seeds predictors by spec name or DSPy name", { skip: !pythonAvailable }, () =>
    withRepo((repo) => {
      const seed = writeJson(repo, "seed.json", { urgency: "seeded urgency", "sentiment.predict": "seeded sentiment" });
      const { result, seen } = runSpec(repo, { args: ["--seed-instructions", seed] });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(seen().seed_instructions["urgency.predict"], "seeded urgency");
      assert.equal(seen().seed_instructions["sentiment.predict"], "seeded sentiment");
      assert.match(seen().seed_instructions["categories.predict"], /^Read the provided message/);
      const bad = writeJson(repo, "bad-seed.json", { priority: "x" });
      const rejected = runSpec(mkdtempSync(join(repo, "bad-")), { args: ["--seed-instructions", bad] });
      assert.equal(rejected.result.status, 3);
      assert.equal(existsSync(rejected.sentinel), false);
    }));

  it("binds the spec content and search settings into the config hash", { skip: !pythonAvailable }, () =>
    withRepo((repo) => {
      const first = runSpec(repo);
      assert.equal(first.result.status, 0, first.result.stderr);
      const config = readJson(join(runDir(repo), "config.json"));
      assert.equal(config.task_spec.logical_path, "task-spec.json");
      assert.match(config.task_spec.sha256, /^[0-9a-f]{64}$/);
      assert.equal(config.task_spec.spec.module, "cot");
      assert.deepEqual(config.input_keys, ["message"]);
      assert.equal(config.search.frontier_type, "instance");
      // The default frontier is left to GEPA rather than passed explicitly.
      assert.equal(first.seen().frontier_type, null);
      assert.equal(config.search.component_selector, "round_robin");

      // Same log dir, different spec text: resume refuses before any provider call.
      const changed = facilitySpec();
      changed.predictors[0].instructions = "Decide the urgency.";
      rmSync(first.sentinel, { force: true });
      const second = runSpec(repo, { spec: changed });
      assert.equal(second.result.status, 6, second.result.stderr);
      assert.equal(second.payload().status, "resume-blocked");
      assert.equal(second.payload().reason, "resume-log-config-mismatch");
      assert.equal(existsSync(second.sentinel), false);
      const third = runSpec(repo, { args: ["--frontier-type", "objective"] });
      assert.equal(third.payload().reason, "resume-log-config-mismatch");

      // A fresh repo with the changed spec hashes differently.
      const other = mkdtempSync(join(repo, "other-"));
      assert.equal(runSpec(other, { spec: changed }).result.status, 0);
      assert.notEqual(readJson(join(runDir(other), "config.json")).config_sha256, first.payload().config_sha256);
    }));

  it("keeps the single-signature path unchanged when no spec is given", { skip: !pythonAvailable }, () =>
    withRepo((repo) => {
      const runtime = writeRuntime(repo);
      const seen = runtimeScript(runtime, `
import argparse
args = argparse.Namespace(rounds="1", proposals_per_iteration="1", stop_after_stale=None, proposer_max_chars=None,
    stop_at_score=None, max_minutes=None, min_round_gain="0", match_mode="exact", proposer_skill=[],
    seed_instructions=None, frontier_type="instance", task_spec=None, program_bridge=None, module=None,
    input_keys="q", output_keys="a", evaluate_holdout=False, no_spend_ledger=False, train_split="train", dev_split="dev")
rt.validate_search_options(args)
print(json.dumps({"module": args.module, "task_spec": args.task_spec_data, "keys": [args.input_keys, args.output_keys]}))
`);
      assert.deepEqual(seen, { module: "predict", task_spec: null, keys: ["q", "a"] });
    }));
});

// Opt-in end to end on the real pinned engine. Set UNDERSTUDY_TEST_DSPY_PYTHON to a
// Python with dspy==3.4.1 and gepa==0.1.4; calls go to a local mock, never a provider.
const mockSource = String.raw`
import json, re, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
RIGHT = {"urgency": "high", "sentiment": "negative", "categories": '["emergency_repair_services"]'}
WRONG = {"urgency": "low", "sentiment": "neutral", "categories": '["general_inquiries"]'}
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
        system = request["messages"][0]["content"] if request["messages"][0]["role"] == "system" else ""
        system = system if isinstance(system, str) else json.dumps(system)
        match = re.search(r"Your output fields are:(.*?)(?:All interactions|$)", system, re.S)
        fields = re.findall(r"\d+\. .(\w+).", match.group(1)) if match else ["answer"]
        if any("instruction" in field for field in fields):
            content = json.dumps({field: "evolved instruction" if "instruction" in field else "ok" for field in fields})
        else:
            table = RIGHT if "evolved" in system else WRONG
            content = "\n\n".join(f"[[ ## {field} ## ]]\n" + ("thinking" if field == "reasoning" else table.get(field, "x")) for field in fields)
            content += "\n\n[[ ## completed ## ]]"
        with open(sys.argv[2], "a") as log:
            log.write(json.dumps({"fields": fields}) + "\n")
        body = json.dumps({"id": "x", "object": "chat.completion", "model": request.get("model"),
            "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 50, "completion_tokens": 20, "total_tokens": 70}}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
open(sys.argv[1], "w").write(str(server.server_port))
server.serve_forever()
`;

// Starts the local mock provider, runs fn(port, callLog), and stops it.
function withMockProvider(repo, fn) {
  const portFile = join(repo, "port");
  const callLog = join(repo, "calls.jsonl");
  const mockPath = join(repo, "mock.py");
  writeFileSync(mockPath, mockSource);
  const server = spawn("python3", [mockPath, portFile, callLog], { stdio: "ignore" });
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(portFile) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    return fn(readFileSync(portFile, "utf8").trim(), callLog);
  } finally {
    server.kill();
  }
}

function runRealEngine(repo, port, args) {
  const runtime = writeRuntime(repo);
  const specPath = writeJson(repo, "task-spec.json", facilitySpec());
  const samplesPath = writeJson(repo, "samples.json", facilityRows());
  return spawnSync(realDspyPython, [
    "-I", runtime, "dspy-gepa", "--repo", repo, "--samples", samplesPath, "--task-spec", specPath,
    "--model", "student-model", "--reflection-model", "reflection-model",
    "--max-tokens", "512", "--track-stats", "true", "--prices-from-gateway", "off",
    "--frontier-type", "hybrid", "--evaluate-holdout", ...args,
  ], {
    encoding: "utf8",
    cwd: repo,
    env: { ...baseEnv, UNDERSTUDY_API_KEY: "fixture-key", UNDERSTUDY_GATEWAY_URL: `http://127.0.0.1:${port}` },
    timeout: 300_000,
  });
}

describe("dspy-gepa task spec on the real engine", () => {
  it("climbs a three-predictor Facility Support program against a local mock", { skip: !realDspyPython }, () =>
    withRepo((repo) => withMockProvider(repo, (port) => {
      const result = runRealEngine(repo, port, ["--max-metric-calls", "30", ...spendArgs]);
      assert.equal(result.status, 0, result.stderr.slice(-2000));
      const candidate = readJson(join(optimizeDir(repo), "candidate.json"));
      assert.deepEqual(Object.keys(candidate.predictors).sort(), ["categories", "sentiment", "urgency"]);
      assert.equal(candidate.predictors.urgency.dspy_predictor, "urgency.predict");
      assert.equal(candidate.instructions_changed, true);
      assert.equal(candidate.stopped_by, null);
      const evaluation = readJson(join(runDir(repo), "holdout-evaluation.json"));
      assert.equal(evaluation.status, "complete");
      assert.ok(evaluation.optimized.score > evaluation.baseline.score);
      assert.deepEqual(evaluation.predictors, ["urgency", "sentiment", "categories"]);
      assert.deepEqual(Object.keys(evaluation.optimized.by_predictor).sort(), ["categories", "sentiment", "urgency"]);
    })));

  it("stops a real GEPA run before a tight cap, keeps its best candidate, and scores the holdout", { skip: !realDspyPython }, () =>
    withRepo((repo) => withMockProvider(repo, (port) => {
      const cap = 0.05;
      const result = runRealEngine(repo, port, [
        "--max-metric-calls", "5000", "--rounds", "3",
        "--budget-usd", String(cap), "--input-usd-per-million", "1", "--output-usd-per-million", "2",
      ]);
      assert.equal(result.status, 0, result.stderr.slice(-2000));
      // DSPy's progress bars share stdout with the payload, so read the run state.
      const payload = readJson(join(runDir(repo), "run-state.json"));
      assert.equal(payload.status, "candidate-created");
      assert.equal(payload.stopped_by, "spend-governor");
      const candidate = readJson(join(optimizeDir(repo), "candidate.json"));
      assert.equal(candidate.stopped_by, "spend-governor");
      assert.equal(candidate.rounds.length, 1);
      assert.equal(candidate.instructions_changed, true);
      const evaluation = readJson(join(runDir(repo), "holdout-evaluation.json"));
      assert.equal(evaluation.status, "complete");
      assert.ok(evaluation.optimized.score > evaluation.baseline.score);
      // Stopped between iterations, before any call was refused, inside the cap.
      const evidence = payload.spend_evidence;
      assert.equal(evidence.calls_attempted, evidence.calls_completed);
      assert.equal(evidence.spend_governor.phase_refusals, 0);
      assert.ok(evidence.reserved_upper_bound_usd <= cap);
      const events = readFileSync(join(runDir(repo), "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(events.some((event) => event.event === "budget-blocked"), false);
      assert.equal(events.filter((event) => event.event === "budget-stop").length, 1);
      assert.ok(events.filter((event) => event.event === "spend-rate").length >= 2);
    })));
});
