// FILE: composerDraft/draftThreads.ts
// Purpose: Reducers for draft-thread lifecycle (per-project mapping, context updates, promotion, clearing).
// Layer: Web state store (reducers)
// Exports: SetProjectDraftThreadOptions, SetDraftThreadContextOptions, and the draft-thread lifecycle reducers

import type {
  OrchestrationThreadPullRequest,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type ThreadPrimarySurface,
} from "../types";
import { revokeDraftPreviewUrls } from "./cleanup";
import {
  projectDraftThreadMappingKey,
  projectIdFromDraftThreadMappingKey,
} from "./draftThreadKeys";
import { normalizeDraftThreadEntryPoint } from "./persistence";
import type {
  ComposerDraftStoreState,
  DraftThreadEnvMode,
  DraftThreadState,
} from "../composerDraftStore";

export interface SetProjectDraftThreadOptions {
  branch?: string | null;
  worktreePath?: string | null;
  lastKnownPr?: OrchestrationThreadPullRequest | null;
  createdAt?: string;
  envMode?: DraftThreadEnvMode;
  runtimeMode?: RuntimeMode;
  interactionMode?: ProviderInteractionMode;
  entryPoint?: ThreadPrimarySurface;
  isTemporary?: boolean;
}

export interface SetDraftThreadContextOptions {
  branch?: string | null;
  worktreePath?: string | null;
  lastKnownPr?: OrchestrationThreadPullRequest | null;
  projectId?: ProjectId;
  createdAt?: string;
  envMode?: DraftThreadEnvMode;
  runtimeMode?: RuntimeMode;
  interactionMode?: ProviderInteractionMode;
  entryPoint?: ThreadPrimarySurface;
  isTemporary?: boolean;
}

type StateChange = ComposerDraftStoreState | Partial<ComposerDraftStoreState>;

export function setProjectDraftThreadIdReducer(
  state: ComposerDraftStoreState,
  projectId: ProjectId,
  threadId: ThreadId,
  options: SetProjectDraftThreadOptions | undefined,
): StateChange {
  const existingThread = state.draftThreadsByThreadId[threadId];
  const entryPoint = normalizeDraftThreadEntryPoint(
    options?.entryPoint,
    existingThread?.entryPoint ?? "chat",
  );
  const mappingKey = projectDraftThreadMappingKey(projectId, entryPoint);
  const previousThreadIdForProject = state.projectDraftThreadIdByProjectId[mappingKey];
  const nextWorktreePath =
    options?.worktreePath === undefined
      ? (existingThread?.worktreePath ?? null)
      : (options.worktreePath ?? null);
  const nextIsTemporary =
    options?.isTemporary === true
      ? true
      : options?.isTemporary === false
        ? false
        : existingThread?.isTemporary === true;
  const nextPromotedTo = existingThread?.promotedTo;
  const nextDraftThread: DraftThreadState = {
    projectId,
    createdAt: options?.createdAt ?? existingThread?.createdAt ?? new Date().toISOString(),
    runtimeMode: options?.runtimeMode ?? existingThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
    interactionMode:
      options?.interactionMode ?? existingThread?.interactionMode ?? DEFAULT_INTERACTION_MODE,
    entryPoint,
    branch:
      options?.branch === undefined ? (existingThread?.branch ?? null) : (options.branch ?? null),
    worktreePath: nextWorktreePath,
    lastKnownPr:
      options?.lastKnownPr === undefined
        ? (existingThread?.lastKnownPr ?? null)
        : (options.lastKnownPr ?? null),
    envMode:
      options?.envMode ?? (nextWorktreePath ? "worktree" : (existingThread?.envMode ?? "local")),
    ...(nextIsTemporary ? { isTemporary: true } : {}),
    ...(nextPromotedTo ? { promotedTo: nextPromotedTo } : {}),
  };
  const hasSameProjectMapping = previousThreadIdForProject === threadId;
  const hasSameDraftThread =
    existingThread &&
    existingThread.projectId === nextDraftThread.projectId &&
    existingThread.createdAt === nextDraftThread.createdAt &&
    existingThread.runtimeMode === nextDraftThread.runtimeMode &&
    existingThread.interactionMode === nextDraftThread.interactionMode &&
    existingThread.entryPoint === nextDraftThread.entryPoint &&
    existingThread.branch === nextDraftThread.branch &&
    existingThread.worktreePath === nextDraftThread.worktreePath &&
    Equal.equals(existingThread.lastKnownPr ?? null, nextDraftThread.lastKnownPr ?? null) &&
    existingThread.envMode === nextDraftThread.envMode &&
    (existingThread.isTemporary === true) === (nextDraftThread.isTemporary === true) &&
    existingThread.promotedTo === nextDraftThread.promotedTo;
  if (hasSameProjectMapping && hasSameDraftThread) {
    return state;
  }
  const nextProjectDraftThreadIdByProjectId: Record<string, ThreadId> = {
    ...state.projectDraftThreadIdByProjectId,
    [mappingKey]: threadId,
  };
  const nextDraftThreadsByThreadId: Record<ThreadId, DraftThreadState> = {
    ...state.draftThreadsByThreadId,
    [threadId]: nextDraftThread,
  };
  let nextDraftsByThreadId = state.draftsByThreadId;
  if (
    previousThreadIdForProject &&
    previousThreadIdForProject !== threadId &&
    !Object.values(nextProjectDraftThreadIdByProjectId).includes(previousThreadIdForProject)
  ) {
    delete nextDraftThreadsByThreadId[previousThreadIdForProject];
    if (state.draftsByThreadId[previousThreadIdForProject] !== undefined) {
      revokeDraftPreviewUrls(state.draftsByThreadId[previousThreadIdForProject]);
      nextDraftsByThreadId = { ...state.draftsByThreadId };
      delete nextDraftsByThreadId[previousThreadIdForProject];
    }
  }
  return {
    draftsByThreadId: nextDraftsByThreadId,
    draftThreadsByThreadId: nextDraftThreadsByThreadId,
    projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
  };
}

export function setDraftThreadContextReducer(
  state: ComposerDraftStoreState,
  threadId: ThreadId,
  options: SetDraftThreadContextOptions,
): StateChange {
  const existing = state.draftThreadsByThreadId[threadId];
  if (!existing) {
    return state;
  }
  const nextProjectId = options.projectId ?? existing.projectId;
  if (nextProjectId.length === 0) {
    return state;
  }
  const nextWorktreePath =
    options.worktreePath === undefined ? existing.worktreePath : (options.worktreePath ?? null);
  const nextEntryPoint = normalizeDraftThreadEntryPoint(options.entryPoint, existing.entryPoint);
  const nextIsTemporary =
    options.isTemporary === true
      ? true
      : options.isTemporary === false
        ? false
        : existing.isTemporary === true;
  const nextPromotedTo = existing.promotedTo;
  const nextDraftThread: DraftThreadState = {
    projectId: nextProjectId,
    createdAt:
      options.createdAt === undefined
        ? existing.createdAt
        : options.createdAt || existing.createdAt,
    runtimeMode: options.runtimeMode ?? existing.runtimeMode,
    interactionMode: options.interactionMode ?? existing.interactionMode,
    entryPoint: nextEntryPoint,
    branch: options.branch === undefined ? existing.branch : (options.branch ?? null),
    worktreePath: nextWorktreePath,
    lastKnownPr:
      options.lastKnownPr === undefined
        ? (existing.lastKnownPr ?? null)
        : (options.lastKnownPr ?? null),
    envMode: options.envMode ?? (nextWorktreePath ? "worktree" : (existing.envMode ?? "local")),
    ...(nextIsTemporary ? { isTemporary: true } : {}),
    ...(nextPromotedTo ? { promotedTo: nextPromotedTo } : {}),
  };
  const isUnchanged =
    nextDraftThread.projectId === existing.projectId &&
    nextDraftThread.createdAt === existing.createdAt &&
    nextDraftThread.runtimeMode === existing.runtimeMode &&
    nextDraftThread.interactionMode === existing.interactionMode &&
    nextDraftThread.entryPoint === existing.entryPoint &&
    nextDraftThread.branch === existing.branch &&
    nextDraftThread.worktreePath === existing.worktreePath &&
    Equal.equals(nextDraftThread.lastKnownPr ?? null, existing.lastKnownPr ?? null) &&
    nextDraftThread.envMode === existing.envMode &&
    (nextDraftThread.isTemporary === true) === (existing.isTemporary === true) &&
    nextDraftThread.promotedTo === existing.promotedTo;
  if (isUnchanged) {
    return state;
  }
  const nextProjectDraftThreadIdByProjectId: Record<string, ThreadId> = {
    ...state.projectDraftThreadIdByProjectId,
  };
  for (const [mappingKey, mappedThreadId] of Object.entries(nextProjectDraftThreadIdByProjectId)) {
    if (mappedThreadId === threadId) {
      delete nextProjectDraftThreadIdByProjectId[mappingKey];
    }
  }
  nextProjectDraftThreadIdByProjectId[projectDraftThreadMappingKey(nextProjectId, nextEntryPoint)] =
    threadId;
  return {
    draftThreadsByThreadId: {
      ...state.draftThreadsByThreadId,
      [threadId]: nextDraftThread,
    },
    projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
  };
}

export function clearProjectDraftThreadIdReducer(
  state: ComposerDraftStoreState,
  projectId: ProjectId,
  entryPoint: ThreadPrimarySurface,
): StateChange {
  const mappingKey = projectDraftThreadMappingKey(projectId, entryPoint);
  const threadId = state.projectDraftThreadIdByProjectId[mappingKey];
  if (threadId === undefined) {
    return state;
  }
  const { [mappingKey]: _removed, ...restProjectMappingsRaw } =
    state.projectDraftThreadIdByProjectId;
  const restProjectMappings = restProjectMappingsRaw as Record<string, ThreadId>;
  const nextDraftThreadsByThreadId: Record<ThreadId, DraftThreadState> = {
    ...state.draftThreadsByThreadId,
  };
  let nextDraftsByThreadId = state.draftsByThreadId;
  if (!Object.values(restProjectMappings).includes(threadId)) {
    delete nextDraftThreadsByThreadId[threadId];
    if (state.draftsByThreadId[threadId] !== undefined) {
      revokeDraftPreviewUrls(state.draftsByThreadId[threadId]);
      nextDraftsByThreadId = { ...state.draftsByThreadId };
      delete nextDraftsByThreadId[threadId];
    }
  }
  return {
    draftsByThreadId: nextDraftsByThreadId,
    draftThreadsByThreadId: nextDraftThreadsByThreadId,
    projectDraftThreadIdByProjectId: restProjectMappings,
  };
}

export function clearProjectDraftThreadsReducer(
  state: ComposerDraftStoreState,
  projectId: ProjectId,
): StateChange {
  const nextProjectDraftThreadIdByProjectId: Record<string, ThreadId> = {};
  const removedThreadIds = new Set<ThreadId>();
  for (const [mappingKey, threadId] of Object.entries(state.projectDraftThreadIdByProjectId)) {
    if (projectIdFromDraftThreadMappingKey(mappingKey) === projectId) {
      removedThreadIds.add(threadId);
      continue;
    }
    nextProjectDraftThreadIdByProjectId[mappingKey] = threadId;
  }
  if (removedThreadIds.size === 0) {
    return state;
  }
  const retainedThreadIds = new Set(Object.values(nextProjectDraftThreadIdByProjectId));
  const nextDraftThreadsByThreadId: Record<ThreadId, DraftThreadState> = {
    ...state.draftThreadsByThreadId,
  };
  let nextDraftsByThreadId = state.draftsByThreadId;
  for (const threadId of removedThreadIds) {
    if (retainedThreadIds.has(threadId)) continue;
    delete nextDraftThreadsByThreadId[threadId];
    if (state.draftsByThreadId[threadId] !== undefined) {
      revokeDraftPreviewUrls(state.draftsByThreadId[threadId]);
      if (nextDraftsByThreadId === state.draftsByThreadId) {
        nextDraftsByThreadId = { ...state.draftsByThreadId };
      }
      delete nextDraftsByThreadId[threadId];
    }
  }
  return {
    draftsByThreadId: nextDraftsByThreadId,
    draftThreadsByThreadId: nextDraftThreadsByThreadId,
    projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
  };
}

export function clearProjectDraftThreadByIdReducer(
  state: ComposerDraftStoreState,
  projectId: ProjectId,
  threadId: ThreadId,
): StateChange {
  const matchingMappingKey = Object.entries(state.projectDraftThreadIdByProjectId).find(
    ([mappingKey, mappedThreadId]) =>
      projectIdFromDraftThreadMappingKey(mappingKey) === projectId && mappedThreadId === threadId,
  )?.[0];
  if (!matchingMappingKey) {
    return state;
  }
  const { [matchingMappingKey]: _removed, ...restProjectMappingsRaw } =
    state.projectDraftThreadIdByProjectId;
  const restProjectMappings = restProjectMappingsRaw as Record<string, ThreadId>;
  const nextDraftThreadsByThreadId: Record<ThreadId, DraftThreadState> = {
    ...state.draftThreadsByThreadId,
  };
  let nextDraftsByThreadId = state.draftsByThreadId;
  if (!Object.values(restProjectMappings).includes(threadId)) {
    delete nextDraftThreadsByThreadId[threadId];
    if (state.draftsByThreadId[threadId] !== undefined) {
      revokeDraftPreviewUrls(state.draftsByThreadId[threadId]);
      nextDraftsByThreadId = { ...state.draftsByThreadId };
      delete nextDraftsByThreadId[threadId];
    }
  }
  return {
    draftsByThreadId: nextDraftsByThreadId,
    draftThreadsByThreadId: nextDraftThreadsByThreadId,
    projectDraftThreadIdByProjectId: restProjectMappings,
  };
}

export function markDraftThreadPromotingReducer(
  state: ComposerDraftStoreState,
  threadId: ThreadId,
  promotedTo: ThreadId | undefined,
): StateChange {
  const existing = state.draftThreadsByThreadId[threadId];
  if (!existing) {
    return state;
  }
  const nextPromotedTo = promotedTo ?? threadId;
  if (existing.promotedTo === nextPromotedTo) {
    return state;
  }
  return {
    draftThreadsByThreadId: {
      ...state.draftThreadsByThreadId,
      [threadId]: {
        ...existing,
        promotedTo: nextPromotedTo,
      },
    },
  };
}

export function clearDraftThreadReducer(
  state: ComposerDraftStoreState,
  threadId: ThreadId,
): StateChange {
  const hasDraftThread = state.draftThreadsByThreadId[threadId] !== undefined;
  const hasProjectMapping = Object.values(state.projectDraftThreadIdByProjectId).includes(threadId);
  const hasComposerDraft = state.draftsByThreadId[threadId] !== undefined;
  if (!hasDraftThread && !hasProjectMapping && !hasComposerDraft) {
    return state;
  }
  const nextProjectDraftThreadIdByProjectId = Object.fromEntries(
    Object.entries(state.projectDraftThreadIdByProjectId).filter(
      ([, draftThreadId]) => draftThreadId !== threadId,
    ),
  ) as Record<string, ThreadId>;
  const { [threadId]: _removedDraftThread, ...restDraftThreadsByThreadId } =
    state.draftThreadsByThreadId;
  const { [threadId]: _removedComposerDraft, ...restDraftsByThreadId } = state.draftsByThreadId;
  return {
    draftsByThreadId: restDraftsByThreadId,
    draftThreadsByThreadId: restDraftThreadsByThreadId,
    projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
  };
}
