// FILE: linkContextMenu.ts
// Purpose: Right-click menu shared by chat links (assistant markdown links and
//          link chips): open in the thread's PR pane or in-app browser, open in
//          the external browser, or copy the URL.
// Layer: Web UI helpers
// Exports: ChatLinkActionsContext, resolvePullRequestLinkOpener, showLinkContextMenu

import { parseGitHubRepositoryNameWithOwnerFromPullRequestUrl } from "@synara/shared/githubRepository";
import { createContext } from "react";

import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { openExternalLink } from "~/lib/linkChips";
import { readNativeApi } from "~/nativeApi";

/** In-app destinations a chat surface offers for the links it renders. */
export interface ChatLinkActions {
  /** Opens the URL in the thread's in-app browser panel. */
  readonly openInBrowserPanel: (url: string) => void;
  /** Opens a GitHub pull-request URL in the thread's pull-request pane. */
  readonly openPullRequest?: ((url: string) => void) | undefined;
}

/** Provided by the chat view; absent on surfaces without an in-app browser or PR pane. */
export const ChatLinkActionsContext = createContext<ChatLinkActions | null>(null);

/** The in-app pull-request opener for `url`, or undefined when a plain click should stay external. */
export function resolvePullRequestLinkOpener(
  url: string,
  actions: ChatLinkActions | null,
): ((url: string) => void) | undefined {
  return actions?.openPullRequest && parseGitHubRepositoryNameWithOwnerFromPullRequestUrl(url)
    ? actions.openPullRequest
    : undefined;
}

// Falls back to a DOM menu outside the desktop app.
export async function showLinkContextMenu(input: {
  url: string;
  position: { x: number; y: number };
  actions: ChatLinkActions | null;
}): Promise<void> {
  const api = readNativeApi();
  if (!api) {
    return;
  }
  const { url, actions } = input;
  const openPullRequest = resolvePullRequestLinkOpener(url, actions);
  const clicked = await api.contextMenu.show(
    [
      ...(openPullRequest
        ? [{ id: "open-pull-request" as const, label: "Open pull request" }]
        : []),
      ...(actions ? [{ id: "open-in-browser" as const, label: "Open in browser" }] : []),
      { id: "open-external" as const, label: "Open in external browser" },
      { id: "copy-link" as const, label: "Copy link", separatorBefore: true },
    ],
    input.position,
  );
  if (clicked === "open-pull-request") {
    openPullRequest?.(url);
    return;
  }
  if (clicked === "open-in-browser") {
    actions?.openInBrowserPanel(url);
    return;
  }
  if (clicked === "open-external") {
    openExternalLink(url);
    return;
  }
  if (clicked === "copy-link") {
    await copyTextToClipboard(url);
  }
}
