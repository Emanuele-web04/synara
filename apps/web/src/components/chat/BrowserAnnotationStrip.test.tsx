// FILE: BrowserAnnotationStrip.test.tsx
// Purpose: Guards the compact, fixed-row browser annotation presentation.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

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

describe("BrowserAnnotationStrip", () => {
  it("renders two annotations and a compact overflow trigger on one row", () => {
    const markup = renderToStaticMarkup(
      <BrowserAnnotationStrip
        annotations={Array.from({ length: 5 }, (_, index) => makeAnnotation(index + 1))}
        onRemove={() => {}}
      />,
    );

    expect(markup.match(/data-testid="browser-annotation-chip"/g)).toHaveLength(2);
    expect(markup).toContain("Comment 1");
    expect(markup).toContain("Comment 2");
    expect(markup).not.toContain("Comment 3");
    expect(markup).toContain("+3 others");
    expect(markup).toContain("flex-nowrap");
    expect(markup).toContain("Remove browser annotation 1");
    expect(markup).toContain("Remove browser annotation 2");
  });

  it("is read-only when no removal handler is supplied", () => {
    const markup = renderToStaticMarkup(
      <BrowserAnnotationStrip annotations={[makeAnnotation(1), makeAnnotation(2)]} />,
    );

    expect(markup).not.toContain("Remove browser annotation");
  });
});
