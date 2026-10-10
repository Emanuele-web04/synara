/**
 * Single Zustand store for terminal UI state keyed by threadId.
 *
 * Terminal transition helpers are intentionally private to keep the public
 * API constrained to store actions/selectors.
 */

import { randomTerminalId } from "./components/terminal/terminalIds";
import { type TerminalActivityState, type TerminalCliKind } from "@synara/shared/terminalThreads";
import type { ThreadId } from "@synara/contracts";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createDeferredPersistStorage, flushStorageBeforePageHide } from "./lib/storage";
import {
  DEFAULT_THREAD_TERMINAL_ID,
  type ThreadPrimarySurface,
  type ThreadTerminalPresentationMode,
  type ThreadTerminalWorkspaceLayout,
  type ThreadTerminalWorkspaceTab,
} from "./types";

export interface ThreadTerminalState {
  entryPoint: ThreadPrimarySurface;
  terminalOpen: boolean;
  hasSession: boolean;
  presentationMode: ThreadTerminalPresentationMode;
  workspaceLayout: ThreadTerminalWorkspaceLayout;
  workspaceActiveTab: ThreadTerminalWorkspaceTab;
  terminalIds: string[];
  terminalLabelsById: Record<string, string>;
  terminalTitleOverridesById: Record<string, string>;
  terminalCliKindsById: Record<string, TerminalCliKind>;
  terminalAttentionStatesById: Record<string, "attention" | "review">;
  runningTerminalIds: string[];
  activeTerminalId: string;
  retiredTerminalIds?: string[];
  dockTerminalIdsByPaneId?: Record<string, string>;
}

const TERMINAL_STATE_STORAGE_KEY = "synara:terminal-state:v1";

function normalizeTerminalIds(terminalIds: string[]): string[] {
  const ids = [...new Set(terminalIds.map((id) => id.trim()).filter((id) => id.length > 0))];
  return ids.length > 0 ? ids : [DEFAULT_THREAD_TERMINAL_ID];
}

function normalizeRunningTerminalIds(
  runningTerminalIds: string[],
  terminalIds: string[],
): string[] {
  if (runningTerminalIds.length === 0) return [];
  const validTerminalIdSet = new Set(terminalIds);
  return [...new Set(runningTerminalIds)]
    .map((id) => id.trim())
    .filter((id) => id.length > 0 && validTerminalIdSet.has(id));
}

function normalizeTerminalLabels(
  terminalLabelsById: Record<string, string> | null | undefined,
  terminalIds: string[],
): Record<string, string> {
  const validTerminalIdSet = new Set(terminalIds);
  const normalizedEntries = Object.entries(terminalLabelsById ?? {})
    .map(([terminalId, label]) => [terminalId.trim(), label.trim()] as const)
    .filter(([terminalId, label]) => terminalId.length > 0 && label.length > 0)
    .filter(([terminalId]) => validTerminalIdSet.has(terminalId))
    .toSorted(([leftId], [rightId]) => leftId.localeCompare(rightId));
  return Object.fromEntries(normalizedEntries);
}

function normalizeTerminalTitleOverrides(
  terminalTitleOverridesById: Record<string, string> | null | undefined,
  terminalIds: string[],
): Record<string, string> {
  const validTerminalIdSet = new Set(terminalIds);
  const normalizedEntries = Object.entries(terminalTitleOverridesById ?? {})
    .map(([terminalId, titleOverride]) => [terminalId.trim(), titleOverride.trim()] as const)
    .filter(
      ([terminalId, titleOverride]) =>
        terminalId.length > 0 && titleOverride.length > 0 && validTerminalIdSet.has(terminalId),
    )
    .toSorted(([leftId], [rightId]) => leftId.localeCompare(rightId));
  return Object.fromEntries(normalizedEntries);
}

function normalizeTerminalCliKinds(
  terminalCliKindsById: Record<string, TerminalCliKind> | null | undefined,
  terminalIds: string[],
): Record<string, TerminalCliKind> {
  const validTerminalIdSet = new Set(terminalIds);
  const normalizedEntries = Object.entries(terminalCliKindsById ?? {})
    .map(([terminalId, cliKind]) => [terminalId.trim(), cliKind] as const)
    .filter(
      ([terminalId, cliKind]) =>
        terminalId.length > 0 &&
        (cliKind === "codex" || cliKind === "claude" || cliKind === "antigravity"),
    )
    .filter(([terminalId]) => validTerminalIdSet.has(terminalId))
    .toSorted(([leftId], [rightId]) => leftId.localeCompare(rightId));
  return Object.fromEntries(normalizedEntries);
}

function normalizeTerminalAttentionStates(
  terminalAttentionStatesById: Record<string, "attention" | "review"> | null | undefined,
  terminalIds: string[],
): Record<string, "attention" | "review"> {
  const validTerminalIdSet = new Set(terminalIds);
  const normalizedEntries = Object.entries(terminalAttentionStatesById ?? {})
    .map(([terminalId, state]) => [terminalId.trim(), state] as const)
    .filter(
      ([terminalId, state]) =>
        terminalId.length > 0 && (state === "attention" || state === "review"),
    )
    .filter(([terminalId]) => validTerminalIdSet.has(terminalId))
    .toSorted(([leftId], [rightId]) => leftId.localeCompare(rightId));
  return Object.fromEntries(normalizedEntries);
}

function clearTerminalReviewState(
  terminalAttentionStatesById: Record<string, "attention" | "review">,
  terminalId: string,
): Record<string, "attention" | "review"> {
  if (terminalAttentionStatesById[terminalId] !== "review") {
    return terminalAttentionStatesById;
  }
  const nextAttentionStatesById = { ...terminalAttentionStatesById };
  delete nextAttentionStatesById[terminalId];
  return nextAttentionStatesById;
}

function generatedTerminalTitleBase(cliKind: TerminalCliKind | null): string {
  if (cliKind === "codex") return "Codex";
  if (cliKind === "claude") return "Claude";
  if (cliKind === "antigravity") return "Antigravity";
  return "Terminal";
}

function resolveTerminalDisplayTitle(options: {
  terminalId: string;
  terminalLabelsById: Record<string, string>;
  terminalTitleOverridesById: Record<string, string>;
}): string {
  return (
    options.terminalTitleOverridesById[options.terminalId]?.trim() ||
    options.terminalLabelsById[options.terminalId]?.trim() ||
    ""
  );
}

function createUniqueTerminalTitle(options: {
  cliKind: TerminalCliKind | null;
  excludeTerminalId?: string | undefined;
  terminalLabelsById: Record<string, string>;
  terminalTitleOverridesById?: Record<string, string> | undefined;
}): string {
  const baseTitle = generatedTerminalTitleBase(options.cliKind);
  const takenTitles = new Set(
    Object.keys(options.terminalLabelsById)
      .filter((terminalId) => terminalId !== options.excludeTerminalId)
      .map((terminalId) =>
        resolveTerminalDisplayTitle({
          terminalId,
          terminalLabelsById: options.terminalLabelsById,
          terminalTitleOverridesById: options.terminalTitleOverridesById ?? {},
        }),
      )
      .filter((title) => title.length > 0),
  );
  let index = 1;
  while (true) {
    const candidate = `${baseTitle} ${index}`;
    if (!takenTitles.has(candidate)) {
      return candidate;
    }
    index += 1;
  }
}

function ensureTerminalLabels(options: {
  terminalCliKindsById: Record<string, TerminalCliKind>;
  terminalIds: string[];
  terminalLabelsById: Record<string, string>;
  terminalTitleOverridesById: Record<string, string>;
}): Record<string, string> {
  const nextLabelsById = { ...options.terminalLabelsById };
  for (const terminalId of options.terminalIds) {
    const existingLabel = nextLabelsById[terminalId]?.trim();
    if (existingLabel && existingLabel.length > 0) {
      continue;
    }
    nextLabelsById[terminalId] = createUniqueTerminalTitle({
      cliKind: options.terminalCliKindsById[terminalId] ?? null,
      excludeTerminalId: terminalId,
      terminalLabelsById: nextLabelsById,
      terminalTitleOverridesById: options.terminalTitleOverridesById,
    });
  }
  return nextLabelsById;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function threadTerminalStateEqual(left: ThreadTerminalState, right: ThreadTerminalState): boolean {
  return (
    left.entryPoint === right.entryPoint &&
    left.terminalOpen === right.terminalOpen &&
    left.hasSession === right.hasSession &&
    left.presentationMode === right.presentationMode &&
    left.workspaceLayout === right.workspaceLayout &&
    left.workspaceActiveTab === right.workspaceActiveTab &&
    left.activeTerminalId === right.activeTerminalId &&
    arraysEqual(left.terminalIds, right.terminalIds) &&
    JSON.stringify(left.terminalLabelsById) === JSON.stringify(right.terminalLabelsById) &&
    JSON.stringify(left.terminalTitleOverridesById) ===
      JSON.stringify(right.terminalTitleOverridesById) &&
    JSON.stringify(left.terminalCliKindsById) === JSON.stringify(right.terminalCliKindsById) &&
    JSON.stringify(left.terminalAttentionStatesById) ===
      JSON.stringify(right.terminalAttentionStatesById) &&
    arraysEqual(left.runningTerminalIds, right.runningTerminalIds) &&
    arraysEqual(left.retiredTerminalIds ?? [], right.retiredTerminalIds ?? []) &&
    JSON.stringify(left.dockTerminalIdsByPaneId) === JSON.stringify(right.dockTerminalIdsByPaneId)
  );
}

const DEFAULT_THREAD_TERMINAL_STATE: ThreadTerminalState = Object.freeze({
  entryPoint: "chat",
  terminalOpen: false,
  hasSession: false,
  presentationMode: "workspace",
  workspaceLayout: "both",
  workspaceActiveTab: "terminal",
  terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
  terminalLabelsById: { [DEFAULT_THREAD_TERMINAL_ID]: "Terminal 1" },
  terminalTitleOverridesById: {},
  terminalCliKindsById: {},
  terminalAttentionStatesById: {},
  runningTerminalIds: [],
  activeTerminalId: DEFAULT_THREAD_TERMINAL_ID,
});

function createDefaultThreadTerminalState(): ThreadTerminalState {
  return {
    ...DEFAULT_THREAD_TERMINAL_STATE,
    terminalIds: [...DEFAULT_THREAD_TERMINAL_STATE.terminalIds],
    terminalLabelsById: { ...DEFAULT_THREAD_TERMINAL_STATE.terminalLabelsById },
    terminalTitleOverridesById: { ...DEFAULT_THREAD_TERMINAL_STATE.terminalTitleOverridesById },
    terminalCliKindsById: { ...DEFAULT_THREAD_TERMINAL_STATE.terminalCliKindsById },
    terminalAttentionStatesById: { ...DEFAULT_THREAD_TERMINAL_STATE.terminalAttentionStatesById },
    runningTerminalIds: [...DEFAULT_THREAD_TERMINAL_STATE.runningTerminalIds],
  };
}

function getDefaultThreadTerminalState(): ThreadTerminalState {
  return DEFAULT_THREAD_TERMINAL_STATE;
}

function normalizeThreadTerminalState(state: ThreadTerminalState): ThreadTerminalState {
  const terminalIds = normalizeTerminalIds(state.terminalIds);
  const activeTerminalId = terminalIds.includes(state.activeTerminalId)
    ? state.activeTerminalId
    : (terminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);
  const dockTerminalIdsByPaneId = state.dockTerminalIdsByPaneId;
  const nextTerminalIds = dockTerminalIdsByPaneId ? terminalIds : [activeTerminalId];
  // Legacy nested sessions retire only after the server acknowledges an idle close.
  // Dock panes keep their independently owned sessions.
  const retiredTerminalIds = [
    ...new Set([
      ...(state.retiredTerminalIds ?? []),
      ...terminalIds.filter((id) => !nextTerminalIds.includes(id)),
    ]),
  ].filter((id) => !nextTerminalIds.includes(id));
  const terminalLabelsById = normalizeTerminalLabels(
    (state as Partial<ThreadTerminalState>).terminalLabelsById,
    nextTerminalIds,
  );
  const terminalTitleOverridesById = normalizeTerminalTitleOverrides(
    (state as Partial<ThreadTerminalState>).terminalTitleOverridesById,
    nextTerminalIds,
  );
  const terminalCliKindsById = normalizeTerminalCliKinds(
    (state as Partial<ThreadTerminalState>).terminalCliKindsById,
    nextTerminalIds,
  );
  const terminalAttentionStatesById = normalizeTerminalAttentionStates(
    (state as Partial<ThreadTerminalState>).terminalAttentionStatesById,
    nextTerminalIds,
  );
  const ensuredTerminalLabelsById = ensureTerminalLabels({
    terminalCliKindsById,
    terminalIds: nextTerminalIds,
    terminalLabelsById,
    terminalTitleOverridesById,
  });
  const runningTerminalIds = normalizeRunningTerminalIds(state.runningTerminalIds, nextTerminalIds);
  const normalized: ThreadTerminalState = {
    entryPoint: state.entryPoint === "terminal" ? "terminal" : "chat",
    terminalOpen: state.terminalOpen,
    hasSession:
      state.terminalOpen || (state.hasSession ?? activeTerminalId !== DEFAULT_THREAD_TERMINAL_ID),
    presentationMode: "workspace",
    workspaceLayout: state.workspaceLayout === "terminal-only" ? "terminal-only" : "both",
    workspaceActiveTab: state.workspaceActiveTab === "chat" ? "chat" : "terminal",
    terminalIds: nextTerminalIds,
    terminalLabelsById: ensuredTerminalLabelsById,
    terminalTitleOverridesById,
    terminalCliKindsById,
    terminalAttentionStatesById,
    runningTerminalIds,
    activeTerminalId,
    ...(retiredTerminalIds.length > 0 ? { retiredTerminalIds } : {}),
    ...(dockTerminalIdsByPaneId ? { dockTerminalIdsByPaneId } : {}),
  };
  const hasLegacyLayout =
    "terminalGroups" in state || "activeTerminalGroupId" in state || "terminalHeight" in state;
  return !hasLegacyLayout && threadTerminalStateEqual(state, normalized) ? state : normalized;
}

function isDefaultThreadTerminalState(state: ThreadTerminalState): boolean {
  const normalized = normalizeThreadTerminalState(state);
  return threadTerminalStateEqual(normalized, DEFAULT_THREAD_TERMINAL_STATE);
}

function stripVolatileTerminalRuntimeState(state: ThreadTerminalState): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (
    normalized.runningTerminalIds.length === 0 &&
    Object.keys(normalized.terminalAttentionStatesById).length === 0
  ) {
    return normalized;
  }
  // Runtime activity is replayed by live terminal events after startup; persisting
  // it would make old attention states look like fresh notifications.
  return {
    ...normalized,
    terminalAttentionStatesById: {},
    runningTerminalIds: [],
  };
}

export function sanitizePersistedTerminalStateByThreadId(
  terminalStateByThreadId: Record<ThreadId, ThreadTerminalState> | null | undefined,
): Record<ThreadId, ThreadTerminalState> {
  const next: Record<ThreadId, ThreadTerminalState> = {};
  for (const [threadId, state] of Object.entries(terminalStateByThreadId ?? {})) {
    // Dedicated Workspace pages used synthetic `workspace:*` terminal scopes.
    // Drop those retired entries while hydrating the shared terminal store.
    if (threadId.startsWith("workspace:")) {
      continue;
    }
    const sanitized = stripVolatileTerminalRuntimeState(state);
    if (!isDefaultThreadTerminalState(sanitized)) {
      next[threadId as ThreadId] = sanitized;
    }
  }
  return next;
}

function isValidTerminalId(terminalId: string): boolean {
  return terminalId.trim().length > 0;
}

function setThreadTerminalOpen(state: ThreadTerminalState, open: boolean): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (normalized.terminalOpen === open) return normalized;
  return { ...normalized, terminalOpen: open, hasSession: open || normalized.hasSession };
}

function openThreadChatPage(state: ThreadTerminalState): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  const nextWorkspaceState =
    normalized.terminalOpen && normalized.presentationMode === "workspace"
      ? {
          workspaceLayout: "both" as const,
          workspaceActiveTab: "chat" as const,
        }
      : null;
  if (normalized.entryPoint === "chat" && nextWorkspaceState === null) {
    return normalized;
  }
  if (nextWorkspaceState === null) {
    return {
      ...normalized,
      entryPoint: "chat",
    };
  }
  return {
    ...normalized,
    entryPoint: "chat",
    ...nextWorkspaceState,
  };
}

function openThreadTerminalPage(
  state: ThreadTerminalState,
  options?: { terminalOnly?: boolean },
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  const shouldUseTerminalOnlyLayout =
    options?.terminalOnly ??
    (normalized.entryPoint === "terminal" ? normalized.workspaceLayout === "terminal-only" : true);
  const nextWorkspaceLayout = shouldUseTerminalOnlyLayout
    ? "terminal-only"
    : normalized.workspaceLayout;
  if (
    normalized.entryPoint === "terminal" &&
    normalized.terminalOpen &&
    normalized.presentationMode === "workspace" &&
    normalized.workspaceActiveTab === "terminal" &&
    normalized.workspaceLayout === nextWorkspaceLayout
  ) {
    return normalized;
  }
  return {
    ...normalized,
    entryPoint: "terminal",
    terminalOpen: true,
    hasSession: true,
    presentationMode: "workspace",
    workspaceLayout: nextWorkspaceLayout,
    workspaceActiveTab: "terminal",
    terminalAttentionStatesById: clearTerminalReviewState(
      normalized.terminalAttentionStatesById,
      normalized.activeTerminalId,
    ),
  };
}

function setThreadTerminalPresentationMode(
  state: ThreadTerminalState,
  _mode: ThreadTerminalPresentationMode,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (normalized.terminalOpen && normalized.workspaceActiveTab === "terminal") {
    return normalized;
  }
  return {
    ...normalized,
    terminalOpen: true,
    hasSession: true,
    presentationMode: "workspace",
    workspaceLayout: normalized.workspaceLayout,
    workspaceActiveTab: "terminal",
  };
}

function setThreadTerminalWorkspaceTab(
  state: ThreadTerminalState,
  tab: ThreadTerminalWorkspaceTab,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  const nextWorkspaceLayout = tab === "chat" ? "both" : normalized.workspaceLayout;
  if (normalized.workspaceActiveTab === tab && normalized.workspaceLayout === nextWorkspaceLayout) {
    return normalized;
  }
  return {
    ...normalized,
    workspaceLayout: nextWorkspaceLayout,
    workspaceActiveTab: tab,
    terminalAttentionStatesById:
      tab === "terminal"
        ? clearTerminalReviewState(
            normalized.terminalAttentionStatesById,
            normalized.activeTerminalId,
          )
        : normalized.terminalAttentionStatesById,
  };
}

function setThreadTerminalWorkspaceLayout(
  state: ThreadTerminalState,
  layout: ThreadTerminalWorkspaceLayout,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  const nextActiveTab =
    layout === "terminal-only"
      ? "terminal"
      : normalized.workspaceActiveTab === "chat"
        ? "chat"
        : "terminal";
  if (normalized.workspaceLayout === layout && normalized.workspaceActiveTab === nextActiveTab) {
    return normalized;
  }
  return {
    ...normalized,
    workspaceLayout: layout,
    workspaceActiveTab: nextActiveTab,
  };
}

// Persist terminal identity without renaming tabs on every command; titles stay stable once assigned.
function setThreadTerminalMetadata(
  state: ThreadTerminalState,
  terminalId: string,
  metadata: {
    cliKind: TerminalCliKind | null;
    label: string;
  },
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }
  const currentLabel = normalized.terminalLabelsById[terminalId] ?? "";
  const currentTitleOverride = normalized.terminalTitleOverridesById[terminalId]?.trim() ?? "";
  const currentCliKind = normalized.terminalCliKindsById[terminalId] ?? null;
  const nextCliKind = metadata.cliKind;
  const nextLabel =
    currentTitleOverride.length > 0
      ? currentLabel
      : nextCliKind !== null
        ? createUniqueTerminalTitle({
            cliKind: nextCliKind,
            excludeTerminalId: terminalId,
            terminalLabelsById: normalized.terminalLabelsById,
            terminalTitleOverridesById: normalized.terminalTitleOverridesById,
          })
        : metadata.label.trim().length > 0
          ? metadata.label.trim()
          : currentLabel;
  if (currentLabel === nextLabel && currentCliKind === nextCliKind) {
    return normalized;
  }
  const nextCliKindsById = { ...normalized.terminalCliKindsById };
  if (nextCliKind === null) {
    delete nextCliKindsById[terminalId];
  } else {
    nextCliKindsById[terminalId] = nextCliKind;
  }
  return {
    ...normalized,
    terminalLabelsById: {
      ...normalized.terminalLabelsById,
      [terminalId]: nextLabel,
    },
    terminalCliKindsById: nextCliKindsById,
  };
}

function setThreadTerminalCliKind(
  state: ThreadTerminalState,
  terminalId: string,
  cliKind: TerminalCliKind | null,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }
  const currentCliKind = normalized.terminalCliKindsById[terminalId] ?? null;
  if (currentCliKind === cliKind) {
    return normalized;
  }

  const nextCliKindsById = { ...normalized.terminalCliKindsById };
  if (cliKind === null) {
    delete nextCliKindsById[terminalId];
  } else {
    nextCliKindsById[terminalId] = cliKind;
  }

  const currentTitleOverride = normalized.terminalTitleOverridesById[terminalId]?.trim() ?? "";
  const terminalLabelsById =
    cliKind !== null && currentTitleOverride.length === 0
      ? {
          ...normalized.terminalLabelsById,
          [terminalId]: createUniqueTerminalTitle({
            cliKind,
            excludeTerminalId: terminalId,
            terminalLabelsById: normalized.terminalLabelsById,
            terminalTitleOverridesById: normalized.terminalTitleOverridesById,
          }),
        }
      : normalized.terminalLabelsById;

  return {
    ...normalized,
    terminalLabelsById,
    terminalCliKindsById: nextCliKindsById,
  };
}

function setThreadTerminalTitleOverride(
  state: ThreadTerminalState,
  terminalId: string,
  titleOverride: string | null | undefined,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }
  const normalizedTitleOverride = titleOverride?.trim() ?? "";
  const currentTitleOverride = normalized.terminalTitleOverridesById[terminalId] ?? "";
  if (currentTitleOverride === normalizedTitleOverride) {
    return normalized;
  }
  const nextTitleOverridesById = { ...normalized.terminalTitleOverridesById };
  if (normalizedTitleOverride.length === 0) {
    delete nextTitleOverridesById[terminalId];
  } else {
    nextTitleOverridesById[terminalId] = normalizedTitleOverride;
  }
  return {
    ...normalized,
    terminalTitleOverridesById: nextTitleOverridesById,
  };
}

// Opening an already existing panel always reuses its session, even while hidden.
function newThreadTerminal(state: ThreadTerminalState, terminalId: string): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!isValidTerminalId(terminalId)) return normalized;
  const hasSession = normalized.hasSession;
  if (hasSession) return { ...normalized, terminalOpen: true, hasSession: true };
  return normalizeThreadTerminalState({
    ...normalized,
    terminalOpen: true,
    hasSession: true,
    terminalIds: [terminalId],
    activeTerminalId: terminalId,
  });
}

function ensureDockTerminal(
  state: ThreadTerminalState,
  paneId: string,
  openedTerminalId?: string,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  const existingId = normalized.dockTerminalIdsByPaneId?.[paneId];
  if (existingId && (!openedTerminalId || existingId === openedTerminalId)) return normalized;
  const terminalId =
    openedTerminalId ??
    (normalized.dockTerminalIdsByPaneId ? randomTerminalId() : normalized.activeTerminalId);
  if (!isValidTerminalId(terminalId)) return normalized;
  return normalizeThreadTerminalState({
    ...normalized,
    terminalOpen: true,
    hasSession: true,
    terminalIds: [
      ...new Set([...(normalized.hasSession ? normalized.terminalIds : []), terminalId]),
    ],
    activeTerminalId: terminalId,
    dockTerminalIdsByPaneId: { ...normalized.dockTerminalIdsByPaneId, [paneId]: terminalId },
  });
}

function setThreadActiveTerminal(
  state: ThreadTerminalState,
  terminalId: string,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }
  if (
    normalized.activeTerminalId === terminalId &&
    normalized.terminalAttentionStatesById[terminalId] !== "review"
  )
    return normalized;
  return {
    ...normalized,
    activeTerminalId: terminalId,
    terminalAttentionStatesById: clearTerminalReviewState(
      normalized.terminalAttentionStatesById,
      terminalId,
    ),
  };
}

function closeThreadTerminal(state: ThreadTerminalState, terminalId: string): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }

  const remainingIds = normalized.terminalIds.filter((id) => id !== terminalId);
  if (remainingIds.length > 0) {
    return normalizeThreadTerminalState({
      ...normalized,
      terminalIds: remainingIds,
      activeTerminalId:
        normalized.activeTerminalId === terminalId ? remainingIds[0]! : normalized.activeTerminalId,
      dockTerminalIdsByPaneId: Object.fromEntries(
        Object.entries(normalized.dockTerminalIdsByPaneId ?? {}).filter(
          ([, id]) => id !== terminalId,
        ),
      ),
    });
  }

  // Late exit/close requests belong to the old PTY, including across reloads.
  const replacementId = randomTerminalId();
  return normalizeThreadTerminalState({
    ...createDefaultThreadTerminalState(),
    terminalIds: [replacementId],
    activeTerminalId: replacementId,
    terminalLabelsById: { [replacementId]: "Terminal 1" },
    entryPoint: normalized.entryPoint,
    terminalOpen: false,
    presentationMode: normalized.presentationMode,
    workspaceLayout: normalized.workspaceLayout,
    ...(normalized.retiredTerminalIds ? { retiredTerminalIds: normalized.retiredTerminalIds } : {}),
  });
}

export type TerminalExitDisposition = "ignored" | "closed" | "final";

function closeExitedThreadTerminal(
  state: ThreadTerminalState,
  terminalId: string,
): { state: ThreadTerminalState; disposition: TerminalExitDisposition } {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalOpen || !normalized.terminalIds.includes(terminalId)) {
    return { state: normalized, disposition: "ignored" };
  }
  return {
    state: closeThreadTerminal(normalized, terminalId),
    disposition: normalized.terminalIds.length > 1 ? "closed" : "final",
  };
}

function openThreadTerminalFullWidth(state: ThreadTerminalState): ThreadTerminalState {
  const nextState = normalizeThreadTerminalState(state);
  return normalizeThreadTerminalState({
    ...nextState,
    terminalOpen: true,
    hasSession: true,
    presentationMode: "workspace",
    workspaceLayout: "terminal-only",
    workspaceActiveTab: "terminal",
  });
}

function closeThreadWorkspaceChat(state: ThreadTerminalState): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (normalized.workspaceLayout === "terminal-only") {
    return normalized;
  }
  return {
    ...normalized,
    workspaceLayout: "terminal-only",
    workspaceActiveTab: "terminal",
  };
}

function setThreadTerminalActivity(
  state: ThreadTerminalState,
  terminalId: string,
  activity: { agentState: TerminalActivityState | null; hasRunningSubprocess: boolean },
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }
  const alreadyRunning = normalized.runningTerminalIds.includes(terminalId);
  const nextTerminalAttentionState =
    activity.agentState === "attention" || activity.agentState === "review"
      ? activity.agentState
      : null;
  const currentTerminalAttentionState = normalized.terminalAttentionStatesById[terminalId] ?? null;
  if (
    activity.hasRunningSubprocess === alreadyRunning &&
    nextTerminalAttentionState === currentTerminalAttentionState
  ) {
    return normalized;
  }
  const runningTerminalIds = new Set(normalized.runningTerminalIds);
  if (activity.hasRunningSubprocess) {
    runningTerminalIds.add(terminalId);
  } else {
    runningTerminalIds.delete(terminalId);
  }
  const terminalAttentionStatesById = { ...normalized.terminalAttentionStatesById };
  if (nextTerminalAttentionState === null) {
    delete terminalAttentionStatesById[terminalId];
  } else {
    terminalAttentionStatesById[terminalId] = nextTerminalAttentionState;
  }
  return {
    ...normalized,
    terminalAttentionStatesById,
    runningTerminalIds: [...runningTerminalIds],
  };
}

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
  newTerminal: (threadId: ThreadId, terminalId: string) => void;
  ensureDockTerminal: (threadId: ThreadId, paneId: string, openedTerminalId?: string) => void;
  openNewFullWidthTerminal: (threadId: ThreadId) => void;
  closeWorkspaceChat: (threadId: ThreadId) => void;
  setActiveTerminal: (threadId: ThreadId, terminalId: string) => void;
  closeTerminal: (threadId: ThreadId, terminalId: string) => void;
  closeExitedTerminal: (threadId: ThreadId, terminalId: string) => TerminalExitDisposition;
  forgetRetiredTerminal: (threadId: ThreadId, terminalId: string) => void;
  setTerminalActivity: (
    threadId: ThreadId,
    terminalId: string,
    activity: { agentState: TerminalActivityState | null; hasRunningSubprocess: boolean },
  ) => void;
  clearTerminalState: (threadId: ThreadId) => void;
  removeOrphanedTerminalStates: (activeThreadIds: Set<ThreadId>) => void;
}

// Defers partialize + JSON.stringify off the hot set() path (terminal layout
// changes, resizes, activity updates fire rapidly). Serialization now runs once
// per debounce window at flush time instead of synchronously on every set().
const terminalPersistStorage = createDeferredPersistStorage<
  TerminalStateStoreState,
  Pick<TerminalStateStoreState, "terminalStateByThreadId">
>({
  getStorage: () => localStorage,
  partialize: (state) => ({
    terminalStateByThreadId: sanitizePersistedTerminalStateByThreadId(
      state.terminalStateByThreadId,
    ),
  }),
});

// Flush pending terminal-state writes before the page goes away so at most one
// debounce window of changes can be lost.
flushStorageBeforePageHide(() => terminalPersistStorage.flush());

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
        ensureDockTerminal: (threadId, paneId, openedTerminalId) =>
          updateTerminal(threadId, (state) => ensureDockTerminal(state, paneId, openedTerminalId)),
        newTerminal: (threadId, terminalId) =>
          updateTerminal(threadId, (state) => newThreadTerminal(state, terminalId)),
        openNewFullWidthTerminal: (threadId) =>
          updateTerminal(threadId, (state) => openThreadTerminalFullWidth(state)),
        closeWorkspaceChat: (threadId) =>
          updateTerminal(threadId, (state) => closeThreadWorkspaceChat(state)),
        setActiveTerminal: (threadId, terminalId) =>
          updateTerminal(threadId, (state) => setThreadActiveTerminal(state, terminalId)),
        closeTerminal: (threadId, terminalId) =>
          updateTerminal(threadId, (state) => closeThreadTerminal(state, terminalId)),
        closeExitedTerminal: (threadId, terminalId) => {
          let disposition: TerminalExitDisposition = "ignored";
          updateTerminal(threadId, (state) => {
            const transition = closeExitedThreadTerminal(state, terminalId);
            disposition = transition.disposition;
            return transition.state;
          });
          return disposition;
        },
        forgetRetiredTerminal: (threadId, terminalId) =>
          updateTerminal(threadId, (state) => ({
            ...state,
            retiredTerminalIds: (state.retiredTerminalIds ?? []).filter((id) => id !== terminalId),
          })),
        setTerminalActivity: (threadId, terminalId, activity) =>
          updateTerminal(threadId, (state) =>
            setThreadTerminalActivity(state, terminalId, activity),
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
      // partialize is owned by the deferred storage (runs at flush time, not
      // eagerly on every set()).
      storage: terminalPersistStorage,
      merge: (persistedState, currentState) => ({
        ...currentState,
        terminalStateByThreadId: sanitizePersistedTerminalStateByThreadId(
          (persistedState as Partial<TerminalStateStoreState> | undefined)?.terminalStateByThreadId,
        ),
      }),
    },
  ),
);
