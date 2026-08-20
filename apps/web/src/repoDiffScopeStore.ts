// FILE: repoDiffScopeStore.ts
// Purpose: Persists the active repo diff scope shared by the diff panel and header badge.
// Layer: Web UI state store
// Exports: repo diff scope labels, validation, and a persisted Zustand store.

import type { GitReadWorkingTreeDiffInput } from "@synara/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type RepoDiffScope = NonNullable<GitReadWorkingTreeDiffInput["scope"]>;

export const DEFAULT_REPO_DIFF_SCOPE: RepoDiffScope = "workingTree";

export const REPO_DIFF_SCOPE_LABELS: Record<RepoDiffScope, string> = {
  workingTree: "Working tree",
  unstaged: "Unstaged",
  staged: "Staged",
  branch: "Branch",
  ref: "Compare with",
};

const COMPARE_REF_SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
const COMPARE_REF_MAX_LABEL_LENGTH = 24;

export function formatCompareRefLabel(compareRef: string | null): string {
  const trimmed = compareRef?.trim() ?? "";
  if (trimmed.length === 0) {
    return REPO_DIFF_SCOPE_LABELS.ref;
  }
  const shortened = COMPARE_REF_SHA_PATTERN.test(trimmed) ? trimmed.slice(0, 7) : trimmed;
  return shortened.length > COMPARE_REF_MAX_LABEL_LENGTH
    ? `${shortened.slice(0, COMPARE_REF_MAX_LABEL_LENGTH - 1)}…`
    : shortened;
}

export function resolveRepoDiffScopeLabel(scope: RepoDiffScope, compareRef: string | null): string {
  if (scope === "ref") {
    return `vs ${formatCompareRefLabel(compareRef)}`;
  }
  return REPO_DIFF_SCOPE_LABELS[scope];
}

export function isRepoDiffScope(value: string): value is RepoDiffScope {
  return (
    value === "workingTree" ||
    value === "unstaged" ||
    value === "staged" ||
    value === "branch" ||
    value === "ref"
  );
}

interface RepoDiffScopeStore {
  scope: RepoDiffScope;
  compareRef: string | null;
  setScope: (scope: RepoDiffScope) => void;
  setCompareRef: (compareRef: string | null) => void;
}

const REPO_DIFF_SCOPE_STORAGE_KEY = "synara:repo-diff-scope:v1";

export const useRepoDiffScopeStore = create<RepoDiffScopeStore>()(
  persist(
    (set) => ({
      scope: DEFAULT_REPO_DIFF_SCOPE,
      compareRef: null,
      setScope: (scope) => set({ scope }),
      setCompareRef: (compareRef) => set({ compareRef }),
    }),
    {
      name: REPO_DIFF_SCOPE_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ scope: state.scope, compareRef: state.compareRef }),
      // Validate the persisted scope on rehydrate: an unknown/legacy value would
      // otherwise flow into the diff request and the label lookup unchecked.
      merge: (persisted, current) => {
        const persistedState = persisted as { scope?: unknown; compareRef?: unknown } | undefined;
        const persistedScope = persistedState?.scope;
        const persistedCompareRef = persistedState?.compareRef;
        const compareRef =
          typeof persistedCompareRef === "string" && persistedCompareRef.trim().length > 0
            ? persistedCompareRef
            : null;
        const scope =
          typeof persistedScope === "string" && isRepoDiffScope(persistedScope)
            ? persistedScope
            : DEFAULT_REPO_DIFF_SCOPE;
        return {
          ...current,
          scope: scope === "ref" && compareRef === null ? DEFAULT_REPO_DIFF_SCOPE : scope,
          compareRef,
        };
      },
    },
  ),
);
