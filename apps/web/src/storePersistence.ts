// FILE: storePersistence.ts
// Purpose: Persists project-only renderer preferences without depending on the Zustand facade.
// Exports: Persistence I/O plus read-only remembered project UI state.

import { normalizeWorkspaceRootForComparison } from "@synara/shared/threadWorkspace";

import type { AppState } from "./storeState";
import type { Project } from "./types";

const PERSISTED_STATE_KEY = "synara:renderer-state:v8";
const persistedExpandedProjectCwds = new Set<string>();
const persistedProjectOrderCwds: string[] = [];
const persistedProjectOrderByCwd = new Map<string, number>();
const persistedProjectNamesByCwd = new Map<string, string>();

export interface RememberedProjectUiState {
  expandedProjectCount: number;
  isProjectExpanded: (cwdKey: string) => boolean;
  projectOrderCount: number;
  projectOrderIndexForCwd: (cwdKey: string) => number | undefined;
  projectNameForCwd: (cwdKey: string) => string | undefined;
}

const rememberedProjectUiState: RememberedProjectUiState = {
  get expandedProjectCount() {
    return persistedExpandedProjectCwds.size;
  },
  isProjectExpanded: (cwdKey) => persistedExpandedProjectCwds.has(cwdKey),
  get projectOrderCount() {
    return persistedProjectOrderCwds.length;
  },
  projectOrderIndexForCwd: (cwdKey) => persistedProjectOrderByCwd.get(cwdKey),
  projectNameForCwd: (cwdKey) => persistedProjectNamesByCwd.get(cwdKey),
};

export function projectCwdKey(cwd: string): string {
  return normalizeWorkspaceRootForComparison(cwd);
}

export function getRememberedProjectUiState(): RememberedProjectUiState {
  return rememberedProjectUiState;
}

export function rememberProjectUiState(
  projects: ReadonlyArray<Pick<Project, "cwd" | "expanded">>,
): void {
  for (const project of projects) {
    const cwdKey = projectCwdKey(project.cwd);
    if (project.expanded) {
      persistedExpandedProjectCwds.add(cwdKey);
    } else {
      persistedExpandedProjectCwds.delete(cwdKey);
    }
    if (!persistedProjectOrderByCwd.has(cwdKey)) {
      persistedProjectOrderByCwd.set(cwdKey, persistedProjectOrderCwds.length);
      persistedProjectOrderCwds.push(cwdKey);
    }
  }
}

export function rememberProjectLocalNames(
  projects: ReadonlyArray<Pick<Project, "cwd" | "localName">>,
): void {
  for (const project of projects) {
    const cwdKey = projectCwdKey(project.cwd);
    const localName = project.localName?.trim() ?? "";
    if (localName.length > 0) {
      persistedProjectNamesByCwd.set(cwdKey, localName);
    } else {
      persistedProjectNamesByCwd.delete(cwdKey);
    }
  }
}

export function readPersistedState(initialState: AppState): AppState {
  if (typeof window === "undefined") return initialState;
  try {
    const raw = window.localStorage.getItem(PERSISTED_STATE_KEY);
    if (!raw) return initialState;
    const parsed = JSON.parse(raw) as {
      expandedProjectCwds?: string[];
      projectOrderCwds?: string[];
      projectNamesByCwd?: Record<string, string>;
    };
    persistedExpandedProjectCwds.clear();
    persistedProjectOrderCwds.length = 0;
    persistedProjectOrderByCwd.clear();
    persistedProjectNamesByCwd.clear();
    for (const cwd of parsed.expandedProjectCwds ?? []) {
      if (typeof cwd === "string" && cwd.length > 0) {
        persistedExpandedProjectCwds.add(projectCwdKey(cwd));
      }
    }
    for (const cwd of parsed.projectOrderCwds ?? []) {
      const cwdKey = typeof cwd === "string" ? projectCwdKey(cwd) : "";
      if (cwdKey.length > 0 && !persistedProjectOrderByCwd.has(cwdKey)) {
        persistedProjectOrderByCwd.set(cwdKey, persistedProjectOrderCwds.length);
        persistedProjectOrderCwds.push(cwdKey);
      }
    }
    for (const [cwd, name] of Object.entries(parsed.projectNamesByCwd ?? {})) {
      if (typeof cwd !== "string" || cwd.length === 0 || typeof name !== "string") continue;
      const trimmedName = name.trim();
      if (trimmedName.length === 0) continue;
      persistedProjectNamesByCwd.set(projectCwdKey(cwd), trimmedName);
    }
    return { ...initialState };
  } catch {
    return initialState;
  }
}

export function persistState(state: AppState): void {
  if (typeof window === "undefined") return;
  try {
    rememberProjectUiState(state.projects);
    rememberProjectLocalNames(state.projects);
    window.localStorage.setItem(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        expandedProjectCwds: state.projects
          .filter((project) => project.expanded)
          .map((project) => project.cwd),
        projectOrderCwds: state.projects.map((project) => project.cwd),
        projectNamesByCwd: Object.fromEntries(persistedProjectNamesByCwd),
      }),
    );
  } catch {
    // Ignore quota/storage errors to avoid breaking chat UX.
  }
}
