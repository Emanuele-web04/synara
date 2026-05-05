import { ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  resolveRoutePanelBootstrap,
  resolveSplitPaneCloseDecision,
  resolveSplitPaneMaximizeDecision,
  resolveThreadPickerTitle,
  resolveToggledChatPanelPatch,
} from "./-chatThreadRoute.logic";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");
const SIDECHAT_THREAD_ID = ThreadId.makeUnsafe("thread-sidechat");
const OTHER_THREAD_ID = ThreadId.makeUnsafe("thread-2");
const TURN_ID = TurnId.makeUnsafe("turn-1");
const OTHER_TURN_ID = TurnId.makeUnsafe("turn-2");

describe("resolveThreadPickerTitle", () => {
  it("falls back to a stable untitled label", () => {
    expect(resolveThreadPickerTitle(null)).toBe("New chat");
    expect(resolveThreadPickerTitle("")).toBe("New chat");
  });

  it("preserves non-empty thread titles", () => {
    expect(resolveThreadPickerTitle("Bug bash")).toBe("Bug bash");
  });
});

describe("resolveRoutePanelBootstrap", () => {
  it("hydrates diff deep links exactly once per scope and search payload", () => {
    const first = resolveRoutePanelBootstrap({
      scopeId: "thread-1",
      search: {
        panel: "diff",
        diff: "1",
        diffTurnId: TURN_ID,
        diffFilePath: "src/chat.tsx",
      },
      lastAppliedSearchKey: null,
    });

    expect(first.panelPatch).toEqual({
      panel: "diff",
      diffTurnId: TURN_ID,
      diffFilePath: "src/chat.tsx",
    });
    expect(first.nextAppliedSearchKey).toEqual(expect.any(String));

    const duplicate = resolveRoutePanelBootstrap({
      scopeId: "thread-1",
      search: {
        panel: "diff",
        diff: "1",
        diffTurnId: TURN_ID,
        diffFilePath: "src/chat.tsx",
      },
      lastAppliedSearchKey: first.nextAppliedSearchKey,
    });

    expect(duplicate).toEqual({
      nextAppliedSearchKey: first.nextAppliedSearchKey,
      panelPatch: null,
    });
  });

  it("resets once route search params are stripped so the same deep link can replay", () => {
    const first = resolveRoutePanelBootstrap({
      scopeId: "thread-1",
      search: {
        panel: "diff",
        diff: "1",
        diffTurnId: TURN_ID,
        diffFilePath: "src/chat.tsx",
      },
      lastAppliedSearchKey: null,
    });

    const cleared = resolveRoutePanelBootstrap({
      scopeId: "thread-1",
      search: {},
      lastAppliedSearchKey: first.nextAppliedSearchKey,
    });

    expect(cleared).toEqual({
      nextAppliedSearchKey: null,
      panelPatch: null,
    });

    const replay = resolveRoutePanelBootstrap({
      scopeId: "thread-1",
      search: {
        panel: "diff",
        diff: "1",
        diffTurnId: TURN_ID,
        diffFilePath: "src/chat.tsx",
      },
      lastAppliedSearchKey: cleared.nextAppliedSearchKey,
    });

    expect(replay.panelPatch).toEqual({
      panel: "diff",
      diffTurnId: TURN_ID,
      diffFilePath: "src/chat.tsx",
    });
  });

  it("reapplies the same deep link when the mounted thread scope changes", () => {
    const first = resolveRoutePanelBootstrap({
      scopeId: "thread-1",
      search: {
        panel: "diff",
        diff: "1",
        diffTurnId: TURN_ID,
      },
      lastAppliedSearchKey: null,
    });

    const nextThread = resolveRoutePanelBootstrap({
      scopeId: "thread-2",
      search: {
        panel: "diff",
        diff: "1",
        diffTurnId: TURN_ID,
      },
      lastAppliedSearchKey: first.nextAppliedSearchKey,
    });

    expect(nextThread.panelPatch).toEqual({
      panel: "diff",
      diffTurnId: TURN_ID,
      diffFilePath: null,
    });
  });
});

describe("resolveToggledChatPanelPatch", () => {
  it("preserves the last diff target when switching from diff to browser", () => {
    expect(
      resolveToggledChatPanelPatch(
        {
          panel: "diff",
          diffTurnId: TURN_ID,
          diffFilePath: "src/chat.tsx",
        },
        "browser",
      ),
    ).toEqual({
      panel: "browser",
      diffTurnId: TURN_ID,
      diffFilePath: "src/chat.tsx",
    });
  });

  it("keeps diff context even when closing the browser panel", () => {
    expect(
      resolveToggledChatPanelPatch(
        {
          panel: "browser",
          diffTurnId: OTHER_TURN_ID,
          diffFilePath: "src/browser.tsx",
        },
        "browser",
      ),
    ).toEqual({
      panel: null,
      diffTurnId: OTHER_TURN_ID,
      diffFilePath: "src/browser.tsx",
    });
  });
});

describe("resolveSplitPaneMaximizeDecision", () => {
  it("targets the focused thread and preserves its panel state for single-chat navigation", () => {
    expect(
      resolveSplitPaneMaximizeDecision({
        splitViewId: "split-1",
        focusedThreadId: THREAD_ID,
        focusedPanelState: {
          panel: "diff",
          diffTurnId: TURN_ID,
          diffFilePath: "src/chat.tsx",
        },
      }),
    ).toEqual({
      splitViewIdToRemove: "split-1",
      threadId: THREAD_ID,
      panelState: {
        panel: "diff",
        diffTurnId: TURN_ID,
        diffFilePath: "src/chat.tsx",
      },
    });
  });

  it("does not invent a target when the focused pane is empty", () => {
    expect(
      resolveSplitPaneMaximizeDecision({
        splitViewId: "split-1",
        focusedThreadId: null,
        focusedPanelState: null,
      }),
    ).toBeNull();
  });
});

describe("resolveSplitPaneCloseDecision", () => {
  it("returns to the original thread when closing a sidechat pane", () => {
    expect(
      resolveSplitPaneCloseDecision({
        splitViewId: "split-sidechat",
        sourceThreadId: THREAD_ID,
        closingThreadId: SIDECHAT_THREAD_ID,
        closingSidechatSourceThreadId: THREAD_ID,
        nextFocusedThreadId: SIDECHAT_THREAD_ID,
        nextLeafCount: 1,
      }),
    ).toEqual({
      kind: "single-thread",
      threadId: THREAD_ID,
      splitViewIdToRemove: "split-sidechat",
    });
  });

  it("collapses a generic one-pane remainder to single chat", () => {
    expect(
      resolveSplitPaneCloseDecision({
        splitViewId: "split-1",
        sourceThreadId: THREAD_ID,
        closingThreadId: THREAD_ID,
        closingSidechatSourceThreadId: null,
        nextFocusedThreadId: OTHER_THREAD_ID,
        nextLeafCount: 1,
      }),
    ).toEqual({
      kind: "single-thread",
      threadId: OTHER_THREAD_ID,
      splitViewIdToRemove: "split-1",
    });
  });

  it("keeps a multi-pane split when there are still multiple leaves", () => {
    expect(
      resolveSplitPaneCloseDecision({
        splitViewId: "split-1",
        sourceThreadId: THREAD_ID,
        closingThreadId: THREAD_ID,
        closingSidechatSourceThreadId: null,
        nextFocusedThreadId: OTHER_THREAD_ID,
        nextLeafCount: 2,
      }),
    ).toEqual({
      kind: "split-thread",
      threadId: OTHER_THREAD_ID,
      splitViewId: "split-1",
    });
  });
});
