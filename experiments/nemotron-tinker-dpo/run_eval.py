"""Run the shared #402 evaluator."""

from __future__ import annotations

import runpy
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SIBLING_DIR = REPO / "experiments" / "nemotron-tinker-grpo"
sys.path.insert(0, str(SIBLING_DIR))
runpy.run_path(str(SIBLING_DIR / "evaluate.py"), run_name="__main__")
