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
    "lfm2.5-8b-a1b": ("mlx_lm",  "/Users/luis/.understudy/models/lfm2.5-8b-a1b-8bit", "LFM 8B-A1B · thinking", {"temp": 0.2,  "top_k": 80, "rep": 1.05}),
    "lfm-thinking":  ("mlx_lm",  "LiquidAI/LFM2.5-1.2B-Thinking-MLX-8bit", "LFM 1.2B · thinking", {"temp": 0.05, "top_k": 50, "rep": 1.05}),
    "lfm-instruct":  ("mlx_lm",  "LiquidAI/LFM2.5-1.2B-Instruct-MLX-8bit", "LFM 1.2B · instruct", {"temp": 0.05, "top_k": 50, "rep": 1.05}),
    "gemma-4-e2b":   ("mlx_vlm", "/Users/luis/.understudy/models/gemma-4-e2b-it-mlx-vlm-4bit", "gemma-4-e2b", {}),
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

def stream_tokens(mid, system, user, max_tokens=900):
    """Yield raw text deltas from the model for system+user."""
    obj = get_model(mid)
    lane = obj[0]
    samp = MODELS[mid][3] if len(MODELS[mid]) > 3 else {}
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
            yield r.text
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
            yield getattr(ch, "text", "") or ""

def split_channels(full):
    """Split accumulated text into (thinking, response) by the <think> channel."""
    if "<think>" in full:
        after = full.split("<think>", 1)[1]
        if "</think>" in after:
            think, resp = after.split("</think>", 1)
            return think, resp
        return after, ""
    return "", full


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

    def handle_run(self, q):
        task = q.get("task", ["sort-email"])[0]
        mid = q.get("model", ["lfm2.5-8b-a1b"])[0]
        if task not in TASKS or mid not in MODELS:
            return self._json({"error": "unknown task or model"}, 400)
        title, system, user, gold = TASKS[task]
        self._sse_open()
        self._sse({"type": "meta", "task": task, "model": mid, "label": MODELS[mid][2],
                   "title": title, "system": system, "user": user, "gold": gold})
        full = ""; sent_think = 0; sent_resp = 0; n = 0; t0 = time.time()
        try:
            for delta in stream_tokens(mid, system, user):
                if not delta:
                    continue
                full += delta; n += 1
                think, resp = split_channels(full)
                if len(think) > sent_think:
                    self._sse({"type": "token", "channel": "thinking", "text": think[sent_think:]}); sent_think = len(think)
                if len(resp) > sent_resp:
                    self._sse({"type": "token", "channel": "response", "text": resp[sent_resp:]}); sent_resp = len(resp)
        except (BrokenPipeError, ConnectionResetError):
            return
        dt = time.time() - t0
        _, resp = split_channels(full)
        correct = gold.split()[0].lower() in resp.lower() if gold else None
        self._sse({"type": "done", "tokens": n, "seconds": round(dt, 2),
                   "tok_s": round(n / max(dt, 0.01)), "correct": correct,
                   "response": resp.strip()[:200]})


def main():
    sys.stderr.write(f"ladder live server: http://{HOST}:{PORT}  (viewer: {VIEWER_DIR})\n")
    sys.stderr.write(f"  try: curl -N 'http://{HOST}:{PORT}/run?task=sort-email&model=lfm-thinking'\n")
    sys.stderr.flush()
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
