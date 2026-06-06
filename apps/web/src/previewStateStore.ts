import type { PreviewRuntimeState } from "@t3tools/contracts";
import { create } from "zustand";

interface PreviewStateStore {
  statesByCwd: Record<string, PreviewRuntimeState>;
  upsertState: (state: PreviewRuntimeState) => void;
}

export function previewStateKey(cwd: string): string {
  return cwd.trim();
}

export const usePreviewStateStore = create<PreviewStateStore>((set) => ({
  statesByCwd: {},
  upsertState: (state) =>
    set((current) => ({
      statesByCwd: {
        ...current.statesByCwd,
        [previewStateKey(state.cwd)]: state,
      },
    })),
}));

export function selectPreviewState(cwd: string | null | undefined) {
  return (state: PreviewStateStore): PreviewRuntimeState | null => {
    if (!cwd) {
      return null;
    }
    return state.statesByCwd[previewStateKey(cwd)] ?? null;
  };
}
