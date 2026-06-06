#!/usr/bin/env python3
"""
decompose.py — extract the STRUCTURE of a captured LLM workload (one prompt/trace)
so a human can understand it before any model comparison.

Handles:
  - Understudy capture envelopes (.jsonl with a `customer_request_body` field)
  - raw Anthropic/OpenAI request JSON ({model, system, messages, tools, ...})

Prints a redaction-safe decomposition: model + params, the SYSTEM-prompt outline
(headings only), message roles + sizes (never content), the tool catalog grouped
by action class, the output schema, a token estimate, and mermaid diagrams (the
agent loop + the tool-class map). It does NOT print message/customer content.

Usage:
  decompose.py <capture.jsonl | request.json> [--full-system] [--json]

The agent uses this to ground an explanation + an interactive Q&A with the user;
the human-facing understanding doc is written by the agent, not here.
"""
import json, sys, os, re

def load_request(path):
    raw = open(path).read().strip()
    # try whole-file JSON, then first JSONL record
    def first_json(text):
        try: return json.loads(text)
        except json.JSONDecodeError:
            for line in text.splitlines():
                line = line.strip()
                if line:
                    return json.loads(line)
        raise ValueError("could not parse JSON")
    obj = first_json(raw)
    env = {}
    # Understudy capture envelope?
    if isinstance(obj, dict) and "customer_request_body" in obj:
        env = {k: obj.get(k) for k in ("request_id", "requested_model", "endpoint",
                                       "status_code", "latency_ms", "provider", "mode")}
        body = obj["customer_request_body"]
        req = json.loads(body) if isinstance(body, str) else body
    else:
        req = obj
    return req, env

TOOL_CLASS = [
    ("read",      r"query|load|get|retrieve|lookup|read|list|grep|glob|schema|history|context"),
    ("write",     r"write|upsert|create|update|delete|edit|purge|merge|insert|bulk"),
    ("transform", r"parse|extract|transform|convert|format"),
    ("search",    r"search|fetch|web"),
    ("orchestrate", r"agent|task|skill|monitor|schedule|wakeup"),
    ("notify",    r"notify|push|message|slack|email|send"),
    ("exec",      r"bash|shell|run|command"),
]
def classify(name):
    n = name.lower()
    for cls, pat in TOOL_CLASS:
        if re.search(pat, n):
            return cls
    return "other"

def text_of(x):
    if isinstance(x, str): return x
    if isinstance(x, list): return " ".join(b.get("text", "") for b in x if isinstance(b, dict))
    return ""

def summarize(req, env):
    model = req.get("model")
    system = text_of(req.get("system"))
    msgs = req.get("messages", [])
    msg_rows = []
    for m in msgs:
        c = m.get("content")
        if isinstance(c, str):
            n = len(c); kinds = ["text"]
        elif isinstance(c, list):
            n = sum(len(b.get("text", "")) + len(json.dumps(b.get("input", {})) if b.get("type") == "tool_use" else "") for b in c if isinstance(b, dict))
            kinds = sorted({b.get("type", "text") for b in c if isinstance(b, dict)})
        else:
            n = 0; kinds = []
        msg_rows.append({"role": m.get("role"), "chars": n, "kinds": kinds})
    tools = []
    for t in req.get("tools", []) or []:
        nm = t.get("name", "?")
        props = list((t.get("input_schema", {}) or {}).get("properties", {}).keys())
        tools.append({"name": nm, "class": classify(nm), "params": props})
    out_schema = None
    oc = req.get("output_config") or {}
    if isinstance(oc, dict) and oc.get("format"):
        out_schema = list(((oc["format"] or {}).get("schema", {}) or {}).get("properties", {}).keys())
    sys_chars = len(system)
    msg_chars = sum(r["chars"] for r in msg_rows)
    tool_chars = len(json.dumps(req.get("tools", []) or []))
    approx_tok = (sys_chars + msg_chars + tool_chars) // 4
    # system outline = markdown headings
    headings = [l.strip() for l in system.splitlines() if l.strip().startswith("#")][:25]
    return {
        "env": env, "model": model, "max_tokens": req.get("max_tokens"),
        "thinking": req.get("thinking"), "stream": req.get("stream"),
        "system_chars": sys_chars, "system_outline": headings,
        "messages": msg_rows, "tools": tools, "output_schema": out_schema,
        "approx_tokens": approx_tok,
    }

def tool_classes(facts):
    classes = {}
    for t in facts["tools"]:
        classes.setdefault(t["class"], []).append(t["name"])
    return classes

def mermaid(facts):
    classes = tool_classes(facts)
    order = ["read", "transform", "write", "search", "exec", "orchestrate", "notify", "other"]
    nodes = [c for c in order if c in classes]
    lines = ["```mermaid", "flowchart TD",
             '  IN["Inputs: user task + context"]:::io --> SYS["System prompt:\\nrole + policy + tools"]:::sys',
             '  SYS --> LOOP{{"Agent loop\\n' + str(facts["model"]) + ' · ~' + f'{facts["approx_tokens"]:,}' + ' tok/turn"}}:::loop']
    label = {"read": "READ / discover", "transform": "TRANSFORM / parse", "write": "WRITE / mutate state",
             "search": "SEARCH / fetch", "exec": "EXECUTE", "orchestrate": "ORCHESTRATE", "notify": "NOTIFY", "other": "OTHER"}
    for c in nodes:
        ex = ", ".join(classes[c][:3]) + ("…" if len(classes[c]) > 3 else "")
        lines.append(f'  LOOP -->|{label[c]}| {c.upper()}["{label[c]}\\n{ex}"]:::{c}')
    if "write" in classes:
        lines.append('  WRITE --> OUT["Output: final state / written records"]:::io')
    else:
        lines.append('  LOOP --> OUT["Output: final answer"]:::io')
    lines += ["  classDef io fill:#eef,stroke:#446;",
              "  classDef sys fill:#efe,stroke:#363;",
              "  classDef loop fill:#fef,stroke:#7C5CFF,stroke-width:2px;",
              "```"]
    return "\n".join(lines)

def render(facts, full_system=False):
    e = facts["env"]; out = []
    out.append("# Workload decomposition\n")
    if e:
        out.append(f"- **capture**: `{e.get('request_id','?')}`  ·  endpoint `{e.get('endpoint','?')}`  ·  "
                   f"status {e.get('status_code','?')}  ·  latency {e.get('latency_ms','?')}ms  ·  provider {e.get('provider','?')}")
    out.append(f"- **model**: `{facts['model']}`  ·  max_tokens {facts['max_tokens']}  ·  "
               f"thinking {bool(facts['thinking'])}  ·  stream {facts['stream']}")
    out.append(f"- **size**: ~**{facts['approx_tokens']:,} tokens** in  (system {facts['system_chars']:,} chars · "
               f"{len(facts['messages'])} messages · {len(facts['tools'])} tools)\n")
    out.append("## What the prompt tells the model to be (system outline)\n")
    for h in facts["system_outline"] or ["(no markdown headings found)"]:
        out.append(h)
    if full_system:
        out.append("\n<details><summary>full system prompt (local only)</summary>\n")
    out.append("\n## Inputs (messages — sizes only, content redacted)\n")
    for i, m in enumerate(facts["messages"], 1):
        out.append(f"{i}. **{m['role']}** — {m['chars']:,} chars  ·  {', '.join(m['kinds'])}")
    out.append("\n## Actions available (tool catalog, grouped by what they DO)\n")
    for cls, names in tool_classes(facts).items():
        out.append(f"- **{cls}** ({len(names)}): {', '.join(names)}")
    if facts["output_schema"]:
        out.append(f"\n## Output schema (fields)\n- {', '.join(facts['output_schema'])}")
    out.append("\n## Flow\n")
    out.append(mermaid(facts))
    return "\n".join(out)

if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = {a for a in sys.argv[1:] if a.startswith("--")}
    if not args:
        print(__doc__); sys.exit(2)
    req, env = load_request(args[0])
    facts = summarize(req, env)
    if "--json" in flags:
        print(json.dumps(facts, indent=2))
    else:
        print(render(facts, full_system="--full-system" in flags))
