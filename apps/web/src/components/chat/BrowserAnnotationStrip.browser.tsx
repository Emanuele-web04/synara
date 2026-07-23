// FILE: BrowserAnnotationStrip.browser.tsx
// Purpose: Verifies that compact annotation overflow stays inspectable and removable.

import "../../index.css";

import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { BrowserAnnotationDraft } from "~/lib/browserAnnotations";
import { BrowserAnnotationStrip } from "./BrowserAnnotationStrip";

function makeAnnotation(ordinal: number): BrowserAnnotationDraft {
  return {
    id: `annotation-${ordinal}`,
    ordinal,
    tabId: "tab-1",
    source: {
      url: `https://example.test/page-${ordinal}`,
      pageTitle: `Page ${ordinal}`,
    },
    selector: `#target-${ordinal}`,
    tagName: "button",
    role: "button",
    name: `Target ${ordinal}`,
    text: `Target ${ordinal}`,
    fingerprint: `button|target-${ordinal}`,
    comment: `Comment ${ordinal}`,
    capturedAt: "2026-07-23T10:00:00.000Z",
  };
}

describe("BrowserAnnotationStrip overflow", () => {
  it("reveals a bounded list and removes hidden annotations individually in the composer", async () => {
    const onRemove = vi.fn();
    const mounted = await render(
      <BrowserAnnotationStrip
        annotations={Array.from({ length: 5 }, (_, index) => makeAnnotation(index + 1))}
        onRemove={onRemove}
      />,
    );

    expect(document.querySelector('[data-testid="browser-annotation-overflow-list"]')).toBeNull();
    const overflowTrigger = page.getByRole("button", {
      name: "Show 3 more browser annotations",
    });
    await overflowTrigger.click();

    const overflowList = document.querySelector<HTMLElement>(
      '[data-testid="browser-annotation-overflow-list"]',
    );
    expect(overflowList).not.toBeNull();
    expect(overflowList?.className).toContain("max-h-52");
    expect(document.body.textContent).toContain("Comment 3");
    expect(document.body.textContent).toContain("Comment 5");

    await page.getByRole("button", { name: "Remove browser annotation 4" }).click();
    expect(onRemove).toHaveBeenCalledWith("annotation-4");
    await overflowTrigger.click();
    await mounted.unmount();
  });

  it("keeps the transcript overflow list read-only", async () => {
    const mounted = await render(
      <BrowserAnnotationStrip
        annotations={Array.from({ length: 3 }, (_, index) => makeAnnotation(index + 1))}
      />,
    );

    const overflowTrigger = page.getByRole("button", {
      name: "Show 1 more browser annotation",
    });
    await overflowTrigger.click();
    expect(document.body.textContent).toContain("Comment 3");
    expect(document.querySelector('[aria-label^="Remove browser annotation"]')).toBeNull();
    await overflowTrigger.click();
    await mounted.unmount();
  });
});
