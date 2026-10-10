"use client";

import { useEffect } from "react";
import { scrollToAnchor } from "@/lib/scrollToAnchor";

// one delegated listener upgrades all three fumadocs-rendered sets of # links at once (TOC, permalinks, MDX body) including future ones; only the click path is intercepted — a global scroll-behavior would break fumadocs' own scrolling
export function DocsSmoothScroll() {
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      // Anything but a plain left-click keeps native behavior: a modifier click opens the link in a new tab, where scrolling this page would be wrong.
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const target = event.target;
      const link = target instanceof Element ? target.closest("a") : null;
      if (!link || link.target === "_blank") return;

      const href = link.getAttribute("href");
      if (!href || !href.startsWith("#") || href.length === 1) return;

      // heading slugs may arrive percent-encoded in the href — fall back to the raw value on a broken escape
      const raw = href.slice(1);
      let id = raw;
      try {
        id = decodeURIComponent(raw);
      } catch {
        id = raw;
      }

      // Unknown id — leave the event alone so the browser's own jump still runs.
      scrollToAnchor(id, event);
    };

    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  return null;
}
