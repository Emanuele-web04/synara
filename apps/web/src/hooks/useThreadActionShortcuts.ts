import type { ResolvedKeybindingsConfig, ThreadId } from "@synara/contracts";
import { useEffect } from "react";

import { MODEL_PICKER_POPUP_ATTRIBUTE } from "../components/chat/ComposerModelPicker.logic";
import { resolveShortcutCommand } from "../keybindings";
import { hasOpenDismissibleOverlay } from "../lib/editableEventTarget";
import { isTerminalFocused } from "../lib/terminalFocus";
import { resolveSplitViewFocusedPaneThreadId, type SplitView } from "../splitViewStore";
import { selectThreadTerminalState, type ThreadTerminalState } from "../terminalStateStore";
import type { SidebarThreadSummary } from "../types";

export interface ThreadActionShortcutsInput {
  readonly enabled: boolean;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly routeThreadId: ThreadId | null;
  readonly activeSplitView: SplitView | null | undefined;
  readonly threadById: Readonly<Record<string, SidebarThreadSummary>>;
  readonly terminalStateByThreadId: Record<ThreadId, ThreadTerminalState>;
  readonly canSnooze: (thread: SidebarThreadSummary) => boolean;
  readonly onArchive: (threadId: ThreadId) => Promise<void>;
  readonly onSnooze: (threadId: ThreadId) => void;
  readonly onMarkUnread: (threadId: ThreadId) => void;
}

/** Dispatch to Sidebar's menu actions; an empty focused split pane has no active chat. */
export function useThreadActionShortcuts({
  enabled,
  keybindings,
  routeThreadId,
  activeSplitView,
  threadById,
  terminalStateByThreadId,
  canSnooze,
  onArchive,
  onSnooze,
  onMarkUnread,
}: ThreadActionShortcutsInput): void {
  const threadId = activeSplitView
    ? resolveSplitViewFocusedPaneThreadId(activeSplitView)
    : routeThreadId;
  const thread = threadId ? threadById[threadId] : undefined;
  const terminalState = threadId
    ? selectThreadTerminalState(terminalStateByThreadId, threadId)
    : null;
  const terminalOpen = terminalState?.terminalOpen ?? false;
  const terminalWorkspaceOpen = terminalState?.presentationMode === "workspace" && terminalOpen;
  useEffect(() => {
    if (!enabled || !thread || thread.archivedAt != null) return;
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          composerFocus:
            event.target instanceof Element &&
            event.target.closest(
              `[data-chat-composer-form="true"], [${MODEL_PICKER_POPUP_ATTRIBUTE}]`,
            ) !== null,
          terminalFocus: isTerminalFocused(),
          terminalOpen,
          terminalWorkspaceOpen,
          terminalWorkspaceTerminalOnly: terminalState?.workspaceLayout === "terminal-only",
          terminalWorkspaceTerminalTabActive:
            terminalWorkspaceOpen &&
            (terminalState?.workspaceLayout === "terminal-only" ||
              terminalState?.workspaceActiveTab === "terminal"),
          terminalWorkspaceChatTabActive:
            terminalWorkspaceOpen &&
            terminalState?.workspaceLayout === "both" &&
            terminalState?.workspaceActiveTab === "chat",
        },
      });
      if (
        command !== "thread.archive" &&
        command !== "thread.snooze" &&
        command !== "thread.markUnread"
      )
        return;
      if (hasOpenDismissibleOverlay()) return;
      if (command === "thread.archive" && thread.parentThreadId) return;
      if (command === "thread.snooze" && !canSnooze(thread)) return;
      event.preventDefault();
      event.stopPropagation();
      if (command === "thread.archive") void onArchive(thread.id);
      else if (command === "thread.snooze") onSnooze(thread.id);
      else onMarkUnread(thread.id);
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [
    enabled,
    thread,
    keybindings,
    terminalOpen,
    terminalWorkspaceOpen,
    terminalState,
    canSnooze,
    onArchive,
    onSnooze,
    onMarkUnread,
  ]);
}
