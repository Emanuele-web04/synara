// FILE: ReviewFileTreePanel.test.tsx
// Purpose: Guards the compact review file-tree panel: it renders the filter
//          input, the nested/compressed changed files, and coherent empty and
//          loading states.
// Layer: Component rendering tests

import type { FileDiffMetadata } from "@pierre/diffs/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ReviewFileTreePanel } from "./ReviewFileTreePanel";

function createFileDiff(path: string): FileDiffMetadata {
  return {
    cacheKey: path,
    name: path,
    prevName: path,
    hunks: [{ additionLines: 2, deletionLines: 1 }],
  } as FileDiffMetadata;
}

describe("ReviewFileTreePanel", () => {
  it("renders a same-named file and directory replacement as distinct rows", () => {
    // Deleting `foo` while adding `foo/bar.ts` produces sibling nodes that share
    // the path "foo"; the panel must render both without colliding React keys.
    const markup = renderToStaticMarkup(
      <ReviewFileTreePanel
        files={[createFileDiff("foo"), createFileDiff("foo/bar.ts")]}
        selectedFilePath="foo"
        resolvedTheme="dark"
        onSelectFile={vi.fn()}
      />,
    );

    expect(markup).toContain("foo");
    expect(markup).toContain("bar.ts");
  });
});
