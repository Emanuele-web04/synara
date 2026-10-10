"use client";

import { useEffect } from "react";

// patches two fumadocs gaps with no CSS fix: GFM task-list checkboxes render disabled with no accessible name, and scrollable code regions get labels only when they contain a <pre>; labels numbered per type for landmark uniqueness
export function DocsA11yLabels() {
  useEffect(() => {
    const apply = () => {
      let checklistCount = 0;
      for (const input of document.querySelectorAll<HTMLInputElement>(
        '.task-list-item input[type="checkbox"]',
      )) {
        checklistCount += 1;
        if (!input.hasAttribute("aria-label")) {
          input.setAttribute("aria-label", `Checklist item ${checklistCount}`);
        }
      }
      let codeBlockCount = 0;
      for (const region of document.querySelectorAll<HTMLElement>(".fd-scroll-container")) {
        if (!region.querySelector("pre")) continue;
        codeBlockCount += 1;
        if (!region.hasAttribute("aria-label")) {
          region.setAttribute("aria-label", `Code block ${codeBlockCount}`);
        }
      }
    };

    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return null;
}
