// FILE: store.ts
// Purpose: Normalizes orchestration snapshots into stable client state for the web app.
// Exports: Zustand store plus pure state transition helpers shared by runtime bootstrap flows.

import { Fragment, type ReactNode, createElement, useEffect } from "react";
import {
  type OrchestrationEvent,
  type ProviderKind,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationSessionStatus,
} from "@t3tools/contracts";
import { resolveThreadBranchRegressionGuard } from "@t3tools/shared/git";
import { resolveModelSlugForProvider } from "@t3tools/shared/model";
import { normalizeWorkspaceRootForComparison } from "@t3tools/shared/threadWorkspace";
import { create } from "zustand";
import {
  type ChatAttachment,
  type ChatMessage,
  type Project,
  type SidebarThreadSummary,
  type Thread,
  type ThreadWorkspacePatch,
} from "./types";
import { Debouncer } from "@tanstack/react-pacer";
import { hasLiveTurnTailWork } from "./session-logic";
import { deriveThreadSummaryMetadata } from "@t3tools/shared/threadSummary";

// ── State ────────────────────────────────────────────────────────────

export interface AppState {
  projects: Project[];
  threads: Thread[];
  sidebarThreadSummaryById: Record<string, SidebarThreadSummary>;
  threadsHydrated: boolean;
}

type ReadModelProject = OrchestrationReadModel["projects"][number];
type ReadModelThread = OrchestrationReadModel["threads"][number];
type ReadModelMessage = OrchestrationReadModel["threads"][number]["messages"][number];
type ThreadMessageSentEvent = Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

const PERSISTED_STATE_KEY = "t3code:renderer-state:v8";
const LEGACY_PERSISTED_STATE_KEYS = [
  "t3code:renderer-state:v7",
  "t3code:renderer-state:v6",
  "t3code:renderer-state:v5",
  "t3code:renderer-state:v4",
  "t3code:renderer-state:v3",
  "codething:renderer-state:v4",
  "codething:renderer-state:v3",
  "codething:renderer-state:v2",
  "codething:renderer-state:v1",
] as const;
const MAX_THREAD_MESSAGES = 2_000;

const initialState: AppState = {
  projects: [],
  threads: [],
  sidebarThreadSummaryById: {},
  threadsHydrated: false,
};
const persistedExpandedProjectCwds = new Set<string>();
const persistedProjectOrderCwds: string[] = [];
const persistedProjectNamesByCwd = new Map<string, string>();

function projectCwdKey(cwd: string): string {
  return normalizeWorkspaceRootForComparison(cwd);
}

function basenameOfPath(value: string): string | null {
  const segments = value.split(/[/\\]/).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? null;
}

function rememberProjectUiState(projects: ReadonlyArray<Pick<Project, "cwd" | "expanded">>): void {
  for (const project of projects) {
    const cwdKey = projectCwdKey(project.cwd);
    if (project.expanded) {
      persistedExpandedProjectCwds.add(cwdKey);
    } else {
      persistedExpandedProjectCwds.delete(cwdKey);
    }
    if (!persistedProjectOrderCwds.includes(cwdKey)) {
      persistedProjectOrderCwds.push(cwdKey);
    }
  }
}

function rememberProjectLocalNames(
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

// ── Persist helpers ──────────────────────────────────────────────────

function readPersistedState(): AppState {
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
    persistedProjectNamesByCwd.clear();
    for (const cwd of parsed.expandedProjectCwds ?? []) {
      if (typeof cwd === "string" && cwd.length > 0) {
        persistedExpandedProjectCwds.add(projectCwdKey(cwd));
      }
    }
    for (const cwd of parsed.projectOrderCwds ?? []) {
      const cwdKey = typeof cwd === "string" ? projectCwdKey(cwd) : "";
      if (cwdKey.length > 0 && !persistedProjectOrderCwds.includes(cwdKey)) {
        persistedProjectOrderCwds.push(cwdKey);
      }
    }
    for (const [cwd, name] of Object.entries(parsed.projectNamesByCwd ?? {})) {
      if (typeof cwd !== "string" || cwd.length === 0) continue;
      if (typeof name !== "string") continue;
      const trimmedName = name.trim();
      if (trimmedName.length === 0) continue;
      persistedProjectNamesByCwd.set(projectCwdKey(cwd), trimmedName);
    }
    return { ...initialState };
  } catch {
    return initialState;
  }
}

let legacyKeysCleanedUp = false;

function persistState(state: AppState): void {
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
    if (!legacyKeysCleanedUp) {
      legacyKeysCleanedUp = true;
      for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
        window.localStorage.removeItem(legacyKey);
      }
    }
  } catch {
    // Ignore quota/storage errors to avoid breaking chat UX.
  }
}
const debouncedPersistState = new Debouncer(persistState, { wait: 500 });

// ── Pure helpers ──────────────────────────────────────────────────────

function updateThread(
  threads: Thread[],
  threadId: ThreadId,
  updater: (t: Thread) => Thread,
): Thread[] {
  let changed = false;
  const next = threads.map((t) => {
    if (t.id !== threadId) return t;
    const updated = updater(t);
    if (updated !== t) changed = true;
    return updated;
  });
  return changed ? next : threads;
}

// Reuse unchanged branches from the read model so per-thread selectors stay stable during streaming.
function arraysShallowEqual<T>(
  left: ReadonlyArray<T> | undefined,
  right: ReadonlyArray<T>,
): left is ReadonlyArray<T> {
  if (!left || left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function recordsShallowEqual<T>(left: Record<string, T>, right: Record<string, T>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (const key of leftKeys) {
    if (!(key in right) || left[key] !== right[key]) {
      return false;
    }
  }
  return true;
}

function deepEqualJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (left == null || right == null || typeof left !== typeof right) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    for (let index = 0; index < left.length; index += 1) {
      if (!deepEqualJson(left[index], right[index])) {
        return false;
      }
    }
    return true;
  }
  if (typeof left !== "object" || typeof right !== "object") {
    return false;
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (const key of leftKeys) {
    if (!(key in rightRecord) || !deepEqualJson(leftRecord[key], rightRecord[key])) {
      return false;
    }
  }
  return true;
}

function normalizeModelSelection<T extends { provider: ProviderKind; model: string }>(
  value: T,
  previous: T | null | undefined,
): T {
  const normalizedModel = resolveModelSlugForProvider(value.provider, value.model);
  const next = normalizedModel === value.model ? value : { ...value, model: normalizedModel };
  return previous && deepEqualJson(previous, next) ? previous : next;
}

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

function normalizeProjectFromReadModel(
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

function upsertProjectFromReadModel(state: AppState, incoming: ReadModelProject): AppState {
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

function normalizeChatAttachments(
  incoming: ReadModelMessage["attachments"],
  previous: ChatAttachment[] | undefined,
): ChatAttachment[] | undefined {
  if (!incoming || incoming.length === 0) {
    return undefined;
  }

  const previousById = new Map(previous?.map((attachment) => [attachment.id, attachment] as const));
  const nextAttachments = incoming.map((attachment) => {
    const nextAttachment: ChatAttachment = {
      type: "image",
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      previewUrl: toAttachmentPreviewUrl(attachmentPreviewRoutePath(attachment.id)),
    };
    const existing = previousById.get(attachment.id);
    if (
      existing &&
      existing.name === nextAttachment.name &&
      existing.mimeType === nextAttachment.mimeType &&
      existing.sizeBytes === nextAttachment.sizeBytes &&
      existing.previewUrl === nextAttachment.previewUrl
    ) {
      return existing;
    }
    return nextAttachment;
  });

  return arraysShallowEqual(previous, nextAttachments) ? previous : nextAttachments;
}

function normalizeChatMessage(
  incoming: ReadModelMessage,
  previous: ChatMessage | undefined,
): ChatMessage {
  const attachments = normalizeChatAttachments(incoming.attachments, previous?.attachments);
  const completedAt = incoming.streaming ? undefined : incoming.updatedAt;
  if (
    previous &&
    previous.role === incoming.role &&
    previous.text === incoming.text &&
    previous.turnId === incoming.turnId &&
    previous.createdAt === incoming.createdAt &&
    previous.streaming === incoming.streaming &&
    previous.source === incoming.source &&
    previous.completedAt === completedAt &&
    previous.attachments === attachments
  ) {
    return previous;
  }

  return {
    id: incoming.id,
    role: incoming.role,
    text: incoming.text,
    turnId: incoming.turnId,
    createdAt: incoming.createdAt,
    streaming: incoming.streaming,
    source: incoming.source,
    ...(completedAt ? { completedAt } : {}),
    ...(attachments ? { attachments } : {}),
  };
}

function normalizeChatMessages(
  incoming: ReadModelThread["messages"],
  previous: ChatMessage[] | undefined,
): ChatMessage[] {
  const previousById = new Map(previous?.map((message) => [message.id, message] as const));
  const nextMessages = incoming.map((message) =>
    normalizeChatMessage(message, previousById.get(message.id)),
  );
  return arraysShallowEqual(previous, nextMessages) ? previous : nextMessages;
}

function normalizeProposedPlans(
  incoming: ReadModelThread["proposedPlans"],
  previous: Thread["proposedPlans"] | undefined,
): Thread["proposedPlans"] {
  const previousById = new Map(previous?.map((plan) => [plan.id, plan] as const));
  const nextPlans = incoming.map((plan) => {
    const existing = previousById.get(plan.id);
    if (
      existing &&
      existing.turnId === plan.turnId &&
      existing.planMarkdown === plan.planMarkdown &&
      existing.implementedAt === plan.implementedAt &&
      existing.implementationThreadId === plan.implementationThreadId &&
      existing.createdAt === plan.createdAt &&
      existing.updatedAt === plan.updatedAt
    ) {
      return existing;
    }
    return {
      id: plan.id,
      turnId: plan.turnId,
      planMarkdown: plan.planMarkdown,
      implementedAt: plan.implementedAt,
      implementationThreadId: plan.implementationThreadId,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
    };
  });
  return arraysShallowEqual(previous, nextPlans) ? previous : nextPlans;
}

function normalizeTurnDiffFiles(
  incoming: ReadonlyArray<Thread["turnDiffSummaries"][number]["files"][number]>,
  previous: Thread["turnDiffSummaries"][number]["files"] | undefined,
): Thread["turnDiffSummaries"][number]["files"] {
  const nextFiles = incoming.map((file, index) => {
    const existing = previous?.[index];
    if (
      existing &&
      existing.path === file.path &&
      existing.kind === file.kind &&
      existing.additions === file.additions &&
      existing.deletions === file.deletions
    ) {
      return existing;
    }
    return file;
  });
  return arraysShallowEqual(previous, nextFiles) ? previous : nextFiles;
}

function normalizeTurnDiffSummaries(
  incoming: ReadModelThread["checkpoints"],
  previous: Thread["turnDiffSummaries"] | undefined,
): Thread["turnDiffSummaries"] {
  const previousByTurnId = new Map(previous?.map((summary) => [summary.turnId, summary] as const));
  const nextSummaries = incoming.map((checkpoint) => {
    const existing = previousByTurnId.get(checkpoint.turnId);
    const files = normalizeTurnDiffFiles(checkpoint.files, existing?.files);
    if (
      existing &&
      existing.completedAt === checkpoint.completedAt &&
      existing.status === checkpoint.status &&
      existing.assistantMessageId === (checkpoint.assistantMessageId ?? undefined) &&
      existing.checkpointTurnCount === checkpoint.checkpointTurnCount &&
      existing.checkpointRef === checkpoint.checkpointRef &&
      existing.files === files
    ) {
      return existing;
    }
    return {
      turnId: checkpoint.turnId,
      completedAt: checkpoint.completedAt,
      status: checkpoint.status,
      assistantMessageId: checkpoint.assistantMessageId ?? undefined,
      checkpointTurnCount: checkpoint.checkpointTurnCount,
      checkpointRef: checkpoint.checkpointRef,
      files,
    };
  });
  return arraysShallowEqual(previous, nextSummaries) ? previous : nextSummaries;
}

function normalizeActivities(
  incoming: ReadModelThread["activities"],
  previous: Thread["activities"] | undefined,
): Thread["activities"] {
  const previousById = new Map(previous?.map((activity) => [activity.id, activity] as const));
  const nextActivities = incoming.map((activity) => {
    const existing = previousById.get(activity.id);
    if (
      existing &&
      existing.kind === activity.kind &&
      existing.tone === activity.tone &&
      existing.summary === activity.summary &&
      deepEqualJson(existing.payload, activity.payload) &&
      existing.turnId === activity.turnId &&
      existing.sequence === activity.sequence &&
      existing.createdAt === activity.createdAt
    ) {
      return existing;
    }
    return activity;
  });
  return arraysShallowEqual(previous, nextActivities) ? previous : nextActivities;
}

function isNonFatalThreadErrorMessage(message: string | null | undefined): boolean {
  if (!message) {
    return false;
  }
  const normalized = message.trim().toLowerCase();
  return normalized.includes("write_stdin failed: stdin is closed for this session");
}

function normalizeThreadErrorMessage(message: string | null | undefined): string | null {
  return message && !isNonFatalThreadErrorMessage(message) ? message : null;
}

function normalizeThreadSession(
  incoming: ReadModelThread["session"],
  previous: Thread["session"] | undefined | null,
): Thread["session"] {
  if (!incoming) {
    return null;
  }
  const nextLastError =
    incoming.lastError && !isNonFatalThreadErrorMessage(incoming.lastError)
      ? incoming.lastError
      : undefined;
  const nextSession = {
    provider: toLegacyProvider(incoming.providerName),
    status: toLegacySessionStatus(incoming.status),
    orchestrationStatus: incoming.status,
    activeTurnId: incoming.activeTurnId ?? undefined,
    createdAt: incoming.updatedAt,
    updatedAt: incoming.updatedAt,
    ...(nextLastError ? { lastError: nextLastError } : {}),
  } satisfies NonNullable<Thread["session"]>;
  if (
    previous &&
    previous.provider === nextSession.provider &&
    previous.status === nextSession.status &&
    previous.orchestrationStatus === nextSession.orchestrationStatus &&
    previous.activeTurnId === nextSession.activeTurnId &&
    previous.createdAt === nextSession.createdAt &&
    previous.updatedAt === nextSession.updatedAt &&
    previous.lastError === nextSession.lastError
  ) {
    return previous;
  }
  return nextSession;
}

function normalizeLatestTurn(
  incoming: ReadModelThread["latestTurn"],
  previous: Thread["latestTurn"] | undefined | null,
): Thread["latestTurn"] {
  if (!incoming) {
    return null;
  }
  const nextSourceProposedPlan = incoming.sourceProposedPlan
    ? previous?.sourceProposedPlan &&
      previous.sourceProposedPlan.threadId === incoming.sourceProposedPlan.threadId &&
      previous.sourceProposedPlan.planId === incoming.sourceProposedPlan.planId
      ? previous.sourceProposedPlan
      : incoming.sourceProposedPlan
    : undefined;

  if (
    previous &&
    previous.turnId === incoming.turnId &&
    previous.state === incoming.state &&
    previous.requestedAt === incoming.requestedAt &&
    previous.startedAt === incoming.startedAt &&
    previous.completedAt === incoming.completedAt &&
    previous.assistantMessageId === incoming.assistantMessageId &&
    previous.sourceProposedPlan === nextSourceProposedPlan
  ) {
    return previous;
  }

  return {
    turnId: incoming.turnId,
    state: incoming.state,
    requestedAt: incoming.requestedAt,
    startedAt: incoming.startedAt,
    completedAt: incoming.completedAt,
    assistantMessageId: incoming.assistantMessageId,
    ...(nextSourceProposedPlan ? { sourceProposedPlan: nextSourceProposedPlan } : {}),
  };
}

function normalizeThreadFromReadModel(
  incoming: ReadModelThread,
  previous: Thread | undefined,
): Thread {
  const modelSelection = normalizeModelSelection(incoming.modelSelection, previous?.modelSelection);
  const session = normalizeThreadSession(incoming.session, previous?.session);
  const messages = normalizeChatMessages(incoming.messages, previous?.messages);
  const proposedPlans = normalizeProposedPlans(incoming.proposedPlans, previous?.proposedPlans);
  const latestTurn = normalizeLatestTurn(incoming.latestTurn, previous?.latestTurn);
  const handoff =
    previous?.handoff && incoming.handoff && deepEqualJson(previous.handoff, incoming.handoff)
      ? previous.handoff
      : (incoming.handoff ?? null);
  const turnDiffSummaries = normalizeTurnDiffSummaries(
    incoming.checkpoints,
    previous?.turnDiffSummaries,
  );
  const activities = normalizeActivities(incoming.activities, previous?.activities);
  const error = normalizeThreadErrorMessage(incoming.session?.lastError);
  const lastVisitedAt = previous?.lastVisitedAt ?? incoming.updatedAt;
  const resolvedLatestUserMessageAt =
    Object.hasOwn(incoming, "latestUserMessageAt") && incoming.latestUserMessageAt !== undefined
      ? (incoming.latestUserMessageAt ?? null)
      : undefined;
  const resolvedHasPendingApprovals =
    typeof incoming.hasPendingApprovals === "boolean" ? incoming.hasPendingApprovals : undefined;
  const resolvedHasPendingUserInput =
    typeof incoming.hasPendingUserInput === "boolean" ? incoming.hasPendingUserInput : undefined;
  const resolvedHasActionableProposedPlan =
    typeof incoming.hasActionableProposedPlan === "boolean"
      ? incoming.hasActionableProposedPlan
      : undefined;
  const resolvedBranch = resolveThreadBranchRegressionGuard({
    currentBranch: previous?.branch ?? null,
    nextBranch: incoming.branch,
  });
  const pendingSourceProposedPlan =
    latestTurn?.sourceProposedPlan ??
    (incoming.session?.status === "running" ? previous?.pendingSourceProposedPlan : undefined);

  if (
    previous &&
    previous.projectId === incoming.projectId &&
    previous.title === incoming.title &&
    previous.modelSelection === modelSelection &&
    previous.runtimeMode === incoming.runtimeMode &&
    previous.interactionMode === incoming.interactionMode &&
    previous.session === session &&
    previous.messages === messages &&
    previous.proposedPlans === proposedPlans &&
    previous.error === error &&
    previous.createdAt === incoming.createdAt &&
    (previous.archivedAt ?? null) === (incoming.archivedAt ?? null) &&
    previous.updatedAt === incoming.updatedAt &&
    previous.latestTurn === latestTurn &&
    previous.pendingSourceProposedPlan === pendingSourceProposedPlan &&
    previous.lastVisitedAt === lastVisitedAt &&
    (previous.parentThreadId ?? null) === (incoming.parentThreadId ?? null) &&
    (previous.subagentAgentId ?? null) === (incoming.subagentAgentId ?? null) &&
    (previous.subagentNickname ?? null) === (incoming.subagentNickname ?? null) &&
    (previous.subagentRole ?? null) === (incoming.subagentRole ?? null) &&
    previous.envMode === (incoming.envMode ?? "local") &&
    previous.branch === resolvedBranch &&
    previous.worktreePath === incoming.worktreePath &&
    (previous.associatedWorktreePath ?? null) === (incoming.associatedWorktreePath ?? null) &&
    (previous.associatedWorktreeBranch ?? null) === (incoming.associatedWorktreeBranch ?? null) &&
    (previous.associatedWorktreeRef ?? null) === (incoming.associatedWorktreeRef ?? null) &&
    previous.latestUserMessageAt === resolvedLatestUserMessageAt &&
    previous.hasPendingApprovals === resolvedHasPendingApprovals &&
    previous.hasPendingUserInput === resolvedHasPendingUserInput &&
    previous.hasActionableProposedPlan === resolvedHasActionableProposedPlan &&
    (previous.forkSourceThreadId ?? null) === (incoming.forkSourceThreadId ?? null) &&
    (previous.handoff ?? null) === handoff &&
    previous.turnDiffSummaries === turnDiffSummaries &&
    previous.activities === activities
  ) {
    return previous;
  }

  return {
    id: incoming.id,
    codexThreadId: null,
    projectId: incoming.projectId,
    title: incoming.title,
    modelSelection,
    runtimeMode: incoming.runtimeMode,
    interactionMode: incoming.interactionMode,
    session,
    messages,
    proposedPlans,
    error,
    createdAt: incoming.createdAt,
    archivedAt: incoming.archivedAt ?? null,
    updatedAt: incoming.updatedAt,
    latestTurn,
    ...(pendingSourceProposedPlan ? { pendingSourceProposedPlan } : {}),
    lastVisitedAt,
    parentThreadId: incoming.parentThreadId ?? null,
    subagentAgentId: incoming.subagentAgentId ?? null,
    subagentNickname: incoming.subagentNickname ?? null,
    subagentRole: incoming.subagentRole ?? null,
    envMode: incoming.envMode ?? "local",
    branch: resolvedBranch,
    worktreePath: incoming.worktreePath,
    associatedWorktreePath: incoming.associatedWorktreePath ?? null,
    associatedWorktreeBranch: incoming.associatedWorktreeBranch ?? null,
    associatedWorktreeRef: incoming.associatedWorktreeRef ?? null,
    forkSourceThreadId: incoming.forkSourceThreadId ?? null,
    handoff,
    ...(resolvedLatestUserMessageAt !== undefined
      ? { latestUserMessageAt: resolvedLatestUserMessageAt }
      : {}),
    ...(resolvedHasPendingApprovals !== undefined
      ? { hasPendingApprovals: resolvedHasPendingApprovals }
      : {}),
    ...(resolvedHasPendingUserInput !== undefined
      ? { hasPendingUserInput: resolvedHasPendingUserInput }
      : {}),
    ...(resolvedHasActionableProposedPlan !== undefined
      ? { hasActionableProposedPlan: resolvedHasActionableProposedPlan }
      : {}),
    turnDiffSummaries,
    activities,
  };
}

function mapProjectsFromReadModel(
  incoming: OrchestrationReadModel["projects"],
  previous: Project[],
): Project[] {
  const previousById = new Map(previous.map((project) => [project.id, project] as const));
  const previousByCwd = new Map(
    previous.map((project) => [projectCwdKey(project.cwd), project] as const),
  );
  const previousOrderById = new Map(previous.map((project, index) => [project.id, index] as const));
  const previousOrderByCwd = new Map(
    previous.map((project, index) => [projectCwdKey(project.cwd), index] as const),
  );
  const persistedOrderByCwd = new Map(
    persistedProjectOrderCwds.map((cwd, index) => [cwd, index] as const),
  );
  const usePersistedOrder = previous.length === 0;

  const mappedProjects = incoming
    .map((project) => {
      const existing =
        previousById.get(project.id) ?? previousByCwd.get(projectCwdKey(project.workspaceRoot));
      return normalizeProjectFromReadModel(project, existing);
    })
    .map((project, incomingIndex) => {
      const previousIndex =
        previousOrderById.get(project.id) ?? previousOrderByCwd.get(projectCwdKey(project.cwd));
      const persistedIndex = usePersistedOrder
        ? persistedOrderByCwd.get(projectCwdKey(project.cwd))
        : undefined;
      const orderIndex =
        previousIndex ??
        persistedIndex ??
        (usePersistedOrder ? persistedProjectOrderCwds.length : previous.length) + incomingIndex;
      return { project, incomingIndex, orderIndex };
    })
    .toSorted((a, b) => {
      const byOrder = a.orderIndex - b.orderIndex;
      if (byOrder !== 0) return byOrder;
      return a.incomingIndex - b.incomingIndex;
    })
    .map((entry) => entry.project);

  return arraysShallowEqual(previous, mappedProjects) ? previous : mappedProjects;
}

function toLegacySessionStatus(
  status: OrchestrationSessionStatus,
): "connecting" | "ready" | "running" | "error" | "closed" {
  switch (status) {
    case "starting":
      return "connecting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "ready":
    case "interrupted":
      return "ready";
    case "idle":
    case "stopped":
      return "closed";
  }
}

function toLegacyProvider(providerName: string | null): ProviderKind {
  if (providerName === "codex" || providerName === "claudeAgent") {
    return providerName;
  }
  return "codex";
}

function resolveWsHttpOrigin(): string {
  if (typeof window === "undefined") return "";
  const bridgeWsUrl = window.desktopBridge?.getWsUrl?.();
  const envWsUrl = import.meta.env.VITE_WS_URL as string | undefined;
  const wsCandidate =
    typeof bridgeWsUrl === "string" && bridgeWsUrl.length > 0
      ? bridgeWsUrl
      : typeof envWsUrl === "string" && envWsUrl.length > 0
        ? envWsUrl
        : null;
  if (!wsCandidate) return window.location.origin;
  try {
    const wsUrl = new URL(wsCandidate);
    const protocol =
      wsUrl.protocol === "wss:" ? "https:" : wsUrl.protocol === "ws:" ? "http:" : wsUrl.protocol;
    return `${protocol}//${wsUrl.host}`;
  } catch {
    return window.location.origin;
  }
}

function toAttachmentPreviewUrl(rawUrl: string): string {
  if (rawUrl.startsWith("/")) {
    return `${resolveWsHttpOrigin()}${rawUrl}`;
  }
  return rawUrl;
}

function attachmentPreviewRoutePath(attachmentId: string): string {
  return `/attachments/${encodeURIComponent(attachmentId)}`;
}

function resolveThreadSidebarMetadata(
  thread: Thread,
): Pick<
  SidebarThreadSummary,
  | "latestUserMessageAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "hasActionableProposedPlan"
  | "hasLiveTailWork"
> {
  const derivedMetadata = deriveThreadSummaryMetadata({
    messages: thread.messages,
    activities: thread.activities,
    proposedPlans: thread.proposedPlans,
    latestTurn: thread.latestTurn,
  });

  return {
    latestUserMessageAt: thread.latestUserMessageAt ?? derivedMetadata.latestUserMessageAt,
    hasPendingApprovals: thread.hasPendingApprovals ?? derivedMetadata.hasPendingApprovals,
    hasPendingUserInput: thread.hasPendingUserInput ?? derivedMetadata.hasPendingUserInput,
    hasActionableProposedPlan:
      thread.hasActionableProposedPlan ?? derivedMetadata.hasActionableProposedPlan,
    hasLiveTailWork: Boolean(
      hasLiveTurnTailWork({
        latestTurn: thread.latestTurn,
        messages: thread.messages,
        activities: thread.activities,
        session: thread.session,
      }),
    ),
  };
}

function sidebarThreadSummariesEqual(
  left: SidebarThreadSummary | undefined,
  right: SidebarThreadSummary,
): boolean {
  return (
    left !== undefined &&
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.title === right.title &&
    left.modelSelection === right.modelSelection &&
    left.interactionMode === right.interactionMode &&
    left.envMode === right.envMode &&
    left.worktreePath === right.worktreePath &&
    left.session === right.session &&
    left.createdAt === right.createdAt &&
    (left.archivedAt ?? null) === (right.archivedAt ?? null) &&
    left.updatedAt === right.updatedAt &&
    left.latestTurn === right.latestTurn &&
    left.lastVisitedAt === right.lastVisitedAt &&
    (left.parentThreadId ?? null) === (right.parentThreadId ?? null) &&
    (left.subagentAgentId ?? null) === (right.subagentAgentId ?? null) &&
    (left.subagentNickname ?? null) === (right.subagentNickname ?? null) &&
    (left.subagentRole ?? null) === (right.subagentRole ?? null) &&
    left.latestUserMessageAt === right.latestUserMessageAt &&
    left.hasPendingApprovals === right.hasPendingApprovals &&
    left.hasPendingUserInput === right.hasPendingUserInput &&
    left.hasActionableProposedPlan === right.hasActionableProposedPlan &&
    left.hasLiveTailWork === right.hasLiveTailWork &&
    (left.forkSourceThreadId ?? null) === (right.forkSourceThreadId ?? null) &&
    (left.handoff ?? null) === (right.handoff ?? null)
  );
}

// Keep sidebar row state lightweight so live thread updates do not force row code
// to rescan every thread message/activity collection on each render.
function buildSidebarThreadSummary(
  thread: Thread,
  previous?: SidebarThreadSummary,
): SidebarThreadSummary {
  const metadata = resolveThreadSidebarMetadata(thread);
  const nextSummary: SidebarThreadSummary = {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: thread.modelSelection,
    interactionMode: thread.interactionMode,
    envMode: thread.envMode,
    worktreePath: thread.worktreePath,
    session: thread.session,
    createdAt: thread.createdAt,
    archivedAt: thread.archivedAt ?? null,
    updatedAt: thread.updatedAt,
    latestTurn: thread.latestTurn,
    lastVisitedAt: thread.lastVisitedAt,
    parentThreadId: thread.parentThreadId ?? null,
    subagentAgentId: thread.subagentAgentId ?? null,
    subagentNickname: thread.subagentNickname ?? null,
    subagentRole: thread.subagentRole ?? null,
    latestUserMessageAt: metadata.latestUserMessageAt,
    hasPendingApprovals: metadata.hasPendingApprovals,
    hasPendingUserInput: metadata.hasPendingUserInput,
    hasActionableProposedPlan: metadata.hasActionableProposedPlan,
    hasLiveTailWork: metadata.hasLiveTailWork,
    forkSourceThreadId: thread.forkSourceThreadId ?? null,
    handoff: thread.handoff ?? null,
  };
  if (previous && sidebarThreadSummariesEqual(previous, nextSummary)) {
    return previous;
  }
  return nextSummary;
}

function normalizeSingleTurnDiffSummary(
  incoming: Thread["turnDiffSummaries"][number],
  previous: Thread["turnDiffSummaries"][number] | undefined,
): Thread["turnDiffSummaries"][number] {
  const files = normalizeTurnDiffFiles(incoming.files, previous?.files);
  if (
    previous &&
    previous.turnId === incoming.turnId &&
    previous.completedAt === incoming.completedAt &&
    previous.status === incoming.status &&
    previous.assistantMessageId === incoming.assistantMessageId &&
    previous.checkpointTurnCount === incoming.checkpointTurnCount &&
    previous.checkpointRef === incoming.checkpointRef &&
    previous.files === files
  ) {
    return previous;
  }
  return {
    ...incoming,
    files,
  };
}

function sortTurnDiffSummaries(
  summaries: ReadonlyArray<Thread["turnDiffSummaries"][number]>,
): Thread["turnDiffSummaries"] {
  return [...summaries].toSorted(
    (left, right) =>
      (left.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER) -
        (right.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER) ||
      left.completedAt.localeCompare(right.completedAt) ||
      left.turnId.localeCompare(right.turnId),
  );
}

function checkpointStatusToLatestTurnState(
  status: Thread["turnDiffSummaries"][number]["status"],
): NonNullable<Thread["latestTurn"]>["state"] {
  if (status === "error") {
    return "error";
  }
  if (status === "missing") {
    return "interrupted";
  }
  return "completed";
}

// Preserve proposed-plan linkage across live turn updates until the snapshot catches up.
function buildLatestTurn(params: {
  previous: Thread["latestTurn"];
  turnId: NonNullable<Thread["latestTurn"]>["turnId"];
  state: NonNullable<Thread["latestTurn"]>["state"];
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  assistantMessageId: NonNullable<Thread["latestTurn"]>["assistantMessageId"];
  sourceProposedPlan?: Thread["pendingSourceProposedPlan"];
}): NonNullable<Thread["latestTurn"]> {
  const sourceProposedPlan =
    params.previous?.turnId === params.turnId
      ? (params.previous.sourceProposedPlan ?? params.sourceProposedPlan)
      : params.sourceProposedPlan;
  return {
    turnId: params.turnId,
    state: params.state,
    requestedAt: params.requestedAt,
    startedAt: params.startedAt,
    completedAt: params.completedAt,
    assistantMessageId: params.assistantMessageId,
    ...(sourceProposedPlan ? { sourceProposedPlan } : {}),
  };
}

function reconcileLatestTurnFromSession(
  thread: Thread,
  session: NonNullable<ReadModelThread["session"]>,
  error: string | null,
): Thread["latestTurn"] {
  if (session.status === "running" && session.activeTurnId !== null) {
    return buildLatestTurn({
      previous: thread.latestTurn,
      turnId: session.activeTurnId,
      state: "running",
      requestedAt:
        thread.latestTurn?.turnId === session.activeTurnId
          ? thread.latestTurn.requestedAt
          : session.updatedAt,
      startedAt:
        thread.latestTurn?.turnId === session.activeTurnId
          ? (thread.latestTurn.startedAt ?? session.updatedAt)
          : session.updatedAt,
      completedAt: null,
      assistantMessageId:
        thread.latestTurn?.turnId === session.activeTurnId
          ? thread.latestTurn.assistantMessageId
          : null,
      sourceProposedPlan: thread.pendingSourceProposedPlan,
    });
  }

  if (
    thread.latestTurn === null ||
    thread.latestTurn.state !== "running" ||
    thread.latestTurn.completedAt !== null
  ) {
    return thread.latestTurn;
  }

  if (
    session.status !== "error" &&
    session.status !== "interrupted" &&
    session.status !== "idle" &&
    session.status !== "stopped"
  ) {
    return thread.latestTurn;
  }

  return buildLatestTurn({
    previous: thread.latestTurn,
    turnId: thread.latestTurn.turnId,
    state: session.status === "error" || error ? "error" : "interrupted",
    requestedAt: thread.latestTurn.requestedAt,
    startedAt: thread.latestTurn.startedAt ?? session.updatedAt,
    completedAt: thread.latestTurn.completedAt ?? session.updatedAt,
    assistantMessageId: thread.latestTurn.assistantMessageId,
  });
}

function rebindTurnDiffSummariesForAssistantMessage(
  turnDiffSummaries: ReadonlyArray<Thread["turnDiffSummaries"][number]>,
  turnId: Thread["turnDiffSummaries"][number]["turnId"],
  assistantMessageId: NonNullable<Thread["latestTurn"]>["assistantMessageId"],
): Thread["turnDiffSummaries"] {
  let changed = false;
  const nextSummaries = turnDiffSummaries.map((summary) => {
    if (summary.turnId !== turnId || summary.assistantMessageId === assistantMessageId) {
      return summary;
    }
    changed = true;
    return {
      ...summary,
      assistantMessageId: assistantMessageId ?? undefined,
    };
  });
  return changed ? nextSummaries : [...turnDiffSummaries];
}

function retainThreadMessagesAfterRevert(
  messages: ReadonlyArray<ChatMessage>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
): ChatMessage[] {
  const retainedMessageIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.id);
      continue;
    }
    if (
      message.turnId !== undefined &&
      message.turnId !== null &&
      retainedTurnIds.has(message.turnId)
    ) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.id),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === undefined ||
            message.turnId === null ||
            retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.id),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === undefined ||
            message.turnId === null ||
            retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.id));
}

function retainThreadActivitiesAfterRevert(
  activities: ReadonlyArray<Thread["activities"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): Thread["activities"] {
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

function retainThreadProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<Thread["proposedPlans"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): Thread["proposedPlans"] {
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

function applyTurnDiffSummaryToThread(
  thread: Thread,
  summary: Thread["turnDiffSummaries"][number],
): Thread {
  const previousSummary = thread.turnDiffSummaries.find(
    (existingSummary) => existingSummary.turnId === summary.turnId,
  );
  const nextSummary = normalizeSingleTurnDiffSummary(summary, previousSummary);
  if (previousSummary && previousSummary.status !== "missing" && nextSummary.status === "missing") {
    return thread;
  }
  const turnDiffSummaries = previousSummary
    ? thread.turnDiffSummaries.map((existingSummary) =>
        existingSummary.turnId === nextSummary.turnId ? nextSummary : existingSummary,
      )
    : sortTurnDiffSummaries([...thread.turnDiffSummaries, nextSummary]);

  const latestTurn =
    thread.latestTurn === null || thread.latestTurn.turnId === nextSummary.turnId
      ? buildLatestTurn({
          previous: thread.latestTurn,
          turnId: nextSummary.turnId,
          state: checkpointStatusToLatestTurnState(nextSummary.status),
          requestedAt: thread.latestTurn?.requestedAt ?? nextSummary.completedAt,
          startedAt: thread.latestTurn?.startedAt ?? nextSummary.completedAt,
          completedAt: nextSummary.completedAt,
          assistantMessageId: nextSummary.assistantMessageId ?? null,
          sourceProposedPlan: thread.pendingSourceProposedPlan,
        })
      : thread.latestTurn;

  if (
    previousSummary === nextSummary &&
    turnDiffSummaries === thread.turnDiffSummaries &&
    latestTurn === thread.latestTurn &&
    (thread.updatedAt ?? thread.createdAt) >= nextSummary.completedAt
  ) {
    return thread;
  }

  return {
    ...thread,
    turnDiffSummaries:
      arraysShallowEqual(thread.turnDiffSummaries, turnDiffSummaries) &&
      thread.turnDiffSummaries.length === turnDiffSummaries.length
        ? thread.turnDiffSummaries
        : turnDiffSummaries,
    latestTurn,
    updatedAt:
      (thread.updatedAt ?? thread.createdAt) > nextSummary.completedAt
        ? thread.updatedAt
        : nextSummary.completedAt,
  };
}

function deriveThreadStateSignals(
  thread: Thread,
): Pick<
  Thread,
  | "latestUserMessageAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "hasActionableProposedPlan"
> {
  const metadata = deriveThreadSummaryMetadata({
    messages: thread.messages,
    activities: thread.activities,
    proposedPlans: thread.proposedPlans,
    latestTurn: thread.latestTurn,
  });
  return {
    latestUserMessageAt: metadata.latestUserMessageAt,
    hasPendingApprovals: metadata.hasPendingApprovals,
    hasPendingUserInput: metadata.hasPendingUserInput,
    hasActionableProposedPlan: metadata.hasActionableProposedPlan,
  };
}

function withDerivedThreadStateSignals(thread: Thread): Thread {
  const nextSignals = deriveThreadStateSignals(thread);
  if (
    thread.latestUserMessageAt === nextSignals.latestUserMessageAt &&
    thread.hasPendingApprovals === nextSignals.hasPendingApprovals &&
    thread.hasPendingUserInput === nextSignals.hasPendingUserInput &&
    thread.hasActionableProposedPlan === nextSignals.hasActionableProposedPlan
  ) {
    return thread;
  }
  return {
    ...thread,
    ...nextSignals,
  };
}

function applyThreadUpdate(
  state: AppState,
  threadId: ThreadId,
  updater: (thread: Thread) => Thread,
): AppState {
  let nextThread: Thread | null = null;
  const threads = updateThread(state.threads, threadId, (thread) => {
    const updatedThread = withDerivedThreadStateSignals(updater(thread));
    if (updatedThread !== thread) {
      nextThread = updatedThread;
    }
    return updatedThread;
  });
  if (threads === state.threads) {
    return state;
  }
  if (nextThread === null) {
    return { ...state, threads };
  }
  const previousSummary = state.sidebarThreadSummaryById[threadId];
  const nextSummary = buildSidebarThreadSummary(nextThread, previousSummary);
  if (nextSummary === previousSummary) {
    return { ...state, threads };
  }
  return {
    ...state,
    threads,
    sidebarThreadSummaryById: {
      ...state.sidebarThreadSummaryById,
      [threadId]: nextSummary,
    },
  };
}

function mergeStreamingMessage(
  existingMessage: ChatMessage,
  incomingMessage: ChatMessage,
): ChatMessage | null {
  const nextText =
    incomingMessage.streaming || incomingMessage.text.length === 0
      ? `${existingMessage.text}${incomingMessage.text}`
      : incomingMessage.text;
  const nextAttachments = incomingMessage.attachments ?? existingMessage.attachments;
  const nextCompletedAt = incomingMessage.streaming
    ? existingMessage.completedAt
    : (incomingMessage.completedAt ?? existingMessage.completedAt);
  const nextTurnId =
    incomingMessage.turnId !== undefined ? incomingMessage.turnId : existingMessage.turnId;
  const nextSource = incomingMessage.source ?? existingMessage.source;

  if (
    existingMessage.text === nextText &&
    existingMessage.streaming === incomingMessage.streaming &&
    existingMessage.attachments === nextAttachments &&
    existingMessage.completedAt === nextCompletedAt &&
    existingMessage.turnId === nextTurnId &&
    existingMessage.source === nextSource
  ) {
    return null;
  }

  return {
    ...existingMessage,
    text: nextText,
    streaming: incomingMessage.streaming,
    ...(nextAttachments ? { attachments: nextAttachments } : {}),
    ...(nextTurnId !== undefined ? { turnId: nextTurnId } : {}),
    ...(nextSource !== undefined ? { source: nextSource } : {}),
    ...(nextCompletedAt !== undefined ? { completedAt: nextCompletedAt } : {}),
  };
}

function applyThreadMessageSentEvent(thread: Thread, event: ThreadMessageSentEvent): Thread {
  const payload = event.payload;
  const incomingMessage = normalizeChatMessage(
    {
      id: payload.messageId,
      role: payload.role,
      text: payload.text,
      turnId: payload.turnId,
      attachments: payload.attachments ?? [],
      streaming: payload.streaming,
      source: payload.source,
      createdAt: payload.createdAt,
      updatedAt: payload.updatedAt,
    },
    thread.messages.find((message) => message.id === payload.messageId),
  );
  const existingIndex = thread.messages.findIndex((message) => message.id === payload.messageId);
  let messages = thread.messages;

  if (existingIndex >= 0) {
    const existingMessage = thread.messages[existingIndex];
    if (!existingMessage) {
      return thread;
    }
    const mergedMessage = mergeStreamingMessage(existingMessage, incomingMessage);
    if (mergedMessage !== null) {
      messages = thread.messages.map((message, index) =>
        index === existingIndex ? mergedMessage : message,
      );
    }
  } else {
    messages = [...thread.messages, incomingMessage].slice(-MAX_THREAD_MESSAGES);
  }

  const turnDiffSummaries =
    payload.role === "assistant" && payload.turnId !== null
      ? rebindTurnDiffSummariesForAssistantMessage(
          thread.turnDiffSummaries,
          payload.turnId,
          payload.messageId,
        )
      : thread.turnDiffSummaries;

  let latestTurn = thread.latestTurn;
  if (
    payload.role === "assistant" &&
    payload.turnId !== null &&
    (thread.latestTurn === null || thread.latestTurn.turnId === payload.turnId)
  ) {
    const previousTurn = thread.latestTurn;
    latestTurn = buildLatestTurn({
      previous: previousTurn,
      turnId: payload.turnId,
      state: payload.streaming
        ? "running"
        : previousTurn?.state === "interrupted"
          ? "interrupted"
          : previousTurn?.state === "error"
            ? "error"
            : "completed",
      requestedAt: previousTurn?.requestedAt ?? payload.createdAt,
      startedAt: previousTurn?.startedAt ?? payload.createdAt,
      completedAt: payload.streaming ? (previousTurn?.completedAt ?? null) : payload.updatedAt,
      assistantMessageId: payload.messageId,
      sourceProposedPlan: thread.pendingSourceProposedPlan,
    });
  }

  const updatedAt =
    thread.updatedAt && thread.updatedAt > payload.updatedAt ? thread.updatedAt : payload.updatedAt;
  if (
    messages === thread.messages &&
    turnDiffSummaries === thread.turnDiffSummaries &&
    latestTurn === thread.latestTurn &&
    updatedAt === thread.updatedAt
  ) {
    return thread;
  }

  return {
    ...thread,
    messages,
    turnDiffSummaries,
    latestTurn,
    updatedAt,
  };
}

function applyOrchestrationEvent(state: AppState, event: OrchestrationEvent): AppState {
  switch (event.type) {
    case "project.created":
      return upsertProjectFromReadModel(state, {
        id: event.payload.projectId,
        title: event.payload.title,
        workspaceRoot: event.payload.workspaceRoot,
        defaultModelSelection: event.payload.defaultModelSelection,
        scripts: event.payload.scripts,
        createdAt: event.payload.createdAt,
        updatedAt: event.payload.updatedAt,
        deletedAt: null,
      });

    case "project.meta-updated": {
      const existingProject = state.projects.find(
        (project) => project.id === event.payload.projectId,
      );
      if (!existingProject) {
        return state;
      }
      return upsertProjectFromReadModel(state, {
        id: existingProject.id,
        title: event.payload.title ?? existingProject.remoteName,
        workspaceRoot: event.payload.workspaceRoot ?? existingProject.cwd,
        defaultModelSelection:
          event.payload.defaultModelSelection !== undefined
            ? event.payload.defaultModelSelection
            : existingProject.defaultModelSelection,
        scripts: event.payload.scripts ?? existingProject.scripts,
        createdAt: existingProject.createdAt ?? event.payload.updatedAt,
        updatedAt: event.payload.updatedAt,
        deletedAt: null,
      });
    }

    case "project.deleted": {
      const existingIndex = state.projects.findIndex(
        (project) => project.id === event.payload.projectId,
      );
      if (existingIndex < 0) {
        return state;
      }
      return {
        ...state,
        projects: state.projects.filter((project) => project.id !== event.payload.projectId),
      };
    }

    case "thread.message-sent":
      return applyThreadUpdate(state, event.payload.threadId, (thread) =>
        applyThreadMessageSentEvent(thread, event),
      );

    case "thread.session-set":
      return applyThreadUpdate(state, event.payload.threadId, (thread) => {
        const session = normalizeThreadSession(event.payload.session, thread.session);
        const error = normalizeThreadErrorMessage(event.payload.session.lastError);
        const latestTurn = reconcileLatestTurnFromSession(thread, event.payload.session, error);
        if (
          session === thread.session &&
          error === thread.error &&
          latestTurn === thread.latestTurn
        ) {
          return thread;
        }
        return {
          ...thread,
          session,
          error,
          latestTurn,
          updatedAt:
            (thread.updatedAt ?? thread.createdAt) > event.occurredAt
              ? thread.updatedAt
              : event.occurredAt,
        };
      });

    case "thread.turn-interrupt-requested": {
      if (event.payload.turnId === undefined) {
        return state;
      }
      return applyThreadUpdate(state, event.payload.threadId, (thread) => {
        const latestTurn = thread.latestTurn;
        if (latestTurn === null || latestTurn.turnId !== event.payload.turnId) {
          return thread;
        }
        return {
          ...thread,
          latestTurn: buildLatestTurn({
            previous: latestTurn,
            turnId: latestTurn.turnId,
            state: "interrupted",
            requestedAt: latestTurn.requestedAt,
            startedAt: latestTurn.startedAt ?? event.payload.createdAt,
            completedAt: latestTurn.completedAt ?? event.payload.createdAt,
            assistantMessageId: latestTurn.assistantMessageId,
          }),
          updatedAt:
            (thread.updatedAt ?? thread.createdAt) > event.occurredAt
              ? thread.updatedAt
              : event.occurredAt,
        };
      });
    }

    case "thread.session-stop-requested":
      return applyThreadUpdate(state, event.payload.threadId, (thread) => {
        if (thread.session === null) {
          return thread;
        }
        const latestTurn =
          thread.latestTurn !== null &&
          thread.latestTurn.state === "running" &&
          thread.latestTurn.completedAt === null
            ? buildLatestTurn({
                previous: thread.latestTurn,
                turnId: thread.latestTurn.turnId,
                state: "interrupted",
                requestedAt: thread.latestTurn.requestedAt,
                startedAt: thread.latestTurn.startedAt ?? event.payload.createdAt,
                completedAt: event.payload.createdAt,
                assistantMessageId: thread.latestTurn.assistantMessageId,
              })
            : thread.latestTurn;
        return {
          ...thread,
          session: {
            ...thread.session,
            status: "closed",
            orchestrationStatus: "stopped",
            activeTurnId: undefined,
            updatedAt: event.payload.createdAt,
          },
          latestTurn,
          updatedAt:
            (thread.updatedAt ?? thread.createdAt) > event.occurredAt
              ? thread.updatedAt
              : event.occurredAt,
        };
      });

    case "thread.turn-start-requested":
      return applyThreadUpdate(state, event.payload.threadId, (thread) => {
        const modelSelection =
          event.payload.modelSelection !== undefined
            ? normalizeModelSelection(event.payload.modelSelection, thread.modelSelection)
            : thread.modelSelection;
        if (
          modelSelection === thread.modelSelection &&
          thread.runtimeMode === event.payload.runtimeMode &&
          thread.interactionMode === event.payload.interactionMode &&
          thread.pendingSourceProposedPlan === event.payload.sourceProposedPlan &&
          (thread.updatedAt ?? thread.createdAt) >= event.payload.createdAt
        ) {
          return thread;
        }
        return {
          ...thread,
          modelSelection,
          runtimeMode: event.payload.runtimeMode,
          interactionMode: event.payload.interactionMode,
          pendingSourceProposedPlan: event.payload.sourceProposedPlan,
          updatedAt:
            (thread.updatedAt ?? thread.createdAt) > event.payload.createdAt
              ? thread.updatedAt
              : event.payload.createdAt,
        };
      });

    case "thread.activity-appended":
      return applyThreadUpdate(state, event.payload.threadId, (thread) => {
        const nextActivities = normalizeActivities(
          [...thread.activities, event.payload.activity],
          thread.activities,
        );
        if (nextActivities === thread.activities) {
          return thread;
        }
        return {
          ...thread,
          activities: nextActivities,
          updatedAt:
            (thread.updatedAt ?? thread.createdAt) > event.payload.activity.createdAt
              ? thread.updatedAt
              : event.payload.activity.createdAt,
        };
      });

    case "thread.proposed-plan-upserted":
      return applyThreadUpdate(state, event.payload.threadId, (thread) => {
        const previousPlanIndex = thread.proposedPlans.findIndex(
          (plan) => plan.id === event.payload.proposedPlan.id,
        );
        const nextPlan = normalizeProposedPlans(
          [event.payload.proposedPlan],
          previousPlanIndex >= 0 ? [thread.proposedPlans[previousPlanIndex]!] : undefined,
        )[0];
        if (!nextPlan) {
          return thread;
        }
        const proposedPlans =
          previousPlanIndex >= 0
            ? thread.proposedPlans.map((plan, index) =>
                index === previousPlanIndex ? nextPlan : plan,
              )
            : [...thread.proposedPlans, nextPlan];
        if (arraysShallowEqual(thread.proposedPlans, proposedPlans)) {
          return thread;
        }
        return {
          ...thread,
          proposedPlans,
          updatedAt:
            (thread.updatedAt ?? thread.createdAt) > event.payload.proposedPlan.updatedAt
              ? thread.updatedAt
              : event.payload.proposedPlan.updatedAt,
        };
      });

    case "thread.turn-diff-completed":
      return applyThreadUpdate(state, event.payload.threadId, (thread) =>
        applyTurnDiffSummaryToThread(thread, {
          turnId: event.payload.turnId,
          completedAt: event.payload.completedAt,
          status: event.payload.status,
          files: event.payload.files.map((file) => ({
            path: file.path,
            ...(file.kind !== undefined ? { kind: file.kind } : {}),
            ...(file.additions !== undefined ? { additions: file.additions } : {}),
            ...(file.deletions !== undefined ? { deletions: file.deletions } : {}),
          })),
          checkpointRef: event.payload.checkpointRef,
          assistantMessageId: event.payload.assistantMessageId ?? undefined,
          checkpointTurnCount: event.payload.checkpointTurnCount,
        }),
      );

    case "thread.reverted":
      return applyThreadUpdate(state, event.payload.threadId, (thread) => {
        const turnDiffSummaries = thread.turnDiffSummaries
          .filter(
            (entry) =>
              entry.checkpointTurnCount !== undefined &&
              entry.checkpointTurnCount <= event.payload.turnCount,
          )
          .toSorted(
            (left, right) =>
              (left.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER) -
              (right.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER),
          );
        const retainedTurnIds = new Set(turnDiffSummaries.map((entry) => entry.turnId));
        const messages = retainThreadMessagesAfterRevert(
          thread.messages,
          retainedTurnIds,
          event.payload.turnCount,
        ).slice(-MAX_THREAD_MESSAGES);
        const proposedPlans = retainThreadProposedPlansAfterRevert(
          thread.proposedPlans,
          retainedTurnIds,
        );
        const activities = retainThreadActivitiesAfterRevert(thread.activities, retainedTurnIds);
        const latestCheckpoint = turnDiffSummaries.at(-1) ?? null;

        return {
          ...thread,
          turnDiffSummaries,
          messages,
          proposedPlans,
          activities,
          pendingSourceProposedPlan: undefined,
          latestTurn:
            latestCheckpoint === null
              ? null
              : {
                  turnId: latestCheckpoint.turnId,
                  state: checkpointStatusToLatestTurnState(latestCheckpoint.status),
                  requestedAt: latestCheckpoint.completedAt,
                  startedAt: latestCheckpoint.completedAt,
                  completedAt: latestCheckpoint.completedAt,
                  assistantMessageId: latestCheckpoint.assistantMessageId ?? null,
                },
          updatedAt:
            (thread.updatedAt ?? thread.createdAt) > event.occurredAt
              ? thread.updatedAt
              : event.occurredAt,
        };
      });

    case "thread.archived":
      return applyThreadUpdate(state, event.payload.threadId, (thread) => ({
        ...thread,
        archivedAt: event.payload.archivedAt ?? event.occurredAt,
        updatedAt: event.payload.updatedAt ?? event.occurredAt,
      }));

    case "thread.unarchived":
      return applyThreadUpdate(state, event.payload.threadId, (thread) => ({
        ...thread,
        archivedAt: null,
        updatedAt: event.payload.updatedAt ?? event.occurredAt,
      }));

    default:
      return state;
  }
}

export function applyOrchestrationEvents(
  state: AppState,
  events: ReadonlyArray<OrchestrationEvent>,
): AppState {
  let nextState = state;
  for (const event of events) {
    nextState = applyOrchestrationEvent(nextState, event);
  }
  return nextState;
}

// ── Pure state transition functions ────────────────────────────────────

export function syncServerReadModel(state: AppState, readModel: OrchestrationReadModel): AppState {
  rememberProjectUiState(state.projects);
  rememberProjectLocalNames(state.projects);
  const projects = mapProjectsFromReadModel(
    readModel.projects.filter((project) => project.deletedAt === null),
    state.projects,
  );
  const existingThreadById = new Map(state.threads.map((thread) => [thread.id, thread] as const));
  const nextThreads = readModel.threads
    .filter((thread) => thread.deletedAt === null)
    .map((thread) => {
      const existing = existingThreadById.get(thread.id);
      return normalizeThreadFromReadModel(thread, existing);
    });
  const threads = arraysShallowEqual(state.threads, nextThreads) ? state.threads : nextThreads;
  const nextSidebarThreadSummaryById = Object.fromEntries(
    threads.map((thread) => [
      thread.id,
      buildSidebarThreadSummary(thread, state.sidebarThreadSummaryById[thread.id]),
    ]),
  ) as Record<string, SidebarThreadSummary>;
  const sidebarThreadSummaryById = recordsShallowEqual(
    state.sidebarThreadSummaryById,
    nextSidebarThreadSummaryById,
  )
    ? state.sidebarThreadSummaryById
    : nextSidebarThreadSummaryById;
  if (
    projects === state.projects &&
    threads === state.threads &&
    sidebarThreadSummaryById === state.sidebarThreadSummaryById &&
    state.threadsHydrated
  ) {
    return state;
  }
  return {
    ...state,
    projects,
    threads,
    sidebarThreadSummaryById,
    threadsHydrated: true,
  };
}

export function markThreadVisited(
  state: AppState,
  threadId: ThreadId,
  visitedAt?: string,
): AppState {
  const at = visitedAt ?? new Date().toISOString();
  const visitedAtMs = Date.parse(at);
  let nextVisitedThread: Thread | null = null;
  const threads = updateThread(state.threads, threadId, (thread) => {
    const previousVisitedAtMs = thread.lastVisitedAt ? Date.parse(thread.lastVisitedAt) : NaN;
    if (
      Number.isFinite(previousVisitedAtMs) &&
      Number.isFinite(visitedAtMs) &&
      previousVisitedAtMs >= visitedAtMs
    ) {
      return thread;
    }
    nextVisitedThread = { ...thread, lastVisitedAt: at };
    return nextVisitedThread;
  });
  if (threads === state.threads) {
    return state;
  }
  if (nextVisitedThread === null) {
    return { ...state, threads };
  }
  const nextSummary = buildSidebarThreadSummary(
    nextVisitedThread,
    state.sidebarThreadSummaryById[threadId],
  );
  return nextSummary === state.sidebarThreadSummaryById[threadId]
    ? { ...state, threads }
    : {
        ...state,
        threads,
        sidebarThreadSummaryById: {
          ...state.sidebarThreadSummaryById,
          [threadId]: nextSummary,
        },
      };
}

export function markThreadUnread(state: AppState, threadId: ThreadId): AppState {
  let nextUnreadThread: Thread | null = null;
  const threads = updateThread(state.threads, threadId, (thread) => {
    if (!thread.latestTurn?.completedAt) return thread;
    const latestTurnCompletedAtMs = Date.parse(thread.latestTurn.completedAt);
    if (Number.isNaN(latestTurnCompletedAtMs)) return thread;
    const unreadVisitedAt = new Date(latestTurnCompletedAtMs - 1).toISOString();
    if (thread.lastVisitedAt === unreadVisitedAt) return thread;
    nextUnreadThread = { ...thread, lastVisitedAt: unreadVisitedAt };
    return nextUnreadThread;
  });
  if (threads === state.threads) {
    return state;
  }
  if (nextUnreadThread === null) {
    return { ...state, threads };
  }
  const nextSummary = buildSidebarThreadSummary(
    nextUnreadThread,
    state.sidebarThreadSummaryById[threadId],
  );
  return nextSummary === state.sidebarThreadSummaryById[threadId]
    ? { ...state, threads }
    : {
        ...state,
        threads,
        sidebarThreadSummaryById: {
          ...state.sidebarThreadSummaryById,
          [threadId]: nextSummary,
        },
      };
}

export function toggleProject(state: AppState, projectId: Project["id"]): AppState {
  return {
    ...state,
    projects: state.projects.map((p) => (p.id === projectId ? { ...p, expanded: !p.expanded } : p)),
  };
}

export function setProjectExpanded(
  state: AppState,
  projectId: Project["id"],
  expanded: boolean,
): AppState {
  let changed = false;
  const projects = state.projects.map((p) => {
    if (p.id !== projectId || p.expanded === expanded) return p;
    changed = true;
    return { ...p, expanded };
  });
  return changed ? { ...state, projects } : state;
}

export function setAllProjectsExpanded(state: AppState, expanded: boolean): AppState {
  let changed = false;
  const projects = state.projects.map((project) => {
    if (project.expanded === expanded) return project;
    changed = true;
    return { ...project, expanded };
  });
  return changed ? { ...state, projects } : state;
}

// Keep just one project expanded so bulk collapse preserves the active chat context.
export function collapseProjectsExcept(
  state: AppState,
  activeProjectId: Project["id"] | null,
): AppState {
  let changed = false;
  const projects = state.projects.map((project) => {
    const nextExpanded = activeProjectId !== null && project.id === activeProjectId;
    if (project.expanded === nextExpanded) return project;
    changed = true;
    return { ...project, expanded: nextExpanded };
  });
  return changed ? { ...state, projects } : state;
}

export function reorderProjects(
  state: AppState,
  draggedProjectId: Project["id"],
  targetProjectId: Project["id"],
): AppState {
  if (draggedProjectId === targetProjectId) return state;
  const draggedIndex = state.projects.findIndex((project) => project.id === draggedProjectId);
  const targetIndex = state.projects.findIndex((project) => project.id === targetProjectId);
  if (draggedIndex < 0 || targetIndex < 0) return state;
  const projects = [...state.projects];
  const [draggedProject] = projects.splice(draggedIndex, 1);
  if (!draggedProject) return state;
  projects.splice(targetIndex, 0, draggedProject);
  return { ...state, projects };
}

export function renameProjectLocally(
  state: AppState,
  projectId: Project["id"],
  name: string | null,
): AppState {
  const normalizedName = name?.trim() ?? null;
  let changed = false;
  const projects = state.projects.map((project) => {
    if (project.id !== projectId) {
      return project;
    }
    const nextLocalName = normalizedName && normalizedName.length > 0 ? normalizedName : null;
    const nextName = nextLocalName ?? project.remoteName;
    if (project.localName === nextLocalName && project.name === nextName) {
      return project;
    }
    changed = true;
    return {
      ...project,
      name: nextName,
      localName: nextLocalName,
    };
  });
  return changed ? { ...state, projects } : state;
}

export function setError(state: AppState, threadId: ThreadId, error: string | null): AppState {
  const threads = updateThread(state.threads, threadId, (t) => {
    if (t.error === error) return t;
    return { ...t, error };
  });
  return threads === state.threads ? state : { ...state, threads };
}

export function setThreadWorkspace(
  state: AppState,
  threadId: ThreadId,
  patch: ThreadWorkspacePatch,
): AppState {
  const threads = updateThread(state.threads, threadId, (t) => {
    const nextEnvMode = patch.envMode !== undefined ? patch.envMode : t.envMode;
    const nextBranch = resolveThreadBranchRegressionGuard({
      currentBranch: t.branch,
      nextBranch: patch.branch !== undefined ? patch.branch : t.branch,
    });
    const nextWorktreePath = patch.worktreePath !== undefined ? patch.worktreePath : t.worktreePath;
    const nextAssociatedWorktreePath =
      patch.associatedWorktreePath !== undefined
        ? patch.associatedWorktreePath
        : (t.associatedWorktreePath ?? null);
    const nextAssociatedWorktreeBranch =
      patch.associatedWorktreeBranch !== undefined
        ? patch.associatedWorktreeBranch
        : (t.associatedWorktreeBranch ?? null);
    const nextAssociatedWorktreeRef =
      patch.associatedWorktreeRef !== undefined
        ? patch.associatedWorktreeRef
        : (t.associatedWorktreeRef ?? null);
    if (
      t.envMode === nextEnvMode &&
      t.branch === nextBranch &&
      t.worktreePath === nextWorktreePath &&
      (t.associatedWorktreePath ?? null) === nextAssociatedWorktreePath &&
      (t.associatedWorktreeBranch ?? null) === nextAssociatedWorktreeBranch &&
      (t.associatedWorktreeRef ?? null) === nextAssociatedWorktreeRef
    ) {
      return t;
    }
    const cwdChanged = t.worktreePath !== nextWorktreePath;
    return {
      ...t,
      envMode: nextEnvMode,
      branch: nextBranch,
      worktreePath: nextWorktreePath,
      associatedWorktreePath: nextAssociatedWorktreePath,
      associatedWorktreeBranch: nextAssociatedWorktreeBranch,
      associatedWorktreeRef: nextAssociatedWorktreeRef,
      ...(cwdChanged ? { session: null } : {}),
    };
  });
  return threads === state.threads ? state : { ...state, threads };
}

// ── Zustand store ────────────────────────────────────────────────────

interface AppStore extends AppState {
  syncServerReadModel: (readModel: OrchestrationReadModel) => void;
  applyOrchestrationEvents: (events: ReadonlyArray<OrchestrationEvent>) => void;
  markThreadVisited: (threadId: ThreadId, visitedAt?: string) => void;
  markThreadUnread: (threadId: ThreadId) => void;
  toggleProject: (projectId: Project["id"]) => void;
  setProjectExpanded: (projectId: Project["id"], expanded: boolean) => void;
  setAllProjectsExpanded: (expanded: boolean) => void;
  collapseProjectsExcept: (activeProjectId: Project["id"] | null) => void;
  reorderProjects: (draggedProjectId: Project["id"], targetProjectId: Project["id"]) => void;
  renameProjectLocally: (projectId: Project["id"], name: string | null) => void;
  setError: (threadId: ThreadId, error: string | null) => void;
  setThreadWorkspace: (threadId: ThreadId, patch: ThreadWorkspacePatch) => void;
}

export const useStore = create<AppStore>((set) => ({
  ...readPersistedState(),
  syncServerReadModel: (readModel) => set((state) => syncServerReadModel(state, readModel)),
  applyOrchestrationEvents: (events) => set((state) => applyOrchestrationEvents(state, events)),
  markThreadVisited: (threadId, visitedAt) =>
    set((state) => markThreadVisited(state, threadId, visitedAt)),
  markThreadUnread: (threadId) => set((state) => markThreadUnread(state, threadId)),
  toggleProject: (projectId) => set((state) => toggleProject(state, projectId)),
  setProjectExpanded: (projectId, expanded) =>
    set((state) => setProjectExpanded(state, projectId, expanded)),
  setAllProjectsExpanded: (expanded) => set((state) => setAllProjectsExpanded(state, expanded)),
  collapseProjectsExcept: (activeProjectId) =>
    set((state) => collapseProjectsExcept(state, activeProjectId)),
  reorderProjects: (draggedProjectId, targetProjectId) =>
    set((state) => reorderProjects(state, draggedProjectId, targetProjectId)),
  renameProjectLocally: (projectId, name) =>
    set((state) => renameProjectLocally(state, projectId, name)),
  setError: (threadId, error) => set((state) => setError(state, threadId, error)),
  setThreadWorkspace: (threadId, patch) =>
    set((state) => setThreadWorkspace(state, threadId, patch)),
}));

// Persist state changes with debouncing to avoid localStorage thrashing
useStore.subscribe((state) => {
  rememberProjectUiState(state.projects);
  rememberProjectLocalNames(state.projects);
  debouncedPersistState.maybeExecute(state);
});

// Flush pending writes synchronously before page unload to prevent data loss.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    debouncedPersistState.flush();
  });
}

export function StoreProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    persistState(useStore.getState());
  }, []);
  return createElement(Fragment, null, children);
}
