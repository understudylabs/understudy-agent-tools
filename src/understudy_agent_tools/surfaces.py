"""Public surface data — the single source of truth for the repo spine and the
roadmap surfaces.

Kept as data (not baked into ``cli.py`` logic) so the skill/appendix paths can
move without editing command code. When the skills tree is reshaped, edit
``ROADMAP_SURFACES`` here; ``cli.build_parser`` and the ``skills``/``spine``
commands read from it.
"""
from __future__ import annotations


def spine_payload() -> dict[str, object]:
    """The public repo spine (`understudy-tools spine`)."""
    return {
        "name": "understudy-agent-tools",
        "license": "MIT",
        "spines": [
            {"name": "cli", "path": "src/understudy_agent_tools"},
            {"name": "scripts", "path": "scripts"},
            {"name": "skills", "path": "skills"},
            {"name": "vendor", "path": "vendor"},
            {"name": "docs", "path": "docs"},
        ],
        "entrypoint_skill": "skills/understudy/SKILL.md",
        "default_mode": "local-only",
    }


# Roadmap surfaces: planned public commands whose runtime hasn't landed yet.
# `skill` points at the documenting skill (appendix while pre-discovery); `why`
# and `next` describe the surface and its next migration step. The four entries
# that already have real handlers (demo, workload-discovery, capture-import,
# value) are wired explicitly in cli.py; the rest auto-generate stub commands.
ROADMAP_SURFACES: dict[str, dict[str, str]] = {
    "demo": {
        "skill": "appendix/understudy-demo/SKILL.md",
        "why": "Local repo workload discovery before provider spend.",
        "next": "Expand static scan signals and add richer Workload Card validation.",
    },
    "workload-discovery": {
        "skill": "appendix/understudy-workload-discovery/SKILL.md",
        "why": "Find and rank local repo AI workload candidates before evaluation.",
        "next": "Add workload type classification and richer candidate-card fields.",
    },
    "capture-import": {
        "skill": "appendix/understudy-capture-import/SKILL.md",
        "why": "Find local traces, eval fixtures, prompt files, logs, and datasets before building a Workload Card.",
        "next": "Add format-specific import previews and redaction manifests before payload extraction.",
    },
    "evaluate": {
        "skill": "appendix/understudy-evaluate/SKILL.md",
        "why": "Local-first workload measurement with explicit split boundaries.",
        "next": "Port artifact validation and dry-run eval planning before live runners.",
    },
    "optimize": {
        "skill": "appendix/understudy-optimize/SKILL.md",
        "why": "Post-baseline prompt, route, parser, and candidate improvement.",
        "next": "Port local dry-run planning before any optimizer implementation.",
    },
    "train": {
        "skill": "appendix/understudy-train/SKILL.md",
        "why": "Local training handoff: provenance, split validation, and export previews.",
        "next": "Port export-preview and validation stubs before hosted provider flows.",
    },
    "model": {
        "skill": "appendix/understudy-model-lookup/SKILL.md",
        "why": "Compatibility checks before benchmark or replacement claims.",
        "next": "Port local metadata inspection and public model-card lookup helpers.",
    },
    "local-models": {
        "skill": "appendix/understudy-local-models/SKILL.md",
        "why": "Apple Silicon, MLX, Ollama, and local runner readiness before live comparison.",
        "next": "Port local hardware inventory and dry-run runner checks without private workloads.",
    },
    "provider-integrations": {
        "skill": "appendix/understudy-provider-integrations/SKILL.md",
        "why": "Provider cookbook mapping and route-decision planning before live calls.",
        "next": "Port redacted key readiness, model lookup, supplier profile refresh, and route-decision packet generation.",
    },
    "proxy": {
        "skill": "appendix/understudy-local-proxy/SKILL.md",
        "why": "Local OpenAI-compatible routing and trace-capture setup.",
        "next": "Port local fixture proxy checks without hosted-control-plane details.",
    },
    "keys": {
        "skill": "appendix/understudy-provider-keys/SKILL.md",
        "why": "Redacted local provider-key status and safe setup guidance.",
        "next": "Port redacted presence checks only; never print secret values.",
    },
    "value": {
        "skill": "appendix/understudy-value-reporting/SKILL.md",
        "why": "Conservative value reporting from measured evidence.",
        "next": "Expand beyond baseline-only scenario math after eval evidence lands.",
    },
}

# Roadmap surfaces with their own real handlers in cli.py — excluded from the
# auto-generated stub loop.
EXPLICIT_SURFACES = frozenset({"demo", "workload-discovery", "capture-import", "value"})

# Action stubs accepted by every roadmap surface until runtime code lands.
ROADMAP_ACTIONS = ("status", "doctor", "lookup", "route", "validate", "run", "plan", "start", "export")


def roadmap_payload(surface: str) -> dict[str, str]:
    """Planned-status payload for a roadmap surface."""
    spec = ROADMAP_SURFACES[surface]
    return {
        "surface": surface,
        "status": "planned",
        "implemented": "false",
        "default_mode": "local-only",
        "skill": spec["skill"],
        "why": spec["why"],
        "next_migration": spec["next"],
        "migration_plan": "docs/tool-migration-map.md",
    }
