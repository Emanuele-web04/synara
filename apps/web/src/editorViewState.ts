// FILE: editorViewState.ts
// Purpose: Persists per-thread editor workspace view state (expanded explorer
//          directories, center mode) so re-entering the editor view restores it.
// Layer: Web UI state persistence

const EDITOR_VIEW_STATE_STORAGE_KEY = "synara.editor.viewStateByThreadId";
const MAX_PERSISTED_THREADS = 50;

export interface EditorViewStateSnapshot {
  expandedDirectories: ReadonlyArray<string>;
  centerMode: "file" | "diff";
}

interface PersistedEditorViewState extends EditorViewStateSnapshot {
  updatedAt: number;
}

type PersistedEditorViewStateMap = Record<string, PersistedEditorViewState>;

function readPersistedMap(): PersistedEditorViewStateMap {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(EDITOR_VIEW_STATE_STORAGE_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed as PersistedEditorViewStateMap;
  } catch {
    return {};
  }
}

export function readEditorViewState(threadId: string): EditorViewStateSnapshot | null {
  const entry = readPersistedMap()[threadId];
  if (!entry) {
    return null;
  }
  return {
    expandedDirectories: Array.isArray(entry.expandedDirectories)
      ? entry.expandedDirectories.filter((path): path is string => typeof path === "string")
      : [],
    centerMode: entry.centerMode === "file" ? "file" : "diff",
  };
}

export function storeEditorViewState(threadId: string, snapshot: EditorViewStateSnapshot): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const map = readPersistedMap();
    map[threadId] = { ...snapshot, updatedAt: Date.now() };
    const entries = Object.entries(map);
    if (entries.length > MAX_PERSISTED_THREADS) {
      entries
        .toSorted((left, right) => (left[1]?.updatedAt ?? 0) - (right[1]?.updatedAt ?? 0))
        .slice(0, entries.length - MAX_PERSISTED_THREADS)
        .forEach(([staleThreadId]) => {
          delete map[staleThreadId];
        });
    }
    window.localStorage.setItem(EDITOR_VIEW_STATE_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Best-effort preference persistence only.
  }
}
