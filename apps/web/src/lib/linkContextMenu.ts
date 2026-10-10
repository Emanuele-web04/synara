// FILE: linkContextMenu.ts
// Purpose: Right-click menu shared by chat links (assistant markdown links and
//          link chips): open in the built-in review view or in-app browser, open in
//          the external browser, or copy the URL. Also resolves where a plain click on
//          a GitHub pull request or issue link goes, from the user's setting.
// Layer: Web UI helpers
// Exports: ChatLinkActionsContext, parseGitHubItemUrl, resolveGitHubItemLinkOpener,
//          resolveGitHubItemClickOpener, showLinkContextMenu

import { isValidGitHubRepositoryNameWithOwner } from "@synara/shared/githubRepository";
import { createContext } from "react";

import type { GitHubLinkOpenTarget } from "~/appSettings";
import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { openExternalLink } from "~/lib/linkChips";
import { readNativeApi } from "~/nativeApi";

/** In-app destinations a chat surface offers for the links it renders. */
export interface ChatLinkActions {
  /** Opens the URL in the thread's in-app browser panel. */
  readonly openInBrowserPanel: (url: string) => void;
  /** Opens a GitHub pull-request or issue URL in the built-in review view. */
  readonly openGitHubItem?: ((url: string) => void) | undefined;
  /** The user's setting for a plain click on a pull request or issue link. */
  readonly githubLinkOpenTarget?: GitHubLinkOpenTarget | undefined;
}

export interface GitHubItemUrl {
  readonly kind: "pullRequest" | "issue";
  readonly repository: string;
  readonly number: number;
}

/** The pull request or issue a GitHub web URL points at, or null for any other URL. */
export function parseGitHubItemUrl(url: string | null | undefined): GitHubItemUrl | null {
  const match =
    /^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/(pull|issues)\/(\d+)(?:[/?#].*)?$/i.exec(
      url?.trim() ?? "",
    );
  const repository = match?.[1] ?? "";
  const number = Number(match?.[3]);
  if (!isValidGitHubRepositoryNameWithOwner(repository) || !Number.isInteger(number)) return null;
  return {
    kind: match?.[2]?.toLowerCase() === "issues" ? "issue" : "pullRequest",
    repository,
    number,
  };
}

/** Provided by the chat view; absent on surfaces without an in-app browser or PR pane. */
export const ChatLinkActionsContext = createContext<ChatLinkActions | null>(null);

/** The built-in review opener for `url`, or undefined when it is not a pull request or issue. */
export function resolveGitHubItemLinkOpener(
  url: string,
  actions: ChatLinkActions | null,
): ((url: string) => void) | undefined {
  return actions?.openGitHubItem && parseGitHubItemUrl(url) ? actions.openGitHubItem : undefined;
}

/** Where a plain click on `url` goes under the user's setting, or undefined when it should
 *  stay external (not a pull request or issue, or the setting says external). */
export function resolveGitHubItemClickOpener(
  url: string,
  actions: ChatLinkActions | null,
): ((url: string) => void) | undefined {
  if (!actions || !parseGitHubItemUrl(url)) return undefined;
  const target = actions.githubLinkOpenTarget ?? "app";
  if (target === "external") return undefined;
  if (target === "browser") return actions.openInBrowserPanel;
  return actions.openGitHubItem;
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
  const openGitHubItem = resolveGitHubItemLinkOpener(url, actions);
  const clicked = await api.contextMenu.show(
    [
      ...(openGitHubItem
        ? [
            {
              id: "open-github-item" as const,
              label: parseGitHubItemUrl(url)?.kind === "issue" ? "Open issue" : "Open pull request",
            },
          ]
        : []),
      ...(actions ? [{ id: "open-in-browser" as const, label: "Open in browser" }] : []),
      { id: "open-external" as const, label: "Open in external browser" },
      { id: "copy-link" as const, label: "Copy link", separatorBefore: true },
    ],
    input.position,
  );
  if (clicked === "open-github-item") {
    openGitHubItem?.(url);
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
