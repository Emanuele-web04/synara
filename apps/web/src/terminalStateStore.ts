/**
 * Purpose: Single Zustand store for terminal UI state keyed by threadId. Holds the
 * store shell, per-thread map updater, and selector; pure normalization and transition
 * logic live in sibling modules.
 * Layer: Web client state.
 * Exports: ThreadTerminalState, selectThreadTerminalState,
 * sanitizePersistedTerminalStateByThreadId, useTerminalStateStore.
 *
 * Terminal transition helpers are intentionally private to keep the public
 * API constrained to store actions/selectors.
 */

import { type TerminalActivityState, type TerminalCliKind } from "@t3tools/shared/terminalThreads";
import type { ThreadId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  type ThreadTerminalPresentationMode,
  type ThreadTerminalWorkspaceLayout,
  type ThreadTerminalWorkspaceTab,
} from "./types";
import { createBrowserStateStorage } from "./lib/storage";
import { type WorkspaceLayoutPresetId } from "./workspaceTerminalLayoutPresets";
import {
  type ThreadTerminalState,
  createDefaultThreadTerminalState,
  getDefaultThreadTerminalState,
  isDefaultThreadTerminalState,
  sanitizePersistedTerminalStateByThreadId,
} from "./terminalStateStore.normalizers";
import {
  applyThreadWorkspaceLayoutPreset,
  closeThreadTerminal,
  closeThreadTerminalGroup,
  closeThreadWorkspaceChat,
  newThreadTerminal,
  newThreadTerminalTab,
  openThreadChatPage,
  openThreadTerminalFullWidth,
  openThreadTerminalPage,
  resizeThreadTerminalSplit,
  setThreadActiveTerminal,
  setThreadTerminalActivity,
  setThreadTerminalCliKind,
  setThreadTerminalHeight,
  setThreadTerminalMetadata,
  setThreadTerminalOpen,
  setThreadTerminalPresentationMode,
  setThreadTerminalTitleOverride,
  setThreadTerminalWorkspaceLayout,
  setThreadTerminalWorkspaceTab,
  splitThreadTerminal,
  splitThreadTerminalDown,
  splitThreadTerminalLeft,
  splitThreadTerminalUp,
} from "./terminalStateStore.reducers";

export type { ThreadTerminalState } from "./terminalStateStore.normalizers";
export { sanitizePersistedTerminalStateByThreadId } from "./terminalStateStore.normalizers";

const TERMINAL_STATE_STORAGE_KEY = "synara:terminal-state:v1";

export function selectThreadTerminalState(
  terminalStateByThreadId: Record<ThreadId, ThreadTerminalState>,
  threadId: ThreadId,
): ThreadTerminalState {
  if (threadId.length === 0) {
    return getDefaultThreadTerminalState();
  }
  return terminalStateByThreadId[threadId] ?? getDefaultThreadTerminalState();
}

function updateTerminalStateByThreadId(
  terminalStateByThreadId: Record<ThreadId, ThreadTerminalState>,
  threadId: ThreadId,
  updater: (state: ThreadTerminalState) => ThreadTerminalState,
): Record<ThreadId, ThreadTerminalState> {
  if (threadId.length === 0) {
    return terminalStateByThreadId;
  }

  const current = selectThreadTerminalState(terminalStateByThreadId, threadId);
  const next = updater(current);
  if (next === current) {
    return terminalStateByThreadId;
  }

  if (isDefaultThreadTerminalState(next)) {
    if (terminalStateByThreadId[threadId] === undefined) {
      return terminalStateByThreadId;
    }
    const { [threadId]: _removed, ...rest } = terminalStateByThreadId;
    return rest as Record<ThreadId, ThreadTerminalState>;
  }

  return {
    ...terminalStateByThreadId,
    [threadId]: next,
  };
}

interface TerminalStateStoreState {
  terminalStateByThreadId: Record<ThreadId, ThreadTerminalState>;
  openChatThreadPage: (threadId: ThreadId) => void;
  openTerminalThreadPage: (threadId: ThreadId, options?: { terminalOnly?: boolean }) => void;
  setTerminalOpen: (threadId: ThreadId, open: boolean) => void;
  setTerminalPresentationMode: (threadId: ThreadId, mode: ThreadTerminalPresentationMode) => void;
  setTerminalWorkspaceLayout: (threadId: ThreadId, layout: ThreadTerminalWorkspaceLayout) => void;
  setTerminalWorkspaceTab: (threadId: ThreadId, tab: ThreadTerminalWorkspaceTab) => void;
  setTerminalHeight: (threadId: ThreadId, height: number) => void;
  setTerminalMetadata: (
    threadId: ThreadId,
    terminalId: string,
    metadata: { cliKind: TerminalCliKind | null; label: string },
  ) => void;
  setTerminalCliKind: (
    threadId: ThreadId,
    terminalId: string,
    cliKind: TerminalCliKind | null,
  ) => void;
  setTerminalTitleOverride: (
    threadId: ThreadId,
    terminalId: string,
    titleOverride: string | null | undefined,
  ) => void;
  splitTerminal: (threadId: ThreadId, terminalId: string) => void;
  splitTerminalLeft: (threadId: ThreadId, terminalId: string) => void;
  splitTerminalRight: (threadId: ThreadId, terminalId: string) => void;
  splitTerminalDown: (threadId: ThreadId, terminalId: string) => void;
  splitTerminalUp: (threadId: ThreadId, terminalId: string) => void;
  newTerminal: (threadId: ThreadId, terminalId: string) => void;
  newTerminalTab: (threadId: ThreadId, targetTerminalId: string, terminalId: string) => void;
  openNewFullWidthTerminal: (threadId: ThreadId, terminalId: string) => void;
  closeWorkspaceChat: (threadId: ThreadId) => void;
  setActiveTerminal: (threadId: ThreadId, terminalId: string) => void;
  closeTerminal: (threadId: ThreadId, terminalId: string) => void;
  closeTerminalGroup: (threadId: ThreadId, groupId: string) => void;
  resizeTerminalSplit: (
    threadId: ThreadId,
    groupId: string,
    splitId: string,
    weights: number[],
  ) => void;
  setTerminalActivity: (
    threadId: ThreadId,
    terminalId: string,
    activity: { agentState: TerminalActivityState | null; hasRunningSubprocess: boolean },
  ) => void;
  applyWorkspaceLayoutPreset: (
    threadId: ThreadId,
    presetId: WorkspaceLayoutPresetId,
    terminalIds: readonly string[],
  ) => void;
  clearTerminalState: (threadId: ThreadId) => void;
  removeOrphanedTerminalStates: (activeThreadIds: Set<ThreadId>) => void;
}

export const useTerminalStateStore = create<TerminalStateStoreState>()(
  persist(
    (set) => {
      const updateTerminal = (
        threadId: ThreadId,
        updater: (state: ThreadTerminalState) => ThreadTerminalState,
      ) => {
        set((state) => {
          const nextTerminalStateByThreadId = updateTerminalStateByThreadId(
            state.terminalStateByThreadId,
            threadId,
            updater,
          );
          if (nextTerminalStateByThreadId === state.terminalStateByThreadId) {
            return state;
          }
          return {
            terminalStateByThreadId: nextTerminalStateByThreadId,
          };
        });
      };

      return {
        terminalStateByThreadId: {},
        openChatThreadPage: (threadId) =>
          updateTerminal(threadId, (state) => openThreadChatPage(state)),
        openTerminalThreadPage: (threadId, options) =>
          updateTerminal(threadId, (state) => openThreadTerminalPage(state, options)),
        setTerminalOpen: (threadId, open) =>
          updateTerminal(threadId, (state) => setThreadTerminalOpen(state, open)),
        setTerminalPresentationMode: (threadId, mode) =>
          updateTerminal(threadId, (state) => setThreadTerminalPresentationMode(state, mode)),
        setTerminalWorkspaceLayout: (threadId, layout) =>
          updateTerminal(threadId, (state) => setThreadTerminalWorkspaceLayout(state, layout)),
        setTerminalWorkspaceTab: (threadId, tab) =>
          updateTerminal(threadId, (state) => setThreadTerminalWorkspaceTab(state, tab)),
        setTerminalHeight: (threadId, height) =>
          updateTerminal(threadId, (state) => setThreadTerminalHeight(state, height)),
        setTerminalMetadata: (threadId, terminalId, metadata) =>
          updateTerminal(threadId, (state) =>
            setThreadTerminalMetadata(state, terminalId, metadata),
          ),
        setTerminalCliKind: (threadId, terminalId, cliKind) =>
          updateTerminal(threadId, (state) => setThreadTerminalCliKind(state, terminalId, cliKind)),
        setTerminalTitleOverride: (threadId, terminalId, titleOverride) =>
          updateTerminal(threadId, (state) =>
            setThreadTerminalTitleOverride(state, terminalId, titleOverride),
          ),
        splitTerminal: (threadId, terminalId) =>
          updateTerminal(threadId, (state) => splitThreadTerminal(state, terminalId)),
        splitTerminalLeft: (threadId, terminalId) =>
          updateTerminal(threadId, (state) => splitThreadTerminalLeft(state, terminalId)),
        splitTerminalRight: (threadId, terminalId) =>
          updateTerminal(threadId, (state) => splitThreadTerminal(state, terminalId)),
        splitTerminalDown: (threadId, terminalId) =>
          updateTerminal(threadId, (state) => splitThreadTerminalDown(state, terminalId)),
        splitTerminalUp: (threadId, terminalId) =>
          updateTerminal(threadId, (state) => splitThreadTerminalUp(state, terminalId)),
        newTerminal: (threadId, terminalId) =>
          updateTerminal(threadId, (state) => newThreadTerminal(state, terminalId)),
        newTerminalTab: (threadId, targetTerminalId, terminalId) =>
          updateTerminal(threadId, (state) =>
            newThreadTerminalTab(state, targetTerminalId, terminalId),
          ),
        openNewFullWidthTerminal: (threadId, terminalId) =>
          updateTerminal(threadId, (state) => openThreadTerminalFullWidth(state, terminalId)),
        closeWorkspaceChat: (threadId) =>
          updateTerminal(threadId, (state) => closeThreadWorkspaceChat(state)),
        setActiveTerminal: (threadId, terminalId) =>
          updateTerminal(threadId, (state) => setThreadActiveTerminal(state, terminalId)),
        closeTerminal: (threadId, terminalId) =>
          updateTerminal(threadId, (state) => closeThreadTerminal(state, terminalId)),
        closeTerminalGroup: (threadId, groupId) =>
          updateTerminal(threadId, (state) => closeThreadTerminalGroup(state, groupId)),
        resizeTerminalSplit: (threadId, groupId, splitId, weights) =>
          updateTerminal(threadId, (state) =>
            resizeThreadTerminalSplit(state, groupId, splitId, weights),
          ),
        setTerminalActivity: (threadId, terminalId, activity) =>
          updateTerminal(threadId, (state) =>
            setThreadTerminalActivity(state, terminalId, activity),
          ),
        applyWorkspaceLayoutPreset: (threadId, presetId, terminalIds) =>
          updateTerminal(threadId, (state) =>
            applyThreadWorkspaceLayoutPreset(state, presetId, terminalIds),
          ),
        clearTerminalState: (threadId) =>
          updateTerminal(threadId, () => createDefaultThreadTerminalState()),
        removeOrphanedTerminalStates: (activeThreadIds) =>
          set((state) => {
            const orphanedIds = Object.keys(state.terminalStateByThreadId).filter(
              (id) => !activeThreadIds.has(id as ThreadId),
            );
            if (orphanedIds.length === 0) return state;
            const next = { ...state.terminalStateByThreadId };
            for (const id of orphanedIds) {
              delete next[id as ThreadId];
            }
            return { terminalStateByThreadId: next };
          }),
      };
    },
    {
      name: TERMINAL_STATE_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(createBrowserStateStorage),
      partialize: (state) => ({
        terminalStateByThreadId: sanitizePersistedTerminalStateByThreadId(
          state.terminalStateByThreadId,
        ),
      }),
      merge: (persistedState, currentState) => ({
        ...currentState,
        terminalStateByThreadId: sanitizePersistedTerminalStateByThreadId(
          (persistedState as Partial<TerminalStateStoreState> | undefined)?.terminalStateByThreadId,
        ),
      }),
    },
  ),
);
