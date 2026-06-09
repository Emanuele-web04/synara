import {
  DEFAULT_MODEL_BY_PROVIDER,
  type ClientOrchestrationCommand,
  type ModelSelection,
  type NativeApi,
  type OrchestrationMessageSource,
  type OrchestrationReviewChatTarget,
  type ProviderSkillReference,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { workspaceRootsEqual } from "@t3tools/shared/threadWorkspace";

import { readNativeApi } from "../nativeApi";
import { useStore, type AppState } from "../store";
import type { Project, Thread } from "../types";
import { buildReviewSidechatInitialPrompt } from "../components/review/reviewSidechatContext";
import type { ReviewSidechatContextPayload } from "../components/review/reviewSidechatContext";
import { newCommandId, newMessageId, newThreadId } from "./utils";
import { promoteThreadCreate } from "./threadCreatePromotion";

type ThreadCreateCommand = Extract<ClientOrchestrationCommand, { type: "thread.create" }>;
type ThreadMetaUpdateCommand = Extract<ClientOrchestrationCommand, { type: "thread.meta.update" }>;
type ThreadSessionEnsureCommand = Extract<
  ClientOrchestrationCommand,
  { type: "thread.session.ensure" }
>;
type ThreadTurnStartCommand = Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>;
type ReviewChatApi = Pick<NativeApi, "orchestration">;
export type ReviewChatThreadResult =
  | { status: "ready"; threadId: ThreadId; created: boolean }
  | { status: "unavailable"; reason: string };

export type ReviewChatQuestionResult =
  | { status: "sent"; threadId: ThreadId; created: boolean }
  | { status: "unavailable"; reason: string };

export type ReviewChatPrewarmResult = ReviewChatThreadResult;

export type ReviewChatThreadReadyHandler = (threadId: ThreadId, created: boolean) => void;

const inFlightCreateByTargetKey = new Map<string, Promise<ThreadId | null>>();
const createdThreadIdByTargetKey = new Map<string, ThreadId>();
const inFlightPrewarmByKey = new Map<
  string,
  {
    readonly targetKey: string;
    readonly modelKey: string;
    threadId: ThreadId | null;
    readonly promise: Promise<ReviewChatPrewarmResult>;
  }
>();
const reviewContextBootstrappedKeys = new Set<string>();
const VISIBLE_SEND_PREWARM_WAIT_MS = 250;
const REVIEW_CONTEXT_BOOTSTRAP_QUESTION =
  "Reply exactly: ready. Do not summarize yet; just load this PR context for the next user question.";

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
  return (
    left.projectId === right.projectId &&
    left.cwd === right.cwd &&
    left.number === right.number &&
    repositoriesMatch
  );
}

export function reviewChatTargetKey(target: OrchestrationReviewChatTarget): string {
  return [target.projectId, target.cwd, String(target.number)].join("\u001f");
}

function reviewChatModelKey(modelSelection: ModelSelection): string {
  return [
    modelSelection.provider,
    modelSelection.model,
    JSON.stringify(modelSelection.options ?? null),
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
  createdThreadIdByTargetKey.clear();
  inFlightPrewarmByKey.clear();
  reviewContextBootstrappedKeys.clear();
}

function findReviewChatThreadInState(
  state: AppState,
  target: OrchestrationReviewChatTarget,
): Thread | null {
  return findReviewChatThread(state.threads, target);
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
    assistantDeliveryMode: "streaming",
    ...(input.dispatchMode !== undefined ? { dispatchMode: input.dispatchMode } : {}),
    runtimeMode: "approval-required",
    interactionMode: "default",
    createdAt: input.createdAt,
  };
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
    createdThreadIdByTargetKey.set(targetKey, threadId);
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
  createdThreadIdByTargetKey.set(reviewChatTargetKey(input.target), threadId);
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
    createdThreadIdByTargetKey.set(reviewChatTargetKey(target), existing.id);
    return { status: "ready", threadId: existing.id, created: false };
  }

  const targetKey = reviewChatTargetKey(target);
  const cachedThreadId = createdThreadIdByTargetKey.get(targetKey);
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
  void api.orchestration.subscribeThread({ threadId }).catch(() => undefined);
  await api.orchestration.dispatchCommand(
    buildSessionEnsureCommand({
      threadId,
      modelSelection,
      createdAt: new Date().toISOString(),
    }),
  );
  void refreshShellSnapshot(api).catch(() => undefined);
  return { status: "ready", threadId, created: true };
}

export async function prewarmReviewChatThread(input: {
  payload: ReviewSidechatContextPayload;
  modelSelection?: ModelSelection | undefined;
  onThreadReady?: ReviewChatThreadReadyHandler | undefined;
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
    input.onThreadReady?.(resolution.threadId, resolution.created);
    void api.orchestration
      .subscribeThread({ threadId: resolution.threadId })
      .catch(() => undefined);
    await api.orchestration.dispatchCommand(
      buildSessionEnsureCommand({
        threadId: resolution.threadId,
        modelSelection,
        createdAt: new Date().toISOString(),
      }),
    );
    if (hasCompleteReviewBootstrapContext(input.payload)) {
      const threadBootstrapKey = `${bootstrapKey}\u001f${resolution.threadId}`;
      if (!reviewContextBootstrappedKeys.has(threadBootstrapKey)) {
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
    void refreshShellSnapshot(api).catch(() => undefined);
    return resolution;
  })().finally(() => {
    inFlightPrewarmByKey.delete(prewarmKey);
  });

  inFlightPrewarmByKey.set(prewarmKey, {
    targetKey,
    modelKey,
    threadId: createdThreadIdByTargetKey.get(targetKey) ?? null,
    promise,
  });
  return promise;
}

function waitForPrewarmVisibleSendBudget(
  promise: Promise<ReviewChatPrewarmResult>,
): Promise<ReviewChatPrewarmResult | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timeout = globalThis.setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(null);
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
      .catch(() => {
        if (settled) {
          return;
        }
        settled = true;
        globalThis.clearTimeout(timeout);
        resolve(null);
      });
  });
}

async function awaitInFlightPrewarmForVisibleSend(input: {
  target: OrchestrationReviewChatTarget;
  modelSelection: ModelSelection;
}): Promise<ReviewChatPrewarmResult | null> {
  const targetKey = reviewChatTargetKey(input.target);
  const modelKey = reviewChatModelKey(input.modelSelection);
  for (const prewarm of inFlightPrewarmByKey.values()) {
    if (prewarm.targetKey === targetKey && prewarm.modelKey === modelKey) {
      if (prewarm.threadId) {
        return { status: "ready", threadId: prewarm.threadId, created: false };
      }
      return waitForPrewarmVisibleSendBudget(prewarm.promise);
    }
  }
  return null;
}

export async function sendReviewChatQuestion(input: {
  payload: ReviewSidechatContextPayload;
  question: string;
  threadId?: ThreadId | undefined;
  modelSelection?: ModelSelection | undefined;
  skills?: readonly ProviderSkillReference[] | undefined;
  onThreadReady?: ReviewChatThreadReadyHandler | undefined;
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
  const prewarmResolution =
    input.threadId === undefined
      ? await awaitInFlightPrewarmForVisibleSend({
          target,
          modelSelection,
        })
      : null;
  const requestedThread =
    input.threadId !== undefined
      ? useStore.getState().threads.find((candidate) => candidate.id === input.threadId)
      : undefined;
  const canUseRequestedThread =
    requestedThread === undefined || isUsableReviewChatThread(requestedThread);
  const resolution =
    input.threadId !== undefined && canUseRequestedThread
      ? ({
          status: "ready",
          threadId: input.threadId,
          created: false,
        } satisfies ReviewChatThreadResult)
      : await resolveOrCreateReviewChatThread({
          payload: input.payload,
          modelSelection,
          api,
        });
  if (resolution.status !== "ready") {
    return resolution;
  }
  const adoptedPrewarm =
    prewarmResolution?.status === "ready" && prewarmResolution.threadId === resolution.threadId;
  input.onThreadReady?.(resolution.threadId, adoptedPrewarm ? false : resolution.created);
  const bootstrapKey = reviewChatBootstrapKey({ target, payload: input.payload });
  const threadBootstrapKey = `${bootstrapKey}\u001f${resolution.threadId}`;
  const thread = useStore
    .getState()
    .threads.find((candidate) => candidate.id === resolution.threadId);
  if (thread && !modelSelectionsEqual(thread.modelSelection, modelSelection)) {
    await api.orchestration.dispatchCommand(
      buildMetaUpdateCommand({
        threadId: resolution.threadId,
        modelSelection,
      }),
    );
  }
  const hasBootstrappedReviewContext =
    hasCompleteReviewBootstrapContext(input.payload) &&
    reviewContextBootstrappedKeys.has(threadBootstrapKey);
  const includeReviewContext =
    !hasBootstrappedReviewContext && (resolution.created || shouldBootstrapReviewContext(thread));
  const dispatchMode = isReviewContextBootstrapRunning(thread) ? "steer" : undefined;
  void api.orchestration.subscribeThread({ threadId: resolution.threadId }).catch(() => undefined);
  const createdAt = new Date().toISOString();
  await api.orchestration.dispatchCommand(
    buildTurnStartCommand({
      payload: input.payload,
      question: input.question,
      threadId: resolution.threadId,
      modelSelection,
      skills: input.skills,
      includeReviewContext,
      dispatchMode,
      createdAt,
    }),
  );
  if (includeReviewContext && hasCompleteReviewBootstrapContext(input.payload)) {
    reviewContextBootstrappedKeys.add(threadBootstrapKey);
  }
  void refreshShellSnapshot(api).catch(() => undefined);
  return {
    status: "sent",
    threadId: resolution.threadId,
    created: resolution.created,
  };
}
