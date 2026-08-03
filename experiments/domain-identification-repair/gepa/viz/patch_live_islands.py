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

# Preserve D3's mutable node objects between live snapshots. Recreating both
# nodes and the simulation on every poll resets positions and causes the graph
# to jump. The extra ref is a keyed node cache; the existing simulation ref is
# reused and only gently reheated.
OLD_REFS = "let n=(0,x.useRef)(null),r=(0,x.useRef)(null),i=(0,x.useRef)(null),a=(0,x.useRef)(null),"
NEW_REFS = OLD_REFS + "b=(0,x.useRef)(new Map),"
OLD_NODES = (
    "let t=new Map,n=new Map,r=Object.keys(e.candidates).map(r=>({id:r,depth:Nl(e,r,t),"
    "branch:Pl(e,r,n)})),i=Object.entries(e.candidates)"
)
NEW_NODES = (
    "let t=new Map,n=new Map,R=new Set(Object.keys(e.candidates));for(let e of b.current.keys())"
    "R.has(e)||b.current.delete(e);let r=Object.keys(e.candidates).map(r=>{let i=Nl(e,r,t),a=Pl(e,r,n),"
    "o=b.current.get(r);if(o)return o.depth=i,o.branch=a,o;let s={id:r,depth:i,branch:a};return "
    "b.current.set(r,s),s}),i=Object.entries(e.candidates)"
)
OLD_SIM = (
    "_=ii(p).force(`link`,Sr(m).id(e=>e.id).distance(Math.max(120,Math.min(t,n)*.12)).strength(.9))"
    ".force(`charge`,ai().strength(-Math.max(900,t*.8))).force(`center`,Kn(t/2,n/2))"
    ".force(`x`,oi(e=>d(e.branch)).strength(.18)).force(`y`,si(e=>c(e.depth)).strength(.9))"
    ".force(`collide`,yr(t=>{let n=e.candidates[t.id];return Ml(n.score)+10})).on(`tick`,()=>f(e=>e+1));"
    "return a.current=_,()=>{_.stop()}"
)
NEW_SIM = (
    "B=a.current===null,_=a.current??ii(p);return _.nodes(p).alphaDecay(.075).velocityDecay(.58)"
    ".force(`link`,Sr(m).id(e=>e.id).distance(Math.max(120,Math.min(t,n)*.12)).strength(.9))"
    ".force(`charge`,ai().strength(-Math.max(900,t*.8))).force(`center`,Kn(t/2,n/2))"
    ".force(`x`,oi(e=>d(e.branch)).strength(.08)).force(`y`,si(e=>c(e.depth)).strength(.24))"
    ".force(`collide`,yr(t=>{let n=e.candidates[t.id];return Ml(n.score)+10}).strength(.75))"
    ".on(`tick`,()=>f(e=>e+1)),_.alpha(B?.55:Math.max(_.alpha(),.075)).restart(),a.current=_,()=>{}"
)
OLD_ZOOM_EFFECT = "},[p,m,e,h,g,o.w,o.h]),(0,x.useEffect)(()=>{if(!r.current)return;"
NEW_ZOOM_EFFECT = (
    "},[p,m,e,h,g,o.w,o.h]),(0,x.useEffect)(()=>()=>{a.current?.stop()},[]),"
    "(0,x.useEffect)(()=>{if(!r.current)return;"
)


def patch(text):
    status_done = NEW_DECL in text and NEW_SHAPE in text and NEW_LABEL in text
    stable_done = all(x in text for x in (NEW_REFS, NEW_NODES, NEW_SIM, NEW_ZOOM_EFFECT))
    has_stable_surface = OLD_REFS in text or NEW_REFS in text
    if status_done and (stable_done or not has_stable_surface):
        return text
    replacements = []
    if not status_done:
        replacements.extend((
            (OLD_DECL, NEW_DECL, "declaration"),
            (OLD_SHAPE, NEW_SHAPE, "node shape"),
            (OLD_LABEL, NEW_LABEL, "node label"),
        ))
    if has_stable_surface and not stable_done:
        replacements.extend((
            (OLD_REFS, NEW_REFS, "node-cache ref"),
            (OLD_NODES, NEW_NODES, "stable node construction"),
            (OLD_SIM, NEW_SIM, "persistent simulation"),
            (OLD_ZOOM_EFFECT, NEW_ZOOM_EFFECT, "simulation unmount cleanup"),
        ))
    for old, new, label in replacements:
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
