// FILE: useGitHubInboxSidechat.ts
// Purpose: The inbox's Ask: a standalone side chat about the selected pull request or issue,
//          docked beside the detail so the user never leaves the page. Owns the dock's side chat
//          pane (it follows the selection), reuses an item's live side chat before creating one,
//          seeds a new one with the item's context card, and wires the side chat shortcut,
//          Escape, and the expired notice's "Start new" to the same flow.
// Layer: GitHub inbox orchestration hook
// Exports: useGitHubInboxSidechat

import type { ProjectId, ThreadId } from "@synara/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import { useAppSettings } from "~/appSettings";
import { createGitHubItemContextDraft } from "~/components/chat/environment/environmentPullRequest.logic";
import { useSidechatShortcut } from "~/components/chat/useSidechatShortcut";
import {
  githubItemCardSourceFromIssue,
  githubItemCardSourceFromPullRequest,
  githubItemSidechatContext,
  type GitHubItemAgentTarget,
} from "~/components/pullRequest/githubItemAgentContext";
import { focusPullRequestRow } from "~/components/pullRequest/pullRequestFocus";
import { toastManager } from "~/components/ui/toast";
import {
  resolvePreferredComposerModelSelection,
  useComposerDraftStore,
} from "~/composerDraftStore";
import { addChatPullRequestContext } from "~/lib/chatReferences";
import { githubIssueDetailQueryOptions } from "~/lib/githubInboxQueryOptions";
import { pullRequestDetailQueryOptions } from "~/lib/pullRequestReactQuery";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { createStandaloneSidechat } from "~/lib/sidechatCreation";
import { registerSidechatCreator } from "~/lib/sidechatCreatorRegistry";
import { promoteThreadCreate } from "~/lib/threadCreatePromotion";
import { readNativeApi } from "~/nativeApi";
import { selectRightDockState, useRightDockStore } from "~/rightDockStore";
import { GITHUB_INBOX_DOCK_HOST_ID } from "~/rightDockStore.logic";
import { useStore } from "~/store";
import { createSidechatSummariesForGitHubItemSelector } from "~/storeSelectors";
import type { SidebarThreadSummary } from "~/types";
import type { GitHubInboxSelection } from "./githubInbox.logic";

const EMPTY_SIDECHATS: readonly SidebarThreadSummary[] = [];
const selectNoSidechats = () => EMPTY_SIDECHATS;

/**
 * Ask answers questions; it does not act. New side chats start in Ask for approval so nothing
 * an item's text suggests can change files or git without the user's say-so. The user can
 * raise it in the side chat's composer, where Auto is still downgraded if the model lacks it.
 */
const STANDALONE_SIDECHAT_RUNTIME_MODE = "approval-required" as const;

interface GitHubItemKey {
  projectId: ProjectId;
  repository: string;
  number: number;
}

function itemKey(item: GitHubItemKey): string {
  return `${item.projectId}\u0000${item.repository.toLowerCase()}\u0000${item.number}`;
}

function liveSidechatId(sidechats: readonly SidebarThreadSummary[]): ThreadId | null {
  return sidechats.find((thread) => !thread.sidechatExpiredAt)?.id ?? null;
}

function readItemSidechats(item: GitHubItemKey): readonly SidebarThreadSummary[] {
  return createSidechatSummariesForGitHubItemSelector(item)(useStore.getState());
}

function showSidechat(threadId: ThreadId): void {
  const store = useRightDockStore.getState();
  store.setSidechatPaneThread(GITHUB_INBOX_DOCK_HOST_ID, threadId);
  store.setDockOpen(GITHUB_INBOX_DOCK_HOST_ID, true);
}

export function useGitHubInboxSidechat(selection: GitHubInboxSelection | null) {
  const queryClient = useQueryClient();
  const { settings } = useAppSettings();
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const dockState = useRightDockStore(
    useMemo(() => selectRightDockState(GITHUB_INBOX_DOCK_HOST_ID), []),
  );
  const projectId = selection?.projectId ?? null;
  const repository = selection?.repository ?? null;
  const number = selection?.number ?? null;
  const selectedKey =
    projectId !== null && repository !== null && number !== null
      ? itemKey({ projectId, repository, number })
      : null;
  const selectItemSidechats = useMemo(
    () =>
      projectId !== null && repository !== null && number !== null
        ? createSidechatSummariesForGitHubItemSelector({ projectId, repository, number })
        : selectNoSidechats,
    [projectId, repository, number],
  );
  const itemSidechats = useStore(selectItemSidechats);
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const creatingKeys = useRef(new Set<string>());

  // The side chat pane follows the selection: the item's latest side chat (live or expired,
  // so an expired one still shows its notice), or none, which leaves an open dock on its
  // "Ask" launcher. Only a selection change moves it: a side chat created for this item
  // points the pane at itself before it reaches the thread list.
  useEffect(() => {
    if (!threadsHydrated) return;
    const latest = selectItemSidechats(useStore.getState())[0]?.id ?? null;
    useRightDockStore.getState().setSidechatPaneThread(GITHUB_INBOX_DOCK_HOST_ID, latest);
  }, [selectItemSidechats, threadsHydrated]);

  const shortcutConfig = useQuery(serverConfigQueryOptions());
  const { focusSidechat } = useSidechatShortcut({
    threadId: GITHUB_INBOX_DOCK_HOST_ID,
    enabled: selection !== null,
    keybindings: shortcutConfig.data?.keybindings ?? [],
    sidechats: itemSidechats,
    // Called on a key press, after this render has defined it.
    createSidechat: () => createForSelection(),
    revealSidechat: () => undefined,
    onHidden: () => {
      if (selection) focusPullRequestRow(document, selection);
    },
  });

  const createForTarget = (target: GitHubItemAgentTarget): Promise<void> => {
    const key = itemKey({
      projectId: target.projectId,
      repository: target.source.repository,
      number: target.source.number,
    });
    if (creatingKeys.current.has(key)) return Promise.resolve();
    const api = readNativeApi();
    if (!api) {
      toastManager.add({ type: "error", title: "Could not start a side chat" });
      return Promise.resolve();
    }
    creatingKeys.current.add(key);
    setPendingKeys(new Set(creatingKeys.current));
    const project = useStore.getState().projects.find((entry) => entry.id === target.projectId);
    const draftStore = useComposerDraftStore.getState();
    // The same precedence a new chat uses: the last-used model, then the project's default.
    const modelSelection = resolvePreferredComposerModelSelection({
      draft: {
        modelSelectionByProvider: draftStore.stickyModelSelectionByProvider,
        activeProvider: draftStore.stickyActiveProvider,
      },
      threadModelSelection: null,
      projectModelSelection: project?.defaultModelSelection ?? null,
      defaultProvider: settings.defaultProvider,
    });
    return createStandaloneSidechat({
      api,
      projectId: target.projectId,
      context: githubItemSidechatContext(target.source),
      itemTitle: target.source.title,
      modelSelection,
      runtimeMode: STANDALONE_SIDECHAT_RUNTIME_MODE,
      dispatchCreate: (command) => promoteThreadCreate(command, api),
      openSidechat: (threadId) => {
        // Seed the card before the pane's composer mounts; the user writes the question.
        addChatPullRequestContext(
          threadId,
          createGitHubItemContextDraft(target.source, { checkedOut: false }),
        );
        showSidechat(threadId);
        focusSidechat(threadId);
      },
      syncServerShellSnapshot: (snapshot) => useStore.getState().syncServerShellSnapshot(snapshot),
    })
      .then((result) => {
        if (result.snapshotError) {
          toastManager.add({
            type: "warning",
            title: "Side chat is still syncing",
            description: "It will appear as soon as the thread list refreshes.",
          });
        }
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not start a side chat",
          description:
            error instanceof Error
              ? error.message
              : "An error occurred while creating the side chat.",
        });
      })
      .finally(() => {
        creatingKeys.current.delete(key);
        setPendingKeys(new Set(creatingKeys.current));
      });
  };

  /** Ask from a detail panel: reopen the item's live side chat, or start one seeded with it. */
  const ask = (target: GitHubItemAgentTarget) => {
    const existing = liveSidechatId(
      readItemSidechats({
        projectId: target.projectId,
        repository: target.source.repository,
        number: target.source.number,
      }),
    );
    if (existing) {
      showSidechat(existing);
      focusSidechat(existing);
      return;
    }
    void createForTarget(target);
  };

  // The shortcut, the dock launcher, and the expired notice act on the selected item without
  // its panel, so they read its detail from the query cache the panel filled (or fetch it).
  const createForSelection = (): Promise<void> => {
    if (!selection) return Promise.resolve();
    const input = {
      projectId: selection.projectId,
      repository: selection.repository,
      number: selection.number,
    };
    const loadSource =
      selection.kind === "issue"
        ? queryClient
            .ensureQueryData(githubIssueDetailQueryOptions(input))
            .then(githubItemCardSourceFromIssue)
        : queryClient
            .ensureQueryData(pullRequestDetailQueryOptions(input))
            .then(githubItemCardSourceFromPullRequest);
    return loadSource.then(
      (source) => createForTarget({ projectId: selection.projectId, source }),
      (error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not start a side chat",
          description: error instanceof Error ? error.message : "The item could not be loaded.",
        });
      },
    );
  };

  // "Start new" on an expired side chat: the inbox is its host, so it registers the
  // replacement under the side chat's own id (a forked one uses its source thread's).
  const shownSidechatId =
    dockState.panes.find((pane) => pane.kind === "sidechat")?.threadId ?? null;
  const createForSelectionRef = useRef(createForSelection);
  useEffect(() => {
    createForSelectionRef.current = createForSelection;
  });
  useEffect(() => {
    if (!shownSidechatId || selectedKey === null) return;
    return registerSidechatCreator(shownSidechatId, () => createForSelectionRef.current());
  }, [selectedKey, shownSidechatId]);

  return {
    dockState,
    ask,
    /** Ask about the selected item from outside its panel (the dock's launcher). */
    askSelected: () => {
      const existing = liveSidechatId(itemSidechats);
      if (existing) {
        showSidechat(existing);
        focusSidechat(existing);
        return;
      }
      void createForSelection();
    },
    askPending: selectedKey !== null && pendingKeys.has(selectedKey),
  };
}
