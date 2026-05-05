// FILE: chatThreadRoute.logic.ts
// Purpose: Keep route-level chat panel state transitions and fallbacks deterministic.
// Layer: Route UI logic helpers.
// Exports: thread title fallback, deep-link bootstrap replay handling, and panel toggle helpers.

import type { ThreadId, TurnId } from "@t3tools/contracts";

import type { ChatRightPanel, DiffRouteSearch } from "../diffRouteSearch";

export interface ChatPanelStateSnapshot {
  panel: ChatRightPanel | null;
  diffTurnId: TurnId | null;
  diffFilePath: string | null;
}

export interface ChatPanelStatePatch {
  panel?: ChatRightPanel | null;
  diffTurnId?: TurnId | null;
  diffFilePath?: string | null;
}

export interface RoutePanelBootstrapResult {
  nextAppliedSearchKey: string | null;
  panelPatch: ChatPanelStatePatch | null;
}

export interface SplitPaneMaximizeDecision {
  splitViewIdToRemove: string;
  threadId: ThreadId;
  panelState: ChatPanelStateSnapshot | null;
}

export type SplitPaneCloseDecision =
  | {
      kind: "single-thread";
      threadId: ThreadId;
      splitViewIdToRemove: string;
    }
  | {
      kind: "split-thread";
      threadId: ThreadId;
      splitViewId: string;
    }
  | {
      kind: "new-chat";
    };

export function resolveThreadPickerTitle(title: string | null): string {
  return title || "New chat";
}

function createRoutePanelSearchKey(input: {
  scopeId: string;
  search: DiffRouteSearch;
}): string | null {
  const { scopeId, search } = input;
  if (
    search.panel === undefined &&
    search.diff === undefined &&
    search.diffTurnId === undefined &&
    search.diffFilePath === undefined
  ) {
    return null;
  }

  return JSON.stringify({
    scopeId,
    panel: search.panel ?? (search.diff ? "diff" : null),
    diffTurnId: search.diffTurnId ?? null,
    diffFilePath: search.diffFilePath ?? null,
  });
}

export function resolveRoutePanelBootstrap(input: {
  scopeId: string;
  search: DiffRouteSearch;
  lastAppliedSearchKey: string | null;
}): RoutePanelBootstrapResult {
  const nextAppliedSearchKey = createRoutePanelSearchKey({
    scopeId: input.scopeId,
    search: input.search,
  });

  if (nextAppliedSearchKey === null) {
    return {
      nextAppliedSearchKey: null,
      panelPatch: null,
    };
  }

  if (input.lastAppliedSearchKey === nextAppliedSearchKey) {
    return {
      nextAppliedSearchKey,
      panelPatch: null,
    };
  }

  return {
    nextAppliedSearchKey,
    panelPatch: {
      panel: input.search.panel ?? (input.search.diff ? "diff" : null),
      diffTurnId: input.search.diffTurnId ?? null,
      diffFilePath: input.search.diffFilePath ?? null,
    },
  };
}

export function resolveToggledChatPanelPatch(
  previousState: ChatPanelStateSnapshot,
  panel: ChatRightPanel,
): ChatPanelStatePatch {
  return {
    panel: previousState.panel === panel ? null : panel,
    diffTurnId: previousState.diffTurnId,
    diffFilePath: previousState.diffFilePath,
  };
}

// Expanding a split pane exits split mode entirely; the selected chat becomes the single surface.
export function resolveSplitPaneMaximizeDecision(input: {
  splitViewId: string;
  focusedThreadId: ThreadId | null | undefined;
  focusedPanelState: ChatPanelStateSnapshot | null | undefined;
}): SplitPaneMaximizeDecision | null {
  if (!input.focusedThreadId) {
    return null;
  }

  return {
    splitViewIdToRemove: input.splitViewId,
    threadId: input.focusedThreadId,
    panelState: input.focusedPanelState ?? null,
  };
}

// Closing a sidechat is a return-to-source action; generic pane closes can still fall back normally.
export function resolveSplitPaneCloseDecision(input: {
  splitViewId: string;
  sourceThreadId: ThreadId;
  closingThreadId: ThreadId | null | undefined;
  closingSidechatSourceThreadId: ThreadId | null | undefined;
  nextFocusedThreadId: ThreadId | null | undefined;
  nextLeafCount: number;
}): SplitPaneCloseDecision {
  if (input.closingSidechatSourceThreadId) {
    return {
      kind: "single-thread",
      threadId: input.closingSidechatSourceThreadId,
      splitViewIdToRemove: input.splitViewId,
    };
  }

  if (input.closingThreadId && input.closingThreadId !== input.sourceThreadId) {
    return {
      kind: "single-thread",
      threadId: input.sourceThreadId,
      splitViewIdToRemove: input.splitViewId,
    };
  }

  if (input.nextFocusedThreadId) {
    if (input.nextLeafCount <= 1) {
      return {
        kind: "single-thread",
        threadId: input.nextFocusedThreadId,
        splitViewIdToRemove: input.splitViewId,
      };
    }
    return {
      kind: "split-thread",
      threadId: input.nextFocusedThreadId,
      splitViewId: input.splitViewId,
    };
  }

  return { kind: "new-chat" };
}
