#!/usr/bin/env python3
"""Compile a LaTeX paper and summarize common polish warnings."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path


WARNING_PATTERNS = {
    "overfull_hbox": re.compile(r"Overfull \\hbox.*", re.IGNORECASE),
    "underfull_hbox": re.compile(r"Underfull \\hbox.*", re.IGNORECASE),
    "underfull_vbox": re.compile(r"Underfull \\vbox.*", re.IGNORECASE),
    "undefined_reference": re.compile(r"(Reference .* undefined|There were undefined references)", re.IGNORECASE),
    "undefined_citation": re.compile(r"(Citation .* undefined|There were undefined citations)", re.IGNORECASE),
    "rerun_needed": re.compile(r"(Rerun to get|Label\\(s\\) may have changed)", re.IGNORECASE),
    "latex_error": re.compile(r"(! LaTeX Error:|! Package .* Error:|! Emergency stop)", re.IGNORECASE),
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tex", type=Path, help="Path to the .tex file.")
    parser.add_argument("--compile", action="store_true", help="Compile before inspecting logs.")
    parser.add_argument("--outdir", type=Path, default=None, help="Build output directory.")
    parser.add_argument("--json", action="store_true", help="Emit JSON only.")
    return parser.parse_args()


def run(cmd: list[str], cwd: Path) -> tuple[int, str]:
    proc = subprocess.run(
        cmd,
        cwd=cwd,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    return proc.returncode, proc.stdout


def compile_tex(tex: Path, outdir: Path) -> tuple[str | None, str]:
    if shutil.which("tectonic"):
        cmd = [
            "tectonic",
            "-X",
            "compile",
            "--keep-intermediates",
            "--outdir",
            str(outdir),
            tex.name,
        ]
        code, output = run(cmd, tex.parent)
        return ("tectonic" if code == 0 else None), output

    if shutil.which("latexmk"):
        cmd = [
            "latexmk",
            "-pdf",
            "-interaction=nonstopmode",
            "-halt-on-error",
            f"-outdir={outdir}",
            tex.name,
        ]
        code, output = run(cmd, tex.parent)
        return ("latexmk" if code == 0 else None), output

    if shutil.which("pdflatex"):
        cmd = [
            "pdflatex",
            "-interaction=nonstopmode",
            "-halt-on-error",
            f"-output-directory={outdir}",
            tex.name,
        ]
        code, output = run(cmd, tex.parent)
        if code == 0:
            code, output2 = run(cmd, tex.parent)
            output += "\n" + output2
        return ("pdflatex" if code == 0 else None), output

    return None, "No LaTeX compiler found: expected tectonic, latexmk, or pdflatex."


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return ""


def inspect_log(log_text: str) -> dict[str, list[str]]:
    warnings: dict[str, list[str]] = {key: [] for key in WARNING_PATTERNS}
    for line in log_text.splitlines():
        stripped = line.strip()
        for key, pattern in WARNING_PATTERNS.items():
            if pattern.search(stripped):
                warnings[key].append(stripped)
    return warnings


def inspect_source(tex_text: str) -> dict[str, object]:
    lines = tex_text.splitlines()
    long_lines = [
        {"line": i + 1, "chars": len(line), "text": line[:180]}
        for i, line in enumerate(lines)
        if len(line) > 140 and not line.lstrip().startswith("%")
    ]
    trailing_whitespace = [
        i + 1 for i, line in enumerate(lines) if line.rstrip() != line
    ]
    preamble_checks = {
        "clubpenalty": "\\clubpenalty" in tex_text,
        "widowpenalty": "\\widowpenalty" in tex_text,
        "displaywidowpenalty": "\\displaywidowpenalty" in tex_text,
        "raggedbottom": "\\raggedbottom" in tex_text,
    }
    return {
        "line_count": len(lines),
        "long_lines": long_lines[:30],
        "long_line_count": len(long_lines),
        "trailing_whitespace_lines": trailing_whitespace[:50],
        "trailing_whitespace_count": len(trailing_whitespace),
        "preamble_checks": preamble_checks,
    }


def find_log(tex: Path, outdir: Path) -> Path:
    return outdir / f"{tex.stem}.log"


def main() -> int:
    args = parse_args()
    tex = args.tex.expanduser().resolve()
    if not tex.exists():
        print(f"missing tex file: {tex}", file=sys.stderr)
        return 2
    if tex.suffix.lower() != ".tex":
        print(f"expected a .tex file: {tex}", file=sys.stderr)
        return 2

    outdir = (args.outdir or tex.parent / "build").expanduser().resolve()
    outdir.mkdir(parents=True, exist_ok=True)

    compile_status = None
    compile_output = ""
    if args.compile:
        compile_status, compile_output = compile_tex(tex, outdir)

    log_path = find_log(tex, outdir)
    log_text = read_text(log_path)
    if not log_text and compile_output:
        log_text = compile_output

    result = {
        "tex": str(tex),
        "pdf": str(outdir / f"{tex.stem}.pdf"),
        "log": str(log_path) if log_path.exists() else None,
        "compiled_with": compile_status,
        "compile_requested": args.compile,
        "compile_succeeded": bool(compile_status) if args.compile else None,
        "source": inspect_source(read_text(tex)),
        "warnings": inspect_log(log_text),
    }

    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result.get("compile_succeeded") is not False else 1

    print(f"TeX: {result['tex']}")
    print(f"PDF: {result['pdf']}")
    if args.compile:
        print(f"Compile: {'ok' if compile_status else 'failed'} ({compile_status or 'no compiler/error'})")
    source = result["source"]
    print(f"Lines: {source['line_count']}")
    print(f"Long lines >140 chars: {source['long_line_count']}")
    print(f"Trailing whitespace lines: {source['trailing_whitespace_count']}")
    print("Preamble checks:")
    for key, value in source["preamble_checks"].items():
        print(f"  {key}: {'yes' if value else 'missing'}")
    print("Warnings:")
    for key, values in result["warnings"].items():
        print(f"  {key}: {len(values)}")
        for value in values[:5]:
            print(f"    {value}")
    return 0 if result.get("compile_succeeded") is not False else 1


if __name__ == "__main__":
    raise SystemExit(main())
