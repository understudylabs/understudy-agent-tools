"""Scripted OpenAI-compatible mock model for the no-keys end-to-end demo.

Not an LLM: a deterministic policy that plays the event-triage task the way a
well-behaved production model would — call `lookup_account` when the event
names an account, then answer with the playbook's rules as bare JSON. The one
knob is `fence_every`: wrap every Nth FINAL answer in markdown fences — valid
JSON that a structured-output parse can't use, the canonical intermittent
output-contract regression. `fence_every=5` is a 20% contract failure rate
that error/latency dashboards never show.

stdlib only; used by demo_gate.py.
"""

import ast
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SECURITY_TYPES = {"login_anomaly", "failed_2fa", "api_key_leaked"}


def playbook_rules(event, tier):
    """The playbook's category/priority table, as code (the oracle policy)."""
    event_type = event.get("type", "")
    if event_type == "api_key_leaked":
        category, priority = "security", "p0"
    elif event_type in SECURITY_TYPES:
        category, priority = "security", "p0" if tier == "enterprise" else "p1"
    elif event_type == "payment_failed":
        category, priority = "billing", "p1" if tier == "enterprise" else "p2"
    elif event_type in ("rate_limit_approach", "quota_exceeded"):
        category, priority = "usage", "p2"
    elif event_type == "ticket_opened":
        category, priority = "support", "p2" if tier == "enterprise" else "p3"
    else:  # heartbeat, invoice_paid, malformed frames
        category, priority = "noise", "p3"
    return {
        "category": category,
        "priority": priority,
        "account_ref": event.get("account_id"),
        "reasoning": f"{event_type or 'unknown'} event, scripted policy.",
    }


def _loose_json(text):
    """Tool results arrive as str(dict) (single quotes) — accept both forms."""
    for parse in (json.loads, ast.literal_eval):
        try:
            return parse(text)
        except (ValueError, SyntaxError):
            continue
    return {}


class _Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        request = json.loads(self.rfile.read(length) or b"{}")
        reply = self._policy(request.get("messages", []), bool(request.get("tools")))
        body = json.dumps(
            {
                "id": "chatcmpl-mock",
                "object": "chat.completion",
                "created": 0,
                "model": request.get("model", "scripted"),
                "choices": [
                    {
                        "index": 0,
                        "message": reply["message"],
                        "finish_reason": reply["finish_reason"],
                    }
                ],
                "usage": {
                    "prompt_tokens": 50,
                    "completion_tokens": 20,
                    "total_tokens": 70,
                },
            }
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):  # keep demo output clean
        pass

    def _policy(self, messages, tools_offered):
        event, tier, looked_up = {}, None, False
        for message in messages:
            role, content = message.get("role"), message.get("content")
            if role == "user" and isinstance(content, str):
                event = _loose_json(content)
            elif role == "tool":
                looked_up = True
                if isinstance(content, str):
                    tier = _loose_json(content).get("plan")
        if tools_offered and event.get("account_id") and not looked_up:
            return {
                "finish_reason": "tool_calls",
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "type": "function",
                            "function": {
                                "name": "lookup_account",
                                "arguments": json.dumps(
                                    {"account_id": event["account_id"]}
                                ),
                            },
                        }
                    ],
                },
            }
        answer = json.dumps(playbook_rules(event, tier))
        if self.server.take_fence_ticket():
            answer = f"```json\n{answer}\n```"
        return {
            "finish_reason": "stop",
            "message": {"role": "assistant", "content": answer},
        }


class MockModelServer(ThreadingHTTPServer):
    """OpenAI-compatible /v1/chat/completions on an ephemeral localhost port."""

    def __init__(self, fence_every=None):
        super().__init__(("127.0.0.1", 0), _Handler)
        self.fence_every = fence_every
        self._final_answers = 0
        self._lock = threading.Lock()

    def take_fence_ticket(self):
        if not self.fence_every:
            return False
        with self._lock:
            self._final_answers += 1
            return self._final_answers % self.fence_every == 0

    @property
    def base_url(self):
        return f"http://127.0.0.1:{self.server_address[1]}/v1"


def start(fence_every=None):
    server = MockModelServer(fence_every)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server
