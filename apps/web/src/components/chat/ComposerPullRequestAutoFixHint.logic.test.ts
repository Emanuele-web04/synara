import { ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  shouldShowPullRequestAutoFixHint,
  type PullRequestAutoFixHintInput,
} from "./ComposerPullRequestAutoFixHint.logic";

const visible: PullRequestAutoFixHintInput = {
  featureOn: true,
  isServerThread: true,
  pullRequestState: "open",
  dismissed: false,
  isWorking: false,
  autoFixState: null,
};

describe("shouldShowPullRequestAutoFixHint", () => {
  it("shows beside an open PR while the chat is idle and auto-fix is off", () => {
    expect(shouldShowPullRequestAutoFixHint(visible)).toBe(true);
  });

  it("stays hidden without an open PR, on a draft, mid-turn, once dismissed, or when unavailable", () => {
    const hidden: Partial<PullRequestAutoFixHintInput>[] = [
      { pullRequestState: null },
      { pullRequestState: "merged" },
      { isServerThread: false },
      { isWorking: true },
      { dismissed: true },
      { featureOn: false },
    ];
    for (const override of hidden) {
      expect(shouldShowPullRequestAutoFixHint({ ...visible, ...override })).toBe(false);
    }
  });

  it("stays hidden while the state loads and once auto-fix is on", () => {
    expect(shouldShowPullRequestAutoFixHint({ ...visible, autoFixState: undefined })).toBe(false);
    expect(
      shouldShowPullRequestAutoFixHint({
        ...visible,
        autoFixState: {
          threadId: ThreadId.makeUnsafe("thread"),
          pullRequestUrl: "https://github.com/o/r/pull/1",
          status: "watching",
          pauseReason: null,
          attempts: 0,
          lastHandledHeadSha: null,
          updatedAt: "2026-10-03T10:00:00.000Z",
        },
      }),
    ).toBe(false);
  });
});
