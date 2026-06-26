import {
  DEFAULT_MODEL_BY_PROVIDER,
  type ClientOrchestrationCommand,
  type ModelSelection,
  type NativeApi,
  type OrchestrationMessageSource,
  type OrchestrationReviewChatTarget,
  type ProviderReviewTarget,
  type ProviderSkillReference,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { workspaceRootsEqual } from "@t3tools/shared/threadWorkspace";

import { readNativeApi } from "../nativeApi";
import { useStore, type AppState } from "../store";
import type { Project, Thread } from "../types";
import { getThreadFromState, getThreadsFromState } from "../threadDerivation";
import { buildReviewSidechatInitialPrompt } from "../components/review/reviewSidechatContext";
import type { ReviewSidechatContextPayload } from "../components/review/reviewSidechatContext";
import { newCommandId, newMessageId, newThreadId } from "./utils";
import { promoteThreadCreate } from "./threadCreatePromotion";
import { retainThreadDetailSubscription } from "../threadDetailSubscriptionRetention";

type ThreadCreateCommand = Extract<ClientOrchestrationCommand, { type: "thread.create" }>;
type ThreadMetaUpdateCommand = Extract<ClientOrchestrationCommand, { type: "thread.meta.update" }>;
type ThreadSessionEnsureCommand = Extract<
  ClientOrchestrationCommand,
  { type: "thread.session.ensure" }
>;
type ThreadTurnStartCommand = Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>;
type ReviewChatApi = {
  readonly orchestration: Pick<NativeApi["orchestration"], "dispatchCommand" | "getShellSnapshot">;
};
export type ReviewChatThreadResult =
  | { status: "ready"; threadId: ThreadId; created: boolean }
  | { status: "unavailable"; reason: string };

export type ReviewChatQuestionResult =
  | { status: "sent"; threadId: ThreadId; created: boolean; turnRequestedAt: string }
  | {
      status: "queued";
      threadId: ThreadId;
      created: boolean;
      queuedAt: string;
      reason: "session_warming";
    }
  | { status: "unavailable"; reason: string };

export type ReviewChatPrewarmResult = ReviewChatThreadResult;

export type ReviewChatThreadReadyHandler = (threadId: ThreadId, created: boolean) => void;
export type ReviewChatQueuedTurnStartedHandler = (threadId: ThreadId, startedAt: string) => void;
export type ReviewChatQueuedProviderStartRequestedHandler = (
  threadId: ThreadId,
  startedAt: string,
) => void;
export type ReviewChatQueuedTurnFailedHandler = (
  threadId: ThreadId,
  queuedAt: string,
  reason: string,
) => void;

const inFlightCreateByTargetKey = new Map<string, Promise<ThreadId | null>>();
const createdThreadByTargetKey = new Map<
  string,
  {
    readonly threadId: ThreadId;
    readonly target: OrchestrationReviewChatTarget;
  }
>();
const inFlightPrewarmByKey = new Map<
  string,
  {
    readonly targetKey: string;
    readonly modelKey: string;
    threadId: ThreadId | null;
    readonly promise: Promise<ReviewChatPrewarmResult>;
  }
>();
const inFlightSessionReadyByKey = new Map<string, Promise<boolean>>();
const queuedReviewTurnFlushByThreadId = new Map<string, Promise<void>>();
const reviewContextBootstrappedKeys = new Set<string>();
const PREWARM_SESSION_READY_TIMEOUT_MS = 45_000;
const VISIBLE_SEND_PREWARM_WAIT_MS = 150;
const REVIEW_CONTEXT_BOOTSTRAP_QUESTION =
  "Reply exactly: ready. Do not summarize yet; just load this PR context for the next user question.";
export const REVIEW_RISKS_NATIVE_REVIEW_QUESTION = "Find review risks";

export function defaultReviewChatModelSelection(): ModelSelection {
  return {
    provider: "codex",
    model: "gpt-5.3-codex-spark",
    options: { reasoningEffort: "low" },
  };
}

function fallbackModelSelection(project: Project): ModelSelection {
  return (
    project.defaultModelSelection ?? {
      provider: "codex",
      model: DEFAULT_MODEL_BY_PROVIDER.codex,
    }
  );
}

function modelSelectionsEqual(
  left: ModelSelection | null | undefined,
  right: ModelSelection | null | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    JSON.stringify(left.options ?? null) === JSON.stringify(right.options ?? null)
  );
}

function shouldUpdateThreadModelBeforeReviewTurn(input: {
  readonly thread: Thread;
  readonly modelSelection: ModelSelection;
}): boolean {
  if (modelSelectionsEqual(input.thread.modelSelection, input.modelSelection)) {
    return false;
  }
  return (
    input.thread.modelSelection.provider !== "codex" || input.modelSelection.provider !== "codex"
  );
}

function buildReviewChatTitle(payload: ReviewSidechatContextPayload): string {
  const prefix = `Review #${payload.number}`;
  const maxTitleLength = 82;
  const cleanTitle = payload.title.replace(/\s+/g, " ").trim();
  const fullTitle = `${prefix}: ${cleanTitle}`;
  if (fullTitle.length <= maxTitleLength) {
    return fullTitle;
  }
  return `${fullTitle.slice(0, maxTitleLength - 1).trimEnd()}...`;
}

export function buildReviewChatTarget(
  payload: ReviewSidechatContextPayload,
  projectId: ProjectId,
): OrchestrationReviewChatTarget | null {
  if (!payload.cwd) {
    return null;
  }
  return {
    projectId,
    cwd: payload.cwd,
    repositoryId: payload.repositoryId,
    reference: payload.reference,
    number: payload.number,
    headSha: payload.headSha,
    url: payload.url,
  };
}

export function reviewChatTargetsEqual(
  left: OrchestrationReviewChatTarget | null | undefined,
  right: OrchestrationReviewChatTarget | null | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  const repositoriesMatch =
    !left.repositoryId || !right.repositoryId || left.repositoryId === right.repositoryId;
  const headShaMatches = !left.headSha || !right.headSha || left.headSha === right.headSha;
  return (
    left.projectId === right.projectId &&
    left.cwd === right.cwd &&
    left.number === right.number &&
    headShaMatches &&
    repositoriesMatch
  );
}

export function reviewChatTargetKey(target: OrchestrationReviewChatTarget): string {
  return [target.projectId, target.cwd, String(target.number)].join("\u001f");
}

function findCachedCreatedReviewThreadId(target: OrchestrationReviewChatTarget): ThreadId | null {
  const cachedThread = createdThreadByTargetKey.get(reviewChatTargetKey(target));
  if (!cachedThread || !reviewChatTargetsEqual(cachedThread.target, target)) {
    return null;
  }
  return cachedThread.threadId;
}

function reviewChatModelKey(modelSelection: ModelSelection): string {
  return [
    modelSelection.provider,
    modelSelection.model,
    JSON.stringify(modelSelection.options ?? null),
  ].join("\u001f");
}

function reviewChatSessionPrewarmKey(input: {
  target: OrchestrationReviewChatTarget;
  modelSelection: ModelSelection;
  threadId: ThreadId;
}): string {
  return [
    reviewChatTargetKey(input.target),
    reviewChatModelKey(input.modelSelection),
    input.threadId,
  ].join("\u001f");
}

function reviewChatContextCompletenessKey(payload: ReviewSidechatContextPayload): string {
  const hasCompleteBootstrapContext =
    payload.cwd !== null &&
    payload.repositoryId !== null &&
    payload.target !== null &&
    payload.headSha !== null &&
    payload.files.length > 0;
  return hasCompleteBootstrapContext ? `head:${payload.headSha}` : "incomplete";
}

function reviewChatBootstrapKey(input: {
  target: OrchestrationReviewChatTarget;
  payload: ReviewSidechatContextPayload;
}): string {
  return [
    reviewChatTargetKey(input.target),
    input.target.repositoryId ?? "",
    input.target.reference,
    input.target.url,
    reviewChatContextCompletenessKey(input.payload),
  ].join("\u001f");
}

function hasCompleteReviewBootstrapContext(payload: ReviewSidechatContextPayload): boolean {
  return reviewChatContextCompletenessKey(payload) !== "incomplete";
}

export function findProjectForReviewChat(
  projects: readonly Project[],
  cwd: string | null,
): Project | null {
  if (!cwd) {
    return null;
  }
  return (
    projects.find(
      (project) => project.kind === "project" && workspaceRootsEqual(project.cwd, cwd),
    ) ?? null
  );
}

export function findReviewChatThread(
  threads: readonly Thread[],
  target: OrchestrationReviewChatTarget,
): Thread | null {
  let newestThread: Thread | null = null;
  let newestUpdatedAt = Number.NEGATIVE_INFINITY;
  for (const thread of threads) {
    if (
      thread.archivedAt != null ||
      !reviewChatTargetsEqual(thread.reviewChatTarget, target) ||
      !isUsableReviewChatThread(thread)
    ) {
      continue;
    }
    const updatedAt = Date.parse(thread.updatedAt ?? thread.createdAt);
    if (updatedAt >= newestUpdatedAt) {
      newestUpdatedAt = updatedAt;
      newestThread = thread;
    }
  }
  return newestThread;
}

export function clearReviewChatThreadCacheForTests(): void {
  inFlightCreateByTargetKey.clear();
  createdThreadByTargetKey.clear();
  inFlightPrewarmByKey.clear();
  inFlightSessionReadyByKey.clear();
  queuedReviewTurnFlushByThreadId.clear();
  reviewContextBootstrappedKeys.clear();
}

function findReviewChatThreadInState(
  state: AppState,
  target: OrchestrationReviewChatTarget,
): Thread | null {
  return findReviewChatThread(getThreadsFromState(state), target);
}

function findThreadById(state: AppState, threadId: ThreadId): Thread | undefined {
  return getThreadFromState(state, threadId);
}

function isReviewChatSessionReady(input: {
  readonly thread: Thread | undefined;
  readonly modelSelection: ModelSelection;
}): boolean {
  const session = input.thread?.session;
  return (
    session?.provider === input.modelSelection.provider &&
    session.status === "ready" &&
    (session.activeTurnId === undefined || session.activeTurnId === null)
  );
}

function reviewChatSessionError(thread: Thread | undefined): string | null {
  const session = thread?.session;
  if (session?.status !== "error") {
    return null;
  }
  return session.lastError ?? "Review chat session failed to start.";
}

function reviewChatUnavailableReason(error: unknown): string {
  return error instanceof Error ? error.message : "Review chat session failed to start.";
}

function waitForReviewChatSessionReady(input: {
  readonly threadId: ThreadId;
  readonly modelSelection: ModelSelection;
  readonly timeoutMs?: number;
}): Promise<boolean> {
  const timeoutMs = input.timeoutMs ?? PREWARM_SESSION_READY_TIMEOUT_MS;
  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: { readonly ready: boolean } | { readonly error: Error }) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      unsubscribe?.();
      if ("error" in result) {
        reject(result.error);
      } else {
        resolve(result.ready);
      }
    };

    const check = () => {
      const thread = findThreadById(useStore.getState(), input.threadId);
      if (isReviewChatSessionReady({ thread, modelSelection: input.modelSelection })) {
        finish({ ready: true });
        return;
      }
      const error = reviewChatSessionError(thread);
      if (error !== null) {
        finish({ error: new Error(error) });
      }
    };

    check();
    if (settled) {
      return;
    }
    timeout = setTimeout(() => finish({ ready: false }), timeoutMs);
    unsubscribe = useStore.subscribe(check);
  });
}

function ensureReviewChatSessionReady(input: {
  readonly api: ReviewChatApi;
  readonly target: OrchestrationReviewChatTarget;
  readonly threadId: ThreadId;
  readonly modelSelection: ModelSelection;
  readonly createdAt: string;
}): Promise<boolean> {
  const currentThread = findThreadById(useStore.getState(), input.threadId);
  if (isReviewChatSessionReady({ thread: currentThread, modelSelection: input.modelSelection })) {
    return Promise.resolve(true);
  }

  const sessionPrewarmKey = reviewChatSessionPrewarmKey({
    target: input.target,
    modelSelection: input.modelSelection,
    threadId: input.threadId,
  });
  const inFlight = inFlightSessionReadyByKey.get(sessionPrewarmKey);
  if (inFlight) {
    return inFlight;
  }

  const promise = (async (): Promise<boolean> => {
    const releaseDetailSubscription = retainThreadDetailSubscription(input.threadId);
    try {
      await input.api.orchestration.dispatchCommand(
        buildSessionEnsureCommand({
          threadId: input.threadId,
          modelSelection: input.modelSelection,
          createdAt: input.createdAt,
        }),
      );
      const sessionReady = await waitForReviewChatSessionReady({
        threadId: input.threadId,
        modelSelection: input.modelSelection,
      });
      return sessionReady;
    } finally {
      releaseDetailSubscription();
    }
  })().finally(() => {
    inFlightSessionReadyByKey.delete(sessionPrewarmKey);
  });

  inFlightSessionReadyByKey.set(sessionPrewarmKey, promise);
  return promise;
}

async function refreshShellSnapshot(api: ReviewChatApi): Promise<AppState> {
  const snapshot = await api.orchestration.getShellSnapshot();
  useStore.getState().syncServerShellSnapshot(snapshot);
  return useStore.getState();
}

function buildCreateCommand(input: {
  payload: ReviewSidechatContextPayload;
  project: Project;
  target: OrchestrationReviewChatTarget;
  threadId: ThreadId;
  modelSelection: ModelSelection;
  createdAt: string;
}): ThreadCreateCommand {
  return {
    type: "thread.create",
    commandId: newCommandId(),
    threadId: input.threadId,
    projectId: input.project.id,
    title: buildReviewChatTitle(input.payload),
    modelSelection: input.modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    envMode: "local",
    branch: input.payload.baseBranch,
    worktreePath: null,
    associatedWorktreePath: null,
    associatedWorktreeBranch: null,
    associatedWorktreeRef: null,
    createBranchFlowCompleted: false,
    lastKnownPr: {
      number: input.payload.number,
      title: input.payload.title,
      url: input.payload.url,
      baseBranch: input.payload.baseBranch,
      headBranch: input.payload.headBranch,
      state: input.payload.state,
    },
    reviewChatTarget: input.target,
    createdAt: input.createdAt,
  };
}

function buildMetaUpdateCommand(input: {
  threadId: ThreadId;
  modelSelection: ModelSelection;
}): ThreadMetaUpdateCommand {
  return {
    type: "thread.meta.update",
    commandId: newCommandId(),
    threadId: input.threadId,
    modelSelection: input.modelSelection,
  };
}

function hasReviewChatMetadata(payload: ReviewSidechatContextPayload): boolean {
  return (
    payload.url.trim().length > 0 &&
    payload.title.trim().length > 0 &&
    payload.baseBranch.trim().length > 0 &&
    payload.headBranch.trim().length > 0 &&
    payload.headBranch !== "unknown"
  );
}

function buildReviewChatMetadataUpdateCommand(input: {
  payload: ReviewSidechatContextPayload;
  target: OrchestrationReviewChatTarget;
  threadId: ThreadId;
}): ThreadMetaUpdateCommand {
  return {
    type: "thread.meta.update",
    commandId: newCommandId(),
    threadId: input.threadId,
    title: buildReviewChatTitle(input.payload),
    branch: input.payload.baseBranch,
    lastKnownPr: {
      number: input.payload.number,
      title: input.payload.title,
      url: input.payload.url,
      baseBranch: input.payload.baseBranch,
      headBranch: input.payload.headBranch,
      state: input.payload.state,
    },
    reviewChatTarget: input.target,
  };
}

function refreshReviewChatMetadata(input: {
  readonly api: ReviewChatApi;
  readonly payload: ReviewSidechatContextPayload;
  readonly target: OrchestrationReviewChatTarget;
  readonly threadId: ThreadId;
}): void {
  if (!hasReviewChatMetadata(input.payload)) {
    return;
  }
  void input.api.orchestration
    .dispatchCommand(
      buildReviewChatMetadataUpdateCommand({
        payload: input.payload,
        target: input.target,
        threadId: input.threadId,
      }),
    )
    .catch(() => undefined);
}

function buildSessionEnsureCommand(input: {
  threadId: ThreadId;
  modelSelection: ModelSelection;
  createdAt: string;
}): ThreadSessionEnsureCommand {
  return {
    type: "thread.session.ensure",
    commandId: newCommandId(),
    threadId: input.threadId,
    modelSelection: input.modelSelection,
    runtimeMode: "approval-required",
    createdAt: input.createdAt,
  };
}

function buildTurnStartCommand(input: {
  payload: ReviewSidechatContextPayload;
  question: string;
  threadId: ThreadId;
  modelSelection: ModelSelection;
  skills?: readonly ProviderSkillReference[] | undefined;
  reviewTarget?: ProviderReviewTarget | undefined;
  includeReviewContext: boolean;
  dispatchMode?: "queue" | "steer" | undefined;
  source?: OrchestrationMessageSource | undefined;
  createdAt: string;
}): ThreadTurnStartCommand {
  const text = input.includeReviewContext
    ? buildReviewSidechatInitialPrompt(input.payload, input.question)
    : input.question;
  return {
    type: "thread.turn.start",
    commandId: newCommandId(),
    threadId: input.threadId,
    message: {
      messageId: newMessageId(),
      role: "user",
      text,
      attachments: [],
      ...(input.skills && input.skills.length > 0 ? { skills: [...input.skills] } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
    },
    modelSelection: input.modelSelection,
    ...(input.reviewTarget !== undefined ? { reviewTarget: input.reviewTarget } : {}),
    assistantDeliveryMode: "streaming",
    ...(input.dispatchMode !== undefined ? { dispatchMode: input.dispatchMode } : {}),
    runtimeMode: "approval-required",
    interactionMode: "default",
    createdAt: input.createdAt,
  };
}

function buildNativeReviewTargetForQuestion(input: {
  readonly payload: ReviewSidechatContextPayload;
  readonly question: string;
  readonly skills?: readonly ProviderSkillReference[] | undefined;
}): ProviderReviewTarget | null {
  if (input.question !== REVIEW_RISKS_NATIVE_REVIEW_QUESTION) {
    return null;
  }
  if (input.skills && input.skills.length > 0) {
    return null;
  }
  const branch = input.payload.baseBranch.trim();
  return branch.length > 0 ? { type: "baseBranch", branch } : null;
}

function shouldBootstrapReviewContext(thread: Thread | undefined): boolean {
  if (!thread) {
    return true;
  }
  return thread.messages.length === 0 && thread.latestUserMessageAt == null;
}

function isStaleResumeErrorMessage(message: string | null | undefined): boolean {
  if (!message) {
    return false;
  }
  const normalized = message.toLowerCase();
  return (
    normalized.includes("thread/resume") &&
    (normalized.includes("no rollout found") ||
      normalized.includes("thread not found") ||
      normalized.includes("missing thread") ||
      normalized.includes("unknown thread"))
  );
}

function isUsableReviewChatThread(thread: Thread): boolean {
  const session = thread.session;
  if (!session) {
    return true;
  }
  return !(
    (session.orchestrationStatus === "stopped" || session.orchestrationStatus === "error") &&
    isStaleResumeErrorMessage(session.lastError)
  );
}

function isReviewContextBootstrapRunning(thread: Thread | undefined): boolean {
  return (
    thread?.latestTurn?.state === "running" &&
    thread.messages.some((message) => message.source === "review-context-bootstrap")
  );
}

function canInjectReviewContext(modelSelection: ModelSelection): boolean {
  return modelSelection.provider === "codex";
}

async function resolveProjectWithRefresh(
  api: ReviewChatApi,
  payload: ReviewSidechatContextPayload,
): Promise<Project | null> {
  let project = findProjectForReviewChat(useStore.getState().projects, payload.cwd);
  if (project) {
    return project;
  }
  const refreshedState = await refreshShellSnapshot(api);
  project = findProjectForReviewChat(refreshedState.projects, payload.cwd);
  return project;
}

async function createReviewChatThreadOnce(input: {
  api: ReviewChatApi;
  payload: ReviewSidechatContextPayload;
  project: Project;
  target: OrchestrationReviewChatTarget;
  modelSelection: ModelSelection;
}): Promise<ThreadId | null> {
  const targetKey = reviewChatTargetKey(input.target);
  const inFlight = inFlightCreateByTargetKey.get(targetKey);
  if (inFlight) {
    return inFlight;
  }

  const promise = (async () => {
    const existing = findReviewChatThreadInState(useStore.getState(), input.target);
    if (existing) {
      return existing.id;
    }

    const threadId = newThreadId();
    const createdAt = new Date().toISOString();
    const createResult = await promoteThreadCreate(
      buildCreateCommand({
        payload: input.payload,
        project: input.project,
        target: input.target,
        threadId,
        modelSelection: input.modelSelection,
        createdAt,
      }),
      input.api,
    );

    if (createResult === "unavailable") {
      return null;
    }
    createdThreadByTargetKey.set(targetKey, { threadId, target: input.target });
    return threadId;
  })().finally(() => {
    inFlightCreateByTargetKey.delete(targetKey);
  });

  inFlightCreateByTargetKey.set(targetKey, promise);
  return promise;
}

async function createReviewChatThread(input: {
  api: ReviewChatApi;
  payload: ReviewSidechatContextPayload;
  project: Project;
  target: OrchestrationReviewChatTarget;
  modelSelection: ModelSelection;
}): Promise<ThreadId | null> {
  const threadId = newThreadId();
  const createdAt = new Date().toISOString();
  const createResult = await promoteThreadCreate(
    buildCreateCommand({
      payload: input.payload,
      project: input.project,
      target: input.target,
      threadId,
      modelSelection: input.modelSelection,
      createdAt,
    }),
    input.api,
  );
  if (createResult === "unavailable") {
    return null;
  }
  createdThreadByTargetKey.set(reviewChatTargetKey(input.target), {
    threadId,
    target: input.target,
  });
  return threadId;
}

export async function resolveOrCreateReviewChatThread(input: {
  payload: ReviewSidechatContextPayload;
  modelSelection?: ModelSelection | undefined;
  api?: ReviewChatApi | undefined;
}): Promise<ReviewChatThreadResult> {
  const api = input.api ?? readNativeApi();
  if (!api) {
    return { status: "unavailable", reason: "Native API is not available." };
  }
  const project = await resolveProjectWithRefresh(api, input.payload);
  if (!project) {
    return { status: "unavailable", reason: "No Synara project is open for this repository." };
  }
  const target = buildReviewChatTarget(input.payload, project.id);
  if (!target) {
    return { status: "unavailable", reason: "This review does not have a repository path." };
  }

  const existing = findReviewChatThreadInState(useStore.getState(), target);
  if (existing) {
    createdThreadByTargetKey.set(reviewChatTargetKey(target), {
      threadId: existing.id,
      target,
    });
    return { status: "ready", threadId: existing.id, created: false };
  }

  const cachedThreadId = findCachedCreatedReviewThreadId(target);
  if (cachedThreadId) {
    return { status: "ready", threadId: cachedThreadId, created: false };
  }

  const threadId = await createReviewChatThreadOnce({
    api,
    payload: input.payload,
    project,
    target,
    modelSelection: input.modelSelection ?? fallbackModelSelection(project),
  });
  if (!threadId) {
    return { status: "unavailable", reason: "Could not create a review chat thread." };
  }
  return { status: "ready", threadId, created: true };
}

export async function startNewReviewChatThread(input: {
  payload: ReviewSidechatContextPayload;
  modelSelection?: ModelSelection | undefined;
  api?: ReviewChatApi | undefined;
}): Promise<ReviewChatThreadResult> {
  const api = input.api ?? readNativeApi();
  if (!api) {
    return { status: "unavailable", reason: "Native API is not available." };
  }
  const project = await resolveProjectWithRefresh(api, input.payload);
  if (!project) {
    return { status: "unavailable", reason: "No Synara project is open for this repository." };
  }
  const target = buildReviewChatTarget(input.payload, project.id);
  if (!target) {
    return { status: "unavailable", reason: "This review does not have a repository path." };
  }
  const modelSelection = input.modelSelection ?? fallbackModelSelection(project);
  const threadId = await createReviewChatThread({
    api,
    payload: input.payload,
    project,
    target,
    modelSelection,
  });
  if (!threadId) {
    return { status: "unavailable", reason: "Could not create a review chat thread." };
  }
  const releaseDetailSubscription = retainThreadDetailSubscription(threadId);
  try {
    await api.orchestration.dispatchCommand(
      buildSessionEnsureCommand({
        threadId,
        modelSelection,
        createdAt: new Date().toISOString(),
      }),
    );
    void refreshShellSnapshot(api).catch(() => undefined);
    return { status: "ready", threadId, created: true };
  } finally {
    releaseDetailSubscription();
  }
}

export async function prewarmReviewChatThread(input: {
  payload: ReviewSidechatContextPayload;
  modelSelection?: ModelSelection | undefined;
  onThreadReady?: ReviewChatThreadReadyHandler | undefined;
  bootstrapReviewContext?: boolean | undefined;
  refreshMetadata?: boolean | undefined;
  api?: ReviewChatApi | undefined;
}): Promise<ReviewChatPrewarmResult> {
  const api = input.api ?? readNativeApi();
  if (!api) {
    return { status: "unavailable", reason: "Native API is not available." };
  }
  const project = await resolveProjectWithRefresh(api, input.payload);
  if (!project) {
    return { status: "unavailable", reason: "No Synara project is open for this repository." };
  }
  const target = buildReviewChatTarget(input.payload, project.id);
  if (!target) {
    return { status: "unavailable", reason: "This review does not have a repository path." };
  }

  const modelSelection = input.modelSelection ?? fallbackModelSelection(project);
  const targetKey = reviewChatTargetKey(target);
  const modelKey = reviewChatModelKey(modelSelection);
  const bootstrapKey = reviewChatBootstrapKey({ target, payload: input.payload });
  const prewarmKey = `${bootstrapKey}\u001f${modelKey}`;
  const inFlight = inFlightPrewarmByKey.get(prewarmKey);
  if (inFlight) {
    return inFlight.promise;
  }

  const promise = (async (): Promise<ReviewChatPrewarmResult> => {
    const resolution = await resolveOrCreateReviewChatThread({
      payload: input.payload,
      modelSelection,
      api,
    });
    if (resolution.status !== "ready") {
      return resolution;
    }
    const prewarmEntry = inFlightPrewarmByKey.get(prewarmKey);
    if (prewarmEntry) {
      prewarmEntry.threadId = resolution.threadId;
    }
    if (!resolution.created && input.refreshMetadata !== false) {
      refreshReviewChatMetadata({
        api,
        payload: input.payload,
        target,
        threadId: resolution.threadId,
      });
    }
    input.onThreadReady?.(resolution.threadId, resolution.created);
    const sessionReady = await ensureReviewChatSessionReady({
      api,
      target,
      threadId: resolution.threadId,
      modelSelection,
      createdAt: new Date().toISOString(),
    });
    if (!sessionReady) {
      return {
        status: "unavailable",
        reason: "Review chat session did not finish warming before the timeout.",
      };
    }
    if (
      input.bootstrapReviewContext !== false &&
      hasCompleteReviewBootstrapContext(input.payload)
    ) {
      const threadBootstrapKey = `${bootstrapKey}\u001f${resolution.threadId}`;
      if (!reviewContextBootstrappedKeys.has(threadBootstrapKey)) {
        if (canInjectReviewContext(modelSelection)) {
          // Skip thread.context.inject for Codex review chats.
          // Injecting context via thread/inject_items blocks the serial
          // DrainableWorker, causing head-of-line blocking for visible
          // user turns. Instead, the first visible send includes PR
          // context directly in the user message text.
          // Do NOT mark the bootstrap key here; sendReviewChatQuestion
          // will mark it when it includes context in the first turn.
        } else {
          await api.orchestration.dispatchCommand(
            buildTurnStartCommand({
              payload: input.payload,
              question: REVIEW_CONTEXT_BOOTSTRAP_QUESTION,
              threadId: resolution.threadId,
              modelSelection,
              includeReviewContext: true,
              source: "review-context-bootstrap",
              createdAt: new Date().toISOString(),
            }),
          );
          reviewContextBootstrappedKeys.add(threadBootstrapKey);
        }
      }
    }
    void refreshShellSnapshot(api).catch(() => undefined);
    return resolution;
  })().finally(() => {
    inFlightPrewarmByKey.delete(prewarmKey);
  });

  inFlightPrewarmByKey.set(prewarmKey, {
    targetKey,
    modelKey,
    threadId: findCachedCreatedReviewThreadId(target),
    promise,
  });
  return promise;
}

type VisibleSendPrewarmResolution = ReviewChatPrewarmResult | { readonly status: "warming" } | null;

function waitForPrewarmVisibleSendBudget(
  promise: Promise<ReviewChatPrewarmResult>,
): Promise<ReviewChatPrewarmResult | { readonly status: "warming" }> {
  return new Promise((resolve) => {
    let settled = false;
    const timeout = globalThis.setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ status: "warming" });
    }, VISIBLE_SEND_PREWARM_WAIT_MS);
    promise
      .then((result) => {
        if (settled) {
          return;
        }
        settled = true;
        globalThis.clearTimeout(timeout);
        resolve(result);
      })
      .catch((error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        globalThis.clearTimeout(timeout);
        resolve({ status: "unavailable", reason: reviewChatUnavailableReason(error) });
      });
  });
}

async function awaitInFlightPrewarmForVisibleSend(input: {
  target: OrchestrationReviewChatTarget;
  modelSelection: ModelSelection;
  threadId?: ThreadId | undefined;
}): Promise<VisibleSendPrewarmResolution> {
  const targetKey = reviewChatTargetKey(input.target);
  const modelKey = reviewChatModelKey(input.modelSelection);
  for (const prewarm of inFlightPrewarmByKey.values()) {
    if (prewarm.targetKey !== targetKey || prewarm.modelKey !== modelKey) {
      continue;
    }
    if (
      input.threadId !== undefined &&
      prewarm.threadId !== null &&
      prewarm.threadId !== input.threadId
    ) {
      continue;
    }
    const threadId = prewarm.threadId ?? input.threadId;
    const thread = threadId ? findThreadById(useStore.getState(), threadId) : undefined;
    if (threadId && isReviewChatSessionReady({ thread, modelSelection: input.modelSelection })) {
      return { status: "ready", threadId, created: false };
    }
    const settledPrewarm = await waitForPrewarmVisibleSendBudget(prewarm.promise);
    if (settledPrewarm.status === "warming") {
      return settledPrewarm;
    }
    if (settledPrewarm.status !== "ready") {
      return input.threadId === undefined ? settledPrewarm : null;
    }
    if (input.threadId === undefined || settledPrewarm.threadId === input.threadId) {
      return settledPrewarm;
    }
    return null;
  }
  return null;
}

type ReadyReviewChatThreadResult = Extract<ReviewChatThreadResult, { status: "ready" }>;

async function dispatchReviewChatTurn(input: {
  readonly api: ReviewChatApi;
  readonly payload: ReviewSidechatContextPayload;
  readonly target: OrchestrationReviewChatTarget;
  readonly resolution: ReadyReviewChatThreadResult;
  readonly modelSelection: ModelSelection;
  readonly question: string;
  readonly skills?: readonly ProviderSkillReference[] | undefined;
  readonly createdAt: string;
}): Promise<void> {
  const bootstrapKey = reviewChatBootstrapKey({ target: input.target, payload: input.payload });
  const threadBootstrapKey = `${bootstrapKey}\u001f${input.resolution.threadId}`;
  const thread = findThreadById(useStore.getState(), input.resolution.threadId);
  if (
    thread &&
    shouldUpdateThreadModelBeforeReviewTurn({ thread, modelSelection: input.modelSelection })
  ) {
    await input.api.orchestration.dispatchCommand(
      buildMetaUpdateCommand({
        threadId: input.resolution.threadId,
        modelSelection: input.modelSelection,
      }),
    );
  }
  const hasBootstrappedReviewContext =
    hasCompleteReviewBootstrapContext(input.payload) &&
    reviewContextBootstrappedKeys.has(threadBootstrapKey);
  const reviewTarget = buildNativeReviewTargetForQuestion({
    payload: input.payload,
    question: input.question,
    skills: input.skills,
  });
  const includeReviewContext =
    reviewTarget === null &&
    !hasBootstrappedReviewContext &&
    (input.resolution.created || shouldBootstrapReviewContext(thread));
  const dispatchMode = isReviewContextBootstrapRunning(thread) ? "steer" : undefined;
  const releaseDetailSubscription = retainThreadDetailSubscription(input.resolution.threadId);
  try {
    await input.api.orchestration.dispatchCommand(
      buildTurnStartCommand({
        payload: input.payload,
        question: input.question,
        threadId: input.resolution.threadId,
        modelSelection: input.modelSelection,
        skills: input.skills,
        ...(reviewTarget !== null ? { reviewTarget } : {}),
        includeReviewContext,
        dispatchMode,
        createdAt: input.createdAt,
      }),
    );
    if (includeReviewContext && hasCompleteReviewBootstrapContext(input.payload)) {
      reviewContextBootstrappedKeys.add(threadBootstrapKey);
    }
  } finally {
    releaseDetailSubscription();
  }
  void refreshShellSnapshot(input.api).catch(() => undefined);
}

async function flushQueuedReviewTurn(input: {
  readonly api: ReviewChatApi;
  readonly payload: ReviewSidechatContextPayload;
  readonly target: OrchestrationReviewChatTarget;
  readonly resolution: ReadyReviewChatThreadResult;
  readonly modelSelection: ModelSelection;
  readonly question: string;
  readonly skills?: readonly ProviderSkillReference[] | undefined;
  readonly queuedAt: string;
  readonly onQueuedProviderStartRequested?:
    | ReviewChatQueuedProviderStartRequestedHandler
    | undefined;
  readonly onQueuedTurnStarted?: ReviewChatQueuedTurnStartedHandler | undefined;
}): Promise<void> {
  const sessionReady = await ensureReviewChatSessionReady({
    api: input.api,
    target: input.target,
    threadId: input.resolution.threadId,
    modelSelection: input.modelSelection,
    createdAt: input.queuedAt,
  });
  if (!sessionReady) {
    throw new Error("Review chat session did not finish warming before the timeout.");
  }
  input.onQueuedProviderStartRequested?.(input.resolution.threadId, input.queuedAt);
  await dispatchReviewChatTurn({
    api: input.api,
    payload: input.payload,
    target: input.target,
    resolution: input.resolution,
    modelSelection: input.modelSelection,
    question: input.question,
    skills: input.skills,
    createdAt: input.queuedAt,
  });
  input.onQueuedTurnStarted?.(input.resolution.threadId, input.queuedAt);
}

function enqueueQueuedReviewTurn(input: {
  readonly api: ReviewChatApi;
  readonly payload: ReviewSidechatContextPayload;
  readonly target: OrchestrationReviewChatTarget;
  readonly resolution: ReadyReviewChatThreadResult;
  readonly modelSelection: ModelSelection;
  readonly question: string;
  readonly skills?: readonly ProviderSkillReference[] | undefined;
  readonly queuedAt: string;
  readonly onQueuedProviderStartRequested?:
    | ReviewChatQueuedProviderStartRequestedHandler
    | undefined;
  readonly onQueuedTurnStarted?: ReviewChatQueuedTurnStartedHandler | undefined;
  readonly onQueuedTurnFailed?: ReviewChatQueuedTurnFailedHandler | undefined;
}): void {
  const queueKey = input.resolution.threadId;
  const previousFlush = queuedReviewTurnFlushByThreadId.get(queueKey) ?? Promise.resolve();
  const flush = previousFlush
    .catch(() => undefined)
    .then(() => flushQueuedReviewTurn(input))
    .catch((error: unknown) => {
      input.onQueuedTurnFailed?.(
        input.resolution.threadId,
        input.queuedAt,
        reviewChatUnavailableReason(error),
      );
    })
    .finally(() => {
      if (queuedReviewTurnFlushByThreadId.get(queueKey) === flush) {
        queuedReviewTurnFlushByThreadId.delete(queueKey);
      }
    });
  queuedReviewTurnFlushByThreadId.set(queueKey, flush);
}

export async function sendReviewChatQuestion(input: {
  payload: ReviewSidechatContextPayload;
  question: string;
  threadId?: ThreadId | undefined;
  modelSelection?: ModelSelection | undefined;
  skills?: readonly ProviderSkillReference[] | undefined;
  onThreadReady?: ReviewChatThreadReadyHandler | undefined;
  onQueuedProviderStartRequested?: ReviewChatQueuedProviderStartRequestedHandler | undefined;
  onQueuedTurnStarted?: ReviewChatQueuedTurnStartedHandler | undefined;
  onQueuedTurnFailed?: ReviewChatQueuedTurnFailedHandler | undefined;
  api?: ReviewChatApi | undefined;
}): Promise<ReviewChatQuestionResult> {
  const api = input.api ?? readNativeApi();
  if (!api) {
    return { status: "unavailable", reason: "Native API is not available." };
  }
  const project = await resolveProjectWithRefresh(api, input.payload);
  if (!project) {
    return { status: "unavailable", reason: "No Synara project is open for this repository." };
  }
  const modelSelection = input.modelSelection ?? fallbackModelSelection(project);
  const target = buildReviewChatTarget(input.payload, project.id);
  if (!target) {
    return { status: "unavailable", reason: "This review does not have a repository path." };
  }
  const prewarmResolution = await awaitInFlightPrewarmForVisibleSend({
    target,
    modelSelection,
    ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
  });
  if (prewarmResolution?.status === "unavailable") {
    return prewarmResolution;
  }
  const requestedThreadId = input.threadId;
  const requestedThread =
    requestedThreadId !== undefined
      ? useStore.getState().threads.find((candidate) => candidate.id === requestedThreadId)
      : undefined;
  const canUseRequestedThread =
    requestedThread === undefined || isUsableReviewChatThread(requestedThread);
  const resolution = await (async (): Promise<ReviewChatThreadResult> => {
    if (prewarmResolution?.status === "ready") {
      return prewarmResolution;
    }
    return requestedThreadId !== undefined && canUseRequestedThread
      ? {
          status: "ready",
          threadId: requestedThreadId,
          created: false,
        }
      : resolveOrCreateReviewChatThread({
          payload: input.payload,
          modelSelection,
          api,
        });
  })();
  if (resolution.status !== "ready") {
    return resolution;
  }
  const adoptedPrewarm =
    prewarmResolution?.status === "ready" && prewarmResolution.threadId === resolution.threadId;
  input.onThreadReady?.(resolution.threadId, adoptedPrewarm ? false : resolution.created);

  const createdAt = new Date().toISOString();
  const resolvedThread = findThreadById(useStore.getState(), resolution.threadId);
  const sessionReady = isReviewChatSessionReady({ thread: resolvedThread, modelSelection });
  if (!sessionReady || queuedReviewTurnFlushByThreadId.has(resolution.threadId)) {
    enqueueQueuedReviewTurn({
      api,
      payload: input.payload,
      target,
      resolution,
      modelSelection,
      question: input.question,
      skills: input.skills,
      queuedAt: createdAt,
      onQueuedProviderStartRequested: input.onQueuedProviderStartRequested,
      onQueuedTurnStarted: input.onQueuedTurnStarted,
      onQueuedTurnFailed: input.onQueuedTurnFailed,
    });
    return {
      status: "queued",
      threadId: resolution.threadId,
      created: resolution.created,
      queuedAt: createdAt,
      reason: "session_warming",
    };
  }

  await dispatchReviewChatTurn({
    api,
    payload: input.payload,
    target,
    resolution,
    modelSelection,
    question: input.question,
    skills: input.skills,
    createdAt,
  });
  return {
    status: "sent",
    threadId: resolution.threadId,
    created: resolution.created,
    turnRequestedAt: createdAt,
  };
}
