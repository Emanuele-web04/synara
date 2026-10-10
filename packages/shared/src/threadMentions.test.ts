import { describe, expect, it } from "vitest";

import {
  isThreadMentionPath,
  threadIdFromThreadMentionPath,
  threadMentionPathForThreadId,
} from "./threadMentions";

describe("thread mention paths", () => {
  it("round-trips a thread id through the mention path", () => {
    const path = threadMentionPathForThreadId("thread-123");
    expect(path).toBe("thread://thread-123");
    expect(isThreadMentionPath(path)).toBe(true);
    expect(threadIdFromThreadMentionPath(path)).toBe("thread-123");
  });

  it("rejects non-thread paths and empty ids", () => {
    expect(isThreadMentionPath("/workspace/file.ts")).toBe(false);
    expect(threadIdFromThreadMentionPath("plugin://linear")).toBeNull();
    expect(threadIdFromThreadMentionPath("thread://")).toBeNull();
    expect(threadIdFromThreadMentionPath("thread://   ")).toBeNull();
  });
});
