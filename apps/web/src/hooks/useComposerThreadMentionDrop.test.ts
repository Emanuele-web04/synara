import { ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { isThreadDragTransfer, readThreadDragPayload, THREAD_DRAG_MIME } from "~/lib/threadDrag";
import { canDropThreadMention } from "./useComposerThreadMentionDrop";

const CURRENT = ThreadId.makeUnsafe("thread-current");
const OTHER = ThreadId.makeUnsafe("thread-other");

describe("canDropThreadMention", () => {
  it("accepts another chat and an unknown drag source", () => {
    expect(
      canDropThreadMention({ disabled: false, currentThreadId: CURRENT, draggedThreadId: OTHER }),
    ).toBe(true);
    expect(
      canDropThreadMention({ disabled: false, currentThreadId: CURRENT, draggedThreadId: null }),
    ).toBe(true);
  });

  it("rejects the chat's own row and a disabled composer", () => {
    expect(
      canDropThreadMention({ disabled: false, currentThreadId: CURRENT, draggedThreadId: CURRENT }),
    ).toBe(false);
    expect(
      canDropThreadMention({ disabled: true, currentThreadId: CURRENT, draggedThreadId: OTHER }),
    ).toBe(false);
  });
});

describe("thread drag transfer", () => {
  it("detects the thread MIME and ignores file drags", () => {
    expect(isThreadDragTransfer({ types: [THREAD_DRAG_MIME] })).toBe(true);
    expect(isThreadDragTransfer({ types: ["Files"] })).toBe(false);
  });

  it("parses a valid payload and rejects malformed data", () => {
    expect(readThreadDragPayload({ getData: () => JSON.stringify({ threadId: OTHER }) })).toEqual({
      threadId: OTHER,
    });
    expect(readThreadDragPayload({ getData: () => "" })).toBeNull();
    expect(readThreadDragPayload({ getData: () => "{not json" })).toBeNull();
    expect(readThreadDragPayload({ getData: () => JSON.stringify({ threadId: 7 }) })).toBeNull();
  });
});
