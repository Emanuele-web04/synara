import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BrowserAnnotationChip } from "./BrowserAnnotationChip";

describe("BrowserAnnotationChip", () => {
  it("renders a stable number, comment label, page title, and individual remove action", () => {
    const markup = renderToStaticMarkup(
      <BrowserAnnotationChip
        annotation={{
          id: "annotation-1",
          ordinal: 7,
          tabId: "tab-1",
          source: { url: "https://example.test/settings", pageTitle: "Settings" },
          selector: "#save",
          tagName: "button",
          role: "button",
          name: "Save",
          text: "Save",
          fingerprint: "button|save",
          comment: "Move this action",
          capturedAt: "2026-07-23T10:00:00.000Z",
        }}
        onRemove={() => {}}
      />,
    );

    expect(markup).toContain("#7");
    expect(markup).toContain("Move this action");
    expect(markup).toContain("Settings");
    expect(markup).toContain("Remove browser annotation 7");
  });

  it("falls back to the accessible name when the comment is empty", () => {
    const markup = renderToStaticMarkup(
      <BrowserAnnotationChip
        annotation={{
          id: "annotation-1",
          ordinal: 1,
          tabId: "tab-1",
          source: { url: "https://example.test", pageTitle: "" },
          selector: "#save",
          tagName: "button",
          role: "button",
          name: "Save changes",
          text: null,
          fingerprint: "button|save",
          comment: "",
          capturedAt: "2026-07-23T10:00:00.000Z",
        }}
      />,
    );

    expect(markup).toContain("Save changes");
    expect(markup).toContain("https://example.test");
  });
});
