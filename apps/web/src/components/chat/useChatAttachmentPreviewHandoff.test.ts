// @vitest-environment happy-dom
// Pins the attachment-preview-handoff TTL map extracted from ChatView:
// registering preview URLs for a message makes them retrievable, the TTL timeout
// drops them, clear-all empties the map, and unmount cancels pending timers
// without a post-unmount setState. Asserts observable map state, not call counts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { MessageId } from "@t3tools/contracts";

import {
  ATTACHMENT_PREVIEW_HANDOFF_TTL_MS,
  useChatAttachmentPreviewHandoff,
} from "./useChatAttachmentPreviewHandoff";

const MESSAGE_A = MessageId.makeUnsafe("message-a");
const MESSAGE_B = MessageId.makeUnsafe("message-b");

describe("useChatAttachmentPreviewHandoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers preview URLs for a message id and makes them retrievable", () => {
    const { result } = renderHook(() => useChatAttachmentPreviewHandoff());

    act(() => {
      result.current.handoffAttachmentPreviews(MESSAGE_A, ["blob:a-1", "blob:a-2"]);
    });

    expect(result.current.attachmentPreviewHandoffByMessageId[MESSAGE_A]).toEqual([
      "blob:a-1",
      "blob:a-2",
    ]);
  });

  it("ignores empty preview lists", () => {
    const { result } = renderHook(() => useChatAttachmentPreviewHandoff());

    act(() => {
      result.current.handoffAttachmentPreviews(MESSAGE_A, []);
    });

    expect(result.current.attachmentPreviewHandoffByMessageId).toEqual({});
  });

  it("clears a message's previews after the TTL elapses", () => {
    const { result } = renderHook(() => useChatAttachmentPreviewHandoff());

    act(() => {
      result.current.handoffAttachmentPreviews(MESSAGE_A, ["blob:a-1"]);
    });
    expect(result.current.attachmentPreviewHandoffByMessageId[MESSAGE_A]).toEqual(["blob:a-1"]);

    act(() => {
      vi.advanceTimersByTime(ATTACHMENT_PREVIEW_HANDOFF_TTL_MS);
    });

    expect(result.current.attachmentPreviewHandoffByMessageId[MESSAGE_A]).toBeUndefined();
  });

  it("keeps previews registered until the full TTL has elapsed", () => {
    const { result } = renderHook(() => useChatAttachmentPreviewHandoff());

    act(() => {
      result.current.handoffAttachmentPreviews(MESSAGE_A, ["blob:a-1"]);
    });

    act(() => {
      vi.advanceTimersByTime(ATTACHMENT_PREVIEW_HANDOFF_TTL_MS - 1);
    });

    expect(result.current.attachmentPreviewHandoffByMessageId[MESSAGE_A]).toEqual(["blob:a-1"]);
  });

  it("re-handing off the same message replaces its preview URLs", () => {
    const { result } = renderHook(() => useChatAttachmentPreviewHandoff());

    act(() => {
      result.current.handoffAttachmentPreviews(MESSAGE_A, ["blob:a-1"]);
    });
    act(() => {
      result.current.handoffAttachmentPreviews(MESSAGE_A, ["blob:a-2"]);
    });

    expect(result.current.attachmentPreviewHandoffByMessageId[MESSAGE_A]).toEqual(["blob:a-2"]);

    act(() => {
      vi.advanceTimersByTime(ATTACHMENT_PREVIEW_HANDOFF_TTL_MS);
    });
    expect(result.current.attachmentPreviewHandoffByMessageId[MESSAGE_A]).toBeUndefined();
  });

  it("clearAttachmentPreviewHandoffs empties the map immediately", () => {
    const { result } = renderHook(() => useChatAttachmentPreviewHandoff());

    act(() => {
      result.current.handoffAttachmentPreviews(MESSAGE_A, ["blob:a-1"]);
      result.current.handoffAttachmentPreviews(MESSAGE_B, ["blob:b-1"]);
    });
    expect(Object.keys(result.current.attachmentPreviewHandoffByMessageId)).toHaveLength(2);

    act(() => {
      result.current.clearAttachmentPreviewHandoffs();
    });

    expect(result.current.attachmentPreviewHandoffByMessageId).toEqual({});
  });

  it("clear cancels pending TTL timers so they never fire afterwards", () => {
    const { result } = renderHook(() => useChatAttachmentPreviewHandoff());

    act(() => {
      result.current.handoffAttachmentPreviews(MESSAGE_A, ["blob:a-1"]);
    });
    act(() => {
      result.current.clearAttachmentPreviewHandoffs();
    });

    // No pending timer should remain; advancing past the TTL is a no-op and must not throw.
    expect(() => {
      act(() => {
        vi.advanceTimersByTime(ATTACHMENT_PREVIEW_HANDOFF_TTL_MS * 2);
      });
    }).not.toThrow();
    expect(result.current.attachmentPreviewHandoffByMessageId).toEqual({});
  });

  it("unmount cancels pending timers with no post-unmount setState", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result, unmount } = renderHook(() => useChatAttachmentPreviewHandoff());

    act(() => {
      result.current.handoffAttachmentPreviews(MESSAGE_A, ["blob:a-1"]);
    });

    unmount();

    act(() => {
      vi.advanceTimersByTime(ATTACHMENT_PREVIEW_HANDOFF_TTL_MS * 2);
    });

    // React warns on setState after unmount via console.error; assert none was emitted.
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
