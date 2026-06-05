"""pytest config.

Makes the skill-local scripts importable so tests don't each manipulate
`sys.path`. The scripts under `skills/<skill>/scripts/` are not an installed
package (they're invoked directly by the agent), so we add the
`validate-and-optimize` scripts dir to the path once, here.
"""
from __future__ import annotations

import sys
from pathlib import Path

_VAO_SCRIPTS = (
    Path(__file__).resolve().parents[1] / "skills" / "validate-and-optimize" / "scripts"
)
if str(_VAO_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_VAO_SCRIPTS))
