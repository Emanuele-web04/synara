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
  it("renders the filter input and the nested, compressed changed files", () => {
    const markup = renderToStaticMarkup(
      <ReviewFileTreePanel
        files={[
          createFileDiff("apps/server/src/codex.ts"),
          createFileDiff("apps/web/src/ChatView.tsx"),
        ]}
        selectedFilePath="apps/web/src/ChatView.tsx"
        resolvedTheme="dark"
        onSelectFile={vi.fn()}
      />,
    );

    expect(markup).toContain('placeholder="Filter files..."');
    // Top-level directory plus the compressed single-child chains.
    expect(markup).toContain("apps");
    expect(markup).toContain("server/src");
    expect(markup).toContain("web/src");
    // Leaf file names render inside the expanded tree.
    expect(markup).toContain("codex.ts");
    expect(markup).toContain("ChatView.tsx");
  });

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

  it("shows a coherent empty state when there are no files", () => {
    const markup = renderToStaticMarkup(
      <ReviewFileTreePanel
        files={[]}
        selectedFilePath={null}
        resolvedTheme="light"
        onSelectFile={vi.fn()}
      />,
    );

    expect(markup).toContain("No files in this diff.");
  });

  it("shows a loading state while the diff is loading with no files yet", () => {
    const markup = renderToStaticMarkup(
      <ReviewFileTreePanel
        files={[]}
        isLoading
        selectedFilePath={null}
        resolvedTheme="light"
        onSelectFile={vi.fn()}
      />,
    );

    expect(markup).toContain("Loading changed files...");
    expect(markup).not.toContain("No files in this diff.");
  });
});
