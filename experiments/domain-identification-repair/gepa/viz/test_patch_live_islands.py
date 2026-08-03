#!/usr/bin/env python3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from patch_live_islands import (  # noqa: E402
    NEW_DECL, NEW_LABEL, NEW_NODES, NEW_REFS, NEW_SHAPE, NEW_SIM,
    NEW_ZOOM_EFFECT, OLD_DECL, OLD_LABEL, OLD_NODES, OLD_REFS, OLD_SHAPE,
    OLD_SIM, OLD_ZOOM_EFFECT, patch,
)

source = f"prefix {OLD_DECL} middle {OLD_SHAPE} then {OLD_LABEL} suffix"
patched = patch(source)
assert NEW_DECL in patched and NEW_SHAPE in patched and NEW_LABEL in patched
assert "r:22" in patched and "children:r.branch_id||r.label||n.id" in patched
assert "[`completed`,`promoted`]" in patched
assert "[`failed`,`rejected`]" in patched
assert patch(patched) == patched

graph_source = " ".join((
    source, OLD_REFS, OLD_NODES, OLD_SIM, OLD_ZOOM_EFFECT,
))
stable = patch(graph_source)
assert all(marker in stable for marker in (
    NEW_REFS, NEW_NODES, NEW_SIM, NEW_ZOOM_EFFECT,
))
assert "alphaDecay(.075).velocityDecay(.58)" in stable
assert "Math.max(_.alpha(),.075)" in stable
assert patch(stable) == stable
print("ALL 9 LIVE-ISLAND PATCH TESTS PASSED")
