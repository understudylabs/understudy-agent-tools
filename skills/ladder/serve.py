#!/usr/bin/env python3
"""
Live local-model serving for the no-data onboarding ladder.

Run on an isolated, CURRENT mlx stack (never system python):

    uv run --with mlx-vlm --with mlx-lm python skills/ladder/serve.py

Serves the viewer/ directory statically AND an SSE endpoint that streams a
local model's *thinking* and *response* token deltas for a task. Local-only,
$0, nothing uploaded. The static page (file:// or this server) is the pre-baked
demo; this server is the "run it for real, live" lane.

  GET /run?task=<id>&model=<id>   -> text/event-stream of {type, channel, text}
  GET /tasks                      -> the task catalog (title/system/user/gold)
  GET /models                     -> the model catalog
  GET /<file>                     -> static file from viewer/
"""
import json, os, sys, time, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

os.environ.setdefault("HF_HUB_OFFLINE", "1")          # cached models only, no network

HERE = os.path.dirname(os.path.abspath(__file__))
VIEWER_DIR = os.path.join(HERE, "viewer")
HOST, PORT = "127.0.0.1", 8011

# id -> (lane, path-or-repo, label, sampling)
# sampling is LiquidAI's recommendation from each model's Hugging Face card (mlx-lm lane only).
MODELS = {
    "lfm2.5-8b-a1b": ("mlx_lm",  "/Users/luis/.understudy/models/lfm2.5-8b-a1b-8bit", "LFM 8B-A1B · thinking", {"temp": 0.2, "top_k": 80, "rep": 1.05}),
    "gemma-4-e2b":   ("mlx_vlm", "/Users/luis/.understudy/models/gemma-4-e2b-it-mlx-vlm-4bit", "gemma-4-e2b", {}),
    # frontier via the Understudy gateway (BILLED). Launch serve.py with `understudy run` so
    # UNDERSTUDY_API_KEY + UNDERSTUDY_GATEWAY_URL are injected — the raw key is never read from disk.
    "glm-5.1":       ("gateway", "glm-5.1", "glm-5.1 · frontier", {}),
}

# id -> (title, system, user, gold)
TASKS = {
    "sort-email": (
        "Sort this customer email into the right inbox.",
        "Route the email to exactly one inbox: billing_urgent, billing_normal, technical, sales_lead, or spam. Reply with just the label.",
        "From: pat@maple.example\nSubject: charged twice\nI got billed twice this morning and it's holding up payroll. Please fix this today.",
        "billing_urgent",
    ),
    "match-search": (
        "Decide how a product relates to a shopper's search.",
        "Label the product against the search: Exact, Substitute, Complement, or Irrelevant. Reply with just the label.",
        "search: running shoes\nproduct: merino ankle socks, cushioned, 3-pack",
        "Complement",
    ),
    "save-play": (
        "Run the renewal save play.",
        "Apply the latest discount, mark the subscription Saved with the new price in USD, and email the right teams per the save-play policy. Tools: get_account, read_policy, update_subscription, send_mail, finish.",
        "Nova Retail · Growth · EUR 4000 · At-Risk · renews soon.",
        "Saved",
    ),
}

# The HARD "save-play" card is not a single-shot prompt -- it's the live agent
# loop. The viewer's save-play task maps to this real tool-calling task in the
# Larkfield world (env/world.py + fixtures/hard/tool_tasks.jsonl).
SAVE_PLAY_TASK = "hard.renewal_save_route"

_loaded = {}
_lock = threading.Lock()

def get_model(mid):
    """Load (once) and cache a model. Returns a lane-tagged tuple."""
    with _lock:
        if mid in _loaded:
            return _loaded[mid]
        lane, path = MODELS[mid][0], MODELS[mid][1]
        sys.stderr.write(f"[load] {mid} ({lane}) ...\n"); sys.stderr.flush()
        if lane == "mlx_lm":
            from mlx_lm import load as lm_load
            model, tok = lm_load(path)
            obj = ("mlx_lm", model, tok)
        else:
            from mlx_vlm import load as vlm_load
            from mlx_vlm.utils import load_config
            model, proc = vlm_load(path)
            obj = ("mlx_vlm", model, proc, load_config(path))
        _loaded[mid] = obj
        sys.stderr.write(f"[load] {mid} ready\n"); sys.stderr.flush()
        return obj

def stream_gateway(model_id, system, user, samp, max_tokens):
    """Stream a frontier model through the Understudy gateway (OpenAI-compatible, BILLED).
    Reads UNDERSTUDY_API_KEY + UNDERSTUDY_GATEWAY_URL from the env that `understudy run`
    injects — the raw key is never read from disk. Yields (channel, text)."""
    import urllib.request
    key = os.environ.get("UNDERSTUDY_API_KEY")
    base = os.environ.get("UNDERSTUDY_GATEWAY_URL")
    if not key or not base:
        yield ("response", "[gateway not configured — launch serve.py via `understudy run`]")
        return
    body = {
        "model": model_id, "stream": True, "max_tokens": max_tokens,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
    }
    if samp.get("temp") is not None:
        body["temperature"] = samp["temp"]
    req = urllib.request.Request(
        base.rstrip("/") + "/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json",
                 "Accept": "text/event-stream"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        for raw in resp:
            line = raw.decode("utf-8", "ignore").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                delta = (json.loads(data).get("choices") or [{}])[0].get("delta") or {}
            except Exception:
                continue
            rc = delta.get("reasoning_content") or delta.get("reasoning")
            if rc:
                yield ("thinking", rc)
            c = delta.get("content")
            if c:
                yield ("response", c)


def stream_tokens(mid, system, user, max_tokens=900):
    """Yield (channel, text) deltas. channel is 'raw' (local — split on <think> downstream)
    or 'thinking'/'response' (gateway — already channel-separated)."""
    lane = MODELS[mid][0]
    samp = MODELS[mid][3] if len(MODELS[mid]) > 3 else {}
    if lane == "gateway":
        yield from stream_gateway(MODELS[mid][1], system, user, samp, max_tokens)
        return
    obj = get_model(mid)
    if lane == "mlx_lm":
        from mlx_lm import stream_generate
        _, model, tok = obj
        prompt = tok.apply_chat_template(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            add_generation_prompt=True,
        )
        kw = dict(max_tokens=max_tokens)
        try:                                   # pin LiquidAI's recommended sampling (temp 0 => greedy)
            from mlx_lm.sample_utils import make_sampler, make_logits_processors
            kw["sampler"] = make_sampler(temp=samp.get("temp", 0.0), top_k=samp.get("top_k", 0))
            if samp.get("rep"):
                kw["logits_processors"] = make_logits_processors(repetition_penalty=samp["rep"])
        except Exception:
            pass
        for r in stream_generate(model, tok, prompt, **kw):
            yield ("raw", r.text)
    else:
        from mlx_vlm import stream_generate
        from mlx_vlm.prompt_utils import apply_chat_template
        _, model, proc, config = obj
        msgs = [{"role": "user", "content": system + "\n\n" + user}]   # gemma: no system role
        try:
            prompt = apply_chat_template(proc, config, msgs, num_images=0)
        except TypeError:
            prompt = apply_chat_template(proc, config, msgs)
        for ch in stream_generate(model, proc, prompt, max_tokens=max_tokens):
            yield ("raw", getattr(ch, "text", "") or "")

def split_channels(full):
    """Split accumulated text into (thinking, response) by the <think> channel."""
    if "<think>" in full:
        after = full.split("<think>", 1)[1]
        if "</think>" in after:
            think, resp = after.split("</think>", 1)
            return think, resp
        return after, ""
    return "", full


# ---------------------------------------------------------------------------
# Live agent loop (HARD tier). A real model drives the Larkfield world:
# model -> tool_call -> world.call_tool -> tool_result -> repeat -> finish,
# then world.score_assertions on the final state. Gateway lane (BILLED), which
# is the cleanest OpenAI function-calling path; local mlx tool-calling is harder
# and deferred. Synthetic data only; every billed call is disclosed.
# ---------------------------------------------------------------------------
sys.path.insert(0, os.path.join(HERE, "env"))

AGENT_SYSTEM = (
    "You are an operations agent for Larkfield, a SaaS company. Complete the task "
    "exactly using the provided tools. Before acting, read the relevant policy email "
    "(mail_find / mail_get) and any reference tables (tables_get_rows). When a table "
    "has multiple dated rows, ALWAYS use the row with the latest as_of date. Make every "
    "required write and send every required email, then call finish. Do not take actions "
    "the policy forbids."
)


def gateway_chat_turn(messages, tools, model_id, samp, max_tokens=2048):
    """One streaming, tool-aware gateway turn (OpenAI-compatible, BILLED).

    Generator: yields ('thinking', delta) and ('content', delta) as tokens
    stream, then a final ('final', {content, reasoning, tool_calls}) with the
    assembled assistant message. Gateway is always streamed (the edge cuts
    non-streaming calls ~125s). Key/url come from the env `understudy run`
    injects -- never read from disk."""
    import urllib.request
    key = os.environ.get("UNDERSTUDY_API_KEY")
    base = os.environ.get("UNDERSTUDY_GATEWAY_URL")
    if not key or not base:
        yield ("final", {"content": "[gateway not configured -- launch serve.py via `understudy run`]",
                         "reasoning": "", "tool_calls": []})
        return
    body = {"model": model_id, "stream": True, "max_tokens": max_tokens,
            "messages": messages, "tools": tools, "tool_choice": "auto"}
    if samp.get("temp") is not None:
        body["temperature"] = samp["temp"]
    req = urllib.request.Request(
        base.rstrip("/") + "/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json",
                 "Accept": "text/event-stream"},
        method="POST")
    content = ""; reasoning = ""; tcs = {}        # index -> {id,name,args}
    with urllib.request.urlopen(req, timeout=180) as resp:
        for raw in resp:
            line = raw.decode("utf-8", "ignore").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                delta = (json.loads(data).get("choices") or [{}])[0].get("delta") or {}
            except Exception:
                continue
            rc = delta.get("reasoning_content") or delta.get("reasoning")
            if rc:
                reasoning += rc; yield ("thinking", rc)
            c = delta.get("content")
            if c:
                content += c; yield ("content", c)
            for tcd in (delta.get("tool_calls") or []):
                slot = tcs.setdefault(tcd.get("index", 0), {"id": None, "name": "", "args": ""})
                if tcd.get("id"):
                    slot["id"] = tcd["id"]
                fn = tcd.get("function") or {}
                if fn.get("name"):
                    slot["name"] = fn["name"]              # name arrives whole
                if fn.get("arguments"):
                    slot["args"] += fn["arguments"]         # arguments stream in chunks
    yield ("final", {"content": content, "reasoning": reasoning,
                     "tool_calls": [tcs[i] for i in sorted(tcs)]})


def run_agent(task_id, model_id, max_turns=10):
    """Generator of SSE-ready events for one live agent run against the world.

    Real model, real tools, real WorldState, real final-state scoring. Yields:
      meta -> token(thinking|response)* / tool_call / tool_result ... -> check* -> done
    """
    import world
    task = world.load_tasks().get(task_id)
    if task is None:
        yield {"type": "error", "error": "unknown task '%s'" % task_id}; return
    if MODELS.get(model_id, (None,))[0] != "gateway":
        yield {"type": "error", "error": "agent loop needs a gateway (function-calling) model"}; return

    state = world.fresh_state(task)
    baseline = state.snapshot()
    tools = world.tool_schemas(task.get("allowed_tools"))
    model_real = MODELS[model_id][1]
    samp = MODELS[model_id][3]
    messages = [{"role": "system", "content": AGENT_SYSTEM},
                {"role": "user", "content": task["prompt"]}]

    yield {"type": "meta", "task": task_id, "model": model_id, "label": MODELS[model_id][2],
           "title": task["prompt"], "system": AGENT_SYSTEM, "user": task["prompt"],
           "tools": [t["function"]["name"] for t in tools]}

    finished = False; turn = 0
    for turn in range(max_turns):
        msg = None
        for kind, payload in gateway_chat_turn(messages, tools, model_real, samp):
            if kind == "thinking":
                yield {"type": "token", "channel": "thinking", "text": payload}
            elif kind == "content":
                yield {"type": "token", "channel": "response", "text": payload}
            else:
                msg = payload
        assistant = {"role": "assistant", "content": msg.get("content") or ""}
        if msg["tool_calls"]:
            assistant["tool_calls"] = [
                {"id": tc["id"] or ("call_%d" % i), "type": "function",
                 "function": {"name": tc["name"], "arguments": tc["args"] or "{}"}}
                for i, tc in enumerate(msg["tool_calls"])]
        messages.append(assistant)

        if not msg["tool_calls"]:
            break                                          # model stopped without finishing
        for i, tc in enumerate(msg["tool_calls"]):
            call_id = tc["id"] or ("call_%d" % i)
            name = tc["name"]
            try:
                args = json.loads(tc["args"] or "{}")
            except Exception:
                args = {}
            yield {"type": "tool_call", "id": call_id, "name": name, "args": args}
            result = world.call_tool(state, name, args)
            yield {"type": "tool_result", "id": call_id, "name": name,
                   "ok": "error" not in result, "result": result}
            messages.append({"role": "tool", "tool_call_id": call_id,
                             "content": json.dumps(result)})
            if name == "finish":
                finished = True
        if finished:
            break

    scored = world.score_assertions(state, task.get("assertions", []), baseline=baseline)
    for r in scored["breakdown"]:
        yield {"type": "check", "id": r["id"], "label": r["label"], "pass": r["pass"],
               "negative": r["negative"], "expected": r["expected"],
               "actual": r["actual"], "plain": r["plain"]}
    passes = sum(1 for r in scored["breakdown"] if r["pass"])
    yield {"type": "done", "strict": scored["strict"], "dense": scored["dense"],
           "passes": passes, "total": len(scored["breakdown"]),
           "finished": finished, "turns": turn + 1}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def _json(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _sse_open(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

    def _sse(self, obj):
        self.wfile.write(("data: " + json.dumps(obj) + "\n\n").encode())
        self.wfile.flush()

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/run":
            return self.handle_run(q)
        if u.path == "/tasks":
            return self._json({"tasks": [
                {"id": k, "title": v[0], "system": v[1], "user": v[2], "gold": v[3]} for k, v in TASKS.items()]})
        if u.path == "/models":
            return self._json({"models": [
                {"id": k, "label": v[2], "lane": v[0]} for k, v in MODELS.items()]})
        return self.serve_static(u.path)

    def serve_static(self, path):
        rel = path.lstrip("/") or "ladder.climb.html"
        fp = os.path.normpath(os.path.join(VIEWER_DIR, rel))
        if not fp.startswith(VIEWER_DIR) or not os.path.isfile(fp):
            self.send_response(404); self.end_headers(); return
        ctype = ("text/html" if fp.endswith(".html")
                 else "application/javascript" if fp.endswith(".js")
                 else "application/json" if fp.endswith(".json") else "text/plain")
        with open(fp, "rb") as f:
            b = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def handle_agent(self, mid):
        """Stream a live tool-calling agent run (HARD save-play) as SSE.
        Forwards run_agent's fully-formed events; it self-guards non-gateway
        models with a single {type:error} event."""
        self._sse_open()
        try:
            for ev in run_agent(SAVE_PLAY_TASK, mid):
                self._sse(ev)
        except (BrokenPipeError, ConnectionResetError):
            return

    def handle_run(self, q):
        task = q.get("task", ["sort-email"])[0]
        mid = q.get("model", ["lfm2.5-8b-a1b"])[0]
        if task not in TASKS or mid not in MODELS:
            return self._json({"error": "unknown task or model"}, 400)
        if task == "save-play":                 # HARD card -> live agent loop
            return self.handle_agent(mid)
        title, system, user, gold = TASKS[task]
        self._sse_open()
        self._sse({"type": "meta", "task": task, "model": mid, "label": MODELS[mid][2],
                   "title": title, "system": system, "user": user, "gold": gold})
        full = ""; sent_think = 0; sent_resp = 0; resp_text = ""; n = 0; t0 = time.time()
        try:
            for channel, text in stream_tokens(mid, system, user):
                if not text:
                    continue
                n += 1
                if channel == "raw":                      # local: split on <think> here
                    full += text
                    think, resp = split_channels(full)
                    if len(think) > sent_think:
                        self._sse({"type": "token", "channel": "thinking", "text": think[sent_think:]}); sent_think = len(think)
                    if len(resp) > sent_resp:
                        self._sse({"type": "token", "channel": "response", "text": resp[sent_resp:]}); sent_resp = len(resp)
                    resp_text = resp
                elif channel == "thinking":               # gateway: already separated
                    self._sse({"type": "token", "channel": "thinking", "text": text})
                else:
                    self._sse({"type": "token", "channel": "response", "text": text})
                    resp_text += text
        except (BrokenPipeError, ConnectionResetError):
            return
        dt = time.time() - t0
        correct = gold.split()[0].lower() in resp_text.lower() if gold else None
        self._sse({"type": "done", "tokens": n, "seconds": round(dt, 2),
                   "tok_s": round(n / max(dt, 0.01)), "correct": correct,
                   "response": resp_text.strip()[:200]})


def _cli_agent(task_id, model_id):
    """Run one agent loop and pretty-print its event stream to stderr.
    Lets us verify the loop end-to-end (BILLED gateway call) before wiring routes:
        understudy run -- uv run python skills/ladder/serve.py --agent hard.renewal_save_route glm-5.1
    """
    think = resp = 0
    for ev in run_agent(task_id, model_id):
        t = ev["type"]
        if t == "meta":
            sys.stderr.write(f"\n=== {ev['model']} on {ev['task']} ===\ntools: {', '.join(ev['tools'])}\n\n")
        elif t == "token":
            if ev["channel"] == "thinking":
                think += len(ev["text"])
            else:
                resp += len(ev["text"])
        elif t == "tool_call":
            sys.stderr.write(f"  -> {ev['name']}({json.dumps(ev['args'])})\n")
        elif t == "tool_result":
            mark = "ok" if ev["ok"] else "ERR"
            sys.stderr.write(f"     [{mark}] {json.dumps(ev['result'])[:160]}\n")
        elif t == "check":
            box = "PASS" if ev["pass"] else "fail"
            neg = " (neg)" if ev["negative"] else ""
            sys.stderr.write(f"  [{box}]{neg} {ev['label']}  -- {ev['actual']}\n")
        elif t == "done":
            sys.stderr.write(f"\nstrict={ev['strict']} dense={ev['dense']} "
                             f"checks={ev['passes']}/{ev['total']} turns={ev['turns']} "
                             f"finished={ev['finished']}  (thinking {think}c / response {resp}c)\n")
        elif t == "error":
            sys.stderr.write(f"ERROR: {ev['error']}\n")
        sys.stderr.flush()


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--agent":
        task_id = sys.argv[2] if len(sys.argv) > 2 else "hard.renewal_save_route"
        model_id = sys.argv[3] if len(sys.argv) > 3 else "glm-5.1"
        return _cli_agent(task_id, model_id)
    sys.stderr.write(f"ladder live server: http://{HOST}:{PORT}  (viewer: {VIEWER_DIR})\n")
    sys.stderr.write(f"  try: curl -N 'http://{HOST}:{PORT}/run?task=sort-email&model=lfm-thinking'\n")
    sys.stderr.flush()
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
