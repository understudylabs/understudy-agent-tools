"use client";

import { useEffect, useState } from "react";

export type RailSection = { id: string; label: string };

/**
 * OpenRouter-style sticky in-page anchor rail with a scroll-spy highlight.
 * Vertical on wide viewports; collapses to horizontal pills under 900px
 * (see .ent-rail in globals.css). Active section wears the accent.
 */
export function AnchorRail({ sections }: { sections: RailSection[] }) {
  const [active, setActive] = useState<string>(sections[0]?.id ?? "");

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      // Fire when a section heading crosses the upper part of the viewport.
      { rootMargin: "-64px 0px -60% 0px" },
    );
    for (const s of sections) {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [sections]);

  return (
    <nav className="ent-rail" aria-label="Page sections">
      {sections.map((s) => (
        <a key={s.id} href={`#${s.id}`} aria-current={active === s.id ? "true" : undefined} onClick={() => setActive(s.id)}>
          {s.label}
        </a>
      ))}
    </nav>
  );
}
