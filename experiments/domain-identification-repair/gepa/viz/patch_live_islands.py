#!/usr/bin/env python3
"""Idempotently patch upstream gepa-viz's minified graph for live island states.

Upstream treats every unscored node as a tiny anonymous rejected candidate.
Understudy carries explicit lifecycle status, so running islands need a named
white pulse and terminal screening outcomes need a named green/red node without
inventing a valset score or predictions.
"""
import argparse
from pathlib import Path

OLD_DECL = "let i=Ml(r.score),a=Qc(r),o=jl.has(r.status??``),s=$c(r);"
NEW_DECL = (
    "let i=Ml(r.score),a=Qc(r),o=jl.has(r.status??``),s=$c(r),"
    "C=[`completed`,`promoted`].includes(r.status??``)&&!a,"
    "E=[`failed`,`rejected`].includes(r.status??``)&&!a;"
)
OLD_SHAPE = (
    "o?(0,W.jsx)(`circle`,{r:i,fill:`#ffffff`,stroke:`#ffffff`,strokeWidth:.8,"
    "className:`gepa-active-pulse`}):a&&s?(0,W.jsx)(Ol,{radius:i,mask:s}):"
    "(0,W.jsx)(`circle`,{r:i,fill:`#a1a1aa`,stroke:`#52525b`,strokeWidth:.8})"
)
NEW_SHAPE = (
    "o?(0,W.jsx)(`circle`,{r:22,fill:`#ffffff`,stroke:`#ffffff`,strokeWidth:.8,"
    "className:`gepa-active-pulse`}):C?(0,W.jsx)(`circle`,{r:18,fill:`#16a34a`,"
    "stroke:`#14532d`,strokeWidth:1.2}):E?(0,W.jsx)(`circle`,{r:18,fill:`#dc2626`,"
    "stroke:`#7f1d1d`,strokeWidth:1.2}):a&&s?(0,W.jsx)(Ol,{radius:i,mask:s}):"
    "(0,W.jsx)(`circle`,{r:i,fill:`#a1a1aa`,stroke:`#52525b`,strokeWidth:.8})"
)
OLD_LABEL = (
    "a&&(0,W.jsx)(`text`,{textAnchor:`middle`,dy:`0.34em`,fontSize:16,fontWeight:700,"
    "className:`fill-zinc-900 dark:fill-zinc-100 font-mono`,pointerEvents:`none`,children:n.id})"
)
NEW_LABEL = (
    "(a||o||C||E)&&(0,W.jsx)(`text`,{textAnchor:`middle`,y:o||C||E?34:void 0,"
    "dy:o||C||E?void 0:`0.34em`,fontSize:o||C||E?11:16,fontWeight:700,"
    "className:`fill-zinc-900 dark:fill-zinc-100 font-mono`,pointerEvents:`none`,"
    "children:r.branch_id||r.label||n.id})"
)


def patch(text):
    if NEW_DECL in text and NEW_SHAPE in text and NEW_LABEL in text:
        return text
    for old, new, label in (
        (OLD_DECL, NEW_DECL, "declaration"),
        (OLD_SHAPE, NEW_SHAPE, "node shape"),
        (OLD_LABEL, NEW_LABEL, "node label"),
    ):
        if text.count(old) != 1:
            raise SystemExit(f"expected exactly one upstream {label} marker; found {text.count(old)}")
        text = text.replace(old, new)
    return text


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("asset")
    args = parser.parse_args()
    path = Path(args.asset)
    original = path.read_text()
    updated = patch(original)
    path.write_text(updated)
    print(f"patched {path} ({len(updated) - len(original):+d} bytes)")


if __name__ == "__main__":
    main()
