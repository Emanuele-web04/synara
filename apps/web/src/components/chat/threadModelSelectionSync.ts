// FILE: threadModelSelectionSync.ts
// Purpose: Keeps a started chat's composer model, effort and speed in step with the
//          selection stored on the thread: the user's picks are stored right away,
//          and a change made on another client (the phone) shows in the composer.
// Layer: Chat composer logic
// Exports: createThreadModelSelectionSync, threadModelSelectionToPersist

import type { ModelSelection, ThreadId } from "@synara/contracts";

import { modelSelectionStorageKey } from "../../composerDraftModels";
import { modelSelectionsEqual } from "../ChatView.logic";

const PERSIST_DEBOUNCE_MS = 300;
// How long a turn that left the queue may still repaint the thread when it starts.
const QUEUED_TURN_START_WINDOW_MS = 30_000;

export interface ThreadModelSelectionView {
  readonly threadId: ThreadId;
  /** The selection stored on the server thread; absent for a chat not created yet. */
  readonly serverModelSelection: ModelSelection | null | undefined;
  /** What a send would store: the composer's normalized selection. */
  readonly composerModelSelection: ModelSelection;
  /** The selections the composer's queued turns were queued with. */
  readonly queuedModelSelections: ReadonlyArray<ModelSelection>;
}

/**
 * The composer's selection to store on the thread, or null when there is nothing
 * to store. A pick of another provider is a handoff that only a send performs,
 * so it stays pending in the composer exactly as before.
 */
export function threadModelSelectionToPersist(input: {
  serverModelSelection: ModelSelection | null | undefined;
  composerModelSelection: ModelSelection;
}): ModelSelection | null {
  const { serverModelSelection, composerModelSelection } = input;
  if (
    !serverModelSelection ||
    modelSelectionStorageKey(serverModelSelection) !==
      modelSelectionStorageKey(composerModelSelection)
  ) {
    return null;
  }
  return modelSelectionsEqual(serverModelSelection, composerModelSelection)
    ? null
    : composerModelSelection;
}

interface QueuedSelection {
  readonly selection: ModelSelection;
  leftQueueAt: number | null;
}

interface ThreadSyncState {
  view: ThreadModelSelectionView | null;
  timer: ReturnType<typeof setTimeout> | null;
  stopWaitingForSend: (() => void) | null;
  inFlight: number;
  // The stored selection when the pending write began. A change the server made
  // while it was pending was held back, and is shown once the write settles.
  serverAtPendingStart: ModelSelection | null | undefined;
  queued: QueuedSelection[];
}

function isPending(state: ThreadSyncState): boolean {
  return state.timer !== null || state.stopWaitingForSend !== null || state.inFlight > 0;
}

export interface ThreadModelSelectionSync {
  /** The chat as the composer last rendered it. */
  updateView: (view: ThreadModelSelectionView) => void;
  /** The user committed a model, effort or speed pick in this chat's composer. */
  committed: (threadId: ThreadId) => void;
  /** The thread's stored selection may have changed. */
  serverChanged: (threadId: ThreadId) => void;
  /** Stores a pick still waiting out its pause now, as the composer leaves the chat. */
  flush: (threadId: ThreadId) => void;
}

export function createThreadModelSelectionSync(deps: {
  persist: (threadId: ThreadId, modelSelection: ModelSelection) => Promise<unknown>;
  showSelection: (threadId: ThreadId, modelSelection: ModelSelection) => void;
  reportFailure: (error: unknown) => void;
  isSending: (threadId: ThreadId) => boolean;
  subscribeSends: (listener: () => void) => () => void;
  now?: () => number;
}): ThreadModelSelectionSync {
  const now = deps.now ?? Date.now;
  const threads = new Map<ThreadId, ThreadSyncState>();

  const stateFor = (threadId: ThreadId): ThreadSyncState => {
    let state = threads.get(threadId);
    if (!state) {
      state = {
        view: null,
        timer: null,
        stopWaitingForSend: null,
        inFlight: 0,
        serverAtPendingStart: undefined,
        queued: [],
      };
      threads.set(threadId, state);
    }
    return state;
  };

  const schedule = (threadId: ThreadId) => {
    const state = stateFor(threadId);
    if (!isPending(state)) state.serverAtPendingStart = state.view?.serverModelSelection;
    // A send in progress stores the composer's selection first; this pick follows it.
    if (state.stopWaitingForSend !== null) return;
    if (state.timer !== null) clearTimeout(state.timer);
    // The pause folds rapid changes (an effort slider, repeated toggles) into one write.
    state.timer = setTimeout(() => {
      state.timer = null;
      write(threadId);
    }, PERSIST_DEBOUNCE_MS);
  };

  const settle = (threadId: ThreadId) => {
    const state = stateFor(threadId);
    if (isPending(state)) return;
    if (state.view?.serverModelSelection !== state.serverAtPendingStart) show(threadId);
  };

  const write = (threadId: ThreadId) => {
    const state = stateFor(threadId);
    if (deps.isSending(threadId)) {
      const stopWaiting = deps.subscribeSends(() => {
        if (deps.isSending(threadId)) return;
        stopWaiting();
        state.stopWaitingForSend = null;
        write(threadId);
      });
      state.stopWaitingForSend = stopWaiting;
      return;
    }
    const modelSelection = state.view ? threadModelSelectionToPersist(state.view) : null;
    if (!modelSelection) {
      settle(threadId);
      return;
    }
    state.inFlight += 1;
    // While a turn runs, the server keeps the new selection on the thread and
    // applies it when the next turn starts; a running turn is never restarted.
    deps.persist(threadId, modelSelection).then(
      () => {
        state.inFlight -= 1;
        settle(threadId);
      },
      (error: unknown) => {
        state.inFlight -= 1;
        deps.reportFailure(error);
        // A refused change goes back to what the thread actually runs.
        const stored = state.view?.serverModelSelection;
        if (stored && !isPending(state)) deps.showSelection(threadId, stored);
      },
    );
  };

  const show = (threadId: ThreadId) => {
    const state = stateFor(threadId);
    const view = state.view;
    // Our own pending write is newer than whatever the server reports meanwhile.
    if (!view?.serverModelSelection || isPending(state)) return;
    const stored = view.serverModelSelection;
    // Starting a queued turn stores the selection it was queued with. A pick made
    // after queueing it still stands for the turns that follow, so it is stored again.
    const currentTime = now();
    const queuedTurnStart = state.queued.findIndex(
      (entry) =>
        (entry.leftQueueAt === null ||
          currentTime - entry.leftQueueAt < QUEUED_TURN_START_WINDOW_MS) &&
        modelSelectionsEqual(entry.selection, stored),
    );
    if (queuedTurnStart !== -1) {
      state.queued.splice(queuedTurnStart, 1);
      if (!modelSelectionsEqual(stored, view.composerModelSelection)) {
        schedule(threadId);
        return;
      }
    }
    deps.showSelection(threadId, stored);
  };

  return {
    updateView(view) {
      const state = stateFor(view.threadId);
      const currentTime = now();
      const stillQueued = new Set(view.queuedModelSelections);
      for (const entry of state.queued) {
        if (entry.leftQueueAt === null && !stillQueued.has(entry.selection)) {
          entry.leftQueueAt = currentTime;
        }
      }
      const tracked = new Set(state.queued.map((entry) => entry.selection));
      for (const selection of view.queuedModelSelections) {
        if (!tracked.has(selection)) state.queued.push({ selection, leftQueueAt: null });
      }
      state.queued = state.queued.filter(
        (entry) =>
          entry.leftQueueAt === null ||
          currentTime - entry.leftQueueAt < QUEUED_TURN_START_WINDOW_MS,
      );
      state.view = view;
    },
    committed(threadId) {
      schedule(threadId);
    },
    serverChanged(threadId) {
      show(threadId);
    },
    flush(threadId) {
      const state = threads.get(threadId);
      if (!state || state.timer === null) return;
      clearTimeout(state.timer);
      state.timer = null;
      write(threadId);
    },
  };
}
