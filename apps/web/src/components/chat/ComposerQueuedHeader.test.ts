// FILE: ComposerQueuedHeader.test.ts
// Purpose: Locks the queued composer preview down to compact, inline markdown.
// Layer: Web chat composer tests
// Depends on: ComposerQueuedHeader preview sanitizer

import { describe, expect, it } from "vitest";

import { compactQueuedComposerPreviewMarkdown } from "./ComposerQueuedHeader";

describe("compactQueuedComposerPreviewMarkdown", () => {
  it("keeps inline markdown while dropping block-only heading/list syntax", () => {
    expect(compactQueuedComposerPreviewMarkdown("# **Ship** `src/app.ts`")).toBe(
      "**Ship** `src/app.ts`",
    );
    expect(compactQueuedComposerPreviewMarkdown("- [x] Review `src/app.ts`")).toBe(
      "Review `src/app.ts`",
    );
  });

  it("uses one representative line for multiline prompts and fenced code", () => {
    expect(compactQueuedComposerPreviewMarkdown("\n\nFirst line\nSecond line")).toBe("First line");
    expect(compactQueuedComposerPreviewMarkdown("```ts\nconsole.log('wide')\n```")).toBe(
      "Code block",
    );
  });

  it("falls back for empty block prefixes", () => {
    expect(compactQueuedComposerPreviewMarkdown("")).toBe("Queued follow-up");
    expect(compactQueuedComposerPreviewMarkdown(">")).toBe("Queued follow-up");
  });
});
