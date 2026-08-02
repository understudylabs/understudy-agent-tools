#!/usr/bin/env python3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from patch_live_islands import (  # noqa: E402
    NEW_DECL, NEW_LABEL, NEW_SHAPE, OLD_DECL, OLD_LABEL, OLD_SHAPE, patch,
)

source = f"prefix {OLD_DECL} middle {OLD_SHAPE} then {OLD_LABEL} suffix"
patched = patch(source)
assert NEW_DECL in patched and NEW_SHAPE in patched and NEW_LABEL in patched
assert "r:22" in patched and "children:r.branch_id||r.label||n.id" in patched
assert "[`completed`,`promoted`]" in patched
assert "[`failed`,`rejected`]" in patched
assert patch(patched) == patched
print("ALL 5 LIVE-ISLAND PATCH TESTS PASSED")
