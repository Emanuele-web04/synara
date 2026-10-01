import { describe, expect, it } from "vitest";

import { ThreadId } from "@synara/contracts";

import {
  composerDraftHasUnsentContent,
  composerThreadDraftIsPending,
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

  it("reveals a draft after leaving its chat and hides it on return without clearing it", () => {
    const a = ThreadId.makeUnsafe("a");
    const b = ThreadId.makeUnsafe("b");
    const empty = createEmptyThreadDraft();
    const state = {
      draftsByThreadId: {
        [a]: { ...empty, prompt: "half-written" },
        [b]: { ...empty, prompt: "another draft" },
      },
    };

    expect(selectThreadIdsWithPendingDraft(state, a)).toEqual(["b"]);
    expect(selectThreadIdsWithPendingDraft(state, b)).toEqual(["a"]);
    expect(selectThreadIdsWithPendingDraft(state, null)).toEqual(["a", "b"]);
    expect(selectThreadIdsWithPendingDraft(state, a)).toEqual(["b"]);
    expect(state.draftsByThreadId[a]?.prompt).toBe("half-written");
  });
});
