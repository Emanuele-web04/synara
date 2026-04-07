// FILE: splitViewStore.ts
// Purpose: Persists split chat surfaces that replace one sidebar row with a two-pane view.
// Layer: UI state store
// Exports: split view types, selectors, and mutation helpers used by sidebar and route surfaces

import { type ProjectId, type ThreadId, type TurnId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { randomUUID } from "./lib/utils";
import { type ChatRightPanel } from "./diffRouteSearch";
import { removeThreadFromSplitView } from "./splitView.logic";

export type SplitViewId = string;
export type SplitViewPane = "left" | "right";

export interface SplitViewPanePanelState {
  panel: ChatRightPanel | null;
  diffTurnId: TurnId | null;
  diffFilePath: string | null;
  hasOpenedPanel: boolean;
  lastOpenPanel: ChatRightPanel;
}

export interface SplitView {
  id: SplitViewId;
  sourceThreadId: ThreadId;
  ownerProjectId: ProjectId;
  leftThreadId: ThreadId | null;
  rightThreadId: ThreadId | null;
  focusedPane: SplitViewPane;
  ratio: number;
  leftPanel: SplitViewPanePanelState;
  rightPanel: SplitViewPanePanelState;
  createdAt: string;
  updatedAt: string;
}

interface CreateSplitViewInput {
  sourceThreadId: ThreadId;
  ownerProjectId: ProjectId;
}

interface SplitViewStore {
  splitViewsById: Record<SplitViewId, SplitView | undefined>;
  splitViewIdBySourceThreadId: Record<string, SplitViewId | undefined>;
  createFromThread: (input: CreateSplitViewInput) => SplitViewId;
  removeSplitView: (splitViewId: SplitViewId) => void;
  replacePaneThread: (
    splitViewId: SplitViewId,
    pane: SplitViewPane,
    threadId: ThreadId | null,
  ) => void;
  setFocusedPane: (splitViewId: SplitViewId, pane: SplitViewPane) => void;
  setRatio: (splitViewId: SplitViewId, ratio: number) => void;
  setPanePanelState: (
    splitViewId: SplitViewId,
    pane: SplitViewPane,
    patch: Partial<SplitViewPanePanelState>,
  ) => void;
  removeThreadFromSplitViews: (threadId: ThreadId) => void;
}

const SPLIT_VIEW_STORAGE_KEY = "t3code:split-view-state:v1";
const DEFAULT_RATIO = 0.5;
const MIN_RATIO = 0.25;
const MAX_RATIO = 0.75;

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RATIO;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, value));
}

function createDefaultPanePanelState(): SplitViewPanePanelState {
  return {
    panel: null,
    diffTurnId: null,
    diffFilePath: null,
    hasOpenedPanel: false,
    lastOpenPanel: "browser",
  };
}

function createSplitView(input: CreateSplitViewInput): SplitView {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    sourceThreadId: input.sourceThreadId,
    ownerProjectId: input.ownerProjectId,
    leftThreadId: input.sourceThreadId,
    rightThreadId: null,
    focusedPane: "right",
    ratio: DEFAULT_RATIO,
    leftPanel: createDefaultPanePanelState(),
    rightPanel: createDefaultPanePanelState(),
    createdAt: now,
    updatedAt: now,
  };
}

function resolveUpdatedAt(): string {
  return new Date().toISOString();
}

function updateSplitView(
  state: SplitViewStoreState,
  splitViewId: SplitViewId,
  updater: (splitView: SplitView) => SplitView,
): SplitViewStoreState {
  const existing = state.splitViewsById[splitViewId];
  if (!existing) return state;
  const updated = updater(existing);
  if (updated === existing) return state;
  return {
    ...state,
    splitViewsById: {
      ...state.splitViewsById,
      [splitViewId]: updated,
    },
  };
}

type SplitViewStoreState = Pick<SplitViewStore, "splitViewsById" | "splitViewIdBySourceThreadId">;

export function resolveSplitViewFocusedThreadId(splitView: SplitView): ThreadId | null {
  if (splitView.focusedPane === "right") {
    return splitView.rightThreadId ?? splitView.leftThreadId ?? null;
  }
  return splitView.leftThreadId ?? splitView.rightThreadId ?? null;
}

export function resolveSplitViewPaneThreadId(
  splitView: SplitView,
  pane: SplitViewPane,
): ThreadId | null {
  return pane === "right" ? splitView.rightThreadId : splitView.leftThreadId;
}

export function resolveSplitViewFocusedPaneThreadId(splitView: SplitView): ThreadId | null {
  return resolveSplitViewPaneThreadId(splitView, splitView.focusedPane);
}

export function resolveSplitViewThreadIds(splitView: SplitView): ThreadId[] {
  const ids = [splitView.leftThreadId, splitView.rightThreadId].filter(
    (threadId): threadId is ThreadId => threadId !== null,
  );
  return [...new Set(ids)];
}

export function resolveSplitViewPaneForThread(
  splitView: SplitView,
  threadId: ThreadId | null,
): SplitViewPane | null {
  if (!threadId) return null;
  if (splitView.leftThreadId === threadId) return "left";
  if (splitView.rightThreadId === threadId) return "right";
  return null;
}

export function selectSplitView(splitViewId: SplitViewId | null) {
  return (store: SplitViewStore) =>
    splitViewId ? (store.splitViewsById[splitViewId] ?? null) : null;
}

export function selectSplitViewIdForSourceThread(threadId: ThreadId | null) {
  return (store: SplitViewStore) =>
    threadId ? (store.splitViewIdBySourceThreadId[threadId] ?? null) : null;
}

export function resolvePreferredSplitViewIdForThread(input: {
  splitViewsById: Record<SplitViewId, SplitView | undefined>;
  splitViewIdBySourceThreadId: Record<string, SplitViewId | undefined>;
  threadId: ThreadId | null;
}): SplitViewId | null {
  if (!input.threadId) {
    return null;
  }

  const sourceSplitViewId = input.splitViewIdBySourceThreadId[input.threadId] ?? null;
  if (sourceSplitViewId) {
    return sourceSplitViewId;
  }

  const matchingSplitViews = Object.values(input.splitViewsById)
    .filter((splitView): splitView is SplitView => splitView !== undefined)
    .filter(
      (splitView) =>
        splitView.leftThreadId === input.threadId || splitView.rightThreadId === input.threadId,
    )
    .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));

  return matchingSplitViews[0]?.id ?? null;
}

export const useSplitViewStore = create<SplitViewStore>()(
  persist(
    (set, get) => ({
      splitViewsById: {},
      splitViewIdBySourceThreadId: {},
      createFromThread: (input) => {
        const existingId = get().splitViewIdBySourceThreadId[input.sourceThreadId] ?? null;
        if (existingId) {
          return existingId;
        }

        const splitView = createSplitView(input);
        set((state) => ({
          splitViewsById: {
            ...state.splitViewsById,
            [splitView.id]: splitView,
          },
          splitViewIdBySourceThreadId: {
            ...state.splitViewIdBySourceThreadId,
            [input.sourceThreadId]: splitView.id,
          },
        }));
        return splitView.id;
      },
      removeSplitView: (splitViewId) =>
        set((state) => {
          const existing = state.splitViewsById[splitViewId];
          if (!existing) return state;
          const nextSplitViewsById = { ...state.splitViewsById };
          const nextSplitViewIdBySourceThreadId = { ...state.splitViewIdBySourceThreadId };
          delete nextSplitViewsById[splitViewId];
          delete nextSplitViewIdBySourceThreadId[existing.sourceThreadId];
          return {
            splitViewsById: nextSplitViewsById,
            splitViewIdBySourceThreadId: nextSplitViewIdBySourceThreadId,
          };
        }),
      replacePaneThread: (splitViewId, pane, threadId) =>
        set((state) =>
          updateSplitView(state, splitViewId, (splitView) => {
            const key = pane === "left" ? "leftThreadId" : "rightThreadId";
            if (splitView[key] === threadId) {
              return splitView;
            }
            return {
              ...splitView,
              [key]: threadId,
              updatedAt: resolveUpdatedAt(),
            };
          }),
        ),
      setFocusedPane: (splitViewId, pane) =>
        set((state) =>
          updateSplitView(state, splitViewId, (splitView) => {
            if (splitView.focusedPane === pane) return splitView;
            return {
              ...splitView,
              focusedPane: pane,
              updatedAt: resolveUpdatedAt(),
            };
          }),
        ),
      setRatio: (splitViewId, ratio) =>
        set((state) =>
          updateSplitView(state, splitViewId, (splitView) => {
            const nextRatio = clampRatio(ratio);
            if (splitView.ratio === nextRatio) return splitView;
            return {
              ...splitView,
              ratio: nextRatio,
              updatedAt: resolveUpdatedAt(),
            };
          }),
        ),
      setPanePanelState: (splitViewId, pane, patch) =>
        set((state) =>
          updateSplitView(state, splitViewId, (splitView) => {
            const key = pane === "left" ? "leftPanel" : "rightPanel";
            const nextPanel = {
              ...splitView[key],
              ...patch,
            };
            if (
              splitView[key].panel === nextPanel.panel &&
              splitView[key].diffTurnId === nextPanel.diffTurnId &&
              splitView[key].diffFilePath === nextPanel.diffFilePath &&
              splitView[key].hasOpenedPanel === nextPanel.hasOpenedPanel &&
              splitView[key].lastOpenPanel === nextPanel.lastOpenPanel
            ) {
              return splitView;
            }
            return {
              ...splitView,
              [key]: nextPanel,
              updatedAt: resolveUpdatedAt(),
            };
          }),
        ),
      removeThreadFromSplitViews: (threadId) =>
        set((state) => {
          let didChange = false;
          const nextSplitViewsById = { ...state.splitViewsById };
          const nextSplitViewIdBySourceThreadId = { ...state.splitViewIdBySourceThreadId };

          for (const [splitViewId, splitView] of Object.entries(state.splitViewsById)) {
            if (!splitView) {
              continue;
            }
            const result = removeThreadFromSplitView(splitView, threadId);
            if (result.nextSplitView === splitView) {
              continue;
            }

            didChange = true;
            if (result.nextSplitView) {
              nextSplitViewsById[splitViewId] = result.nextSplitView;
            } else {
              delete nextSplitViewsById[splitViewId];
            }

            if (splitView.sourceThreadId === threadId || result.nextSplitView === null) {
              delete nextSplitViewIdBySourceThreadId[splitView.sourceThreadId];
            }
          }

          if (!didChange) {
            return state;
          }

          return {
            splitViewsById: nextSplitViewsById,
            splitViewIdBySourceThreadId: nextSplitViewIdBySourceThreadId,
          };
        }),
    }),
    {
      name: SPLIT_VIEW_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
