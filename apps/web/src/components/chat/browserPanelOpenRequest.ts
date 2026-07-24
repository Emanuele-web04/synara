import type { ThreadId } from "@synara/contracts";

import { collectLeaves, findLeafPaneById } from "../../splitView.logic";
import { resolveSplitViewPaneIdForThread, type PaneId, type SplitView } from "../../splitViewStore";

interface SingleBrowserPanelOpenRequestInput {
  readonly currentThreadId: ThreadId;
  readonly requestedThreadId: ThreadId;
  readonly requestImmediateBrowserHydration: () => void;
  readonly openBrowserPane: (threadId: ThreadId) => void;
  readonly navigateToThread: (threadId: ThreadId, panel: "browser") => void;
}

export function routeSingleBrowserPanelOpenRequest(
  input: SingleBrowserPanelOpenRequestInput,
): void {
  // Explicit agent requests must not wait for rAF, which Electron may suspend
  // while the app is backgrounded.
  input.requestImmediateBrowserHydration();

  if (input.requestedThreadId === input.currentThreadId) {
    input.openBrowserPane(input.currentThreadId);
    return;
  }

  // Seed the destination dock before navigating so its first render can attach
  // the browser that the desktop host already opened.
  input.openBrowserPane(input.requestedThreadId);
  input.navigateToThread(input.requestedThreadId, "browser");
}

interface SplitBrowserPanelOpenRequestInput {
  readonly splitView: SplitView;
  readonly requestedThreadId: ThreadId;
  readonly focusPane: (paneId: PaneId) => void;
  readonly replacePaneThread: (paneId: PaneId, threadId: ThreadId) => void;
  readonly openBrowserPanel: (paneId: PaneId) => void;
  readonly navigateToThread: (threadId: ThreadId) => void;
}

export function routeSplitBrowserPanelOpenRequest(input: SplitBrowserPanelOpenRequestInput): void {
  const existingPaneId = resolveSplitViewPaneIdForThread(input.splitView, input.requestedThreadId);
  const focusedPaneId = findLeafPaneById(input.splitView.root, input.splitView.focusedPaneId)?.id;
  const targetPaneId =
    existingPaneId ?? focusedPaneId ?? collectLeaves(input.splitView.root)[0]?.id;
  if (!targetPaneId) {
    return;
  }

  input.focusPane(targetPaneId);
  if (!existingPaneId) {
    input.replacePaneThread(targetPaneId, input.requestedThreadId);
  }
  input.openBrowserPanel(targetPaneId);
  input.navigateToThread(input.requestedThreadId);
}
