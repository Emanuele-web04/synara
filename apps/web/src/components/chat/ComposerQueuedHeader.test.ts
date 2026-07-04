// FILE: ComposerQueuedHeader.test.ts
// Purpose: Locks the queued composer preview down to compact, inline markdown.
// Layer: Web chat composer tests
// Depends on: ComposerQueuedHeader preview sanitizer

import { describe, expect, it } from "vitest";

import {
  compactQueuedComposerPreviewMarkdown,
  formatQueuedComposerWaitTimer,
} from "./ComposerQueuedHeader";

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

describe("formatQueuedComposerWaitTimer", () => {
  it("formats the queued wait time from creation to the current check", () => {
    expect(
      formatQueuedComposerWaitTimer("2026-07-04T12:00:00.000Z", "2026-07-04T12:00:07.000Z"),
    ).toBe("7s");
    expect(
      formatQueuedComposerWaitTimer("2026-07-04T12:00:00.000Z", "2026-07-04T12:01:03.000Z"),
    ).toBe("1m 3s");
  });

  it("falls back for invalid queued timestamps", () => {
    expect(formatQueuedComposerWaitTimer("not-a-date", "2026-07-04T12:00:00.000Z")).toBe("0s");
  });
});
