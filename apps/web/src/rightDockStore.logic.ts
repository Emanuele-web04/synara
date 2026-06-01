// FILE: rightDockStore.logic.ts
// Purpose: Pure, testable transitions for the right dock (tabbed multi-pane right sidebar).
// Layer: UI state helpers
// Exports: dock pane types, default-state factory, and immutable open/close/activate helpers.

import type { ThreadId, TurnId } from "@t3tools/contracts";

export type RightDockPaneKind = "browser" | "diff" | "terminal" | "sidechat" | "git";

export interface RightDockPane {
  id: string;
  kind: RightDockPaneKind;
  // sidechat panes point at the embedded thread.
  threadId: ThreadId | null;
  // diff panes remember which turn/file they were opened on.
  diffTurnId: TurnId | null;
  diffFilePath: string | null;
}

export interface RightDockThreadState {
  open: boolean;
  panes: RightDockPane[];
  activePaneId: string | null;
}

// Kinds that can only ever have one instance per host thread. Sidechat is the
// only kind that allows multiple concurrent panes (one per embedded thread).
export const SINGLETON_PANE_KINDS: ReadonlySet<RightDockPaneKind> = new Set<RightDockPaneKind>([
  "browser",
  "diff",
  "git",
  "terminal",
]);

export function isSingletonPaneKind(kind: RightDockPaneKind): boolean {
  return SINGLETON_PANE_KINDS.has(kind);
}

export function createDefaultRightDockState(): RightDockThreadState {
  return {
    open: false,
    panes: [],
    activePaneId: null,
  };
}

export interface OpenPaneInput {
  paneId: string;
  kind: RightDockPaneKind;
  threadId?: ThreadId | null;
  diffTurnId?: TurnId | null;
  diffFilePath?: string | null;
}

function createPane(input: OpenPaneInput): RightDockPane {
  return {
    id: input.paneId,
    kind: input.kind,
    threadId: input.threadId ?? null,
    diffTurnId: input.diffTurnId ?? null,
    diffFilePath: input.diffFilePath ?? null,
  };
}

function findSingletonPane(
  state: RightDockThreadState,
  kind: RightDockPaneKind,
): RightDockPane | undefined {
  return state.panes.find((pane) => pane.kind === kind);
}

// Opens (or focuses) a pane and makes the dock visible. Singleton kinds reuse
// the existing pane and merge diff metadata; sidechat always adds a new pane
// unless one already exists for the same embedded thread.
export function openPaneInState(
  state: RightDockThreadState,
  input: OpenPaneInput,
): RightDockThreadState {
  if (isSingletonPaneKind(input.kind)) {
    const existing = findSingletonPane(state, input.kind);
    if (existing) {
      // Only overwrite diff metadata when the caller explicitly targets a turn/file,
      // so a bare re-open/toggle keeps the pane focused on its current diff.
      const shouldUpdateDiff =
        input.kind === "diff" &&
        (input.diffTurnId !== undefined || input.diffFilePath !== undefined);
      const nextPanes = shouldUpdateDiff
        ? state.panes.map((pane) =>
            pane.id === existing.id
              ? {
                  ...pane,
                  diffTurnId: input.diffTurnId ?? null,
                  diffFilePath: input.diffFilePath ?? null,
                }
              : pane,
          )
        : state.panes;
      return { open: true, panes: nextPanes, activePaneId: existing.id };
    }
  } else {
    const existingForThread = input.threadId
      ? state.panes.find((pane) => pane.kind === input.kind && pane.threadId === input.threadId)
      : undefined;
    if (existingForThread) {
      return { open: true, panes: state.panes, activePaneId: existingForThread.id };
    }
  }

  const pane = createPane(input);
  return {
    open: true,
    panes: [...state.panes, pane],
    activePaneId: pane.id,
  };
}

function resolveActiveAfterRemoval(
  panes: RightDockPane[],
  removedIndex: number,
  previousActiveId: string | null,
  removedId: string,
): string | null {
  if (previousActiveId !== removedId) {
    return previousActiveId;
  }
  if (panes.length === 0) {
    return null;
  }
  const neighborIndex = Math.min(removedIndex, panes.length - 1);
  return panes[neighborIndex]?.id ?? null;
}

export function closePaneInState(
  state: RightDockThreadState,
  paneId: string,
): RightDockThreadState {
  const removedIndex = state.panes.findIndex((pane) => pane.id === paneId);
  if (removedIndex === -1) {
    return state;
  }
  const nextPanes = state.panes.filter((pane) => pane.id !== paneId);
  const nextActiveId = resolveActiveAfterRemoval(
    nextPanes,
    removedIndex,
    state.activePaneId,
    paneId,
  );
  return {
    open: nextPanes.length > 0 ? state.open : false,
    panes: nextPanes,
    activePaneId: nextActiveId,
  };
}

export function setActivePaneInState(
  state: RightDockThreadState,
  paneId: string,
): RightDockThreadState {
  if (!state.panes.some((pane) => pane.id === paneId)) {
    return state;
  }
  return { ...state, open: true, activePaneId: paneId };
}

export function setDockOpenInState(
  state: RightDockThreadState,
  open: boolean,
): RightDockThreadState {
  if (open && state.panes.length === 0) {
    return state;
  }
  if (state.open === open) {
    return state;
  }
  return { ...state, open };
}

export function updatePaneInState(
  state: RightDockThreadState,
  paneId: string,
  patch: Partial<Pick<RightDockPane, "diffTurnId" | "diffFilePath" | "threadId">>,
): RightDockThreadState {
  let changed = false;
  const nextPanes = state.panes.map((pane) => {
    if (pane.id !== paneId) {
      return pane;
    }
    const nextPane = { ...pane, ...patch };
    if (
      nextPane.diffTurnId !== pane.diffTurnId ||
      nextPane.diffFilePath !== pane.diffFilePath ||
      nextPane.threadId !== pane.threadId
    ) {
      changed = true;
      return nextPane;
    }
    return pane;
  });
  return changed ? { ...state, panes: nextPanes } : state;
}

// Header toggles behave like a visibility switch for a singleton kind: if that
// kind is the active visible pane, collapse the dock (preserving tabs);
// otherwise open/focus it.
export function toggleSingletonPaneInState(
  state: RightDockThreadState,
  input: OpenPaneInput,
): RightDockThreadState {
  const existing = findSingletonPane(state, input.kind);
  if (existing && state.open && state.activePaneId === existing.id) {
    return { ...state, open: false };
  }
  return openPaneInState(state, input);
}

export function resolveActivePane(state: RightDockThreadState): RightDockPane | null {
  if (!state.open || state.activePaneId === null) {
    return null;
  }
  return state.panes.find((pane) => pane.id === state.activePaneId) ?? null;
}
