"use client";

import { useCallback, useEffect, useState } from "react";
import { scrollToAnchor } from "@/lib/scrollToAnchor";

export interface ChangelogNavItem {
  readonly version: string;
  readonly date: string;
  readonly anchor: string;
}

// `items` must be a stable reference (the server page builds it once) so the observer wires up a single time
export function useActiveAnchor(items: readonly ChangelogNavItem[]) {
  const [active, setActive] = useState<string | null>(items[0]?.anchor ?? null);

  useEffect(() => {
    const sections = items
      .map((item) => document.getElementById(item.anchor))
      .filter((el): el is HTMLElement => el !== null);
    if (sections.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(entry.target.id);
        }
      },
      { rootMargin: "-100px 0px -66% 0px", threshold: 0 },
    );
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [items]);

  const jumpTo = useCallback((anchor: string, event?: { preventDefault: () => void }) => {
    // Missing section — leave the event alone and let the native jump handle it.
    if (scrollToAnchor(anchor, event)) setActive(anchor);
  }, []);

  return { active, jumpTo };
}
