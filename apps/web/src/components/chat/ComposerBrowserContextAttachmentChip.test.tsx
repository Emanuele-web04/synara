import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ComposerBrowserContextAttachmentChip } from "./ComposerBrowserContextAttachmentChip";
import { buildExpandedBrowserContextPreview } from "./ExpandedImagePreview";

describe("ComposerBrowserContextAttachmentChip", () => {
  it("renders inspect-only browser selections as the same compact live editor context card", () => {
    const context = {
      id: "browser-context-1",
      type: "browser-context" as const,
      source: "browser-selection" as const,
      promptBlock: [
        "<browser-selection>",
        "source: browser-selection",
        "selectedElement:",
        "  selector: div.page > main > nav.nav",
        "</browser-selection>",
      ].join("\n"),
      title: "Northstar Studio",
      url: "http://localhost:8891/browser-editor-demo/index.html",
      strokeCount: 0,
      textCount: 0,
      selectedSelector: "div.page > main > nav.nav",
    };

    const markup = renderToStaticMarkup(
      <ComposerBrowserContextAttachmentChip
        context={context}
        contexts={[context]}
        onExpandContext={() => {}}
        onRemoveContext={() => {}}
      />,
    );

    expect(markup).toContain("Live Editor Context");
    expect(markup).not.toContain("Selection context");
    expect(markup).not.toContain("div.page &gt; main &gt; nav.nav");
    expect(markup).toContain("tabler-icon-eye");
    expect(markup).toContain("Preview live editor context Northstar Studio");
    expect(markup).toContain("Remove live editor context Northstar Studio");

    const expandedPreview = buildExpandedBrowserContextPreview([context], context.id);
    expect(expandedPreview?.images[0]?.name).toBe("Live Editor Context");
    expect(expandedPreview?.images[0]?.browserAnnotation?.selectedSelector).toBe(
      "div.page > main > nav.nav",
    );
  });
});
