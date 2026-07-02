// FILE: FileAttachmentChip.test.tsx
// Purpose: Guards composer file attachment chrome against warning and label regressions.
// Layer: Component rendering tests
// Depends on: FileAttachmentChip and React server rendering.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FileAttachmentChip } from "./FileAttachmentChip";

describe("FileAttachmentChip", () => {
  it("renders composer file cards without a draft warning by default", () => {
    const markup = renderToStaticMarkup(
      <FileAttachmentChip
        file={{
          type: "file",
          id: "calendar-file",
          name: "99247298-78c2-44ba-a1f6-721b11fb3a5a (1).ics",
          mimeType: "text/calendar",
          sizeBytes: 646,
        }}
        variant="card"
        onRemove={() => {}}
      />,
    );

    expect(markup).toContain("99247298-78c2-44ba-a1f6-721b11fb3a5a (1).ics");
    expect(markup).toContain("ICS");
    expect(markup).toContain("Remove 99247298-78c2-44ba-a1f6-721b11fb3a5a (1).ics");
    expect(markup).not.toContain("Draft attachment may not persist");
    // The card shows a type-aware glyph, never the generic source-code bracket.
    expect(markup).toContain("calendar-days");
    expect(markup).not.toContain("code-brackets");
  });

  it("derives the card glyph from the MIME type when the filename has no extension", () => {
    const markup = renderToStaticMarkup(
      <FileAttachmentChip
        file={{
          type: "file",
          id: "calendar-blob",
          name: "99247298-78c2-44ba-a1f6-721b11fb3a5a",
          mimeType: "text/calendar",
          sizeBytes: 646,
        }}
        variant="card"
        onRemove={() => {}}
      />,
    );

    expect(markup).toContain("ICS");
    expect(markup).toContain("calendar-days");
    expect(markup).not.toContain("code-brackets");
  });

  it("keeps sent-message pills compact with size metadata", () => {
    const markup = renderToStaticMarkup(
      <FileAttachmentChip
        file={{
          type: "file",
          id: "pdf-file",
          name: "invoice.pdf",
          mimeType: "application/pdf",
          sizeBytes: 2048,
        }}
      />,
    );

    expect(markup).toContain("invoice.pdf");
    expect(markup).toContain("2 KB");
    expect(markup).toContain("rounded-full");
    expect(markup).not.toContain("size-12");
  });

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
