import type { ResolvedKeybindingsConfig, ThreadId } from "@synara/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { requestComposerFocus } from "../../composerFocusRequestStore";
import { resolveShortcutCommand } from "../../keybindings";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { selectRightDockState, useRightDockStore } from "../../rightDockStore";
import { scheduleDeferredChatMount } from "./deferredChatMount";
import {
  type RightDockHostId,
  type RightDockPane,
  resolveActivePane,
} from "../../rightDockStore.logic";

function hasOpenDismissibleOverlay(): boolean {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-slot="context-menu-popup"], [data-testid="composer-extras-panel"]',
    ),
  ).some(
    (element) =>
      !element.closest('[inert], [aria-hidden="true"]') && element.getClientRects().length > 0,
  );
}

// The dock host owns the shortcut: the single-chat surface for its thread's sidechats, the
// GitHub inbox for the selected item's. Embedded ChatViews must not each create or toggle a
// sidechat in response to the same key event.
//
// Returns `focusSidechat`, which focuses a sidechat's composer once the dock shows it, for
// hosts that open one outside the shortcut (the inbox's Ask button).
export function useSidechatShortcut({
  threadId,
  enabled,
  keybindings,
  sidechats,
  createSidechat,
  revealSidechat,
  onHidden,
}: {
  /** The dock host: a thread id, or the GitHub inbox's dock id. */
  threadId: RightDockHostId;
  enabled: boolean;
  keybindings: ResolvedKeybindingsConfig;
  /** This host's sidechats, newest first. */
  sidechats: readonly { id: ThreadId; sidechatExpiredAt?: string | null }[];
  createSidechat: () => Promise<void>;
  revealSidechat: () => void;
  /** Returns focus to the host after the shortcut or Escape hides the sidechat. */
  onHidden: () => void;
}) {
  const dockState = useRightDockStore(useMemo(() => selectRightDockState(threadId), [threadId]));
  const [focusRequest, setFocusRequest] = useState<{
    sourceId: RightDockHostId;
    targetId: ThreadId;
  } | null>(null);
  const creatingFor = useRef(new Set<RightDockHostId>());
  const currentSource = useRef<RightDockHostId | null>(threadId);
  useEffect(() => {
    currentSource.current = threadId;
    return () => {
      currentSource.current = null;
    };
  }, [threadId]);

  useEffect(() => {
    if (!focusRequest || focusRequest.sourceId !== threadId || !enabled) return;
    const activePane = resolveActivePane(dockState);
    if (!dockState.open || activePane?.threadId !== focusRequest.targetId) return;
    // A reopened dock may remount its composer and restore the saved Lexical
    // draft. Request focus after that commit rather than on the hidden editor.
    return scheduleDeferredChatMount(window, () => {
      requestComposerFocus(focusRequest.targetId);
      setFocusRequest(null);
    });
  }, [dockState, focusRequest, threadId, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const hideSidechat = () => {
      useRightDockStore.getState().setDockOpen(threadId, false);
      setFocusRequest(null);
      onHidden();
    };
    const toggleSidechat = () => {
      const store = useRightDockStore.getState();
      const state = selectRightDockState(threadId)(store);
      const activePane = resolveActivePane(state);
      if (state.open && activePane?.kind === "sidechat") {
        hideSidechat();
        return;
      }
      if (creatingFor.current.has(threadId)) return;
      revealSidechat();
      const latestLiveSidechatId =
        sidechats.find((thread) => !thread.sidechatExpiredAt)?.id ?? null;
      const isReusablePane = (pane: RightDockPane) =>
        pane.kind === "sidechat" &&
        pane.threadId !== null &&
        !sidechats.some((thread) => thread.id === pane.threadId && thread.sidechatExpiredAt);
      const existingPane =
        (activePane && isReusablePane(activePane) ? activePane : null) ??
        state.panes.find(
          (pane) => pane.kind === "sidechat" && pane.threadId === latestLiveSidechatId,
        ) ??
        state.panes.findLast(isReusablePane);
      const targetId = existingPane?.threadId ?? latestLiveSidechatId;
      if (targetId) {
        if (existingPane) store.setActivePane(threadId, existingPane.id);
        else store.openPane(threadId, { kind: "sidechat", threadId: targetId });
        setFocusRequest({ sourceId: threadId, targetId });
        return;
      }
      creatingFor.current.add(threadId);
      void createSidechat().finally(() => {
        creatingFor.current.delete(threadId);
        if (currentSource.current !== threadId) return;
        const nextPane = resolveActivePane(
          selectRightDockState(threadId)(useRightDockStore.getState()),
        );
        if (nextPane?.kind === "sidechat" && nextPane.threadId) {
          setFocusRequest({ sourceId: threadId, targetId: nextPane.threadId });
        }
      });
    };
    // Editors can consume Escape before it bubbles. Check overlays first, then
    // handle it alongside the configured chord in capture phase.
    const capture = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        hasOpenDismissibleOverlay()
      )
        return;
      if (
        event.key === "Escape" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        !isTerminalFocused()
      ) {
        const state = selectRightDockState(threadId)(useRightDockStore.getState());
        if (state.open && resolveActivePane(state)?.kind === "sidechat") {
          event.preventDefault();
          event.stopPropagation();
          hideSidechat();
        }
        return;
      }
      if (
        resolveShortcutCommand(event, keybindings, {
          context: { terminalFocus: isTerminalFocused() },
        }) !== "sidechat.toggle"
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      toggleSidechat();
    };
    window.addEventListener("keydown", capture, { capture: true });
    return () => window.removeEventListener("keydown", capture, { capture: true });
  }, [enabled, threadId, keybindings, sidechats, createSidechat, revealSidechat, onHidden]);

  return {
    focusSidechat: (targetId: ThreadId) => setFocusRequest({ sourceId: threadId, targetId }),
  };
}
