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
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { getProviderInstanceOptions, getProviderStartOptions, useAppSettings } from "~/appSettings";
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
import { randomUUID } from "~/lib/utils";
import { addChatPullRequestContext } from "~/lib/chatReferences";
import type { ModelSelection } from "@synara/contracts";
import { githubIssueDetailQueryOptions } from "~/lib/githubInboxQueryOptions";
import { pullRequestDetailQueryOptions } from "~/lib/pullRequestReactQuery";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { createStandaloneSidechat, resolveSidechatRuntimeMode } from "~/lib/sidechatCreation";
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
  return `${item.repository.toLowerCase()}\u0000${item.number}`;
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

/**
 * Queues the typed question as the side chat's turn, with the item's context card attached. The
 * chat mounted in the dock drains the queue through its normal send path (as `startSelectionChat`
 * does for a new chat), so model, approvals, and recovery behave like any first send.
 */
function enqueueItemQuestion(input: {
  threadId: ThreadId;
  question: string;
  target: GitHubItemAgentTarget;
  modelSelection: ModelSelection;
  providerOptionsForDispatch: ReturnType<typeof getProviderStartOptions>;
}): void {
  useComposerDraftStore.getState().enqueueQueuedTurn(input.threadId, {
    id: randomUUID(),
    kind: "chat",
    createdAt: new Date().toISOString(),
    previewText: input.question,
    prompt: input.question,
    assistantSelections: [],
    images: [],
    files: [],
    browserAnnotations: [],
    terminalContexts: [],
    fileComments: [],
    pastedTexts: [],
    pullRequestContexts: [createGitHubItemContextDraft(input.target.source, { checkedOut: false })],
    skills: [],
    mentions: [],
    selectedProvider: input.modelSelection.provider,
    selectedModel: input.modelSelection.model,
    selectedPromptEffort: null,
    modelSelection: input.modelSelection,
    ...(input.providerOptionsForDispatch
      ? { providerOptionsForDispatch: input.providerOptionsForDispatch }
      : {}),
    runtimeMode: resolveSidechatRuntimeMode(STANDALONE_SIDECHAT_RUNTIME_MODE, input.modelSelection),
    interactionMode: "default",
    envMode: "local",
  });
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
  const selectedKeyRef = useRef(selectedKey);
  useLayoutEffect(() => {
    selectedKeyRef.current = selectedKey;
    return () => {
      selectedKeyRef.current = null;
    };
  }, [selectedKey]);
  const selectItemSidechats = useMemo(
    () =>
      projectId !== null && repository !== null && number !== null
        ? createSidechatSummariesForGitHubItemSelector({ repository, number })
        : selectNoSidechats,
    [projectId, repository, number],
  );
  const itemSidechats = useStore(selectItemSidechats);
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const creatingKeys = useRef(new Set<string>());

  // The side chat pane follows the selection: the item's latest side chat (live or expired,
  // so an expired one still shows its notice). An item with none closes the dock, so the page
  // shows its floating composer instead of an empty pane; asking reopens it. Only a selection
  // change moves it: a side chat created for this item points the pane at itself before it
  // reaches the thread list.
  useEffect(() => {
    if (!threadsHydrated) return;
    const latest = selectItemSidechats(useStore.getState())[0]?.id ?? null;
    const dock = useRightDockStore.getState();
    dock.setSidechatPaneThread(GITHUB_INBOX_DOCK_HOST_ID, latest);
    if (latest === null) dock.setDockOpen(GITHUB_INBOX_DOCK_HOST_ID, false);
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

  // The same precedence a new chat uses: the last-used model, then the project's default.
  const defaultModelSelectionFor = (projectId: ProjectId): ModelSelection => {
    const project = useStore.getState().projects.find((entry) => entry.id === projectId);
    const draftStore = useComposerDraftStore.getState();
    return resolvePreferredComposerModelSelection({
      draft: {
        modelSelectionByProvider: draftStore.stickyModelSelectionByProvider,
        activeProvider: draftStore.stickyActiveProvider,
      },
      threadModelSelection: null,
      projectModelSelection: project?.defaultModelSelection ?? null,
      defaultProvider: settings.defaultProvider,
      resolveProviderForInstanceId: (instanceId) =>
        getProviderInstanceOptions(settings).find((instance) => instance.instanceId === instanceId)
          ?.provider,
    });
  };

  const createForTarget = (target: GitHubItemAgentTarget, question?: string): Promise<void> => {
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
    const modelSelection = defaultModelSelectionFor(target.projectId);
    return createStandaloneSidechat({
      api,
      projectId: target.projectId,
      context: githubItemSidechatContext(target.source),
      itemTitle: target.source.title,
      modelSelection,
      runtimeMode: STANDALONE_SIDECHAT_RUNTIME_MODE,
      dispatchCreate: (command) => promoteThreadCreate(command, api),
      openSidechat: (threadId) => {
        if (question) {
          // The card travels with the queued turn; the user already wrote the question.
          enqueueItemQuestion({
            threadId,
            question,
            target,
            modelSelection,
            providerOptionsForDispatch: getProviderStartOptions(
              settings,
              modelSelection.instanceId,
            ),
          });
        } else {
          // Seed the card before the pane's composer mounts; the user writes the question.
          addChatPullRequestContext(
            threadId,
            createGitHubItemContextDraft(target.source, { checkedOut: false }),
          );
        }
        // Creation may finish after the user selected another item or left this page.
        // Keep the created thread and its question, without replacing the current item's dock.
        if (selectedKeyRef.current !== selectedKey) return;
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

  /**
   * Ask from the page's composer: the question goes to the item's live side chat, or starts a new
   * one with it as the first turn.
   */
  const askQuestion = (target: GitHubItemAgentTarget, question: string) => {
    const text = question.trim();
    if (!text) return;
    const summaries = readItemSidechats({
      projectId: target.projectId,
      repository: target.source.repository,
      number: target.source.number,
    });
    const existing = liveSidechatId(summaries);
    if (existing) {
      const modelSelection =
        summaries.find((thread) => thread.id === existing)?.modelSelection ??
        defaultModelSelectionFor(target.projectId);
      enqueueItemQuestion({
        threadId: existing,
        question: text,
        target,
        modelSelection,
        providerOptionsForDispatch: getProviderStartOptions(settings, modelSelection.instanceId),
      });
      showSidechat(existing);
      return;
    }
    void createForTarget(target, text);
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
    askQuestion,
    /** The item's side chats, newest first. */
    sidechats: itemSidechats,
    /** Focus an existing side chat of the item in the dock. */
    openSidechat: (threadId: ThreadId) => {
      showSidechat(threadId);
      focusSidechat(threadId);
    },
    /** A new side chat about the selected item, even when one already exists. */
    newSidechat: () => void createForSelection(),
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
