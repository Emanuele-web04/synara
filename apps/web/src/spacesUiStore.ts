// FILE: spacesUiStore.ts
// Purpose: Keeps per-window Space selection and last working-context restoration.

import type { ProjectId, SpaceId, ThreadId } from "@synara/contracts";
import { create } from "zustand";

import { spaceKey } from "~/lib/spaceGrouping";

const STORAGE_KEY = "synara:spaces-ui:v1";

interface PersistedSpacesUiState {
  activeSpaceId: SpaceId | null;
  lastThreadIdBySpace: Record<string, ThreadId>;
  lastProjectIdBySpace: Record<string, ProjectId>;
}

function readPersisted(): PersistedSpacesUiState {
  if (typeof window === "undefined") {
    return { activeSpaceId: null, lastThreadIdBySpace: {}, lastProjectIdBySpace: {} };
  }
  try {
    const parsed = JSON.parse(
      window.sessionStorage.getItem(STORAGE_KEY) ?? "null",
    ) as Partial<PersistedSpacesUiState> | null;
    return {
      activeSpaceId:
        typeof parsed?.activeSpaceId === "string" ? (parsed.activeSpaceId as SpaceId) : null,
      lastThreadIdBySpace:
        parsed?.lastThreadIdBySpace && typeof parsed.lastThreadIdBySpace === "object"
          ? parsed.lastThreadIdBySpace
          : {},
      lastProjectIdBySpace:
        parsed?.lastProjectIdBySpace && typeof parsed.lastProjectIdBySpace === "object"
          ? parsed.lastProjectIdBySpace
          : {},
    };
  } catch {
    return { activeSpaceId: null, lastThreadIdBySpace: {}, lastProjectIdBySpace: {} };
  }
}

function persist(
  state: Pick<SpacesUiState, "activeSpaceId" | "lastThreadIdBySpace" | "lastProjectIdBySpace">,
): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        activeSpaceId: state.activeSpaceId,
        lastThreadIdBySpace: state.lastThreadIdBySpace,
        lastProjectIdBySpace: state.lastProjectIdBySpace,
      }),
    );
  } catch {
    // A blocked storage API must not make Space switching unusable.
  }
}

function recordsEqual<T extends string>(
  left: Record<string, T>,
  right: Record<string, T>,
): boolean {
  const leftEntries = Object.entries(left);
  return (
    leftEntries.length === Object.keys(right).length &&
    leftEntries.every(([key, value]) => right[key] === value)
  );
}

interface SpacesUiState extends PersistedSpacesUiState {
  setActiveSpaceId: (spaceId: SpaceId | null) => void;
  rememberThread: (spaceId: SpaceId | null, threadId: ThreadId) => void;
  rememberProject: (spaceId: SpaceId | null, projectId: ProjectId) => void;
  getLastThreadId: (spaceId: SpaceId | null) => ThreadId | null;
  getLastProjectId: (spaceId: SpaceId | null) => ProjectId | null;
  reconcile: (input: {
    activeSpaceIds: ReadonlySet<SpaceId>;
    projectSpaceById: ReadonlyMap<ProjectId, SpaceId | null>;
    threadProjectById: ReadonlyMap<ThreadId, ProjectId>;
  }) => void;
}

const persisted = readPersisted();

export const useSpacesUiStore = create<SpacesUiState>((set, get) => ({
  ...persisted,
  setActiveSpaceId: (activeSpaceId) => {
    set({ activeSpaceId });
    persist(get());
  },
  rememberThread: (spaceId, threadId) => {
    const key = spaceKey(spaceId);
    if (get().lastThreadIdBySpace[key] === threadId && !(key in get().lastProjectIdBySpace)) return;
    set((state) => ({
      lastThreadIdBySpace: { ...state.lastThreadIdBySpace, [key]: threadId },
      lastProjectIdBySpace: Object.fromEntries(
        Object.entries(state.lastProjectIdBySpace).filter(([entryKey]) => entryKey !== key),
      ) as Record<string, ProjectId>,
    }));
    persist(get());
  },
  rememberProject: (spaceId, projectId) => {
    const key = spaceKey(spaceId);
    if (get().lastProjectIdBySpace[key] === projectId && !(key in get().lastThreadIdBySpace))
      return;
    set((state) => ({
      lastProjectIdBySpace: { ...state.lastProjectIdBySpace, [key]: projectId },
      lastThreadIdBySpace: Object.fromEntries(
        Object.entries(state.lastThreadIdBySpace).filter(([entryKey]) => entryKey !== key),
      ) as Record<string, ThreadId>,
    }));
    persist(get());
  },
  getLastThreadId: (spaceId) => get().lastThreadIdBySpace[spaceKey(spaceId)] ?? null,
  getLastProjectId: (spaceId) => get().lastProjectIdBySpace[spaceKey(spaceId)] ?? null,
  reconcile: ({ activeSpaceIds, projectSpaceById, threadProjectById }) => {
    const current = get();
    const activeSpaceId =
      current.activeSpaceId !== null && !activeSpaceIds.has(current.activeSpaceId)
        ? null
        : current.activeSpaceId;
    const lastThreadIdBySpace: Record<string, ThreadId> = {};
    for (const [key, threadId] of Object.entries(current.lastThreadIdBySpace)) {
      const projectId = threadProjectById.get(threadId);
      if (!projectId) continue;
      const assignedSpaceId = projectSpaceById.get(projectId) ?? null;
      if (spaceKey(assignedSpaceId) === key) {
        lastThreadIdBySpace[key] = threadId;
      }
    }
    const lastProjectIdBySpace: Record<string, ProjectId> = {};
    for (const [key, projectId] of Object.entries(current.lastProjectIdBySpace)) {
      const assignedSpaceId = projectSpaceById.get(projectId);
      if (assignedSpaceId !== undefined && spaceKey(assignedSpaceId) === key) {
        lastProjectIdBySpace[key] = projectId;
      }
    }
    if (
      activeSpaceId === current.activeSpaceId &&
      recordsEqual(lastThreadIdBySpace, current.lastThreadIdBySpace) &&
      recordsEqual(lastProjectIdBySpace, current.lastProjectIdBySpace)
    ) {
      return;
    }
    set({ activeSpaceId, lastThreadIdBySpace, lastProjectIdBySpace });
    persist(get());
  },
}));

export function readActiveSpaceId(): SpaceId | null {
  return useSpacesUiStore.getState().activeSpaceId;
}
