import { describe, expect, it } from "vitest";

import { ThreadId } from "@synara/contracts";

import {
  COMPOSER_DRAFT_PREVIEW_MAX_CHARS,
  composerDraftHasUnsentContent,
  composerThreadDraftIsPending,
  composerThreadDraftPreviewText,
  createEmptyThreadDraft,
  selectThreadIdsWithPendingDraft,
  type ComposerThreadDraftState,
} from "./composerDraftDomain";

describe("composerDraftHasUnsentContent", () => {
  it("counts collapsed pasted text and pull-request cards, which dispatch does not carry", () => {
    const empty = createEmptyThreadDraft();
    expect(composerDraftHasUnsentContent(empty)).toBe(false);
    expect(composerDraftHasUnsentContent({ ...empty, prompt: "  " })).toBe(false);
    expect(composerDraftHasUnsentContent({ ...empty, prompt: "Ship it" })).toBe(true);
    expect(
      composerDraftHasUnsentContent({
        ...empty,
        pastedTexts: [{}] as unknown as ComposerThreadDraftState["pastedTexts"],
      }),
    ).toBe(true);
    expect(
      composerDraftHasUnsentContent({
        ...empty,
        pullRequestContexts: [{}] as unknown as ComposerThreadDraftState["pullRequestContexts"],
      }),
    ).toBe(true);
  });
});

describe("composerThreadDraftIsPending", () => {
  it("counts work-item-only drafts and saved prompt-history drafts as pending", () => {
    const draft = createEmptyThreadDraft();
    draft.workItems = [
      {
        id: "work-item-7",
        kind: "issue",
        number: 7,
        title: "Preserve attached issues",
        state: "open",
        url: "https://github.com/owner/repo/issues/7",
        bodyExcerpt: "Reproduce the bug",
        createdAt: "2026-10-10T00:00:00Z",
        updatedAt: "2026-10-10T00:00:00Z",
      },
    ];
    expect(composerDraftHasUnsentContent(draft)).toBe(true);
    expect(composerThreadDraftIsPending(draft)).toBe(true);
    expect(
      composerThreadDraftIsPending({
        ...createEmptyThreadDraft(),
        promptHistorySavedDraft: draft,
      }),
    ).toBe(true);
  });

  it("ignores model-only drafts and reads the saved draft while browsing prompt history", () => {
    const empty = createEmptyThreadDraft();
    expect(composerThreadDraftIsPending({ ...empty, runtimeMode: "full-access" })).toBe(false);
    expect(composerThreadDraftIsPending({ ...empty, prompt: "half-written" })).toBe(true);
    const { promptHistorySavedDraft: _unused, ...savedFields } = empty;
    expect(
      composerThreadDraftIsPending({
        ...empty,
        prompt: "recalled history entry",
        promptHistorySavedDraft: { ...savedFields, prompt: "" },
      }),
    ).toBe(false);
  });

  it("lists pending thread ids in a stable sorted order", () => {
    const empty = createEmptyThreadDraft();
    expect(
      selectThreadIdsWithPendingDraft({
        draftsByThreadId: {
          [ThreadId.makeUnsafe("b")]: { ...empty, prompt: "two" },
          [ThreadId.makeUnsafe("c")]: { ...empty, runtimeMode: "full-access" },
          [ThreadId.makeUnsafe("a")]: { ...empty, prompt: "one" },
        },
      }),
    ).toEqual(["a", "b"]);
  });
});

describe("composerThreadDraftPreviewText", () => {
  it("collapses whitespace, drops inline placeholders, and caps long drafts", () => {
    const empty = createEmptyThreadDraft();
    expect(composerThreadDraftPreviewText(undefined)).toBeNull();
    expect(composerThreadDraftPreviewText({ ...empty, prompt: " \n " })).toBeNull();
    expect(
      composerThreadDraftPreviewText({ ...empty, prompt: "Fix\n\n the \uFFFC sidebar  " }),
    ).toBe("Fix the sidebar");
    const preview = composerThreadDraftPreviewText({ ...empty, prompt: "a".repeat(1000) });
    expect(preview).toHaveLength(COMPOSER_DRAFT_PREVIEW_MAX_CHARS + 1);
    expect(preview?.endsWith("…")).toBe(true);
  });

  it("previews the saved draft while prompt history is browsed", () => {
    const empty = createEmptyThreadDraft();
    const { promptHistorySavedDraft: _unused, ...savedFields } = empty;
    expect(
      composerThreadDraftPreviewText({
        ...empty,
        prompt: "recalled history entry",
        promptHistorySavedDraft: { ...savedFields, prompt: "my real draft" },
      }),
    ).toBe("my real draft");
  });
});
