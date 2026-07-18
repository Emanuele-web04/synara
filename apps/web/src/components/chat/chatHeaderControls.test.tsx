// FILE: chatHeaderControls.test.tsx
// Purpose: Covers shared tab-chip markup for stable rename and close hit targets.
// Layer: Component unit tests
// Depends on: React server rendering and SurfaceTabChip.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { shouldCloseSurfaceTabFromAuxClick, SurfaceTabChip } from "./chatHeaderControls";

describe("SurfaceTabChip", () => {
  it("only treats a middle click on a closable tab as a close gesture", () => {
    expect(shouldCloseSurfaceTabFromAuxClick(1, true)).toBe(true);
    expect(shouldCloseSurfaceTabFromAuxClick(0, true)).toBe(false);
    expect(shouldCloseSurfaceTabFromAuxClick(2, true)).toBe(false);
    expect(shouldCloseSurfaceTabFromAuxClick(1, false)).toBe(false);
  });

  it("keeps the identity glyph separate from a trailing close control", () => {
    const markup = renderToStaticMarkup(
      <SurfaceTabChip
        icon={<span data-testid="identity">AI</span>}
        label="Seller Catalog"
        closeLabel="Close Seller Catalog"
        closePlacement="trailing"
        renameLabel="Rename Seller Catalog"
        onSelect={() => undefined}
        onClose={() => undefined}
        onRename={() => undefined}
      />,
    );

    expect(markup).toContain('<span data-testid="identity">AI</span>');
    expect(markup).toContain('aria-label="Rename Seller Catalog"');
    expect(markup).toContain('aria-label="Close Seller Catalog"');
    expect(markup.indexOf('aria-label="Rename Seller Catalog"')).toBeLessThan(
      markup.indexOf('aria-label="Close Seller Catalog"'),
    );
    expect(markup.match(/<button/g)).toHaveLength(3);
  });
});
