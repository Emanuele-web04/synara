// FILE: FileEntryIcon.test.tsx
// Purpose: Guards colored file/folder glyph rendering in editor-style file lists.
// Layer: Component rendering tests
// Depends on: FileEntryIcon and React server rendering.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FileEntryIcon } from "./FileEntryIcon";

describe("FileEntryIcon", () => {
  it("tints known file types with their icon color", () => {
    const markup = renderToStaticMarkup(
      <FileEntryIcon pathValue="src/EditorWorkspaceView.tsx" kind="file" />,
    );

    expect(markup).toContain("text-[#61dafb]");
  });

  it("renders folders with the neutral folder color", () => {
    const markup = renderToStaticMarkup(
      <FileEntryIcon pathValue="src/components" kind="directory" />,
    );

    expect(markup).toContain("text-muted-foreground");
  });
});
