import { describe, expect, it } from "vitest";

import {
  isSidechatThread,
  isStandaloneSidechatThread,
  sidechatContextMatchesGitHubItem,
} from "./sidechatThread";

const context = {
  kind: "github-item",
  itemKind: "issue",
  repository: "Octo/Repo",
  number: 7,
  url: "https://github.com/octo/repo/issues/7",
} as const;

describe("sidechat identity", () => {
  it("treats forked and standalone sidechats as sidechats, and nothing else", () => {
    expect(isSidechatThread({ sidechatSourceThreadId: "source" })).toBe(true);
    expect(isSidechatThread({ sidechatContext: context })).toBe(true);
    expect(isSidechatThread({ sidechatSourceThreadId: null, sidechatContext: null })).toBe(false);
    expect(isSidechatThread({})).toBe(false);
  });

  it("calls only a source-less sidechat standalone", () => {
    expect(isStandaloneSidechatThread({ sidechatContext: context })).toBe(true);
    expect(
      isStandaloneSidechatThread({ sidechatSourceThreadId: "source", sidechatContext: context }),
    ).toBe(false);
    expect(isStandaloneSidechatThread({ sidechatSourceThreadId: "source" })).toBe(false);
  });

  it("matches a GitHub item by repository (any case) and number", () => {
    expect(sidechatContextMatchesGitHubItem(context, { repository: "octo/repo", number: 7 })).toBe(
      true,
    );
    expect(sidechatContextMatchesGitHubItem(context, { repository: "octo/repo", number: 8 })).toBe(
      false,
    );
    expect(sidechatContextMatchesGitHubItem(null, { repository: "octo/repo", number: 7 })).toBe(
      false,
    );
  });
});
