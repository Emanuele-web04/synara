// FILE: FileAttachmentChip.test.tsx
// Purpose: Guards composer file attachment chrome against warning and label regressions.
// Layer: Component rendering tests
// Depends on: FileAttachmentChip and React server rendering.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FileAttachmentChip } from "./FileAttachmentChip";

describe("FileAttachmentChip", () => {
  it("uses MIME fallbacks without leaking long vendor types", () => {
    const markup = renderToStaticMarkup(
      <FileAttachmentChip
        file={{
          type: "file",
          id: "word-file",
          name: "proposal",
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          sizeBytes: 4096,
        }}
        variant="card"
      />,
    );

    expect(markup).toContain("DOCX");
    expect(markup).not.toContain("WORDPROCESSINGML");

    const legacyWordMarkup = renderToStaticMarkup(
      <FileAttachmentChip
        file={{
          type: "file",
          id: "legacy-word-file",
          name: "proposal",
          mimeType: "application/msword",
          sizeBytes: 4096,
        }}
        variant="card"
      />,
    );

    expect(legacyWordMarkup).toContain("DOC");
    expect(legacyWordMarkup).not.toContain("MSWORD");
  });

  it("still surfaces the draft warning when explicitly requested", () => {
    const markup = renderToStaticMarkup(
      <FileAttachmentChip
        file={{
          type: "file",
          id: "draft-file",
          name: "scratch.txt",
          mimeType: "text/plain",
          sizeBytes: 128,
        }}
        variant="card"
        nonPersisted
      />,
    );

    expect(markup).toContain("Draft attachment may not persist");
    expect(markup).toContain("scratch.txt");
    expect(markup).toContain("TXT");
  });
});
