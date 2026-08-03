#!/usr/bin/env python3
"""Prompt-only GEPA arm for the domain-identification slice."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
import re
from statistics import pvariance
import threading
import time
from pathlib import Path
from urllib.request import Request, urlopen

import dspy
import gepa
from gepa.core.adapter import EvaluationBatch

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


# ---------------------------------------------------------------------------
# Run controls: fuses, immutable output, append-only ledger, split guard.
# All of this is provider-free and unit-tested in test_run_controls.py.
#
# Two independent spend budgets (never conflated into one "$ fuse"):
#   * reflection_cost_usd  -> Kimi reflection via the gateway; gateway-metered;
#     hard delta fuse. If a cap is set, a WORKING reader is REQUIRED (fail closed).
#   * student_compute      -> Tinker/Nemotron; NOT metered locally; bounded only
#     by --max-episodes and --max-wall-seconds; recorded cost = null.
# ---------------------------------------------------------------------------
class FuseTripped(SystemExit):
    """Raised to hard-abort the run when a safety fuse trips."""


class CostTelemetryUnavailable(RuntimeError):
    """Authoritative reflection cost telemetry could not be read."""


def read_gateway_reflection_cost_usd(usage_url, api_key, timeout=10):
    """OPTIONAL / FUTURE: read-only cumulative-USD poll of Kimi reflection spend.

    Not used by the planned run: the authoritative ClickHouse event_costs job is
    ~5-minute lagged and its usage-summary route needs admin auth, so it is
    out-of-band OBSERVABILITY, not a synchronous in-process fuse. Kept for a
    future real-time reader. Returns cumulative USD or raises
    CostTelemetryUnavailable. Never mutates anything; covers reflection only.
    """
    if not usage_url:
        raise CostTelemetryUnavailable("no cost-usage URL configured")
    headers = {"authorization": f"Bearer {api_key}"} if api_key else {}
    try:
        with urlopen(Request(usage_url, headers=headers), timeout=timeout) as response:
            payload = json.loads(response.read())
    except Exception as exc:  # noqa: BLE001 - any failure means "unavailable"
        raise CostTelemetryUnavailable(str(exc)[:200]) from exc
    if isinstance(payload, dict):
        for key in ("cost_usd", "customer_cost_usd", "total_cost_usd", "usd"):
            if isinstance(payload.get(key), (int, float)):
                return float(payload[key])
    raise CostTelemetryUnavailable("no numeric USD field in usage payload")


class RunFuse:
    """Thread-safe hard fuses. Episode capacity is RESERVED under the lock before
    a rollout is dispatched so concurrent workers cannot overshoot max_episodes.

    Reflection dollars are the only metered budget; student compute is unmetered
    and gated behind explicit acknowledgement (allow_unmetered_student).
    """
    def __init__(self, max_episodes, max_reflection_calls, max_wall_seconds,
                 max_reflection_cost_usd=None, reflection_cost_reader=None,
                 allow_unmetered_student=False, spend_authorization_usd=None,
                 cost_poll_interval=20.0):
        self.max_episodes = max_episodes
        self.max_reflection_calls = max_reflection_calls
        self.max_wall_seconds = max_wall_seconds
        self.max_reflection_cost_usd = max_reflection_cost_usd
        self._reader = reflection_cost_reader
        self.allow_unmetered_student = allow_unmetered_student
        self.spend_authorization_usd = spend_authorization_usd
        self._cost_poll_interval = cost_poll_interval
        self._lock = threading.Lock()
        self.episodes_reserved = 0
        self.episodes_completed = 0
        self.reflection_calls = 0
        self.reflection_metered = False
        self.in_process_dollar_fuse = False
        # Default coverage until preflight: reflection $ observed out-of-band in
        # ClickHouse (5-min lag), NOT an in-process fuse.
        self.cost_coverage = "out_of_band_clickhouse"
        self._baseline_usd = 0.0
        self._last_reflection_usd = 0.0
        self._last_cost_at = 0.0
        self.started_at = None

    def _read_reflection_delta_locked(self, force=False):
        if self._reader is None or not self.reflection_metered:
            return None
        now = time.time()
        if not force and (now - self._last_cost_at) < self._cost_poll_interval:
            return self._last_reflection_usd
        self._last_reflection_usd = self._reader() - self._baseline_usd
        self._last_cost_at = now
        return self._last_reflection_usd

    def preflight(self):
        """Fail closed. A reflection $ cap REQUIRES a working reader; student
        compute is always unmetered and must be explicitly accepted."""
        self.started_at = time.time()
        with self._lock:
            if self.max_reflection_cost_usd is not None:
                # Opt-in in-process reflection $ fuse: REQUIRES a working reader.
                if self._reader is None:
                    raise FuseTripped(
                        "reflection $ cap set but no cost reader; fail-closed "
                        "(refusing to start)")
                try:
                    self._baseline_usd = self._reader()
                except CostTelemetryUnavailable as exc:
                    raise FuseTripped(
                        f"reflection cost telemetry unreadable; fail-closed: {exc}")
                self.reflection_metered = True
                self.in_process_dollar_fuse = True
                self.cost_coverage = "reflection_only"
            else:
                # Planned mode: no synchronous in-process $ fuse. Reflection $ is
                # observed out-of-band in ClickHouse event_costs (5-min lag);
                # student compute is unmetered. Both require explicit acceptance.
                self.reflection_metered = False
                self.in_process_dollar_fuse = False
                self.cost_coverage = "out_of_band_clickhouse"
            if not self.allow_unmetered_student:
                raise FuseTripped(
                    "student (Tinker/Nemotron) compute is unmetered and reflection $ "
                    "telemetry is not synchronous in-process; pass --allow-unmetered-cost "
                    "to accept the --max-episodes/--max-reflection-calls/--max-wall-seconds "
                    "bounds as the only in-process spend controls")
        return self

    def _check_wall_and_cost_locked(self):
        if self.started_at is not None and self.max_wall_seconds is not None:
            if time.time() - self.started_at >= self.max_wall_seconds:
                raise FuseTripped(f"wall-clock fuse: exceeded {self.max_wall_seconds}s")
        if self.reflection_metered and self.max_reflection_cost_usd is not None:
            spent = self._read_reflection_delta_locked()
            if spent is not None and spent >= self.max_reflection_cost_usd:
                raise FuseTripped(
                    f"reflection cost fuse: spent >= ${self.max_reflection_cost_usd}")

    def reserve_episode(self):
        """Reserve ONE physical student episode before dispatch. Hard-stop at cap."""
        with self._lock:
            self._check_wall_and_cost_locked()
            if self.max_episodes is not None and self.episodes_reserved >= self.max_episodes:
                raise FuseTripped(
                    f"episode fuse: reserved {self.episodes_reserved} >= max {self.max_episodes}")
            self.episodes_reserved += 1
            return self.episodes_reserved

    def complete_episode(self):
        with self._lock:
            self.episodes_completed += 1

    def note_reflection(self):
        """Count a reflection call BEFORE it is issued. Hard-stop at cap."""
        with self._lock:
            self._check_wall_and_cost_locked()
            if self.max_reflection_calls is not None and self.reflection_calls >= self.max_reflection_calls:
                raise FuseTripped(
                    f"reflection-call fuse: {self.reflection_calls} >= max {self.max_reflection_calls}")
            self.reflection_calls += 1
            return self.reflection_calls

    def snapshot(self):
        with self._lock:
            reflection_spent = self._last_reflection_usd if self.reflection_metered else None
            return {
                "episodes_reserved": self.episodes_reserved,
                "episodes_completed": self.episodes_completed,
                "reflection_calls": self.reflection_calls,
                "cost_coverage": self.cost_coverage,
                "reflection_metered": self.reflection_metered,
                "in_process_dollar_fuse": self.in_process_dollar_fuse,
                "reflection_spent_usd": reflection_spent,
                "max_reflection_cost_usd": self.max_reflection_cost_usd,
                "student_compute_metered": False,
                "total_cost_usd": None,
                "spend_authorization_usd": self.spend_authorization_usd,
                "max_episodes": self.max_episodes,
                "max_reflection_calls": self.max_reflection_calls,
                "max_wall_seconds": self.max_wall_seconds,
                "allow_unmetered_student": self.allow_unmetered_student,
            }


def prepare_run_dir(runs_root, run_id):
    """Immutable run dir. Refuse if the run_id directory already exists at all
    (any entry: receipt, prompt, ledger, snapshots, logs). Created exclusively."""
    run_dir = Path(runs_root) / run_id
    Path(runs_root).mkdir(parents=True, exist_ok=True)
    try:
        run_dir.mkdir()  # exclusive: raises if the run dir already exists
    except FileExistsError as exc:
        raise FuseTripped(f"refusing to reuse an existing run dir: {run_dir}") from exc
    (run_dir / "logs").mkdir()
    return run_dir


def write_latest_pointer(runs_root, run_dir):
    """Atomic pointer to the newest run. Overwrites only the pointer, never evidence."""
    manifest = Path(runs_root) / "LATEST.json"
    tmp = manifest.with_name(manifest.name + ".tmp")
    tmp.write_text(json.dumps({"run_dir": str(run_dir), "ts": time.time()}, indent=2) + "\n")
    os.replace(tmp, manifest)


class ProgressLedger:
    """Append-only progress ledger + IMMUTABLE sequence-numbered per-candidate
    snapshots. Snapshots are never overwritten; only LATEST.json (a pointer for
    the live viewer) is atomically replaced."""
    def __init__(self, run_dir):
        self.run_dir = Path(run_dir)
        self.ledger_path = self.run_dir / "progress.jsonl"
        self.snap_dir = self.run_dir / "snapshots"
        self.snap_dir.mkdir(parents=True, exist_ok=True)
        self.latest_path = self.snap_dir / "LATEST.json"
        self._lock = threading.Lock()
        self._seq = 0

    def _append_locked(self, entry):
        with self.ledger_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, sort_keys=True) + "\n")

    def record(self, entry):
        """Record a completed candidate-task evaluation + immutable snapshot."""
        with self._lock:
            self._seq += 1
            seq = self._seq
            line = dict(entry)
            line.setdefault("kind", "candidate_eval")
            self._append_locked(line)
            cand = entry.get("candidate_hash", "unknown")
            snap = dict(line)
            snap["seq"] = seq
            # Immutable, never-overwritten snapshot.
            path = self.snap_dir / f"candidate-{cand}-{seq:06d}.json"
            path.write_text(json.dumps(snap, indent=2, sort_keys=True) + "\n")
            # Atomic pointer swap only.
            tmp = self.latest_path.with_name(self.latest_path.name + ".tmp")
            tmp.write_text(json.dumps({"snapshot": path.name, "candidate_hash": cand,
                                       "seq": seq}, indent=2, sort_keys=True) + "\n")
            os.replace(tmp, self.latest_path)
            return seq

    def record_episode(self, entry):
        """Append-only per-episode attempt telemetry (status/latency). No prompts
        or secrets. Does NOT create a candidate snapshot."""
        with self._lock:
            line = dict(entry)
            line["kind"] = "episode"
            self._append_locked(line)

    def record_invalid(self, entry):
        """Append-only marker that a logical eval was invalid_service_pressure."""
        with self._lock:
            line = dict(entry)
            line["kind"] = "invalid_service_pressure"
            self._append_locked(line)


def assert_split_allowed(split):
    if str(split).lower() == "holdout":
        raise FuseTripped("holdout access is forbidden in this run")
    return split


def candidate_hash(system_prompt):
    return hashlib.sha256(system_prompt.encode("utf-8")).hexdigest()[:16]


def summarize_samples(sample_traces):
    """Choose the representative FAILURE trace and a bounded per-sample summary.

    Representative = lowest score, tie-break HIGHEST malformed_total, then LOWEST
    sample index. Order-independent (does not depend on completion order).
    """
    indexed = list(enumerate(sample_traces))
    rep_idx, rep = min(indexed, key=lambda it: (it[1]["score"], -it[1]["malformed_total"], it[0]))
    summary = [
        {"sample": i, "score": t["score"], "malformed_total": t["malformed_total"],
         "ended": t["ended"], "steps": t["steps"]}
        for i, t in indexed
    ]
    return rep_idx, rep, summary


# ---------------------------------------------------------------------------
# Service-pressure handling + adaptive concurrency.
#
# Infrastructure failures (timeout/429/5xx/provider errors) MUST NOT become a
# score. They are recorded as telemetry, retried at most once (each retry
# reserves a fresh physical episode), and on a second failure the whole logical
# candidate-task evaluation is InvalidServicePressure: the batch aborts at the
# durable GEPA checkpoint BEFORE any score/rank/promote/reject/reflection.
# ---------------------------------------------------------------------------
class InvalidServicePressure(SystemExit):
    """Raised to abort/pause the evaluate batch on unrecoverable service pressure."""


TRANSIENT_STATUSES = frozenset({"timeout", "429", "5xx"})


def classify_error(exc):
    """Map a provider/network exception to timeout | 429 | 5xx | other."""
    code = getattr(exc, "status_code", None)
    if code is None:
        code = getattr(exc, "code", None)
    try:
        code = int(code)
    except (TypeError, ValueError):
        code = None
    if code == 429:
        return "429"
    if code is not None and 500 <= code <= 599:
        return "5xx"
    text = f"{type(exc).__name__} {exc}".lower()
    if "timeout" in text or "timed out" in text:
        return "timeout"
    if "429" in text or "rate limit" in text or "ratelimit" in text:
        return "429"
    if "503" in text or "502" in text or "500" in text or "internal server" in text:
        return "5xx"
    return "other"


class BatchStats:
    """Thread-safe per-batch attempt telemetry aggregator."""
    def __init__(self):
        self._lock = threading.Lock()
        self.attempts = 0
        self.failures = 0
        self.by_status = {}
        self.success_latencies = []

    def record(self, status, latency):
        with self._lock:
            self.attempts += 1
            self.by_status[status] = self.by_status.get(status, 0) + 1
            if status == "success":
                self.success_latencies.append(latency)
            else:
                self.failures += 1

    def pressure_rate(self):
        with self._lock:
            return (self.failures / self.attempts) if self.attempts else 0.0

    def p95_latency(self):
        with self._lock:
            lat = sorted(self.success_latencies)
        if not lat:
            return None
        idx = max(0, int(round(0.95 * (len(lat) - 1))))
        return lat[idx]

    def summary(self):
        with self._lock:
            return {"attempts": self.attempts, "failures": self.failures,
                    "by_status": dict(self.by_status)}


class ConcurrencyController:
    """Bounded adaptive student concurrency across evaluate() batches.

    Ladder: start (24) -> 16 -> 12. Step DOWN on error pressure >= down_pressure
    or (only once a measured baseline exists) p95 > latency_down x baseline. Step
    UP toward start after `recover_after` consecutive clean batches (pressure <
    clean_pressure and, if baseline exists, p95 <= latency_up x baseline).

    baseline_p95 is null until the FIRST fully-successful `start`-job batch, then
    fixed with baseline_source='first_clean_batch'. Before that, adapt ONLY on
    error pressure; never derive latency from throughput.
    """
    def __init__(self, start=24, ladder=(24, 16, 12), down_pressure=0.02,
                 clean_pressure=0.01, latency_down=2.0, latency_up=1.5,
                 recover_after=2):
        self.ladder = list(ladder)
        self.start = start
        self._idx = self.ladder.index(start) if start in self.ladder else 0
        self.down_pressure = down_pressure
        self.clean_pressure = clean_pressure
        self.latency_down = latency_down
        self.latency_up = latency_up
        self.recover_after = recover_after
        self.clean_streak = 0
        self.baseline_p95 = None
        self.baseline_source = None
        self.last_pressure_rate = None
        self.last_p95 = None
        self._lock = threading.Lock()

    def current(self):
        with self._lock:
            return self.ladder[self._idx]

    def observe(self, jobs_dispatched, pressure_rate, p95):
        """Fold in one completed batch; return the (possibly new) concurrency."""
        with self._lock:
            self.last_pressure_rate = pressure_rate
            self.last_p95 = p95
            if (self.baseline_p95 is None and pressure_rate == 0.0
                    and jobs_dispatched >= self.start and p95 is not None):
                self.baseline_p95 = p95
                self.baseline_source = "first_clean_batch"
            latency_hot = (self.baseline_p95 is not None and p95 is not None
                           and p95 > self.latency_down * self.baseline_p95)
            latency_ok = (self.baseline_p95 is None or p95 is None
                          or p95 <= self.latency_up * self.baseline_p95)
            if pressure_rate >= self.down_pressure or latency_hot:
                self.clean_streak = 0
                if self._idx < len(self.ladder) - 1:
                    self._idx += 1
            elif pressure_rate < self.clean_pressure and latency_ok:
                self.clean_streak += 1
                if self.clean_streak >= self.recover_after and self._idx > 0:
                    self._idx -= 1
                    self.clean_streak = 0
            else:
                self.clean_streak = 0
            return self.ladder[self._idx]

    def snapshot(self):
        with self._lock:
            return {
                "current_concurrency": self.ladder[self._idx],
                "max_concurrency": self.start,
                "clean_streak": self.clean_streak,
                "baseline_p95_seconds": self.baseline_p95,
                "baseline_source": self.baseline_source,
                "last_pressure_rate": self.last_pressure_rate,
                "last_p95_seconds": self.last_p95,
            }


class PolicySignature(dspy.Signature):
    """Policy prompt is replaced by GEPA; output is the raw assistant message."""
    task_prompt: str = dspy.InputField()
    history: str = dspy.InputField()
    assistant_message: str = dspy.OutputField()


PolicySignature.instructions = DEFAULT_SYSTEM


class ContractAdapter:
    """GEPA adapter whose rollout is the exact rollout.mjs contract."""
    def __init__(self, sidecar, student_model="openai/nemotron-3-nano-base",
                 student_api_base="http://127.0.0.1:8099/v1", student_api_key="local-shim",
                 student_headers=None,
                 max_tokens=384, max_turns=10, malformed_tolerance=3, temperature=0,
                 samples_per_eval=1, concurrency=6, fuse=None, ledger=None,
                 controller=None):
        self.sidecar = sidecar
        self.student_model = student_model
        self.student_api_base = student_api_base
        self.student_api_key = student_api_key
        self.student_headers = dict(student_headers or {})
        self.samples_per_eval = samples_per_eval
        self._max_workers = concurrency
        self.fuse = fuse
        self.ledger = ledger
        self.controller = controller
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
                api_base=self.student_api_base,
                api_key=self.student_api_key,
                extra_headers=self.student_headers or None,
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
        if self.fuse is not None:
            self.fuse.complete_episode()
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

    def _attempt(self, task, system):
        """Run ONE physical episode. Return (status, latency, score, trace).
        status='success' on a scored rollout; 'timeout'/'429'/'5xx' for RETRYABLE
        service pressure. Any other exception (scorer/schema/programming/auth/
        harness bug) is re-raised with its original identity so it fails visibly.
        """
        t0 = time.perf_counter()
        try:
            sc, tr = self.rollout(task, system)
            return "success", time.perf_counter() - t0, float(sc), tr
        except Exception as exc:
            status = classify_error(exc)
            if status in TRANSIENT_STATUSES:
                return status, time.perf_counter() - t0, None, None
            raise

    def _log_episode(self, chash, task, attempt, status, latency):
        if self.ledger is not None:
            self.ledger.record_episode({
                "candidate_hash": chash,
                "task_id": task["task_id"],
                "attempt": attempt,
                "status": status,
                "latency_s": round(latency, 4),
                "ts": time.time(),
            })

    def evaluate(self, batch, candidate, capture_traces=False):
        system = candidate["system_prompt"]
        k = self.samples_per_eval
        chash = candidate_hash(system)
        concurrency = self.controller.current() if self.controller is not None else self._max_workers
        stats = BatchStats()
        # Reserve every physical episode up front, under the fuse lock, BEFORE
        # dispatch, so concurrent workers can never overshoot --max-episodes.
        jobs = []
        for ti, task in enumerate(batch):
            for si in range(k):
                if self.fuse is not None:
                    self.fuse.reserve_episode()
                jobs.append((ti, si, task))

        def run_job(job):
            ti, si, task = job
            status, lat, sc, tr = self._attempt(task, system)
            stats.record(status, lat)
            self._log_episode(chash, task, 1, status, lat)
            if status == "success":
                return ti, si, sc, tr
            # Retryable service pressure: ONE retry, reserving a FRESH physical
            # episode first (retries count against --max-episodes).
            if self.fuse is not None:
                self.fuse.reserve_episode()
            status2, lat2, sc2, tr2 = self._attempt(task, system)
            stats.record(status2, lat2)
            self._log_episode(chash, task, 2, status2, lat2)
            if status2 == "success":
                return ti, si, sc2, tr2
            # Second failure -> the logical eval is invalid; abort BEFORE any
            # score/rank/promote/reject/reflection. GEPA pauses at its last
            # durable checkpoint. No score is produced for this candidate.
            if self.ledger is not None:
                self.ledger.record_invalid({
                    "candidate_hash": chash,
                    "task_id": task["task_id"],
                    "reason": "invalid_service_pressure",
                    "statuses": [status, status2],
                    "ts": time.time(),
                })
            raise InvalidServicePressure(
                f"invalid_service_pressure task={task['task_id']} "
                f"statuses={status},{status2}")

        with ThreadPoolExecutor(max_workers=concurrency) as pool:
            # Any worker exception (InvalidServicePressure or a re-raised
            # non-transient error) propagates here, before aggregation.
            results = list(pool.map(run_job, jobs))

        # Adaptive concurrency folds in telemetry ONLY after a fully-scored batch.
        if self.controller is not None:
            self.controller.observe(len(jobs), stats.pressure_rate(), stats.p95_latency())

        per_task = {}
        for ti, si, sc, tr in results:
            per_task.setdefault(ti, []).append((si, sc, tr))

        outputs, mean_scores = [], []
        for ti, task in enumerate(batch):
            samples = sorted(per_task[ti], key=lambda x: x[0])  # by sample index
            sample_scores = [sc for _, sc, _ in samples]
            sample_traces = [tr for _, _, tr in samples]
            mean = sum(sample_scores) / len(sample_scores)
            variance = pvariance(sample_scores) if len(sample_scores) > 1 else 0.0
            mal_list = [t["malformed_total"] for t in sample_traces]
            malformed_mean = sum(mal_list) / len(mal_list)
            steps_list = [t["steps"] for t in sample_traces]
            total_calls = sum(max(s, 0) for s in steps_list) + sum(mal_list)
            malformed_rate = (sum(mal_list) / total_calls) if total_calls else 0.0
            rep_idx, rep, sample_summary = summarize_samples(sample_traces)
            # Representative FAILURE trace keeps a real transcript for reflection;
            # aggregate score is the k-sample mean.
            agg = dict(rep)
            agg.update({
                "task_id": task["task_id"],
                "prompt": task["prompt"],
                "score": mean,
                "samples_per_eval": k,
                "sample_scores": sample_scores,
                "score_variance": variance,
                "malformed_mean": malformed_mean,
                "malformed_rate": malformed_rate,
                "representative_sample": rep_idx,
                "sample_summary": sample_summary,
                "episode_count": len(sample_scores),
            })
            outputs.append(agg)
            mean_scores.append(mean)
            if self.ledger is not None:
                self.ledger.record({
                    "candidate_hash": chash,
                    "task_id": task["task_id"],
                    "k": k,
                    "mean": mean,
                    "variance": variance,
                    "sample_scores": sample_scores,
                    "malformed_mean": malformed_mean,
                    "malformed_rate": malformed_rate,
                    "representative_sample": rep_idx,
                    "episode_count": len(sample_scores),
                    "concurrency": concurrency,
                    "batch_pressure": stats.summary(),
                    "ts": time.time(),
                })
        trajectories = outputs if capture_traces else None
        return EvaluationBatch(outputs=outputs, scores=mean_scores, trajectories=trajectories)

    def make_reflective_dataset(self, candidate, eval_batch, components_to_update):
        records = []
        for trace in eval_batch.trajectories or []:
            if trace["score"] >= 1:
                continue
            raw = trace["messages"][-1]["content"] if trace["messages"] else ""
            if trace["malformed"]:
                feedback = f"Malformed output: rejected {trace['malformed']} time(s). The strict parser strips think tags only, then requires one JSON object; output no thinking and JSON on the first line."
            elif "unmatched-abstain" in trace["task_id"]:
                feedback = (
                    f"Authoritative outcome reward was {trace['score']:.3f}. Unmatched is an active "
                    "state transition, not passive abstention: GET tickets, identify the addressed "
                    "requester's full domain, GET accounts, compare domains character-for-character, "
                    "then if no exact account exists PATCH only the addressed ticket with "
                    "{assignee: none, status: unmatched} and finish. Preserve matched routing and "
                    "never write another ticket."
                )
            else:
                feedback = f"Outcome reward was {trace['score']:.3f}. Preserve exact tool semantics and avoid unrequested writes."
            records.append({
                "Inputs": {"task_prompt": trace["prompt"], "history": "\n".join(m["content"][:1200] for m in trace["messages"][-4:])},
                "Generated Outputs": raw[:1600],
                "Feedback": feedback,
            })
        return {"system_prompt": records[:8]}


def build_receipt(*, run_id, run_dir, seed, dspy_version, metric_budget,
                  samples_per_eval, candidates_tried, best_dev_score_gepa_observed,
                  train_tasks, dev_tasks, train_split_sha256, dev_split_sha256,
                  wall_clock_s, reflection_key_source, fuse, controller,
                  spend_authorization_usd):
    """Pure receipt builder (no I/O, no providers) so the invariants below are
    unit-testable. This is a TRAIN/DEV-ONLY GEPA run: it never touches a holdout,
    so both holdout flags are False. No historical holdout provenance is asserted
    here (that would require a hash-bound prior receipt reference)."""
    fuses = fuse.snapshot()
    return {
        "schema_version": "understudy.gepa_receipt.v1",
        "run_id": run_id,
        "run_dir": str(run_dir),
        "seed": seed,
        "dspy_version": dspy_version,
        "gepa_version": "0.0.27",
        "student_model": "openai/nemotron-3-nano-base",
        "reflection_model": "openai/kimi-k3",
        "metric_budget": metric_budget,
        "samples_per_eval": samples_per_eval,
        "candidates_tried": candidates_tried,
        "best_dev_score_gepa_observed": best_dev_score_gepa_observed,
        "train_tasks": train_tasks,
        "dev_tasks": dev_tasks,
        "train_split_sha256": train_split_sha256,
        "dev_split_sha256": dev_split_sha256,
        # This run only ever evaluates train/dev; no holdout is executed.
        "holdout_executed": False,
        "gepa_holdout_executed": False,
        "fixture": "domain-identification-offline-v1",
        "wall_clock_s": wall_clock_s,
        "reflection_key_source": reflection_key_source,
        # Cost model: no synchronous in-process $ fuse in the planned run.
        # Reflection $ is observed out-of-band in ClickHouse (5-min lag);
        # student (Tinker) compute is unmetered. total_cost_usd stays null until
        # final out-of-band reconciliation.
        "cost_coverage": fuse.cost_coverage,
        "in_process_dollar_fuse": fuse.in_process_dollar_fuse,
        "total_cost_usd": None,
        "student_compute_cost_usd": None,
        "reflection_cost_usd": fuses["reflection_spent_usd"],
        "spend_authorization_usd": spend_authorization_usd,
        "fuses": fuses,
        "concurrency": controller.snapshot(),
    }


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
    # Repeated evaluation: k independent fresh episodes per candidate-task.
    parser.add_argument("--samples-per-eval", type=int, default=1)
    # Student concurrency: start of the adaptive ladder (24 -> 16 -> 12).
    parser.add_argument("--concurrency", type=int, default=24)
    # Hard fuses.
    parser.add_argument("--max-episodes", type=int, default=230)
    parser.add_argument("--max-reflection-calls", type=int, default=15)
    parser.add_argument("--max-wall-seconds", type=int, default=9000)
    # OPTIONAL in-process reflection $ fuse. Default None = DISABLED: reflection
    # $ is observed out-of-band in ClickHouse (5-min lag), not a synchronous
    # in-process fuse. If set, it REQUIRES a working --cost-usage-url reader.
    parser.add_argument("--max-reflection-cost-usd", type=float, default=None)
    parser.add_argument("--cost-usage-url", default="",
                        help="optional read-only gateway usage reader (cumulative reflection USD); "
                             "required only if --max-reflection-cost-usd is set")
    parser.add_argument("--allow-unmetered-cost", action="store_true",
                        help="explicitly accept that student compute AND reflection $ are not "
                             "metered synchronously in-process")
    parser.add_argument("--spend-authorization-usd", type=float, default=None,
                        help="recorded outer spend ceiling authorized out-of-band (observability, "
                             "not an in-process fuse)")
    # Immutable output.
    parser.add_argument("--runs-root", default=str(Path.home() / ".di-runs"))
    parser.add_argument("--run-id", default="")
    args = parser.parse_args()

    run_id = args.run_id or time.strftime("gepa-run-%Y%m%dT%H%M%SZ", time.gmtime())
    run_dir = prepare_run_dir(args.runs_root, run_id)
    ledger = ProgressLedger(run_dir)

    reflection_key = os.environ.get("UNDERSTUDY_API_KEY") or os.environ.get("FIREWORKS_API_KEY")
    if not reflection_key:
        raise RuntimeError("UNDERSTUDY_API_KEY or FIREWORKS_API_KEY is required")

    cost_cap = args.max_reflection_cost_usd
    cost_reader = None
    if args.cost_usage_url:
        cost_reader = lambda: read_gateway_reflection_cost_usd(args.cost_usage_url, reflection_key)  # noqa: E731
    fuse = RunFuse(
        max_episodes=args.max_episodes,
        max_reflection_calls=args.max_reflection_calls,
        max_wall_seconds=args.max_wall_seconds,
        max_reflection_cost_usd=cost_cap,
        reflection_cost_reader=cost_reader,
        allow_unmetered_student=args.allow_unmetered_cost,
        spend_authorization_usd=args.spend_authorization_usd,
    ).preflight()
    controller = ConcurrencyController(start=args.concurrency)

    # Split guard: this run only ever touches train/dev; holdout is forbidden.
    for split in ("train", "dev"):
        assert_split_allowed(split)
    train = call_json(args.sidecar, "/pool?split=train")["tasks"][: args.train_limit]
    dev = call_json(args.sidecar, "/pool?split=dev")["tasks"][: args.dev_limit]

    import litellm
    def reflection(messages):
        fuse.note_reflection()  # counts + caps BEFORE the spend
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
        samples_per_eval=args.samples_per_eval,
        concurrency=args.concurrency,
        fuse=fuse,
        ledger=ledger,
        controller=controller,
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
        "run_dir": str(run_dir / "logs"),
        "seed": args.seed,
    }
    started = time.time()
    result = gepa.optimize(**optimizer_kwargs)
    prompt = result.best_candidate["system_prompt"]
    (run_dir / "optimized-system-prompt.txt").write_text(prompt.rstrip() + "\n")
    receipt = build_receipt(
        run_id=run_id,
        run_dir=run_dir,
        seed=args.seed,
        dspy_version=dspy.__version__,
        metric_budget=args.max_metric_calls,
        samples_per_eval=args.samples_per_eval,
        candidates_tried=len(result.candidates),
        best_dev_score_gepa_observed=max(result.val_aggregate_scores),
        train_tasks=len(train),
        dev_tasks=len(dev),
        train_split_sha256=call_json(args.sidecar, "/pool?split=train")["split_sha256"],
        dev_split_sha256=call_json(args.sidecar, "/pool?split=dev")["split_sha256"],
        wall_clock_s=round(time.time() - started),
        reflection_key_source=("UNDERSTUDY_API_KEY" if os.environ.get("UNDERSTUDY_API_KEY") else "FIREWORKS_API_KEY"),
        fuse=fuse,
        controller=controller,
        spend_authorization_usd=args.spend_authorization_usd,
    )
    (run_dir / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    write_latest_pointer(args.runs_root, run_dir)
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
