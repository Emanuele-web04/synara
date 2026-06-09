// FILE: storeSlices/projects.ts
// Purpose: Normalizes read-model/shell project payloads into stable client Project state.
// Layer: Pure project transition helpers consumed by store.ts's Zustand actions.
// Exports: normalizeProjectFromReadModel/Shell, upsertProjectFromReadModel/Shell.

import { type OrchestrationReadModel, type OrchestrationShellSnapshot } from "@t3tools/contracts";
import { type AppState } from "../store";
import { arraysShallowEqual, deepEqualJson, normalizeModelSelection } from "./equality";
import {
  basenameOfPath,
  persistedExpandedProjectCwds,
  persistedProjectNamesByCwd,
  projectCwdKey,
} from "../storePersistence/hydration";
import { type Project } from "../types";

type ReadModelProject = OrchestrationReadModel["projects"][number];
type ShellSnapshotProject = OrchestrationShellSnapshot["projects"][number];

function normalizeProjectScripts(
  incoming: ReadModelProject["scripts"],
  previous: Project["scripts"] | undefined,
): Project["scripts"] {
  const nextScripts = incoming.map((script, index) => {
    const existing = previous?.[index];
    return existing && deepEqualJson(existing, script) ? existing : script;
  });
  return arraysShallowEqual(previous, nextScripts) ? previous : nextScripts;
}

export function normalizeProjectFromReadModel(
  incoming: ReadModelProject,
  previous: Project | undefined,
): Project {
  const workspaceRootKey = projectCwdKey(incoming.workspaceRoot);
  const folderName = basenameOfPath(incoming.workspaceRoot) ?? incoming.title;
  const localName = previous?.localName ?? persistedProjectNamesByCwd.get(workspaceRootKey) ?? null;
  const defaultModelSelection =
    incoming.defaultModelSelection === null
      ? null
      : normalizeModelSelection(incoming.defaultModelSelection, previous?.defaultModelSelection);
  const scripts = normalizeProjectScripts(incoming.scripts, previous?.scripts);
  const expanded =
    previous?.expanded ??
    (persistedExpandedProjectCwds.size > 0
      ? persistedExpandedProjectCwds.has(workspaceRootKey)
      : true);

  if (
    previous &&
    previous.id === incoming.id &&
    previous.kind === incoming.kind &&
    previous.name === (localName ?? incoming.title) &&
    previous.remoteName === incoming.title &&
    previous.folderName === folderName &&
    previous.localName === localName &&
    previous.cwd === incoming.workspaceRoot &&
    previous.defaultModelSelection === defaultModelSelection &&
    previous.expanded === expanded &&
    previous.createdAt === incoming.createdAt &&
    previous.updatedAt === incoming.updatedAt &&
    previous.scripts === scripts
  ) {
    return previous;
  }

  return {
    id: incoming.id,
    kind: incoming.kind ?? "project",
    name: localName ?? incoming.title,
    remoteName: incoming.title,
    folderName,
    localName,
    cwd: incoming.workspaceRoot,
    defaultModelSelection,
    expanded,
    createdAt: incoming.createdAt,
    updatedAt: incoming.updatedAt,
    scripts,
  } satisfies Project;
}

export function normalizeProjectFromShell(
  incoming: ShellSnapshotProject,
  previous: Project | undefined,
): Project {
  const workspaceRootKey = projectCwdKey(incoming.workspaceRoot);
  const folderName = basenameOfPath(incoming.workspaceRoot) ?? incoming.title;
  const localName = previous?.localName ?? persistedProjectNamesByCwd.get(workspaceRootKey) ?? null;
  const defaultModelSelection =
    incoming.defaultModelSelection === null
      ? null
      : normalizeModelSelection(incoming.defaultModelSelection, previous?.defaultModelSelection);
  const scripts = normalizeProjectScripts(incoming.scripts, previous?.scripts);
  const expanded =
    previous?.expanded ??
    (persistedExpandedProjectCwds.size > 0
      ? persistedExpandedProjectCwds.has(workspaceRootKey)
      : true);

  if (
    previous &&
    previous.id === incoming.id &&
    previous.kind === incoming.kind &&
    previous.name === (localName ?? incoming.title) &&
    previous.remoteName === incoming.title &&
    previous.folderName === folderName &&
    previous.localName === localName &&
    previous.cwd === incoming.workspaceRoot &&
    previous.defaultModelSelection === defaultModelSelection &&
    previous.expanded === expanded &&
    previous.createdAt === incoming.createdAt &&
    previous.updatedAt === incoming.updatedAt &&
    previous.scripts === scripts
  ) {
    return previous;
  }

  return {
    id: incoming.id,
    kind: incoming.kind ?? "project",
    name: localName ?? incoming.title,
    remoteName: incoming.title,
    folderName,
    localName,
    cwd: incoming.workspaceRoot,
    defaultModelSelection,
    expanded,
    createdAt: incoming.createdAt,
    updatedAt: incoming.updatedAt,
    scripts,
  } satisfies Project;
}

export function upsertProjectFromReadModel(state: AppState, incoming: ReadModelProject): AppState {
  const existingProject = state.projects.find((project) => project.id === incoming.id);
  const nextProject = normalizeProjectFromReadModel(incoming, existingProject);

  if (existingProject) {
    if (existingProject === nextProject) {
      return state;
    }
    return {
      ...state,
      projects: state.projects.map((project) =>
        project.id === incoming.id ? nextProject : project,
      ),
    };
  }

  return {
    ...state,
    projects: [...state.projects, nextProject],
  };
}

export function upsertProjectFromShell(state: AppState, incoming: ShellSnapshotProject): AppState {
  const existingProject =
    state.projects.find((project) => project.id === incoming.id) ??
    state.projects.find(
      (project) => projectCwdKey(project.cwd) === projectCwdKey(incoming.workspaceRoot),
    );
  const nextProject = normalizeProjectFromShell(incoming, existingProject);

  if (existingProject) {
    if (existingProject === nextProject) {
      return state;
    }
    return {
      ...state,
      projects: state.projects.map((project) =>
        project.id === existingProject.id ? nextProject : project,
      ),
    };
  }

  return {
    ...state,
    projects: [...state.projects, nextProject],
  };
}
