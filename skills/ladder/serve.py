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
import ast, json, os, re, sys, time, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

os.environ.setdefault("HF_HUB_OFFLINE", "1")          # cached models only, no network

HERE = os.path.dirname(os.path.abspath(__file__))
VIEWER_DIR = os.path.join(HERE, "viewer")
HOST, PORT = "127.0.0.1", 8011

# id -> (lane, path-or-repo, label, sampling)
# sampling = each model's HF-card recommendation. LFM (mlx_lm): LiquidAI's temp/top_k/rep.
# Gemma (mlx_vlm): Google's standardized temp 1.0 / top_p 0.95 / top_k 64, and it runs with
# enable_thinking=True so it emits a reasoning channel like the others.
MODELS = {
    "lfm2.5-8b-a1b": ("mlx_lm",  "/Users/luis/.understudy/models/lfm2.5-8b-a1b-8bit", "LFM 8B-A1B · thinking", {"temp": 0.2, "top_k": 80, "rep": 1.05}),
    "gemma-4-e2b":   ("mlx_vlm", "/Users/luis/.understudy/models/gemma-4-e2b-it-mlx-vlm-4bit", "gemma-4-e2b · thinking", {"temp": 1.0, "top_p": 0.95, "top_k": 64}),
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

# Tool-calling tasks are DATA, not code: they live in fixtures/hard/tool_tasks.jsonl
# and load through env/world.py. EVERY task there runs through the same agent loop
# with no per-task server code -- add a JSONL row and it is immediately live and
# scored. The viewer's friendly "save-play" id aliases one fixture task; every other
# task is addressed by its real fixture id (e.g. hard.sla_route).
TASK_ALIASES = {"save-play": "hard.renewal_save_route"}
_TOOL_TASKS = None

def tool_tasks():
    """Cached {task_id: task} from the hard fixtures (loaded via env/world.py)."""
    global _TOOL_TASKS
    if _TOOL_TASKS is None:
        import world
        _TOOL_TASKS = world.load_tasks()
    return _TOOL_TASKS

def resolve_task(task):
    """Map a requested task id (or alias) to a real tool-task id, or None if it
    isn't a tool task (then it's a single-shot classify task or unknown)."""
    real = TASK_ALIASES.get(task, task)
    return real if real in tool_tasks() else None

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


def model_loaded(mid):
    """True if `mid` needs no load (gateway) or is already cached (local lane)."""
    return MODELS.get(mid, ("",))[0] == "gateway" or mid in _loaded


def prewarm_models():
    """Load the local mlx models once at startup (in a background thread) so the
    first real request streams immediately instead of stalling ~60s on a cold load."""
    for mid, spec in MODELS.items():
        if spec[0] in ("mlx_lm", "mlx_vlm"):
            try:
                get_model(mid)
            except Exception as e:
                sys.stderr.write(f"[prewarm] {mid} failed: {type(e).__name__}: {e}\n"); sys.stderr.flush()


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
        msgs = [{"role": "system", "content": system}, {"role": "user", "content": user}]
        try:                                          # enable_thinking => Gemma reasoning channel
            prompt = apply_chat_template(proc, config, msgs, num_images=0, enable_thinking=True)
        except TypeError:
            try:
                prompt = apply_chat_template(proc, config, msgs, enable_thinking=True)
            except TypeError:
                prompt = apply_chat_template(proc, config, msgs)
        gkw = {"max_tokens": max_tokens}              # Google's recommended sampling
        if samp.get("temp") is not None:
            gkw["temperature"] = samp["temp"]
        if samp.get("top_p") is not None:
            gkw["top_p"] = samp["top_p"]
        if samp.get("top_k"):
            gkw["top_k"] = samp["top_k"]
        try:
            stream = stream_generate(model, proc, prompt, **gkw)
        except TypeError:
            stream = stream_generate(model, proc, prompt, max_tokens=max_tokens)
        for ch in stream:
            yield ("raw", getattr(ch, "text", "") or "")

def split_channels(full):
    """Split accumulated text into (thinking, response). Handles both local
    reasoning formats: LFM's <think>...</think> and Gemma's channel form
    <|channel>thought\\n...<channel|>."""
    if "<|channel>" in full:                        # Gemma reasoning channel
        after = full.split("<|channel>", 1)[1]
        nl = after.find("\n")                        # drop the channel label line ("thought")
        body = after[nl + 1:] if nl != -1 else ""
        if "<channel|>" in body:
            think, resp = body.split("<channel|>", 1)
            return think, resp
        return body, ""
    if "<think>" in full:                            # LFM reasoning
        after = full.split("<think>", 1)[1]
        if "</think>" in after:
            think, resp = after.split("</think>", 1)
            return think, resp
        return after, ""
    return "", full


# ---------------------------------------------------------------------------
# Live agent loop (HARD tier). A real model drives the Larkfield world:
# model -> tool_call -> world.call_tool -> tool_result -> repeat -> finish,
# then world.score_assertions on the final state. TWO lanes drive the same world
# + scorer: the gateway (OpenAI function-calling, BILLED) and local mlx_lm (LFM2.5's
# native <|tool_call_start|>[...] format, $0, runs on your machine). Synthetic data
# only; every billed call is disclosed.
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


def parse_lfm_tool_calls(text):
    """Parse LFM2.5's native tool calls out of a generated turn:
        <|tool_call_start|>[crm_find_accounts(query='Nova Retail'), ...]<|tool_call_end|>
    The inside is Python-call syntax (kwargs), so parse it with ast -- never eval.
    Returns [{"name", "args": dict}, ...]."""
    calls = []
    for m in re.finditer(r"<\|tool_call_start\|>\s*\[(.*?)\]\s*<\|tool_call_end\|>", text, re.S):
        inner = m.group(1).strip()
        if not inner:
            continue
        try:
            elts = ast.parse("[" + inner + "]", mode="eval").body.elts
        except Exception:
            continue
        for node in elts:
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                args = {}
                for kw in node.keywords:
                    try:
                        args[kw.arg] = ast.literal_eval(kw.value)
                    except Exception:
                        args[kw.arg] = None
                calls.append({"name": node.func.id, "args": args})
    return calls


def local_chat_turn(model_id, messages, tools, samp, max_tokens=1280):
    """One streaming LOCAL (mlx_lm) turn using LFM2.5's native tool-calling.
    Tool schemas go into the prompt via the chat template's `tools=` kwarg; the
    model emits <think>...</think> then <|tool_call_start|>[...]. Yields
    ('thinking', delta)/('content', delta) live, then ('final', {...}). $0."""
    from mlx_lm import stream_generate
    _, model, tok = get_model(model_id)
    prompt = tok.apply_chat_template(messages, tools=tools, add_generation_prompt=True)
    kw = dict(max_tokens=max_tokens)
    try:
        from mlx_lm.sample_utils import make_sampler, make_logits_processors
        kw["sampler"] = make_sampler(temp=samp.get("temp", 0.2), top_k=samp.get("top_k", 0))
        if samp.get("rep"):
            kw["logits_processors"] = make_logits_processors(repetition_penalty=samp["rep"])
    except Exception:
        pass
    full = ""; sent_think = 0; sent_resp = 0
    for r in stream_generate(model, tok, prompt, **kw):
        full += r.text
        think, rest = split_channels(full)
        resp = rest.split("<|tool_call_start|>", 1)[0]      # don't stream the structured call as prose
        if len(think) > sent_think:
            yield ("thinking", think[sent_think:]); sent_think = len(think)
        if len(resp) > sent_resp:
            yield ("content", resp[sent_resp:]); sent_resp = len(resp)
    think, rest = split_channels(full)
    content = rest.split("<|tool_call_start|>", 1)[0].strip()
    yield ("final", {"content": content, "reasoning": think,
                     "tool_calls": parse_lfm_tool_calls(full)})


def run_agent(task_id, model_id, max_turns=10):
    """Generator of SSE-ready events for one live agent run against the world.

    Real model, real tools, real WorldState, real final-state scoring. Yields:
      meta -> token(thinking|response)* / tool_call / tool_result ... -> check* -> done
    """
    import world
    task = world.load_tasks().get(task_id)
    if task is None:
        yield {"type": "error", "error": "unknown task '%s'" % task_id}; return
    lane = MODELS.get(model_id, (None,))[0]
    if lane not in ("gateway", "mlx_lm"):
        yield {"type": "error", "error": "this task needs a tool-calling model (8b-a1b or glm-5.1)"}; return

    state = world.fresh_state(task)
    baseline = state.snapshot()
    tools = world.tool_schemas(task.get("allowed_tools"))
    samp = MODELS[model_id][3]
    messages = [{"role": "system", "content": AGENT_SYSTEM},
                {"role": "user", "content": task["prompt"]}]

    yield {"type": "meta", "task": task_id, "model": model_id, "label": MODELS[model_id][2],
           "title": task["prompt"], "system": AGENT_SYSTEM, "user": task["prompt"],
           "tools": [t["function"]["name"] for t in tools]}
    if not model_loaded(model_id):             # cold model: tell the UI before the ~60s load
        yield {"type": "status", "state": "loading", "model": model_id, "label": MODELS[model_id][2]}

    finished = False; turn = 0
    for turn in range(max_turns):
        msg = None
        turn_stream = (gateway_chat_turn(messages, tools, MODELS[model_id][1], samp)
                       if lane == "gateway"
                       else local_chat_turn(model_id, messages, tools, samp))
        for kind, payload in turn_stream:
            if kind == "thinking":
                yield {"type": "token", "channel": "thinking", "text": payload}
            elif kind == "content":
                yield {"type": "token", "channel": "response", "text": payload}
            else:
                msg = payload

        # record the assistant turn in the lane's expected message shape
        assistant = {"role": "assistant", "content": msg.get("content") or ""}
        if msg["tool_calls"]:
            if lane == "gateway":                          # OpenAI: arguments is a JSON string + id
                assistant["tool_calls"] = [
                    {"id": tc.get("id") or ("call_%d" % i), "type": "function",
                     "function": {"name": tc["name"],
                                  "arguments": tc["args"] if isinstance(tc["args"], str) else json.dumps(tc["args"])}}
                    for i, tc in enumerate(msg["tool_calls"])]
            else:                                          # LFM template: arguments is a dict
                assistant["tool_calls"] = [
                    {"type": "function", "function": {"name": tc["name"], "arguments": tc["args"]}}
                    for tc in msg["tool_calls"]]
        messages.append(assistant)

        if not msg["tool_calls"]:
            break                                          # model stopped without finishing
        for i, tc in enumerate(msg["tool_calls"]):
            call_id = tc.get("id") or ("call_%d" % i)
            name = tc["name"]
            args = tc["args"]
            if isinstance(args, str):
                try:
                    args = json.loads(args or "{}")
                except Exception:
                    args = {}
            yield {"type": "tool_call", "id": call_id, "name": name, "args": args}
            result = world.call_tool(state, name, args)
            yield {"type": "tool_result", "id": call_id, "name": name,
                   "ok": "error" not in result, "result": result}
            if lane == "gateway":
                messages.append({"role": "tool", "tool_call_id": call_id, "content": json.dumps(result)})
            else:
                messages.append({"role": "tool", "content": json.dumps(result)})
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
            cat = [{"id": k, "kind": "classify", "title": v[0], "system": v[1], "user": v[2], "gold": v[3]}
                   for k, v in TASKS.items()]
            for tid, t in tool_tasks().items():     # tool tasks discovered from the fixtures
                cat.append({"id": tid, "kind": "tool", "title": t.get("prompt"),
                            "tools": t.get("allowed_tools", []), "checks": len(t.get("assertions", []))})
            return self._json({"tasks": cat})
        if u.path == "/models":
            return self._json({"models": [
                {"id": k, "label": v[2], "lane": v[0], "ready": model_loaded(k)} for k, v in MODELS.items()]})
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

    def handle_agent(self, task_id, mid):
        """Stream a live tool-calling agent run (any tool task) as SSE.
        Forwards run_agent's fully-formed events; it self-guards non-gateway
        models with a single {type:error} event."""
        self._sse_open()
        try:
            for ev in run_agent(task_id, mid):
                self._sse(ev)
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as e:                     # surface failures, never silently die
            try:
                self._sse({"type": "error", "error": "%s: %s" % (type(e).__name__, str(e)[:300])})
            except (BrokenPipeError, ConnectionResetError):
                pass

    def handle_run(self, q):
        task = q.get("task", ["sort-email"])[0]
        mid = q.get("model", ["lfm2.5-8b-a1b"])[0]
        if mid not in MODELS:
            return self._json({"error": "unknown model"}, 400)
        real = resolve_task(task)               # any tool task (or alias) -> live agent loop
        if real:
            return self.handle_agent(real, mid)
        if task not in TASKS:
            return self._json({"error": "unknown task"}, 400)
        title, system, user, gold = TASKS[task]
        self._sse_open()
        self._sse({"type": "meta", "task": task, "model": mid, "label": MODELS[mid][2],
                   "title": title, "system": system, "user": user, "gold": gold})
        if not model_loaded(mid):              # cold model: tell the UI before the ~60s load
            self._sse({"type": "status", "state": "loading", "model": mid, "label": MODELS[mid][2]})
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
        except Exception as e:                     # e.g. a local model fails to load on a stale mlx
            try:
                self._sse({"type": "error", "error": "%s: %s" % (type(e).__name__, str(e)[:300])})
            except (BrokenPipeError, ConnectionResetError):
                pass
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


class QuietServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        # A client closing an SSE stream mid-flight is normal, not an error.
        if sys.exc_info()[0] in (ConnectionResetError, BrokenPipeError):
            return
        super().handle_error(request, client_address)


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--agent":
        task_id = sys.argv[2] if len(sys.argv) > 2 else "hard.renewal_save_route"
        model_id = sys.argv[3] if len(sys.argv) > 3 else "glm-5.1"
        return _cli_agent(task_id, model_id)
    sys.stderr.write(f"ladder live server: http://{HOST}:{PORT}  (viewer: {VIEWER_DIR})\n")
    sys.stderr.write(f"  try: curl -N 'http://{HOST}:{PORT}/run?task=sort-email&model=lfm2.5-8b-a1b'\n")
    sys.stderr.flush()
    threading.Thread(target=prewarm_models, daemon=True).start()   # warm local models off the request path
    QuietServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
