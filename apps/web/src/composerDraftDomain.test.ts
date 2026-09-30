import { describe, expect, it } from "vitest";

import {
  composerDraftHasUnsentContent,
  createEmptyThreadDraft,
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
