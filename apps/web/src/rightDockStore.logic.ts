// FILE: rightDockStore.logic.ts
// Purpose: Pure, testable transitions for the right dock (tabbed multi-pane right sidebar).
// Layer: UI state helpers
// Exports: dock pane types, default-state factory, and immutable open/close/activate helpers.

import type { ThreadId, TurnId } from "@t3tools/contracts";
import { isPlainObject, sanitizeStringKeyedRecord } from "./persistedRecord";

// Single source of truth for the dock pane kinds. The union type, the runtime
// validator, the per-kind metadata map, and the add-menu order are all derived
// from this list so they can never drift apart.
export const RIGHT_DOCK_PANE_KINDS = [
  "browser",
  "diff",
  "terminal",
  "sidechat",
  "git",
  "review",
] as const;

export type RightDockPaneKind = (typeof RIGHT_DOCK_PANE_KINDS)[number];

const RIGHT_DOCK_PANE_KIND_SET: ReadonlySet<string> = new Set(RIGHT_DOCK_PANE_KINDS);

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
// only kind that allows multiple concurrent panes (one per embedded thread), so
// the singleton set is derived as "every kind except sidechat".
export const SINGLETON_PANE_KINDS: ReadonlySet<RightDockPaneKind> = new Set(
  RIGHT_DOCK_PANE_KINDS.filter((kind) => kind !== "sidechat"),
);

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

export function isRightDockPaneKind(value: unknown): value is RightDockPaneKind {
  return typeof value === "string" && RIGHT_DOCK_PANE_KIND_SET.has(value);
}

// Persisted dock state predates the current pane-kind union, so a stale entry
// (e.g. a kind that was renamed or removed) can crash the dock during render.
// Drop any pane we no longer understand and keep the active tab pointing at a
// surviving pane.
function sanitizePersistedPane(value: unknown): RightDockPane | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const candidate = value;
  if (typeof candidate.id !== "string" || !isRightDockPaneKind(candidate.kind)) {
    return null;
  }
  return {
    id: candidate.id,
    kind: candidate.kind,
    threadId: typeof candidate.threadId === "string" ? (candidate.threadId as ThreadId) : null,
    diffTurnId: typeof candidate.diffTurnId === "string" ? (candidate.diffTurnId as TurnId) : null,
    diffFilePath: typeof candidate.diffFilePath === "string" ? candidate.diffFilePath : null,
  };
}

export function sanitizeRightDockThreadState(value: unknown): RightDockThreadState {
  if (!isPlainObject(value)) {
    return createDefaultRightDockState();
  }
  const candidate = value;
  const panes = Array.isArray(candidate.panes)
    ? candidate.panes
        .map(sanitizePersistedPane)
        .filter((pane): pane is RightDockPane => pane !== null)
    : [];
  const activePaneId =
    typeof candidate.activePaneId === "string" &&
    panes.some((pane) => pane.id === candidate.activePaneId)
      ? candidate.activePaneId
      : (panes[0]?.id ?? null);
  return {
    open: panes.length > 0 && candidate.open === true,
    panes,
    activePaneId,
  };
}

export function sanitizeRightDockStateByThreadId(
  value: unknown,
): Record<string, RightDockThreadState> {
  return sanitizeStringKeyedRecord(value, (raw) =>
    raw === undefined ? null : sanitizeRightDockThreadState(raw),
  );
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
