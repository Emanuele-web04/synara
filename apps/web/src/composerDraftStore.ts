// FILE: composerDraftStore.ts
// Purpose: Public Zustand facade for composer drafts, model choices, attachments, and persistence.
// Exports: Stable composer draft API, hooks, and promotion helpers.

import {
  type ModelSelection,
  type ProjectId,
  type ProviderKind,
  type ThreadId,
} from "@synara/contracts";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { createComposerDraftStoreState } from "./composerDraftActions";
import {
  COMPOSER_DRAFT_STORAGE_KEY,
  COMPOSER_DRAFT_STORAGE_VERSION,
  selectComposerThreadDraft,
  type ComposerDraftStoreState,
  type ComposerThreadDraftState,
  type DraftThreadState,
} from "./composerDraftDomain";
import {
  deriveEffectiveComposerModelState,
  type EffectiveComposerModelState,
} from "./composerDraftModels";
import {
  migratePersistedComposerDraftStoreState,
  normalizeCurrentPersistedComposerDraftStoreState,
  partializeComposerDraftStoreState,
  toHydratedThreadDraft,
  type PersistedComposerDraftStoreState,
} from "./composerDraftPersistence";
import {
  createDeferredPersistStorage,
  createMemoryStorage,
  flushStorageBeforePageHide,
  type StateStorage,
} from "./lib/storage";

export {
  findSupersededComposerImageBlobAttachments,
  isComposerImageBlobReferenced,
} from "./composerDraftAttachments";
export {
  captureComposerPromptHistorySavedDraft,
  COMPOSER_DRAFT_STORAGE_KEY,
  COMPOSER_DRAFT_STORAGE_VERSION,
  PersistedComposerImageAttachment,
} from "./composerDraftDomain";
export type {
  ComposerAssistantSelectionAttachment,
  ComposerAttachmentPersistenceResult,
  ComposerDraftStoreState,
  ComposerFileAttachment,
  ComposerImageAttachment,
  ComposerPromptHistorySavedDraft,
  ComposerThreadDraftState,
  DraftThreadEnvMode,
  DraftThreadState,
  QueuedComposerChatTurn,
  QueuedComposerPlanFollowUp,
  QueuedComposerTurn,
  RestoredComposerSourceProposedPlan,
} from "./composerDraftDomain";
export type { BrowserAnnotationDraft } from "./lib/browserAnnotations";
export {
  deriveEffectiveComposerModelState,
  resolvePreferredComposerModelSelection,
} from "./composerDraftModels";
export type { EffectiveComposerModelState } from "./composerDraftModels";
export { partializeComposerDraftStoreState } from "./composerDraftPersistence";

const COMPOSER_PERSIST_DEBOUNCE_MS = 300;
const composerBaseStorage: StateStorage =
  typeof localStorage !== "undefined" ? localStorage : createMemoryStorage();
const composerPersistStorage = createDeferredPersistStorage<
  ComposerDraftStoreState,
  PersistedComposerDraftStoreState
>({
  getStorage: () => composerBaseStorage,
  partialize: partializeComposerDraftStoreState,
  debounceMs: COMPOSER_PERSIST_DEBOUNCE_MS,
});

// Flush pending composer draft writes before the page goes away so at most one
// debounce window of changes can be lost.
flushStorageBeforePageHide(() => composerPersistStorage.flush());

export const useComposerDraftStore = create<ComposerDraftStoreState>()(
  persist(
    createComposerDraftStoreState(() => composerPersistStorage.flush()),
    {
      name: COMPOSER_DRAFT_STORAGE_KEY,
      version: COMPOSER_DRAFT_STORAGE_VERSION,
      // Partialization is owned by deferred storage so serialization does not run
      // on each keystroke and instead happens once per 300ms flush window.
      storage: composerPersistStorage,
      migrate: migratePersistedComposerDraftStoreState,
      merge: (persistedState, currentState) => {
        const normalizedPersisted =
          normalizeCurrentPersistedComposerDraftStoreState(persistedState);
        const draftsByThreadId = Object.fromEntries(
          Object.entries(normalizedPersisted.draftsByThreadId).map(([threadId, draft]) => [
            threadId,
            toHydratedThreadDraft(threadId as ThreadId, draft),
          ]),
        );
        return {
          ...currentState,
          draftsByThreadId,
          draftThreadsByThreadId: normalizedPersisted.draftThreadsByThreadId,
          projectDraftThreadIdByProjectId: normalizedPersisted.projectDraftThreadIdByProjectId,
          stickyModelSelectionByProvider: normalizedPersisted.stickyModelSelectionByProvider ?? {},
          stickyActiveProvider: normalizedPersisted.stickyActiveProvider ?? null,
        };
      },
    },
  ),
);

export function useComposerThreadDraft(threadId: ThreadId): ComposerThreadDraftState {
  return useComposerDraftStore((state) => selectComposerThreadDraft(state, threadId));
}

export function useEffectiveComposerModelState(input: {
  threadId: ThreadId;
  selectedProvider: ProviderKind;
  threadModelSelection: ModelSelection | null | undefined;
  projectModelSelection: ModelSelection | null | undefined;
  customModelsByProvider: Record<ProviderKind, readonly string[]>;
  availableModelOptionsByProvider?: Partial<
    Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>>
  >;
}): EffectiveComposerModelState {
  const draft = useComposerThreadDraft(input.threadId);
  return deriveEffectiveComposerModelState({
    draft,
    selectedProvider: input.selectedProvider,
    threadModelSelection: input.threadModelSelection,
    projectModelSelection: input.projectModelSelection,
    customModelsByProvider: input.customModelsByProvider,
    ...(input.availableModelOptionsByProvider !== undefined
      ? { availableModelOptionsByProvider: input.availableModelOptionsByProvider }
      : {}),
  });
}

// How long a just-promoted thread stays route-protected after its draft record
// drops. The first started detail clears the draft and can land before the
// shell row — or a lagging shell snapshot can briefly rebuild `threadShellById`
// without the thread — leaving one render where neither slice knows it. The
// thread route guard reads these markers to hold its missing-thread fallback
// instead of bouncing home; the bound keeps a genuinely missing thread on a
// real (few-second) timeout.
export const PROMOTED_THREAD_ROUTE_GRACE_MS = 5_000;

export interface PromotedThreadRouteMarker {
  readonly projectId: ProjectId;
  readonly entryPoint: DraftThreadState["entryPoint"];
  readonly promotedAt: number;
}

const promotedThreadRouteMarkers = new Map<ThreadId, PromotedThreadRouteMarker>();

function prunePromotedThreadRouteMarkers(now: number): void {
  for (const [threadId, marker] of promotedThreadRouteMarkers) {
    if (now - marker.promotedAt > PROMOTED_THREAD_ROUTE_GRACE_MS) {
      promotedThreadRouteMarkers.delete(threadId);
    }
  }
}

function notePromotedThreadRouteMarker(threadId: ThreadId, draftThread: DraftThreadState): void {
  const promotedAt = Date.now();
  const marker: PromotedThreadRouteMarker = {
    projectId: draftThread.projectId,
    entryPoint: draftThread.entryPoint,
    promotedAt,
  };
  promotedThreadRouteMarkers.set(threadId, marker);
  // `promotedTo` defaults to the draft id but can carry a distinct server id —
  // protect whichever id a route could be holding.
  if (draftThread.promotedTo !== undefined && draftThread.promotedTo !== threadId) {
    promotedThreadRouteMarkers.set(draftThread.promotedTo, marker);
  }
  prunePromotedThreadRouteMarkers(promotedAt);
}

/** True while `threadId`'s promotion is fresh enough that its route must hold. */
export function isPromotedThreadRoutePending(threadId: ThreadId): boolean {
  const marker = promotedThreadRouteMarkers.get(threadId);
  if (marker === undefined) {
    return false;
  }
  if (Date.now() - marker.promotedAt > PROMOTED_THREAD_ROUTE_GRACE_MS) {
    promotedThreadRouteMarkers.delete(threadId);
    return false;
  }
  return true;
}

/** Fresh markers only — expired entries are swept before the map is handed out. */
export function readPromotedThreadRouteMarkers(): ReadonlyMap<
  ThreadId,
  PromotedThreadRouteMarker
> {
  prunePromotedThreadRouteMarkers(Date.now());
  return promotedThreadRouteMarkers;
}

// Mark drafts as promoted first; route/composer cleanup happens after the server thread starts.
export function markPromotedDraftThreads(serverThreadIds: ReadonlySet<ThreadId>): void {
  const store = useComposerDraftStore.getState();
  const draftThreadIds = Object.keys(store.draftThreadsByThreadId) as ThreadId[];
  for (const draftId of draftThreadIds) {
    if (serverThreadIds.has(draftId)) {
      const draftThread = store.draftThreadsByThreadId[draftId];
      store.markDraftThreadPromoting(draftId);
      if (draftThread !== undefined) {
        notePromotedThreadRouteMarker(draftId, draftThread);
      }
    }
  }
}

export function finalizePromotedDraftThreads(serverThreadIds: ReadonlySet<ThreadId>): void {
  const store = useComposerDraftStore.getState();
  for (const threadId of serverThreadIds) {
    // Re-stamp at the exact moment the draft record drops — that is the render
    // window the route guard protects, and it can open long after the promote
    // call that set the first marker.
    const draftThread = useComposerDraftStore.getState().draftThreadsByThreadId[threadId];
    if (draftThread?.promotedTo !== undefined) {
      notePromotedThreadRouteMarker(threadId, draftThread);
    }
    store.finalizePromotedDraftThread(threadId);
  }
}
