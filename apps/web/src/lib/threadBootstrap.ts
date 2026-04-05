// FILE: threadBootstrap.ts
// Purpose: Pure helpers for draft reuse and terminal-thread promotion payloads.
// Layer: Web bootstrap/domain helpers
// Exports: draft patching, reuse checks, and terminal creation state resolution.

import {
  DEFAULT_RUNTIME_MODE,
  type ModelSelection,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import {
  type ComposerThreadDraftState,
  type DraftThreadEnvMode,
  type DraftThreadState,
  resolvePreferredComposerModelSelection,
} from "../composerDraftStore";
import { DEFAULT_INTERACTION_MODE, type ThreadPrimarySurface } from "../types";

export interface NewThreadOptions {
  branch?: string | null;
  worktreePath?: string | null;
  envMode?: DraftThreadEnvMode;
  entryPoint?: ThreadPrimarySurface;
}

interface ActiveThreadSnapshot {
  projectId: ProjectId;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
}

export interface DraftReusePlanStored {
  draftThread: DraftThreadState;
  kind: "stored";
  threadId: ThreadId;
}

export interface DraftReusePlanRoute {
  draftThread: DraftThreadState;
  kind: "route";
  threadId: ThreadId;
}

export interface DraftReusePlanFresh {
  kind: "fresh";
}

export type ThreadBootstrapPlan = DraftReusePlanStored | DraftReusePlanRoute | DraftReusePlanFresh;

interface ResolveTerminalThreadCreationStateInput {
  activeDraftThread: DraftThreadState | null;
  activeThread: ActiveThreadSnapshot | null;
  draftComposerState: ComposerThreadDraftState | null;
  draftThread: DraftThreadState | null;
  options: NewThreadOptions | undefined;
  projectDefaultModelSelection: ModelSelection | null;
  projectId: ProjectId;
}

export interface TerminalThreadCreationState {
  branch: string | null;
  interactionMode: ProviderInteractionMode;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  worktreePath: string | null;
}

// Normalize the currently active server thread into a stable snapshot for pure helpers.
export function createActiveThreadSnapshot(
  activeThread:
    | {
        interactionMode: ProviderInteractionMode;
        modelSelection: ModelSelection;
        projectId: ProjectId;
        runtimeMode: RuntimeMode;
      }
    | null
    | undefined,
  projectId: ProjectId,
): ActiveThreadSnapshot | null {
  if (!activeThread || activeThread.projectId !== projectId) {
    return null;
  }
  return {
    projectId: activeThread.projectId,
    modelSelection: activeThread.modelSelection,
    runtimeMode: activeThread.runtimeMode,
    interactionMode: activeThread.interactionMode,
  };
}

// Normalize the currently active draft thread into a stable snapshot for pure helpers.
export function createActiveDraftThreadSnapshot(
  activeDraftThread: DraftThreadState | null | undefined,
  projectId: ProjectId,
): DraftThreadState | null {
  if (!activeDraftThread || activeDraftThread.projectId !== projectId) {
    return null;
  }
  return {
    projectId: activeDraftThread.projectId,
    createdAt: activeDraftThread.createdAt,
    runtimeMode: activeDraftThread.runtimeMode,
    interactionMode: activeDraftThread.interactionMode,
    entryPoint: activeDraftThread.entryPoint,
    branch: activeDraftThread.branch,
    worktreePath: activeDraftThread.worktreePath,
    envMode: activeDraftThread.envMode,
  };
}

// Decide whether we should reuse a stored draft, the current route draft, or create a fresh one.
export function resolveThreadBootstrapPlan(input: {
  entryPoint: ThreadPrimarySurface;
  latestActiveDraftThread: DraftThreadState | null;
  projectId: ProjectId;
  routeThreadId: ThreadId | null;
  storedDraftThread: ({ threadId: ThreadId } & DraftThreadState) | null;
}): ThreadBootstrapPlan {
  if (input.storedDraftThread) {
    return {
      kind: "stored",
      threadId: input.storedDraftThread.threadId,
      draftThread: input.storedDraftThread,
    };
  }
  if (
    shouldReuseActiveDraftThread({
      draftThread: input.latestActiveDraftThread,
      entryPoint: input.entryPoint,
      projectId: input.projectId,
      routeThreadId: input.routeThreadId,
    })
  ) {
    return {
      kind: "route",
      threadId: input.routeThreadId!,
      draftThread: input.latestActiveDraftThread!,
    };
  }
  return { kind: "fresh" };
}

// Build the initial draft-thread metadata for a brand new thread bootstrap.
export function createFreshDraftThreadSeed(input: {
  createdAt: string;
  entryPoint: ThreadPrimarySurface;
  options: NewThreadOptions | undefined;
}): Omit<DraftThreadState, "projectId" | "interactionMode"> {
  return {
    createdAt: input.createdAt,
    branch: input.options?.branch ?? null,
    worktreePath: input.options?.worktreePath ?? null,
    envMode: input.options?.envMode ?? "local",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    entryPoint: input.entryPoint,
  };
}

// Detect whether the caller wants to override stored draft context before reuse.
export function hasDraftContextOverrides(options?: NewThreadOptions): boolean {
  return (
    options?.branch !== undefined ||
    options?.worktreePath !== undefined ||
    options?.envMode !== undefined
  );
}

// Build the exact patch we should apply to an existing draft before reusing it.
export function buildDraftThreadContextPatch(
  entryPoint: ThreadPrimarySurface,
  options?: NewThreadOptions,
): {
  branch?: string | null;
  entryPoint: ThreadPrimarySurface;
  envMode?: DraftThreadEnvMode;
  worktreePath?: string | null;
} | null {
  if (!hasDraftContextOverrides(options)) {
    return null;
  }
  return {
    ...(options?.branch !== undefined ? { branch: options.branch ?? null } : {}),
    ...(options?.worktreePath !== undefined ? { worktreePath: options.worktreePath ?? null } : {}),
    ...(options?.envMode !== undefined ? { envMode: options.envMode } : {}),
    entryPoint,
  };
}

// Reuse only when the active route draft already belongs to the target project and surface.
export function shouldReuseActiveDraftThread(input: {
  draftThread: DraftThreadState | null;
  entryPoint: ThreadPrimarySurface;
  projectId: ProjectId;
  routeThreadId: ThreadId | null;
}): input is {
  draftThread: DraftThreadState;
  entryPoint: ThreadPrimarySurface;
  projectId: ProjectId;
  routeThreadId: ThreadId;
} {
  return Boolean(
    input.draftThread &&
    input.routeThreadId &&
    input.draftThread.projectId === input.projectId &&
    input.draftThread.entryPoint === input.entryPoint,
  );
}

// Resolve the durable thread payload for terminal-first promotion from the most specific state.
export function resolveTerminalThreadCreationState(
  input: ResolveTerminalThreadCreationStateInput,
): TerminalThreadCreationState {
  return {
    modelSelection: resolvePreferredComposerModelSelection({
      draft: input.draftComposerState,
      threadModelSelection:
        input.activeThread?.projectId === input.projectId
          ? input.activeThread.modelSelection
          : null,
      projectModelSelection: input.projectDefaultModelSelection,
    }),
    runtimeMode:
      input.draftThread?.runtimeMode ??
      (input.activeThread?.projectId === input.projectId ? input.activeThread.runtimeMode : null) ??
      (input.activeDraftThread?.projectId === input.projectId
        ? input.activeDraftThread.runtimeMode
        : null) ??
      DEFAULT_RUNTIME_MODE,
    interactionMode:
      input.draftThread?.interactionMode ??
      (input.activeThread?.projectId === input.projectId
        ? input.activeThread.interactionMode
        : null) ??
      DEFAULT_INTERACTION_MODE,
    branch:
      input.options?.branch !== undefined
        ? (input.options.branch ?? null)
        : (input.draftThread?.branch ?? null),
    worktreePath:
      input.options?.worktreePath !== undefined
        ? (input.options.worktreePath ?? null)
        : (input.draftThread?.worktreePath ?? null),
  };
}
