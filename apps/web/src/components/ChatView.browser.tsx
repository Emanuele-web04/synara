import { FEATURE_TOUR_STORAGE_KEY } from "../featureTour/store";
import {
  buildStalePendingRequestFailureDetail,
  pendingRequestInstanceKey,
} from "@synara/shared/threadSummary";
// Production CSS is part of the behavior under test because row height depends on it.
import "../index.css";

import {
  ApprovalRequestId,
  AutomationId,
  type AutomationCreateInput,
  type AutomationDefinition,
  CheckpointRef,
  DEFAULT_AUTOMATION_STOP_AFTER_CONSECUTIVE_FAILURES,
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  MessageId,
  DEVICE_WS_METHODS,
  COMPUTER_WS_METHODS,
  ORCHESTRATION_WS_METHODS,
  OrchestrationProposedPlanId,
  type OrchestrationReadModel,
  type ProjectId,
  type ProjectAgentOverview,
  type ServerConfig,
  SpaceId,
  ThreadId,
  TurnId,
  type WsWelcomePayload,
  WS_METHODS,
  OrchestrationSessionStatus,
} from "@synara/contracts";
import {
  ATTACHMENT_CANCEL_ROUTE_PATH,
  ATTACHMENT_UPLOAD_ROUTE_PATH,
} from "@synara/shared/binaryTransfer";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { HttpResponse, http, ws } from "msw";
import { setupWorker } from "msw/browser";
import { page, userEvent } from "vitest/browser";
import React, { Profiler, type ProfilerOnRenderCallback } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { render } from "vitest-browser-react";

import { type ComposerImageAttachment, useComposerDraftStore } from "../composerDraftStore";
import {
  AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
  getScrollContainerDistanceFromBottom,
} from "../chat-scroll";
import { useGroupPanelClosedStore } from "../groupPanelClosedStore";
import { useLatestProjectStore } from "../latestProjectStore";
import { useProjectEnvironmentStore } from "../projectEnvironmentStore";
import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  type TerminalContextDraft,
  removeInlineTerminalContextPlaceholder,
} from "../lib/terminalContext";
import { extractTrailingBrowserAnnotations } from "../lib/browserAnnotations";
import { isMacNavigatorPlatform } from "../lib/utils";
import { STARRED_MODELS_STORAGE_KEY } from "../lib/starredModels";
import { readNativeApi } from "../nativeApi";
import { emitWsTransportState } from "../wsTransportEvents";
import { dispatchKanbanDraftThread } from "../lib/kanbanDispatch";
import {
  endQueuedComposerAutoDispatch,
  tryBeginQueuedComposerAutoDispatch,
} from "../lib/queuedComposerDrain";
import { useKanbanUiStore } from "../kanbanUiStore";
import { setThreadDetailResumeCursor } from "../threadDetailResumeCursors";
import { resetHomeChatProjectPrewarmStateForTests } from "../lib/chatProjects";
import { hasReconciledServerProviderStatuses } from "../lib/serverReactQuery";
import { getRouter } from "../router";
import { showContextMenuFallback } from "../contextMenuFallback";
import { useRightDockStore } from "../rightDockStore";
import { dockTerminalThreadId } from "../lib/dockTerminalScope";
import { collectLeaves } from "../splitView.logic";
import { GITHUB_INBOX_DOCK_HOST_ID } from "../rightDockStore.logic";
import { useOpenThreadTabsStore } from "../openThreadTabsStore";
import { resolveSplitViewPaneIdForThread, useSplitViewStore } from "../splitViewStore";
import { splitViewPaneScopeId } from "../lib/chatPaneScope";
import { gitQueryKeys } from "../lib/gitReactQuery";
import { useSpacesUiStore } from "../spacesUiStore";
import { useRailShellStore } from "../railShellStore";
import { usePinnedThreadsStore } from "../pinnedThreadsStore";
import { getAppTypographyScale } from "../lib/appTypography";
import { threadJumpCommandForIndex } from "../keybindings";
import { useStore } from "../store";
import {
  createShellSnapshotFromReadModel,
  flattenEffectRpcRequestPayload,
  readEffectRpcClientMessage,
  sendEffectRpcChunk,
  sendEffectRpcExit,
} from "../test/effectRpcWebSocketMock";
import { makeDomainEvent } from "../storeTestFixtures";
import {
  acknowledgeStartupAnnouncementsForTest,
  createBrowserTestServerConfig,
  createBrowserTestServerSettings,
  createFullscreenTestHost,
} from "../test/browserHarness";
import { useTemporaryThreadStore } from "../temporaryThreadStore";
import { useTerminalStateStore } from "../terminalStateStore";
import { resetRetainedThreadDetailSubscriptionsForTests } from "../threadDetailSubscriptionRetention";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import { getWorkspaceEditorSession } from "../lib/workspaceEditorSession";
import { resetWsNativeApiForTest } from "../wsNativeApi";
import { trackWsTurnSettlement } from "../wsTransportEvents";
import { hasActiveComposerSend } from "../lib/composerSendOwnership";
import { useProjectAgentSummariesStore } from "./chat/project/useProjectAgentSummaries";
import { useThreadDispatchStore } from "./chat/useChatLocalDispatch";
import { hasUnseenSnoozeReturn } from "./Sidebar.logic";
// Pre-transform the compiler-heavy component outside the first case's timeout.
// The router's auto-split route otherwise requests this module on first mount.
import "./ChatView";

const THREAD_ID = "thread-browser-test" as ThreadId;
const OTHER_THREAD_ID = "thread-browser-test-other" as ThreadId;

// Each call to the snapshot factory gets a fresh, monotonically increasing sequence.
// The step (1_000_000) is far larger than any single test can bridge: in-test
// increments come only from `recordProjectCreateCommand`, `addThreadToSnapshot`, and
// the per-test snapshot-sync helpers, each +1 per call and bounded by waitFor-driven
// helper invocations (hundreds at most). So a late in-flight shell snapshot from a
// previous test is always strictly below the next test's base sequence and is ignored
// by `isStaleSnapshot`.
let snapshotSequenceFactory = 0;
function nextSnapshotSequence(): number {
  snapshotSequenceFactory += 1_000_000;
  return snapshotSequenceFactory;
}
const THREAD_TITLE = "Browser test thread";
const UUID_ROUTE_RE = /^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECT_ID = "project-1" as ProjectId;
const OTHER_PROJECT_ID = "project-2" as ProjectId;
const HOME_PROJECT_ID = "project-home" as ProjectId;
const STUDIO_PROJECT_ID = "project-studio" as ProjectId;
const STUDIO_DRAFT_THREAD_ID = "thread-studio-draft" as ThreadId;
const NOW_ISO = "2026-03-04T12:00:00.000Z";
const BASE_TIME_MS = Date.parse(NOW_ISO);
const ATTACHMENT_SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='120' height='300'></svg>";
let attachmentResponseDelayMs = 0;
let attachmentUploadSequence = 0;
let attachmentUploadBarrier: Promise<void> | null = null;
let attachmentCancelBarrier: Promise<void> | null = null;

interface WsRequestEnvelope {
  id: string;
  body: {
    _tag: string;
    [key: string]: unknown;
  };
}

interface TestFixture {
  snapshot: OrchestrationReadModel;
  serverConfig: ServerConfig;
  providerStatusesSnapshot: ServerConfig["providers"] | null;
  welcome: WsWelcomePayload;
  gitBranchByCwd: Record<string, string>;
  projectAgentOverviews: Record<string, unknown>;
}

let fixture: TestFixture;
const wsRequests: WsRequestEnvelope["body"][] = [];
const wsLink = ws.link(/ws(s)?:\/\/.*/);

interface ViewportSpec {
  name: string;
  width: number;
  height: number;
}

const DEFAULT_VIEWPORT: ViewportSpec = {
  name: "desktop",
  width: 960,
  height: 1_100,
};
const TEXT_VIEWPORT_MATRIX = [
  DEFAULT_VIEWPORT,
  { name: "tablet", width: 720, height: 1_024 },
  { name: "mobile", width: 430, height: 932 },
  { name: "narrow", width: 320, height: 700 },
] as const satisfies readonly ViewportSpec[];
const ATTACHMENT_VIEWPORT_MATRIX = [
  { name: "narrow", width: 320, height: 700 },
] as const satisfies readonly ViewportSpec[];

interface UserRowMeasurement {
  measuredRowHeightPx: number;
  timelineWidthMeasuredPx: number;
}

interface MountedChatView {
  [Symbol.asyncDispose]: () => Promise<void>;
  cleanup: () => Promise<void>;
  measureLayout: () => Promise<ChatLayoutMeasurement>;
  measureUserRow: (targetMessageId: MessageId) => Promise<UserRowMeasurement>;
  setViewport: (viewport: ViewportSpec) => Promise<void>;
  router: ReturnType<typeof getRouter>;
}

interface ChatLayoutMeasurement {
  hostHeightPx: number;
  composerBottomPx: number;
  scrollClientHeightPx: number;
  scrollHeightPx: number;
  distanceFromBottomPx: number;
}

function isoAt(offsetSeconds: number): string {
  return new Date(BASE_TIME_MS + offsetSeconds * 1_000).toISOString();
}

function createBaseServerConfig(): ServerConfig {
  return createBrowserTestServerConfig(NOW_ISO);
}

function createUserMessage(options: {
  id: MessageId;
  text: string;
  offsetSeconds: number;
  attachments?: Array<{
    type: "image";
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
  }>;
}) {
  return {
    id: options.id,
    role: "user" as const,
    text: options.text,
    ...(options.attachments ? { attachments: options.attachments } : {}),
    turnId: null,
    streaming: false,
    source: "native" as const,
    createdAt: isoAt(options.offsetSeconds),
    updatedAt: isoAt(options.offsetSeconds + 1),
  };
}

function createAssistantMessage(options: { id: MessageId; text: string; offsetSeconds: number }) {
  return {
    id: options.id,
    role: "assistant" as const,
    text: options.text,
    turnId: null,
    streaming: false,
    source: "native" as const,
    createdAt: isoAt(options.offsetSeconds),
    updatedAt: isoAt(options.offsetSeconds + 1),
  };
}

function createTerminalContext(input: {
  id: string;
  terminalLabel: string;
  lineStart: number;
  lineEnd: number;
  text: string;
}): TerminalContextDraft {
  return {
    id: input.id,
    threadId: THREAD_ID,
    terminalId: `terminal-${input.id}`,
    terminalLabel: input.terminalLabel,
    lineStart: input.lineStart,
    lineEnd: input.lineEnd,
    text: input.text,
    createdAt: NOW_ISO,
  };
}

function createComposerImage(input: {
  id: string;
  previewUrl: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
}): ComposerImageAttachment {
  const name = input.name ?? "queued-image.png";
  const mimeType = input.mimeType ?? "image/png";
  const sizeBytes = input.sizeBytes ?? 8;
  const file = new File([new Uint8Array(sizeBytes).fill(1)], name, {
    type: mimeType,
    lastModified: BASE_TIME_MS,
  });
  return {
    type: "image",
    id: input.id,
    name,
    mimeType,
    sizeBytes: file.size,
    previewUrl: input.previewUrl,
    file,
  };
}

function createSnapshotForTargetUser(options: {
  targetMessageId: MessageId;
  targetText: string;
  targetAttachmentCount?: number;
  sessionStatus?: OrchestrationSessionStatus;
}): OrchestrationReadModel {
  const messages: Array<OrchestrationReadModel["threads"][number]["messages"][number]> = [];

  for (let index = 0; index < 22; index += 1) {
    const isTarget = index === 3;
    const userId = `msg-user-${index}` as MessageId;
    const assistantId = `msg-assistant-${index}` as MessageId;
    const attachments =
      isTarget && (options.targetAttachmentCount ?? 0) > 0
        ? Array.from({ length: options.targetAttachmentCount ?? 0 }, (_, attachmentIndex) => ({
            type: "image" as const,
            id: `attachment-${attachmentIndex + 1}`,
            name: `attachment-${attachmentIndex + 1}.png`,
            mimeType: "image/png",
            sizeBytes: 128,
          }))
        : undefined;

    messages.push(
      createUserMessage({
        id: isTarget ? options.targetMessageId : userId,
        text: isTarget ? options.targetText : `filler user message ${index}`,
        offsetSeconds: messages.length * 3,
        ...(attachments ? { attachments } : {}),
      }),
    );
    messages.push(
      createAssistantMessage({
        id: assistantId,
        text: `assistant filler ${index}`,
        offsetSeconds: messages.length * 3,
      }),
    );
  }

  return {
    snapshotSequence: nextSnapshotSequence(),
    spaces: [],
    projects: [
      {
        id: PROJECT_ID,
        kind: "project",
        title: "Project",
        workspaceRoot: "/repo/project",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        title: THREAD_TITLE,
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        interactionMode: "default",
        runtimeMode: "full-access",
        envMode: "local",
        branch: "main",
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
        handoff: null,
        messages,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: {
          threadId: THREAD_ID,
          status: options.sessionStatus ?? "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId:
            options.sessionStatus === "running"
              ? TurnId.makeUnsafe("turn-browser-fixture-active")
              : null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
    updatedAt: NOW_ISO,
  };
}

function createIssue550Snapshot(options: {
  messageCount: number;
  activityCount: number;
}): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-issue-550" as MessageId,
    targetText: "issue 550 baseline",
  });
  const messages = Array.from({ length: options.messageCount }, (_, index) =>
    index % 2 === 0
      ? createUserMessage({
          id: MessageId.makeUnsafe(`msg-issue-550-user-${index}`),
          text: `user message ${index}`,
          offsetSeconds: index * 2,
        })
      : createAssistantMessage({
          id: MessageId.makeUnsafe(`msg-issue-550-assistant-${index}`),
          text: `assistant message ${index}`,
          offsetSeconds: index * 2,
        }),
  );
  const activities = Array.from({ length: options.activityCount }, (_, index) => ({
    id: EventId.makeUnsafe(`activity-issue-550-${index}`),
    createdAt: isoAt(options.messageCount * 2 + index),
    kind: "tool.completed" as const,
    summary: `tool ${index}`,
    tone: "tool" as const,
    turnId: null,
    payload: {
      itemType: "dynamic_tool_call",
      toolName: `tool-${index}`,
    },
  }));

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID ? { ...thread, messages, activities } : thread,
    ),
  };
}

function createSnapshotWithLongAssistantResponse(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-assistant-overflow-target" as MessageId,
    targetText: "start",
  });

  const threads = [...snapshot.threads];
  const threadIndex = threads.findIndex((thread) => thread.id === THREAD_ID);
  if (threadIndex < 0) {
    return snapshot;
  }

  const thread = threads[threadIndex]!;
  const messages = [...thread.messages];
  const messageIndex = messages.findIndex(
    (message, index) => message.role === "assistant" && index === 7,
  );
  if (messageIndex < 0) {
    return snapshot;
  }

  const message = messages[messageIndex]!;
  messages[messageIndex] = {
    ...message,
    text: Array.from(
      { length: 240 },
      (_, lineIndex) =>
        `${lineIndex + 1}. keep the viewport stable while this response keeps growing`,
    ).join("\n"),
  };
  threads[threadIndex] = {
    ...thread,
    messages,
  };

  return {
    ...snapshot,
    threads,
  };
}

function createSnapshotWithBottomAttachments(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-bottom-attachments" as MessageId,
    targetText: "bottom attachments",
  });

  const threads = [...snapshot.threads];
  const threadIndex = threads.findIndex((thread) => thread.id === THREAD_ID);
  if (threadIndex < 0) {
    return snapshot;
  }

  const thread = threads[threadIndex]!;
  const messages = [...thread.messages];
  let lastUserMessageIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUserMessageIndex = index;
      break;
    }
  }
  if (lastUserMessageIndex < 0) {
    return snapshot;
  }

  const lastUserMessage = messages[lastUserMessageIndex]!;
  messages[lastUserMessageIndex] = {
    ...lastUserMessage,
    text: "final user message with delayed attachments",
    attachments: Array.from({ length: 3 }, (_, attachmentIndex) => ({
      type: "image" as const,
      id: `bottom-attachment-${attachmentIndex + 1}`,
      name: `bottom-attachment-${attachmentIndex + 1}.png`,
      mimeType: "image/png",
      sizeBytes: 128,
    })),
  };
  threads[threadIndex] = {
    ...thread,
    messages,
  };

  return {
    ...snapshot,
    threads,
  };
}

function buildFixture(snapshot: OrchestrationReadModel): TestFixture {
  return {
    snapshot,
    serverConfig: createBaseServerConfig(),
    providerStatusesSnapshot: null,
    gitBranchByCwd: {},
    projectAgentOverviews: {},
    welcome: {
      cwd: "/repo/project",
      projectName: "Project",
      bootstrapProjectId: PROJECT_ID,
      bootstrapThreadId: THREAD_ID,
    },
  };
}

function findThreadDetailFromFixtureSnapshot(
  threadId: ThreadId,
): OrchestrationReadModel["threads"][number] | null {
  return fixture.snapshot.threads.find((entry) => entry.id === threadId) ?? null;
}

/** The rows of the open fallback context menu. */
function contextMenuRows() {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-slot="context-menu-popup"] button'),
  );
}

function addThreadToSnapshot(
  snapshot: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationReadModel {
  return {
    ...snapshot,
    snapshotSequence: snapshot.snapshotSequence + 1,
    threads: [
      ...snapshot.threads,
      {
        id: threadId,
        projectId: PROJECT_ID,
        title: "New thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        interactionMode: "default",
        runtimeMode: "full-access",
        envMode: "local",
        branch: "main",
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
        handoff: null,
        messages: [],
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
  };
}

function createAutomationDefinitionFromCreateRequest(
  body: WsRequestEnvelope["body"],
): AutomationDefinition {
  const input = body as unknown as AutomationCreateInput;
  const definition: AutomationDefinition = {
    id: AutomationId.makeUnsafe(`automation-${wsRequests.length}`),
    projectId: input.projectId,
    sourceThreadId: input.sourceThreadId ?? null,
    name: input.name,
    prompt: input.prompt,
    schedule: input.schedule,
    enabled: input.enabled ?? true,
    nextRunAt: null,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode ?? "approval-required",
    interactionMode: input.interactionMode ?? "default",
    worktreeMode: input.worktreeMode ?? "auto",
    mode: input.mode ?? "standalone",
    targetThreadId: input.targetThreadId ?? null,
    maxIterations: input.maxIterations ?? null,
    stopAfterConsecutiveFailures:
      input.stopAfterConsecutiveFailures === undefined
        ? DEFAULT_AUTOMATION_STOP_AFTER_CONSECUTIVE_FAILURES
        : input.stopAfterConsecutiveFailures,
    consecutiveFailureCount: 0,
    disabledReason: null,
    disabledAt: null,
    completionPolicy: input.completionPolicy ?? { type: "none" },
    completionPolicyVersion: 1,
    completionPolicyUpdatedAt: NOW_ISO,
    minimumIntervalSeconds: input.minimumIntervalSeconds ?? 60,
    maxRuntimeSeconds: input.maxRuntimeSeconds ?? 3_600,
    retryPolicy: input.retryPolicy ?? { type: "none" },
    misfirePolicy: input.misfirePolicy ?? "coalesce",
    acknowledgedRisks: input.acknowledgedRisks ?? [],
    iterationCount: 0,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    archivedAt: null,
  };
  return input.providerOptions === undefined
    ? definition
    : { ...definition, providerOptions: input.providerOptions };
}

function createDraftOnlySnapshot(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-draft-target" as MessageId,
    targetText: "draft thread",
  });
  return {
    ...snapshot,
    threads: [],
  };
}

function withSettledThreadBranch(
  snapshot: OrchestrationReadModel,
  branch: string,
): OrchestrationReadModel {
  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID ? { ...thread, branch, settledAt: NOW_ISO } : thread,
    ),
  };
}

function withOpenProjectPickerFixtures(snapshot: OrchestrationReadModel): OrchestrationReadModel {
  return {
    ...snapshot,
    projects: [
      ...snapshot.projects,
      {
        id: OTHER_PROJECT_ID,
        kind: "project",
        title: "Other Project",
        workspaceRoot: "/repo/other",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
  };
}

function withHomeChatProject(snapshot: OrchestrationReadModel): OrchestrationReadModel {
  return {
    ...snapshot,
    projects: [
      ...snapshot.projects,
      {
        id: HOME_PROJECT_ID,
        kind: "chat",
        title: "Home",
        workspaceRoot: "/Users/tester",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
  };
}

function withActiveHomeChatThread(snapshot: OrchestrationReadModel): OrchestrationReadModel {
  const snapshotWithHomeProject = withHomeChatProject(snapshot);
  return {
    ...snapshotWithHomeProject,
    threads: snapshotWithHomeProject.threads.map((thread) =>
      thread.id === THREAD_ID ? { ...thread, projectId: HOME_PROJECT_ID } : thread,
    ),
  };
}

function withStudioProject(snapshot: OrchestrationReadModel): OrchestrationReadModel {
  return {
    ...snapshot,
    projects: [
      ...snapshot.projects,
      {
        id: STUDIO_PROJECT_ID,
        kind: "studio",
        title: "Studio",
        workspaceRoot: "/Users/tester/Documents/Synara/Studio",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
  };
}

function withProjectScripts(
  snapshot: OrchestrationReadModel,
  scripts: OrchestrationReadModel["projects"][number]["scripts"],
): OrchestrationReadModel {
  return {
    ...snapshot,
    projects: snapshot.projects.map((project) =>
      project.id === PROJECT_ID ? { ...project, scripts: Array.from(scripts) } : project,
    ),
  };
}

function createSnapshotWithLongProposedPlan(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-plan-target" as MessageId,
    targetText: "plan thread",
  });
  const planMarkdown = [
    "# Ship plan mode follow-up",
    "",
    "- Step 1: capture the thread-open trace",
    "- Step 2: identify the main-thread bottleneck",
    "- Step 3: keep collapsed cards cheap",
    "- Step 4: render the full markdown only on demand",
    "- Step 5: preserve export and save actions",
    "- Step 6: add regression coverage",
    "- Step 7: verify route transitions stay responsive",
    "- Step 8: confirm no server-side work changed",
    "- Step 9: confirm short plans still render normally",
    "- Step 10: confirm long plans stay collapsed by default",
    "- Step 11: confirm preview text is still useful",
    "- Step 12: confirm plan follow-up flow still works",
    "- Step 13: confirm timeline virtualization still behaves",
    "- Step 14: confirm theme styling still looks correct",
    "- Step 15: confirm save dialog behavior is unchanged",
    "- Step 16: confirm download behavior is unchanged",
    "- Step 17: confirm code fences do not parse until expand",
    "- Step 18: confirm preview truncation ends cleanly",
    "- Step 19: confirm markdown links still open in editor after expand",
    "- Step 20: confirm deep hidden detail only appears after expand",
    "",
    "```ts",
    "export const hiddenPlanImplementationDetail = 'deep hidden detail only after expand';",
    "```",
  ].join("\n");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, {
            proposedPlans: [
              {
                id: "plan-browser-test",
                turnId: null,
                planMarkdown,
                implementedAt: null,
                implementationThreadId: null,
                createdAt: isoAt(1_000),
                updatedAt: isoAt(1_001),
              },
            ],
            updatedAt: isoAt(1_001),
          })
        : thread,
    ),
  };
}

function createSnapshotWithActiveInlinePlan(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-inline-plan-target" as MessageId,
    targetText: "inline plan thread",
    sessionStatus: "running",
  });
  const activeTurnId = TurnId.makeUnsafe("turn-inline-plan");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            latestTurn: {
              turnId: activeTurnId,
              state: "running",
              requestedAt: isoAt(1_000),
              startedAt: isoAt(1_001),
              completedAt: null,
              assistantMessageId: null,
            },
            activities: [
              {
                id: EventId.makeUnsafe("activity-inline-plan"),
                createdAt: isoAt(1_002),
                kind: "turn.tasks.updated",
                summary: "Tasks updated",
                tone: "info",
                turnId: activeTurnId,
                payload: {
                  tasks: [
                    {
                      task: "Inspecting ChatView boundaries",
                      status: "inProgress",
                    },
                    {
                      task: "Patch the shared checklist receiver",
                      status: "pending",
                    },
                    {
                      task: "Run final validation",
                      status: "completed",
                    },
                  ],
                },
              },
              {
                id: EventId.makeUnsafe("activity-inline-background-task"),
                createdAt: isoAt(1_003),
                kind: "task.started",
                summary: "Background agent started",
                tone: "info",
                turnId: activeTurnId,
                payload: {
                  taskId: "task-inline-background-agent",
                  taskType: "subagent",
                },
              },
            ],
            session: thread.session
              ? {
                  ...thread.session,
                  status: "running",
                  activeTurnId,
                  updatedAt: isoAt(1_003),
                }
              : null,
            updatedAt: isoAt(1_003),
          }
        : thread,
    ),
  };
}

function createSnapshotWithTallComposerStack(): OrchestrationReadModel {
  const snapshot = createSnapshotWithActiveInlinePlan();
  const activeTurnId = TurnId.makeUnsafe("turn-inline-plan");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            checkpoints: [
              {
                turnId: activeTurnId,
                checkpointTurnCount: 1,
                checkpointRef: CheckpointRef.makeUnsafe("checkpoint-inline-plan"),
                status: "ready",
                files: [
                  {
                    path: "apps/web/src/components/ChatView.tsx",
                    kind: "modified",
                    additions: 12,
                    deletions: 4,
                  },
                  {
                    path: "apps/web/src/components/ChatView.browser.tsx",
                    kind: "modified",
                    additions: 36,
                    deletions: 0,
                  },
                ],
                assistantMessageId: null,
                completedAt: isoAt(1_004),
              },
            ],
          }
        : thread,
    ),
  };
}

function createSnapshotWithSettledInlinePlan(): OrchestrationReadModel {
  const snapshot = createSnapshotWithActiveInlinePlan();
  const activeTurnId = TurnId.makeUnsafe("turn-inline-plan");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            latestTurn: {
              turnId: activeTurnId,
              state: "completed",
              requestedAt: isoAt(1_000),
              startedAt: isoAt(1_001),
              completedAt: isoAt(1_004),
              assistantMessageId: MessageId.makeUnsafe("msg-assistant-inline-plan-complete"),
            },
            messages: [
              ...thread.messages,
              {
                turnId: activeTurnId,
                id: MessageId.makeUnsafe("msg-assistant-inline-plan-complete"),
                role: "assistant",
                text: "Finished the investigation.",
                createdAt: isoAt(1_004),
                updatedAt: isoAt(1_004),
                completedAt: isoAt(1_004),
                streaming: false,
                source: "native",
              },
            ],
            session: thread.session
              ? {
                  ...thread.session,
                  status: "ready",
                  activeTurnId: null,
                  updatedAt: isoAt(1_004),
                }
              : null,
            updatedAt: isoAt(1_004),
          }
        : thread,
    ),
  };
}

// A plan-mode thread whose latest turn has settled and that still has an
// actionable (unimplemented) proposed plan. This is exactly the state where the
// live composer shows the plan-follow-up prompt, so it's the setup that used to
// misroute an auto-dispatched queued *chat* turn into the plan-follow-up path.
function createSnapshotWithSettledPlanAwaitingFollowUp(): OrchestrationReadModel {
  const snapshot = createSnapshotWithSettledInlinePlan();
  const planMarkdown = [
    "# Proposed plan",
    "",
    "- Step 1: capture the failing state",
    "- Step 2: apply the fix",
    "- Step 3: add regression coverage",
  ].join("\n");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            interactionMode: "plan",
            hasActionableProposedPlan: true,
            proposedPlans: [
              {
                id: "plan-awaiting-follow-up",
                turnId: null,
                planMarkdown,
                implementedAt: null,
                implementationThreadId: null,
                createdAt: isoAt(1_005),
                updatedAt: isoAt(1_005),
              },
            ],
            updatedAt: isoAt(1_005),
          }
        : thread,
    ),
  };
}

function createSnapshotWithInlineToolOverflow(options: {
  active: boolean;
}): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-inline-tools-target" as MessageId,
    targetText: "inline tools thread",
    sessionStatus: options.active ? "running" : "ready",
  });
  const activeTurnId = TurnId.makeUnsafe("turn-inline-tools");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            latestTurn: {
              turnId: activeTurnId,
              state: options.active ? "running" : "completed",
              requestedAt: isoAt(1_100),
              startedAt: isoAt(1_101),
              completedAt: options.active ? null : isoAt(1_108),
              assistantMessageId: MessageId.makeUnsafe("msg-assistant-inline-tools"),
            },
            activities: Array.from({ length: 6 }, (_, index) => ({
              id: EventId.makeUnsafe(`activity-inline-tool-${index + 1}`),
              createdAt: isoAt(1_102 + index),
              kind: "tool.completed" as const,
              summary: `tool ${index + 1}`,
              tone: "tool" as const,
              turnId: activeTurnId,
              payload: {
                itemType: "dynamic_tool_call",
                toolName: `tool-${index + 1}`,
              },
            })),
            messages: [
              ...thread.messages,
              {
                turnId: activeTurnId,
                id: MessageId.makeUnsafe("msg-assistant-inline-tools"),
                role: "assistant",
                text: "Wrapped up the inline tool review.",
                createdAt: isoAt(1_109),
                updatedAt: isoAt(1_109),
                completedAt: options.active ? undefined : isoAt(1_109),
                streaming: false,
                source: "native",
              },
            ],
            session: thread.session
              ? {
                  ...thread.session,
                  status: options.active ? "running" : "ready",
                  activeTurnId: options.active ? activeTurnId : null,
                  updatedAt: options.active ? isoAt(1_107) : isoAt(1_108),
                }
              : null,
            updatedAt: options.active ? isoAt(1_107) : isoAt(1_109),
          }
        : thread,
    ),
  };
}

function createSnapshotWithHistoricalToolHydrationDuringLiveTurn(options: {
  hydrateHistoricalActivities: boolean;
}): OrchestrationReadModel {
  const snapshot = createSnapshotWithInlineToolOverflow({ active: false });
  const liveTurnId = TurnId.makeUnsafe("turn-after-inline-tools");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            latestTurn: {
              turnId: liveTurnId,
              state: "running",
              requestedAt: isoAt(1_200),
              startedAt: isoAt(1_201),
              completedAt: null,
              assistantMessageId: MessageId.makeUnsafe("msg-assistant-live-after-history"),
            },
            activities: options.hydrateHistoricalActivities ? thread.activities : [],
            messages: [
              ...thread.messages,
              {
                turnId: liveTurnId,
                id: MessageId.makeUnsafe("msg-user-live-after-history"),
                role: "user",
                text: "Keep working while history hydrates.",
                createdAt: isoAt(1_200),
                updatedAt: isoAt(1_200),
                streaming: false,
                source: "native",
              },
              {
                turnId: liveTurnId,
                id: MessageId.makeUnsafe("msg-assistant-live-after-history"),
                role: "assistant",
                text: "Current turn is still running.",
                createdAt: isoAt(1_202),
                updatedAt: isoAt(1_202),
                streaming: false,
                source: "native",
              },
            ],
            session: thread.session
              ? {
                  ...thread.session,
                  status: "running",
                  activeTurnId: liveTurnId,
                  updatedAt: isoAt(1_202),
                }
              : null,
            updatedAt: isoAt(1_202),
          }
        : thread,
    ),
  };
}

function recordProjectCreateCommand(command: unknown): boolean {
  if (
    !command ||
    typeof command !== "object" ||
    !("type" in command) ||
    command.type !== "project.create" ||
    !("projectId" in command) ||
    !("workspaceRoot" in command) ||
    !("title" in command)
  ) {
    return false;
  }

  const projectId = command.projectId as ProjectId;
  fixture = {
    ...fixture,
    snapshot: {
      ...fixture.snapshot,
      snapshotSequence: fixture.snapshot.snapshotSequence + 1,
      projects: [
        ...fixture.snapshot.projects.filter((project) => project.id !== projectId),
        {
          id: projectId,
          kind:
            "kind" in command && (command.kind === "chat" || command.kind === "studio")
              ? command.kind
              : "project",
          title: String(command.title),
          workspaceRoot: String(command.workspaceRoot),
          defaultModelSelection:
            "defaultModelSelection" in command &&
            command.defaultModelSelection &&
            typeof command.defaultModelSelection === "object"
              ? (command.defaultModelSelection as OrchestrationReadModel["projects"][number]["defaultModelSelection"])
              : {
                  provider: "codex" as const,
                  model: "gpt-5",
                },
          scripts: [],
          createdAt:
            "createdAt" in command && typeof command.createdAt === "string"
              ? command.createdAt
              : NOW_ISO,
          updatedAt: NOW_ISO,
          deletedAt: null,
        },
      ],
      updatedAt: NOW_ISO,
    },
  };
  return true;
}

function resolveWsRpc(body: WsRequestEnvelope["body"]): unknown {
  const tag = body._tag;
  if (tag === ORCHESTRATION_WS_METHODS.getShellSnapshot) {
    return createShellSnapshotFromReadModel(fixture.snapshot);
  }
  if (tag === ORCHESTRATION_WS_METHODS.getSnapshot) {
    return fixture.snapshot;
  }
  if (tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
    if (recordProjectCreateCommand(body.command)) {
      return { sequence: fixture.snapshot.snapshotSequence };
    }
    return { sequence: fixture.snapshot.snapshotSequence + 1 };
  }
  if (tag === WS_METHODS.automationCreate) {
    return createAutomationDefinitionFromCreateRequest(body);
  }
  if (tag === WS_METHODS.serverGetSettings) {
    return createBrowserTestServerSettings(NOW_ISO);
  }
  if (tag === WS_METHODS.serverGetConfig) {
    return fixture.serverConfig;
  }
  if (tag === WS_METHODS.providerListModels) {
    // Keep the full-app fixture contract-valid and neutral. Returning the
    // generic `{}` fallback makes real discovery retry malformed responses,
    // which leaks unrelated retry pressure across this file's many mounts.
    return { models: [], source: "unsupported", cached: false };
  }
  if (tag === WS_METHODS.projectsListDevServers) {
    return { servers: [] };
  }
  if (tag === WS_METHODS.automationList) {
    return { definitions: [], runs: [] };
  }
  // The sidebar reads to-dos on Beta hosts; the `{}` fallback would fail to decode.
  if (tag === WS_METHODS.todoList) {
    return { todos: [] };
  }
  // The Code review badge shares the inbox list; keep its background read contract-valid.
  if (tag === WS_METHODS.githubInboxList) {
    return {
      viewer: null,
      items: [],
      errors: [],
      repositoryBatches: [],
      rateLimit: null,
      reviewRequestedCount: 0,
      reviewRequestedCountIncomplete: false,
    };
  }
  if (tag === WS_METHODS.gitListBranches) {
    const cwd = typeof body.cwd === "string" ? body.cwd : null;
    const branchName = cwd ? (fixture.gitBranchByCwd[cwd] ?? "main") : "main";
    return {
      isRepo: true,
      hasOriginRemote: true,
      branches: [
        {
          name: branchName,
          current: true,
          isDefault: true,
          worktreePath: null,
        },
      ],
    };
  }
  if (tag === WS_METHODS.gitStatus) {
    const cwd = typeof body.cwd === "string" ? body.cwd : null;
    const branchName = cwd ? (fixture.gitBranchByCwd[cwd] ?? "main") : "main";
    return {
      branch: branchName,
      hasWorkingTreeChanges: false,
      workingTree: {
        files: [],
        insertions: 0,
        deletions: 0,
      },
      hasUpstream: true,
      upstreamBranch: null,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    };
  }
  if (tag === WS_METHODS.gitCreateWorktree) {
    const requestedBranch =
      typeof body.newBranch === "string"
        ? body.newBranch
        : typeof body.branch === "string"
          ? body.branch
          : "main";
    return {
      worktree: {
        path: `/repo/.codex/worktrees/project/${requestedBranch.replaceAll("/", "-")}`,
        branch: requestedBranch,
      },
    };
  }
  if (tag === WS_METHODS.gitCreateDetachedWorktree) {
    return {
      worktree: {
        path: "/repo/.codex/worktrees/generated/synara",
        ref: "0123456789abcdef0123456789abcdef01234567",
        branch: typeof body.newBranch === "string" ? body.newBranch : null,
      },
    };
  }
  if (tag === WS_METHODS.projectsSearchEntries) {
    return {
      entries: [],
      truncated: false,
    };
  }
  if (tag === WS_METHODS.projectAgentListTasks) return { tasks: [], nextCursor: null };
  if (tag === WS_METHODS.projectAgentListActivity) return { activity: [], nextCursor: null };
  if (tag === WS_METHODS.projectAgentListDocuments) return { documents: [] };
  if (tag === WS_METHODS.projectAgentListThreadIndex) return { threads: [] };
  if (tag === WS_METHODS.projectAgentGetOverview) {
    const projectId = typeof body.projectId === "string" ? body.projectId : "";
    return fixture.projectAgentOverviews[projectId] ?? {};
  }
  if (tag === WS_METHODS.terminalOpen) {
    return {
      threadId: typeof body.threadId === "string" ? body.threadId : THREAD_ID,
      terminalId: typeof body.terminalId === "string" ? body.terminalId : "default",
      cwd: typeof body.cwd === "string" ? body.cwd : "/repo/project",
      status: "running",
      pid: 123,
      history: "",
      exitCode: null,
      exitSignal: null,
      updatedAt: NOW_ISO,
    };
  }
  if (
    tag === WS_METHODS.shellOpenInEditor ||
    tag === WS_METHODS.terminalWrite ||
    tag === WS_METHODS.terminalClose
  ) {
    return null;
  }
  return {};
}

function installDeterministicSendNativeApi(options?: {
  rejectTurnStart?: boolean;
  beforeWorktreeCreation?: () => Promise<void>;
  beforeTurnStart?: () => Promise<void>;
  projectThreadCommands?: boolean;
}): () => void {
  const previousNativeApi = window.nativeApi;
  const wsNativeApi = readNativeApi();
  if (!wsNativeApi) {
    throw new Error("Expected browser native API fixture.");
  }

  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: {
      ...wsNativeApi,
      git: {
        ...wsNativeApi.git,
        createDetachedWorktree: async (
          input: Parameters<typeof wsNativeApi.git.createDetachedWorktree>[0],
        ) => {
          const request: WsRequestEnvelope["body"] = {
            _tag: WS_METHODS.gitCreateDetachedWorktree,
            ...input,
          };
          wsRequests.push(request);
          await options?.beforeWorktreeCreation?.();
          return resolveWsRpc(request) as Awaited<
            ReturnType<typeof wsNativeApi.git.createDetachedWorktree>
          >;
        },
      },
      terminal: {
        ...wsNativeApi.terminal,
        open: async (input: Parameters<typeof wsNativeApi.terminal.open>[0]) => {
          const request: WsRequestEnvelope["body"] = {
            _tag: WS_METHODS.terminalOpen,
            ...input,
          };
          wsRequests.push(request);
          return resolveWsRpc(request) as Awaited<ReturnType<typeof wsNativeApi.terminal.open>>;
        },
        write: async (input: Parameters<typeof wsNativeApi.terminal.write>[0]) => {
          wsRequests.push({
            _tag: WS_METHODS.terminalWrite,
            ...input,
          });
        },
      },
      orchestration: {
        ...wsNativeApi.orchestration,
        dispatchCommand: async (
          command: Parameters<typeof wsNativeApi.orchestration.dispatchCommand>[0],
        ) => {
          wsRequests.push({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            command,
          });
          if (command.type === "thread.turn.start") await options?.beforeTurnStart?.();
          if (options?.rejectTurnStart && command.type === "thread.turn.start") {
            throw new Error("Turn start failed for test.");
          }
          if (options?.projectThreadCommands && command.type === "thread.create") {
            const snapshot = addThreadToSnapshot(fixture.snapshot, command.threadId);
            fixture.snapshot = {
              ...snapshot,
              threads: snapshot.threads.map((thread) =>
                thread.id === command.threadId
                  ? { ...thread, ...command, id: command.threadId, session: null }
                  : thread,
              ),
            };
            useStore.getState().syncServerReadModel(fixture.snapshot);
          }
          if (options?.projectThreadCommands && command.type === "thread.meta.update") {
            const patch = Object.fromEntries(
              Object.entries(command).filter(([, value]) => value !== undefined),
            );
            fixture.snapshot = {
              ...fixture.snapshot,
              snapshotSequence: fixture.snapshot.snapshotSequence + 1,
              threads: fixture.snapshot.threads.map((thread) =>
                thread.id === command.threadId ? { ...thread, ...patch } : thread,
              ),
            };
            useStore.getState().syncServerReadModel(fixture.snapshot);
          }
          return { sequence: fixture.snapshot.snapshotSequence + 1 };
        },
      },
    },
  });

  return () => {
    if (previousNativeApi) {
      Object.defineProperty(window, "nativeApi", {
        configurable: true,
        value: previousNativeApi,
      });
    } else {
      Reflect.deleteProperty(window, "nativeApi");
    }
  };
}

function toRecordedWsRequestBody(request: {
  readonly tag: string;
  readonly payload: unknown;
}): WsRequestEnvelope["body"] {
  if (request.tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
    return {
      _tag: request.tag,
      command: request.payload,
    };
  }
  return flattenEffectRpcRequestPayload(request.tag, request.payload);
}

const worker = setupWorker(
  wsLink.addEventListener("connection", ({ client }) => {
    client.addEventListener("message", (event) => {
      const rawData = event.data;
      if (typeof rawData !== "string") return;
      const parsed = readEffectRpcClientMessage(client, rawData);
      if (parsed.kind !== "request") return;

      const requestBody = toRecordedWsRequestBody(parsed.request);
      const method = requestBody._tag;
      wsRequests.push(requestBody);

      if (method === WS_METHODS.subscribeServerLifecycle) {
        sendEffectRpcChunk(client, parsed.request.id, {
          type: "welcome",
          payload: fixture.welcome,
        });
        return;
      }
      if (method === WS_METHODS.subscribeServerConfig) {
        sendEffectRpcChunk(client, parsed.request.id, {
          type: "snapshot",
          config: fixture.serverConfig,
        });
        return;
      }
      if (method === ORCHESTRATION_WS_METHODS.subscribeShell) {
        sendEffectRpcChunk(client, parsed.request.id, {
          kind: "snapshot",
          snapshot: createShellSnapshotFromReadModel(fixture.snapshot),
        });
        return;
      }
      if (method === ORCHESTRATION_WS_METHODS.subscribeThread && "threadId" in requestBody) {
        const threadId = requestBody.threadId as ThreadId;
        const thread = findThreadDetailFromFixtureSnapshot(threadId);
        if (!thread) {
          return;
        }
        sendEffectRpcChunk(client, parsed.request.id, {
          kind: "snapshot",
          snapshot: {
            snapshotSequence: fixture.snapshot.snapshotSequence,
            thread,
          },
        });
        return;
      }
      if (method === WS_METHODS.subscribeServerProviderStatuses) {
        if (fixture.providerStatusesSnapshot) {
          sendEffectRpcChunk(client, parsed.request.id, {
            providers: fixture.providerStatusesSnapshot,
          });
        }
        return;
      }
      if (
        method === WS_METHODS.subscribeServerSettings ||
        method === WS_METHODS.subscribeServerKeepAwake ||
        method === WS_METHODS.subscribeTerminalEvents ||
        method === WS_METHODS.subscribeOrchestrationDomainEvents ||
        method === WS_METHODS.subscribeProjectDevServerEvents ||
        method === WS_METHODS.subscribeAutomationEvents ||
        method === WS_METHODS.subscribeTodoEvents ||
        // Left open like the rest: these are infinite subscriptions, and the
        // default below answers with an Exit, which a stream RPC reads as the
        // socket dying and answers with a full reconnect. That loops forever
        // and starves the RPCs these tests are actually asserting on.
        method === DEVICE_WS_METHODS.subscribeEvents ||
        method === COMPUTER_WS_METHODS.subscribeEvents
      ) {
        return;
      }
      sendEffectRpcExit(client, parsed.request.id, resolveWsRpc(requestBody));
    });
  }),
  http.post(`*${ATTACHMENT_UPLOAD_ROUTE_PATH}`, async ({ request }) => {
    const url = new URL(request.url);
    const bytes = await request.arrayBuffer();
    await attachmentUploadBarrier;
    attachmentUploadSequence += 1;
    return HttpResponse.json(
      {
        type: url.searchParams.get("type") ?? "file",
        id: `att_v2_${String(attachmentUploadSequence).padStart(32, "0")}`,
        name: url.searchParams.get("name") ?? "attachment.bin",
        mimeType: url.searchParams.get("mimeType") ?? "application/octet-stream",
        sizeBytes: bytes.byteLength,
      },
      { status: 201 },
    );
  }),
  http.post(`*${ATTACHMENT_CANCEL_ROUTE_PATH}`, async () => {
    await attachmentCancelBarrier;
    return HttpResponse.json({ cancelled: true }, { status: 200 });
  }),
  http.get("*/attachments/:attachmentId", async () => {
    if (attachmentResponseDelayMs > 0) {
      await new Promise<void>((resolve) => {
        globalThis.setTimeout(() => resolve(), attachmentResponseDelayMs);
      });
    }
    return HttpResponse.text(ATTACHMENT_SVG, {
      headers: {
        "Content-Type": "image/svg+xml",
      },
    });
  }),
  http.get("*/api/project-favicon", () => new HttpResponse(null, { status: 204 })),
);

// React development builds capture an owner stack (an Error plus a console task)
// for the first 10,000 elements created after each reset, and reset at most once
// per wall-clock second. Whether a render lands inside that budget depends on
// timing, not on the rendered tree, and costs the same ~20 ms per Issue #550
// step at every thread size, so it decided that benchmark's ratio at random.
// Production builds never capture these stacks; report the budget as spent.
function skipReactDevOwnerStacks(): () => void {
  const internals = (
    React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: Record<string, unknown>;
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  // Fail loudly if a React upgrade renames the counter, instead of silently
  // bringing the timing-dependent capture back into the measurement.
  if (typeof internals?.recentlyCreatedOwnerStacks !== "number") {
    throw new Error("React no longer exposes recentlyCreatedOwnerStacks in development.");
  }
  Object.defineProperty(internals, "recentlyCreatedOwnerStacks", {
    configurable: true,
    get: () => Number.POSITIVE_INFINITY,
    set: () => {},
  });
  return () => {
    Object.defineProperty(internals, "recentlyCreatedOwnerStacks", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: 0,
    });
  };
}

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function mousePointerEvent(type: string, x: number, y: number): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerType: "mouse",
    pointerId: 1,
    isPrimary: true,
    button: 0,
    buttons: type === "pointerup" ? 0 : 1,
    clientX: x,
    clientY: y,
  });
}

async function waitForLayout(): Promise<void> {
  await nextFrame();
  await nextFrame();
  await nextFrame();
}

async function waitForTranscriptLayoutToSettle(container: HTMLElement): Promise<void> {
  let lastTop = container.scrollTop;
  let lastHeight = container.scrollHeight;
  let lastViewportHeight = container.clientHeight;
  let stableSince = performance.now();
  const scrollOffsets = [lastTop];
  await vi.waitFor(
    () => {
      if (
        container.scrollTop !== lastTop ||
        container.scrollHeight !== lastHeight ||
        container.clientHeight !== lastViewportHeight
      ) {
        lastTop = container.scrollTop;
        lastHeight = container.scrollHeight;
        lastViewportHeight = container.clientHeight;
        stableSince = performance.now();
        scrollOffsets.push(lastTop);
        if (scrollOffsets.length > 20) scrollOffsets.shift();
      }
      expect(
        performance.now() - stableSince,
        `Transcript scroll did not settle: ${scrollOffsets.join(" -> ")} (height ${container.scrollHeight}, viewport ${container.clientHeight})`,
      ).toBeGreaterThanOrEqual(150);
    },
    { timeout: 3_000, interval: 20 },
  );
}

/**
 * Whether the virtualized transcript is actually painted. LegendList keeps its
 * container wrapper at `opacity: 0` until its own initial scroll has finished,
 * so scroll corrections taken before that are invisible and must not count as
 * a visible scroll flight.
 */
function isTranscriptContentVisible(scrollContainer: HTMLElement): boolean {
  const wrapper = scrollContainer.querySelector<HTMLElement>('div[style*="opacity"]');
  if (!wrapper) {
    return false;
  }
  return Number.parseFloat(wrapper.style.opacity || "1") > 0;
}

/**
 * Samples the transcript's scroll position every frame while it is visible.
 * `downwardTravelPx` is the distance the reader actually watches the transcript
 * move; `maxDistanceFromBottomPx` is how far from the live edge it ever sat.
 */
async function recordTranscriptScrollTravel(durationMs: number): Promise<{
  readonly downwardTravelPx: number;
  readonly maxDistanceFromBottomPx: number;
  readonly visibleFrames: number;
}> {
  const startedAt = performance.now();
  let downwardTravelPx = 0;
  let maxDistanceFromBottomPx = 0;
  let visibleFrames = 0;
  let previousScrollTop: number | null = null;

  while (performance.now() - startedAt < durationMs) {
    await nextFrame();
    const container = document.querySelector<HTMLElement>("[data-chat-scroll-container='true']");
    if (!container || !isTranscriptContentVisible(container)) {
      previousScrollTop = null;
      continue;
    }
    if (container.scrollHeight <= container.clientHeight) {
      continue;
    }
    visibleFrames += 1;
    maxDistanceFromBottomPx = Math.max(
      maxDistanceFromBottomPx,
      getScrollContainerDistanceFromBottom(container),
    );
    if (previousScrollTop !== null) {
      downwardTravelPx += Math.max(0, container.scrollTop - previousScrollTop);
    }
    previousScrollTop = container.scrollTop;
  }

  return { downwardTravelPx, maxDistanceFromBottomPx, visibleFrames };
}

function installImmediateScrollToSpy(
  scrollContainer: HTMLElement,
  config?: { readonly suspendSmoothScroll?: boolean },
): {
  readonly calls: ScrollToOptions[];
  readonly restore: () => void;
} {
  const originalScrollTo = scrollContainer.scrollTo;
  const calls: ScrollToOptions[] = [];
  scrollContainer.scrollTo = ((options?: ScrollToOptions | number, y?: number) => {
    const normalized: ScrollToOptions =
      typeof options === "object" && options !== null
        ? options
        : {
            ...(typeof options === "number" ? { left: options } : {}),
            ...(typeof y === "number" ? { top: y } : {}),
          };
    calls.push(normalized);
    if (config?.suspendSmoothScroll && normalized.behavior === "smooth") {
      return;
    }
    if (typeof normalized.left === "number") {
      scrollContainer.scrollLeft = normalized.left;
    }
    if (typeof normalized.top === "number") {
      scrollContainer.scrollTop = normalized.top;
    }
    scrollContainer.dispatchEvent(new Event("scroll"));
  }) as typeof scrollContainer.scrollTo;

  return {
    calls,
    restore: () => {
      scrollContainer.scrollTo = originalScrollTo;
    },
  };
}

async function setViewport(viewport: ViewportSpec): Promise<void> {
  await page.viewport(viewport.width, viewport.height);
  await waitForLayout();
}

async function waitForProductionStyles(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(
        getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
      ).not.toBe("");
      expect(getComputedStyle(document.body).marginTop).toBe("0px");
    },
    {
      timeout: 4_000,
      interval: 16,
    },
  );
}

async function waitForElement<T extends Element>(
  query: () => T | null,
  errorMessage: string,
): Promise<T> {
  let element: T | null = null;
  await vi.waitFor(
    () => {
      element = query();
      expect(element, errorMessage).toBeTruthy();
    },
    {
      timeout: 8_000,
      interval: 16,
    },
  );
  if (!element) {
    throw new Error(errorMessage);
  }
  return element;
}

async function waitForURL(
  router: ReturnType<typeof getRouter>,
  predicate: (pathname: string) => boolean,
  errorMessage: string,
): Promise<string> {
  let pathname = "";
  await vi.waitFor(
    () => {
      pathname = router.state.location.pathname;
      expect(predicate(pathname), errorMessage).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
  return pathname;
}

async function waitForComposerEditor(): Promise<HTMLElement> {
  return waitForElement(
    () => document.querySelector<HTMLElement>('[contenteditable="true"]'),
    "Unable to find composer editor.",
  );
}

async function waitForSendButton(): Promise<HTMLButtonElement> {
  return waitForElement(
    () => document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]'),
    "Unable to find send button.",
  );
}

function readDispatchedCommand(request: WsRequestEnvelope["body"]): Record<string, unknown> | null {
  if (
    request._tag !== ORCHESTRATION_WS_METHODS.dispatchCommand ||
    typeof request.command !== "object" ||
    request.command === null
  ) {
    return null;
  }
  return request.command as Record<string, unknown>;
}

function hasDispatchedCommandType(type: string): boolean {
  return wsRequests.some((request) => readDispatchedCommand(request)?.type === type);
}

async function waitForWorktreeCheckbox(): Promise<HTMLElement> {
  return waitForElement(
    () =>
      document.querySelector<HTMLElement>('[data-empty-landing-controls] [data-slot="checkbox"]'),
    "Unable to find the Worktree checkbox.",
  );
}

async function waitForServerConfigToApply(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(wsRequests.some((request) => request._tag === WS_METHODS.serverGetConfig)).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
  await waitForLayout();
}

function dispatchComposerPickerShortcut(target: EventTarget, key: "m" | "e"): void {
  const useMetaForMod = isMacNavigatorPlatform();
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      shiftKey: true,
      metaKey: useMetaForMod,
      ctrlKey: !useMetaForMod,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function dispatchModelCycleShortcut(target: EventTarget, key: "[" | "]"): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    code: key === "]" ? "BracketRight" : "BracketLeft",
    altKey: true,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

async function dispatchModelCycleShortcutWhenReady(
  target: EventTarget,
  key: "[" | "]",
): Promise<void> {
  await vi.waitFor(
    () => {
      expect(dispatchModelCycleShortcut(target, key).defaultPrevented).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
}

function dispatchConfiguredShortcut(
  target: EventTarget,
  input: { key: string; shiftKey?: boolean; altKey?: boolean },
): KeyboardEvent {
  const useMetaForMod = isMacNavigatorPlatform();
  const event = new KeyboardEvent("keydown", {
    key: input.key,
    shiftKey: input.shiftKey ?? false,
    altKey: input.altKey ?? false,
    metaKey: useMetaForMod,
    ctrlKey: !useMetaForMod,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

// Re-dispatches until the shortcut handler consumes the event: the resolved
// keybindings land asynchronously after `serverGetConfig`, so a single dispatch
// can race the config apply.
async function dispatchConfiguredShortcutWhenReady(
  target: EventTarget,
  input: { key: string; shiftKey?: boolean; altKey?: boolean },
): Promise<void> {
  await vi.waitFor(
    () => {
      expect(dispatchConfiguredShortcut(target, input).defaultPrevented).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
}

function dispatchComposerFocusToggleShortcut(): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "l",
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
}

// The composer model/effort shortcuts both drop into the same combined picker,
// rendered as a Base UI menu popup. Provider and effort detail live in lazily
// mounted submenus, so the reliable signal that the surface opened is the popup
// mounting with the active model label (the fixture pins the thread to gpt-5).
async function waitForComposerPickerSurfaceOpen(): Promise<void> {
  await vi.waitFor(() => {
    const popup = document.querySelector('[data-slot="menu-popup"]');
    expect(popup).not.toBeNull();
    expect(popup?.textContent ?? "").toContain("GPT-5");
  });
}

function dispatchChatNewShortcut(): void {
  dispatchThreadShortcut("o");
}

function dispatchTerminalThreadShortcut(): void {
  dispatchThreadShortcut("t");
}

function dispatchThreadShortcut(key: string): void {
  const useMetaForMod = isMacNavigatorPlatform();
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      shiftKey: true,
      metaKey: useMetaForMod,
      ctrlKey: !useMetaForMod,
      bubbles: true,
      cancelable: true,
    }),
  );
}

async function triggerChatNewShortcutUntilPath(
  router: ReturnType<typeof getRouter>,
  predicate: (pathname: string) => boolean,
  errorMessage: string,
): Promise<string> {
  return triggerThreadShortcutUntilPath(router, dispatchChatNewShortcut, predicate, errorMessage);
}

async function triggerTerminalThreadShortcutUntilPath(
  router: ReturnType<typeof getRouter>,
  predicate: (pathname: string) => boolean,
  errorMessage: string,
): Promise<string> {
  return triggerThreadShortcutUntilPath(
    router,
    dispatchTerminalThreadShortcut,
    predicate,
    errorMessage,
  );
}

async function triggerThreadShortcutUntilPath(
  router: ReturnType<typeof getRouter>,
  dispatchShortcut: () => void,
  predicate: (pathname: string) => boolean,
  errorMessage: string,
): Promise<string> {
  let pathname = router.state.location.pathname;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    dispatchShortcut();
    await waitForLayout();
    pathname = router.state.location.pathname;
    if (predicate(pathname)) {
      return pathname;
    }
  }
  throw new Error(`${errorMessage} Last path: ${pathname}`);
}

async function waitForNewThreadShortcutLabel(): Promise<void> {
  const newThreadButton = page.getByTestId("new-thread-button");
  await expect.element(newThreadButton).toBeInTheDocument();
  await waitForLayout();
}

async function waitForImagesToLoad(scope: ParentNode): Promise<void> {
  const images = Array.from(scope.querySelectorAll("img"));
  if (images.length === 0) {
    return;
  }
  await Promise.all(
    images.map(
      (image) =>
        new Promise<void>((resolve) => {
          if (image.complete) {
            resolve();
            return;
          }
          image.addEventListener("load", () => resolve(), { once: true });
          image.addEventListener("error", () => resolve(), { once: true });
        }),
    ),
  );
  await waitForLayout();
}

async function measureUserRow(options: {
  host: HTMLElement;
  targetMessageId: MessageId;
}): Promise<UserRowMeasurement> {
  const { host, targetMessageId } = options;
  const rowSelector = `[data-message-id="${targetMessageId}"][data-message-role="user"]`;

  const scrollContainer = await waitForElement(
    () => host.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
    "Unable to find ChatView message scroll container.",
  );

  let row: HTMLElement | null = null;
  await vi.waitFor(
    async () => {
      scrollContainer.scrollTop = 0;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();
      row = host.querySelector<HTMLElement>(rowSelector);
      expect(row, "Unable to locate targeted user message row.").toBeTruthy();
    },
    {
      timeout: 8_000,
      interval: 16,
    },
  );

  await waitForImagesToLoad(row!);
  scrollContainer.scrollTop = 0;
  scrollContainer.dispatchEvent(new Event("scroll"));
  await nextFrame();

  let timelineWidthMeasuredPx = 0;
  let measuredRowHeightPx = 0;
  await vi.waitFor(
    async () => {
      scrollContainer.scrollTop = 0;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await nextFrame();
      const measuredRow = host.querySelector<HTMLElement>(rowSelector);
      expect(measuredRow, "Unable to measure targeted user row height.").toBeTruthy();
      timelineWidthMeasuredPx = measuredRow!.getBoundingClientRect().width;
      measuredRowHeightPx = measuredRow!.getBoundingClientRect().height;
      expect(timelineWidthMeasuredPx, "Unable to measure timeline width.").toBeGreaterThan(0);
      expect(measuredRowHeightPx, "Unable to measure targeted user row height.").toBeGreaterThan(0);
    },
    {
      timeout: 4_000,
      interval: 16,
    },
  );

  return { measuredRowHeightPx, timelineWidthMeasuredPx };
}

async function measureChatLayout(host: HTMLElement): Promise<ChatLayoutMeasurement> {
  const scrollContainer = await waitForElement(
    () => host.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
    "Unable to find ChatView message scroll container.",
  );
  const composerForm = await waitForElement(
    () => host.querySelector<HTMLElement>("[data-chat-composer-form='true']"),
    "Unable to find chat composer form.",
  );

  await waitForLayout();

  const hostHeightPx = host.getBoundingClientRect().height;
  const composerBottomPx = composerForm.getBoundingClientRect().bottom;
  return {
    hostHeightPx,
    composerBottomPx,
    scrollClientHeightPx: scrollContainer.clientHeight,
    scrollHeightPx: scrollContainer.scrollHeight,
    distanceFromBottomPx: getScrollContainerDistanceFromBottom(scrollContainer),
  };
}

async function waitForMountedChatReady(options: {
  host: HTMLElement;
  snapshot: OrchestrationReadModel;
  routeThreadId: ThreadId;
}): Promise<void> {
  const expectedThread = options.snapshot.threads.find(
    (thread) => thread.id === options.routeThreadId,
  );

  await vi.waitFor(
    () => {
      expect(
        options.host.querySelector("[data-chat-composer-form='true']"),
        "Chat composer did not mount.",
      ).toBeTruthy();
      expect(
        wsRequests.some((request) => request._tag === WS_METHODS.serverGetConfig),
        "Browser RPC configuration did not load.",
      ).toBe(true);

      if (!expectedThread) return;
      const state = useStore.getState();
      expect(state.threadIds?.includes(expectedThread.id)).toBe(true);
      const hydratedMessageIdSet = new Set(state.messageIdsByThreadId?.[expectedThread.id] ?? []);
      expect(
        expectedThread.messages.every((message) => hydratedMessageIdSet.has(message.id)),
        "Active thread detail did not hydrate.",
      ).toBe(true);
    },
    { timeout: 20_000, interval: 16 },
  );
  await waitForLayout();
}

async function mountChatView(options: {
  viewport: ViewportSpec;
  snapshot: OrchestrationReadModel;
  configureFixture?: (fixture: TestFixture) => void;
  initialEntry?: string;
  onRender?: ProfilerOnRenderCallback;
}): Promise<MountedChatView> {
  fixture = buildFixture(options.snapshot);
  options.configureFixture?.(fixture);
  await setViewport(options.viewport);
  await waitForProductionStyles();

  const host = createFullscreenTestHost();

  const initialEntry = options.initialEntry ?? `/${THREAD_ID}`;

  const router = getRouter(
    createMemoryHistory({
      initialEntries: [initialEntry],
    }),
  );

  const content = options.onRender ? (
    <Profiler id="issue-550-root" onRender={options.onRender}>
      <RouterProvider router={router} />
    </Profiler>
  ) : (
    <RouterProvider router={router} />
  );
  const screen = await render(content, {
    container: host,
  });

  try {
    await waitForMountedChatReady({
      host,
      snapshot: options.snapshot,
      routeThreadId: ThreadId.makeUnsafe(initialEntry.slice(1)),
    });
  } catch (cause) {
    await screen.unmount();
    if (host.isConnected) host.remove();
    throw cause;
  }

  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    await screen.unmount();
    if (host.isConnected) host.remove();
    // React Query retries and background refetches outlive the unmounted tree.
    // A leftover provider-discovery retry can recreate the websocket API inside
    // the next test's beforeEach reset window, before that test configures its
    // fixture; the transport then caches the neutral fixture's welcome, which
    // onServerWelcome replays, so the next mount never receives its workspace
    // paths. Cancel and drop this mount's queries so nothing outlives the test.
    await router.options.context.queryClient.cancelQueries();
    router.options.context.queryClient.clear();
  };

  return {
    [Symbol.asyncDispose]: cleanup,
    cleanup,
    measureLayout: async () => measureChatLayout(host),
    measureUserRow: async (targetMessageId: MessageId) => measureUserRow({ host, targetMessageId }),
    setViewport: async (viewport: ViewportSpec) => {
      await setViewport(viewport);
      await waitForProductionStyles();
    },
    router,
  };
}

describe("ChatView transcript geometry (full app)", () => {
  it("keeps the active chat explicitly unread until the next visit", async () => {
    const snapshot = createSnapshotWithInlineToolOverflow({ active: false });
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    try {
      const shell = () => useStore.getState().threadShellById?.[THREAD_ID];
      const completedAt = snapshot.threads.find((thread) => thread.id === THREAD_ID)!.latestTurn!
        .completedAt!;
      await expect
        .poll(() => Date.parse(shell()?.lastVisitedAt ?? ""))
        .toBeGreaterThanOrEqual(Date.parse(completedAt));
      const input = document.querySelector('[data-chat-composer-form="true"]')!;
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "u",
          code: "KeyU",
          metaKey: isMacNavigatorPlatform(),
          ctrlKey: !isMacNavigatorPlatform(),
          altKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await waitForLayout();
      expect(Date.parse(shell()?.lastVisitedAt ?? "")).toBe(Date.parse(completedAt) - 1);
      await mounted.router.navigate({ to: "/" });
      await mounted.router.navigate({ to: "/$threadId", params: { threadId: THREAD_ID } });
      await expect
        .poll(() => Date.parse(shell()?.lastVisitedAt ?? ""))
        .toBeGreaterThanOrEqual(Date.parse(completedAt));
    } finally {
      await mounted.cleanup();
    }
  });

  beforeAll(async () => {
    fixture = buildFixture(
      createSnapshotForTargetUser({
        targetMessageId: "msg-user-bootstrap" as MessageId,
        targetText: "bootstrap",
      }),
    );
    await worker.start({
      onUnhandledRequest: "bypass",
      quiet: true,
      serviceWorker: {
        url: "/mockServiceWorker.js",
      },
    });
  });

  afterAll(async () => {
    await resetWsNativeApiForTest();
    await worker.stop();
  });

  beforeEach(async () => {
    // Reset the shared fixture snapshot to a neutral, low-sequence shell before
    // disposing the old transport. Any in-flight getShellSnapshot that resolves
    // after this point will then return sequence 0, which the next test's real
    // snapshot will supersede.
    fixture = buildFixture({
      ...fixture.snapshot,
      snapshotSequence: 0,
      spaces: [],
      projects: [],
      threads: [],
      updatedAt: NOW_ISO,
    });
    await resetWsNativeApiForTest();
    resetRetainedThreadDetailSubscriptionsForTests();
    await resetHomeChatProjectPrewarmStateForTests();
    attachmentResponseDelayMs = 0;
    attachmentUploadSequence = 0;
    attachmentUploadBarrier = null;
    attachmentCancelBarrier = null;
    localStorage.clear();
    acknowledgeStartupAnnouncementsForTest(createBaseServerConfig());
    useProjectEnvironmentStore.setState({ envModeByProjectId: {} });
    useThreadDispatchStore.setState({ threads: {} });
    useLatestProjectStore.setState({ latestProjectId: null });
    useWorkspacePathsStore.setState({
      homeDir: null,
      chatWorkspaceRoot: null,
      studioWorkspaceRoot: null,
      groupsWorkspaceRoot: null,
    });
    document.body.innerHTML = "";
    wsRequests.length = 0;
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
    useStore.setState({
      shellSnapshotSequence: 0,
      spaces: [],
      projects: [],
      threadIds: [],
      threadShellById: {},
      threadSessionById: {},
      threadTurnStateById: {},
      messageIdsByThreadId: {},
      messageByThreadId: {},
      activityIdsByThreadId: {},
      activityByThreadId: {},
      proposedPlanIdsByThreadId: {},
      proposedPlanByThreadId: {},
      turnDiffIdsByThreadId: {},
      turnDiffSummaryByThreadId: {},
      threadDetailSyncById: {},
      deletedProjectIdsById: {},
      deletedThreadIdsById: {},
      sidebarThreadSummaryById: {},
      threadsHydrated: false,
    });
    useTemporaryThreadStore.setState({
      temporaryThreadIds: {},
    });
    useTerminalStateStore.setState({
      terminalStateByThreadId: {},
    });
    useSplitViewStore.setState({
      splitViewsById: {},
      splitViewIdBySourceThreadId: {},
    });
  });

  afterEach(async () => {
    await resetHomeChatProjectPrewarmStateForTests();
    resetRetainedThreadDetailSubscriptionsForTests();
    document.body.innerHTML = "";
  });

  it("keeps persistent turn failure visible after reopening and admits one manual continuation", async () => {
    const base = createSnapshotForTargetUser({
      targetMessageId: MessageId.makeUnsafe("failure-user"),
      targetText: "Review the requested pull requests",
    });
    const turnId = TurnId.makeUnsafe("failed-turn");
    const cause = "Selected model is at capacity. Please try a different model.";
    const snapshot: OrchestrationReadModel = {
      ...base,
      threads: [
        {
          ...base.threads[0]!,
          messages: [
            createUserMessage({
              id: MessageId.makeUnsafe("failure-user"),
              text: "Review the requested pull requests",
              offsetSeconds: 0,
            }),
            {
              ...createAssistantMessage({
                id: MessageId.makeUnsafe("progress"),
                text: "I am checking the pull requests and their conflicts.",
                offsetSeconds: 3,
              }),
              turnId,
            },
          ],
          latestTurn: {
            turnId,
            state: "error",
            requestedAt: NOW_ISO,
            startedAt: NOW_ISO,
            completedAt: isoAt(10),
            assistantMessageId: null,
          },
          activities: [
            {
              id: EventId.makeUnsafe("fatal-error"),
              turnId,
              createdAt: isoAt(10),
              sequence: 1,
              kind: "runtime.error",
              tone: "error",
              summary: "Provider runtime error",
              payload: { message: cause, class: "provider_error" },
            },
            {
              id: EventId.makeUnsafe("failed-completed"),
              turnId,
              createdAt: isoAt(10),
              sequence: 2,
              kind: "turn.completed",
              tone: "error",
              summary: "Turn failed",
              payload: { state: "failed", errorMessage: cause },
            },
          ],
        },
      ],
    };
    const first = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    await expect.element(page.getByText("Task interrupted", { exact: true })).toBeVisible();
    await first.cleanup();
    const reopened = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    let releaseSend!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const restoreApi = installDeterministicSendNativeApi({ beforeTurnStart: () => barrier });
    try {
      await expect.element(page.getByText("Task interrupted", { exact: true })).toBeVisible();
      expect(document.querySelectorAll("[data-turn-failure]")).toHaveLength(1);
      await page.getByRole("button", { name: "Change model", exact: true }).click();
      await expect.element(page.getByLabelText("Search models", { exact: true })).toBeVisible();
      page
        .getByLabelText("Search models", { exact: true })
        .element()
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await page.getByRole("button", { name: "Continue task", exact: true }).click();
      // Exercise a second click before the first dispatch settles.
      (
        page
          .getByRole("button", { name: "Continue task", exact: true })
          .element() as HTMLButtonElement
      ).click();
      await vi.waitFor(() => {
        const starts = wsRequests.filter(
          (request) =>
            request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            "command" in request &&
            (request.command as { type?: string }).type === "thread.turn.start",
        );
        expect(starts).toHaveLength(1);
        expect(starts[0]?.command).toMatchObject({
          threadId: THREAD_ID,
          message: { text: expect.stringContaining("avoid repeating") },
        });
      });
      expect(document.querySelectorAll("[data-turn-failure]")).toHaveLength(1);
    } finally {
      releaseSend();
      restoreApi();
      await reopened.cleanup();
    }
  });

  it.each([
    { activityViewEnabled: false, customShortcut: false },
    { activityViewEnabled: true, customShortcut: false },
    { activityViewEnabled: false, customShortcut: true },
    { activityViewEnabled: true, customShortcut: true },
  ])(
    "keeps sidebar shortcut hints clear of row content (Activity: $activityViewEnabled, custom: $customShortcut)",
    async ({ activityViewEnabled, customShortcut }) => {
      const base = createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("shortcut-layout"),
        targetText: "Review the sidebar layout",
      });
      const titles = [
        "Review authentication and session recovery",
        "Improve the checkout flow",
        "Check the background worker",
        "Update the account settings",
        "Investigate a long-running worktree task",
        "Review the session cancellation tests",
        "Review the deployment checklist",
      ];
      const now = new Date().toISOString();
      const threads = titles.map((title, index) => ({
        ...base.threads[0]!,
        id: index === 0 ? THREAD_ID : ThreadId.makeUnsafe(`shortcut-layout-${index}`),
        title,
        createdAt: now,
        updatedAt: now,
        latestTurn: {
          turnId: TurnId.makeUnsafe(`shortcut-layout-turn-${index}`),
          state: "completed" as const,
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          assistantMessageId: null,
        },
        session: {
          ...base.threads[0]!.session!,
          threadId: index === 0 ? THREAD_ID : ThreadId.makeUnsafe(`shortcut-layout-${index}`),
          updatedAt: now,
        },
        messages: index === 0 ? base.threads[0]!.messages : [],
        envMode: index % 2 === 0 ? ("local" as const) : ("worktree" as const),
        worktreePath: index % 2 === 0 ? null : `/repo/worktrees/sidebar-${index}`,
        branch: index % 2 === 0 ? "main" : "fix/authentication-session-recovery",
        forkSourceThreadId: index === 1 ? THREAD_ID : null,
        parentThreadId:
          index === 0 ? ThreadId.makeUnsafe("shortcut-layout-6") : index === 5 ? THREAD_ID : null,
        subagentNickname: index === 0 ? "Atlas" : index === 5 ? "Nova" : null,
      }));
      const snapshot = {
        ...base,
        projects: base.projects.map((project) => ({
          ...project,
          title: "Customer portal workspace",
        })),
        threads,
      };
      const previousPins = usePinnedThreadsStore.getState().pinnedThreadIds;
      usePinnedThreadsStore.setState({
        pinnedThreadIds: threads.slice(1, 4).map((thread) => thread.id),
      });
      onTestFinished(() => {
        usePinnedThreadsStore.setState({ pinnedThreadIds: previousPins });
      });
      localStorage.setItem("synara:sidebar-ui:v1", JSON.stringify({ activityViewEnabled }));
      if (customShortcut) {
        const platformSpy = vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
        onTestFinished(() => platformSpy.mockRestore());
      }
      const mounted = await mountChatView({
        viewport: { ...DEFAULT_VIEWPORT, width: 1280, height: 800 },
        snapshot,
        configureFixture: (nextFixture) => {
          if (!customShortcut) return;
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            keybindings: Array.from({ length: 9 }, (_, index) => ({
              command: threadJumpCommandForIndex(index)!,
              shortcut: {
                key: String(index + 1),
                modKey: false,
                metaKey: true,
                ctrlKey: true,
                shiftKey: true,
                altKey: true,
              },
            })),
          };
        },
      });
      try {
        await waitForServerConfigToApply();
        const sidebar = document.querySelector<HTMLElement>('[data-slot="sidebar-container"]')!;
        expect(sidebar).toBeTruthy();
        const wrapper = sidebar.closest<HTMLElement>('[data-slot="sidebar-wrapper"]')!;
        const resizeSidebar = async (width: number) => {
          wrapper.style.setProperty("--sidebar-width", `${width}px`);
          await vi.waitFor(() =>
            expect(sidebar.getBoundingClientRect().width).toBeCloseTo(width, 0),
          );
        };
        const mod = isMacNavigatorPlatform() ? "Meta" : "Control";
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        await userEvent.unhover(sidebar);
        for (const fontSize of [13, 18]) {
          const scale = getAppTypographyScale(fontSize);
          for (const [token, value] of Object.entries({
            ui: scale.uiPx,
            "ui-lg": scale.uiLgPx,
            "ui-sm": scale.uiSmPx,
            "ui-xs": scale.uiXsPx,
            "ui-meta": scale.uiMetaPx,
          })) {
            document.documentElement.style.setProperty(`--app-font-size-${token}`, `${value}px`);
          }
          for (const width of [208, 256, 320]) {
            await resizeSidebar(width);
            window.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: mod,
                metaKey: customShortcut || mod === "Meta",
                ctrlKey: customShortcut || mod === "Control",
                altKey: customShortcut,
                shiftKey: customShortcut,
                bubbles: true,
              }),
            );
            await waitForLayout();
            const hints = [...sidebar.querySelectorAll<HTMLElement>('[data-slot="kbd"]')].filter(
              (hint) => hint.closest("[data-thread-item]"),
            );
            expect(hints.length).toBe(activityViewEnabled ? 5 : 6);
            if (!activityViewEnabled) expect(sidebar.textContent).toContain("Atlas");
            if (customShortcut) expect(hints[0]!.textContent).toContain("Ctrl+Alt+Shift+Meta");
            for (const hint of hints) {
              const row = hint.closest<HTMLElement>("[data-thread-item]")!;
              expect(row).toBeTruthy();
              const hintRect = hint.getBoundingClientRect();
              expect(hintRect.right).toBeLessThanOrEqual(row.getBoundingClientRect().right);
              // The chord is one capsule now; it must keep at least a key's width.
              expect(hintRect.width).toBeGreaterThanOrEqual(20);
              for (const chip of row.querySelectorAll<HTMLElement>(".sidebar-icon-chip")) {
                const rect = chip.getBoundingClientRect();
                if (rect.top < hintRect.bottom && rect.bottom > hintRect.top) {
                  expect(rect.right).toBeLessThanOrEqual(hintRect.left);
                }
              }
              const labels = [...row.querySelectorAll<HTMLElement>("span")].filter(
                (element) =>
                  element.classList.contains("truncate-fade") ||
                  (!element.parentElement?.closest(".truncate-fade") &&
                    (element.textContent === "Customer portal workspace" ||
                      titles.includes(element.textContent ?? ""))),
              );
              expect(labels.length).toBeGreaterThan(0);
              for (const label of labels) {
                const rect = label.getBoundingClientRect();
                if (rect.top < hintRect.bottom && rect.bottom > hintRect.top) {
                  expect(
                    rect.right,
                    `${label.textContent} overlaps ${hint.textContent}`,
                  ).toBeLessThanOrEqual(hintRect.left);
                }
              }
            }
            for (const hoverHint of hints.filter(
              (hint, index) =>
                index === 0 || hint.closest("[data-thread-item]")!.textContent?.includes("Atlas"),
            )) {
              const row = hoverHint.closest<HTMLElement>("[data-thread-item]")!;
              const actions = activityViewEnabled
                ? row.querySelector<HTMLElement>(
                    'span[class*="group-hover/activity-row:opacity-100"]',
                  )!
                : row.querySelector<HTMLElement>('[data-testid^="thread-hover-actions-"]')!;
              // The geometry contract is about settled hover/focus visibility, not
              // transition timing. Under parallel Chromium CI, animation frames can
              // lag past waitFor's deadline. Keep the real hover/focus selectors
              // active but make these two measured transitions instantaneous.
              hoverHint.style.setProperty("transition-duration", "0s", "important");
              actions.style.setProperty("transition-duration", "0s", "important");
              const hoverGroup = row.closest<HTMLElement>(
                activityViewEnabled
                  ? '[class~="group/activity-row"]'
                  : '[class~="group/thread-row"]',
              )!;
              await userEvent.unhover(row);
              await userEvent.hover(row);
              const assertHoverLayout = () => {
                expect(
                  Number(getComputedStyle(hoverHint).opacity),
                  `Shortcut ${hoverHint.textContent} should fade (hover=${hoverGroup.matches(":hover")}, focus=${hoverGroup.contains(document.activeElement)})`,
                ).toBe(0);
                expect(Number(getComputedStyle(actions).opacity)).toBe(1);
                const actionsRect = actions.getBoundingClientRect();
                for (const label of [...row.querySelectorAll<HTMLElement>("span")].filter(
                  (element) =>
                    element.classList.contains("truncate-fade") ||
                    (!element.parentElement?.closest(".truncate-fade") &&
                      (element.textContent === "Customer portal workspace" ||
                        titles.includes(element.textContent ?? ""))),
                )) {
                  const rect = label.getBoundingClientRect();
                  if (rect.top < actionsRect.bottom && rect.bottom > actionsRect.top) {
                    expect(
                      rect.right,
                      `${label.textContent} overlaps hover actions`,
                    ).toBeLessThanOrEqual(actionsRect.left);
                  }
                }
              };
              await vi.waitFor(assertHoverLayout, { timeout: 3_000 });
              await userEvent.unhover(row);
              const focusTarget = row.matches('[role="button"]')
                ? row
                : row.querySelector<HTMLElement>('button, [role="button"]')!;
              focusTarget.focus();
              await vi.waitFor(assertHoverLayout, { timeout: 3_000 });
              focusTarget.blur();
            }
            window.dispatchEvent(new KeyboardEvent("keyup", { key: mod, bubbles: true }));
            await waitForLayout();
            expect(sidebar.querySelector('[data-thread-item] [data-slot="kbd"]')).toBeNull();
          }
        }
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it.each(["user", "assistant"] as const)(
    "opens the linked PR number from a %s message when the repository path also contains pull",
    async (role) => {
      useRightDockStore.setState({ dockStateByThreadId: {} });
      const url = "https://github.com/pull/123/pull/456";
      const snapshot = createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("linked-pr"),
        targetText: url,
      });
      const message =
        role === "user"
          ? createUserMessage({
              id: MessageId.makeUnsafe("linked-pr"),
              text: url,
              offsetSeconds: 0,
            })
          : createAssistantMessage({
              id: MessageId.makeUnsafe("linked-pr"),
              text: `[Inspect PR](${url})`,
              offsetSeconds: 0,
            });
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: { ...snapshot, threads: [{ ...snapshot.threads[0]!, messages: [message] }] },
      });
      const previousNativeApi = window.nativeApi;
      const api = readNativeApi()!;
      const repository = { nameWithOwner: "pull/123", url: "https://github.com/pull/123" };
      Object.defineProperty(window, "nativeApi", {
        configurable: true,
        value: {
          ...api,
          git: {
            ...api.git,
            githubRepository: async () => ({ repository, repositories: [repository] }),
          },
        },
      });
      try {
        const link = page.getByRole(role === "user" ? "button" : "link", {
          name: role === "user" ? "pull/123#456" : "Inspect PR",
          exact: true,
        });
        await link.click({ button: "right" });
        await expect
          .element(page.getByRole("button", { name: "Open pull request", exact: true }))
          .toBeVisible();
        await expect
          .element(page.getByRole("button", { name: "Open in browser", exact: true }))
          .toBeVisible();
        await expect
          .element(page.getByRole("button", { name: "Open in external browser", exact: true }))
          .toBeVisible();
        await expect
          .element(page.getByRole("button", { name: "Copy link", exact: true }))
          .toBeVisible();
        await page.getByRole("button", { name: "Open pull request", exact: true }).click();
        await vi.waitFor(() => {
          expect(useRightDockStore.getState().dockStateByThreadId[THREAD_ID]?.panes).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                kind: "pullRequest",
                pullRequestProjectId: PROJECT_ID,
                pullRequestRepository: "pull/123",
                pullRequestNumber: 456,
              }),
            ]),
          );
        });
        useRightDockStore.setState({ dockStateByThreadId: {} });
        await link.click();
        await vi.waitFor(() => {
          expect(useRightDockStore.getState().dockStateByThreadId[THREAD_ID]?.panes).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ kind: "pullRequest", pullRequestNumber: 456 }),
            ]),
          );
        });
      } finally {
        if (previousNativeApi) {
          Object.defineProperty(window, "nativeApi", {
            configurable: true,
            value: previousNativeApi,
          });
        } else {
          Reflect.deleteProperty(window, "nativeApi");
        }
        await mounted.cleanup();
      }
    },
  );

  it.each([
    { kind: "forked", repository: "acme/widgets", opens: "the host chat dock" },
    { kind: "forked", repository: "other/repo", opens: "the external browser" },
    { kind: "standalone", repository: "acme/widgets", opens: "Code review" },
  ] as const)(
    "opens a $repository pull request link from a $kind side chat in $opens",
    async ({ kind, repository: linkedRepository }) => {
      useRightDockStore.setState({ dockStateByThreadId: {} });
      const url = `https://github.com/${linkedRepository}/pull/41`;
      const sidechatId = ThreadId.makeUnsafe("sidechat-pr-link");
      const base = addThreadToSnapshot(
        createSnapshotForTargetUser({
          targetMessageId: MessageId.makeUnsafe("sidechat-pr-main"),
          targetText: "Main conversation",
        }),
        sidechatId,
      );
      const snapshot = {
        ...base,
        threads: base.threads.map((thread) =>
          thread.id === sidechatId
            ? {
                ...thread,
                ...(kind === "forked"
                  ? { sidechatSourceThreadId: THREAD_ID }
                  : {
                      sidechatContext: {
                        kind: "github-item" as const,
                        itemKind: "pullRequest" as const,
                        repository: "acme/widgets",
                        number: 1368,
                        url: "https://github.com/acme/widgets/pull/1368",
                      },
                    }),
                messages: [
                  createAssistantMessage({
                    id: MessageId.makeUnsafe("sidechat-pr-link"),
                    text: `[Inspect PR](${url})`,
                    offsetSeconds: 0,
                  }),
                ],
              }
            : thread,
        ),
      };
      const dockHostId = kind === "forked" ? THREAD_ID : GITHUB_INBOX_DOCK_HOST_ID;
      useRightDockStore.getState().openPane(dockHostId, { kind: "sidechat", threadId: sidechatId });
      const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
      const previousNativeApi = window.nativeApi;
      const api = readNativeApi()!;
      const repository = { nameWithOwner: "acme/widgets", url: "https://github.com/acme/widgets" };
      const openedExternally: string[] = [];
      Object.defineProperty(window, "nativeApi", {
        configurable: true,
        value: {
          ...api,
          git: {
            ...api.git,
            githubRepository: async () => ({ repository, repositories: [repository] }),
          },
          shell: {
            ...api.shell,
            openExternal: async (href: string) => {
              openedExternally.push(href);
            },
          },
        },
      });
      const pullRequestNumbers = (hostId: ThreadId) =>
        (useRightDockStore.getState().dockStateByThreadId[hostId]?.panes ?? [])
          .filter((pane) => pane.kind === "pullRequest")
          .map((pane) => pane.pullRequestNumber);
      try {
        if (kind === "standalone") {
          await mounted.router.navigate({
            to: "/pull-requests",
            search: {
              kind: "pullRequest",
              selectedProjectId: PROJECT_ID,
              selectedRepo: "acme/widgets",
              number: 1368,
            },
          });
        }
        await page.getByRole("link", { name: "Inspect PR", exact: true }).click();
        await vi.waitFor(() => {
          if (kind === "standalone") {
            expect(mounted.router.state.location.pathname).toBe("/pull-requests");
            expect(mounted.router.state.location.search).toMatchObject({
              kind: "pullRequest",
              selectedProjectId: PROJECT_ID,
              selectedRepo: "acme/widgets",
              number: 41,
            });
          } else if (linkedRepository === "acme/widgets") {
            expect(pullRequestNumbers(THREAD_ID)).toEqual([41]);
          } else {
            expect(openedExternally).toEqual([url]);
          }
        });
        // Nothing lands in the side chat's own dock, which no surface renders.
        expect(pullRequestNumbers(sidechatId)).toEqual([]);
      } finally {
        if (previousNativeApi) {
          Object.defineProperty(window, "nativeApi", {
            configurable: true,
            value: previousNativeApi,
          });
        } else {
          Reflect.deleteProperty(window, "nativeApi");
        }
        await mounted.cleanup();
      }
    },
  );

  it("offers unseen startup highlights once on a configured installation and keeps chat usable after dismissal", async () => {
    localStorage.removeItem(FEATURE_TOUR_STORAGE_KEY);
    const snapshot = createSnapshotWithLongAssistantResponse();
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    try {
      await expect
        .element(page.getByRole("dialog", { name: "A new home for your work" }))
        .toBeVisible();
      expect(document.querySelectorAll('[role="dialog"]').length).toBe(1);
      await page.getByRole("button", { name: "Skip tour" }).click();
      expect(JSON.parse(localStorage.getItem(FEATURE_TOUR_STORAGE_KEY) ?? "[]")).toEqual([
        createBaseServerConfig().worktreesDir,
      ]);
    } finally {
      await mounted.cleanup();
    }
    const remounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(document.querySelector("[data-feature-tour]")).toBeNull();
      await page.getByTestId("composer-editor").click();
      await remounted.router.navigate({ to: "/settings", search: { section: "advanced" } });
      await page.getByRole("button", { name: "Replay feature tour" }).click();
      await expect
        .element(page.getByRole("dialog", { name: "A new home for your work" }))
        .toBeVisible();
      await page.getByRole("button", { name: "Skip tour" }).click();
    } finally {
      await remounted.cleanup();
    }
  });

  // #1374: real route, dock and Lexical composers; only the server boundary is
  // simulated. The main agent must keep running while the panel toggles.
  it("previews split widths without persisting and restores the released ratio after remount", async () => {
    const snapshot = addThreadToSnapshot(
      createSnapshotWithLongAssistantResponse(),
      OTHER_THREAD_ID,
    );
    let mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    try {
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "Resize draft");
      const splitViewId = useSplitViewStore.getState().createFromDrop({
        sourceThreadId: THREAD_ID,
        ownerProjectId: PROJECT_ID,
        droppedThreadId: OTHER_THREAD_ID,
        direction: "horizontal",
        side: "second",
      });
      const openSplit = () =>
        mounted.router.navigate({
          to: "/$threadId",
          params: { threadId: THREAD_ID },
          search: () => ({ splitViewId }),
        });
      await openSplit();
      await vi.waitFor(() =>
        expect(document.querySelectorAll('[contenteditable="true"]')).toHaveLength(2),
      );
      await waitForLayout();
      const editors = [...document.querySelectorAll<HTMLElement>('[contenteditable="true"]')];
      const divider = document.querySelector<HTMLElement>('[data-split-divider="true"]')!;
      const frame = divider.parentElement!.getBoundingClientRect();
      const sourceScope = splitViewPaneScopeId(
        splitViewId,
        resolveSplitViewPaneIdForThread(
          useSplitViewStore.getState().splitViewsById[splitViewId]!,
          THREAD_ID,
        )!,
      );
      const sourceChat = document.querySelector(`[data-chat-pane-scope="${sourceScope}"]`)!;
      const sourceBox = sourceChat.closest('[data-slot="sidebar-inset"]')!.parentElement!;
      const persistedRatio = () =>
        JSON.parse(localStorage.getItem("synara:split-view-state:v1")!).state.splitViewsById[
          splitViewId
        ].root.ratio;
      const dispatch = (target: EventTarget, type: string, ratio: number, buttons: number) =>
        target.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerId: 1,
            pointerType: "mouse",
            button: 0,
            buttons,
            clientX: frame.left + frame.width * ratio,
            clientY: frame.top + frame.height / 2,
          }),
        );
      const widthBefore = sourceBox.getBoundingClientRect().width;
      dispatch(divider, "pointerdown", 0.5, 1);
      const overlay = document.querySelector("[data-panel-resize-overlay]") ?? window;
      dispatch(overlay, "pointermove", 0.65, 1);
      await vi.waitFor(() =>
        expect(sourceBox.getBoundingClientRect().width).toBeCloseTo(frame.width * 0.65, 0),
      );
      expect(sourceBox.getBoundingClientRect().width).toBeGreaterThan(widthBefore);
      expect(persistedRatio()).toBe(0.5);
      expect([...document.querySelectorAll('[contenteditable="true"]')]).toEqual(editors);
      expect(sourceChat.textContent).toContain("Resize draft");
      dispatch(overlay, "pointerup", 0.65, 0);
      await vi.waitFor(() => expect(persistedRatio()).toBeCloseTo(0.65));
      expect([...document.querySelectorAll('[contenteditable="true"]')]).toEqual(editors);
      const saved = localStorage.getItem("synara:split-view-state:v1")!;
      await mounted.cleanup();
      useSplitViewStore.setState({ splitViewsById: {}, splitViewIdBySourceThreadId: {} });
      localStorage.setItem("synara:split-view-state:v1", saved);
      await useSplitViewStore.persist.rehydrate();
      mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
      await openSplit();
      await vi.waitFor(() =>
        expect(document.querySelectorAll('[contenteditable="true"]')).toHaveLength(2),
      );
      const restoredDivider = document.querySelector<HTMLElement>('[data-split-divider="true"]')!;
      const restoredFrame = restoredDivider.parentElement!.getBoundingClientRect();
      expect(restoredDivider.getBoundingClientRect().left - restoredFrame.left).toBeCloseTo(
        restoredFrame.width * 0.65,
        0,
      );
      expect(persistedRatio()).toBeCloseTo(0.65);
    } finally {
      window.dispatchEvent(new Event("blur"));
      await mounted.cleanup();
    }
  });

  it.each(["surviving", "closing"] as const)(
    "closes a source pane into a survivor that anchors its own split (%s pane focused)",
    async (focused) => {
      const snapshot = withHomeChatProject(
        addThreadToSnapshot(createSnapshotWithLongAssistantResponse(), OTHER_THREAD_ID),
      );
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot,
        configureFixture: (nextFixture) => {
          nextFixture.welcome = {
            ...nextFixture.welcome,
            homeDir: "/Users/tester",
            chatWorkspaceRoot: "/Users/tester/Documents/Synara",
          };
        },
      });
      try {
        // The survivor already anchors its own split, so it cannot take over this one.
        const survivorSplitId = useSplitViewStore.getState().createFromThread({
          sourceThreadId: THREAD_ID,
          ownerProjectId: PROJECT_ID,
        });
        const splitViewId = useSplitViewStore.getState().createFromDrop({
          sourceThreadId: OTHER_THREAD_ID,
          ownerProjectId: PROJECT_ID,
          droppedThreadId: THREAD_ID,
          direction: "horizontal",
          side: "second",
        });
        await mounted.router.navigate({
          to: "/$threadId",
          params: { threadId: THREAD_ID },
          search: () => ({ splitViewId }),
        });
        await vi.waitFor(() =>
          expect(document.querySelectorAll('[contenteditable="true"]')).toHaveLength(2),
        );
        await waitForLayout();
        const split = useSplitViewStore.getState().splitViewsById[splitViewId]!;
        const editorForThread = (threadId: ThreadId) => {
          const scope = splitViewPaneScopeId(
            splitViewId,
            resolveSplitViewPaneIdForThread(split, threadId)!,
          );
          return document.querySelector<HTMLElement>(
            `[data-chat-pane-scope="${scope}"] [contenteditable="true"]`,
          )!;
        };
        const survivingEditor = editorForThread(THREAD_ID);
        const closingEditor = editorForThread(OTHER_THREAD_ID);
        // The dropped pane (the survivor) starts focused, so only the closing variant needs to
        // move focus. Pane focus follows mousedown, so that variant clicks the closing editor.
        if (focused === "closing") {
          await userEvent.click(closingEditor);
        }
        await vi.waitFor(() => {
          const focusedThreadId = focused === "surviving" ? THREAD_ID : OTHER_THREAD_ID;
          const current = useSplitViewStore.getState().splitViewsById[splitViewId]!;
          expect(current.focusedPaneId).toBe(
            resolveSplitViewPaneIdForThread(current, focusedThreadId),
          );
          expect(mounted.router.state.location.pathname).toBe(`/${focusedThreadId}`);
        });
        await userEvent.click(
          closingEditor
            .closest('[data-slot="sidebar-inset"]')!
            .querySelector<HTMLButtonElement>('button[aria-label="Close chat"]')!,
        );
        await vi.waitFor(() => {
          expect(mounted.router.state.location.pathname).toBe(`/${THREAD_ID}`);
          expect(mounted.router.state.location.search.splitViewId).toBeUndefined();
          expect(document.querySelectorAll('[contenteditable="true"]')).toHaveLength(1);
          expect(useSplitViewStore.getState().splitViewsById[splitViewId]).toBeUndefined();
        });
        await waitForLayout();
        expect(mounted.router.state.location.pathname).toBe(`/${THREAD_ID}`);
        expect(document.querySelector('[contenteditable="true"]')).toBe(survivingEditor);
        expect(useSplitViewStore.getState().splitViewIdBySourceThreadId[THREAD_ID]).toBe(
          survivorSplitId,
        );
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("keeps the surviving non-route chat mounted when a split collapses", async () => {
    const snapshot = addThreadToSnapshot(
      createSnapshotWithLongAssistantResponse(),
      OTHER_THREAD_ID,
    );
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    try {
      mounted.router.options.context.queryClient.setQueryData(
        gitQueryKeys.workingTreeDiffStats("/repo/project"),
        { additions: 604, deletions: 27, fileCount: 18 },
      );
      useComposerDraftStore.getState().setPrompt(OTHER_THREAD_ID, "surviving draft");
      const splitViewId = useSplitViewStore.getState().createFromDrop({
        sourceThreadId: THREAD_ID,
        ownerProjectId: PROJECT_ID,
        droppedThreadId: OTHER_THREAD_ID,
        direction: "horizontal",
        side: "second",
      });
      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: THREAD_ID },
        search: () => ({ splitViewId }),
      });
      await vi.waitFor(() =>
        expect(document.querySelectorAll('[contenteditable="true"]').length).toBe(2),
      );
      await waitForLayout();
      const split = useSplitViewStore.getState().splitViewsById[splitViewId]!;
      if (
        split.root.kind !== "split" ||
        split.root.first.kind !== "leaf" ||
        split.root.second.kind !== "leaf"
      )
        throw new Error("Expected two panes");
      const scope = splitViewPaneScopeId(splitViewId, split.root.second.id);
      const survivingEditor = document.querySelector<HTMLElement>(
        `[data-chat-pane-scope="${scope}"] [contenteditable="true"]`,
      )!;
      const survivingChat = survivingEditor.closest("[data-chat-pane-scope]")!;
      await vi.waitFor(() => expect(survivingEditor.textContent).toContain("surviving draft"));
      const closingScope = splitViewPaneScopeId(splitViewId, split.root.first.id);
      const closingChat = document.querySelector(`[data-chat-pane-scope="${closingScope}"]`)!;
      const closingPane = closingChat.closest('[data-slot="sidebar-inset"]')!;
      const survivingPane = survivingChat.closest('[data-slot="sidebar-inset"]')!;
      await userEvent.click(survivingEditor);
      await vi.waitFor(() =>
        expect(mounted.router.state.location.pathname).toBe(`/${OTHER_THREAD_ID}`),
      );
      for (const chat of [closingPane, survivingPane]) {
        const header = chat.querySelector("header")!;
        expect(header.querySelectorAll('button[aria-label="Close chat"]')).toHaveLength(1);
        expect(header.querySelector('button[aria-label="Expand this chat"]')).toBeNull();
        expect(header.querySelector('button[aria-label="Change thread"]')).toBeNull();
        expect(header.querySelector('[data-slot="diff-stat"]')).toBeNull();
        const close = header.querySelector<HTMLButtonElement>('button[aria-label="Close chat"]')!;
        const diff = header.querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle diff panel"]',
        )!;
        expect(getComputedStyle(close).color).toBe(getComputedStyle(diff).color);
      }
      await page.screenshot({ path: "../../../../output/playwright/split-chat-headers.png" });
      await userEvent.click(
        closingPane.querySelector<HTMLButtonElement>('button[aria-label="Close chat"]')!,
      );
      await vi.waitFor(() => {
        expect(mounted.router.state.location.pathname).toBe(`/${OTHER_THREAD_ID}`);
        expect(mounted.router.state.location.search.splitViewId).toBeUndefined();
        expect(document.querySelectorAll('[contenteditable="true"]').length).toBe(1);
      });
      expect(document.querySelector('[contenteditable="true"]')).toBe(survivingEditor);
      expect(document.querySelector("[data-chat-pane-scope]")).toBe(survivingChat);
      expect(survivingEditor.textContent).toContain("surviving draft");
    } finally {
      await mounted.cleanup();
    }
  });

  it.each(["source", "non-source"] as const)(
    "closes only the inactive ordinary %s pane and preserves the focused chat",
    async (closing) => {
      const thirdId = ThreadId.makeUnsafe("third-ordinary-grid-chat");
      const snapshot = addThreadToSnapshot(
        addThreadToSnapshot(createSnapshotWithLongAssistantResponse(), OTHER_THREAD_ID),
        thirdId,
      );
      const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
      try {
        const splitViewId = useSplitViewStore.getState().createFromDrop({
          sourceThreadId: THREAD_ID,
          ownerProjectId: PROJECT_ID,
          droppedThreadId: OTHER_THREAD_ID,
          direction: "horizontal",
          side: "second",
        });
        const split = useSplitViewStore.getState().splitViewsById[splitViewId]!;
        useSplitViewStore.getState().dropThreadOnPane({
          splitViewId,
          targetPaneId: resolveSplitViewPaneIdForThread(split, OTHER_THREAD_ID)!,
          threadId: thirdId,
          direction: "vertical",
          side: "second",
        });
        await mounted.router.navigate({
          to: "/$threadId",
          params: { threadId: THREAD_ID },
          search: () => ({ splitViewId }),
        });
        await vi.waitFor(() =>
          expect(document.querySelectorAll('[contenteditable="true"]')).toHaveLength(3),
        );
        await waitForLayout();
        const readySplit = useSplitViewStore.getState().splitViewsById[splitViewId]!;
        const editorForThread = (threadId: ThreadId) => {
          const scope = splitViewPaneScopeId(
            splitViewId,
            resolveSplitViewPaneIdForThread(readySplit, threadId)!,
          );
          return document.querySelector<HTMLElement>(
            `[data-chat-pane-scope="${scope}"] [contenteditable="true"]`,
          )!;
        };
        const retainedEditor = editorForThread(thirdId);
        await userEvent.click(retainedEditor);
        await vi.waitFor(() => expect(mounted.router.state.location.pathname).toBe(`/${thirdId}`));
        const closingThreadId = closing === "source" ? THREAD_ID : OTHER_THREAD_ID;
        const closingPane = editorForThread(closingThreadId).closest(
          '[data-slot="sidebar-inset"]',
        )!;
        await userEvent.click(
          closingPane.querySelector<HTMLButtonElement>('button[aria-label="Close chat"]')!,
        );
        await vi.waitFor(() => {
          expect(mounted.router.state.location.pathname).toBe(`/${thirdId}`);
          expect(mounted.router.state.location.search.splitViewId).toBe(splitViewId);
          expect(document.querySelectorAll('[contenteditable="true"]')).toHaveLength(2);
          const remaining = useSplitViewStore.getState().splitViewsById[splitViewId]!;
          expect(resolveSplitViewPaneIdForThread(remaining, closingThreadId)).toBeNull();
          expect(remaining.focusedPaneId).toBe(resolveSplitViewPaneIdForThread(remaining, thirdId));
        });
        expect(retainedEditor.isConnected).toBe(true);
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it.each([
    { kind: "standalone", panes: 2, closing: "non-source" },
    { kind: "standalone", panes: 3, closing: "non-source" },
    { kind: "standalone", panes: 3, closing: "source" },
    { kind: "forked", panes: 2, closing: "non-source" },
    { kind: "forked", panes: 3, closing: "non-source" },
  ] as const)(
    "closes a $kind Side in $panes panes ($closing)",
    async ({ kind, panes, closing }) => {
      const thirdId = ThreadId.makeUnsafe("third-standalone-grid-chat");
      const closingThreadId = closing === "source" ? THREAD_ID : OTHER_THREAD_ID;
      const base = addThreadToSnapshot(
        addThreadToSnapshot(createSnapshotWithLongAssistantResponse(), OTHER_THREAD_ID),
        thirdId,
      );
      const snapshot = {
        ...base,
        threads: base.threads.map((thread) =>
          thread.id === closingThreadId
            ? {
                ...thread,
                ...(kind === "forked"
                  ? { sidechatSourceThreadId: THREAD_ID }
                  : {
                      sidechatContext: {
                        kind: "github-item" as const,
                        itemKind: "pullRequest" as const,
                        repository: "acme/widgets",
                        number: 1472,
                        url: "https://github.com/acme/widgets/pull/1472",
                      },
                    }),
              }
            : thread,
        ),
      };
      const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
      try {
        const splitViewId = useSplitViewStore.getState().createFromDrop({
          sourceThreadId: THREAD_ID,
          ownerProjectId: PROJECT_ID,
          droppedThreadId: OTHER_THREAD_ID,
          direction: "horizontal",
          side: "second",
        });
        const split = useSplitViewStore.getState().splitViewsById[splitViewId]!;
        const sourcePaneId = resolveSplitViewPaneIdForThread(split, THREAD_ID)!;
        if (panes === 3)
          useSplitViewStore.getState().dropThreadOnPane({
            splitViewId,
            targetPaneId: sourcePaneId,
            threadId: thirdId,
            direction: "vertical",
            side: "first",
          });
        await mounted.router.navigate({
          to: "/$threadId",
          params: { threadId: THREAD_ID },
          search: () => ({ splitViewId }),
        });
        await vi.waitFor(() =>
          expect(document.querySelectorAll('[contenteditable="true"]')).toHaveLength(panes),
        );
        await waitForLayout();
        const readySplit = useSplitViewStore.getState().splitViewsById[splitViewId]!;
        const targetThreadId = closing === "source" ? thirdId : THREAD_ID;
        const editorForThread = (threadId: ThreadId) => {
          const scope = splitViewPaneScopeId(
            splitViewId,
            resolveSplitViewPaneIdForThread(readySplit, threadId)!,
          );
          return document.querySelector<HTMLElement>(
            `[data-chat-pane-scope="${scope}"] [contenteditable="true"]`,
          )!;
        };
        const retainedEditor = editorForThread(targetThreadId);
        await userEvent.click(editorForThread(closingThreadId));
        await vi.waitFor(() =>
          expect(mounted.router.state.location.pathname).toBe(`/${closingThreadId}`),
        );
        const persistedSplit = () =>
          JSON.parse(localStorage.getItem("synara:split-view-state:v1")!).state.splitViewsById[
            splitViewId
          ];
        expect(persistedSplit()).toBeDefined();
        const closingChat = editorForThread(closingThreadId).closest(
          '[data-slot="sidebar-inset"]',
        )!;
        await userEvent.click(
          closingChat.querySelector<HTMLButtonElement>('button[aria-label="Close chat"]')!,
        );
        await vi.waitFor(() => {
          expect(mounted.router.state.location.pathname).toBe(`/${targetThreadId}`);
          expect(mounted.router.state.location.search.splitViewId).toBe(
            closing === "source" ? splitViewId : undefined,
          );
          expect(document.querySelectorAll('[contenteditable="true"]')).toHaveLength(
            closing === "source" ? 2 : 1,
          );
          if (closing === "source") {
            expect(useSplitViewStore.getState().splitViewsById[splitViewId]).toBeDefined();
            expect(persistedSplit()).toBeDefined();
            expect(persistedSplit().sourceThreadId).toBe(thirdId);
          } else {
            expect(useSplitViewStore.getState().splitViewsById[splitViewId]).toBeUndefined();
            expect(persistedSplit()).toBeUndefined();
          }
        });
        await waitForLayout();
        expect(retainedEditor.isConnected).toBe(true);
        expect(document.querySelectorAll('[contenteditable="true"]')).toContain(retainedEditor);
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("opens one sidechat, preserves its draft on toggle, and restores composer focus", async () => {
    useRightDockStore.setState({ dockStateByThreadId: {} });
    const mainSnapshot = createSnapshotForTargetUser({
      targetMessageId: MessageId.makeUnsafe("sidechat-shortcut-main"),
      targetText: "Main conversation continues",
      sessionStatus: "running",
    });
    const expiredId = ThreadId.makeUnsafe("expired-sidechat-shortcut");
    const withExpiredSidechat = addThreadToSnapshot(mainSnapshot, expiredId);
    const snapshot = {
      ...withExpiredSidechat,
      threads: withExpiredSidechat.threads.map((thread) =>
        thread.id === expiredId
          ? { ...thread, sidechatSourceThreadId: THREAD_ID, sidechatExpiredAt: NOW_ISO }
          : thread,
      ),
    };
    useRightDockStore.getState().openPane(THREAD_ID, { kind: "sidechat", threadId: expiredId });
    useRightDockStore.getState().setDockOpen(THREAD_ID, false);
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    const previousNativeApi = window.nativeApi;
    const api = readNativeApi()!;
    const commands: Record<string, unknown>[] = [];
    let releaseFork!: () => void;
    const forkBarrier = new Promise<void>((resolve) => {
      releaseFork = resolve;
    });
    Object.defineProperty(window, "nativeApi", {
      configurable: true,
      value: {
        ...api,
        orchestration: {
          ...api.orchestration,
          dispatchCommand: async (command: Record<string, unknown>) => {
            commands.push(command);
            if (command.type === "thread.fork.create") {
              await forkBarrier;
              const next = addThreadToSnapshot(fixture.snapshot, command.threadId as ThreadId);
              fixture.snapshot = {
                ...next,
                threads: next.threads.map((thread) =>
                  thread.id === command.threadId
                    ? { ...thread, sidechatSourceThreadId: THREAD_ID }
                    : thread,
                ),
              };
            }
            return { sequence: fixture.snapshot.snapshotSequence };
          },
          getShellSnapshot: async () => createShellSnapshotFromReadModel(fixture.snapshot),
        },
      },
    });
    try {
      let mainEditor = await waitForComposerEditor();
      const expectMainFocus = async () => {
        await vi.waitFor(() => {
          const current = document.querySelector<HTMLElement>(
            '[data-chat-pane-scope="single"] [contenteditable="true"]',
          );
          expect(current).not.toBeNull();
          expect(document.activeElement).toBe(current);
          mainEditor = current!;
        });
      };
      mainEditor.focus();
      await dispatchConfiguredShortcutWhenReady(mainEditor, { key: "s", altKey: true });
      dispatchConfiguredShortcut(mainEditor, { key: "s", altKey: true });
      await vi.waitFor(() =>
        expect(commands.filter((c) => c.type === "thread.fork.create")).toHaveLength(1),
      );
      expect(commands[0]).toMatchObject({
        sourceThreadId: THREAD_ID,
        sidechatSourceThreadId: THREAD_ID,
        projectId: PROJECT_ID,
        envMode: "local",
        branch: "main",
        worktreePath: null,
        runtimeMode: "full-access",
        modelSelection: { provider: "codex", model: "gpt-5" },
      });
      releaseFork();
      let sideEditor = await waitForElement(
        () =>
          document.querySelector<HTMLElement>(
            '[data-chat-pane-scope^="dock-sidechat:"] [contenteditable="true"]',
          ),
        "Sidechat composer missing",
      );
      await vi.waitFor(() => expect(document.activeElement).toBe(sideEditor));
      const sidechatPane = sideEditor.closest("[data-chat-pane-scope]")!;
      expect(sidechatPane.querySelector('[data-testid="empty-landing-heading"]')).toBeNull();
      expect(sidechatPane.querySelector("[data-empty-landing-controls]")).toBeNull();
      expect(sidechatPane.querySelector('[role="combobox"]')).toBeNull();
      expect(sidechatPane.textContent).not.toContain("Import your Claude Code");
      expect(sidechatPane.textContent).not.toContain("Let's build");
      expect(sidechatPane.textContent).not.toContain("Local");
      await userEvent.type(sideEditor, "Keep this tangent");
      const panes = useRightDockStore.getState().dockStateByThreadId[THREAD_ID]!.panes;
      const livePane = panes.find((pane) => pane.threadId === commands[0]!.threadId)!;
      expect(livePane.threadId).not.toBe(expiredId);
      const closeShortcut = dispatchConfiguredShortcut(sideEditor, { key: "s", altKey: true });
      expect(closeShortcut.defaultPrevented).toBe(true);
      expect(useRightDockStore.getState().dockStateByThreadId[THREAD_ID]!.open).toBe(false);
      await expectMainFocus();
      expect(useRightDockStore.getState().dockStateByThreadId[THREAD_ID]!.open).toBe(false);
      dispatchConfiguredShortcut(mainEditor, { key: "s", altKey: true });
      await vi.waitFor(() => {
        const current = document.querySelector<HTMLElement>(
          '[data-chat-pane-scope^="dock-sidechat:"] [contenteditable="true"]',
        );
        expect(current).not.toBeNull();
        expect(document.activeElement).toBe(current);
        sideEditor = current!;
      });
      expect(sideEditor.textContent).toContain("Keep this tangent");
      expect(useRightDockStore.getState().dockStateByThreadId[THREAD_ID]!.panes).toEqual(panes);
      expect(commands.filter((c) => c.type === "thread.fork.create")).toHaveLength(1);

      // A menu closing on Escape gets the first key, even if it removes its DOM.
      const dismissedMenu = showContextMenuFallback([{ id: "keep", label: "Keep side chat" }]);
      sideEditor.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      await expect(dismissedMenu).resolves.toBeNull();
      expect(useRightDockStore.getState().dockStateByThreadId[THREAD_ID]!.open).toBe(true);
      sideEditor = document.querySelector<HTMLElement>(
        '[data-chat-pane-scope^="dock-sidechat:"] [contenteditable="true"]',
      )!;
      const escape = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      sideEditor.dispatchEvent(escape);
      expect(escape.defaultPrevented).toBe(true);
      await expectMainFocus();
      expect(useRightDockStore.getState().dockStateByThreadId[THREAD_ID]!.open).toBe(false);
      // Removing the tab must not force another fork of the source conversation.
      useRightDockStore.getState().closePane(THREAD_ID, livePane.id);
      dispatchConfiguredShortcut(mainEditor, { key: "s", altKey: true });
      await vi.waitFor(() => {
        const reopened = useRightDockStore.getState().dockStateByThreadId[THREAD_ID]!;
        expect(reopened.open).toBe(true);
        expect(reopened.panes.find((pane) => pane.id === reopened.activePaneId)?.threadId).toBe(
          livePane.threadId,
        );
      });
      expect(commands.filter((c) => c.type === "thread.fork.create")).toHaveLength(1);
      expect(mounted.router.state.location.pathname).toBe(`/${THREAD_ID}`);
      expect(useStore.getState().threadSessionById?.[THREAD_ID]?.status).toBe("running");
      expect(
        commands.some((c) => c.type === "thread.turn.interrupt" || c.type === "thread.delete"),
      ).toBe(false);
    } finally {
      releaseFork();
      Object.defineProperty(window, "nativeApi", { configurable: true, value: previousNativeApi });
      await mounted.cleanup();
      useRightDockStore.setState({ dockStateByThreadId: {} });
    }
  });

  it("preserves the automatic project name when saving only its appearance", async () => {
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: MessageId.makeUnsafe("project-appearance-name"),
      targetText: "Project appearance",
    });
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    try {
      await waitForLayout();
      const projectRow = document.querySelector<HTMLButtonElement>(
        `[data-project-hover-anchor="${PROJECT_ID}"] button`,
      );
      expect(projectRow).not.toBeNull();
      projectRow!.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 160 }),
      );
      await page.getByRole("menuitem", { name: "Edit project", exact: true }).click();
      await page.getByRole("button", { name: "Choose icon" }).click();
      await page.getByRole("radio", { name: "Blue", exact: true }).click();
      await page.getByRole("radio", { name: "Launch", exact: true }).click();
      await page.getByRole("button", { name: "Save", exact: true }).click();

      const project = () => useStore.getState().projects.find((item) => item.id === PROJECT_ID);
      await expect
        .poll(() => project()?.appearance)
        .toEqual({
          kind: "icon",
          icon: "rocket",
          color: "blue",
        });
      expect(project()?.localName).toBeNull();
      const persisted = JSON.parse(localStorage.getItem("synara:renderer-state:v8") ?? "{}");
      expect(persisted.projectNamesByCwd["/repo/project"]).toBeUndefined();

      useStore.getState().syncServerReadModel({
        ...snapshot,
        snapshotSequence: snapshot.snapshotSequence + 1,
        projects: snapshot.projects.map((item) =>
          item.id === PROJECT_ID ? { ...item, title: "Renamed upstream" } : item,
        ),
      });
      expect(project()?.name).toBe("Renamed upstream");
      expect(project()?.appearance).toEqual({ kind: "icon", icon: "rocket", color: "blue" });
    } finally {
      await mounted.cleanup();
    }
  });

  it("preserves the hidden board slot when Tasks replaces Kanban in the rail", async () => {
    localStorage.setItem("synara:app-settings:v1", JSON.stringify({ hiddenRailItems: ["kanban"] }));
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("hidden-tasks-slot"),
        targetText: "Hidden Tasks slot",
      }),
    });
    try {
      await waitForLayout();
      await expect
        .element(page.getByRole("button", { name: "Tasks", exact: true }))
        .not.toBeInTheDocument();
      await page
        .getByRole("navigation", { name: "Primary" })
        .getByRole("button", { name: "More", exact: true })
        .click();
      await page.getByRole("menuitem", { name: "Customize…", exact: true }).click();
      await page.getByRole("checkbox", { name: "Show Tasks in the sidebar", exact: true }).click();
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await expect.element(page.getByRole("button", { name: "Tasks", exact: true })).toBeVisible();
      expect(
        JSON.parse(localStorage.getItem("synara:app-settings:v1") ?? "{}").hiddenRailItems,
      ).toEqual([]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("carries the rail inside the sidebar sheet at phone width", async () => {
    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 540 },
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("mobile-rail"),
        targetText: "Mobile rail",
      }),
    });
    try {
      await waitForLayout();
      // The shell keeps no left column on phones, so the rail is absent until the sheet opens.
      await expect
        .element(page.getByRole("navigation", { name: "Primary" }))
        .not.toBeInTheDocument();
      await page.getByRole("button", { name: "Toggle thread sidebar", exact: true }).click();
      const rail = page.getByRole("navigation", { name: "Primary" });
      await expect.element(rail.getByRole("button", { name: "Home", exact: true })).toBeVisible();
      await expect
        .element(rail.getByRole("button", { name: "Settings", exact: true }))
        .toBeVisible();
      // Customize has no shell slot to anchor to on phones; it opens beside the sheet's rail.
      await rail.getByRole("button", { name: "More", exact: true }).click();
      await page.getByRole("menuitem", { name: "Customize…", exact: true }).click();
      await expect.element(page.getByRole("button", { name: "Done", exact: true })).toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });

  it("preserves absent project pins when toggling a rail Space shortcut", async () => {
    localStorage.setItem(
      "synara:app-settings:v1",
      JSON.stringify({ railShortcuts: ["project:temporarily-absent"] }),
    );
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("rail-pins"),
        targetText: "Rail pins",
      }),
    });
    try {
      await mounted.router.navigate({ to: "/settings" });
      await waitForLayout();
      await page
        .getByRole("navigation", { name: "Primary" })
        .getByRole("button", { name: "More", exact: true })
        .click();
      await page.getByRole("menuitemcheckbox", { name: "Void", exact: true }).click();
      await expect
        .poll(
          () => JSON.parse(localStorage.getItem("synara:app-settings:v1") ?? "{}").railShortcuts,
        )
        .toEqual(["project:temporarily-absent", "space:void"]);
    } finally {
      await mounted.cleanup();
    }
  });

  it.each([
    { destination: "Home", keepsActivity: true },
    { destination: "Spaces", keepsActivity: false },
    { destination: "Project", keepsActivity: false },
    { destination: "Void", keepsActivity: false },
  ])(
    "keeps Activity=$keepsActivity when selecting rail $destination",
    async ({ destination, keepsActivity }) => {
      localStorage.setItem(
        "synara:app-settings:v1",
        JSON.stringify({ railShortcuts: ["project:project-1", "space:void"] }),
      );
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: MessageId.makeUnsafe("rail-activity"),
          targetText: "Rail activity",
        }),
      });
      try {
        await page.getByRole("button", { name: "Switch to activity view", exact: true }).click();
        await expect.element(page.getByRole("button", { name: "Activity options" })).toBeVisible();
        await page
          .getByRole("navigation", { name: "Primary" })
          .getByRole("button", { name: destination, exact: true })
          .click();
        if (keepsActivity) {
          await expect
            .element(page.getByRole("button", { name: "Switch to classic view", exact: true }))
            .toBeVisible();
          await expect
            .element(page.getByRole("button", { name: "Activity options" }))
            .toBeVisible();
        } else {
          await expect
            .element(page.getByRole("button", { name: "Switch to activity view", exact: true }))
            .toBeVisible();
          await expect
            .element(page.getByRole("button", { name: "Activity options" }))
            .not.toBeInTheDocument();
        }
      } finally {
        await mounted.cleanup();
        useRailShellStore.getState().closeSpacesProject();
        useRailShellStore.getState().selectPanelItem("home");
      }
    },
  );

  it("creates a project in the rail Space whose Add project button was clicked", async () => {
    const currentSpaceId = SpaceId.makeUnsafe("rail-current");
    const destinationSpaceId = SpaceId.makeUnsafe("rail-destination");
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: MessageId.makeUnsafe("rail-create"),
      targetText: "Rail create",
    });
    useSpacesUiStore.getState().setActiveSpaceId(currentSpaceId);
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        spaces: [currentSpaceId, destinationSpaceId].map((id, index) => ({
          id,
          name: index === 0 ? "Current" : "Destination",
          icon: "bag",
          sortOrder: index,
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
          deletedAt: null,
        })),
        projects: snapshot.projects.map((project) => ({ ...project, spaceId: currentSpaceId })),
      },
    });
    try {
      await page
        .getByRole("navigation", { name: "Primary" })
        .getByRole("button", { name: "Spaces", exact: true })
        .click();
      const header = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>(".group\\/project-header")).find(
            (element) => element.textContent?.includes("Destination"),
          ) ?? null,
        "Destination Space header missing",
      );
      header.querySelector<HTMLButtonElement>('button[aria-label="Add project"]')!.click();
      await page.getByLabelText("Project folder path").fill("/repo/rail-created");
      await page.getByRole("button", { name: "Create project", exact: true }).click();
      await vi.waitFor(() => {
        const request = wsRequests.find(
          (request) =>
            request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            "command" in request &&
            (request.command as { workspaceRoot?: string })?.workspaceRoot === "/repo/rail-created",
        );
        expect((request?.command as { spaceId?: string })?.spaceId).toBe(destinationSpaceId);
      });
    } finally {
      await mounted.cleanup();
      useSpacesUiStore.getState().setActiveSpaceId(null);
      useRailShellStore.getState().closeSpacesProject();
      useRailShellStore.getState().selectPanelItem("home");
    }
  });

  it("refreshes the full conversation when an approval was already answered", async () => {
    const requestId = ApprovalRequestId.makeUnsafe("approval-refresh-race");
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: MessageId.makeUnsafe("msg-approval-refresh"),
      targetText: "Run the requested command",
    });
    const thread = snapshot.threads[0]!;
    const pendingThread = {
      ...thread,
      activities: [
        {
          id: EventId.makeUnsafe("approval-refresh-request"),
          createdAt: NOW_ISO,
          kind: "approval.requested",
          summary: "Command approval requested",
          tone: "approval" as const,
          turnId: null,
          sequence: 1,
          payload: { requestId, requestKind: "command", detail: "Command: git status" },
        },
      ],
      pendingInteractions: [
        {
          interactionKind: "approval" as const,
          requestId,
          threadId: thread.id,
          turnId: null,
          lifecycleGeneration: null,
          status: "pending" as const,
          decision: null,
          responseCommandId: null,
          responseRequestedAt: null,
          createdAt: NOW_ISO,
          resolvedAt: null,
        },
      ],
    };
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: { ...snapshot, threads: [pendingThread] },
    });
    const previousNativeApi = window.nativeApi;
    const api = readNativeApi()!;
    const subscribeThread = vi.fn(api.orchestration.subscribeThread);
    const dispatchCommand = vi.fn(async () => {
      // Only the server fixture learns the winner. The client must fetch and
      // apply this snapshot through its real subscription/EventRouter path.
      fixture.snapshot = {
        ...fixture.snapshot,
        snapshotSequence: fixture.snapshot.snapshotSequence + 1,
        threads: [
          {
            ...pendingThread,
            pendingInteractions: pendingThread.pendingInteractions.map((interaction) => ({
              ...interaction,
              status: "confirmed" as const,
              decision: "accept" as const,
              resolvedAt: NOW_ISO,
            })),
          },
        ],
      };
      throw new Error(`Approval request ${requestId} was already answered.`);
    });
    Object.defineProperty(window, "nativeApi", {
      configurable: true,
      value: { ...api, orchestration: { ...api.orchestration, dispatchCommand, subscribeThread } },
    });
    try {
      setThreadDetailResumeCursor(THREAD_ID, snapshot.snapshotSequence);
      await page.getByRole("button", { name: /Approve once/u }).click();
      await vi.waitFor(() => expect(subscribeThread).toHaveBeenCalledWith({ threadId: THREAD_ID }));
      await expect
        .element(page.getByRole("button", { name: /Approve once/u }))
        .not.toBeInTheDocument();
      expect(dispatchCommand).toHaveBeenCalledTimes(1);
      await expect.element(page.getByText(/was already answered/u)).not.toBeInTheDocument();
    } finally {
      if (previousNativeApi) {
        Object.defineProperty(window, "nativeApi", {
          configurable: true,
          value: previousNativeApi,
        });
      } else {
        Reflect.deleteProperty(window, "nativeApi");
      }
      await mounted.cleanup();
    }
  });

  it.each(["manual", "auto-advance", "custom"] as const)(
    "preserves three answers (%s) on transient failure and restores expired questions without sending a message",
    async (navigation) => {
      const requestId = ApprovalRequestId.makeUnsafe("question-recovery");
      const generation = "question-generation";
      const requestKey = pendingRequestInstanceKey(requestId, generation);
      const questions = [1, 2, 3].map((id) => ({
        id: String(id),
        header: `Question ${id}`,
        question: `Choose option ${id}?`,
        ...(navigation !== "auto-advance" ? { multiSelect: true } : {}),
        options: [{ label: `Choice ${id}`, description: "Selected answer" }],
      }));
      const snapshot = createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("msg-question-recovery"),
        targetText: "Discuss the design",
      });
      const thread = snapshot.threads[0]!;
      const request = { requestId, lifecycleGeneration: generation, createdAt: NOW_ISO, questions };
      const pendingThread = {
        ...thread,
        activities: [
          {
            id: EventId.makeUnsafe("question-request"),
            createdAt: NOW_ISO,
            kind: "user-input.requested",
            summary: "Questions",
            tone: "info" as const,
            turnId: null,
            sequence: 900,
            payload: { requestId, lifecycleGeneration: generation, questions },
          },
        ],
        pendingInteractions: [
          {
            interactionKind: "userInput" as const,
            requestId,
            threadId: thread.id,
            turnId: null,
            lifecycleGeneration: generation,
            status: "pending" as const,
            decision: null,
            responseCommandId: null,
            responseRequestedAt: null,
            createdAt: NOW_ISO,
            resolvedAt: null,
          },
        ],
      };
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "Keep this existing draft.");
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: { ...snapshot, threads: [pendingThread] },
      });
      const previousNativeApi = window.nativeApi;
      const api = readNativeApi()!;
      let expire = false;
      const dispatchCommand = vi.fn(async () => {
        if (!expire) throw new Error("Temporary connection failure");
        fixture.snapshot = {
          ...fixture.snapshot,
          snapshotSequence: fixture.snapshot.snapshotSequence + 1,
          threads: [
            {
              ...pendingThread,
              pendingInteractions: pendingThread.pendingInteractions.map((row) => ({
                ...row,
                status: "confirmed" as const,
                resolvedAt: NOW_ISO,
              })),
              activities: [
                ...pendingThread.activities,
                {
                  id: EventId.makeUnsafe("question-expired"),
                  createdAt: NOW_ISO,
                  kind: "provider.user-input.respond.failed",
                  summary: "Expired",
                  tone: "error" as const,
                  turnId: null,
                  sequence: 2,
                  payload: {
                    requestId,
                    lifecycleGeneration: generation,
                    detail: buildStalePendingRequestFailureDetail("user-input", requestId),
                  },
                },
              ],
            },
          ],
        };
      });
      Object.defineProperty(window, "nativeApi", {
        configurable: true,
        value: { ...api, orchestration: { ...api.orchestration, dispatchCommand } },
      });
      try {
        for (const id of [1, 2, 3]) {
          await page.getByRole("button", { name: new RegExp(`Choice ${id}`) }).click();
          // Single-choice answers advance themselves; another Next click races the timer.
          if (id < 3 && navigation !== "auto-advance")
            await page.getByRole("button", { name: "Next question", exact: true }).first().click();
        }
        if (navigation === "custom") {
          await userEvent.click(await waitForComposerEditor());
          await userEvent.keyboard("Custom answer");
        }
        const submit = page.getByRole("button", { name: "Submit answers", exact: true });
        await expect.element(submit).toBeEnabled();
        const button = submit.element() as HTMLButtonElement;
        button.click();
        button.click();
        await vi.waitFor(() => expect(dispatchCommand).toHaveBeenCalledTimes(1));
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(dispatchCommand).toHaveBeenCalledTimes(1);
        await expect.element(submit).toBeEnabled();
        expect(
          useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.pendingUserInputDrafts?.[
            requestKey
          ],
        ).toEqual({
          request,
          answers: Object.fromEntries(
            [1, 2, 3].map((id) => [
              String(id),
              navigation === "custom" && id === 3
                ? { customAnswer: "Custom answer" }
                : { customAnswer: "", selectedOptionLabels: [`Choice ${id}`] },
            ]),
          ),
        });
        expire = true;
        await submit.click();
        await expect.element(page.getByRole("button", { name: "Restore answers" })).toBeVisible();
        await expect.element(submit).not.toBeInTheDocument();
        await page.getByRole("button", { name: "Restore answers" }).click();
        expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
          `Keep this existing draft.\n\nChoose option 1?\nChoice 1\n\nChoose option 2?\nChoice 2\n\nChoose option 3?\n${navigation === "custom" ? "Custom answer" : "Choice 3"}`,
        );
        expect(dispatchCommand).toHaveBeenCalledTimes(2);
      } finally {
        if (previousNativeApi)
          Object.defineProperty(window, "nativeApi", {
            configurable: true,
            value: previousNativeApi,
          });
        else Reflect.deleteProperty(window, "nativeApi");
        await mounted.cleanup();
      }
    },
  );

  it("keeps near-cap composer work bounded while live activities arrive", async () => {
    onTestFinished(skipReactDevOwnerStacks());
    const percentile = (samples: readonly number[], fraction: number): number => {
      const ordered = [...samples].sort((left, right) => left - right);
      return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))] ?? 0;
    };
    const cases = [
      { name: "short", messageCount: 10, activityCount: 20 },
      { name: "near-cap", messageCount: 81, activityCount: 1_609 },
    ] as const;
    const measure = async (benchmarkCase: (typeof cases)[number]) => {
      const commits: number[] = [];
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createIssue550Snapshot(benchmarkCase),
        onRender: (_id, phase, actualDuration) => {
          if (phase === "update") commits.push(actualDuration);
        },
      });
      try {
        const editor = await waitForComposerEditor();
        await userEvent.click(editor);
        commits.length = 0;

        const inputToPaintMs: number[] = [];
        for (let index = 0; index < 12; index += 1) {
          const startedAt = performance.now();
          useStore.getState().applyOrchestrationEventsHotPath([
            makeDomainEvent(
              "thread.activity-appended",
              {
                threadId: THREAD_ID,
                activity: {
                  id: EventId.makeUnsafe(`activity-issue-550-live-${index}`),
                  createdAt: isoAt(
                    benchmarkCase.messageCount * 2 + benchmarkCase.activityCount + index,
                  ),
                  kind: "tool.completed",
                  summary: `live tool ${index}`,
                  tone: "tool",
                  turnId: null,
                  payload: {
                    itemType: "dynamic_tool_call",
                    toolName: `live-tool-${index}`,
                  },
                },
              },
              { sequence: benchmarkCase.activityCount + index + 1 },
            ),
          ]);
          await userEvent.keyboard("x");
          await nextFrame();
          inputToPaintMs.push(performance.now() - startedAt);
        }

        expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
          "x".repeat(12),
        );
        expect(useStore.getState().activityIdsByThreadId?.[THREAD_ID]).toHaveLength(
          benchmarkCase.activityCount + 12,
        );
        return {
          name: benchmarkCase.name,
          inputP95Ms: percentile(inputToPaintMs, 0.95),
          reactCommitTotalMs: commits.reduce((total, duration) => total + duration, 0),
        };
      } finally {
        await mounted.cleanup();
        useComposerDraftStore.setState({ draftsByThreadId: {} });
      }
    };

    // Run the full measured path once per case first: a mount alone leaves the
    // live-activity path cold, and the first near-cap sample was the slowest.
    for (const benchmarkCase of cases) await measure(benchmarkCase);

    // Pair each short run with a near-cap run. One noisy profiler sample on a
    // shared CI worker must not decide whether the limit is met.
    const reports: Array<Awaited<ReturnType<typeof measure>> & { sample: number }> = [];
    const ratios: number[] = [];
    for (let sample = 0; sample < 3; sample += 1) {
      const short = { sample, ...(await measure(cases[0])) };
      const nearCap = { sample, ...(await measure(cases[1])) };
      reports.push(short, nearCap);
      ratios.push(nearCap.reactCommitTotalMs / short.reactCommitTotalMs);
    }

    const medianRatio = ratios.sort((left, right) => left - right)[1]!;
    // Preserve the existing Issue #550 regression limit after the performance changes.
    expect(
      medianRatio,
      `Issue #550 benchmark: ${JSON.stringify({ reports, ratios })}`,
    ).toBeLessThan(2.5);
  });

  it.each(["confirmed", "stale"])("cancels a multi-question (%s)", async (settlement) => {
    const requestId = ApprovalRequestId.makeUnsafe("question-cancel");
    const lifecycleGeneration = "cancel-generation";
    const questions = [1, 2].map((id) => ({
      id: String(id),
      header: `Question ${id}`,
      question: `Choose option ${id}?`,
      options: [{ label: `Choice ${id}`, description: "Selected answer" }],
    }));
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: MessageId.makeUnsafe("msg-question-cancel"),
      targetText: "Ask for a decision",
    });
    const thread = snapshot.threads[0]!;
    const pendingThread = {
      ...thread,
      activities: [
        {
          id: EventId.makeUnsafe("question-cancel-request"),
          createdAt: NOW_ISO,
          kind: "user-input.requested",
          summary: "Questions",
          tone: "info" as const,
          turnId: null,
          sequence: 900,
          payload: { requestId, lifecycleGeneration, questions },
        },
      ],
      pendingInteractions: [
        {
          interactionKind: "userInput" as const,
          requestId,
          threadId: thread.id,
          turnId: null,
          lifecycleGeneration,
          status: "pending" as const,
          decision: null,
          responseCommandId: null,
          responseRequestedAt: null,
          createdAt: NOW_ISO,
          resolvedAt: null,
        },
      ],
    };
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: { ...snapshot, threads: [pendingThread] },
    });
    const previousNativeApi = window.nativeApi;
    const api = readNativeApi()!;
    const subscribeThread = vi.fn(api.orchestration.subscribeThread);
    const dispatchCommand = vi.fn(
      async (command: Parameters<typeof api.orchestration.dispatchCommand>[0]) => {
        if (command.type !== "thread.user-input.respond") {
          throw new Error("Unexpected command in the cancellation fixture.");
        }
        // Both a provider-confirmed cancellation and an invalidated callback
        // settle durably. Acceptance alone is not settlement.
        fixture.snapshot = {
          ...fixture.snapshot,
          snapshotSequence: fixture.snapshot.snapshotSequence + 1,
          threads: [
            {
              ...pendingThread,
              ...(settlement === "stale"
                ? {
                    activities: [
                      ...pendingThread.activities,
                      {
                        id: EventId.makeUnsafe("question-cancel-expired"),
                        createdAt: NOW_ISO,
                        kind: "provider.user-input.respond.failed",
                        summary: "Questions expired",
                        tone: "error" as const,
                        turnId: null,
                        sequence: 2,
                        payload: {
                          requestId,
                          lifecycleGeneration,
                          responseCommandId: command.commandId,
                          settlementStatus: "uncertain",
                          detail: buildStalePendingRequestFailureDetail("user-input", requestId),
                        },
                      },
                    ],
                  }
                : {}),
              pendingInteractions: pendingThread.pendingInteractions.map((interaction) =>
                Object.assign({}, interaction, {
                  status: "confirmed" as const,
                  responseCommandId: command.commandId,
                  responseRequestedAt: command.createdAt,
                  resolvedAt: NOW_ISO,
                }),
              ),
            },
          ],
        };
        return { sequence: fixture.snapshot.snapshotSequence };
      },
    );
    Object.defineProperty(window, "nativeApi", {
      configurable: true,
      value: {
        ...api,
        orchestration: { ...api.orchestration, dispatchCommand, subscribeThread },
      },
    });
    try {
      setThreadDetailResumeCursor(THREAD_ID, snapshot.snapshotSequence);
      await expect.element(page.getByText("Choose option 1?")).toBeVisible();
      await page.getByRole("button", { name: /Choice 1/ }).click();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await vi.waitFor(() => expect(dispatchCommand).toHaveBeenCalledTimes(1));
      expect(dispatchCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "thread.user-input.respond",
          threadId: THREAD_ID,
          requestId,
          lifecycleGeneration,
          answers: {},
        }),
      );
      await vi.waitFor(() => expect(subscribeThread).toHaveBeenCalledWith({ threadId: THREAD_ID }));
      await new Promise((resolve) => setTimeout(resolve, 250));
      await expect.element(page.getByText("Choose option 1?")).not.toBeInTheDocument();
      await expect.element(page.getByText("Choose option 2?")).not.toBeInTheDocument();
      // A later snapshot can omit the failure and all terminal rows. The old
      // request activity must not bring the question card back.
      fixture.snapshot = {
        ...fixture.snapshot,
        snapshotSequence: fixture.snapshot.snapshotSequence + 1,
        threads: [{ ...pendingThread, pendingInteractions: [] }],
      };
      await api.orchestration.subscribeThread({ threadId: THREAD_ID });
      await expect.element(page.getByText("Choose option 1?")).not.toBeInTheDocument();
      expect(await waitForComposerEditor()).toBeDefined();
    } finally {
      if (previousNativeApi)
        Object.defineProperty(window, "nativeApi", {
          configurable: true,
          value: previousNativeApi,
        });
      else Reflect.deleteProperty(window, "nativeApi");
      await mounted.cleanup();
    }
  });

  describe("provider handoff destination", () => {
    const withClaudeReady = (nextFixture: TestFixture) => {
      const providers: ServerConfig["providers"] = [
        ...nextFixture.serverConfig.providers,
        {
          provider: "claudeAgent",
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          status: "ready",
          available: true,
          authStatus: "authenticated",
          checkedAt: NOW_ISO,
        },
      ];
      nextFixture.serverConfig = { ...nextFixture.serverConfig, providers };
      nextFixture.providerStatusesSnapshot = providers;
    };

    async function mountWithCapturedCommands(
      snapshot: OrchestrationReadModel = createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("msg-handoff-destination"),
        targetText: "Fix the flaky reconnect test",
      }),
      // Models the server's reaction to a dispatched command.
      respond?: (
        command: Parameters<
          NonNullable<typeof window.nativeApi>["orchestration"]["dispatchCommand"]
        >[0],
      ) => void,
      respondDelayMs = 50,
    ) {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot,
        configureFixture: withClaudeReady,
      });
      const previousNativeApi = window.nativeApi;
      const api = readNativeApi()!;
      const commands: Array<Parameters<typeof api.orchestration.dispatchCommand>[0]> = [];
      const dispatchCommand = vi.fn(
        async (command: Parameters<typeof api.orchestration.dispatchCommand>[0]) => {
          commands.push(command);
          if (respond) setTimeout(() => respond(command), respondDelayMs);
          return { sequence: fixture.snapshot.snapshotSequence };
        },
      );
      Object.defineProperty(window, "nativeApi", {
        configurable: true,
        value: { ...api, orchestration: { ...api.orchestration, dispatchCommand } },
      });
      await waitForServerConfigToApply();
      return {
        commands,
        setViewport: mounted.setViewport,
        cleanup: async () => {
          if (previousNativeApi)
            Object.defineProperty(window, "nativeApi", {
              configurable: true,
              value: previousNativeApi,
            });
          else Reflect.deleteProperty(window, "nativeApi");
          await mounted.cleanup();
        },
      };
    }

    async function openHandoffMenu() {
      const trigger = page.getByRole("button", { name: "Hand off thread" });
      await expect.element(trigger).toBeEnabled();
      // The first click can land while the chat is still hydrating and the menu
      // closes again; reopen until the destinations render.
      await vi.waitFor(
        async () => {
          if (!document.querySelector("[data-handoff-destination]")) {
            await trigger.click();
          }
          expect(document.querySelector("[data-handoff-destination]")).not.toBeNull();
        },
        { timeout: 10_000, interval: 500 },
      );
      await expect.element(page.getByText("Continue in this thread")).toBeVisible();
      await expect.element(page.getByText("Continue in a new thread")).toBeVisible();
    }

    it.each([
      {
        provider: "claudeAgent" as const,
        model: "claude-opus-4-6",
        sessionStatus: "ready" as const,
      },
      {
        provider: "codex" as const,
        model: "gpt-5.3-codex",
        sessionStatus: "ready" as const,
      },
      {
        provider: "claudeAgent" as const,
        model: "claude-opus-4-6",
        sessionStatus: "running" as const,
      },
      {
        provider: "codex" as const,
        model: "gpt-5.3-codex",
        sessionStatus: "running" as const,
      },
    ])(
      "shows a dismissible pre-send tip above the composer when leaving Claude for $provider ($sessionStatus)",
      async ({ provider, model, sessionStatus }) => {
        const snapshot = createSnapshotForTargetUser({
          targetMessageId: MessageId.makeUnsafe("msg-claude-model-switch"),
          targetText: "Continue the task",
          sessionStatus,
        });
        const thread = snapshot.threads[0]!;
        const claudeSnapshot: OrchestrationReadModel = {
          ...snapshot,
          threads: [
            {
              ...thread,
              modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
              session: { ...thread.session!, providerName: "claudeAgent" },
            },
          ],
        };
        const mounted = await mountWithCapturedCommands(
          claudeSnapshot,
          respondToHandoff("completed"),
        );
        try {
          await waitForServerConfigToApply();
          const note = page.getByTestId("composer-claude-model-switch-note");
          await expect.element(note).not.toBeInTheDocument();
          const surface = document.querySelector<HTMLElement>(".chat-composer-surface")!;
          const originalHeight = surface.getBoundingClientRect().height;
          useComposerDraftStore.getState().setModelSelection(THREAD_ID, { provider, model });
          await vi.waitFor(() => expect(note.query()).not.toBeNull(), { timeout: 3_000 });
          await expect.element(note).toBeVisible();
          expect(surface.contains(note.element())).toBe(false);
          // Stacked panels share the composer's top border by one pixel.
          expect(note.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(
            surface.getBoundingClientRect().top + 1,
          );
          expect(surface.getBoundingClientRect().height).toBeCloseTo(originalHeight, 0);
          await expect
            .element(note)
            .toHaveTextContent(provider === "claudeAgent" ? "Next reply" : "new provider");
          expect(document.querySelector('[role="alertdialog"]')).toBeNull();
          expect(document.querySelector('[data-slot="menu-popup"]')).toBeNull();
          useComposerDraftStore.getState().setPrompt(THREAD_ID, "Continue the task");
          if (sessionStatus === "ready") {
            await expect
              .element(page.getByRole("button", { name: "Send message", exact: true }))
              .toBeEnabled();
          } else {
            await expect
              .element(page.getByRole("button", { name: "Stop generation", exact: true }))
              .toBeVisible();
          }
          const screenshotName =
            provider === "claudeAgent"
              ? "claude-model-switch-note"
              : "claude-provider-handoff-note";
          await page.screenshot({
            path: `../../../../output/playwright/${screenshotName}.png`,
          });
          await mounted.setViewport({ name: "narrow", width: 480, height: 640 });
          await expect.element(note).toBeVisible();
          expect(surface.contains(note.element())).toBe(false);
          await page.screenshot({
            path: `../../../../output/playwright/${screenshotName}-narrow.png`,
          });
          await note.getByRole("button", { name: "Dismiss tip" }).click();
          await expect.element(note).not.toBeInTheDocument();

          useComposerDraftStore.getState().setModelSelection(THREAD_ID, {
            provider: "claudeAgent",
            model: "claude-sonnet-4-6",
            options: { effort: "high" },
          });
          await expect.element(note).not.toBeInTheDocument();
          useComposerDraftStore.getState().setModelSelection(THREAD_ID, { provider, model });
          await expect.element(note).toBeVisible();
          document
            .querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]')!
            .requestSubmit();
          const handoffBlocked = sessionStatus === "running" && provider !== "claudeAgent";
          if (handoffBlocked) {
            await vi.waitFor(() =>
              expect(document.body.textContent).toContain("Cannot switch to Codex yet"),
            );
            expect(mounted.commands).toHaveLength(0);
            expect(
              useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.queuedTurns,
            ).toHaveLength(0);
            await expect.element(note).toBeVisible();
          } else if (sessionStatus === "running") {
            await vi.waitFor(() => {
              expect(
                useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.queuedTurns[0],
              ).toMatchObject({ kind: "chat", modelSelection: { provider, model } });
              expect(document.querySelector('[data-testid="queued-follow-up-row"]')).not.toBeNull();
            });
            expect(fixture.snapshot.threads[0]?.modelSelection.provider).toBe("claudeAgent");
            expect(fixture.snapshot.threads[0]?.session?.status).toBe("running");
          } else {
            await vi.waitFor(() =>
              expect(mounted.commands.some((command) => command.type === "thread.turn.start")).toBe(
                true,
              ),
            );
          }
          if (!handoffBlocked) {
            await expect.element(note).not.toBeInTheDocument();
          }
        } finally {
          await mounted.cleanup();
        }
      },
    );

    it("continues in the same thread by rebinding its provider", async () => {
      const mounted = await mountWithCapturedCommands(undefined, respondToHandoff("completed"));
      try {
        await openHandoffMenu();
        const sameThreadItem = document.querySelector<HTMLElement>(
          '[data-handoff-destination="this-thread"]',
        );
        expect(sameThreadItem?.textContent).toContain("Claude");
        sameThreadItem!.click();
        await vi.waitFor(() => expect(mounted.commands).toHaveLength(1));
        expect(mounted.commands[0]).toMatchObject({
          type: "thread.meta.update",
          threadId: THREAD_ID,
          providerHandoff: true,
          modelSelection: { provider: "claudeAgent" },
        });
        // The handoff waits for its durable outcome, not just command admission.
        // Settle it before unmounting so its timeout cannot toast over a later test.
        await vi.waitFor(() =>
          expect(fixture.snapshot.threads[0]?.modelSelection.provider).toBe("claudeAgent"),
        );
        // Same thread: no new thread, and the route stays put.
        expect(mounted.commands.some((command) => command.type === "thread.handoff.create")).toBe(
          false,
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("still hands off to a new thread with the imported transcript", async () => {
      const mounted = await mountWithCapturedCommands();
      try {
        await openHandoffMenu();
        document.querySelector<HTMLElement>('[data-handoff-destination="new-thread"]')!.click();
        await vi.waitFor(() =>
          expect(mounted.commands.some((command) => command.type === "thread.handoff.create")).toBe(
            true,
          ),
        );
        const create = mounted.commands.find((command) => command.type === "thread.handoff.create");
        expect(create).toMatchObject({
          sourceThreadId: THREAD_ID,
          projectId: PROJECT_ID,
          modelSelection: { provider: "claudeAgent" },
        });
        expect(create && "threadId" in create ? create.threadId : null).not.toBe(THREAD_ID);
        expect(
          create && "importedMessages" in create
            ? create.importedMessages.some((message) =>
                message.text.includes("Fix the flaky reconnect test"),
              )
            : false,
        ).toBe(true);
        expect(mounted.commands.some((command) => command.type === "thread.meta.update")).toBe(
          false,
        );
      } finally {
        await mounted.cleanup();
      }
    });

    // Server reaction to a same-thread handoff: the outcome row keyed by the
    // command, plus (on success) the thread rebound to the target provider.
    const respondToHandoff =
      (outcome: "completed" | "failed") =>
      (
        command: Parameters<
          NonNullable<typeof window.nativeApi>["orchestration"]["dispatchCommand"]
        >[0],
      ) => {
        if (command.type !== "thread.meta.update" || command.providerHandoff !== true) return;
        const { commandId, modelSelection } = command;
        const targetProvider = modelSelection?.provider ?? "claudeAgent";
        const targetModel = modelSelection?.model ?? "claude-sonnet-4-6";
        fixture.snapshot = {
          ...fixture.snapshot,
          snapshotSequence: fixture.snapshot.snapshotSequence + 1,
          threads: fixture.snapshot.threads.map((thread) =>
            thread.id !== THREAD_ID
              ? thread
              : {
                  ...thread,
                  ...(outcome === "completed"
                    ? {
                        modelSelection: {
                          provider: targetProvider,
                          model: targetModel,
                        },
                        session: {
                          threadId: THREAD_ID,
                          status: "ready" as const,
                          providerName: targetProvider,
                          providerInstanceId: targetProvider,
                          runtimeMode: "full-access" as const,
                          activeTurnId: null,
                          lastError: null,
                          updatedAt: NOW_ISO,
                        },
                      }
                    : {}),
                  activities: [
                    ...thread.activities,
                    {
                      id: EventId.makeUnsafe(
                        outcome === "completed"
                          ? `provider-handoff:${commandId}`
                          : `provider-handoff-failed:${commandId}`,
                      ),
                      createdAt: new Date().toISOString(),
                      kind:
                        outcome === "completed" ? "provider.handoff" : "provider.handoff.failed",
                      summary: outcome === "completed" ? "Handed off" : "Handoff failed",
                      tone: outcome === "completed" ? ("info" as const) : ("error" as const),
                      turnId: null,
                      sequence: 950,
                      payload: {
                        sourceProvider: thread.modelSelection.provider,
                        sourceModel: thread.modelSelection.model,
                        targetProvider,
                        targetModel,
                        ...(outcome === "failed" ? { detail: "Claude CLI is not signed in." } : {}),
                      },
                    },
                  ],
                },
          ),
        };
        useStore.getState().syncServerReadModel(fixture.snapshot);
      };

    async function pickClaudeAndSend(text: string) {
      useComposerDraftStore.getState().setModelSelectionAndSticky(THREAD_ID, {
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
      });
      useComposerDraftStore.getState().setPrompt(THREAD_ID, text);
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(() => expect(composerEditor.textContent ?? "").toContain(text), {
        timeout: 8_000,
        interval: 16,
      });
      const sendButton = await waitForSendButton();
      await vi.waitFor(() => expect(sendButton.disabled).toBe(false), {
        timeout: 8_000,
        interval: 16,
      });
      sendButton.click();
      return composerEditor;
    }

    it("hands the thread off before sending when the composer picks another provider", async () => {
      // The target takes a while to start; the message must show meanwhile.
      const mounted = await mountWithCapturedCommands(
        undefined,
        respondToHandoff("completed"),
        1_500,
      );
      try {
        await pickClaudeAndSend("Review the reconnect fix");
        await vi.waitFor(
          () =>
            expect(
              [...document.querySelectorAll('[data-message-role="user"]')].some((row) =>
                (row.textContent ?? "").includes("Review the reconnect fix"),
              ),
            ).toBe(true),
          { timeout: 1_000, interval: 16 },
        );
        expect(mounted.commands.some((command) => command.type === "thread.turn.start")).toBe(
          false,
        );
        await vi.waitFor(
          () =>
            expect(mounted.commands.some((command) => command.type === "thread.turn.start")).toBe(
              true,
            ),
          { timeout: 8_000, interval: 16 },
        );
        const handoffIndex = mounted.commands.findIndex(
          (command) => command.type === "thread.meta.update" && "providerHandoff" in command,
        );
        const turnStartIndex = mounted.commands.findIndex(
          (command) => command.type === "thread.turn.start",
        );
        expect(mounted.commands[handoffIndex]).toMatchObject({
          threadId: THREAD_ID,
          providerHandoff: true,
          modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
        });
        const handoffActivity = fixture.snapshot.threads
          .find((thread) => thread.id === THREAD_ID)!
          .activities.find((activity) => activity.kind === "provider.handoff")!;
        const sentTurn = mounted.commands[turnStartIndex]!;
        expect(sentTurn.type).toBe("thread.turn.start");
        if (sentTurn.type !== "thread.turn.start") throw new Error("Expected turn start");
        expect(Date.parse(sentTurn.createdAt)).toBeGreaterThan(
          Date.parse(handoffActivity.createdAt),
        );
        await vi.waitFor(() => {
          const divider = document.querySelector('[data-provider-handoff-divider="true"]')!;
          const userMessage = [...document.querySelectorAll('[data-message-role="user"]')].find(
            (row) => (row.textContent ?? "").includes("Review the reconnect fix"),
          )!;
          expect(
            divider.compareDocumentPosition(userMessage) & Node.DOCUMENT_POSITION_FOLLOWING,
          ).toBeTruthy();
        });
        // The message only goes out once the target is up, and to the target.
        expect(turnStartIndex).toBeGreaterThan(handoffIndex);
        expect(mounted.commands[turnStartIndex]).toMatchObject({
          threadId: THREAD_ID,
          modelSelection: { provider: "claudeAgent" },
        });
        expect(mounted.commands.some((command) => command.type === "thread.handoff.create")).toBe(
          false,
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("never persists a provider switch before its explicit handoff", async () => {
      const mounted = await mountWithCapturedCommands(undefined, respondToHandoff("completed"));
      try {
        await pickClaudeAndSend("Continue on the selected provider");
        await vi.waitFor(() =>
          expect(mounted.commands.some((command) => command.type === "thread.turn.start")).toBe(
            true,
          ),
        );
        // An ordinary metadata update changes the durable provider immediately.
        // Persisting Claude first makes the real decider refuse the later
        // explicit handoff as a same-provider switch, and loses source provenance.
        const providerUpdates = mounted.commands.filter(
          (command) =>
            command.type === "thread.meta.update" &&
            command.modelSelection?.provider === "claudeAgent",
        );
        expect(providerUpdates[0]).toMatchObject({ providerHandoff: true });
      } finally {
        await mounted.cleanup();
      }
    });

    it("hands off the captured selection when the picker changes during attachment upload", async () => {
      let releaseUpload = () => {};
      attachmentUploadBarrier = new Promise<void>((resolve) => {
        releaseUpload = resolve;
      });
      const mounted = await mountWithCapturedCommands(undefined, respondToHandoff("completed"));
      try {
        useComposerDraftStore.getState().addImage(
          THREAD_ID,
          createComposerImage({
            id: "handoff-upload-image",
            previewUrl: "blob:handoff-upload-image",
          }),
        );
        await pickClaudeAndSend("Continue after uploading");
        // The optimistic row proves this send captured Claude and is now waiting
        // on its real attachment route, before preparing the provider handoff.
        await vi.waitFor(() =>
          expect(
            [...document.querySelectorAll('[data-message-role="user"]')].some((row) =>
              (row.textContent ?? "").includes("Continue after uploading"),
            ),
          ).toBe(true),
        );
        useComposerDraftStore.getState().setModelSelectionAndSticky(THREAD_ID, {
          provider: "codex",
          model: "gpt-5.5",
        });
        await vi.waitFor(() =>
          expect(
            [...document.querySelectorAll("button")].some((button) =>
              (button.textContent ?? "").includes("GPT-5.5"),
            ),
          ).toBe(true),
        );
        releaseUpload();
        await vi.waitFor(() =>
          expect(mounted.commands.some((command) => command.type === "thread.turn.start")).toBe(
            true,
          ),
        );
        expect(
          mounted.commands.find(
            (command) => command.type === "thread.meta.update" && command.providerHandoff === true,
          ),
        ).toMatchObject({
          threadId: THREAD_ID,
          modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
        });
        expect(
          mounted.commands.find((command) => command.type === "thread.turn.start"),
        ).toMatchObject({ modelSelection: { provider: "claudeAgent" } });
      } finally {
        releaseUpload();
        attachmentUploadBarrier = null;
        await mounted.cleanup();
      }
    });

    it("keeps the message in the composer when the picked provider cannot start", async () => {
      const mounted = await mountWithCapturedCommands(undefined, respondToHandoff("failed"));
      try {
        const composerEditor = await pickClaudeAndSend("Review the reconnect fix");
        await expect
          .element(page.getByText("Claude could not start: Claude CLI is not signed in."))
          .toBeVisible();
        expect(mounted.commands.some((command) => command.type === "thread.turn.start")).toBe(
          false,
        );
        // The send rolled back: the message left the transcript for the composer.
        await vi.waitFor(() =>
          expect(composerEditor.textContent ?? "").toContain("Review the reconnect fix"),
        );
        expect(
          [...document.querySelectorAll('[data-message-role="user"]')].some((row) =>
            (row.textContent ?? "").includes("Review the reconnect fix"),
          ),
        ).toBe(false);
      } finally {
        await mounted.cleanup();
      }
    });

    it("shows the handoff event with its source, target, and transferred context", async () => {
      const snapshot = createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("msg-handoff-event"),
        targetText: "Fix the flaky reconnect test",
      });
      const thread = snapshot.threads[0]!;
      const handedOffThread = {
        ...thread,
        modelSelection: { provider: "claudeAgent" as const, model: "claude-sonnet-4-6" },
        activities: [
          {
            id: EventId.makeUnsafe("provider-handoff:event"),
            // Mid-conversation: after an assistant reply, before the next user
            // message, where it used to fold into the settled turn's work group.
            createdAt: isoAt(124),
            kind: "provider.handoff",
            summary: "Handed off from Codex (gpt-5) to Claude (claude-sonnet-4-6)",
            tone: "info" as const,
            turnId: null,
            sequence: 900,
            payload: {
              sourceProvider: "codex",
              sourceModel: "gpt-5.5",
              targetProvider: "claudeAgent",
              targetModel: "claude-sonnet-4-6",
              contextText: "Most recent imported messages:\nUser:\nFix the flaky reconnect test",
              sourceModelSelection: {
                provider: "codex",
                model: "gpt-5.5",
                options: { reasoningEffort: "high", fastMode: true },
              },
              targetModelSelection: {
                provider: "claudeAgent",
                model: "claude-sonnet-4-6",
                options: { effort: "medium" },
              },
              contextCharacters: 66,
            },
          },
        ],
      };
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: { ...snapshot, threads: [handedOffThread] },
        configureFixture: withClaudeReady,
      });
      try {
        // A transcript boundary of its own, naming both models, not a work row.
        const divider = await vi.waitFor(() => {
          const element = document.querySelector<HTMLElement>(
            '[data-provider-handoff-divider="true"]',
          );
          expect(element).not.toBeNull();
          return element!;
        });
        expect(divider.textContent).toContain("Context handoff");
        expect(divider.textContent).toContain("GPT-5.5");
        expect(divider.textContent).toContain("Claude Sonnet 4.6");
        // Effort and fast mode read like the composer's model trigger.
        expect(divider.textContent).toContain("High");
        expect(divider.textContent).toContain("Medium");
        expect(divider.querySelector('[aria-label="Fast mode"]')).not.toBeNull();
        divider.querySelector("button")!.click();
        await expect.element(page.getByText("Transferred context", { exact: true })).toBeVisible();
        const context = document.querySelector('[data-provider-handoff-context="true"]');
        expect(context?.textContent).toContain("Fix the flaky reconnect test");
        // The transcript before the handoff stays in place.
        await expect.element(page.getByText("assistant filler 21")).toBeInTheDocument();
      } finally {
        await mounted.cleanup();
      }
    });
  });

  it("uses the persisted thread access mode instead of a stale composer draft", async () => {
    const base = createSnapshotForTargetUser({
      targetMessageId: "msg-runtime-stale-draft" as MessageId,
      targetText: "Hub worker awaiting approval",
    });
    const snapshot: OrchestrationReadModel = {
      ...base,
      threads: base.threads.map((thread) =>
        Object.assign({}, thread, {
          runtimeMode: "approval-required" as const,
          session: thread.session
            ? { ...thread.session, runtimeMode: "approval-required" as const }
            : null,
        }),
      ),
    };
    useComposerDraftStore.getState().setRuntimeMode(THREAD_ID, "full-access");
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    try {
      await expect
        .element(page.getByRole("button", { name: "Ask for approval", exact: true }))
        .toBeVisible();
      const trigger = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[title^="Ask for approval:"]'),
        "Missing persisted access mode trigger",
      );
      trigger.click();
      const fullAccess = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="menu-radio-item"]')).find(
            (item) => item.textContent?.trim().startsWith("Full access"),
          ) ?? null,
        "Missing Full access override",
      );
      fullAccess.click();
      await vi.waitFor(() => {
        expect(
          wsRequests
            .map(readDispatchedCommand)
            .filter((command) => command?.type === "thread.runtime-mode.set")
            .map((command) => command?.runtimeMode),
        ).toEqual(["full-access"]);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("dispatches a rapid access-mode reversal while the server projection is stale", async () => {
    const baseSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-runtime-reversal" as MessageId,
      targetText: "runtime reversal",
    });
    const snapshot: OrchestrationReadModel = {
      ...baseSnapshot,
      threads: baseSnapshot.threads.map((thread) => ({
        ...thread,
        runtimeMode: "approval-required",
        session: thread.session
          ? {
              ...thread.session,
              runtimeMode: "approval-required",
            }
          : null,
      })),
    };
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
    });

    try {
      const supervisedTrigger = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[title^="Ask for approval:"]'),
        "Unable to find the Ask for approval access-mode trigger.",
      );
      supervisedTrigger.click();
      const autoOption = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="menu-radio-item"]')).find(
            (item) => item.textContent?.trim().startsWith("Approve for me"),
          ) ?? null,
        "Unable to find the Approve for me access-mode option.",
      );
      autoOption.click();

      const autoTrigger = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[title^="Approve for me:"]'),
        "Approve for me did not become the acknowledged composer access mode.",
      );
      autoTrigger.click();
      const supervisedOption = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="menu-radio-item"]')).find(
            (item) => item.textContent?.trim().startsWith("Ask for approval"),
          ) ?? null,
        "Unable to find the Ask for approval access-mode option.",
      );
      supervisedOption.click();

      await vi.waitFor(
        () => {
          const runtimeModes = wsRequests
            .map(readDispatchedCommand)
            .filter((command) => command?.type === "thread.runtime-mode.set")
            .map((command) => command?.runtimeMode);
          expect(runtimeModes).toEqual(["auto", "approval-required"]);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  // Other widths are covered by the resize test below, which checks that the
  // collapsed row keeps the same height across the whole viewport matrix.
  it.each([TEXT_VIEWPORT_MATRIX[0]])(
    "[geometry:linux] clamps long user messages to twelve rendered lines at the $name viewport",
    async (viewport) => {
      const userText = "x".repeat(3_200);
      const targetMessageId = `msg-user-target-long-${viewport.name}` as MessageId;
      const mounted = await mountChatView({
        viewport,
        snapshot: createSnapshotForTargetUser({
          targetMessageId,
          targetText: userText,
        }),
      });

      try {
        await mounted.measureUserRow(targetMessageId);
        const row = document.querySelector<HTMLElement>(
          `[data-message-id="${targetMessageId}"][data-message-role="user"]`,
        )!;
        const clamp = row.querySelector<HTMLElement>('[data-user-message-clamp="true"]')!;
        expect(clamp).toBeTruthy();
        const text = clamp.firstElementChild!;
        const lineHeightPx = Number.parseFloat(getComputedStyle(text).lineHeight);
        expect(lineHeightPx).toBeGreaterThan(0);
        expect(clamp.scrollHeight).toBeGreaterThan(clamp.clientHeight);
        expect(
          Math.abs(clamp.getBoundingClientRect().height - 12 * lineHeightPx),
        ).toBeLessThanOrEqual(1);
        expect(row.querySelector('button[aria-expanded="false"]')?.textContent).toBe("Show more");
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("[geometry:linux] tracks wrapping parity while resizing an existing ChatView across the viewport matrix", async () => {
    const userText = "x".repeat(3_200);
    const targetMessageId = "msg-user-target-resize" as MessageId;
    const mounted = await mountChatView({
      viewport: TEXT_VIEWPORT_MATRIX[0],
      snapshot: createSnapshotForTargetUser({
        targetMessageId,
        targetText: userText,
      }),
    });

    try {
      const measurements: UserRowMeasurement[] = [];

      for (const viewport of TEXT_VIEWPORT_MATRIX) {
        await mounted.setViewport(viewport);
        const measurement = await mounted.measureUserRow(targetMessageId);
        measurements.push(measurement);
      }

      expect(
        new Set(measurements.map((measurement) => Math.round(measurement.timelineWidthMeasuredPx)))
          .size,
      ).toBeGreaterThanOrEqual(3);

      const byMeasuredWidth = measurements.toSorted(
        (left, right) => left.timelineWidthMeasuredPx - right.timelineWidthMeasuredPx,
      );
      const narrowest = byMeasuredWidth[0]!;
      const widest = byMeasuredWidth.at(-1)!;
      expect(narrowest.timelineWidthMeasuredPx).toBeLessThan(widest.timelineWidthMeasuredPx);
      // Both widths exceed the 12-line limit, so the collapsed row stays the same height.
      expect(
        Math.abs(narrowest.measuredRowHeightPx - widest.measuredRowHeightPx),
      ).toBeLessThanOrEqual(8);
    } finally {
      await mounted.cleanup();
    }
  });

  it("[geometry:linux] collapses header actions into overflow before they can overlap the thread title", async () => {
    const longTitle =
      'remove "ago" from the sidebar while the diff panel stays open on smaller viewports';
    const headerOverflowSnapshot = (() => {
      const snapshot = createSnapshotForTargetUser({
        targetMessageId: "msg-user-header-overflow-target" as MessageId,
        targetText: "header overflow",
      });

      return withProjectScripts(
        {
          ...snapshot,
          threads: snapshot.threads.map((thread) =>
            thread.id === THREAD_ID ? Object.assign({}, thread, { title: longTitle }) : thread,
          ),
        },
        [
          {
            id: "dev-server",
            name: "Dev",
            command: "bun run dev",
            icon: "play",
            runOnWorktreeCreate: false,
          },
        ],
      );
    })();
    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 540 },
      snapshot: headerOverflowSnapshot,
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode"],
        };
      },
    });

    try {
      await vi.waitFor(
        () => {
          const title = document.querySelector<HTMLElement>(`h2[title='${longTitle}']`);
          const overflowButton = document.querySelector<HTMLButtonElement>(
            'button[aria-label="Toggle environment panel"]',
          );

          expect(title, "Unable to find the chat header title.").toBeTruthy();
          expect(overflowButton, "Unable to find the header overflow trigger.").toBeTruthy();

          const titleRight = title!.getBoundingClientRect().right;
          const actionsLeft = overflowButton!.getBoundingClientRect().left;
          expect(titleRight).toBeLessThanOrEqual(actionsLeft + 1);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows transport recovery without auto-following a detached transcript", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithLongAssistantResponse(),
    });
    try {
      const scrollContainer = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Unable to find message scroll container.",
      );
      await waitForLayout();
      scrollContainer.scrollTop = 100;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();
      const previousTop = scrollContainer.scrollTop;
      emitWsTransportState("connecting");
      await expect
        .element(page.getByRole("status").filter({ hasText: "Reconnecting to Synara…" }), {
          timeout: 4000,
        })
        .toBeVisible();
      await waitForLayout();
      expect(Math.abs(scrollContainer.scrollTop - previousTop)).toBeLessThanOrEqual(1);
      emitWsTransportState("open");
      await expect
        .element(page.getByRole("status").filter({ hasText: "Reconnecting to Synara…" }))
        .not.toBeInTheDocument();
      await waitForLayout();
      expect(Math.abs(scrollContainer.scrollTop - previousTop)).toBeLessThanOrEqual(1);
    } finally {
      emitWsTransportState("open");
      await mounted.cleanup();
    }
  });

  it("[geometry:linux] keeps the composer visible while a long assistant response forces a viewport relayout", async () => {
    const mounted = await mountChatView({
      viewport: TEXT_VIEWPORT_MATRIX[0],
      snapshot: createSnapshotWithLongAssistantResponse(),
    });

    try {
      const desktopLayout = await mounted.measureLayout();
      expect(desktopLayout.scrollClientHeightPx).toBeGreaterThan(0);
      expect(desktopLayout.scrollHeightPx).toBeGreaterThan(desktopLayout.scrollClientHeightPx);
      expect(desktopLayout.composerBottomPx).toBeLessThanOrEqual(desktopLayout.hostHeightPx + 1);

      await mounted.setViewport(TEXT_VIEWPORT_MATRIX[2]);
      const mobileLayout = await mounted.measureLayout();
      expect(mobileLayout.scrollClientHeightPx).toBeGreaterThan(0);
      expect(mobileLayout.scrollHeightPx).toBeGreaterThan(mobileLayout.scrollClientHeightPx);
      expect(mobileLayout.composerBottomPx).toBeLessThanOrEqual(mobileLayout.hostHeightPx + 1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("stays pinned to the bottom after delayed attachment loads expand the timeline", async () => {
    attachmentResponseDelayMs = 160;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithBottomAttachments(),
    });

    try {
      const scrollContainer = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Unable to find message scroll container.",
      );
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();
      await vi.waitFor(
        () => {
          expect(document.querySelectorAll("img").length).toBeGreaterThanOrEqual(3);
        },
        { timeout: 8_000, interval: 16 },
      );
      await waitForImagesToLoad(document.body);
      await vi.waitFor(
        async () => {
          const layout = await mounted.measureLayout();
          expect(layout.scrollHeightPx).toBeGreaterThan(layout.scrollClientHeightPx);
          expect(layout.distanceFromBottomPx).toBeLessThanOrEqual(AUTO_SCROLL_BOTTOM_THRESHOLD_PX);
        },
        { timeout: 4_000, interval: 16 },
      );
    } finally {
      attachmentResponseDelayMs = 0;
      await mounted.cleanup();
    }
  });

  it("does not let delayed tail-expansion retries override a user scroll takeover", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithBottomAttachments(),
    });
    let restoreScrollTo = () => {};

    try {
      const scrollContainer = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Unable to find message scroll container.",
      );
      const tailImage = await waitForElement(
        () => document.querySelector<HTMLImageElement>("img[alt='bottom-attachment-3.png']"),
        "Unable to find the tail attachment image.",
      );
      await waitForImagesToLoad(document.body);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 300));
      await waitForLayout();

      const scrollSpy = installImmediateScrollToSpy(scrollContainer);
      restoreScrollTo = scrollSpy.restore;

      scrollContainer.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }));
      scrollContainer.scrollTo({ top: 0, behavior: "auto" });
      scrollContainer.dispatchEvent(new Event("scroll"));
      tailImage.dispatchEvent(new Event("load", { bubbles: true }));

      await new Promise<void>((resolve) => window.setTimeout(resolve, 320));
      expect(getScrollContainerDistanceFromBottom(scrollContainer)).toBeGreaterThan(
        AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
      );
      expect(
        scrollSpy.calls.every(
          (call) =>
            typeof call.top !== "number" ||
            call.top <= scrollContainer.scrollTop + AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
        ),
      ).toBe(true);
    } finally {
      restoreScrollTo();
      await mounted.cleanup();
    }
  });

  it("does not snap to the end when reading down from a transcript moved off its end", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithInlineToolOverflow({ active: false }),
    });

    try {
      const scrollContainer = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Unable to find message scroll container.",
      );
      await vi.waitFor(() =>
        expect(getScrollContainerDistanceFromBottom(scrollContainer)).toBeLessThanOrEqual(4),
      );
      // Layout, not a reader gesture, moves the following transcript to the top.
      scrollContainer.scrollTop = 0;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForTranscriptLayoutToSettle(scrollContainer);
      expect(scrollContainer.scrollHeight).toBeGreaterThan(scrollContainer.clientHeight * 2);

      await userEvent.wheel(scrollContainer, { delta: { y: 40 } });
      await waitForTranscriptLayoutToSettle(scrollContainer);
      expect(scrollContainer.scrollTop).toBeGreaterThan(0);
      expect(scrollContainer.scrollTop).toBeLessThan(scrollContainer.clientHeight);
    } finally {
      await mounted.cleanup();
    }
  });

  it.each([false, true])(
    "flushes editor changes before sending and preserves the prompt on failure=%s",
    async (failSave) => {
      const restoreNativeApi = installDeterministicSendNativeApi();
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotWithLongAssistantResponse(),
      });
      let unsubscribe = () => {};
      try {
        let finish!: () => void;
        const writeFile = vi.fn(
          () =>
            new Promise<{ relativePath: string; version: string }>((resolve, reject) => {
              finish = () =>
                failSave
                  ? reject(new Error("Editor write failed"))
                  : resolve({ relativePath: "file.ts", version: "sha256:saved" });
            }),
        );
        const api = readNativeApi()!;
        Object.defineProperty(window, "nativeApi", {
          configurable: true,
          value: { ...api, projects: { ...api.projects, writeFile } },
        });
        const session = getWorkspaceEditorSession(
          mounted.router.options.context.queryClient,
          "/repo/project",
          "file.ts",
        );
        unsubscribe = session.subscribe(() => undefined);
        session.load({
          relativePath: "file.ts",
          contents: "original",
          version: "sha256:initial",
          encoding: "utf8",
          lineEnding: "lf",
          truncated: false,
        });
        session.change("editor draft");
        const prompt = "use the saved editor changes";
        useComposerDraftStore.getState().setPrompt(THREAD_ID, prompt);
        const turnStarts = () =>
          wsRequests.filter(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              (request.command as { type?: string } | undefined)?.type === "thread.turn.start",
          );
        const before = turnStarts().length;
        (await waitForSendButton()).click();
        await vi.waitFor(() => expect(writeFile).toHaveBeenCalledTimes(1));
        expect(turnStarts()).toHaveLength(before);
        finish();
        if (failSave) {
          await vi.waitFor(() =>
            expect(document.body.textContent).toContain("Could not save editor changes"),
          );
          expect(turnStarts()).toHaveLength(before);
          expect(session.getSnapshot().value).toBe("editor draft");
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(prompt);
        } else {
          await vi.waitFor(() => expect(turnStarts()).toHaveLength(before + 1));
          expect(session.dirty).toBe(false);
        }
      } finally {
        unsubscribe();
        restoreNativeApi();
        await mounted.cleanup();
      }
    },
  );

  // Leaving a thread you just sent in and coming back must not replay the
  // send-time anchor slide: the transcript is remounted with no scroll history,
  // so replaying it means bootstrapping at the top of the conversation and then
  // flying down through the whole history in view.
  it("reopens a thread you sent in at its anchored end without replaying the slide", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: addThreadToSnapshot(createSnapshotWithLongAssistantResponse(), OTHER_THREAD_ID),
    });

    try {
      const firstContainer = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Unable to find message scroll container.",
      );
      await vi.waitFor(
        () => {
          expect(firstContainer.scrollHeight).toBeGreaterThan(firstContainer.clientHeight);
          expect(getScrollContainerDistanceFromBottom(firstContainer)).toBeLessThanOrEqual(
            AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
          );
        },
        { timeout: 8_000, interval: 16 },
      );

      const prompt = "anchor me before the thread switch";
      useComposerDraftStore.getState().setPrompt(THREAD_ID, prompt);
      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(prompt);
        },
        { timeout: 8_000, interval: 16 },
      );
      // Let the send's anchor slide finish before leaving.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 600));

      // Leave and come back: the thread's detail stays cached, so the whole
      // transcript is present in the very first render of the remounted list.
      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: OTHER_THREAD_ID },
      });
      await waitForURL(
        mounted.router,
        (pathname) => pathname === `/${OTHER_THREAD_ID}`,
        "Expected to navigate to the other thread.",
      );
      await waitForLayout();

      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: THREAD_ID },
      });

      const travel = await recordTranscriptScrollTravel(1_500);
      expect(travel.visibleFrames).toBeGreaterThan(10);
      // Never painted far from the live edge, and never seen travelling there.
      expect(travel.maxDistanceFromBottomPx).toBeLessThanOrEqual(AUTO_SCROLL_BOTTOM_THRESHOLD_PX);
      expect(travel.downwardTravelPx).toBeLessThanOrEqual(AUTO_SCROLL_BOTTOM_THRESHOLD_PX);
    } finally {
      restoreNativeApi();
      await mounted.cleanup();
    }
  });

  it("settles the scroll-to-bottom arrow at the measured transcript end", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithLongAssistantResponse(),
    });
    let restoreScrollTo = () => {};

    try {
      const scrollContainer = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Unable to find message scroll container.",
      );
      await vi.waitFor(() => {
        expect(scrollContainer.scrollHeight).toBeGreaterThan(scrollContainer.clientHeight);
        expect(getScrollContainerDistanceFromBottom(scrollContainer)).toBeLessThanOrEqual(
          AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
        );
      });
      scrollContainer.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }));
      scrollContainer.scrollTo({ top: 0, behavior: "auto" });
      await vi.waitFor(() => {
        expect(getScrollContainerDistanceFromBottom(scrollContainer)).toBeGreaterThan(
          AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
        );
      });
      const scrollButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            "button[aria-label='Scroll to bottom'][aria-hidden='false']",
          ),
        "Unable to find the visible scroll-to-bottom button.",
      );

      const scrollSpy = installImmediateScrollToSpy(scrollContainer);
      restoreScrollTo = scrollSpy.restore;

      scrollButton.click();

      await vi.waitFor(
        () => {
          expect(scrollSpy.calls.some((call) => call.behavior === "smooth")).toBe(true);
          expect(scrollSpy.calls.some((call) => call.behavior === "auto")).toBe(true);
          expect(getScrollContainerDistanceFromBottom(scrollContainer)).toBeLessThanOrEqual(
            AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      restoreScrollTo();
      await mounted.cleanup();
    }
  });

  it("stops the arrow's smooth scroll when the user scrolls upward", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithLongAssistantResponse(),
    });
    let restoreScrollTo = () => {};

    try {
      const scrollContainer = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Unable to find message scroll container.",
      );
      await vi.waitFor(() => {
        expect(scrollContainer.scrollHeight).toBeGreaterThan(scrollContainer.clientHeight);
      });
      // Let mount-time tail expansion retries (max 260ms) finish before
      // isolating the arrow scroll and the user's takeover gesture.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 300));
      await waitForLayout();
      scrollContainer.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }));
      scrollContainer.scrollTo({ top: 0, behavior: "auto" });
      await vi.waitFor(() => {
        expect(getScrollContainerDistanceFromBottom(scrollContainer)).toBeGreaterThan(
          AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
        );
      });
      const scrollButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            "button[aria-label='Scroll to bottom'][aria-hidden='false']",
          ),
        "Unable to find the visible scroll-to-bottom button.",
      );
      const scrollSpy = installImmediateScrollToSpy(scrollContainer, {
        suspendSmoothScroll: true,
      });
      restoreScrollTo = scrollSpy.restore;

      scrollButton.click();
      await vi.waitFor(() => {
        expect(scrollSpy.calls.some((call) => call.behavior === "smooth")).toBe(true);
      });
      const takeoverOffset = scrollContainer.scrollTop;
      scrollContainer.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }));

      await vi.waitFor(() => {
        expect(scrollSpy.calls.some((call) => call.behavior === "auto")).toBe(true);
      });
      await new Promise<void>((resolve) => window.setTimeout(resolve, 400));
      const smoothCalls = scrollSpy.calls.filter((call) => call.behavior === "smooth");
      const takeoverCalls = scrollSpy.calls.filter((call) => call.behavior === "auto");
      expect(smoothCalls).toHaveLength(1);
      expect(takeoverCalls.length).toBeGreaterThanOrEqual(1);
      expect(
        takeoverCalls.every(
          (call) =>
            typeof call.top === "number" &&
            call.top <= takeoverOffset + AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
        ),
      ).toBe(true);
    } finally {
      restoreScrollTo();
      await mounted.cleanup();
    }
  });

  // How the transcript gets there — one motion, no bouncing — is covered by
  // "moves a sent message to its anchor once…"; this guards the outcome: a send
  // from far up the transcript ends pinned at the live edge with focus kept.
  it("re-sticks to the bottom after sending an optimistic user message", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-send-bottom-stick" as MessageId,
        targetText: "bottom stick target",
      }),
    });
    let restoreScrollTo = () => {};

    try {
      const scrollContainer = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Unable to find message scroll container.",
      );
      scrollContainer.scrollTop = 0;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();
      expect(getScrollContainerDistanceFromBottom(scrollContainer)).toBeGreaterThan(
        AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
      );

      // Installed so any native smooth scroll resolves immediately; the send
      // path itself drives the container frame by frame, so this spy is here for
      // determinism rather than to observe the motion.
      const scrollSpy = installImmediateScrollToSpy(scrollContainer);
      restoreScrollTo = scrollSpy.restore;

      const prompt = "keep me pinned after send";
      useComposerDraftStore.getState().setPrompt(THREAD_ID, prompt);

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      await userEvent.click(sendButton);

      await vi.waitFor(
        async () => {
          expect(document.body.textContent).toContain(prompt);
          expect(document.activeElement).toBe(await waitForComposerEditor());
          const layout = await mounted.measureLayout();
          expect(layout.scrollHeightPx).toBeGreaterThan(layout.scrollClientHeightPx);
          expect(layout.distanceFromBottomPx).toBeLessThanOrEqual(AUTO_SCROLL_BOTTOM_THRESHOLD_PX);
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(scrollContainer.scrollTop, "transcript never left the top").toBeGreaterThan(0);
    } finally {
      restoreScrollTo();
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it.each(["Enter", "send button", "plan follow-up"])(
    "keeps sent messages at the bottom with anchoring disabled when using %s, and follows streaming text",
    async (sendMethod) => {
      localStorage.setItem(
        "synara:app-settings:v1",
        JSON.stringify({ anchorSentMessagesToTop: false }),
      );
      const restoreNativeApi = installDeterministicSendNativeApi();
      let currentSnapshot =
        sendMethod === "plan follow-up"
          ? createSnapshotWithSettledPlanAwaitingFollowUp()
          : createSnapshotForTargetUser({
              targetMessageId: "msg-user-send-no-anchor" as MessageId,
              targetText: "Previous conversation message",
            });
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: currentSnapshot,
      });

      try {
        const scrollContainer = await waitForElement(
          () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
          "Unable to find message scroll container.",
        );
        // Sending must return to the live edge even if the reader was looking at history.
        scrollContainer.scrollTop = 0;
        scrollContainer.dispatchEvent(new Event("scroll"));
        await waitForLayout();

        const prompt = "Keep this message at the bottom";
        if (sendMethod === "plan follow-up") {
          useComposerDraftStore.getState().setInteractionMode(THREAD_ID, "plan");
        }
        useComposerDraftStore.getState().setPrompt(THREAD_ID, prompt);
        await vi.waitFor(async () => {
          expect((await waitForComposerEditor()).textContent).toContain(prompt);
        });
        if (sendMethod !== "send button") {
          await userEvent.click(await waitForComposerEditor());
          await userEvent.keyboard("{Enter}");
        } else {
          const sendButton = await waitForSendButton();
          expect(sendButton.disabled).toBe(false);
          await userEvent.click(sendButton);
        }

        const findSentRow = () =>
          Array.from(
            document.querySelectorAll<HTMLElement>("[data-message-id][data-message-role='user']"),
          ).find((row) => row.textContent?.includes(prompt));
        await vi.waitFor(
          () => {
            const row = findSentRow();
            expect(row, "sent user message missing").toBeTruthy();
            expect(
              row!.getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top,
              "sent user message moved to the viewport top",
            ).toBeGreaterThan(scrollContainer.clientHeight / 2);
            expect(getScrollContainerDistanceFromBottom(scrollContainer)).toBeLessThanOrEqual(2);
          },
          { timeout: 8_000, interval: 16 },
        );
        if (sendMethod !== "plan follow-up") {
          expect(document.activeElement).toBe(await waitForComposerEditor());
        }

        const sentMessageId = MessageId.makeUnsafe(findSentRow()!.dataset.messageId!);
        const activeTurnId = TurnId.makeUnsafe("turn-no-anchor");
        const streamingId = MessageId.makeUnsafe("msg-assistant-no-anchor");
        for (const paragraphCount of [1, 20]) {
          currentSnapshot = {
            ...currentSnapshot,
            snapshotSequence: currentSnapshot.snapshotSequence + 1,
            threads: currentSnapshot.threads.map((thread) =>
              thread.id !== THREAD_ID
                ? thread
                : {
                    ...thread,
                    messages: [
                      ...thread.messages.filter(
                        (message) => message.id !== streamingId && message.id !== sentMessageId,
                      ),
                      {
                        id: sentMessageId,
                        role: "user" as const,
                        text: prompt,
                        turnId: activeTurnId,
                        streaming: false,
                        source: "native" as const,
                        createdAt: isoAt(1_300),
                        updatedAt: isoAt(1_300),
                      },
                      {
                        id: streamingId,
                        role: "assistant" as const,
                        text: "Streaming response paragraph.\n\n".repeat(paragraphCount),
                        turnId: activeTurnId,
                        streaming: true,
                        source: "native" as const,
                        createdAt: isoAt(1_302),
                        updatedAt: isoAt(1_302 + paragraphCount),
                      },
                    ],
                    latestTurn: {
                      turnId: activeTurnId,
                      state: "running" as const,
                      requestedAt: isoAt(1_300),
                      startedAt: isoAt(1_301),
                      completedAt: null,
                      assistantMessageId: streamingId,
                    },
                    session: thread.session
                      ? { ...thread.session, status: "running" as const, activeTurnId }
                      : null,
                  },
            ),
            updatedAt: isoAt(1_302 + paragraphCount),
          };
          fixture = { ...fixture, snapshot: currentSnapshot };
          useStore.getState().syncServerReadModel(currentSnapshot);
          await vi.waitFor(
            () => {
              expect(document.body.textContent).toContain("Streaming response paragraph.");
              expect(getScrollContainerDistanceFromBottom(scrollContainer)).toBeLessThanOrEqual(2);
            },
            { timeout: 8_000, interval: 16 },
          );
        }
      } finally {
        await mounted.cleanup();
        restoreNativeApi();
      }
    },
  );

  it("anchors a freshly sent user message at the top of the transcript viewport", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    let currentSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-send-tail-anchor" as MessageId,
      targetText: "tail anchor target",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: currentSnapshot,
    });

    const syncActiveThread = (
      update: (
        thread: OrchestrationReadModel["threads"][number],
      ) => OrchestrationReadModel["threads"][number],
    ) => {
      currentSnapshot = {
        ...currentSnapshot,
        snapshotSequence: currentSnapshot.snapshotSequence + 1,
        threads: currentSnapshot.threads.map((thread) =>
          thread.id === THREAD_ID ? update(thread) : thread,
        ),
        updatedAt: isoAt(currentSnapshot.snapshotSequence + 1_200),
      };
      fixture = { ...fixture, snapshot: currentSnapshot };
      useStore.getState().syncServerReadModel(currentSnapshot);
    };

    try {
      const scrollContainer = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Unable to find message scroll container.",
      );
      // Start where a real conversation sits: parked at the bottom of the transcript.
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();

      const prompt = "anchor this message at the viewport top";
      useComposerDraftStore.getState().setPrompt(THREAD_ID, prompt);
      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      const findSentRow = () => {
        const rows = document.querySelectorAll<HTMLElement>(
          "[data-message-id][data-message-role='user']",
        );
        for (const row of rows) {
          if (row.textContent?.includes(prompt)) {
            return row;
          }
        }
        return null;
      };

      const anchorOffsetPx = () => {
        const row = findSentRow();
        if (!row) {
          return null;
        }
        return row.getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top;
      };
      // The anchored message keeps the same top gap a chat's first message gets:
      // the scroll container's own top padding.
      const expectedTopGapPx = Number.parseFloat(getComputedStyle(scrollContainer).paddingTop) || 0;

      await vi.waitFor(
        () => {
          const offsetPx = anchorOffsetPx();
          expect(offsetPx, "sent user message row not rendered").not.toBeNull();
          expect(Math.abs(offsetPx! - expectedTopGapPx)).toBeLessThanOrEqual(24);
        },
        { timeout: 8_000, interval: 16 },
      );
      // Real sends ack before the turn goes live, so the transcript sits with no
      // running turn for a beat. The anchor must survive that gap instead of
      // collapsing the moment the send stops being "busy".
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 700);
      });
      const offsetAfterAckGapPx = anchorOffsetPx();
      expect(offsetAfterAckGapPx, "sent user message row missing after ack gap").not.toBeNull();
      expect(Math.abs(offsetAfterAckGapPx! - expectedTopGapPx)).toBeLessThanOrEqual(24);

      // The server acknowledges the send and the turn starts running: the durable
      // user message replaces the optimistic row and live turn chrome appears.
      const activeTurnId = TurnId.makeUnsafe("turn-tail-anchor");
      const sentMessageId = findSentRow()?.dataset.messageId;
      expect(sentMessageId, "sent user message id").toBeTruthy();
      syncActiveThread((thread) => ({
        ...thread,
        messages: [
          ...thread.messages,
          {
            id: MessageId.makeUnsafe(sentMessageId!),
            role: "user" as const,
            text: prompt,
            turnId: activeTurnId,
            streaming: false,
            source: "native" as const,
            createdAt: isoAt(1_300),
            updatedAt: isoAt(1_300),
          },
        ],
        latestTurn: {
          turnId: activeTurnId,
          state: "running",
          requestedAt: isoAt(1_300),
          startedAt: isoAt(1_301),
          completedAt: null,
          assistantMessageId: null,
        },
        session: thread.session
          ? { ...thread.session, status: "running", activeTurnId, updatedAt: isoAt(1_301) }
          : null,
        updatedAt: isoAt(1_301),
      }));
      await waitForLayout();
      await vi.waitFor(
        () => {
          const offsetPx = anchorOffsetPx();
          expect(offsetPx, "sent user message row missing after ack").not.toBeNull();
          expect(Math.abs(offsetPx! - expectedTopGapPx)).toBeLessThanOrEqual(24);
        },
        { timeout: 4_000, interval: 16 },
      );

      // The assistant response streams in below the anchored message. While it is
      // shorter than the viewport the anchored message must not move.
      const streamingId = MessageId.makeUnsafe("msg-assistant-tail-anchor-stream");
      for (const chunkCount of [1, 3, 6]) {
        syncActiveThread((thread) => ({
          ...thread,
          messages: [
            ...thread.messages.filter((message) => message.id !== streamingId),
            {
              id: streamingId,
              role: "assistant" as const,
              text: `Streaming response paragraph.\n\n`.repeat(chunkCount),
              turnId: activeTurnId,
              streaming: true,
              source: "native" as const,
              createdAt: isoAt(1_302),
              updatedAt: isoAt(1_302 + chunkCount),
            },
          ],
          updatedAt: isoAt(1_302 + chunkCount),
        }));
        await waitForLayout();
        await waitForLayout();
        const offsetPx = anchorOffsetPx();
        expect(offsetPx, `anchor row missing while streaming ${chunkCount} chunks`).not.toBeNull();
        expect(
          Math.abs(offsetPx! - expectedTopGapPx),
          `anchor drifted while streaming ${chunkCount} chunks`,
        ).toBeLessThanOrEqual(24);
      }

      // The turn completes: the reserve persists so the settled transcript does
      // not jump back to its true bottom.
      const scrollTopBeforeTurnEnd = scrollContainer.scrollTop;
      syncActiveThread((thread) => ({
        ...thread,
        messages: thread.messages.map((message) =>
          message.id === streamingId
            ? { ...message, streaming: false, updatedAt: isoAt(1_400) }
            : message,
        ),
        latestTurn: thread.latestTurn
          ? { ...thread.latestTurn, state: "completed", completedAt: isoAt(1_400) }
          : thread.latestTurn,
        session: thread.session
          ? { ...thread.session, status: "idle", activeTurnId: null, updatedAt: isoAt(1_400) }
          : null,
        updatedAt: isoAt(1_400),
      }));
      await waitForLayout();
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 700);
      });
      const offsetAfterTurnEndPx = anchorOffsetPx();
      expect(offsetAfterTurnEndPx, "sent user message row missing after turn end").not.toBeNull();
      expect(
        Math.abs(offsetAfterTurnEndPx! - expectedTopGapPx),
        "anchor jumped when the turn settled",
      ).toBeLessThanOrEqual(24);
      expect(
        Math.abs(scrollContainer.scrollTop - scrollTopBeforeTurnEnd),
        "scroll position jumped when the turn settled",
      ).toBeLessThanOrEqual(2);

      const anchoredScrollHeight = scrollContainer.scrollHeight;
      for (const enabled of [false, true]) {
        const storedSettings = JSON.parse(localStorage.getItem("synara:app-settings:v1") ?? "{}");
        localStorage.setItem(
          "synara:app-settings:v1",
          JSON.stringify({ ...storedSettings, anchorSentMessagesToTop: enabled }),
        );
        window.dispatchEvent(new StorageEvent("storage", { key: "synara:app-settings:v1" }));
        await vi.waitFor(
          () => {
            expect(
              scrollContainer.scrollHeight,
              "disabling must release the reserve; re-enabling must not resurrect the old anchor",
            ).toBeLessThan(anchoredScrollHeight - 50);
          },
          { timeout: 4_000, interval: 16 },
        );
        await waitForLayout();
      }
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("shows uncertain delivery and blocks another send without a local dispatch marker", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("msg-before-uncertain-delivery"),
        targetText: "Previous message",
      }),
    });
    const finishSettlement = trackWsTurnSettlement(THREAD_ID);
    try {
      // The ordinary loading marker can expire or be absent after navigation.
      useThreadDispatchStore.setState({ threads: {} });
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "Do not duplicate this send");
      await expect.element(page.getByText("Checking message delivery…")).toBeVisible();
      const form = document.querySelector<HTMLFormElement>("[data-chat-composer-form='true']")!;
      form.requestSubmit();
      await waitForLayout();
      expect(
        wsRequests.filter(
          (request) => readDispatchedCommand(request)?.type === "thread.turn.start",
        ),
      ).toHaveLength(0);
      finishSettlement();
      await expect.element(page.getByText("Checking message delivery…")).not.toBeInTheDocument();
      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
    } finally {
      finishSettlement();
      await mounted.cleanup();
    }
  });

  it("shows Loading until ack, then keeps Thinking through the post-ack gap", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    let currentSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-thinking-bridge" as MessageId,
      targetText: "thinking bridge target",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: currentSnapshot,
    });

    const syncActiveThread = (
      update: (
        thread: OrchestrationReadModel["threads"][number],
      ) => OrchestrationReadModel["threads"][number],
    ) => {
      currentSnapshot = {
        ...currentSnapshot,
        snapshotSequence: currentSnapshot.snapshotSequence + 1,
        threads: currentSnapshot.threads.map((thread) =>
          thread.id === THREAD_ID ? update(thread) : thread,
        ),
        updatedAt: isoAt(currentSnapshot.snapshotSequence + 1_200),
      };
      fixture = { ...fixture, snapshot: currentSnapshot };
      useStore.getState().syncServerReadModel(currentSnapshot);
    };

    try {
      const prompt = "keep thinking through the ack gap";
      useComposerDraftStore.getState().setPrompt(THREAD_ID, prompt);
      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(prompt);
          expect(document.body.textContent).toContain("Loading");
          expect(document.body.textContent).not.toContain("Thinking");
        },
        { timeout: 8_000, interval: 16 },
      );

      const findSentRow = () => {
        const rows = document.querySelectorAll<HTMLElement>(
          "[data-message-id][data-message-role='user']",
        );
        for (const row of rows) {
          if (row.textContent?.includes(prompt)) {
            return row;
          }
        }
        return null;
      };

      const sentMessageId = await vi.waitFor(
        () => {
          const id = findSentRow()?.dataset.messageId;
          expect(id, "sent user message id").toBeTruthy();
          return id!;
        },
        { timeout: 8_000, interval: 16 },
      );

      // Server ack: durable user message + turn requested, but session still ready
      // (provider session not live yet). Thinking must survive this gap.
      const requestedTurnId = TurnId.makeUnsafe("turn-thinking-bridge");
      syncActiveThread((thread) => ({
        ...thread,
        messages: [
          ...thread.messages,
          {
            id: MessageId.makeUnsafe(sentMessageId),
            role: "user" as const,
            text: prompt,
            turnId: requestedTurnId,
            streaming: false,
            source: "native" as const,
            createdAt: isoAt(1_300),
            updatedAt: isoAt(1_300),
          },
        ],
        latestTurn: {
          turnId: requestedTurnId,
          state: "running",
          requestedAt: isoAt(1_300),
          startedAt: null,
          completedAt: null,
          assistantMessageId: null,
        },
        session: thread.session
          ? {
              ...thread.session,
              status: "ready",
              activeTurnId: null,
              updatedAt: isoAt(1_300),
            }
          : null,
        updatedAt: isoAt(1_300),
      }));

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(prompt);
          expect(document.body.textContent).toContain("Thinking");
          expect(document.body.textContent).not.toContain("Loading");
          expect(document.body.textContent).not.toContain("Working for");
        },
        { timeout: 4_000, interval: 16 },
      );

      // Hold the gap briefly so a flicker/empty frame would be visible if the
      // bridge cleared too early.
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 400);
      });
      expect(document.body.textContent).toContain("Thinking");
      expect(document.body.textContent).not.toContain("Loading");
      expect(document.body.textContent).not.toContain("Working for");

      syncActiveThread((thread) => ({
        ...thread,
        latestTurn: thread.latestTurn
          ? {
              ...thread.latestTurn,
              startedAt: isoAt(1_301),
            }
          : thread.latestTurn,
        session: thread.session
          ? {
              ...thread.session,
              status: "running",
              activeTurnId: requestedTurnId,
              updatedAt: isoAt(1_301),
            }
          : null,
        updatedAt: isoAt(1_301),
      }));

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("Thinking");
          expect(document.body.textContent).toContain("Working for");
        },
        { timeout: 4_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  // Regression: the sent message must reach its anchored coordinate in one
  // motion and then stay there for the rest of the turn. The failure this guards
  // is the message visibly jumping up and down through send → Thinking →
  // "Working for" → streaming, which is what a fixed-target scroll produces once
  // the coordinate moves under it (reserve sizing, rows above being remeasured).
  it("moves a sent message to its anchor and handles a long streamed response", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    let currentSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-send-jitter" as MessageId,
      targetText: "jitter target",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: currentSnapshot,
    });

    const syncActiveThread = (
      update: (
        thread: OrchestrationReadModel["threads"][number],
      ) => OrchestrationReadModel["threads"][number],
    ) => {
      currentSnapshot = {
        ...currentSnapshot,
        snapshotSequence: currentSnapshot.snapshotSequence + 1,
        threads: currentSnapshot.threads.map((thread) =>
          thread.id === THREAD_ID ? update(thread) : thread,
        ),
        updatedAt: isoAt(currentSnapshot.snapshotSequence + 1_200),
      };
      fixture = { ...fixture, snapshot: currentSnapshot };
      useStore.getState().syncServerReadModel(currentSnapshot);
    };

    try {
      const scrollContainer = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Unable to find message scroll container.",
      );
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();

      const prompt = "measure the anchor motion for this send";
      useComposerDraftStore.getState().setPrompt(THREAD_ID, prompt);
      const sendButton = await waitForSendButton();
      sendButton.click();

      const findSentRow = () => {
        const rows = document.querySelectorAll<HTMLElement>(
          "[data-message-id][data-message-role='user']",
        );
        for (const row of rows) {
          if (row.textContent?.includes(prompt)) return row;
        }
        return null;
      };
      const topGapPx = Number.parseFloat(getComputedStyle(scrollContainer).paddingTop) || 0;

      // Sampled every frame: the regression is a single-frame hop, so polling for
      // the settled state would not see it.
      const samples: Array<{ t: number; offset: number | null; bottom: number }> = [];
      const startedAt = performance.now();
      let sampling = true;
      const sample = () => {
        if (!sampling) return;
        const row = findSentRow();
        samples.push({
          t: performance.now() - startedAt,
          offset: row
            ? row.getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top
            : null,
          bottom:
            scrollContainer.scrollHeight - scrollContainer.clientHeight - scrollContainer.scrollTop,
        });
        window.requestAnimationFrame(sample);
      };
      window.requestAnimationFrame(sample);

      const at = (ms: number, action: () => void) => window.setTimeout(action, ms);
      const activeTurnId = TurnId.makeUnsafe("turn-jitter");
      const streamingId = MessageId.makeUnsafe("msg-assistant-jitter-stream");

      // Server ack: durable user row + running turn (Thinking appears).
      at(140, () => {
        const sentMessageId = findSentRow()?.dataset.messageId;
        if (!sentMessageId) return;
        syncActiveThread((thread) => ({
          ...thread,
          messages: [
            ...thread.messages,
            {
              id: MessageId.makeUnsafe(sentMessageId),
              role: "user" as const,
              text: prompt,
              turnId: activeTurnId,
              streaming: false,
              source: "native" as const,
              createdAt: isoAt(1_300),
              updatedAt: isoAt(1_300),
            },
          ],
          latestTurn: {
            turnId: activeTurnId,
            state: "running" as const,
            requestedAt: isoAt(1_300),
            startedAt: null,
            completedAt: null,
            assistantMessageId: null,
          },
          session: thread.session
            ? {
                ...thread.session,
                status: "running" as const,
                activeTurnId,
                updatedAt: isoAt(1_301),
              }
            : null,
          updatedAt: isoAt(1_301),
        }));
      });
      // Turn actually starts: the "Working for" header replaces Thinking.
      at(420, () => {
        syncActiveThread((thread) => ({
          ...thread,
          latestTurn: thread.latestTurn
            ? { ...thread.latestTurn, startedAt: isoAt(1_310) }
            : thread.latestTurn,
          updatedAt: isoAt(1_310),
        }));
      });
      // Rows above the anchor settle to their real height mid-slide (late image
      // loads, markdown remeasure, estimated virtualized rows mounting). Visible
      // content preservation is off while an anchor is set, so this is exactly
      // what shifts the anchored row under the in-flight slide.
      const earlierMessageId = currentSnapshot.threads
        .find((thread) => thread.id === THREAD_ID)!
        .messages.at(-2)!.id;
      for (const [index, delayMs] of [260, 340, 430].entries()) {
        at(delayMs, () => {
          syncActiveThread((thread) => ({
            ...thread,
            messages: thread.messages.map((message) =>
              message.id === earlierMessageId
                ? {
                    ...message,
                    text: `${message.text}\n\n${"Late-measured earlier content. ".repeat(6 * (index + 1))}`,
                    updatedAt: isoAt(1_250 + index),
                  }
                : message,
            ),
            updatedAt: isoAt(1_250 + index),
          }));
        });
      }
      // Assistant text streams in below the anchor, chunk by chunk. Depending
      // on browser fonts and render scheduling, this may exhaust the reserve.
      for (let chunk = 1; chunk <= 40; chunk += 1) {
        at(560 + chunk * 33, () => {
          syncActiveThread((thread) => ({
            ...thread,
            messages: [
              ...thread.messages.filter((message) => message.id !== streamingId),
              {
                id: streamingId,
                role: "assistant" as const,
                text: "Streaming response paragraph.\n\n".repeat(chunk),
                turnId: activeTurnId,
                streaming: true,
                source: "native" as const,
                createdAt: isoAt(1_320),
                updatedAt: isoAt(1_320 + chunk),
              },
            ],
            updatedAt: isoAt(1_320 + chunk),
          }));
        });
      }

      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 2_200);
      });
      try {
        // Markdown rendering and row measurement can finish after the last
        // scheduled chunk. Keep sampling their motion before the final check.
        await vi.waitFor(
          () => {
            const paragraphs = scrollContainer
              .querySelector(`[data-message-id='${CSS.escape(streamingId)}']`)
              ?.querySelectorAll("p");
            expect(paragraphs?.length).toBe(40);
            expect(paragraphs?.[39]?.textContent).toBe("Streaming response paragraph.");
          },
          { timeout: 10_000, interval: 20 },
        );
        await waitForTranscriptLayoutToSettle(scrollContainer);
      } finally {
        sampling = false;
      }

      const visible = samples.filter(
        (entry): entry is { t: number; offset: number; bottom: number } => entry.offset !== null,
      );
      const firstArrivalIndex = visible.findIndex(
        (entry) => Math.abs(entry.offset - topGapPx) <= 2,
      );
      const settled = firstArrivalIndex >= 0 ? visible.slice(firstArrivalIndex) : [];
      // Once the response is taller than the remaining viewport, the list
      // intentionally hands off from the pinned send to following the live
      // tail. Validate the rigid hold before that hand-off separately from the
      // upward motion afterward. A separate small-viewport browser test always
      // forces overflow and requires the hand-off.
      const handoffIndex = settled.findIndex((entry) => entry.offset < topGapPx - 4);
      const held = handoffIndex < 0 ? settled : settled.slice(0, handoffIndex);
      let reversals = 0;
      let travelAfterArrivalPx = 0;
      let maxDownwardJumpPx = 0;
      let previousDirection = 0;
      for (let index = 1; index < settled.length; index += 1) {
        const delta = settled[index]!.offset - settled[index - 1]!.offset;
        maxDownwardJumpPx = Math.max(maxDownwardJumpPx, delta);
        if (Math.abs(delta) <= 0.5) continue;
        const direction = Math.sign(delta);
        if (previousDirection !== 0 && direction !== previousDirection) reversals += 1;
        previousDirection = direction;
      }
      for (let index = 1; index < held.length; index += 1) {
        travelAfterArrivalPx += Math.abs(held[index]!.offset - held[index - 1]!.offset);
      }
      const maxDriftAfterArrivalPx = held.reduce(
        (worst, entry) => Math.max(worst, Math.abs(entry.offset - topGapPx)),
        0,
      );
      // The approach itself must not bounce: every observed frame moves the
      // message toward the anchor, never back down and up again. The easing
      // curve is covered deterministically in transcriptScroll.test.ts;
      // browser frame sampling cannot prove the intermediate path because a
      // loaded runner may present no frames between the first move and arrival.
      const approach = firstArrivalIndex >= 0 ? visible.slice(0, firstArrivalIndex + 1) : visible;
      let approachReversals = 0;
      let approachDirection = 0;
      for (let index = 1; index < approach.length; index += 1) {
        const delta = approach[index]!.offset - approach[index - 1]!.offset;
        // Chromium can report a one-pixel layout/compositor rounding shift before
        // the anchor animation starts. Match the arrival tolerance so that noise
        // does not count as an extra change of direction.
        if (Math.abs(delta) <= 2) continue;
        const direction = Math.sign(delta);
        if (approachDirection !== 0 && direction !== approachDirection) approachReversals += 1;
        approachDirection = direction;
      }
      const trace = () =>
        visible
          .map(
            (entry) =>
              `${Math.round(entry.t)}:${Math.round(entry.offset)}:${Math.round(entry.bottom)}`,
          )
          .join(" ");
      expect(
        firstArrivalIndex,
        `sent message never reached its anchor: ${trace()}`,
      ).toBeGreaterThan(-1);
      expect(
        visible[firstArrivalIndex]!.t - (visible[0]?.t ?? 0),
        `anchor took too long to land: ${trace()}`,
      ).toBeLessThan(900);
      expect(approachReversals, `anchor bounced on its way up: ${trace()}`).toBeLessThanOrEqual(1);
      expect(reversals, `anchor moved back and forth after landing: ${trace()}`).toBe(0);
      expect(maxDownwardJumpPx, `anchor slid back down after landing: ${trace()}`).toBeLessThan(2);
      expect(travelAfterArrivalPx, `anchor kept moving after landing: ${trace()}`).toBeLessThan(8);
      expect(maxDriftAfterArrivalPx, `anchor drifted off its coordinate: ${trace()}`).toBeLessThan(
        4,
      );
      if (handoffIndex >= 0) {
        expect(
          settled[handoffIndex]!.t,
          `anchor released before the short response filled the reserve: ${trace()}`,
        ).toBeGreaterThan(1_000);
        expect(
          settled.at(-1)!.bottom,
          `transcript did not follow the overflowing response: ${trace()}`,
        ).toBeLessThan(8);
      }
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it.each([
    "wheel near end",
    "manual return",
    "arrow",
    "send",
    "wheel down",
    "wheel without movement",
    "nested wheel",
    "nested key",
    "layout leave",
    "keyboard ArrowUp",
    "find",
    "pointer click",
    "thread switch",
    "short transcript",
  ] as const)("restores streaming follow after %s in the full ChatView", async (action) => {
    const keyboardKey = action.startsWith("keyboard ") ? action.slice("keyboard ".length) : null;
    const restoreNativeApi = installDeterministicSendNativeApi();
    let snapshot = addThreadToSnapshot(createSnapshotWithLongAssistantResponse(), OTHER_THREAD_ID);
    if (action === "short transcript") {
      snapshot = {
        ...snapshot,
        threads: snapshot.threads.map((thread) =>
          thread.id === THREAD_ID ? { ...thread, messages: thread.messages.slice(0, 1) } : thread,
        ),
      };
    }
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    const messageId = MessageId.makeUnsafe("follow-live-response");
    const turnId = TurnId.makeUnsafe("follow-live-turn");
    const syncThread = (
      update: (
        thread: OrchestrationReadModel["threads"][number],
      ) => OrchestrationReadModel["threads"][number],
    ) => {
      snapshot = {
        ...snapshot,
        snapshotSequence: snapshot.snapshotSequence + 1,
        threads: snapshot.threads.map((thread) =>
          thread.id === THREAD_ID ? update(thread) : thread,
        ),
      };
      fixture = { ...fixture, snapshot };
      useStore.getState().syncServerReadModel(snapshot);
    };
    const grow = () =>
      syncThread((thread) => ({
        ...thread,
        messages: thread.messages.map((message) =>
          message.id === messageId
            ? { ...message, text: `${message.text}\n\n${"More streaming output. ".repeat(35)}` }
            : message,
        ),
      }));
    try {
      let container = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Transcript did not mount.",
      );
      await vi.waitFor(() =>
        expect(getScrollContainerDistanceFromBottom(container)).toBeLessThanOrEqual(4),
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 350));
      if (action === "send") {
        useComposerDraftStore
          .getState()
          .setPrompt(THREAD_ID, "Continue with a long streamed response");
        (await waitForSendButton()).click();
        const sent = await waitForElement(
          () =>
            Array.from(document.querySelectorAll<HTMLElement>("[data-message-role='user']")).find(
              (row) => row.textContent?.includes("Continue with a long streamed response"),
            ) ?? null,
          "Optimistic message did not appear.",
        );
        const sentId = MessageId.makeUnsafe(sent.dataset.messageId!);
        syncThread((thread) => ({
          ...thread,
          messages: [
            ...thread.messages,
            {
              id: sentId,
              role: "user",
              source: "native",
              turnId: null,
              text: "Continue with a long streamed response",
              createdAt: isoAt(1_200),
              updatedAt: isoAt(1_200),
              streaming: false,
            },
          ],
        }));
        // The slide emits real scroll events while the provider is starting.
        await new Promise<void>((resolve) => setTimeout(resolve, 700));
      }
      syncThread((thread) => ({
        ...thread,
        session: thread.session
          ? { ...thread.session, status: "running", activeTurnId: turnId }
          : null,
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: isoAt(1_200),
          startedAt: isoAt(1_201),
          completedAt: null,
          assistantMessageId: messageId,
        },
        messages: [
          ...thread.messages,
          {
            id: messageId,
            role: "assistant",
            source: "native",
            text: "The response begins.",
            turnId,
            streaming: true,
            createdAt: isoAt(1_202),
            updatedAt: isoAt(1_202),
          },
        ],
      }));
      if (action === "short transcript") {
        await waitForLayout();
        expect(container.scrollHeight).toBeLessThanOrEqual(container.clientHeight + 1);
        await userEvent.wheel(container, { delta: { y: -100 } });
      }
      for (let index = 0; index < 12; index += 1) {
        grow();
        await waitForLayout();
      }
      // The prepared response still reveals text gradually after delivery.
      // Finish rendering and measuring it before giving the reader control.
      await vi.waitFor(
        () => {
          const paragraphs = container
            .querySelector(`[data-message-id='${CSS.escape(messageId)}']`)
            ?.querySelectorAll("p");
          expect(paragraphs?.length).toBe(13);
          expect(paragraphs?.[12]?.textContent).toBe("More streaming output. ".repeat(35).trim());
        },
        { timeout: 10_000, interval: 20 },
      );
      await waitForTranscriptLayoutToSettle(container);
      await vi.waitFor(() =>
        expect(getScrollContainerDistanceFromBottom(container)).toBeLessThanOrEqual(4),
      );

      if (action === "wheel down") {
        await userEvent.wheel(container, { delta: { y: 100 } });
      } else if (action === "layout leave") {
        const height = container.clientHeight;
        container.style.maxHeight = `${height - 180}px`;
        await vi.waitFor(() => expect(container.clientHeight).toBeLessThan(height));
        await waitForLayout();
        await userEvent.wheel(container, { delta: { y: 100 } });
      } else if (action === "wheel without movement") {
        container.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -0.1 }));
        grow();
        container.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -0.1 }));
        await waitForLayout();
      } else if (action === "nested wheel" || action === "nested key") {
        if (action === "nested key") {
          // The first native input activates the test iframe and replays pending
          // composer focus. Settle that activation before testing a nested key.
          await page.getByTestId("composer-editor").click();
          await waitForLayout();
        }
        const nested = document.createElement("div");
        const bounds = container.getBoundingClientRect();
        nested.style.cssText = `position: fixed; left: ${bounds.left + 20}px; top: ${bounds.top + 20}px; width: 180px; height: 96px; overflow: auto; overscroll-behavior: contain; z-index: 100;`;
        nested.textContent = "Nested scrollable content. ".repeat(100);
        container.append(nested);
        try {
          nested.scrollTop = 100;
          if (action === "nested key") {
            nested.tabIndex = 0;
            // Focus through native input so Chromium directs keyboard scrolling
            // to this nested viewport as it would after a reader clicks it.
            await userEvent.click(nested);
            expect(document.activeElement).toBe(nested);
            let keyTarget: EventTarget | null = null;
            const captureKeyTarget = (event: KeyboardEvent) => {
              if (event.key === "ArrowUp") keyTarget = event.target;
            };
            nested.addEventListener("keydown", captureKeyTarget);
            try {
              await userEvent.keyboard("{ArrowUp}");
            } finally {
              nested.removeEventListener("keydown", captureKeyTarget);
            }
            expect(keyTarget).toBe(nested);
          } else {
            await userEvent.wheel(nested, { delta: { y: -30 } });
          }
          await vi.waitFor(() => expect(nested.scrollTop).toBeLessThan(100));
          await waitForLayout();
          await vi.waitFor(() =>
            expect(getScrollContainerDistanceFromBottom(container)).toBeLessThanOrEqual(4),
          );
        } finally {
          nested.remove();
        }
      } else if (action === "pointer click") {
        container.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        container.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      } else if (action !== "send" && action !== "short transcript") {
        if (keyboardKey !== null) {
          container.tabIndex = 0;
          container.focus();
          expect(document.activeElement).toBe(container);
          // Streaming can advance while the browser input command is in transit.
          // Compare against the offset at keydown, when the gesture takes ownership.
          let initialTop: number | null = null;
          const captureInitialTop = (event: KeyboardEvent) => {
            if (event.key === keyboardKey) initialTop = container.scrollTop;
          };
          container.addEventListener("keydown", captureInitialTop, { capture: true });
          try {
            await userEvent.keyboard(`{${keyboardKey}}`);
          } finally {
            container.removeEventListener("keydown", captureInitialTop, { capture: true });
          }
          expect(initialTop).not.toBeNull();
          await vi.waitFor(() => expect(container.scrollTop).toBeLessThan(initialTop! - 1));
        } else if (action === "find") {
          await dispatchConfiguredShortcutWhenReady(window, { key: "f" });
          await page.getByLabelText("Find in thread").fill("assistant filler 0");
          await vi.waitFor(() => {
            const match = document.querySelector<HTMLElement>('[data-chat-find-match="active"]');
            expect(match).not.toBeNull();
            const bounds = match!.getBoundingClientRect();
            const viewport = container.getBoundingClientRect();
            expect(bounds.top).toBeGreaterThanOrEqual(viewport.top);
            expect(bounds.bottom).toBeLessThanOrEqual(viewport.bottom);
          });
          await new Promise<void>((resolve) => setTimeout(resolve, 350));
        } else {
          await userEvent.wheel(container, {
            delta: { y: action === "wheel near end" ? -12 : -350 },
          });
        }
        await vi.waitFor(() =>
          expect(getScrollContainerDistanceFromBottom(container)).toBeGreaterThanOrEqual(10),
        );
        await waitForLayout();
        // Native wheel and key scrolling may continue after the input command
        // resolves. Record the reader position only once the viewport is quiet.
        await waitForTranscriptLayoutToSettle(container);
        const viewport = container.getBoundingClientRect();
        const readingAnchor = Array.from(
          container.querySelectorAll<HTMLElement>("[data-message-id] p, [data-message-id] li"),
        ).find((paragraph) => {
          const bounds = paragraph.getBoundingClientRect();
          return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
        });
        expect(readingAnchor, "Visible text must anchor the reader position").toBeDefined();
        const anchorMessage = readingAnchor!.closest<HTMLElement>("[data-message-id]")!;
        const anchorIndex = Array.from(anchorMessage.querySelectorAll("p, li")).indexOf(
          readingAnchor!,
        );
        const anchorSelector = `[data-message-id='${CSS.escape(anchorMessage.dataset.messageId!)}']`;
        const readAnchorTop = () =>
          container
            .querySelector(anchorSelector)!
            .querySelectorAll("p, li")
            [anchorIndex]!.getBoundingClientRect().top;
        const detachedTop = readAnchorTop();
        for (let index = 0; index < 3; index += 1) {
          grow();
          await waitForLayout();
        }
        if (keyboardKey !== null || action === "find") {
          syncThread((thread) => ({
            ...thread,
            messages: [
              ...thread.messages,
              {
                id: MessageId.makeUnsafe("remote-follow-message"),
                role: "user",
                source: "native",
                turnId: null,
                text: "Another message arrived while reading earlier output.",
                streaming: false,
                createdAt: isoAt(1_203),
                updatedAt: isoAt(1_203),
              },
            ],
          }));
          await waitForLayout();
        }
        // The list may compensate scrollTop as estimated rows settle. The text
        // the reader is looking at must remain at the same viewport position.
        expect(readAnchorTop()).toBeCloseTo(detachedTop, 0);
        if (action === "thread switch") {
          await mounted.router.navigate({
            to: "/$threadId",
            params: { threadId: OTHER_THREAD_ID },
          });
          // Router navigation can finish before React commits the new transcript.
          // Wait for the old list to unmount so the return cannot race that commit.
          await vi.waitFor(() => expect(container.isConnected).toBe(false));
          await mounted.router.navigate({ to: "/$threadId", params: { threadId: THREAD_ID } });
          container = await waitForElement(() => {
            const next = document.querySelector<HTMLElement>("[data-chat-scroll-container='true']");
            return next?.querySelector(`[data-message-id='${messageId}']`) ? next : null;
          }, "Streaming transcript did not remount.");
          await waitForLayout();
        } else if (action === "arrow" || keyboardKey !== null || action === "find") {
          const arrow = await waitForElement(
            () =>
              document.querySelector<HTMLButtonElement>(
                "button[aria-label='Scroll to bottom'][aria-hidden='false']",
              ),
            "Scroll-to-bottom arrow did not appear.",
          );
          arrow.click();
        } else {
          container.scrollTop = container.scrollHeight;
          container.dispatchEvent(new Event("scroll"));
        }
        await vi.waitFor(
          () =>
            expect(getScrollContainerDistanceFromBottom(container)).toBeLessThanOrEqual(
              action === "thread switch" ? AUTO_SCROLL_BOTTOM_THRESHOLD_PX : 4,
            ),
          { timeout: 3_000 },
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
      }
      for (let index = 0; index < 8; index += 1) {
        grow();
        await waitForLayout();
      }
      await vi.waitFor(() =>
        expect(getScrollContainerDistanceFromBottom(container)).toBeLessThanOrEqual(4),
      );
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("follows the final text batch when the assistant turn settles", async () => {
    let snapshot = createSnapshotWithLongAssistantResponse();
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    const messageId = MessageId.makeUnsafe("msg-final-text-batch");
    const turnId = TurnId.makeUnsafe("turn-final-text-batch");
    const syncReply = (text: string, streaming: boolean) => {
      snapshot = {
        ...snapshot,
        snapshotSequence: snapshot.snapshotSequence + 1,
        threads: snapshot.threads.map((thread) =>
          thread.id !== THREAD_ID
            ? thread
            : {
                ...thread,
                session: thread.session
                  ? {
                      ...thread.session,
                      status: streaming ? "running" : "ready",
                      activeTurnId: streaming ? turnId : null,
                    }
                  : null,
                latestTurn: {
                  turnId,
                  state: streaming ? "running" : "completed",
                  requestedAt: isoAt(1_200),
                  startedAt: isoAt(1_201),
                  completedAt: streaming ? null : isoAt(1_204),
                  assistantMessageId: messageId,
                },
                messages: [
                  ...thread.messages.filter((message) => message.id !== messageId),
                  {
                    id: messageId,
                    role: "assistant",
                    source: "native",
                    text,
                    turnId,
                    streaming,
                    createdAt: isoAt(1_202),
                    updatedAt: isoAt(1_203),
                    ...(streaming ? {} : { completedAt: isoAt(1_204) }),
                  },
                ],
              },
        ),
      };
      fixture = { ...fixture, snapshot };
      useStore.getState().syncServerReadModel(snapshot);
    };
    try {
      const container = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Transcript did not mount.",
      );
      await vi.waitFor(() =>
        expect(getScrollContainerDistanceFromBottom(container)).toBeLessThanOrEqual(4),
      );
      syncReply("The reply starts.", true);
      await vi.waitFor(() => expect(container.textContent).toContain("The reply starts."));
      await waitForTranscriptLayoutToSettle(container);
      expect(getScrollContainerDistanceFromBottom(container)).toBeLessThanOrEqual(4);
      syncReply(
        `${Array.from(
          { length: 40 },
          (_, index) => `Paragraph ${index}. ${"Delivered assistant output. ".repeat(8)}`,
        ).join("\n\n")}\n\nEnd of reply.`,
        false,
      );
      await vi.waitFor(() => expect(container.textContent).toContain("End of reply."));
      await waitForTranscriptLayoutToSettle(container);
      await vi.waitFor(() =>
        expect(getScrollContainerDistanceFromBottom(container)).toBeLessThanOrEqual(4),
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps following work after assistant text finishes streaming", async () => {
    let snapshot = createSnapshotWithInlineToolOverflow({ active: true });
    const messageId = MessageId.makeUnsafe("msg-assistant-inline-tools");
    const turnId = TurnId.makeUnsafe("turn-inline-tools");
    snapshot = {
      ...snapshot,
      threads: snapshot.threads.map((thread) => ({
        ...thread,
        messages: thread.messages.map((message) =>
          message.id === messageId
            ? { ...message, text: "I will check the transcript layout.", streaming: true }
            : message,
        ),
      })),
    };
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    const syncThread = (
      update: (
        thread: OrchestrationReadModel["threads"][number],
      ) => OrchestrationReadModel["threads"][number],
    ) => {
      snapshot = {
        ...snapshot,
        snapshotSequence: snapshot.snapshotSequence + 1,
        threads: snapshot.threads.map((thread) =>
          thread.id === THREAD_ID ? update(thread) : thread,
        ),
      };
      fixture = { ...fixture, snapshot };
      useStore.getState().syncServerReadModel(snapshot);
    };
    const appendWork = (index: number) =>
      syncThread((thread) => ({
        ...thread,
        activities: [
          ...thread.activities,
          {
            id: EventId.makeUnsafe(`activity-after-commentary-${index}`),
            createdAt: isoAt(1_110 + index),
            kind: "tool.started",
            summary: `Checking transcript layout ${index}`,
            tone: "tool",
            turnId,
            payload: {
              itemType: "command_execution",
              status: "inProgress",
              title: "Run transcript checks",
              detail: `bun run test transcript-layout-${index}`,
            },
          },
        ],
      }));
    try {
      const container = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Transcript did not mount.",
      );
      await vi.waitFor(() =>
        expect(getScrollContainerDistanceFromBottom(container)).toBeLessThanOrEqual(4),
      );
      syncThread((thread) => ({
        ...thread,
        messages: thread.messages.map((message) =>
          message.id === messageId
            ? { ...message, streaming: false, completedAt: isoAt(1_110) }
            : message,
        ),
      }));
      await waitForTranscriptLayoutToSettle(container);
      expect(getScrollContainerDistanceFromBottom(container)).toBeLessThanOrEqual(4);
      const beforeWorkHeight = container.scrollHeight;
      for (let index = 0; index < 4; index += 1) {
        appendWork(index);
        await waitForLayout();
      }
      await waitForTranscriptLayoutToSettle(container);
      expect(container.scrollHeight).toBeGreaterThan(beforeWorkHeight + 20);
      expect(getScrollContainerDistanceFromBottom(container)).toBeLessThanOrEqual(4);

      // Reading earlier output releases follow even between text messages.
      await userEvent.wheel(container, { delta: { y: -350 } });
      await vi.waitFor(() =>
        expect(getScrollContainerDistanceFromBottom(container)).toBeGreaterThan(100),
      );
      await waitForTranscriptLayoutToSettle(container);
      const readerTop = container.scrollTop;
      appendWork(4);
      syncThread((thread) => ({
        ...thread,
        messages: [
          ...thread.messages,
          {
            id: MessageId.makeUnsafe("msg-after-commentary-work"),
            role: "assistant",
            source: "native",
            text: "The layout checks have completed.",
            turnId,
            streaming: false,
            createdAt: isoAt(1_120),
            updatedAt: isoAt(1_120),
            completedAt: isoAt(1_120),
          },
        ],
      }));
      await waitForTranscriptLayoutToSettle(container);
      expect(container.scrollTop).toBeCloseTo(readerTop, 0);
      expect(getScrollContainerDistanceFromBottom(container)).toBeGreaterThan(100);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the previous turn folded while a follow-up send awaits its new turn", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithInlineToolOverflow({ active: false }),
    });
    let releaseSend!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const restoreApi = installDeterministicSendNativeApi({ beforeTurnStart: () => barrier });
    try {
      const findDisclosure = () =>
        Array.from(document.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")).find(
          (button) => button.textContent?.includes("Worked for"),
        );
      await vi.waitFor(() => expect(findDisclosure()?.getAttribute("aria-expanded")).toBe("false"));
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "Thanks");
      (await waitForSendButton()).click();
      await vi.waitFor(() => expect(hasDispatchedCommandType("thread.turn.start")).toBe(true));
      // Inspect the whole pending-send window: an unfold followed by a fold
      // changes transcript height even if the final settled state looks right.
      for (let frame = 0; frame < 20; frame += 1) {
        await nextFrame();
        expect(findDisclosure()?.getAttribute("aria-expanded")).toBe("false");
        expect(document.querySelector("[data-settled-turn-collapse-transition='true']")).toBeNull();
        expect(document.body.textContent).not.toContain("Used 6 tools");
      }
    } finally {
      releaseSend();
      restoreApi();
      await mounted.cleanup();
    }
  });

  it("does not rearm detached reading for non-message activity", async () => {
    let currentSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-auto-follow-wiring" as MessageId,
      targetText: "auto-follow wiring target",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: currentSnapshot,
    });
    let restoreScrollTo = () => {};

    const syncActiveThread = (
      update: (
        thread: OrchestrationReadModel["threads"][number],
      ) => OrchestrationReadModel["threads"][number],
    ) => {
      currentSnapshot = {
        ...currentSnapshot,
        snapshotSequence: currentSnapshot.snapshotSequence + 1,
        threads: currentSnapshot.threads.map((thread) =>
          thread.id === THREAD_ID ? update(thread) : thread,
        ),
        updatedAt: isoAt(currentSnapshot.snapshotSequence + 1_200),
      };
      fixture = { ...fixture, snapshot: currentSnapshot };
      useStore.getState().syncServerReadModel(currentSnapshot);
    };

    try {
      const scrollContainer = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Unable to find message scroll container.",
      );
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();

      const scrollSpy = installImmediateScrollToSpy(scrollContainer);
      restoreScrollTo = scrollSpy.restore;
      // The virtual list's bootstrap initial-scroll session can stay armed
      // past mount — or re-arm on the next layout change after an abort — and
      // dispatches a one-shot correction scroll once its reveal settles. Drive
      // one real transition, then stay quiet so its rAF-driven passes settle
      // without the resolved offset moving; repeat once in case the first
      // session aborted silently and only re-arms on this change. The
      // dispatch is captured by the spy and cleared instead of landing inside
      // the assertions below.
      for (const warmStatus of ["starting", "ready"] as const) {
        syncActiveThread((thread) => ({
          ...thread,
          session: thread.session ? { ...thread.session, status: warmStatus } : null,
        }));
        await waitForLayout();
        // Quiet window: also covers mount-time tail/image expansion retries
        // (scheduled at up to 260ms, possibly late under load).
        for (let attempt = 0; attempt < 8; attempt += 1) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 300));
          await waitForLayout();
          if (scrollSpy.calls.length === 0) {
            break;
          }
          scrollSpy.calls.length = 0;
        }
      }
      scrollSpy.calls.length = 0;

      await userEvent.wheel(scrollContainer, { delta: { y: -350 } });
      await vi.waitFor(() =>
        expect(getScrollContainerDistanceFromBottom(scrollContainer)).toBeGreaterThan(100),
      );
      await waitForTranscriptLayoutToSettle(scrollContainer);
      scrollSpy.calls.length = 0;

      // Buffering/connecting changes turn chrome but must not reclaim the
      // viewport from someone reading earlier messages.
      syncActiveThread((thread) => ({
        ...thread,
        session: thread.session
          ? {
              ...thread.session,
              status: "starting",
              updatedAt: isoAt(1_201),
            }
          : null,
        updatedAt: isoAt(1_201),
      }));
      await waitForLayout();
      expect(scrollSpy.calls).toHaveLength(0);

      for (const status of ["error", "starting", "ready"] as const) {
        syncActiveThread((thread) => ({
          ...thread,
          session: thread.session
            ? {
                ...thread.session,
                status,
                lastError: status === "error" ? "Provider connection failed" : null,
              }
            : null,
        }));
        await waitForLayout();
        expect(scrollSpy.calls).toHaveLength(0);
      }

      const activeTurnId = TurnId.makeUnsafe("turn-auto-follow-wiring");
      syncActiveThread((thread) => ({
        ...thread,
        latestTurn: {
          turnId: activeTurnId,
          state: "running",
          requestedAt: isoAt(1_202),
          startedAt: isoAt(1_203),
          completedAt: null,
          assistantMessageId: null,
        },
        session: thread.session
          ? {
              ...thread.session,
              status: "running",
              activeTurnId,
              updatedAt: isoAt(1_204),
            }
          : null,
        activities: [
          ...thread.activities,
          {
            id: EventId.makeUnsafe("activity-auto-follow-approval"),
            createdAt: isoAt(1_204),
            kind: "approval.requested",
            summary: "Command approval requested",
            tone: "approval",
            turnId: activeTurnId,
            payload: {
              requestId: "request-auto-follow",
              requestKind: "command",
              detail: "inspect the unchanged transcript tail",
            },
          },
        ],
        updatedAt: isoAt(1_204),
      }));
      await waitForLayout();
      expect(scrollSpy.calls).toHaveLength(0);

      syncActiveThread((thread) => ({
        ...thread,
        activities: [
          ...thread.activities,
          {
            id: EventId.makeUnsafe("activity-auto-follow-tool"),
            createdAt: isoAt(1_205),
            kind: "tool.completed",
            summary: "scroll-only tool activity",
            tone: "tool",
            turnId: activeTurnId,
            payload: {
              itemType: "dynamic_tool_call",
              toolName: "inspect-scroll-tail",
            },
          },
        ],
        updatedAt: isoAt(1_205),
      }));
      await waitForLayout();
      expect(scrollSpy.calls).toHaveLength(0);

      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      scrollContainer.dispatchEvent(new Event("scroll"));
      scrollSpy.calls.length = 0;
      const liveAssistantMessage = {
        ...createAssistantMessage({
          id: MessageId.makeUnsafe("msg-assistant-auto-follow-live"),
          text: "A real live assistant tail",
          offsetSeconds: 1_206,
        }),
        turnId: activeTurnId,
        streaming: true,
      };
      syncActiveThread((thread) => ({
        ...thread,
        messages: [...thread.messages, liveAssistantMessage],
        updatedAt: isoAt(1_206),
      }));
      await vi.waitFor(() => expect(scrollSpy.calls.length).toBeGreaterThan(0), {
        timeout: 4_000,
        interval: 16,
      });

      scrollSpy.calls.length = 0;
      syncActiveThread((thread) => ({
        ...thread,
        messages: thread.messages.map((message) =>
          message.id === liveAssistantMessage.id
            ? {
                ...message,
                text: `${message.text}\n\nA second streamed chunk that grows the live response.`,
                updatedAt: isoAt(1_207),
              }
            : message,
        ),
        updatedAt: isoAt(1_207),
      }));
      await vi.waitFor(() => expect(scrollSpy.calls.length).toBeGreaterThan(0), {
        timeout: 4_000,
        interval: 16,
      });

      scrollSpy.calls.length = 0;
      syncActiveThread((thread) => ({
        ...thread,
        messages: thread.messages.map((message) =>
          message.id === liveAssistantMessage.id
            ? {
                ...message,
                streaming: false,
                completedAt: isoAt(1_208),
                updatedAt: isoAt(1_208),
              }
            : message,
        ),
        updatedAt: isoAt(1_208),
      }));
      await vi.waitFor(() => expect(scrollSpy.calls.length).toBeGreaterThan(0), {
        timeout: 4_000,
        interval: 16,
      });
    } finally {
      restoreScrollTo();
      await mounted.cleanup();
    }
  });

  it("creates composer automations as heartbeat runs on the current chat", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-current-chat-automation" as MessageId,
        targetText: "current chat automation target",
      }),
    });

    try {
      useComposerDraftStore
        .getState()
        .setPrompt(THREAD_ID, "/automation say hi every 15 seconds 3 times total");
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(
        () => {
          expect(composerEditor.textContent ?? "").toContain("say hi every 15 seconds");
        },
        { timeout: 8_000, interval: 16 },
      );

      wsRequests.length = 0;
      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          const automationCreateRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.automationCreate,
          );
          expect(automationCreateRequest).toMatchObject({
            _tag: WS_METHODS.automationCreate,
            mode: "heartbeat",
            targetThreadId: THREAD_ID,
            sourceThreadId: THREAD_ID,
            worktreeMode: "auto",
            maxIterations: 3,
            prompt: "say hi",
            schedule: { type: "interval", everySeconds: 15 },
          });
        },
        { timeout: 8_000, interval: 16 },
      );
      await waitForLayout();

      expect(hasDispatchedCommandType("thread.create")).toBe(false);
      expect(hasDispatchedCommandType("thread.turn.start")).toBe(false);
      expect(wsRequests.some((request) => request._tag === WS_METHODS.gitCreateWorktree)).toBe(
        false,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("promotes draft chats before creating composer heartbeat automations", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          entryPoint: "chat",
          branch: "feature/draft-automation",
          worktreePath: "/repo/worktrees/draft-automation",
          envMode: "worktree",
        },
      },
      projectDraftThreadIdByProjectId: {
        [PROJECT_ID]: THREAD_ID,
      },
    });
    useComposerDraftStore.getState().setModelSelection(THREAD_ID, {
      provider: "codex",
      model: "gpt-5.4",
      options: {
        reasoningEffort: "low",
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
    });

    try {
      useComposerDraftStore
        .getState()
        .setPrompt(THREAD_ID, "/automation say hi every 15 seconds for 3 times");
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(
        () => {
          expect(composerEditor.textContent ?? "").toContain("say hi every 15 seconds");
        },
        { timeout: 8_000, interval: 16 },
      );

      wsRequests.length = 0;
      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      await sendButton.click();

      await vi.waitFor(
        () => {
          const createThreadIndex = wsRequests.findIndex((request) => {
            const command = readDispatchedCommand(request);
            return command?.type === "thread.create" && command.threadId === THREAD_ID;
          });
          const automationCreateIndex = wsRequests.findIndex(
            (request) => request._tag === WS_METHODS.automationCreate,
          );
          expect(createThreadIndex).toBeGreaterThanOrEqual(0);
          expect(automationCreateIndex).toBeGreaterThan(createThreadIndex);

          const createThreadCommand = readDispatchedCommand(wsRequests[createThreadIndex]!);
          expect(createThreadCommand).toMatchObject({
            type: "thread.create",
            threadId: THREAD_ID,
            createdAt: expect.any(String),
            envMode: "worktree",
            branch: "feature/draft-automation",
            worktreePath: "/repo/worktrees/draft-automation",
            associatedWorktreePath: "/repo/worktrees/draft-automation",
            associatedWorktreeBranch: "feature/draft-automation",
            associatedWorktreeRef: "feature/draft-automation",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.4",
              options: {
                reasoningEffort: "low",
              },
            },
            runtimeMode: "full-access",
            interactionMode: "default",
          });
          expect(createThreadCommand?.createdAt).not.toBe(NOW_ISO);

          expect(wsRequests[automationCreateIndex]).toMatchObject({
            _tag: WS_METHODS.automationCreate,
            mode: "heartbeat",
            targetThreadId: THREAD_ID,
            sourceThreadId: THREAD_ID,
            worktreeMode: "auto",
            maxIterations: 3,
            prompt: "say hi",
            schedule: { type: "interval", everySeconds: 15 },
          });
        },
        { timeout: 8_000, interval: 16 },
      );
      await waitForLayout();

      expect(hasDispatchedCommandType("thread.turn.start")).toBe(false);
      expect(wsRequests.some((request) => request._tag === WS_METHODS.gitCreateWorktree)).toBe(
        false,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not promote draft chats until a reviewed automation is submitted", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          entryPoint: "chat",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      projectDraftThreadIdByProjectId: {
        [PROJECT_ID]: THREAD_ID,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "/automation say hi every 15 seconds");
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(
        () => {
          expect(composerEditor.textContent ?? "").toContain("say hi every 15 seconds");
        },
        { timeout: 8_000, interval: 16 },
      );

      wsRequests.length = 0;
      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      await sendButton.click();

      await expect.element(page.getByText("Fast recurring loop")).toBeInTheDocument();
      expect(hasDispatchedCommandType("thread.create")).toBe(false);
      expect(wsRequests.some((request) => request._tag === WS_METHODS.automationCreate)).toBe(
        false,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it.each(ATTACHMENT_VIEWPORT_MATRIX)(
    "[geometry:linux] keeps user attachments inside their rendered row at the $name viewport",
    async (viewport) => {
      const targetMessageId = `msg-user-target-attachments-${viewport.name}` as MessageId;
      const userText = "message with image attachments";
      const mounted = await mountChatView({
        viewport,
        snapshot: createSnapshotForTargetUser({
          targetMessageId,
          targetText: userText,
          targetAttachmentCount: 3,
        }),
      });

      try {
        await mounted.measureUserRow(targetMessageId);
        const row = document.querySelector<HTMLElement>(
          `[data-message-id="${targetMessageId}"][data-message-role="user"]`,
        )!;
        const rowRect = row.getBoundingClientRect();
        const thumbnails = Array.from(
          row.querySelectorAll<HTMLButtonElement>('button[aria-label^="Preview "]'),
        );
        expect(thumbnails).toHaveLength(3);
        const rects = thumbnails.map((thumbnail) => thumbnail.getBoundingClientRect());
        for (const rect of rects) {
          expect(rect.width).toBeGreaterThan(0);
          expect(rect.height).toBeGreaterThan(0);
          expect(rect.left).toBeGreaterThanOrEqual(rowRect.left - 1);
          expect(rect.right).toBeLessThanOrEqual(rowRect.right + 1);
          expect(rect.top).toBeGreaterThanOrEqual(rowRect.top - 1);
          expect(rect.bottom).toBeLessThanOrEqual(rowRect.bottom + 1);
        }
        expect(
          Math.max(...rects.map((rect) => rect.top)) - Math.min(...rects.map((rect) => rect.top)),
        ).toBeLessThanOrEqual(1);
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("opens the project cwd for draft threads without a worktree path", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          entryPoint: "chat",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      projectDraftThreadIdByProjectId: {
        [PROJECT_ID]: THREAD_ID,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode"],
        };
      },
    });

    try {
      const openInVsCodeTrigger = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
            (button) => button.textContent?.trim() === "Open in VS Code",
          ) ?? null,
        "Unable to find Open in VS Code environment row.",
      );
      openInVsCodeTrigger.click();

      const vscodeOption = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="menu-radio-item"]')).find(
            (item) => item.textContent?.trim() === "VS Code",
          ) ?? null,
        "Unable to find VS Code editor option.",
      );
      vscodeOption.click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "vscode",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("resets branch selector state when switching threads", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: addThreadToSnapshot(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-branch-selector-switch" as MessageId,
          targetText: "branch selector switch",
        }),
        OTHER_THREAD_ID,
      ),
    });

    try {
      const branchTrigger = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[data-slot="combobox-trigger"]'),
        "Unable to find branch selector trigger.",
      );
      await vi.waitFor(() => expect(branchTrigger.disabled).toBe(false), {
        timeout: 8_000,
        interval: 16,
      });
      branchTrigger.click();

      const branchSearch = await waitForElement(
        () => document.querySelector<HTMLInputElement>('input[placeholder="Search branches..."]'),
        "Unable to find branch selector search input.",
      );
      await page.getByPlaceholder("Search branches...").fill("stale-query");
      expect(branchSearch.value).toBe("stale-query");

      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: OTHER_THREAD_ID },
      });
      await waitForURL(
        mounted.router,
        (pathname) => pathname === `/${OTHER_THREAD_ID}`,
        "Thread route did not switch.",
      );
      await waitForLayout();

      await vi.waitFor(
        () => {
          expect(
            document.querySelector('input[placeholder="Search branches..."]'),
            "Branch selector state remained open after switching threads.",
          ).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );

      const nextBranchTrigger = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[data-slot="combobox-trigger"]'),
        "Unable to find branch selector after switching threads.",
      );
      nextBranchTrigger.click();
      const resetSearch = await waitForElement(
        () => document.querySelector<HTMLInputElement>('input[placeholder="Search branches..."]'),
        "Unable to reopen branch selector after switching threads.",
      );
      expect(resetSearch.value).toBe("");
    } finally {
      await mounted.cleanup();
    }
  });

  it("warns before sending from a settled thread on another branch", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withSettledThreadBranch(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-settled-branch-warning" as MessageId,
          targetText: "settled branch warning",
        }),
        "feature/finished",
      ),
      configureFixture: (nextFixture) => {
        nextFixture.gitBranchByCwd["/repo/project"] = "feature/current";
      },
    });

    try {
      await expect
        .element(page.getByTestId("composer-branch-mismatch-warning"))
        .toBeInTheDocument();
      const branchWarning = page.getByTestId("composer-branch-mismatch-warning").element();
      expect(branchWarning.getBoundingClientRect().height).toBeLessThanOrEqual(80);
      expect(branchWarning.textContent).toContain(
        "Sending a message will move this thread to the current branch",
      );
      const threadBranchLabel = branchWarning.querySelector<HTMLElement>(
        '[title="Thread branch: feature/finished"]',
      );
      const currentBranchLabel = branchWarning.querySelector<HTMLElement>(
        '[title="Current branch: feature/current"]',
      );
      expect(threadBranchLabel).not.toBeNull();
      expect(currentBranchLabel).not.toBeNull();
      expect(getComputedStyle(threadBranchLabel!).textOverflow).toBe("ellipsis");
      expect(getComputedStyle(currentBranchLabel!).textOverflow).toBe("ellipsis");
      expect(document.body.textContent).toContain("feature/finished");
      expect(document.body.textContent).toContain("feature/current");

      // Simulate an out-of-band checkout after the cached branch query resolved. The send
      // path must refresh Git status instead of trusting the stale composer warning.
      fixture.gitBranchByCwd["/repo/project"] = "feature/latest";
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "resume settled thread");
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(
        () => expect(composerEditor.textContent ?? "").toContain("resume settled thread"),
        { timeout: 8_000, interval: 16 },
      );
      wsRequests.length = 0;
      const sendButton = await waitForSendButton();
      await vi.waitFor(() => expect(sendButton.disabled).toBe(false), {
        timeout: 8_000,
        interval: 16,
      });
      await page.getByRole("button", { name: "Send message" }).click();

      await vi.waitFor(
        () => {
          const branchUpdate = wsRequests
            .map(readDispatchedCommand)
            .find(
              (command) =>
                command?.type === "thread.meta.update" &&
                command.threadId === THREAD_ID &&
                command.branch === "feature/latest",
            );
          expect(branchUpdate).toBeTruthy();
          const branchUpdateIndex = wsRequests.findIndex((request) => {
            const command = readDispatchedCommand(request);
            return (
              command?.type === "thread.meta.update" &&
              command.threadId === THREAD_ID &&
              command.branch === "feature/latest"
            );
          });
          const turnStartIndex = wsRequests.findIndex(
            (request) => readDispatchedCommand(request)?.type === "thread.turn.start",
          );
          expect(turnStartIndex).toBeGreaterThan(branchUpdateIndex);
        },
        { timeout: 8_000, interval: 16 },
      );
      await vi.waitFor(
        () =>
          expect(
            document.querySelector('[data-testid="composer-branch-mismatch-warning"]'),
          ).toBeNull(),
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("restores a settled thread branch when turn start fails", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi({ rejectTurnStart: true });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withSettledThreadBranch(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-settled-branch-failed-send" as MessageId,
          targetText: "settled branch failed send",
        }),
        "feature/finished",
      ),
      configureFixture: (nextFixture) => {
        nextFixture.gitBranchByCwd["/repo/project"] = "feature/current";
      },
    });

    try {
      await expect
        .element(page.getByTestId("composer-branch-mismatch-warning"))
        .toBeInTheDocument();
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "retry after failed turn start");
      const sendButton = await waitForSendButton();
      await vi.waitFor(() => expect(sendButton.disabled).toBe(false), {
        timeout: 8_000,
        interval: 16,
      });
      wsRequests.length = 0;
      sendButton.click();

      await vi.waitFor(
        () => {
          const branchUpdates = wsRequests
            .map(readDispatchedCommand)
            .filter((command) => command?.type === "thread.meta.update" && "branch" in command)
            .map((command) => command?.branch);
          expect(branchUpdates).toEqual(["feature/current", "feature/finished"]);
          expect(useStore.getState().threadShellById?.[THREAD_ID]?.branch).toBe("feature/finished");
        },
        { timeout: 8_000, interval: 16 },
      );
      await expect
        .element(page.getByTestId("composer-branch-mismatch-warning"))
        .toBeInTheDocument();
      expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
        "retry after failed turn start",
      );
    } finally {
      restoreNativeApi();
      await mounted.cleanup();
    }
  });

  it("retains the opened terminal identity when path navigation fails", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("path-terminal-retry"),
        targetText: "Path navigation",
      }),
    });
    const previousNativeApi = window.nativeApi;
    const nativeApi = readNativeApi()!;
    const writes: Array<Parameters<typeof nativeApi.terminal.write>[0]> = [];
    Object.defineProperty(window, "nativeApi", {
      configurable: true,
      value: {
        ...nativeApi,
        terminal: {
          ...nativeApi.terminal,
          write: async (input: Parameters<typeof nativeApi.terminal.write>[0]) => {
            if (input.onlyIfIdle) {
              writes.push(input);
              throw new Error("Activity check unavailable");
            }
            return nativeApi.terminal.write(input);
          },
        },
      },
    });
    try {
      const row = await waitForElement<HTMLElement>(
        () => document.querySelector("[data-thread-item] [data-thread-entry-point]"),
        "Expected sidebar thread row",
      );
      row.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 160 }),
      );
      (
        await waitForElement<HTMLButtonElement>(
          () =>
            contextMenuRows().find((button) =>
              button.textContent?.includes("Open Path in Terminal"),
            ) ?? null,
          "Expected path action",
        )
      ).click();
      await expect.poll(() => writes.length).toBe(1);
      await expect
        .element(page.getByText("Unable to open terminal", { exact: true }))
        .toBeVisible();
      const state = useTerminalStateStore.getState().terminalStateByThreadId[THREAD_ID]!;
      expect(state.terminalOpen).toBe(false);
      expect(state.activeTerminalId).toBe(writes[0]!.terminalId);
      expect(state.hasSession).toBe(true);
      useTerminalStateStore.getState().setTerminalOpen(THREAD_ID, true);
      expect(
        useTerminalStateStore.getState().terminalStateByThreadId[THREAD_ID]?.activeTerminalId,
      ).toBe(writes[0]!.terminalId);
    } finally {
      if (previousNativeApi)
        Object.defineProperty(window, "nativeApi", {
          configurable: true,
          value: previousNativeApi,
        });
      else Reflect.deleteProperty(window, "nativeApi");
      await mounted.cleanup();
    }
  });

  it.each(["button", "draft shortcut", "split button"] as const)(
    "runs project scripts in the right dock at the worktree cwd via %s",
    async (entryPoint) => {
      useComposerDraftStore.setState({
        draftThreadsByThreadId: {
          [THREAD_ID]: {
            projectId: PROJECT_ID,
            createdAt: NOW_ISO,
            runtimeMode: "full-access",
            interactionMode: "default",
            entryPoint: "chat",
            branch: "feature/draft",
            worktreePath: "/repo/worktrees/feature-draft",
            envMode: "worktree",
          },
        },
        projectDraftThreadIdByProjectId: {
          [PROJECT_ID]: THREAD_ID,
        },
      });

      const baseSnapshot =
        entryPoint === "draft shortcut"
          ? createDraftOnlySnapshot()
          : createSnapshotForTargetUser({
              targetMessageId: MessageId.makeUnsafe("action-button-worktree"),
              targetText: "Keep this chat visible",
            });
      const snapshot: OrchestrationReadModel = {
        ...baseSnapshot,
        threads: baseSnapshot.threads.map((thread) => ({
          ...thread,
          envMode: "worktree",
          worktreePath: "/repo/worktrees/feature-draft",
        })),
      };
      useRightDockStore.setState({ dockStateByThreadId: {} });

      const mounted = await mountChatView({
        viewport: { ...DEFAULT_VIEWPORT, width: 1_800 },
        snapshot: withProjectScripts(
          entryPoint === "split button" ? addThreadToSnapshot(snapshot, OTHER_THREAD_ID) : snapshot,
          [
            {
              id: "test",
              name: "Test",
              command: "bun run test",
              icon: "test",
              runOnWorktreeCreate: false,
            },
          ],
        ),
        // The empty landing runs minimal chrome with no scripts control, so drafts
        // reach scripts through their keybindings; drive the same runProjectScript
        // path the way a user would.
        configureFixture: (nextFixture) => {
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            keybindings: [
              {
                command: "script.test.run",
                shortcut: {
                  key: "t",
                  metaKey: false,
                  ctrlKey: false,
                  shiftKey: true,
                  altKey: true,
                  modKey: true,
                },
              },
            ],
          };
        },
      });

      try {
        await waitForServerConfigToApply();
        if (entryPoint === "split button") {
          const splitViewId = useSplitViewStore.getState().createFromDrop({
            sourceThreadId: THREAD_ID,
            ownerProjectId: PROJECT_ID,
            droppedThreadId: OTHER_THREAD_ID,
            direction: "horizontal",
            side: "second",
          });
          const splitView = useSplitViewStore.getState().splitViewsById[splitViewId]!;
          const actionPaneId = resolveSplitViewPaneIdForThread(splitView, THREAD_ID)!;
          useSplitViewStore
            .getState()
            .setPanePanelState(splitViewId, actionPaneId, { panel: "diff" });
          await mounted.router.navigate({
            to: "/$threadId",
            params: { threadId: THREAD_ID },
            search: () => ({ splitViewId }),
          });
          await vi.waitFor(() =>
            expect(document.querySelectorAll('[contenteditable="true"]')).toHaveLength(2),
          );
        }
        if (entryPoint !== "draft shortcut") {
          await page.getByRole("button", { name: "Run Test", exact: true }).first().click();
        } else {
          await dispatchConfiguredShortcutWhenReady(window, {
            key: "t",
            shiftKey: true,
            altKey: true,
          });
        }

        await vi.waitFor(
          () => {
            const openRequest = wsRequests.find(
              (request) =>
                request._tag === WS_METHODS.terminalOpen &&
                request.cwd === "/repo/worktrees/feature-draft",
            );
            expect(openRequest).toMatchObject({
              _tag: WS_METHODS.terminalOpen,
              threadId: dockTerminalThreadId(THREAD_ID),
              cwd: "/repo/worktrees/feature-draft",
              env: {
                SYNARA_PROJECT_ROOT: "/repo/project",
                SYNARA_WORKTREE_PATH: "/repo/worktrees/feature-draft",
              },
            });
          },
          { timeout: 8_000, interval: 16 },
        );

        await vi.waitFor(
          () => {
            const writeRequest = wsRequests.find(
              (request) => request._tag === WS_METHODS.terminalWrite,
            );
            expect(writeRequest).toMatchObject({
              _tag: WS_METHODS.terminalWrite,
              threadId: dockTerminalThreadId(THREAD_ID),
              data: "bun run test\r",
            });
          },
          { timeout: 8_000, interval: 16 },
        );
        await expect.element(page.getByRole("complementary", { name: "Terminal" })).toBeVisible();
        const terminalSelector =
          entryPoint === "split button"
            ? '[data-split-pane-focused] aside[aria-label="Terminal"]'
            : '[data-right-dock-content] aside[aria-label="Terminal"]';
        expect(document.querySelector(terminalSelector)).not.toBeNull();
        if (entryPoint === "split button") {
          expect(mounted.router.state.location.search.splitViewId).toBeDefined();
          expect(document.querySelectorAll('[contenteditable="true"]')).toHaveLength(2);
        }
        expect((await waitForComposerEditor()).getBoundingClientRect().width).toBeGreaterThan(0);
        if (entryPoint === "split button") {
          const openedSessionIds = new Set(
            wsRequests
              .filter((request) => request._tag === WS_METHODS.terminalOpen)
              .map((request) => request.terminalId),
          );
          await page.getByRole("button", { name: "Hide terminal", exact: true }).click();
          await expect
            .element(page.getByRole("complementary", { name: "Terminal" }))
            .not.toBeInTheDocument();
          await page
            .getByRole("button", { name: "Toggle right sidebar", exact: true })
            .first()
            .click();
          await expect.element(page.getByRole("complementary", { name: "Terminal" })).toBeVisible();
          expect(
            new Set(
              wsRequests
                .filter((request) => request._tag === WS_METHODS.terminalOpen)
                .map((request) => request.terminalId),
            ),
          ).toEqual(openedSessionIds);
          const splitViewId = mounted.router.state.location.search.splitViewId!;
          const splitView = useSplitViewStore.getState().splitViewsById[splitViewId]!;
          expect(
            collectLeaves(splitView.root).find((leaf) => leaf.threadId === THREAD_ID)?.panel.panel,
          ).toBe("diff");
        }
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("cycles model effort with Shift+Tab in the existing model picker", async () => {
    localStorage.setItem("synara:app-settings:v1", JSON.stringify({ composerEffortSlider: true }));
    localStorage.setItem(
      STARRED_MODELS_STORAGE_KEY,
      JSON.stringify([
        { provider: "codex", model: "gpt-5.4", effort: "medium", fastMode: true, thinking: null },
      ]),
    );
    useComposerDraftStore.getState().setModelSelection(THREAD_ID, {
      provider: "codex",
      model: "gpt-5.4",
      options: { reasoningEffort: "medium", fastMode: true },
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-target-hotkey" as MessageId,
        targetText: "hotkey target",
      }),
    });
    const focusTarget = document.createElement("button");
    focusTarget.type = "button";
    focusTarget.textContent = "Focus sink";
    document.body.appendChild(focusTarget);

    try {
      await waitForServerConfigToApply();
      const readInteractionMode = () =>
        useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.interactionMode ?? "default";
      const readModelSelection = () =>
        useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.modelSelectionByProvider
          .codex;
      expect(readInteractionMode()).toBe("default");

      focusTarget.focus();
      focusTarget.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await waitForLayout();

      expect(readInteractionMode()).toBe("default");
      expect(readModelSelection()).toMatchObject({ options: { reasoningEffort: "medium" } });
      expect(document.querySelector('[role="slider"][aria-label="Reasoning effort"]')).toBeNull();

      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      const slider = page.getByRole("slider", { name: "Reasoning effort" });
      const searchbox = page.getByRole("searchbox", { name: "Search models" });
      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await waitForLayout();
      expect(readModelSelection()).toMatchObject({ options: { reasoningEffort: "medium" } });
      expect(document.querySelector('[role="slider"][aria-label="Reasoning effort"]')).toBeNull();
      let shortcutTarget: HTMLElement = composerEditor;
      for (const [effort, label] of [
        ["high", "High"],
        ["xhigh", "Extra High"],
        ["low", "Low"],
      ] as const) {
        const event = new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        });
        shortcutTarget.dispatchEvent(event);
        await expect.element(searchbox, { timeout: 1_000 }).toBeVisible();
        await expect.element(page.getByRole("tablist", { name: "Model sources" })).toBeVisible();
        await expect
          .element(page.getByRole("tab", { name: "Starred", exact: true }))
          .toHaveAttribute("aria-selected", "true");
        await expect.element(page.getByRole("menuitem", { name: /^GPT-5\.4/u })).toBeVisible();
        expect(
          page.getByRole("dialog", { name: "Model effort", exact: true }).elements(),
        ).toHaveLength(0);
        await expect.element(slider).toHaveAttribute("aria-valuetext", label);
        expect(event.defaultPrevented).toBe(true);
        expect(readModelSelection()).toMatchObject({
          provider: "codex",
          model: "gpt-5.4",
          options: { reasoningEffort: effort, fastMode: true },
        });
        expect(readInteractionMode()).toBe("default");
        await vi.waitFor(() => expect(document.activeElement).toBe(searchbox.element()));
        shortcutTarget = searchbox.element() as HTMLElement;
      }
    } finally {
      focusTarget.remove();
      await mounted.cleanup();
    }
  });

  it("keeps the model picker open for 1500ms after the latest Shift+Tab press", async () => {
    localStorage.setItem("synara:app-settings:v1", JSON.stringify({ composerEffortSlider: true }));
    useComposerDraftStore.getState().setModelSelection(THREAD_ID, {
      provider: "codex",
      model: "gpt-5.4",
      options: { reasoningEffort: "low" },
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-effort-preview-timer" as MessageId,
        targetText: "effort preview timer",
      }),
    });

    try {
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      let shortcutTarget: HTMLElement = composerEditor;
      const pressShortcut = () =>
        shortcutTarget.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Tab",
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      const slider = page.getByRole("slider", { name: "Reasoning effort" });
      const searchbox = page.getByRole("searchbox", { name: "Search models" });
      pressShortcut();
      await expect.element(searchbox, { timeout: 1_000 }).toBeVisible();
      await expect.element(slider).toHaveAttribute("aria-valuetext", "Medium");
      await vi.waitFor(() => expect(document.activeElement).toBe(searchbox.element()));
      shortcutTarget = searchbox.element() as HTMLElement;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 900));
      pressShortcut();
      await expect.element(slider).toHaveAttribute("aria-valuetext", "High");
      await new Promise<void>((resolve) => window.setTimeout(resolve, 900));
      await expect.element(slider).toBeVisible();
      await vi.waitFor(
        () => {
          expect(document.querySelector('[data-slot="menu-popup"]')).toBeNull();
        },
        { timeout: 1_500, interval: 16 },
      );
      await vi.waitFor(() => expect(document.activeElement).toBe(composerEditor));
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps a manually opened model picker open after the effort shortcut timer expires", async () => {
    localStorage.setItem("synara:app-settings:v1", JSON.stringify({ composerEffortSlider: true }));
    useComposerDraftStore.getState().setModelSelection(THREAD_ID, {
      provider: "codex",
      model: "gpt-5.4",
      options: { reasoningEffort: "medium" },
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-effort-preview-manual-picker" as MessageId,
        targetText: "manual model picker",
      }),
    });

    try {
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await expect
        .element(page.getByRole("slider", { name: "Reasoning effort" }))
        .toHaveAttribute("aria-valuetext", "High");
      const searchbox = page.getByRole("searchbox", { name: "Search models" });
      await expect.element(searchbox, { timeout: 1_000 }).toBeVisible();
      await vi.waitFor(() => expect(document.activeElement).toBe(searchbox.element()));
      dispatchComposerPickerShortcut(searchbox.element(), "m");
      await waitForComposerPickerSurfaceOpen();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 1_700));
      await expect
        .element(page.getByRole("searchbox", { name: "Search models" }), { timeout: 1_000 })
        .toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the existing slider menu open when choosing another model after Shift+Tab", async () => {
    localStorage.setItem("synara:app-settings:v1", JSON.stringify({ composerEffortSlider: true }));
    useComposerDraftStore.getState().setModelSelection(THREAD_ID, {
      provider: "codex",
      model: "gpt-5.4",
      options: { reasoningEffort: "medium" },
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-effort-shortcut-model-selection" as MessageId,
        targetText: "choose model from effort shortcut",
      }),
    });

    try {
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      const searchbox = page.getByRole("searchbox", { name: "Search models" });
      const slider = page.getByRole("slider", { name: "Reasoning effort" });
      await expect.element(searchbox, { timeout: 1_000 }).toBeVisible();
      await expect.element(slider, { timeout: 1_000 }).toHaveAttribute("aria-valuetext", "High");
      await page.getByRole("menuitem", { name: /^GPT-5\.5/u }).click();
      await vi.waitFor(() => {
        expect(
          useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.modelSelectionByProvider
            .codex,
        ).toMatchObject({ model: "gpt-5.5" });
      });
      await waitForLayout();
      await expect.element(searchbox, { timeout: 1_000 }).toBeVisible();
      await expect.element(slider, { timeout: 1_000 }).toHaveAttribute("aria-valuetext", "High");
      slider
        .element()
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }),
        );
      await expect.element(slider, { timeout: 1_000 }).toHaveAttribute("aria-valuetext", "Medium");
      expect(
        useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.modelSelectionByProvider
          .codex,
      ).toMatchObject({ model: "gpt-5.5", options: { reasoningEffort: "medium" } });
      await new Promise<void>((resolve) => window.setTimeout(resolve, 1_700));
      await expect.element(searchbox, { timeout: 1_000 }).toBeVisible();
      await expect.element(slider, { timeout: 1_000 }).toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the existing model picker effort menu when its slider setting is disabled", async () => {
    localStorage.setItem("synara:app-settings:v1", JSON.stringify({ composerEffortSlider: false }));
    useComposerDraftStore.getState().setModelSelection(THREAD_ID, {
      provider: "codex",
      model: "gpt-5.4",
      options: { reasoningEffort: "medium" },
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-effort-shortcut-menu-setting" as MessageId,
        targetText: "effort menu setting",
      }),
    });

    try {
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(
        useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.modelSelectionByProvider
          .codex,
      ).toMatchObject({ options: { reasoningEffort: "high" } });
      await expect
        .element(page.getByRole("searchbox", { name: "Search models" }), { timeout: 1_000 })
        .toBeVisible();
      await expect.element(page.getByRole("menuitem", { name: /^Effort.*High/u })).toBeVisible();
      expect(page.getByRole("slider", { name: "Reasoning effort" }).elements()).toHaveLength(0);
      expect(
        page.getByRole("dialog", { name: "Model effort", exact: true }).elements(),
      ).toHaveLength(0);
    } finally {
      await mounted.cleanup();
    }
  });

  it("protects typed drafts while preserving history browsing from an empty composer", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("msg-prompt-history"),
        targetText: "Earlier submitted prompt",
      }),
    });
    try {
      const editor = await waitForComposerEditor();
      await userEvent.click(editor);
      const phrase = "Keep this unsent draft while moving the caret. ";
      const draft = phrase.repeat(8);
      // Exercise caret/history behavior while allowing React to finish a frame between
      // typing bursts, rather than hundreds of automation keys in one update batch.
      for (let index = 0; index < 8; index += 1) {
        await userEvent.keyboard(phrase);
        await nextFrame();
      }
      await userEvent.keyboard("{Shift>}{Enter}{/Shift}Second line");
      const prompt = useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt;
      await userEvent.keyboard("{ArrowUp>10/}");
      expect(editor.textContent).toContain(draft);
      expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(prompt);

      await userEvent.clear(editor);
      await userEvent.keyboard("{ArrowUp}");
      await vi.waitFor(() => expect(editor.textContent).toBe("filler user message 21"));
      await userEvent.keyboard("{ArrowUp}");
      await vi.waitFor(() => expect(editor.textContent).toBe("filler user message 20"));
      await userEvent.keyboard("{ArrowDown}{ArrowDown}");
      await vi.waitFor(() => expect(editor.textContent).toBe(""));

      await userEvent.keyboard("{ArrowUp}");
      await vi.waitFor(() => expect(editor.textContent).toBe("filler user message 21"));
      await userEvent.keyboard(" edited");
      await userEvent.keyboard("{ArrowUp>3/}{ArrowDown}");
      expect(editor.textContent).toBe("filler user message 21 edited");
    } finally {
      await mounted.cleanup();
    }
  });

  it("toggles composer focus with Cmd+L", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-composer-focus-shortcut" as MessageId,
        targetText: "composer focus shortcut",
      }),
    });
    const focusTarget = document.createElement("button");
    focusTarget.type = "button";
    focusTarget.textContent = "Focus sink";
    document.body.appendChild(focusTarget);

    try {
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      focusTarget.focus();
      expect(document.activeElement).toBe(focusTarget);

      const focusEvent = dispatchComposerFocusToggleShortcut();
      expect(focusEvent.defaultPrevented).toBe(true);
      await vi.waitFor(() => {
        expect(document.activeElement).toBe(composerEditor);
      });

      const blurEvent = dispatchComposerFocusToggleShortcut();
      expect(blurEvent.defaultPrevented).toBe(true);
      await vi.waitFor(() => {
        expect(document.activeElement).not.toBe(composerEditor);
      });
    } finally {
      focusTarget.remove();
      await mounted.cleanup();
    }
  });

  it("cycles the active provider model without opening the picker", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-model-cycle-shortcut" as MessageId,
        targetText: "model cycle shortcut",
      }),
    });

    try {
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();

      await dispatchModelCycleShortcutWhenReady(composerEditor, "]");
      await vi.waitFor(() => {
        expect(
          useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.modelSelectionByProvider
            .codex,
        ).toMatchObject({ provider: "codex", model: DEFAULT_MODEL_BY_PROVIDER.codex });
      });
      expect(document.querySelector('[data-slot="menu-popup"]')).toBeNull();

      await dispatchModelCycleShortcutWhenReady(composerEditor, "[");
      await vi.waitFor(() => {
        expect(
          useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.modelSelectionByProvider
            .codex,
        ).toMatchObject({ provider: "codex", model: "gpt-5.2" });
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the composer model picker with configured keybinding labels loaded", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-model-picker-configured-shortcut" as MessageId,
        targetText: "configured model picker shortcut",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "modelPicker.toggle",
              shortcut: {
                key: "m",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: true,
                modKey: true,
              },
            },
          ],
        };
      },
    });

    try {
      const composerEditor = await waitForComposerEditor();
      await waitForServerConfigToApply();
      composerEditor.focus();
      dispatchConfiguredShortcut(composerEditor, { key: "m", altKey: true });

      await waitForComposerPickerSurfaceOpen();
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the composer effort picker surface", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-effort-picker-shortcut" as MessageId,
        targetText: "effort picker shortcut",
      }),
      configureFixture: (nextFixture) => {
        const providers: ServerConfig["providers"] = [
          ...nextFixture.serverConfig.providers,
          {
            provider: "claudeAgent",
            instanceId: "claudeAgent",
            driver: "claudeAgent",
            status: "ready",
            available: true,
            authStatus: "authenticated",
            checkedAt: NOW_ISO,
          },
        ];
        nextFixture.serverConfig = { ...nextFixture.serverConfig, providers };
        nextFixture.providerStatusesSnapshot = providers;
      },
    });

    try {
      const composerEditor = await waitForComposerEditor();
      await waitForServerConfigToApply();
      const queryClient = mounted.router.options.context.queryClient;
      const catalogKey = ["provider-discovery", "models", "claudeAgent"];
      await vi.waitFor(() => expect(queryClient.isFetching({ queryKey: catalogKey })).toBe(0));
      // Simulate a cold non-selected catalog after any route-level prewarming.
      queryClient.removeQueries({ queryKey: catalogKey });
      wsRequests.length = 0;
      composerEditor.focus();
      dispatchComposerPickerShortcut(composerEditor, "e");

      await waitForComposerPickerSurfaceOpen();
      expect(
        wsRequests.filter(
          (request) =>
            request._tag === WS_METHODS.providerListModels && request.provider === "claudeAgent",
        ),
      ).toEqual([]);
      expect(
        page.getByRole("button", { name: "Refresh models", exact: true }).elements(),
      ).toHaveLength(0);
      await vi.waitFor(() => {
        expect(wsRequests).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              _tag: WS_METHODS.providerListModels,
              provider: "codex",
              instanceId: "codex",
              refresh: "if-stale",
            }),
          ]),
        );
      });
      expect(
        wsRequests.filter(
          (request) =>
            request._tag === WS_METHODS.providerListModels && request.provider === "claudeAgent",
        ),
      ).toEqual([]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps removed terminal context pills removed when a new one is added", async () => {
    const removedLabel = "Terminal 1 lines 1-2";
    const addedLabel = "Terminal 2 lines 9-10";
    useComposerDraftStore.getState().addTerminalContext(
      THREAD_ID,
      createTerminalContext({
        id: "ctx-removed",
        terminalLabel: "Terminal 1",
        lineStart: 1,
        lineEnd: 2,
        text: "bun i\nno changes",
      }),
    );

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-terminal-pill-backspace" as MessageId,
        targetText: "terminal pill backspace target",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(removedLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      const store = useComposerDraftStore.getState();
      const currentPrompt = store.draftsByThreadId[THREAD_ID]?.prompt ?? "";
      const nextPrompt = removeInlineTerminalContextPlaceholder(currentPrompt, 0);
      store.setPrompt(THREAD_ID, nextPrompt.prompt);
      store.removeTerminalContext(THREAD_ID, "ctx-removed");

      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]).toBeUndefined();
          expect(document.body.textContent).not.toContain(removedLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      useComposerDraftStore.getState().addTerminalContext(
        THREAD_ID,
        createTerminalContext({
          id: "ctx-added",
          terminalLabel: "Terminal 2",
          lineStart: 9,
          lineEnd: 10,
          text: "git status\nOn branch main",
        }),
      );

      await vi.waitFor(
        () => {
          const draft = useComposerDraftStore.getState().draftsByThreadId[THREAD_ID];
          expect(draft?.terminalContexts.map((context) => context.id)).toEqual(["ctx-added"]);
          expect(document.body.textContent).toContain(addedLabel);
          expect(document.body.textContent).not.toContain(removedLabel);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("warns when sending text while omitting expired terminal pills", async () => {
    const expiredLabel = "Terminal 1 line 4";
    useComposerDraftStore.getState().addTerminalContext(
      THREAD_ID,
      createTerminalContext({
        id: "ctx-expired-send-warning",
        terminalLabel: "Terminal 1",
        lineStart: 4,
        lineEnd: 4,
        text: "",
      }),
    );
    useComposerDraftStore
      .getState()
      .setPrompt(THREAD_ID, `yoo${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}waddup`);

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-expired-pill-warning" as MessageId,
        targetText: "expired pill warning target",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(expiredLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(
            "Expired terminal context omitted from message",
          );
          expect(document.body.textContent).not.toContain(expiredLabel);
          expect(document.body.textContent).toContain("yoowaddup");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("sends every browser annotation as prompt context without upload attachments", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    const prompt = "Delete everything I annotated.";
    const store = useComposerDraftStore.getState();
    store.setPrompt(THREAD_ID, prompt);
    expect(
      store.addBrowserAnnotation(THREAD_ID, {
        id: "annotation-without-comment",
        tabId: "tab-a",
        source: {
          url: "https://example.test/landing",
          pageTitle: "Landing page",
        },
        selector: "#hero-title",
        tagName: "h1",
        role: null,
        name: null,
        text: "Build faster",
        fingerprint: "fnv1a64:0123456789abcdef",
        comment: null,
        capturedAt: NOW_ISO,
      }),
    ).toBe(true);
    expect(
      store.addBrowserAnnotation(THREAD_ID, {
        id: "annotation-with-comment",
        tabId: "tab-a",
        source: {
          url: "https://example.test/pricing",
          pageTitle: "Pricing",
        },
        selector: "#legacy-plan",
        tagName: "section",
        role: "region",
        name: "Legacy plan",
        text: "Legacy",
        fingerprint: "fnv1a64:fedcba9876543210",
        comment: "This one is obsolete.",
        capturedAt: NOW_ISO,
      }),
    ).toBe(true);

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-browser-annotations-send" as MessageId,
        targetText: "browser annotations send target",
      }),
    });

    try {
      await vi.waitFor(() => {
        expect(document.querySelectorAll('[data-testid="browser-annotation-chip"]')).toHaveLength(
          2,
        );
      });

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          const request = wsRequests.find(
            (candidate) =>
              candidate._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              typeof candidate.command === "object" &&
              candidate.command !== null &&
              "type" in candidate.command &&
              candidate.command.type === "thread.turn.start",
          );
          expect(request).toBeTruthy();
          const command = request!.command as {
            message?: { messageId?: unknown; text?: unknown; attachments?: unknown[] };
          };
          expect(typeof command.message?.messageId).toBe("string");
          expect(typeof command.message?.text).toBe("string");
          const serializedPayload = (command.message!.text as string).split("\n").at(-2);
          expect(serializedPayload).toBeTruthy();
          expect(JSON.parse(serializedPayload!)?.messageId).toBe(command.message!.messageId);
          const extracted = extractTrailingBrowserAnnotations(
            command.message!.text as string,
            MessageId.makeUnsafe(command.message!.messageId as string),
          );
          expect(extracted.promptText).toBe(prompt);
          expect(
            extracted.annotations.map(({ id, ordinal, comment, source }) => ({
              id,
              ordinal,
              comment,
              url: source.url,
            })),
          ).toEqual([
            {
              id: "annotation-without-comment",
              ordinal: 1,
              comment: null,
              url: "https://example.test/landing",
            },
            {
              id: "annotation-with-comment",
              ordinal: 2,
              comment: "This one is obsolete.",
              url: "https://example.test/pricing",
            },
          ]);
          expect(command.message?.attachments ?? []).toHaveLength(0);
          expect(
            useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.browserAnnotations ?? [],
          ).toHaveLength(0);
          expect(document.body.textContent).not.toContain("<browser_annotations>");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("steers a running turn when Follow-up behavior is set to Steer", async () => {
    localStorage.setItem("synara:app-settings:v1", JSON.stringify({ followUpBehavior: "steer" }));
    useComposerDraftStore.getState().setPrompt(THREAD_ID, "steer this running turn");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-running-steer-setting" as MessageId,
        targetText: "running steer setting target",
        sessionStatus: "running",
      }),
    });

    try {
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
        "Unable to find composer form.",
      );
      composerForm.requestSubmit();

      await vi.waitFor(
        () => {
          const turnStart = wsRequests
            .map(readDispatchedCommand)
            .find(
              (command) =>
                command?.type === "thread.turn.start" &&
                command.dispatchMode === "steer" &&
                typeof command.message === "object" &&
                command.message !== null &&
                "text" in command.message &&
                typeof command.message.text === "string" &&
                command.message.text.includes("steer this running turn"),
            );
          expect(turnStart).toBeTruthy();
          expect(document.querySelector('[data-testid="queued-follow-up-row"]')).toBeNull();
          expect(document.body.textContent).toContain("Steering conversation");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps queued follow-ups when you switch threads and come back", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_ID, "queue survives thread switch");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: addThreadToSnapshot(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-running-queue-switch" as MessageId,
          targetText: "running queue switch target",
          sessionStatus: "running",
        }),
        OTHER_THREAD_ID,
      ),
    });
    try {
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
        "Unable to find composer form.",
      );
      composerForm.requestSubmit();

      await vi.waitFor(
        () => {
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(1);
          expect(document.body.textContent).toContain("queue survives thread switch");
          expect(document.body.textContent).toContain("Steer");
          expect(document.querySelector('button[aria-label="Stop generation"]')).not.toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );

      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: OTHER_THREAD_ID },
      });
      await waitForLayout();

      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.pathname).toBe(`/${OTHER_THREAD_ID}`);
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(0);
        },
        { timeout: 8_000, interval: 16 },
      );

      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: THREAD_ID },
      });
      await waitForLayout();

      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.pathname).toBe(`/${THREAD_ID}`);
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(1);
          expect(document.body.textContent).toContain("queue survives thread switch");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("marks a chat back from snooze as seen once it is opened", async () => {
    const base = createSnapshotForTargetUser({
      targetMessageId: "msg-snooze-return" as MessageId,
      targetText: "Snoozed chat",
    });
    const finishedTurn = {
      turnId: TurnId.makeUnsafe("turn-snooze-return"),
      state: "completed" as const,
      requestedAt: isoAt(-700),
      startedAt: isoAt(-690),
      completedAt: isoAt(-600),
      assistantMessageId: null,
    };
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: addThreadToSnapshot(
        {
          ...base,
          threads: base.threads.map((thread) =>
            thread.id === THREAD_ID ? { ...thread, latestTurn: finishedTurn } : thread,
          ),
        },
        OTHER_THREAD_ID,
      ),
      initialEntry: `/${OTHER_THREAD_ID}`,
    });
    try {
      await waitForLayout();
      // The reminder fires while another chat is open: THREAD_ID returns unread. The server
      // clock is ahead of this one, so a visit stamped with this clock's now stays before it.
      const reminderAt = new Date(Date.now() + 60_000).toISOString();
      fixture.snapshot = {
        ...fixture.snapshot,
        snapshotSequence: fixture.snapshot.snapshotSequence + 1,
        threads: fixture.snapshot.threads.map((thread) =>
          thread.id === THREAD_ID
            ? { ...thread, snoozedUntil: null, snoozeReminderAt: reminderAt, updatedAt: reminderAt }
            : thread,
        ),
      };
      useStore.getState().syncServerReadModel(fixture.snapshot);
      const returnedChat = () => useStore.getState().sidebarThreadSummaryById[THREAD_ID]!;
      expect(hasUnseenSnoozeReturn(returnedChat())).toBe(true);

      await mounted.router.navigate({ to: "/$threadId", params: { threadId: THREAD_ID } });
      await vi.waitFor(() => expect(hasUnseenSnoozeReturn(returnedChat())).toBe(false));
    } finally {
      await mounted.cleanup();
    }
  });

  it("editing a queued follow-up removes only that row and restores its images to the composer", async () => {
    const queuedImage = createComposerImage({
      id: "queued-image-1",
      previewUrl: "blob:queued-image-1",
      name: "queued-image.png",
    });
    const firstQueuedPrompt = "first queued prompt with image";
    const secondQueuedPrompt = "second queued prompt stays queued";

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-running-edit-queue" as MessageId,
        targetText: "running edit queue target",
        sessionStatus: "running",
      }),
    });

    try {
      useComposerDraftStore.getState().enqueueQueuedTurn(THREAD_ID, {
        id: "queued-turn-1",
        kind: "chat",
        createdAt: NOW_ISO,
        previewText: firstQueuedPrompt,
        prompt: firstQueuedPrompt,
        images: [queuedImage],
        files: [],
        assistantSelections: [],
        browserAnnotations: [],
        terminalContexts: [],
        fileComments: [],
        pastedTexts: [],
        pullRequestContexts: [],
        skills: [],
        mentions: [],
        selectedProvider: "codex",
        selectedModel: "gpt-5",
        selectedPromptEffort: null,
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        envMode: "local",
      });
      useComposerDraftStore.getState().enqueueQueuedTurn(THREAD_ID, {
        id: "queued-turn-2",
        kind: "chat",
        createdAt: NOW_ISO,
        previewText: secondQueuedPrompt,
        prompt: secondQueuedPrompt,
        images: [],
        files: [],
        assistantSelections: [],
        browserAnnotations: [],
        terminalContexts: [],
        fileComments: [],
        pastedTexts: [],
        pullRequestContexts: [],
        skills: [],
        mentions: [],
        selectedProvider: "codex",
        selectedModel: "gpt-5",
        selectedPromptEffort: null,
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        envMode: "local",
      });

      await vi.waitFor(
        () => {
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(2);
        },
        { timeout: 8_000, interval: 16 },
      );

      const actionButtons = document.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="Queued follow-up actions"]',
      );
      await page.getByRole("button", { name: "Steer", exact: true }).first().hover();
      await expect
        .element(page.getByText("Send this follow-up now to redirect the current work."))
        .toHaveTextContent(
          "Send this follow-up now to redirect the current work. If native steering is unavailable, stop the current turn and start a new one.",
        );
      expect(
        document.querySelectorAll('button[aria-label="Delete queued follow-up"]'),
      ).toHaveLength(2);
      actionButtons[0]?.click();

      const editMenuItem = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="menu-item"]')).find(
            (item) => item.textContent?.trim() === "Edit queued follow-up",
          ) ?? null,
        "Unable to find edit queued follow-up menu item.",
      );
      expect(document.querySelectorAll('[data-slot="menu-item"]')).toHaveLength(1);
      editMenuItem.click();

      await vi.waitFor(
        () => {
          const queuedRows = document.querySelectorAll<HTMLElement>(
            '[data-testid="queued-follow-up-row"]',
          );
          expect(queuedRows).toHaveLength(1);
          expect(queuedRows[0]?.textContent ?? "").toContain(secondQueuedPrompt);
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
            firstQueuedPrompt,
          );
          expect(
            useComposerDraftStore
              .getState()
              .draftsByThreadId[THREAD_ID]?.images.map((image) => image.name),
          ).toEqual(["queued-image.png"]);
          // The restored image renders as a thumbnail chip whose filename lives in
          // its accessible label/title, not in text content.
          expect(document.querySelector('[aria-label="Preview queued-image.png"]')).not.toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("auto-dispatches a queued turn without wiping the live composer draft", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    const queuedPrompt = "queued prompt that should auto-send";
    const draftBeingTyped = "draft the user is still typing";

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-auto-dispatch-target" as MessageId,
        targetText: "auto dispatch target",
        // Idle session so the auto-dispatch effect (gated on phase !== "running")
        // drains the queue, mirroring a turn that just finished.
        sessionStatus: "ready",
      }),
    });

    try {
      // The user is mid-draft in the composer while a turn-completion drain fires.
      useComposerDraftStore.getState().setPrompt(THREAD_ID, draftBeingTyped);
      useComposerDraftStore.getState().enqueueQueuedTurn(THREAD_ID, {
        id: "queued-turn-auto",
        kind: "chat",
        createdAt: NOW_ISO,
        previewText: queuedPrompt,
        prompt: queuedPrompt,
        images: [],
        files: [],
        assistantSelections: [],
        browserAnnotations: [],
        terminalContexts: [],
        fileComments: [],
        pastedTexts: [],
        pullRequestContexts: [],
        skills: [],
        mentions: [],
        selectedProvider: "codex",
        selectedModel: "gpt-5",
        selectedPromptEffort: null,
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        envMode: "local",
      });

      await vi.waitFor(
        () => {
          const turnStartRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              typeof request.command === "object" &&
              request.command !== null &&
              "type" in request.command &&
              request.command.type === "thread.turn.start" &&
              "threadId" in request.command &&
              request.command.threadId === THREAD_ID &&
              "message" in request.command &&
              typeof request.command.message === "object" &&
              request.command.message !== null &&
              "text" in request.command.message &&
              typeof request.command.message.text === "string" &&
              request.command.message.text.includes(queuedPrompt),
          );
          expect(turnStartRequest).toBeTruthy();
          // Queue drained...
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(0);
          // ...but the in-progress composer draft is left untouched.
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
            draftBeingTyped,
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  describe("queue paused by Stop", () => {
    const queuedPrompt = "queued prompt held after stop";
    const stoppedTurnId = TurnId.makeUnsafe("turn-stopped-by-user");
    const turnStartText = (request: (typeof wsRequests)[number]): string | null =>
      request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
      typeof request.command === "object" &&
      request.command !== null &&
      "type" in request.command &&
      request.command.type === "thread.turn.start" &&
      "message" in request.command &&
      typeof request.command.message === "object" &&
      request.command.message !== null &&
      "text" in request.command.message &&
      typeof request.command.message.text === "string"
        ? request.command.message.text
        : null;
    const sentQueuedPrompt = () =>
      wsRequests.some((request) => turnStartText(request)?.includes(queuedPrompt) === true);

    async function mountPausedQueue(kind: "chat" | "plan-follow-up" = "chat") {
      const baseSnapshot =
        kind === "plan-follow-up"
          ? createSnapshotWithSettledPlanAwaitingFollowUp()
          : createSnapshotForTargetUser({
              targetMessageId: "msg-user-paused-queue-target" as MessageId,
              targetText: "paused queue target",
              sessionStatus: "ready",
            });
      const snapshot: OrchestrationReadModel = {
        ...baseSnapshot,
        threads: baseSnapshot.threads.map((thread) =>
          thread.id === THREAD_ID
            ? {
                ...thread,
                // Claude settles a stopped turn as "completed"; the recorded Stop still holds.
                latestTurn: {
                  turnId: stoppedTurnId,
                  state: "completed",
                  requestedAt: NOW_ISO,
                  startedAt: NOW_ISO,
                  completedAt: NOW_ISO,
                  assistantMessageId: null,
                },
              }
            : thread,
        ),
      };
      const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
      const queuedTurn = {
        id: "queued-turn-paused",
        kind: "chat" as const,
        createdAt: NOW_ISO,
        previewText: queuedPrompt,
        prompt: queuedPrompt,
        images: [],
        files: [],
        assistantSelections: [],
        browserAnnotations: [],
        terminalContexts: [],
        fileComments: [],
        pastedTexts: [],
        pullRequestContexts: [],
        skills: [],
        mentions: [],
        selectedProvider: "codex" as const,
        selectedModel: "gpt-5",
        selectedPromptEffort: null,
        modelSelection: { provider: "codex" as const, model: "gpt-5" },
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        envMode: "local" as const,
      };
      useComposerDraftStore
        .getState()
        .enqueueQueuedTurn(
          THREAD_ID,
          kind === "plan-follow-up"
            ? { ...queuedTurn, kind, text: queuedPrompt, interactionMode: "plan" }
            : queuedTurn,
        );
      if (kind === "plan-follow-up") {
        useComposerDraftStore.getState().setInteractionMode(THREAD_ID, "plan");
      }
      // Same tick as the enqueue: the Stop action recorded this turn before it settled.
      useComposerDraftStore.getState().pauseQueuedTurnsAfterStop(THREAD_ID, stoppedTurnId);

      await vi.waitFor(
        () => {
          const notice = document.querySelector('[data-testid="queued-follow-up-paused-notice"]');
          expect(notice?.textContent).toContain("Queue paused");
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(1);
        },
        { timeout: 8_000, interval: 16 },
      );
      // Give the drain a few frames: a held queue must not send on its own.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(sentQueuedPrompt()).toBe(false);
      return mounted;
    }

    it("holds the queue with a notice and sends it after Resume", async () => {
      const restoreNativeApi = installDeterministicSendNativeApi();
      const mounted = await mountPausedQueue();
      try {
        await page.getByRole("button", { name: "Resume", exact: true }).click();

        await vi.waitFor(
          () => {
            expect(sentQueuedPrompt()).toBe(true);
            expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(
              0,
            );
          },
          { timeout: 8_000, interval: 16 },
        );
        expect(
          useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.queueStoppedTurnId ?? null,
        ).toBe(null);
      } finally {
        await mounted.cleanup();
        restoreNativeApi();
      }
    });

    it.each(["chat", "plan-follow-up"] as const)(
      "sends a %s typed by hand first and releases the stop pause",
      async (kind) => {
        const restoreNativeApi = installDeterministicSendNativeApi();
        const mounted = await mountPausedQueue(kind);
        const manualPrompt = "message typed while the queue is paused";
        try {
          useComposerDraftStore.getState().setPrompt(THREAD_ID, manualPrompt);
          const composerEditor = await waitForComposerEditor();
          await vi.waitFor(() => expect(composerEditor.textContent ?? "").toContain(manualPrompt), {
            timeout: 8_000,
            interval: 16,
          });
          if (kind === "plan-follow-up") {
            await userEvent.click(composerEditor);
            await userEvent.keyboard("{Enter}");
          } else {
            const sendButton = await waitForSendButton();
            await vi.waitFor(() => expect(sendButton.disabled).toBe(false), {
              timeout: 8_000,
              interval: 16,
            });
            sendButton.click();
          }

          await vi.waitFor(() => {
            expect(
              wsRequests.some((request) => turnStartText(request)?.includes(manualPrompt) === true),
            ).toBe(true);
          });
          if (kind === "plan-follow-up") {
            await page.screenshot({
              path: "../../../../output/playwright/queue-plan-resume.png",
            });
          }
          await vi.waitFor(
            () => {
              expect(
                wsRequests.some(
                  (request) => turnStartText(request)?.includes(manualPrompt) === true,
                ),
              ).toBe(true);
              expect(
                useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.queueStoppedTurnId ??
                  null,
              ).toBe(null);
            },
            { timeout: 8_000, interval: 16 },
          );
          // The typed message goes first; the queued one waits for that turn to end.
          expect(sentQueuedPrompt()).toBe(false);
        } finally {
          await mounted.cleanup();
          restoreNativeApi();
        }
      },
    );

    it("preserves the last queued item and stop hold when Steer fails", async () => {
      let releaseSend!: () => void;
      const sendBarrier = new Promise<void>((resolve) => {
        releaseSend = resolve;
      });
      const restoreNativeApi = installDeterministicSendNativeApi({
        beforeTurnStart: () => sendBarrier,
        rejectTurnStart: true,
      });
      const mounted = await mountPausedQueue();
      const originalQueue =
        useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]!.queuedTurns;
      try {
        const steer = page.getByRole("button", { name: "Steer", exact: true }).first();
        await steer.click();
        await vi.waitFor(() => expect(sentQueuedPrompt()).toBe(true));
        expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.queuedTurns).toEqual(
          originalQueue,
        );
        expect(
          useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.queueStoppedTurnId,
        ).toBe(stoppedTurnId);
        const acquired = tryBeginQueuedComposerAutoDispatch(THREAD_ID);
        if (acquired) endQueuedComposerAutoDispatch(THREAD_ID);
        expect(acquired).toBe(false);
        await steer.click();
        expect(
          wsRequests.filter((request) => turnStartText(request)?.includes(queuedPrompt)),
        ).toHaveLength(1);
        releaseSend();
        await vi.waitFor(() =>
          expect(document.body.textContent).toContain("Turn start failed for test."),
        );
        expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.queuedTurns).toEqual(
          originalQueue,
        );
        expect(
          useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.queueStoppedTurnId,
        ).toBe(stoppedTurnId);
      } finally {
        releaseSend();
        await mounted.cleanup();
        restoreNativeApi();
      }
    });

    it("releases the stop hold after a queued plan follow-up Steer succeeds", async () => {
      const restoreNativeApi = installDeterministicSendNativeApi();
      const mounted = await mountPausedQueue("plan-follow-up");
      const queuedTurn =
        useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]!.queuedTurns[0]!;
      useComposerDraftStore
        .getState()
        .enqueueQueuedTurn(THREAD_ID, { ...queuedTurn, id: "remaining-plan-follow-up" });
      try {
        await page.getByRole("button", { name: "Steer", exact: true }).first().click();
        await vi.waitFor(() => {
          expect(
            useComposerDraftStore
              .getState()
              .draftsByThreadId[THREAD_ID]?.queuedTurns.map((turn) => turn.id),
          ).toEqual(["remaining-plan-follow-up"]);
          expect(
            useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.queueStoppedTurnId ??
              null,
          ).toBe(null);
        });
        expect(
          wsRequests.filter((request) => turnStartText(request)?.includes(queuedPrompt)),
        ).toHaveLength(1);
      } finally {
        await mounted.cleanup();
        restoreNativeApi();
      }
    });

    it("preserves a newer Stop and a replacement queued item while Steer completes", async () => {
      let releaseSend!: () => void;
      const sendBarrier = new Promise<void>((resolve) => {
        releaseSend = resolve;
      });
      const restoreNativeApi = installDeterministicSendNativeApi({
        beforeTurnStart: () => sendBarrier,
      });
      const mounted = await mountPausedQueue();
      const queuedTurn =
        useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]!.queuedTurns[0]!;
      const newerStoppedTurnId = TurnId.makeUnsafe("newer-stop-while-steering");
      try {
        await page.getByRole("button", { name: "Steer", exact: true }).first().click();
        await vi.waitFor(() => expect(sentQueuedPrompt()).toBe(true));
        useComposerDraftStore
          .getState()
          .enqueueQueuedTurn(THREAD_ID, { ...queuedTurn, id: "edited-queued-turn" });
        useComposerDraftStore.getState().removeQueuedTurn(THREAD_ID, queuedTurn.id);
        useComposerDraftStore.getState().pauseQueuedTurnsAfterStop(THREAD_ID, newerStoppedTurnId);
        releaseSend();
        await vi.waitFor(() => {
          const acquired = tryBeginQueuedComposerAutoDispatch(THREAD_ID);
          if (acquired) endQueuedComposerAutoDispatch(THREAD_ID);
          expect(acquired).toBe(true);
        });
        // Let the accepted turn and its draft effects settle before inspecting newer controls.
        await waitForLayout();
        expect(
          useComposerDraftStore
            .getState()
            .draftsByThreadId[THREAD_ID]?.queuedTurns.map((turn) => turn.id),
        ).toEqual(["edited-queued-turn"]);
        expect(
          useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.queueStoppedTurnId,
        ).toBe(newerStoppedTurnId);
        expect(
          wsRequests.filter((request) => turnStartText(request)?.includes(queuedPrompt)),
        ).toHaveLength(1);
      } finally {
        releaseSend();
        await mounted.cleanup();
        restoreNativeApi();
      }
    });
  });

  it("auto-dispatches a queued chat turn as a chat message even while a plan follow-up is pending", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    const queuedPrompt = "queued chat turn that must stay a chat message";
    const queuedImage = createComposerImage({
      id: "queued-plan-image-1",
      previewUrl: "blob:queued-plan-image-1",
      name: "queued-plan-image.png",
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      // Plan mode, settled turn, actionable proposed plan -> the live composer is
      // showing the plan follow-up prompt at the moment the queue drains.
      snapshot: createSnapshotWithSettledPlanAwaitingFollowUp(),
    });

    try {
      await waitForComposerEditor();
      // Make the live composer's interaction mode explicitly "plan" so the
      // plan-follow-up branch in onSend is live. The queued chat turn below
      // carries its own "default" mode and an image attachment, both of which the
      // misroute (onSubmitPlanFollowUp) would discard.
      useComposerDraftStore.getState().setInteractionMode(THREAD_ID, "plan");
      useComposerDraftStore.getState().enqueueQueuedTurn(THREAD_ID, {
        id: "queued-turn-plan-chat",
        kind: "chat",
        createdAt: NOW_ISO,
        previewText: queuedPrompt,
        prompt: queuedPrompt,
        images: [queuedImage],
        files: [],
        assistantSelections: [],
        browserAnnotations: [],
        terminalContexts: [],
        fileComments: [],
        pastedTexts: [],
        pullRequestContexts: [],
        skills: [],
        mentions: [],
        selectedProvider: "codex",
        selectedModel: "gpt-5",
        selectedPromptEffort: null,
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        envMode: "local",
      });

      await vi.waitFor(
        () => {
          const turnStartRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              typeof request.command === "object" &&
              request.command !== null &&
              "type" in request.command &&
              request.command.type === "thread.turn.start" &&
              "threadId" in request.command &&
              request.command.threadId === THREAD_ID &&
              "message" in request.command &&
              typeof request.command.message === "object" &&
              request.command.message !== null &&
              "text" in request.command.message &&
              typeof request.command.message.text === "string" &&
              request.command.message.text.includes(queuedPrompt),
          );
          expect(turnStartRequest).toBeTruthy();
          const command = turnStartRequest!.command as {
            interactionMode?: unknown;
            message?: { attachments?: Array<{ type?: unknown; name?: unknown }> };
          };
          // Dispatched as a normal chat turn: it keeps the queued turn's own
          // "default" interaction mode rather than being coerced to "plan" by the
          // plan-follow-up path.
          expect(command.interactionMode).toBe("default");
          // ...and the queued image survives instead of being dropped to [].
          const attachments = command.message?.attachments ?? [];
          expect(attachments).toHaveLength(1);
          expect(attachments[0]?.type).toBe("image");
          expect(attachments[0]?.name).toBe("queued-plan-image.png");
          // Queue drained.
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(0);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("auto-dispatches only the queue head until the previous turn is live", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    const firstQueuedPrompt = "queued follow-up A stays the only dispatch";
    const secondQueuedPrompt = "queued follow-up B must wait for the live turn";
    let currentSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-queued-gap-target" as MessageId,
      targetText: "queued gap target",
      sessionStatus: "running",
    });

    const enqueueQueuedChatTurn = (id: string, prompt: string) => {
      useComposerDraftStore.getState().enqueueQueuedTurn(THREAD_ID, {
        id,
        kind: "chat",
        createdAt: NOW_ISO,
        previewText: prompt,
        prompt,
        images: [],
        files: [],
        assistantSelections: [],
        browserAnnotations: [],
        terminalContexts: [],
        fileComments: [],
        pastedTexts: [],
        pullRequestContexts: [],
        skills: [],
        mentions: [],
        selectedProvider: "codex",
        selectedModel: "gpt-5",
        selectedPromptEffort: null,
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        envMode: "local",
      });
    };

    const turnStartCommands = () =>
      wsRequests.flatMap((request) => {
        if (request._tag !== ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return [];
        }
        const command = request.command;
        if (
          typeof command !== "object" ||
          command === null ||
          !("type" in command) ||
          command.type !== "thread.turn.start"
        ) {
          return [];
        }
        return [
          command as {
            threadId?: unknown;
            message?: { messageId?: unknown; text?: unknown };
          },
        ];
      });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: currentSnapshot,
    });

    const syncActiveThread = (
      update: (
        thread: OrchestrationReadModel["threads"][number],
      ) => OrchestrationReadModel["threads"][number],
    ) => {
      currentSnapshot = {
        ...currentSnapshot,
        snapshotSequence: currentSnapshot.snapshotSequence + 1,
        threads: currentSnapshot.threads.map((thread) =>
          thread.id === THREAD_ID ? update(thread) : thread,
        ),
        updatedAt: isoAt(currentSnapshot.snapshotSequence + 1_200),
      };
      fixture = { ...fixture, snapshot: currentSnapshot };
      useStore.getState().syncServerReadModel(currentSnapshot);
    };

    try {
      enqueueQueuedChatTurn("queued-turn-gap-a", firstQueuedPrompt);
      enqueueQueuedChatTurn("queued-turn-gap-b", secondQueuedPrompt);

      await vi.waitFor(
        () => {
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(2);
        },
        { timeout: 8_000, interval: 16 },
      );

      syncActiveThread((thread) => ({
        ...thread,
        session: thread.session
          ? {
              ...thread.session,
              status: "ready",
              activeTurnId: null,
              updatedAt: isoAt(1_200),
            }
          : null,
        updatedAt: isoAt(1_200),
      }));

      const firstCommand = await vi.waitFor(
        () => {
          const match = turnStartCommands().find((command) =>
            String(command.message?.text ?? "").includes(firstQueuedPrompt),
          );
          expect(match, "first queued turn should auto-dispatch").toBeTruthy();
          return match!;
        },
        { timeout: 8_000, interval: 16 },
      );
      const sentMessageId = String(firstCommand.message?.messageId ?? "");
      expect(sentMessageId, "dispatched user message id").not.toBe("");

      const requestedTurnId = TurnId.makeUnsafe("turn-queued-gap");
      syncActiveThread((thread) => ({
        ...thread,
        messages: [
          ...thread.messages,
          {
            id: MessageId.makeUnsafe(sentMessageId),
            role: "user" as const,
            text: firstQueuedPrompt,
            turnId: requestedTurnId,
            streaming: false,
            source: "native" as const,
            createdAt: isoAt(1_300),
            updatedAt: isoAt(1_300),
          },
        ],
        latestTurn: {
          turnId: requestedTurnId,
          state: "running",
          requestedAt: isoAt(1_300),
          startedAt: null,
          completedAt: null,
          assistantMessageId: null,
        },
        session: thread.session
          ? {
              ...thread.session,
              status: "ready",
              activeTurnId: null,
              updatedAt: isoAt(1_300),
            }
          : null,
        updatedAt: isoAt(1_300),
      }));

      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 500);
      });

      expect(turnStartCommands()).toHaveLength(1);
      expect(String(turnStartCommands()[0]?.message?.text ?? "")).toContain(firstQueuedPrompt);
      expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(1);
      expect(document.body.textContent).toContain(secondQueuedPrompt);

      syncActiveThread((thread) => ({
        ...thread,
        latestTurn: thread.latestTurn
          ? {
              ...thread.latestTurn,
              startedAt: isoAt(1_301),
            }
          : thread.latestTurn,
        session: thread.session
          ? {
              ...thread.session,
              status: "running",
              activeTurnId: requestedTurnId,
              updatedAt: isoAt(1_301),
            }
          : null,
        updatedAt: isoAt(1_301),
      }));

      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 400);
      });

      expect(turnStartCommands()).toHaveLength(1);
      expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(1);
      expect(document.body.textContent).toContain(secondQueuedPrompt);
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it.each([
    { envMode: "local", intent: "send" },
    { envMode: "worktree", intent: "send" },
    { envMode: "worktree", intent: "compose" },
  ] as const)(
    "moves a selected quote through the mini composer ($envMode, $intent)",
    async ({ envMode, intent }) => {
      const restoreNativeApi = installDeterministicSendNativeApi();
      const snapshot = createSnapshotForTargetUser({
        targetMessageId: "msg-user-selection-composer" as MessageId,
        targetText: "Selection composer test",
      });
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: {
          ...snapshot,
          threads: snapshot.threads.map((thread) => ({
            ...thread,
            messages: thread.messages.slice(-2),
          })),
        },
      });
      try {
        useComposerDraftStore.getState().setPrompt(THREAD_ID, "Keep the current draft");
        const composerEditor = await waitForComposerEditor();
        await vi.waitFor(() =>
          expect(composerEditor.textContent).toContain("Keep the current draft"),
        );
        await waitForLayout();
        const source = page.getByText("assistant filler 21", { exact: true });
        await expect.element(source).toBeVisible();
        expect(source.element().closest("[data-assistant-message-id]")).not.toBeNull();
        await source.click();
        const sourceNode = source.element();
        const range = document.createRange();
        range.selectNodeContents(sourceNode);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
        const rect = range.getBoundingClientRect();
        sourceNode.dispatchEvent(
          new MouseEvent("mouseup", {
            bubbles: true,
            clientX: rect.right,
            clientY: rect.bottom,
          }),
        );
        await expect
          .element(page.getByRole("button", { name: "Add to new Chat", exact: true }))
          .toBeVisible();
        await page.getByRole("button", { name: "Add to new Chat", exact: true }).click();
        const miniInput = page.getByRole("textbox", { name: "Message for new chat" });
        await expect.element(miniInput).toHaveFocus();
        await miniInput.fill("Explain this selected passage");
        const miniComposer = page.getByRole("dialog", { name: "New chat from selection" });
        const environmentChip = miniComposer.getByRole("button", { name: /^(Local|Worktree)$/ });
        await environmentChip.click();
        await page
          .getByRole("menuitem", {
            name: envMode === "local" ? "Local project" : "New worktree",
            exact: true,
          })
          .click();
        wsRequests.length = 0;
        await page
          .getByRole("button", {
            name: intent === "send" ? "Send to new chat" : "Open in chat",
            exact: true,
          })
          .click();
        if (intent === "compose") {
          const path = await waitForURL(
            mounted.router,
            (path) => UUID_ROUTE_RE.test(path),
            "Open in chat should select a fresh draft.",
          );
          const draftId = ThreadId.makeUnsafe(path.slice(1));
          const editor = await waitForComposerEditor();
          await vi.waitFor(() => {
            expect(editor.textContent).toBe("Explain this selected passage");
            expect(document.activeElement).toBe(editor);
            const drafts = useComposerDraftStore.getState();
            expect(drafts.draftsByThreadId[draftId]?.assistantSelections[0]?.text).toBe(
              "assistant filler 21",
            );
            expect(drafts.getDraftThread(draftId)?.envMode).toBe(envMode);
            expect(drafts.draftsByThreadId[draftId]?.queuedTurns).toHaveLength(0);
          });
          expect(
            wsRequests
              .map(readDispatchedCommand)
              .some((command) => command?.type === "thread.turn.start"),
          ).toBe(false);
        } else
          await vi.waitFor(
            () => {
              const commands = wsRequests
                .map(readDispatchedCommand)
                .filter((command) => command !== null);
              const create = commands.find((command) => command.type === "thread.create");
              const send = commands.find((command) => command.type === "thread.turn.start");
              expect(create).toMatchObject({ projectId: PROJECT_ID, envMode });
              expect(create?.threadId).not.toBe(THREAD_ID);
              expect(send).toMatchObject({ threadId: create?.threadId });
              const message = send?.message as { text?: string } | undefined;
              const text = String(message?.text ?? "");
              expect(text).toContain("Explain this selected passage");
              expect(text).toContain("assistant filler 21");
              expect(text).toContain("<assistant_selection>");
              expect(
                commands.filter((command) => command.type === "thread.turn.start"),
              ).toHaveLength(1);
              expect(
                wsRequests.some((request) => request._tag === WS_METHODS.gitCreateDetachedWorktree),
              ).toBe(envMode === "worktree");
              if (envMode === "worktree") {
                expect(create?.worktreePath).toBeNull();
                const linkedWorkspace = commands.find(
                  (command) =>
                    command.type === "thread.meta.update" &&
                    command.threadId === create?.threadId &&
                    typeof command.worktreePath === "string",
                );
                expect(linkedWorkspace?.worktreePath).toContain("/repo/.codex/worktrees/");
                expect(commands.indexOf(linkedWorkspace!)).toBeLessThan(commands.indexOf(send!));
              } else {
                expect(create?.worktreePath).toBeNull();
              }
            },
            { timeout: 15_000 },
          );
        expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
          "Keep the current draft",
        );
        expect(useProjectEnvironmentStore.getState().envModeByProjectId[PROJECT_ID]).toBe(envMode);
      } finally {
        window.getSelection()?.removeAllRanges();
        await mounted.cleanup();
        restoreNativeApi();
      }
    },
  );

  it("keeps a failed selection send queued without a stale optimistic message", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi({ rejectTurnStart: true });
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-selection-composer-failed-send" as MessageId,
      targetText: "Selection composer failed send test",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        threads: snapshot.threads.map((thread) => ({
          ...thread,
          messages: thread.messages.slice(-2),
        })),
      },
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "Keep the source draft");
      await waitForLayout();
      const source = page.getByText("assistant filler 21", { exact: true });
      await expect.element(source).toBeVisible();
      await source.click();
      const sourceNode = source.element();
      const range = document.createRange();
      range.selectNodeContents(sourceNode);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      const rect = range.getBoundingClientRect();
      sourceNode.dispatchEvent(
        new MouseEvent("mouseup", {
          bubbles: true,
          clientX: rect.right,
          clientY: rect.bottom,
        }),
      );

      await page.getByRole("button", { name: "Add to new Chat", exact: true }).click();
      const prompt = "Retry this selected passage";
      await page.getByRole("textbox", { name: "Message for new chat" }).fill(prompt);
      wsRequests.length = 0;
      await page.getByRole("button", { name: "Send to new chat", exact: true }).click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "A failed selection send should remain on its fresh draft.",
      );
      const newThreadId = ThreadId.makeUnsafe(newThreadPath.slice(1));
      await vi.waitFor(
        () => {
          const draft = useComposerDraftStore.getState().draftsByThreadId[newThreadId];
          expect(draft?.queuedTurns).toHaveLength(1);
          expect(draft?.queuedTurns[0]).toMatchObject({
            kind: "chat",
            prompt,
            assistantSelections: [{ text: "assistant filler 21" }],
          });
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
            "Keep the source draft",
          );
          expect(
            wsRequests
              .map(readDispatchedCommand)
              .filter((command) => command?.type === "thread.turn.start"),
          ).toHaveLength(1);
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(1);
          const staleOptimisticRows = Array.from(
            document.querySelectorAll<HTMLElement>('[data-message-role="user"]'),
          ).filter((row) => row.textContent?.includes(prompt));
          expect(staleOptimisticRows).toHaveLength(0);
        },
        { timeout: 8_000, interval: 16 },
      );
      await new Promise<void>((resolve) => window.setTimeout(resolve, 500));
      expect(
        wsRequests
          .map(readDispatchedCommand)
          .filter((command) => command?.type === "thread.turn.start"),
      ).toHaveLength(1);
    } finally {
      window.getSelection()?.removeAllRanges();
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("keeps a new draft out of horizontal tabs until it becomes a saved thread", async () => {
    useOpenThreadTabsStore.setState({ threadIds: [] });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-new-thread-test" as MessageId,
        targetText: "new thread selection test",
      }),
    });

    try {
      // Wait for the sidebar to render with the project.
      const newThreadButton = page.getByLabelText("Create new thread in Project");
      await expect.element(newThreadButton).toBeInTheDocument();

      await newThreadButton.click();

      // The route should change to a new draft thread ID.
      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      // The composer editor should be present for the new draft thread.
      await waitForComposerEditor();

      await vi.waitFor(() => {
        const tabs = document.querySelectorAll('nav[aria-label="Open threads"] [data-surface-tab]');
        expect(tabs).toHaveLength(1);
        expect(
          document.querySelector('nav[aria-label="Open threads"] button[title="New thread"]'),
        ).toBeNull();
        expect(
          document.querySelector('nav[aria-label="Open threads"] button[aria-current="page"]'),
        ).toBeNull();
      });

      // Simulate the snapshot sync arriving from the server after the draft
      // thread has been promoted to a server thread (thread.create + turn.start
      // succeeded). The snapshot now includes the new thread, and the sync
      // should clear the draft without disrupting the route.
      const { syncServerReadModel } = useStore.getState();
      syncServerReadModel(addThreadToSnapshot(fixture.snapshot, newThreadId));

      // Clear the draft now that the server thread exists (mirrors EventRouter behavior).
      useComposerDraftStore.getState().clearDraftThread(newThreadId);

      // The route should still be on the new thread — not redirected away.
      await waitForURL(
        mounted.router,
        (path) => path === newThreadPath,
        "New thread should remain selected after snapshot sync clears the draft.",
      );

      await vi.waitFor(() => {
        expect(
          document.querySelectorAll('nav[aria-label="Open threads"] [data-surface-tab]'),
        ).toHaveLength(2);
        expect(
          document.querySelector('nav[aria-label="Open threads"] button[aria-current="page"]'),
        ).not.toBeNull();
      });

      // The empty thread view and composer should still be visible.
      await expect.element(page.getByTestId("composer-editor")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("uses the latest ordinary project from Home when the global New thread button is clicked", async () => {
    useLatestProjectStore.setState({ latestProjectId: PROJECT_ID });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withActiveHomeChatThread(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-global-new-thread-latest-project" as MessageId,
          targetText: "global new thread latest project",
        }),
      ),
    });

    try {
      const newThreadButton = page.getByRole("button", { name: "New thread", exact: true });
      await expect.element(newThreadButton).toBeInTheDocument();
      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Global New thread should create a draft in the latest ordinary project.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;
      expect(useComposerDraftStore.getState().getDraftThread(newThreadId)?.projectId).toBe(
        PROJECT_ID,
      );
      await expect.element(page.getByText("Type path", { exact: true })).not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens Add project when the global New thread action has no usable project target", async () => {
    useLatestProjectStore.setState({ latestProjectId: PROJECT_ID });
    const snapshot = withActiveHomeChatThread(
      createSnapshotForTargetUser({
        targetMessageId: "msg-user-global-new-thread-no-project" as MessageId,
        targetText: "global new thread no project",
      }),
    );
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        projects: snapshot.projects.filter((project) => project.kind !== "project"),
      },
    });

    try {
      const initialPath = mounted.router.state.location.pathname;
      const newThreadButton = page.getByRole("button", { name: "New thread", exact: true });
      await expect.element(newThreadButton).toBeInTheDocument();
      await newThreadButton.click();

      await expect
        .element(page.getByRole("heading", { name: "Create project" }))
        .toBeInTheDocument();
      expect(mounted.router.state.location.pathname).toBe(initialPath);
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not open Add project before project hydration completes", async () => {
    useLatestProjectStore.setState({ latestProjectId: PROJECT_ID });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withActiveHomeChatThread(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-global-new-thread-before-hydration" as MessageId,
          targetText: "global new thread before hydration",
        }),
      ),
    });

    try {
      useStore.setState({ projects: [], threadsHydrated: false });
      await waitForLayout();
      const initialPath = mounted.router.state.location.pathname;
      const newThreadButton = page.getByRole("button", { name: "New thread", exact: true });
      await expect.element(newThreadButton).toBeInTheDocument();
      await newThreadButton.click();
      await waitForLayout();

      await expect
        .element(page.getByRole("heading", { name: "Create project" }))
        .not.toBeInTheDocument();
      expect(mounted.router.state.location.pathname).toBe(initialPath);
    } finally {
      await mounted.cleanup();
    }
  });

  it("lets an empty project draft switch to another open project", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withOpenProjectPickerFixtures(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-project-picker-switch-test" as MessageId,
          targetText: "project picker switch test",
        }),
      ),
    });

    try {
      const newThreadButton = page.getByLabelText("Create new thread in Project");
      await expect.element(newThreadButton).toBeInTheDocument();
      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      useComposerDraftStore.getState().setDraftThreadContext(newThreadId, {
        envMode: "worktree",
        branch: "feature/keep-out",
        worktreePath: "/repo/project/.worktrees/feature-keep-out",
      });
      useComposerDraftStore.getState().setProjectDraftThreadId(OTHER_PROJECT_ID, OTHER_THREAD_ID);
      useComposerDraftStore.getState().setPrompt(OTHER_THREAD_ID, "replace this other draft");

      const projectPickerTrigger = page.getByTestId("project-picker-trigger");
      await expect.element(projectPickerTrigger).toHaveTextContent("project");
      const inlineResetButton = page.getByTestId("project-picker-reset-trigger");
      const inlineFolderIcon = projectPickerTrigger
        .element()
        .querySelector<HTMLElement>("[class*='transition-opacity']");
      expect(inlineFolderIcon).not.toBeNull();
      // Opening the draft autofocuses the composer on a later frame; let that settle so it
      // cannot steal focus back between focusing the trigger and pressing Tab.
      await vi.waitFor(() => {
        expect(page.getByTestId("composer-editor").element().contains(document.activeElement)).toBe(
          true,
        );
      });
      projectPickerTrigger.element().focus();
      await vi.waitFor(() => {
        expect(getComputedStyle(inlineResetButton.element()).opacity).toBe("0");
        expect(getComputedStyle(inlineFolderIcon!).opacity).toBe("1");
      });
      await userEvent.keyboard("{Tab}");
      await vi.waitFor(() => {
        expect(document.activeElement).toBe(inlineResetButton.element());
        expect(getComputedStyle(inlineResetButton.element()).opacity).toBe("1");
        expect(getComputedStyle(inlineFolderIcon!).opacity).toBe("0");
      });
      await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
      await vi.waitFor(() => {
        expect(document.activeElement).toBe(projectPickerTrigger.element());
        expect(getComputedStyle(inlineResetButton.element()).opacity).toBe("0");
        expect(getComputedStyle(inlineFolderIcon!).opacity).toBe("1");
      });
      await userEvent.keyboard("{Enter}");

      await expect.element(page.getByText("New project")).toBeInTheDocument();
      await expect.element(page.getByText("Don't work in a project")).toBeInTheDocument();
      await expect.element(page.getByText(/Folders on this/)).not.toBeInTheDocument();
      await page.getByText("New project").hover();
      await vi.waitFor(() => {
        expect(getComputedStyle(inlineResetButton.element()).opacity).toBe("0");
      });

      const currentProjectOption = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="combobox-item"]')).find(
            (item) => item.textContent?.trim() === "project",
          ) ?? null,
        "Unable to find current project option.",
      );
      currentProjectOption.click();
      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
            projectId: PROJECT_ID,
            envMode: "worktree",
            branch: "feature/keep-out",
            worktreePath: "/repo/project/.worktrees/feature-keep-out",
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await projectPickerTrigger.click();
      await page.getByText("other", { exact: true }).click();

      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
            projectId: OTHER_PROJECT_ID,
            envMode: "local",
            branch: null,
            worktreePath: null,
          });
          expect(useComposerDraftStore.getState().getDraftThread(OTHER_THREAD_ID)).toBeNull();
          expect(
            useComposerDraftStore.getState().draftsByThreadId[OTHER_THREAD_ID],
          ).toBeUndefined();
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(mounted.router.state.location.pathname).toBe(newThreadPath);
    } finally {
      await mounted.cleanup();
    }
  });

  it("focuses and keyboard-selects from the new-thread project picker", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withOpenProjectPickerFixtures(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-project-picker-keyboard-test" as MessageId,
          targetText: "project picker keyboard test",
        }),
      ),
    });

    try {
      await page.getByLabelText("Create new thread in Project").click();
      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      await page.getByTestId("project-picker-trigger").click();
      const searchInput = page.getByPlaceholder("Search projects");
      await vi.waitFor(() => {
        expect(document.activeElement).toBe(searchInput.element());
      });

      await searchInput.fill("oth");
      await userEvent.keyboard("{ArrowDown}{Enter}");

      await vi.waitFor(() => {
        expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
          projectId: OTHER_PROJECT_ID,
        });
      });
      expect(mounted.router.state.location.pathname).toBe(newThreadPath);
    } finally {
      await mounted.cleanup();
    }
  });

  it.each(["/hubs", "/groups", "/studio"])(
    "restores the saved hub draft from %s and coalesces repeated new-chat clicks",
    async (initialEntry) => {
      useComposerDraftStore.setState({
        draftThreadsByThreadId: {
          [STUDIO_DRAFT_THREAD_ID]: {
            projectId: STUDIO_PROJECT_ID,
            createdAt: NOW_ISO,
            runtimeMode: "full-access",
            interactionMode: "default",
            entryPoint: "chat",
            branch: null,
            worktreePath: null,
            envMode: "local",
          },
        },
        projectDraftThreadIdByProjectId: {
          [STUDIO_PROJECT_ID]: STUDIO_DRAFT_THREAD_ID,
        },
      });

      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        // Keep one non-group server thread in the snapshot. This matches the real failure: Groups
        // has no persisted chats, while the global missing-thread recovery sees known threads and
        // immediately redirects a transiently-cleared group draft to the home index.
        snapshot: withStudioProject(
          withHomeChatProject(
            createSnapshotForTargetUser({
              targetMessageId: "msg-user-studio-draft-regression" as MessageId,
              targetText: "projects-side thread",
            }),
          ),
        ),
        initialEntry,
        configureFixture: (nextFixture) => {
          nextFixture.welcome = {
            ...nextFixture.welcome,
            homeDir: "/Users/tester",
            chatWorkspaceRoot: "/Users/tester/Documents/Synara",
            studioWorkspaceRoot: "/Users/tester/Documents/Synara/Studio",
            groupsWorkspaceRoot: "/Users/tester/Documents/Synara/Groups",
          };
        },
      });

      try {
        expect(mounted.router.state.location.pathname).toBe(`/${STUDIO_DRAFT_THREAD_ID}`);
        expect(
          useComposerDraftStore.getState().getDraftThread(STUDIO_DRAFT_THREAD_ID)?.projectId,
        ).toBe(STUDIO_PROJECT_ID);
        // Fire the surface-aware new-chat chord twice: on the Groups segment it maps to
        // the group chat create path, and the second fire must coalesce with the first.
        await dispatchConfiguredShortcutWhenReady(window, { key: "n", altKey: true });
        await dispatchConfiguredShortcutWhenReady(window, { key: "n", altKey: true });

        const newThreadPath = await waitForURL(
          mounted.router,
          (path) => UUID_ROUTE_RE.test(path),
          "A fresh hub chat should navigate to a new draft UUID.",
        );
        const newThreadId = newThreadPath.slice(1) as ThreadId;

        await vi.waitFor(
          () => {
            expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
              projectId: STUDIO_PROJECT_ID,
              entryPoint: "chat",
              envMode: "local",
              branch: null,
              worktreePath: null,
              workingDirectory: null,
            });
            expect(
              document.querySelector('[data-testid="workspace-picker-trigger"]'),
            ).not.toBeNull();
            expect(
              useComposerDraftStore.getState().projectDraftThreadIdByProjectId[HOME_PROJECT_ID],
            ).toBeUndefined();
            expect(mounted.router.state.location.pathname).toBe(newThreadPath);
          },
          { timeout: 8_000, interval: 16 },
        );

        await page.getByTestId("workspace-picker-trigger").click();
        const projectFolderOption = await waitForElement(
          () =>
            Array.from(document.querySelectorAll<HTMLElement>('[data-slot="combobox-item"]')).find(
              (item) => item.textContent?.trim() === "project",
            ) ?? null,
          "Unable to find the reference folder option.",
        );
        projectFolderOption.click();
        await vi.waitFor(
          () => {
            expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
              projectId: STUDIO_PROJECT_ID,
              envMode: "local",
              branch: null,
              worktreePath: null,
              workingDirectory: "/repo/project",
            });
          },
          { timeout: 8_000, interval: 16 },
        );

        // A superseded navigation resolves the older navigate() promise before the newer route has
        // committed. Give route effects enough time to expose a late Home redirect, then assert the
        // stable final state and cleanup of the displaced group draft.
        await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
        await vi.waitFor(
          () => {
            const state = useComposerDraftStore.getState();
            const studioDraftIds = Object.entries(state.draftThreadsByThreadId)
              .filter(([, draft]) => draft.projectId === STUDIO_PROJECT_ID)
              .map(([threadId]) => threadId);
            expect(mounted.router.state.status).toBe("idle");
            expect(mounted.router.state.location.pathname).toBe(newThreadPath);
            expect(state.getDraftThread(STUDIO_DRAFT_THREAD_ID)).toBeNull();
            expect(studioDraftIds).toEqual([newThreadId]);
            expect(state.projectDraftThreadIdByProjectId[STUDIO_PROJECT_ID]).toBe(newThreadId);
            expect(state.projectDraftThreadIdByProjectId[HOME_PROJECT_ID]).toBeUndefined();
          },
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("keeps hub suggestions above the composer as image attachments change", async () => {
    const previousSummaries = useProjectAgentSummariesStore.getState();
    const previousClosedPanels = useGroupPanelClosedStore.getState();
    const snapshot = withStudioProject(
      createSnapshotForTargetUser({
        targetMessageId: "msg-hub-welcome" as MessageId,
        targetText: "Welcome to your Hub",
      }),
    );
    const hubSnapshot = {
      ...snapshot,
      threads: snapshot.threads.map((thread) =>
        thread.id === THREAD_ID
          ? {
              ...thread,
              projectId: STUDIO_PROJECT_ID,
              messages: [
                createAssistantMessage({
                  id: "msg-hub-welcome" as MessageId,
                  text: "Welcome to your Hub. Connect repositories, set a goal, or add instructions to get started.",
                  offsetSeconds: 0,
                }),
              ],
            }
          : thread,
      ),
    };
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: hubSnapshot,
      configureFixture: (nextFixture) => {
        nextFixture.welcome = {
          ...nextFixture.welcome,
          studioWorkspaceRoot: "/Users/tester/Documents/Synara/Studio",
        };
        nextFixture.projectAgentOverviews[STUDIO_PROJECT_ID] = {
          projectId: STUDIO_PROJECT_ID,
          configured: true,
          config: {
            projectId: STUDIO_PROJECT_ID,
            coordinatorThreadId: THREAD_ID,
            coordinatorName: "Studio lead",
            coordinatorModelSelection: { provider: "codex", model: "gpt-5" },
            workerRouting: {
              modelSelection: { provider: "claudeAgent", model: "claude-opus-4-5" },
              providerOptions: { claudeAgent: { enableArtifacts: true } },
            },
            limits: {
              maxConcurrentWorkers: 8,
              maxNewWorkersPerTurn: 8,
              maxWorkerCreationsPerGoal: 40,
              maxAutomaticContinuationsPerGoal: 20,
              maxRepairRoundsPerTask: 2,
            },
            captureEnabled: true,
            enabled: true,
            automationId: null,
            revision: 1,
            createdAt: NOW_ISO,
            updatedAt: NOW_ISO,
            disabledAt: null,
          },
          linkedProjectIds: [],
          goal: null,
          digest: null,
          blockers: [],
          recentOutcomes: [],
          coordinatorStatus: "idle",
        };
      },
    });
    try {
      useProjectAgentSummariesStore
        .getState()
        .applyOverview(fixture.projectAgentOverviews[STUDIO_PROJECT_ID] as ProjectAgentOverview);
      await page.getByRole("button", { name: "Close hub panel", exact: true }).click();
      for (const viewport of [DEFAULT_VIEWPORT, { name: "narrow", width: 480, height: 640 }]) {
        await mounted.setViewport(viewport);
        for (const count of [0, 1, 4, 0]) {
          useComposerDraftStore.getState().clearComposerContent(THREAD_ID);
          for (let index = 0; index < count; index += 1) {
            useComposerDraftStore.getState().addImage(
              THREAD_ID,
              createComposerImage({
                id: `hub-image-${index}`,
                name: `reference-${index + 1}.png`,
                previewUrl: `data:image/svg+xml,${encodeURIComponent(ATTACHMENT_SVG)}`,
              }),
            );
          }
          await vi.waitFor(() => {
            expect(document.querySelectorAll('img[alt^="reference-"]')).toHaveLength(count);
            const surface = document.querySelector(".chat-composer-surface")!;
            const top = surface.getBoundingClientRect().top;
            for (const label of ["Connect repositories", "Add a goal", "Write instructions"]) {
              const button = [...document.querySelectorAll("button")].find(
                (node) => node.textContent === label,
              );
              expect(button).toBeDefined();
              const rect = button!.getBoundingClientRect();
              expect(rect.top).toBeGreaterThanOrEqual(0);
              expect(rect.bottom).toBeLessThanOrEqual(top - 4);
              expect(
                button!.contains(
                  document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
                ),
              ).toBe(true);
            }
          });
          if (count === 4) {
            for (const label of ["Connect repositories", "Add a goal", "Write instructions"]) {
              const button = page.getByRole("button", { name: label, exact: true });
              (button.element() as HTMLButtonElement).focus();
              expect(document.activeElement).toBe(button.element());
              if (label === "Connect repositories") await button.click();
              else await userEvent.keyboard("{Enter}");
              await expect.element(page.getByRole("dialog")).toBeVisible();
              await userEvent.keyboard("{Escape}");
              await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
            }
          }
        }
      }
    } finally {
      await mounted.cleanup();
      useProjectAgentSummariesStore.setState(previousSummaries);
      useGroupPanelClosedStore.setState(previousClosedPanels);
    }
  });

  it("seeds a fresh hub chat draft from the hub's workerRouting", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [STUDIO_DRAFT_THREAD_ID]: {
          projectId: STUDIO_PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          entryPoint: "chat",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      projectDraftThreadIdByProjectId: {
        [STUDIO_PROJECT_ID]: STUDIO_DRAFT_THREAD_ID,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withStudioProject(
        withHomeChatProject(
          createSnapshotForTargetUser({
            targetMessageId: "msg-user-group-routing" as MessageId,
            targetText: "projects-side thread",
          }),
        ),
      ),
      initialEntry: `/${STUDIO_DRAFT_THREAD_ID}`,
      configureFixture: (nextFixture) => {
        nextFixture.welcome = {
          ...nextFixture.welcome,
          homeDir: "/Users/tester",
          chatWorkspaceRoot: "/Users/tester/Documents/Synara",
          studioWorkspaceRoot: "/Users/tester/Documents/Synara/Studio",
        };
        nextFixture.projectAgentOverviews[STUDIO_PROJECT_ID] = {
          projectId: STUDIO_PROJECT_ID,
          configured: true,
          config: {
            projectId: STUDIO_PROJECT_ID,
            coordinatorThreadId: "thread-studio-coordinator" as ThreadId,
            coordinatorName: "Studio lead",
            coordinatorModelSelection: { provider: "codex", model: "gpt-5" },
            workerRouting: {
              modelSelection: { provider: "claudeAgent", model: "claude-opus-4-5" },
              providerOptions: { claudeAgent: { enableArtifacts: true } },
            },
            limits: {
              maxConcurrentWorkers: 8,
              maxNewWorkersPerTurn: 8,
              maxWorkerCreationsPerGoal: 40,
              maxAutomaticContinuationsPerGoal: 20,
              maxRepairRoundsPerTask: 2,
            },
            captureEnabled: true,
            enabled: true,
            automationId: null,
            revision: 1,
            createdAt: NOW_ISO,
            updatedAt: NOW_ISO,
            disabledAt: null,
          },
          linkedProjectIds: [],
          goal: null,
          digest: null,
          blockers: [],
          recentOutcomes: [],
          coordinatorStatus: "idle",
        };
      },
    });

    try {
      await dispatchConfiguredShortcutWhenReady(window, { key: "n", altKey: true });

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "A fresh hub chat should navigate to a new draft UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      // The group's coordinator workerRouting beats the app-level sticky/default
      // selection: the fresh draft dispatches on the group's configured provider.
      await vi.waitFor(
        () => {
          const draft = useComposerDraftStore.getState().draftsByThreadId[newThreadId];
          expect(draft?.activeProvider).toBe("claudeAgent");
          expect(draft?.modelSelectionByProvider.claudeAgent?.model).toBe("claude-opus-4-5");
          expect(draft?.providerOptionsForDispatch).toEqual({
            claudeAgent: { enableArtifacts: true },
          });
          expect(useComposerDraftStore.getState().getDraftThread(newThreadId)?.projectId).toBe(
            STUDIO_PROJECT_ID,
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps a hub thread open when the Hubs section is hidden", async () => {
    localStorage.setItem("synara:app-settings:v1", JSON.stringify({ showGroupsSection: false }));
    const groupProjectId = "project-group-alpha" as ProjectId;
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-group-thread-hidden-tab" as MessageId,
      targetText: "hub thread",
    });
    const groupSnapshot: OrchestrationReadModel = {
      ...snapshot,
      projects: [
        ...snapshot.projects,
        {
          id: groupProjectId,
          kind: "group",
          title: "Team Alpha",
          workspaceRoot: "/Users/tester/Groups/team-alpha",
          defaultModelSelection: { provider: "codex", model: "gpt-5" },
          scripts: [],
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
          deletedAt: null,
        },
      ],
      threads: snapshot.threads.map((thread) =>
        thread.id === THREAD_ID ? Object.assign({}, thread, { projectId: groupProjectId }) : thread,
      ),
    };

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: groupSnapshot,
      initialEntry: `/${THREAD_ID}`,
      configureFixture: (nextFixture) => {
        nextFixture.welcome = {
          ...nextFixture.welcome,
          homeDir: "/Users/tester",
          chatWorkspaceRoot: "/Users/tester/Documents/Synara",
          studioWorkspaceRoot: "/Users/tester/Documents/Synara/Studio",
          groupsWorkspaceRoot: "/Users/tester/Groups",
        };
      },
    });
    try {
      // The hidden-section guard belongs to the /hubs route alone: a hub
      // thread opened from search, split view, or a link stays on its route.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 400));
      await vi.waitFor(
        () => {
          expect(mounted.router.state.status).toBe("idle");
          expect(mounted.router.state.location.pathname).toBe(`/${THREAD_ID}`);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("can detach an empty project draft back to a normal chat before first send", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withHomeChatProject(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-project-picker-home-test" as MessageId,
          targetText: "project picker home test",
        }),
      ),
      configureFixture: (nextFixture) => {
        nextFixture.welcome = {
          ...nextFixture.welcome,
          homeDir: "/Users/tester",
          chatWorkspaceRoot: "/Users/tester/Documents/Synara",
        };
      },
    });

    try {
      const newThreadButton = page.getByLabelText("Create new thread in Project");
      await expect.element(newThreadButton).toBeInTheDocument();
      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      expect(document.activeElement).toBe(composerEditor);
      const projectPickerTrigger = page.getByTestId("project-picker-trigger");
      await expect.element(projectPickerTrigger).toBeInTheDocument();
      const resetProjectButton = page.getByTestId("project-picker-reset-trigger");
      // Re-query on every check: crossing the mobile breakpoint can remount the composer and
      // detach any node held from before.
      const queryFolderIcon = () =>
        projectPickerTrigger.element().querySelector<HTMLElement>("[class*='transition-opacity']");
      expect(queryFolderIcon()).not.toBeNull();
      const expectResetAlignedWithFolderIcon = () => {
        const folderIconRect = queryFolderIcon()!.getBoundingClientRect();
        const resetButtonRect = resetProjectButton.element().getBoundingClientRect();
        const folderIconCenterX = folderIconRect.left + folderIconRect.width / 2;
        const resetButtonCenterX = resetButtonRect.left + resetButtonRect.width / 2;
        expect(Math.abs(resetButtonCenterX - folderIconCenterX)).toBeLessThanOrEqual(0.5);
      };
      const temporaryChatButton = page.getByLabelText("Temporary chat");
      await temporaryChatButton.hover();
      const temporaryChatElement = temporaryChatButton.element();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 200));
      const temporaryHoverBackground = getComputedStyle(temporaryChatElement).backgroundColor;
      const temporaryCapsuleRadius = getComputedStyle(temporaryChatElement).borderRadius;
      const temporaryCapsulePadding = getComputedStyle(temporaryChatElement).paddingInlineStart;
      await projectPickerTrigger.hover();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 200));
      await vi.waitFor(() => {
        expect(getComputedStyle(resetProjectButton.element()).opacity).toBe("1");
        expect(getComputedStyle(projectPickerTrigger.element()).backgroundColor).toBe(
          temporaryHoverBackground,
        );
      });
      expectResetAlignedWithFolderIcon();
      expect(getComputedStyle(projectPickerTrigger.element()).borderRadius).toBe(
        temporaryCapsuleRadius,
      );
      expect(getComputedStyle(projectPickerTrigger.element()).paddingInlineStart).toBe(
        temporaryCapsulePadding,
      );
      expect(projectPickerTrigger.element().getBoundingClientRect().height).toBe(
        temporaryChatElement.getBoundingClientRect().height,
      );
      await resetProjectButton.hover();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 200));
      await vi.waitFor(() => {
        expect(getComputedStyle(projectPickerTrigger.element()).backgroundColor).toBe(
          temporaryHoverBackground,
        );
      });
      await mounted.setViewport(TEXT_VIEWPORT_MATRIX[2]);
      await projectPickerTrigger.hover();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      expectResetAlignedWithFolderIcon();
      await mounted.setViewport(DEFAULT_VIEWPORT);
      // The round trip through the mobile breakpoint remounted the composer; the reset below
      // must keep focus in the one now on screen.
      const settledComposerEditor = await waitForComposerEditor();
      settledComposerEditor.focus();

      const originalRequestAnimationFrame = window.requestAnimationFrame;
      let frameRequestCount = 0;
      window.requestAnimationFrame = (callback) => {
        frameRequestCount += 1;
        return originalRequestAnimationFrame(callback);
      };
      try {
        await resetProjectButton.click();
        await vi.waitFor(
          () => {
            expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
              projectId: HOME_PROJECT_ID,
              envMode: "local",
              branch: null,
              worktreePath: null,
            });
          },
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        window.requestAnimationFrame = originalRequestAnimationFrame;
      }

      expect(frameRequestCount).toBe(0);
      expect(document.activeElement).toBe(settledComposerEditor);
      await expect.element(page.getByText("Don't work in a project")).not.toBeInTheDocument();
      await expect.element(page.getByTestId("workspace-picker-trigger")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("moves a home draft into an existing project from the home picker without carrying branch", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: HOME_PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          entryPoint: "chat",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      projectDraftThreadIdByProjectId: {
        [HOME_PROJECT_ID]: THREAD_ID,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withStudioProject(withHomeChatProject(createDraftOnlySnapshot())),
      configureFixture: (nextFixture) => {
        nextFixture.welcome = {
          ...nextFixture.welcome,
          homeDir: "/Users/tester",
          chatWorkspaceRoot: "/Users/tester/Documents/Synara",
        };
        nextFixture.gitBranchByCwd = {
          "/Users/tester": "home-main",
          "/repo/project": "main",
        };
      },
    });

    try {
      const workspacePickerTrigger = page.getByTestId("workspace-picker-trigger");
      await expect.element(workspacePickerTrigger).toBeInTheDocument();
      const controlsBefore = document.querySelector<HTMLElement>(
        '[data-empty-landing-controls="true"]',
      );
      const composerBlockBefore = document.querySelector<HTMLElement>(
        '[data-empty-landing-composer-block="true"]',
      );
      expect(controlsBefore).not.toBeNull();
      expect(composerBlockBefore).not.toBeNull();
      const beforeRect = controlsBefore!.getBoundingClientRect();
      const composerBlockBeforeRect = composerBlockBefore!.getBoundingClientRect();
      await workspacePickerTrigger.click();

      const projectOption = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="combobox-item"]')).find(
            (item) => item.textContent?.trim() === "project",
          ) ?? null,
        "Unable to find existing project option.",
      );
      projectOption.click();

      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftThread(THREAD_ID)).toMatchObject({
            projectId: PROJECT_ID,
            envMode: "local",
            branch: null,
            worktreePath: null,
          });
        },
        { timeout: 8_000, interval: 16 },
      );
      await expect.element(page.getByTestId("project-picker-trigger")).toBeInTheDocument();
      await expect.element(page.getByRole("checkbox", { name: "Worktree" })).toBeInTheDocument();
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      const controlsAfter = document.querySelector<HTMLElement>(
        '[data-empty-landing-controls="true"]',
      );
      const composerBlockAfter = document.querySelector<HTMLElement>(
        '[data-empty-landing-composer-block="true"]',
      );
      expect(controlsAfter).not.toBeNull();
      expect(composerBlockAfter).not.toBeNull();
      const afterRect = controlsAfter!.getBoundingClientRect();
      const composerBlockAfterRect = composerBlockAfter!.getBoundingClientRect();
      // Guard against the empty-pane entry animation restarting with a vertical translate
      // when Home selection turns into a project draft.
      expect(
        Math.round(Math.abs(afterRect.height - beforeRect.height)),
        `Composer controls changed height ${beforeRect.height}px -> ${afterRect.height}px`,
      ).toBeLessThanOrEqual(1);
      expect(Math.round(Math.abs(afterRect.top - beforeRect.top))).toBeLessThanOrEqual(1);
      expect(
        Math.round(Math.abs(composerBlockAfterRect.top - composerBlockBeforeRect.top)),
      ).toBeLessThanOrEqual(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates and selects a new project from an empty project draft without navigating away", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-project-picker-new-test" as MessageId,
        targetText: "project picker new test",
      }),
    });
    const previousNativeApi = window.nativeApi;
    const wsNativeApi = readNativeApi();
    expect(wsNativeApi).toBeDefined();
    const pickFolder = vi.fn(async () => "/repo/new-project");
    let createdProjectId: ProjectId | null = null;
    const dispatchCommand = vi.fn(async (command: unknown) => {
      wsRequests.push({
        _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
        command,
      });
      if (recordProjectCreateCommand(command)) {
        if (command && typeof command === "object" && "projectId" in command) {
          createdProjectId = command.projectId as ProjectId;
        }
        return { sequence: fixture.snapshot.snapshotSequence };
      }
      return { sequence: fixture.snapshot.snapshotSequence + 1 };
    });
    Object.defineProperty(window, "nativeApi", {
      configurable: true,
      value: {
        ...wsNativeApi,
        dialogs: {
          ...wsNativeApi?.dialogs,
          pickFolder,
        },
        orchestration: {
          ...wsNativeApi?.orchestration,
          dispatchCommand,
          getShellSnapshot: vi.fn(async () => createShellSnapshotFromReadModel(fixture.snapshot)),
        },
      },
    });

    try {
      const newThreadButton = page.getByLabelText("Create new thread in Project");
      await expect.element(newThreadButton).toBeInTheDocument();
      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      const projectPickerTrigger = page.getByTestId("project-picker-trigger");
      await expect.element(projectPickerTrigger).toBeInTheDocument();
      await projectPickerTrigger.click();
      await page.getByText("New project").click();
      await vi.waitFor(() => {
        expect(pickFolder).toHaveBeenCalledTimes(1);
      });

      await vi.waitFor(
        () => {
          const projectCreateRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              "command" in request &&
              request.command &&
              typeof request.command === "object" &&
              "type" in request.command &&
              request.command.type === "project.create" &&
              "workspaceRoot" in request.command &&
              request.command.workspaceRoot === "/repo/new-project",
          );
          expect(projectCreateRequest).toBeDefined();
          expect(createdProjectId).not.toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );

      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
            projectId: createdProjectId,
            envMode: "local",
            branch: null,
            worktreePath: null,
          });
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(mounted.router.state.location.pathname).toBe(newThreadPath);
    } finally {
      if (previousNativeApi) {
        Object.defineProperty(window, "nativeApi", {
          configurable: true,
          value: previousNativeApi,
        });
      } else {
        Reflect.deleteProperty(window, "nativeApi");
      }
      await mounted.cleanup();
    }
  });

  it("creates a project from the sidebar Create Project dialog and shows it in the sidebar", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-create-project-dialog-test" as MessageId,
        targetText: "create project dialog test",
      }),
    });

    try {
      await page.getByRole("button", { name: "Add project", exact: true }).click();
      await expect
        .element(page.getByRole("heading", { name: "Create project" }))
        .toBeInTheDocument();

      await page.getByLabelText("Project folder path").fill("/repo/new-project");
      await page.getByRole("button", { name: "Create project", exact: true }).click();

      await vi.waitFor(
        () => {
          const projectCreateRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              "command" in request &&
              request.command &&
              typeof request.command === "object" &&
              "type" in request.command &&
              request.command.type === "project.create" &&
              "workspaceRoot" in request.command &&
              request.command.workspaceRoot === "/repo/new-project",
          );
          expect(projectCreateRequest).toBeDefined();
        },
        { timeout: 8_000, interval: 16 },
      );

      // The dialog closes only after the new project's draft route commits.
      await expect
        .element(page.getByRole("heading", { name: "Create project" }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByText("new-project", { exact: true }).first())
        .toBeInTheDocument();
      const draftPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Project creation should land on a draft thread route.",
      );
      expect(
        useComposerDraftStore.getState().getDraftThread(ThreadId.makeUnsafe(draftPath.slice(1))),
      ).toMatchObject({
        projectId: expect.any(String),
      });
      await expect.element(page.getByTestId("composer-editor")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the prior route and exposes an error when project draft navigation is superseded", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-create-project-superseded" as MessageId,
        targetText: "create project superseded navigation",
      }),
    });
    const previousPath = mounted.router.state.location.pathname;
    const previousNativeApi = window.nativeApi;
    const wsNativeApi = readNativeApi();
    expect(wsNativeApi).toBeDefined();
    Object.defineProperty(window, "nativeApi", {
      configurable: true,
      value: {
        ...wsNativeApi,
        orchestration: {
          ...wsNativeApi?.orchestration,
          dispatchCommand: vi.fn(async (command: unknown) => {
            if (recordProjectCreateCommand(command)) {
              return { sequence: fixture.snapshot.snapshotSequence };
            }
            return { sequence: fixture.snapshot.snapshotSequence + 1 };
          }),
          getShellSnapshot: vi.fn(async () => createShellSnapshotFromReadModel(fixture.snapshot)),
        },
      },
    });
    const navigateSpy = vi.spyOn(mounted.router, "navigate").mockImplementation(async (options) => {
      const targetThreadId =
        typeof options === "object" && options && "params" in options
          ? (options.params as { threadId?: string } | undefined)?.threadId
          : undefined;
      if (targetThreadId) return;
      return undefined;
    });

    try {
      await page.getByRole("button", { name: "Add project", exact: true }).click();
      await page.getByLabelText("Project folder path").fill("/repo/superseded-project");
      await page.getByRole("button", { name: "Create project", exact: true }).click();

      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent("Project creation was superseded before its chat opened.");
      expect(mounted.router.state.location.pathname).toBe(previousPath);
      await expect.element(page.getByTestId("composer-editor")).toBeInTheDocument();
    } finally {
      navigateSpy.mockRestore();
      if (previousNativeApi) {
        Object.defineProperty(window, "nativeApi", {
          configurable: true,
          value: previousNativeApi,
        });
      } else {
        Reflect.deleteProperty(window, "nativeApi");
      }
      await mounted.cleanup();
    }
  });

  it("creates a Space inline from the Create Project dialog and files the project into it", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-create-project-inline-space" as MessageId,
        targetText: "create project inline space",
      }),
    });

    const findDispatchedCommand = (
      type: string,
      matches: (command: Record<string, unknown>) => boolean,
    ) =>
      wsRequests
        .map(readDispatchedCommand)
        .find((command) => command?.type === type && matches(command));

    try {
      await page.getByRole("button", { name: "Add project", exact: true }).click();
      await expect
        .element(page.getByRole("heading", { name: "Create project" }))
        .toBeInTheDocument();

      await page.getByRole("button", { name: "New space", exact: true }).click();
      await expect.element(page.getByRole("heading", { name: "New space" })).toBeInTheDocument();
      await page.getByLabelText("Name").fill("Focus");
      await page.getByRole("button", { name: "Create space", exact: true }).click();

      // The nested editor closes, the space.create command is dispatched, and
      // the fresh space is preselected as the project's destination.
      await expect
        .element(page.getByRole("heading", { name: "New space" }))
        .not.toBeInTheDocument();
      let createdSpaceId: unknown;
      await vi.waitFor(
        () => {
          const spaceCreateCommand = findDispatchedCommand(
            "space.create",
            (command) => command.name === "Focus",
          );
          expect(spaceCreateCommand).toBeDefined();
          createdSpaceId = spaceCreateCommand?.spaceId;
        },
        { timeout: 8_000, interval: 16 },
      );
      await expect.element(page.getByText("Focus", { exact: true }).first()).toBeInTheDocument();

      await page.getByLabelText("Project folder path").fill("/repo/spaced-project");
      await page.getByRole("button", { name: "Create project", exact: true }).click();

      await vi.waitFor(
        () => {
          const projectCreateCommand = findDispatchedCommand(
            "project.create",
            (command) => command.workspaceRoot === "/repo/spaced-project",
          );
          expect(projectCreateCommand).toBeDefined();
          expect(projectCreateCommand?.spaceId).toBe(createdSpaceId);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("rolls back the provisional Space when project creation fails", async () => {
    const currentSpaceId = SpaceId.makeUnsafe("space-current");
    const destinationSpaceId = SpaceId.makeUnsafe("space-destination");
    const baseSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-create-project-space-rollback" as MessageId,
      targetText: "create project space rollback",
    });
    useSpacesUiStore.getState().setActiveSpaceId(currentSpaceId);
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...baseSnapshot,
        spaces: [
          {
            id: currentSpaceId,
            name: "Current",
            icon: "bag",
            sortOrder: 0,
            createdAt: NOW_ISO,
            updatedAt: NOW_ISO,
            deletedAt: null,
          },
          {
            id: destinationSpaceId,
            name: "Destination",
            icon: "target",
            sortOrder: 1,
            createdAt: NOW_ISO,
            updatedAt: NOW_ISO,
            deletedAt: null,
          },
        ],
        projects: baseSnapshot.projects.map((project) => ({
          ...project,
          spaceId: currentSpaceId,
        })),
      },
    });
    const previousNativeApi = window.nativeApi;
    const wsNativeApi = readNativeApi();
    expect(wsNativeApi).toBeDefined();
    Object.defineProperty(window, "nativeApi", {
      configurable: true,
      value: {
        ...wsNativeApi,
        orchestration: {
          ...wsNativeApi?.orchestration,
          dispatchCommand: vi.fn(async () => {
            throw new Error("Project creation failed for test.");
          }),
        },
      },
    });

    try {
      await page.getByRole("button", { name: "Add project", exact: true }).click();
      await page.getByLabelText("Project folder path").fill("/repo/failing-project");
      const spaceTrigger = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            '[data-slot="dialog-popup"] [data-slot="select-trigger"]',
          ),
        "Unable to find the Create Project Space selector.",
      );
      spaceTrigger.click();
      const destinationOption = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="select-item"]')).find(
            (item) => item.textContent?.trim() === "Destination",
          ) ?? null,
        "Unable to find the destination Space option.",
      );
      destinationOption.click();
      await page.getByRole("button", { name: "Create project", exact: true }).click();

      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent("Project creation failed for test.");
      expect(useSpacesUiStore.getState().activeSpaceId).toBe(currentSpaceId);
      await expect
        .element(page.getByRole("heading", { name: "Create project" }))
        .toBeInTheDocument();
    } finally {
      useSpacesUiStore.getState().setActiveSpaceId(null);
      if (previousNativeApi) {
        Object.defineProperty(window, "nativeApi", {
          configurable: true,
          value: previousNativeApi,
        });
      } else {
        Reflect.deleteProperty(window, "nativeApi");
      }
      await mounted.cleanup();
    }
  });

  it("remembers the Worktree checkbox choice for subsequent project chats", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-empty-worktree-test" as MessageId,
        targetText: "empty worktree test",
      }),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();
      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      await vi.waitFor(
        () => {
          expect(
            useComposerDraftStore.getState().getDraftThreadByProjectId(PROJECT_ID)?.threadId,
          ).toBe(newThreadId);
          expect(mounted.router.state.location.pathname).toBe(newThreadPath);
          expect(mounted.router.state.status).toBe("idle");
        },
        { timeout: 8_000, interval: 16 },
      );
      (await waitForWorktreeCheckbox()).click();

      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftThread(newThreadId)?.envMode).toBe(
            "worktree",
          );
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(useProjectEnvironmentStore.getState().envModeByProjectId[PROJECT_ID]).toBe("worktree");

      let previousDraftId = newThreadId;
      for (const expectedMode of ["worktree", "local"] as const) {
        await mounted.router.navigate({ to: "/$threadId", params: { threadId: THREAD_ID } });
        useComposerDraftStore.getState().clearDraftThread(previousDraftId);
        await newThreadButton.click();
        const nextPath = await waitForURL(
          mounted.router,
          (path) => UUID_ROUTE_RE.test(path) && path !== `/${previousDraftId}`,
          "The next chat should open a fresh draft.",
        );
        previousDraftId = nextPath.slice(1) as ThreadId;
        await vi.waitFor(() => {
          expect(useComposerDraftStore.getState().getDraftThread(previousDraftId)).toMatchObject({
            projectId: PROJECT_ID,
            envMode: expectedMode,
            worktreePath: null,
          });
        });

        if (expectedMode === "worktree") {
          const worktreeCheckbox = await waitForWorktreeCheckbox();
          expect(worktreeCheckbox.getAttribute("aria-checked")).toBe("true");
          worktreeCheckbox.click();
          await vi.waitFor(() => {
            expect(useProjectEnvironmentStore.getState().envModeByProjectId[PROJECT_ID]).toBe(
              "local",
            );
          });
        }
      }
    } finally {
      await mounted.cleanup();
    }
  });

  it.each(["board", "chat"] as const)(
    "dispatches a draft once when %s owns the send before the other surface",
    async (firstOwner) => {
      let releaseTurn!: () => void;
      const turnGate = new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
      const restoreNativeApi = installDeterministicSendNativeApi({
        projectThreadCommands: true,
        beforeTurnStart: () => turnGate,
      });
      useKanbanUiStore.setState({ optimisticDispatchByThreadId: {} });
      useComposerDraftStore.getState().setProjectDraftThreadId(PROJECT_ID, THREAD_ID);
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createDraftOnlySnapshot(),
      });
      let boardSend: ReturnType<typeof dispatchKanbanDraftThread> | undefined;
      const turnCommands = () =>
        wsRequests
          .map(readDispatchedCommand)
          .filter((command) => command?.type === "thread.turn.start");
      const sendFromBoard = () =>
        dispatchKanbanDraftThread({
          threadId: THREAD_ID,
          projectId: PROJECT_ID,
          thread: null,
          defaultProvider: "codex",
          assistantDeliveryMode: "buffered",
        });
      try {
        const prompt = "Send this shared draft once";
        const newerPrompt = "Keep this newer edit for my next turn";
        await page.getByTestId("composer-editor").fill(prompt);
        const sendButton = await waitForSendButton();
        await vi.waitFor(() => expect(sendButton.disabled).toBe(false));
        if (firstOwner === "board") boardSend = sendFromBoard();
        else sendButton.click();
        await vi.waitFor(() => expect(turnCommands()).toHaveLength(1));
        if (firstOwner === "board") {
          sendButton.click();
          // The actual chat send must have entered its pending UI before releasing the board RPC.
          await vi.waitFor(() =>
            expect(
              useThreadDispatchStore.getState().threads[THREAD_ID]?.localDispatch,
            ).toBeTruthy(),
          );
        } else {
          boardSend = sendFromBoard();
          expect(await boardSend).toMatchObject({ kind: "dispatched", deferred: true });
          expect(
            useKanbanUiStore.getState().optimisticDispatchByThreadId[THREAD_ID],
          ).toBeUndefined();
        }
        await page.getByTestId("composer-editor").fill(newerPrompt);
        releaseTurn();
        expect(await boardSend).toMatchObject({ kind: "dispatched" });
        await vi.waitFor(() => expect(turnCommands()).toHaveLength(1));
        const command = turnCommands()[0]!;
        const message = command.message as { messageId: MessageId; text: string };
        expect(message.text).toBe(prompt);
        const created = addThreadToSnapshot(fixture.snapshot, THREAD_ID);
        const startedThread = {
          ...created.threads.find((thread) => thread.id === THREAD_ID)!,
          messages: [
            createUserMessage({ id: message.messageId, text: message.text, offsetSeconds: 1 }),
          ],
          session: {
            ...createSnapshotForTargetUser({
              targetMessageId: message.messageId,
              targetText: prompt,
            }).threads[0]!.session!,
            threadId: THREAD_ID,
            status: "ready" as const,
            activeTurnId: null,
          },
          latestTurn: {
            turnId: TurnId.makeUnsafe("board-chat-race-turn"),
            state: "completed" as const,
            requestedAt: NOW_ISO,
            startedAt: NOW_ISO,
            completedAt: NOW_ISO,
            assistantMessageId: null,
          },
        };
        fixture.snapshot = {
          ...created,
          threads: [startedThread],
          snapshotSequence: created.snapshotSequence + 1,
        };
        useStore.getState().syncServerReadModel(fixture.snapshot);
        useStore.getState().syncServerThreadDetailHotPath(startedThread);
        await vi.waitFor(() => {
          expect(useThreadDispatchStore.getState().threads[THREAD_ID]?.localDispatch).toBeFalsy();
          expect(document.querySelectorAll('[data-message-role="user"]')).toHaveLength(1);
          expect(page.getByTestId("composer-editor").element().textContent).toContain(newerPrompt);
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
            newerPrompt,
          );
        });
        // Real board reconciliation consumes the runtime acknowledgement and drops its optimistic move.
        await mounted.router.navigate({
          to: "/kanban/$projectId",
          params: { projectId: PROJECT_ID },
        });
        await vi.waitFor(() =>
          expect(
            useKanbanUiStore.getState().optimisticDispatchByThreadId[THREAD_ID],
          ).toBeUndefined(),
        );
        await mounted.router.navigate({ to: "/$threadId", params: { threadId: THREAD_ID } });
        await vi.waitFor(() => {
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
            newerPrompt,
          );
          expect(page.getByTestId("composer-editor").element().textContent).toContain(newerPrompt);
          expect(
            document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')
              ?.disabled,
          ).toBe(false);
        });
        (await waitForSendButton()).click();
        await vi.waitFor(() => expect(turnCommands()).toHaveLength(2));
        expect((turnCommands()[1]!.message as { text: string }).text).toBe(newerPrompt);
      } finally {
        releaseTurn();
        await boardSend;
        await mounted.cleanup();
        restoreNativeApi();
      }
    },
  );

  it("keeps the first sent message visible throughout draft promotion", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    useComposerDraftStore.getState().setProjectDraftThreadId(PROJECT_ID, THREAD_ID);
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
    });

    try {
      const prompt = "Keep the first message on screen";
      const draftCreatedAt = useComposerDraftStore.getState().getDraftThread(THREAD_ID)?.createdAt;
      expect(draftCreatedAt).toBeDefined();
      useComposerDraftStore.getState().setPrompt(THREAD_ID, prompt);
      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();
      const startCommand = await vi.waitFor(() => {
        const command = wsRequests
          .map(readDispatchedCommand)
          .find((candidate) => candidate?.type === "thread.turn.start");
        expect(command).toBeDefined();
        return command!;
      });
      const createCommand = wsRequests
        .map(readDispatchedCommand)
        .find((command) => command?.type === "thread.create");
      expect(createCommand?.createdAt).toBe(startCommand.createdAt);
      expect(createCommand?.createdAt).not.toBe(draftCreatedAt);
      const message = startCommand.message as { messageId: MessageId; text: string };
      const messageSelector = `[data-message-id="${message.messageId}"][data-message-role="user"]`;
      const expectTranscript = async () => {
        await waitForLayout();
        expect(document.querySelectorAll(messageSelector)).toHaveLength(1);
        expect(document.querySelector(messageSelector)?.textContent).toContain(prompt);
        expect(document.querySelector('[data-empty-landing-composer-block="true"]')).toBeNull();
        expect(mounted.router.state.location.pathname).toBe(`/${THREAD_ID}`);
      };
      await expectTranscript();

      const createdSnapshot = addThreadToSnapshot(fixture.snapshot, THREAD_ID);
      const createdThread = { ...createdSnapshot.threads[0]!, session: null };
      fixture.snapshot = { ...createdSnapshot, threads: [createdThread] };
      useStore
        .getState()
        .syncServerShellSnapshot(createShellSnapshotFromReadModel(fixture.snapshot));
      await expectTranscript();
      useStore.getState().syncServerThreadDetailHotPath(createdThread);
      await expectTranscript();

      const startedThread = {
        ...createdThread,
        messages: [
          {
            ...createUserMessage({ id: message.messageId, text: message.text, offsetSeconds: 1 }),
            createdAt: startCommand.createdAt as string,
            updatedAt: startCommand.createdAt as string,
          },
        ],
      };
      fixture.snapshot = {
        ...fixture.snapshot,
        snapshotSequence: fixture.snapshot.snapshotSequence + 1,
        threads: [startedThread],
      };
      useStore.getState().syncServerThreadDetailHotPath(startedThread);
      useComposerDraftStore.getState().finalizePromotedDraftThread(THREAD_ID);
      await expectTranscript();

      // A creation snapshot can finish after the first message echo.
      useStore.getState().syncServerThreadDetailHotPath(createdThread);
      await expectTranscript();
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("keeps a sent draft prompt out of the composer once the server recorded it", async () => {
    const turnStartCommand = () =>
      wsRequests
        .map(readDispatchedCommand)
        .find((command) => command?.type === "thread.turn.start");
    // The server records the first message, then the acknowledgement fails.
    const restoreNativeApi = installDeterministicSendNativeApi({
      rejectTurnStart: true,
      beforeTurnStart: async () => {
        const command = turnStartCommand()!;
        const message = command.message as { messageId: MessageId; text: string };
        const createdSnapshot = addThreadToSnapshot(fixture.snapshot, THREAD_ID);
        const startedThread = {
          ...createdSnapshot.threads[0]!,
          session: null,
          messages: [
            {
              ...createUserMessage({ id: message.messageId, text: message.text, offsetSeconds: 1 }),
              createdAt: command.createdAt as string,
              updatedAt: command.createdAt as string,
            },
          ],
        };
        fixture.snapshot = { ...createdSnapshot, threads: [startedThread] };
        useStore
          .getState()
          .syncServerShellSnapshot(createShellSnapshotFromReadModel(fixture.snapshot));
        useStore.getState().syncServerThreadDetailHotPath(startedThread);
      },
    });
    useComposerDraftStore.getState().setProjectDraftThreadId(PROJECT_ID, THREAD_ID);
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "Send this only once");
      const sendButton = await waitForSendButton();
      await vi.waitFor(() => expect(sendButton.disabled).toBe(false));
      sendButton.click();
      await vi.waitFor(() => expect(turnStartCommand()).toBeDefined());
      await vi.waitFor(() => expect(hasActiveComposerSend(THREAD_ID)).toBe(false), {
        timeout: 8_000,
        interval: 16,
      });
      await waitForLayout();

      expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt ?? "").toBe("");
      expect(
        wsRequests.map(readDispatchedCommand).some((command) => command?.type === "thread.delete"),
      ).toBe(false);
    } finally {
      restoreNativeApi();
      await mounted.cleanup();
    }
  });

  it("keeps composer edits made while New thread reopens a stored draft", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("stored-draft-reopen"),
        targetText: "Stored draft reopen",
      }),
    });

    try {
      useComposerDraftStore.getState().setProjectDraftThreadId(PROJECT_ID, OTHER_THREAD_ID);
      useComposerDraftStore.getState().setPrompt(OTHER_THREAD_ID, "Older stored draft");
      const newThreadButton = page.getByLabelText("Create new thread in Project").element();
      (newThreadButton as HTMLElement).click();
      // Type into the reopened draft as soon as its route is active, while the
      // New thread navigation is still settling.
      await new Promise<void>((resolve) => {
        let microtaskChecks = 0;
        const editWhenRouted = () => {
          if (mounted.router.state.location.pathname === `/${OTHER_THREAD_ID}`) {
            useComposerDraftStore.getState().setPrompt(OTHER_THREAD_ID, "Newer typed text");
            resolve();
            return;
          }
          microtaskChecks += 1;
          if (microtaskChecks < 10_000) queueMicrotask(editWhenRouted);
          else window.setTimeout(editWhenRouted, 0);
        };
        editWhenRouted();
      });
      await vi.waitFor(() =>
        expect(document.querySelector('[data-testid="empty-landing-heading"]')).not.toBeNull(),
      );
      await waitForLayout();

      expect(useComposerDraftStore.getState().draftsByThreadId[OTHER_THREAD_ID]?.prompt).toBe(
        "Newer typed text",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("explains a second send instead of ignoring it while the first is in flight", async () => {
    let releaseTurnStart!: () => void;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurnStart = resolve;
    });
    const restoreNativeApi = installDeterministicSendNativeApi({
      beforeTurnStart: () => turnGate,
    });
    useComposerDraftStore.getState().setProjectDraftThreadId(PROJECT_ID, THREAD_ID);
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
    });
    const turnCommands = () =>
      wsRequests
        .map(readDispatchedCommand)
        .filter((command) => command?.type === "thread.turn.start");

    try {
      await page.getByTestId("composer-editor").fill("First message");
      const sendButton = await waitForSendButton();
      await vi.waitFor(() => expect(sendButton.disabled).toBe(false));
      sendButton.click();
      await vi.waitFor(() => expect(turnCommands()).toHaveLength(1));

      await page.getByTestId("composer-editor").fill("Second message");
      await userEvent.keyboard("{Enter}");

      await expect.element(page.getByText("Still sending your last message")).toBeInTheDocument();
      expect(turnCommands()).toHaveLength(1);
      expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
        "Second message",
      );
    } finally {
      releaseTurnStart();
      restoreNativeApi();
      await mounted.cleanup();
    }
  });

  it.each([
    { kind: "forked", envMode: "local", started: false },
    { kind: "forked", envMode: "worktree", started: false },
    { kind: "forked", envMode: "local", started: true },
    { kind: "forked", envMode: "worktree", started: true },
    { kind: "standalone", envMode: "local", started: false },
    { kind: "standalone", envMode: "local", started: true },
  ] as const)(
    "keeps $kind sidechat composer free of workspace controls ($envMode, started=$started)",
    async ({ kind, envMode, started }) => {
      const snapshot = addThreadToSnapshot(createDraftOnlySnapshot(), THREAD_ID);
      const sidechat = {
        ...snapshot.threads[0]!,
        session: null,
        envMode,
        worktreePath: envMode === "worktree" ? "/repo-sidechat-worktree" : null,
        workingDirectory: "/repo-sidechat-worktree/packages",
        ...(kind === "forked"
          ? { sidechatSourceThreadId: OTHER_THREAD_ID }
          : {
              sidechatContext: {
                kind: "github-item" as const,
                itemKind: "pullRequest" as const,
                repository: "acme/widgets",
                number: 1368,
                url: "https://github.com/acme/widgets/pull/1368",
              },
            }),
        messages: started
          ? [
              createUserMessage({
                id: MessageId.makeUnsafe("sidechat-follow-up"),
                text: "Keep discussing this context",
                offsetSeconds: 0,
              }),
            ]
          : [],
      };
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: { ...snapshot, threads: [sidechat] },
      });

      try {
        const editor = await waitForComposerEditor();
        expect(document.querySelector('[data-testid="empty-landing-heading"]')).toBeNull();
        expect(document.querySelector('[data-empty-landing-controls="true"]')).toBeNull();
        expect(document.body.textContent).not.toContain("Import your Claude Code");
        expect(document.body.textContent).not.toContain("Let's build");
        await expect
          .element(page.getByRole("button", { name: "Local", exact: true }))
          .not.toBeInTheDocument();
        await expect
          .element(page.getByRole("button", { name: "Temporary chat", exact: true }))
          .not.toBeInTheDocument();
        if (kind === "standalone" && !started) {
          expect(editor.getAttribute("aria-placeholder")).toBe("Ask about this pull request");
        }
        if (started) {
          await expect
            .element(page.getByText("Keep discussing this context", { exact: true }))
            .toBeVisible();
        }
        await page.getByRole("button", { name: "Toggle environment panel" }).click();
        await expect
          .element(page.getByRole("button", { name: "Local", exact: true }))
          .not.toBeInTheDocument();
        await expect
          .element(page.getByRole("combobox", { name: "main", exact: true }))
          .not.toBeInTheDocument();
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("keeps the transcript open while the first turn starts before its message arrives", async () => {
    const snapshot = addThreadToSnapshot(createDraftOnlySnapshot(), THREAD_ID);
    const emptyThread = { ...snapshot.threads[0]!, session: null };
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: { ...snapshot, threads: [emptyThread] },
    });

    try {
      await expect.element(page.getByTestId("empty-landing-heading")).toBeInTheDocument();
      // The project name sits in a combobox, which must not drop out of the heading's name.
      expect(
        page.getByTestId("empty-landing-heading").element().getAttribute("aria-label"),
      ).toMatch(/^What should we do in \S.*\?$/);
      const pendingTurn = {
        turnId: TurnId.makeUnsafe("first-turn-starting"),
        state: "running" as const,
        requestedAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
        assistantMessageId: null,
      };
      const pendingThread = { ...emptyThread, latestTurn: pendingTurn };
      fixture.snapshot = { ...fixture.snapshot, threads: [pendingThread] };
      useStore.getState().syncServerThreadDetailHotPath(pendingThread);
      await waitForLayout();
      expect(document.querySelector('[data-testid="empty-landing-heading"]')).toBeNull();
      const transcriptPane = document.querySelector('[data-chat-transcript-pane="true"]');
      expect(transcriptPane).not.toBeNull();
      expect(transcriptPane?.textContent).not.toContain("What should");
      expect(transcriptPane?.textContent).not.toContain(
        "Send a message to start the conversation.",
      );

      for (const status of ["starting", "running"] as const) {
        const thread = {
          ...pendingThread,
          session: { ...snapshot.threads[0]!.session!, status },
        };
        fixture.snapshot = { ...fixture.snapshot, threads: [thread] };
        useStore.getState().syncServerThreadDetailHotPath(thread);
        await waitForLayout();
        expect(document.querySelector('[data-testid="empty-landing-heading"]')).toBeNull();
        expect(document.querySelector('[data-chat-transcript-pane="true"]')).toBe(transcriptPane);
      }

      const startedThread = {
        ...pendingThread,
        messages: [
          createUserMessage({
            id: MessageId.makeUnsafe("first-turn-message"),
            text: "Start the first turn",
            offsetSeconds: 1,
          }),
        ],
      };
      fixture.snapshot = { ...fixture.snapshot, threads: [startedThread] };
      useStore.getState().syncServerThreadDetailHotPath(startedThread);
      await expect
        .element(page.getByText("Start the first turn", { exact: true }))
        .toBeInTheDocument();
      expect(document.querySelector('[data-testid="empty-landing-heading"]')).toBeNull();
      expect(document.querySelector('[data-chat-transcript-pane="true"]')).toBe(transcriptPane);
    } finally {
      await mounted.cleanup();
    }
  });

  it.each(["interrupted"] as const)(
    "shows the empty landing for terminal state %s without a start timestamp",
    async (state) => {
      const snapshot = addThreadToSnapshot(createDraftOnlySnapshot(), THREAD_ID);
      const emptyThread = {
        ...snapshot.threads[0]!,
        session: null,
        latestTurn: {
          turnId: TurnId.makeUnsafe("restored-terminal-turn"),
          state,
          requestedAt: isoAt(0),
          startedAt: null,
          completedAt: isoAt(1),
          assistantMessageId: null,
        },
      };
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: { ...snapshot, threads: [emptyThread] },
      });

      try {
        expect(document.querySelector('[data-testid="empty-landing-heading"]')).not.toBeNull();
        expect(document.querySelector('[data-empty-landing-composer-block="true"]')).not.toBeNull();
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it.each(["success", "failure", "revisit", "cancel"] as const)(
    "opens another draft during worktree creation and preserves the original send on %s",
    async (outcome) => {
      let finishCreation!: () => void;
      const creationGate = new Promise<void>((resolve) => {
        finishCreation = resolve;
      });
      const restoreNativeApi = installDeterministicSendNativeApi({
        projectThreadCommands: true,
        beforeWorktreeCreation: async () => {
          await creationGate;
          if (outcome !== "success") throw new Error("Worktree creation failed for test.");
        },
      });
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: MessageId.makeUnsafe("worktree-new-thread-shortcut"),
          targetText: "worktree shortcut",
        }),
      });

      try {
        useProjectEnvironmentStore.getState().setProjectEnvMode(PROJECT_ID, "worktree");
        await page.getByTestId("new-thread-button").click();
        const sendingPath = await waitForURL(
          mounted.router,
          (path) => UUID_ROUTE_RE.test(path),
          "Expected a worktree draft.",
        );
        const sendingId = sendingPath.slice(1) as ThreadId;
        useComposerDraftStore.getState().setPrompt(sendingId, "Create while I start another task");
        await vi.waitFor(() => {
          expect(useComposerDraftStore.getState().getDraftThread(sendingId)?.branch).toBe("main");
        });
        const sendButton = await waitForSendButton();
        await vi.waitFor(() => expect(sendButton.disabled).toBe(false));
        sendButton.click();
        await vi.waitFor(() => {
          expect(
            wsRequests.some((request) => request._tag === WS_METHODS.gitCreateDetachedWorktree),
          ).toBe(true);
        });

        // The real sidebar must display the durable thread while the git RPC is pending.
        await vi.waitFor(
          () => {
            expect(
              document.querySelector(
                '[role="button"][aria-label="Open Create while I start another task"]',
              ),
            ).toBeTruthy();
            expect(
              document.querySelector('[role="img"][aria-label="Preparing worktree"]'),
            ).toBeTruthy();
          },
          { timeout: 8_000, interval: 16 },
        );
        expect(
          wsRequests
            .map(readDispatchedCommand)
            .filter((command) => command?.type === "thread.turn.start"),
        ).toHaveLength(0);

        // Use the actual default mod+N shortcut while the worktree RPC is unresolved.
        await dispatchConfiguredShortcutWhenReady(window, { key: "n" });
        const nextPath = await waitForURL(
          mounted.router,
          (path) => UUID_ROUTE_RE.test(path) && path !== sendingPath,
          "New thread must remain available during worktree creation.",
        );
        const nextId = nextPath.slice(1) as ThreadId;
        expect(useComposerDraftStore.getState().getDraftThread(sendingId)).not.toBeNull();
        expect(
          useComposerDraftStore.getState().getDraftThreadByProjectId(PROJECT_ID)?.threadId,
        ).toBe(nextId);
        useComposerDraftStore.getState().setPrompt(nextId, "Independent draft");
        const nextPlanSource = {
          threadId: THREAD_ID,
          planId: OrchestrationProposedPlanId.makeUnsafe("independent-draft-plan"),
        };
        if (outcome === "success") {
          useComposerDraftStore.getState().setRestoredSourceProposedPlan(nextId, {
            threadId: nextId,
            restoredPrompt: "Independent draft",
            sourceProposedPlan: nextPlanSource,
          });
          await vi.waitFor(() =>
            expect(document.querySelector('[contenteditable="true"]')?.textContent).toContain(
              "Independent draft",
            ),
          );
        }
        if (outcome === "revisit" || outcome === "cancel") {
          await page
            .getByRole("button", { name: "Open Create while I start another task", exact: true })
            .click();
          await vi.waitFor(
            () =>
              expect(
                Array.from(document.querySelectorAll("button")).find(
                  (button) => button.textContent?.trim() === "Cancel",
                ),
              ).toBeTruthy(),
            { timeout: 8_000 },
          );
        }
        if (outcome === "cancel") {
          const cancel = Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Cancel",
          );
          cancel?.click();
          await vi.waitFor(() =>
            expect(useComposerDraftStore.getState().draftsByThreadId[sendingId]?.prompt).toBe(
              "Create while I start another task",
            ),
          );
        }
        if (outcome === "revisit") {
          await mounted.router.navigate({ to: "/$threadId", params: { threadId: THREAD_ID } });
          useComposerDraftStore.getState().setPrompt(THREAD_ID, "Existing task draft");
          await vi.waitFor(() =>
            expect(document.querySelector('[contenteditable="true"]')?.textContent).toContain(
              "Existing task draft",
            ),
          );
        }
        finishCreation();

        await vi.waitFor(
          () => {
            if (outcome === "success") {
              const turns = wsRequests
                .map(readDispatchedCommand)
                .filter((command) => command?.type === "thread.turn.start");
              expect(turns).toHaveLength(1);
              expect(turns[0]).toMatchObject({ threadId: sendingId });
            } else {
              expect(useComposerDraftStore.getState().draftsByThreadId[sendingId]?.prompt).toBe(
                "Create while I start another task",
              );
              expect(
                wsRequests
                  .map(readDispatchedCommand)
                  .filter((command) => command?.type === "thread.turn.start"),
              ).toHaveLength(0);
            }
            expect(mounted.router.state.location.pathname).toBe(
              outcome === "revisit"
                ? `/${THREAD_ID}`
                : outcome === "cancel"
                  ? sendingPath
                  : nextPath,
            );
            expect(useComposerDraftStore.getState().draftsByThreadId[nextId]?.prompt).toBe(
              "Independent draft",
            );
          },
          { timeout: 8_000, interval: 16 },
        );
        if (outcome === "success") {
          const worktreeCheckbox = await waitForWorktreeCheckbox();
          worktreeCheckbox.click();
          await vi.waitFor(() =>
            expect(worktreeCheckbox.getAttribute("aria-checked")).toBe("false"),
          );
          const nextSend = await waitForSendButton();
          await vi.waitFor(() => expect(nextSend.disabled).toBe(false));
          nextSend.click();
          await vi.waitFor(() => {
            const nextTurn = wsRequests
              .map(readDispatchedCommand)
              .find(
                (command) => command?.type === "thread.turn.start" && command.threadId === nextId,
              );
            expect(nextTurn).toMatchObject({ sourceProposedPlan: nextPlanSource });
          });
        }
      } finally {
        finishCreation();
        await mounted.cleanup();
        restoreNativeApi();
      }
    },
  );

  it("creates a detached worktree on first send in New worktree mode", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-new-worktree-send-test" as MessageId,
        targetText: "new worktree send test",
      }),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();
      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      await vi.waitFor(
        () => {
          expect(
            useComposerDraftStore.getState().getDraftThreadByProjectId(PROJECT_ID)?.threadId,
          ).toBe(newThreadId);
          expect(mounted.router.state.location.pathname).toBe(newThreadPath);
          expect(mounted.router.state.status).toBe("idle");
        },
        { timeout: 8_000, interval: 16 },
      );
      (await waitForWorktreeCheckbox()).click();

      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftThread(newThreadId)?.envMode).toBe(
            "worktree",
          );
        },
        { timeout: 8_000, interval: 16 },
      );

      useComposerDraftStore.getState().setPrompt(newThreadId, "Ship it");
      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
            envMode: "worktree",
            branch: "main",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(
        () => {
          expect(composerEditor.textContent ?? "").toContain("Ship it");
        },
        { timeout: 8_000, interval: 16 },
      );

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      await sendButton.click();

      await vi.waitFor(
        () => {
          const createWorktreeRequest = wsRequests.find(
            (request) =>
              request._tag === WS_METHODS.gitCreateDetachedWorktree &&
              request.cwd === "/repo/project" &&
              request.ref === "main" &&
              request.copyChangesFrom === "/repo/project",
          );
          expect(createWorktreeRequest).toBeTruthy();
          const temporaryBranch = createWorktreeRequest?.newBranch;
          expect(typeof temporaryBranch).toBe("string");
          expect(temporaryBranch).toMatch(/^synara\/[0-9a-f]{8}$/);

          const createThreadRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              typeof request.command === "object" &&
              request.command !== null &&
              "type" in request.command &&
              "threadId" in request.command &&
              request.command.type === "thread.create" &&
              request.command.threadId === newThreadId,
          );
          expect(createThreadRequest).toBeTruthy();
          expect(createThreadRequest?.command).toMatchObject({
            envMode: "worktree",
            branch: "main",
            worktreePath: null,
          });
          const linkedWorkspace = wsRequests
            .map(readDispatchedCommand)
            .find(
              (command) =>
                command?.type === "thread.meta.update" &&
                command.threadId === newThreadId &&
                command.worktreePath === "/repo/.codex/worktrees/generated/synara",
            );
          expect(linkedWorkspace).toMatchObject({
            envMode: "worktree",
            branch: temporaryBranch,
            worktreePath: "/repo/.codex/worktrees/generated/synara",
            associatedWorktreePath: "/repo/.codex/worktrees/generated/synara",
            associatedWorktreeBranch: temporaryBranch,
            associatedWorktreeRef: "0123456789abcdef0123456789abcdef01234567",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("keeps worktree setup resolvable while attachments upload", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    let releaseAttachmentUpload = () => {};
    let releaseAttachmentCancel = () => {};
    attachmentUploadBarrier = new Promise<void>((resolve) => {
      releaseAttachmentUpload = resolve;
    });
    attachmentCancelBarrier = new Promise<void>((resolve) => {
      releaseAttachmentCancel = resolve;
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-new-worktree-cancel-upload-test" as MessageId,
        targetText: "new worktree cancel upload test",
      }),
    });

    try {
      await page.getByTestId("new-thread-button").click();
      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      const worktreeCheckbox = await waitForWorktreeCheckbox();
      worktreeCheckbox.click();
      await vi.waitFor(() => {
        expect(worktreeCheckbox.getAttribute("aria-checked")).toBe("true");
      });

      useComposerDraftStore.getState().setPrompt(newThreadId, "Cancel before upload finishes");
      useComposerDraftStore.getState().addImage(
        newThreadId,
        createComposerImage({
          id: "new-worktree-cancel-upload-image",
          previewUrl: "blob:new-worktree-cancel-upload-image",
        }),
      );
      const composerForm = document.querySelector<HTMLFormElement>(
        'form[data-chat-composer-form="true"]',
      );
      expect(composerForm).not.toBeNull();
      composerForm!.requestSubmit();

      await expect
        .poll(
          () =>
            document.querySelector<HTMLElement>('[data-timeline-row-kind="worktree-setup"]')
              ?.textContent,
        )
        .toContain("Linking thread workspace");
      const cancelButton = page.getByRole("button", { name: "Cancel" });
      await expect.element(cancelButton).toBeInTheDocument();
      expect(
        wsRequests.some(
          (candidate) => readDispatchedCommand(candidate)?.type === "thread.turn.start",
        ),
      ).toBe(false);

      await cancelButton.click();
      releaseAttachmentCancel();
      attachmentCancelBarrier = null;
      releaseAttachmentUpload();
      attachmentUploadBarrier = null;

      await vi.waitFor(
        () => {
          expect(
            wsRequests.some(
              (candidate) => readDispatchedCommand(candidate)?.type === "thread.turn.start",
            ),
          ).toBe(false);
          expect(
            wsRequests.some(
              (candidate) =>
                candidate._tag === WS_METHODS.gitRemoveWorktree &&
                candidate.path === "/repo/.codex/worktrees/generated/synara" &&
                candidate.force === true &&
                candidate.reclaimTemporaryBranch === true,
            ),
          ).toBe(true);
          expect(document.querySelector('[data-timeline-row-kind="worktree-setup"]')).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      releaseAttachmentCancel();
      attachmentCancelBarrier = null;
      releaseAttachmentUpload();
      attachmentUploadBarrier = null;
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("runs the setup action from the newly-created worktree before starting the turn", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withProjectScripts(
        withStudioProject(
          withHomeChatProject(
            createSnapshotForTargetUser({
              targetMessageId: "msg-user-new-worktree-setup-action-test" as MessageId,
              targetText: "new worktree setup action test",
            }),
          ),
        ),
        [
          {
            id: "setup",
            name: "Setup",
            command: "printf setup",
            icon: "configure",
            runOnWorktreeCreate: true,
          },
        ],
      ),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();
      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      await vi.waitFor(
        () => {
          expect(
            useComposerDraftStore.getState().getDraftThreadByProjectId(PROJECT_ID)?.threadId,
          ).toBe(newThreadId);
          expect(mounted.router.state.location.pathname).toBe(newThreadPath);
          expect(mounted.router.state.status).toBe("idle");
        },
        { timeout: 8_000, interval: 16 },
      );
      (await waitForWorktreeCheckbox()).click();

      useComposerDraftStore.getState().setPrompt(newThreadId, "Ship it with setup");
      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
            envMode: "worktree",
            branch: "main",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(
        () => {
          expect(composerEditor.textContent ?? "").toContain("Ship it with setup");
        },
        { timeout: 8_000, interval: 16 },
      );

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      const composerForm = document.querySelector<HTMLFormElement>(
        'form[data-chat-composer-form="true"]',
      );
      expect(composerForm).not.toBeNull();
      composerForm!.requestSubmit();

      const createWorktreeRequest = await vi.waitFor(
        () => {
          const request = wsRequests.find(
            (candidate) =>
              candidate._tag === WS_METHODS.gitCreateDetachedWorktree &&
              candidate.cwd === "/repo/project" &&
              candidate.ref === "main",
          );
          expect(
            request,
            `Expected create worktree request; draft=${JSON.stringify(
              useComposerDraftStore.getState().getDraftThread(newThreadId),
            )}; path=${mounted.router.state.location.pathname}; forms=${
              document.querySelectorAll('form[data-chat-composer-form="true"]').length
            }; ui=${(document.body.textContent ?? "").slice(-300)}; saw ${wsRequests
              .map((candidate) => {
                const command = readDispatchedCommand(candidate);
                return command ? `${candidate._tag}:${command.type}` : candidate._tag;
              })
              .slice(-40)
              .join(", ")}`,
          ).toBeTruthy();
          if (!request || request._tag !== WS_METHODS.gitCreateDetachedWorktree) {
            throw new Error("Expected create worktree request.");
          }
          return request;
        },
        { timeout: 10_000, interval: 16 },
      );
      const createWorktreeIndex = wsRequests.indexOf(createWorktreeRequest);
      const worktreePath = "/repo/.codex/worktrees/generated/synara";

      const terminalOpenRequest = await vi.waitFor(
        () => {
          const request = wsRequests.find(
            (candidate) =>
              candidate._tag === WS_METHODS.terminalOpen &&
              candidate.threadId === dockTerminalThreadId(newThreadId) &&
              candidate.cwd === worktreePath,
          );
          expect(
            request,
            `Expected setup terminal open; saw ${wsRequests
              .map((candidate) => {
                const command = readDispatchedCommand(candidate);
                return command ? `${candidate._tag}:${command.type}` : candidate._tag;
              })
              .join(", ")}`,
          ).toBeTruthy();
          return request;
        },
        { timeout: 10_000, interval: 16 },
      );
      const terminalOpenIndex = wsRequests.indexOf(terminalOpenRequest!);
      expect(terminalOpenIndex).toBeGreaterThan(createWorktreeIndex);
      expect(terminalOpenRequest).toMatchObject({
        _tag: WS_METHODS.terminalOpen,
        cwd: worktreePath,
        env: {
          SYNARA_PROJECT_ROOT: "/repo/project",
          SYNARA_WORKTREE_PATH: worktreePath,
        },
      });

      const terminalWriteRequest = await vi.waitFor(
        () => {
          const request = wsRequests.find(
            (candidate) =>
              candidate._tag === WS_METHODS.terminalWrite &&
              candidate.threadId === dockTerminalThreadId(newThreadId) &&
              candidate.data === "printf setup\r",
          );
          expect(request).toBeTruthy();
          return request;
        },
        { timeout: 10_000, interval: 16 },
      );
      const terminalWriteIndex = wsRequests.indexOf(terminalWriteRequest!);
      expect(terminalWriteIndex).toBeGreaterThan(terminalOpenIndex);

      const turnStartRequest = await vi.waitFor(
        () => {
          const request = wsRequests.find((candidate) => {
            const command = readDispatchedCommand(candidate);
            return command?.type === "thread.turn.start" && command.threadId === newThreadId;
          });
          expect(request).toBeTruthy();
          return request;
        },
        { timeout: 10_000, interval: 16 },
      );
      expect(wsRequests.indexOf(turnStartRequest!)).toBeGreaterThan(terminalWriteIndex);
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("restores a usable sticky claude model on fresh chat", async () => {
    useComposerDraftStore.setState({
      stickyModelSelectionByProvider: {
        claudeAgent: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: {
            effort: "max",
            fastMode: true,
          },
        },
      },
      stickyActiveProvider: "claudeAgent",
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sticky-claude-model-test" as MessageId,
        targetText: "sticky claude model test",
      }),
      configureFixture: (nextFixture) => {
        const providers: ServerConfig["providers"] = [
          ...nextFixture.serverConfig.providers,
          {
            provider: "claudeAgent",
            instanceId: "claudeAgent",
            driver: "claudeAgent",
            status: "ready",
            available: true,
            authStatus: "authenticated",
            checkedAt: NOW_ISO,
          },
        ];
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          providers,
        };
        nextFixture.providerStatusesSnapshot = providers;
      },
    });

    try {
      await vi.waitFor(() => {
        expect(
          hasReconciledServerProviderStatuses(mounted.router.options.context.queryClient),
        ).toBe(true);
      });
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();

      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new sticky claude draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      expect(useComposerDraftStore.getState().draftsByThreadId[newThreadId]).toMatchObject({
        modelSelectionByProvider: {
          claudeAgent: {
            provider: "claudeAgent",
            model: "claude-opus-4-6",
            options: {
              effort: "max",
              fastMode: true,
            },
          },
        },
        activeProvider: "claudeAgent",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("falls back from an unauthenticated sticky provider on fresh chat", async () => {
    useComposerDraftStore.setState({
      stickyModelSelectionByProvider: {
        claudeAgent: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: {
            effort: "max",
            fastMode: true,
          },
        },
      },
      stickyActiveProvider: "claudeAgent",
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-unavailable-sticky-claude-test" as MessageId,
        targetText: "unavailable sticky claude test",
      }),
      configureFixture: (nextFixture) => {
        const providers: ServerConfig["providers"] = [
          ...nextFixture.serverConfig.providers,
          {
            provider: "claudeAgent",
            instanceId: "claudeAgent",
            driver: "claudeAgent",
            status: "warning",
            available: true,
            authStatus: "unauthenticated",
            checkedAt: NOW_ISO,
          },
        ];
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          providers,
        };
        nextFixture.providerStatusesSnapshot = providers;
      },
    });

    try {
      await vi.waitFor(() => {
        expect(
          hasReconciledServerProviderStatuses(mounted.router.options.context.queryClient),
        ).toBe(true);
      });
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();

      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a healthy fallback draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      expect(useComposerDraftStore.getState().draftsByThreadId[newThreadId]).toMatchObject({
        modelSelectionByProvider: {
          codex: {
            provider: "codex",
            model: "gpt-5",
          },
        },
        activeProvider: "codex",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("leaves the project default implicit when no sticky composer settings exist", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-default-codex-traits-test" as MessageId,
        targetText: "default codex traits test",
      }),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();

      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      expect(useComposerDraftStore.getState().draftsByThreadId[newThreadId]).toBeUndefined();
    } finally {
      await mounted.cleanup();
    }
  });

  it("reuses the existing draft thread when the user clicks new thread again", async () => {
    useComposerDraftStore.setState({
      stickyModelSelectionByProvider: {
        codex: {
          provider: "codex",
          model: "gpt-5.3-codex",
          options: {
            reasoningEffort: "medium",
            fastMode: true,
          },
        },
      },
      stickyActiveProvider: "codex",
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-draft-codex-traits-precedence-test" as MessageId,
        targetText: "draft codex traits precedence test",
      }),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();

      await newThreadButton.click();

      const threadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a sticky draft thread UUID.",
      );
      const threadId = threadPath.slice(1) as ThreadId;

      expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toMatchObject({
        modelSelectionByProvider: {
          codex: {
            provider: "codex",
            model: "gpt-5.3-codex",
            options: {
              reasoningEffort: "medium",
              fastMode: true,
            },
          },
        },
        activeProvider: "codex",
      });

      useComposerDraftStore.getState().setModelSelection(threadId, {
        provider: "codex",
        model: "gpt-5.4",
        options: {
          reasoningEffort: "low",
          fastMode: true,
        },
      });
      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toMatchObject({
            modelSelectionByProvider: {
              codex: {
                provider: "codex",
                model: "gpt-5.4",
                options: {
                  reasoningEffort: "low",
                  fastMode: true,
                },
              },
            },
            activeProvider: "codex",
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await newThreadButton.click();
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 64);
      });

      expect(mounted.router.state.location.pathname).toBe(threadPath);
      expect(useComposerDraftStore.getState().projectDraftThreadIdByProjectId[PROJECT_ID]).toBe(
        threadId,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("preserves a new-chat draft when switching to another thread and back via New chat", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withActiveHomeChatThread(
        addThreadToSnapshot(
          createSnapshotForTargetUser({
            targetMessageId: "msg-user-home-draft-switch" as MessageId,
            targetText: "home draft switch target",
          }),
          OTHER_THREAD_ID,
        ),
      ),
      configureFixture: (nextFixture) => {
        nextFixture.welcome = {
          ...nextFixture.welcome,
          homeDir: "/Users/tester",
          chatWorkspaceRoot: "/Users/tester/Documents/Synara",
          studioWorkspaceRoot: "/Users/tester/Documents/Synara/Studio",
        };
      },
    });

    try {
      // Start a brand-new home chat (draft thread)
      const newChatButton = page.getByLabelText("Open new chat home");
      await expect.element(newChatButton).toBeInTheDocument();
      await newChatButton.click();
      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      // Type a draft in the new chat
      const prompt = "draft typed in a brand-new home chat";
      useComposerDraftStore.getState().setPrompt(newThreadId, prompt);
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(
        () => {
          expect(composerEditor.textContent ?? "").toContain(prompt);
        },
        { timeout: 8_000, interval: 16 },
      );

      // Switch to another thread to check on it
      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: OTHER_THREAD_ID },
      });
      await waitForLayout();
      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.pathname).toBe(`/${OTHER_THREAD_ID}`);
        },
        { timeout: 8_000, interval: 16 },
      );

      // Come back via "New chat" — must return to the SAME draft thread with the draft intact
      const newChatButtonAgain = page.getByLabelText("Open new chat home");
      await expect.element(newChatButtonAgain).toBeInTheDocument();
      await newChatButtonAgain.click();
      const returnedPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a draft thread UUID.",
      );

      await vi.waitFor(
        () => {
          expect(returnedPath).toBe(newThreadPath);
        },
        { timeout: 8_000, interval: 16 },
      );

      const composerEditorAfter = await waitForComposerEditor();
      await vi.waitFor(
        () => {
          expect(composerEditorAfter.textContent ?? "").toContain(prompt);
        },
        { timeout: 8_000, interval: 16 },
      );

      // The original draft thread must still be registered with its content
      expect(useComposerDraftStore.getState().draftsByThreadId[newThreadId]?.prompt).toBe(prompt);
    } finally {
      await mounted.cleanup();
    }
  });

  it("applies the selected chat width to the transcript column", async () => {
    localStorage.setItem("synara:app-settings:v1", JSON.stringify({ chatWidth: "wide" }));
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-chat-width-test" as MessageId,
        targetText: "chat width test",
      }),
    });

    try {
      // The hook must surface the preset as a root CSS variable.
      await vi.waitFor(
        () => {
          expect(document.documentElement.style.getPropertyValue("--app-chat-max-width")).toBe(
            "72rem",
          );
        },
        { timeout: 8_000, interval: 16 },
      );

      // The transcript column frame must pick up the wider max width.
      await vi.waitFor(
        () => {
          const row = document.querySelector(
            "[data-timeline-row-kind='message'][data-message-role='assistant']",
          ) as HTMLElement | null;
          expect(row).not.toBeNull();
          expect(row?.className ?? "").toContain("max-w-[var(--app-chat-max-width,46rem)]");
          expect(getComputedStyle(row!).maxWidth).toBe("1152px"); // 72rem at 16px root
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a new thread from the global chat.new shortcut", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-chat-shortcut-test" as MessageId,
        targetText: "chat shortcut test",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "chat.new",
              shortcut: {
                key: "o",
                metaKey: false,
                ctrlKey: false,
                shiftKey: true,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      useProjectEnvironmentStore.getState().setProjectEnvMode(PROJECT_ID, "worktree");
      await waitForNewThreadShortcutLabel();
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      await waitForLayout();
      const nextPath = await triggerChatNewShortcutUntilPath(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID from the shortcut.",
      );
      expect(
        useComposerDraftStore.getState().getDraftThread(nextPath.slice(1) as ThreadId),
      ).toMatchObject({ envMode: "worktree", worktreePath: null });
    } finally {
      await mounted.cleanup();
    }
  });

  it("closes a worktree handoff dialog when navigating to a draft thread", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("handoff-owner"),
        targetText: "Saved thread handoff",
      }),
    });
    try {
      useComposerDraftStore.getState().setProjectDraftThreadId(PROJECT_ID, OTHER_THREAD_ID, {});
      useComposerDraftStore.getState().setPrompt(OTHER_THREAD_ID, "Destination draft");
      await page.getByRole("button", { name: "Toggle environment panel", exact: true }).click();
      await expect.element(page.getByRole("button", { name: "Local", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Local", exact: true }).click();
      await expect
        .element(page.getByRole("menuitem", { name: "Hand off to new worktree" }))
        .toBeVisible();
      await page.getByRole("menuitem", { name: "Hand off to new worktree" }).click();
      await expect
        .element(page.getByRole("dialog", { name: "Hand off to worktree" }))
        .toBeVisible();
      await page.getByRole("textbox", { name: "Worktree name" }).fill("source-thread-worktree");
      // Browser/history navigation remains possible while the dialog makes background clicks inert.
      await mounted.router.navigate({ to: "/$threadId", params: { threadId: OTHER_THREAD_ID } });
      await vi.waitFor(() => {
        expect(mounted.router.state.location.pathname).toBe(`/${OTHER_THREAD_ID}`);
        expect(document.querySelector('[contenteditable="true"]')?.textContent).toBe(
          "Destination draft",
        );
      });
      await expect
        .element(page.getByRole("dialog", { name: "Hand off to worktree" }), { timeout: 2_000 })
        .not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it.each(["saved", "promoted-draft", "terminal"] as const)(
    "reorders a background horizontal tab across navigation and persists the order (%s)",
    async (kind) => {
      const thirdId = ThreadId.makeUnsafe("drag-tab-third");
      let snapshot = createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("drag-tabs"),
        targetText: "Drag tabs",
      });
      snapshot = addThreadToSnapshot(snapshot, thirdId);
      if (kind !== "promoted-draft") snapshot = addThreadToSnapshot(snapshot, OTHER_THREAD_ID);
      snapshot = {
        ...snapshot,
        threads: snapshot.threads.map((thread) =>
          thread.id === thirdId ? Object.assign({}, thread, { title: "Destination tab" }) : thread,
        ),
      };
      const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
      try {
        if (kind === "promoted-draft") {
          useComposerDraftStore.getState().registerDraftThread(OTHER_THREAD_ID, {
            projectId: PROJECT_ID,
          });
          useOpenThreadTabsStore.setState({ threadIds: [THREAD_ID, OTHER_THREAD_ID, thirdId] });
          await vi.waitFor(() =>
            expect(
              document.querySelectorAll('nav[aria-label="Open threads"] [data-surface-tab]'),
            ).toHaveLength(2),
          );
          fixture.snapshot = addThreadToSnapshot(fixture.snapshot, OTHER_THREAD_ID);
          useStore.getState().syncServerReadModel(fixture.snapshot);
          useComposerDraftStore.getState().clearDraftThread(OTHER_THREAD_ID);
        } else if (kind === "terminal") {
          useTerminalStateStore.getState().openTerminalThreadPage(OTHER_THREAD_ID);
        }
        useOpenThreadTabsStore.setState({ threadIds: [THREAD_ID, OTHER_THREAD_ID, thirdId] });
        await vi.waitFor(() =>
          expect(
            document.querySelectorAll('nav[aria-label="Open threads"] [data-surface-tab]'),
          ).toHaveLength(3),
        );
        await waitForLayout();
        const labels = document.querySelectorAll<HTMLButtonElement>(
          'nav[aria-label="Open threads"] [data-surface-tab] > button:not([aria-label])',
        );
        const source = labels[1]!.getBoundingClientRect();
        const x = source.left + source.width / 2;
        const y = source.top + source.height / 2;
        labels[1]!.dispatchEvent(mousePointerEvent("pointerdown", x, y));
        document.dispatchEvent(mousePointerEvent("pointermove", x + 8, y));
        await waitForLayout();
        expect(mounted.router.state.location.pathname).toBe(`/${THREAD_ID}`);
        expect(labels[1]!.getAttribute("aria-current")).toBeNull();
        // Navigation may still arrive while dragging; it must preserve the sortable strip.
        await mounted.router.navigate({
          to: "/$threadId",
          params: { threadId: OTHER_THREAD_ID },
        });
        await vi.waitFor(() =>
          expect(mounted.router.state.location.pathname).toBe(`/${OTHER_THREAD_ID}`),
        );
        const currentLabels = document.querySelectorAll<HTMLButtonElement>(
          'nav[aria-label="Open threads"] [data-surface-tab] > button:not([aria-label])',
        );
        const target = currentLabels[2]!.getBoundingClientRect();
        const targetX = target.left + target.width / 2;
        document.dispatchEvent(mousePointerEvent("pointermove", targetX, y));
        await waitForLayout();
        document.dispatchEvent(mousePointerEvent("pointermove", targetX + 1, y));
        await nextFrame();
        document.dispatchEvent(mousePointerEvent("pointerup", targetX + 1, y));
        await vi.waitFor(() =>
          expect(useOpenThreadTabsStore.getState().threadIds).toEqual([
            THREAD_ID,
            thirdId,
            OTHER_THREAD_ID,
          ]),
        );
        expect(
          JSON.parse(localStorage.getItem("synara:open-thread-tabs:v1")!).state.threadIds,
        ).toEqual([THREAD_ID, thirdId, OTHER_THREAD_ID]);
        await vi.waitFor(() =>
          expect(mounted.router.state.location.pathname).toBe(`/${OTHER_THREAD_ID}`),
        );
        expect(
          document.querySelector('nav[aria-label="Open threads"] button[aria-current="page"]')
            ?.textContent,
        ).toBe("New thread");
        expect(
          [
            ...document.querySelectorAll(
              'nav[aria-label="Open threads"] [data-surface-tab] > button:not([aria-label])',
            ),
          ].map((label) => label.textContent),
        ).toEqual([THREAD_TITLE, "Destination tab", "New thread"]);
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("keeps close-button pointer travel from starting a horizontal tab drag", async () => {
    const snapshot = addThreadToSnapshot(
      createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("drag-close"),
        targetText: "Close a tab",
      }),
      OTHER_THREAD_ID,
    );
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    try {
      useOpenThreadTabsStore.setState({ threadIds: [THREAD_ID, OTHER_THREAD_ID] });
      await vi.waitFor(() =>
        expect(
          document.querySelectorAll('nav[aria-label="Open threads"] [data-surface-tab]'),
        ).toHaveLength(2),
      );
      const button = document.querySelectorAll<HTMLButtonElement>(
        'nav[aria-label="Open threads"] button[aria-label^="Close "]',
      )[0]!;
      await userEvent.hover(button);
      await userEvent.dragAndDrop(button, button, {
        sourcePosition: { x: 12, y: 12 },
        targetPosition: { x: 19, y: 12 },
      });
      await vi.waitFor(
        () => expect(useOpenThreadTabsStore.getState().threadIds).not.toContain(THREAD_ID),
        {
          timeout: 2_000,
        },
      );
      expect(useOpenThreadTabsStore.getState().threadIds).toEqual([OTHER_THREAD_ID]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the thread menu on a tab right-click and closes the tabs its close row names", async () => {
    const thirdId = ThreadId.makeUnsafe("tab-menu-third");
    const snapshot = addThreadToSnapshot(
      addThreadToSnapshot(
        createSnapshotForTargetUser({
          targetMessageId: MessageId.makeUnsafe("tab-menu"),
          targetText: "Tab menu",
        }),
        OTHER_THREAD_ID,
      ),
      thirdId,
    );
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    try {
      useOpenThreadTabsStore.setState({ threadIds: [THREAD_ID, OTHER_THREAD_ID, thirdId] });
      await vi.waitFor(() =>
        expect(
          document.querySelectorAll('nav[aria-label="Open threads"] [data-surface-tab]'),
        ).toHaveLength(3),
      );
      // The last tab, while the first one is on screen.
      document
        .querySelectorAll('nav[aria-label="Open threads"] [data-surface-tab]')[2]!
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 320, clientY: 24 }));
      await vi.waitFor(() =>
        expect(contextMenuRows().map((row) => row.textContent)).toEqual(
          expect.arrayContaining(["Rename thread", "Pin thread", "Archive", "Delete"]),
        ),
      );
      // Nothing sits to the right of the last tab, so that row is left out.
      expect(
        contextMenuRows()
          .map((row) => row.textContent)
          .filter((label) => label?.startsWith("Close ")),
      ).toEqual(["Close Tabs to the Left", "Close Other Tabs"]);
      contextMenuRows()
        .find((row) => row.textContent === "Close Tabs to the Left")!
        .click();

      // The thread on screen was among the closed tabs, so the kept tab takes over.
      await vi.waitFor(() =>
        expect(useOpenThreadTabsStore.getState().threadIds).toEqual([thirdId]),
      );
      expect(mounted.router.state.location.pathname).toBe(`/${thirdId}`);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the saved editor chat reachable while an unsent draft is on screen", async () => {
    useOpenThreadTabsStore.setState({ threadIds: [] });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("editor-draft-return"),
        targetText: "Saved editor chat",
      }),
      initialEntry: `/${THREAD_ID}?view=editor`,
    });
    try {
      // A lone active saved chat still needs no redundant rail tab.
      expect(page.getByRole("button", { name: "Chat 1", exact: true }).elements()).toHaveLength(0);
      const draftId = ThreadId.makeUnsafe("019f88ab-cdea-7100-8b00-000000000022");
      useComposerDraftStore.getState().setProjectDraftThreadId(PROJECT_ID, draftId, {});
      useComposerDraftStore.getState().setPrompt(draftId, "Keep this unsent prompt");
      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: draftId },
        search: () => ({ view: "editor" as const }),
      });
      await vi.waitFor(() =>
        expect(document.querySelector('[contenteditable="true"]')?.textContent).toBe(
          "Keep this unsent prompt",
        ),
      );
      const savedTab = page.getByRole("button", { name: "Chat 1", exact: true });
      await expect.element(savedTab, { timeout: 2_000 }).toBeVisible();
      expect(savedTab.element().getAttribute("aria-pressed")).toBe("false");
      expect(page.getByRole("button", { name: "Chat 2", exact: true }).elements()).toHaveLength(0);
      await savedTab.click();
      await waitForURL(
        mounted.router,
        (path) => path === `/${THREAD_ID}`,
        "The saved tab should return to its chat from the draft.",
      );
      expect(mounted.router.state.location.search.view).toBe("editor");
      expect(useComposerDraftStore.getState().draftsByThreadId[draftId]?.prompt).toBe(
        "Keep this unsent prompt",
      );
      await expect.element(page.getByTestId("composer-editor")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it.each(["terminal", "close", "navigation", "navigation-back", "inflight"] as const)(
    "cancels a pending editor chat tab switch after %s",
    async (action) => {
      const laterThreadId = ThreadId.makeUnsafe("editor-tab-later-navigation");
      const snapshot = addThreadToSnapshot(
        addThreadToSnapshot(
          createSnapshotForTargetUser({
            targetMessageId: MessageId.makeUnsafe("editor-tab-cancel"),
            targetText: "Editor chat",
          }),
          OTHER_THREAD_ID,
        ),
        laterThreadId,
      );
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot,
        initialEntry: `/${THREAD_ID}?view=editor`,
      });
      try {
        const laterNavigation =
          action === "navigation" || action === "navigation-back" || action === "inflight";
        useOpenThreadTabsStore.setState({
          threadIds: [THREAD_ID, OTHER_THREAD_ID, ...(laterNavigation ? [laterThreadId] : [])],
        });
        useTerminalStateStore.getState().setTerminalOpen(THREAD_ID, true);
        await expect
          .element(page.getByRole("button", { name: "Terminal", exact: true }))
          .toBeVisible();
        await page.getByRole("button", { name: "Chat 1", exact: true }).click();
        await waitForLayout();
        // Hold deferred activation until the later terminal, close or navigation action.
        const frames: FrameRequestCallback[] = [];
        const animationFrame = vi
          .spyOn(window, "requestAnimationFrame")
          .mockImplementation((callback) => {
            frames.push(callback);
            return frames.length;
          });
        let pressedLaterTab = false;
        let firstNavigation: Promise<void> | null = null;
        if (action === "inflight") {
          const navigate = mounted.router.navigate;
          vi.spyOn(mounted.router, "navigate").mockImplementation((options) => {
            const result = navigate(options);
            if (
              !pressedLaterTab &&
              options.to === "/$threadId" &&
              options.params &&
              typeof options.params === "object" &&
              "threadId" in options.params &&
              (options.params as { threadId?: string }).threadId === OTHER_THREAD_ID
            ) {
              firstNavigation = result;
              // The second click happens after activate returns, before React commits
              // the first route. Use the actual router, without a synthetic loader.
              queueMicrotask(() => {
                pressedLaterTab = true;
                (
                  page
                    .getByRole("button", { name: "Chat 3", exact: true })
                    .element() as HTMLButtonElement
                ).click();
              });
            }
            return result;
          });
        }
        (
          page.getByRole("button", { name: "Chat 2", exact: true }).element() as HTMLButtonElement
        ).click();
        if (action === "terminal") {
          (
            page
              .getByRole("button", { name: "Terminal", exact: true })
              .element() as HTMLButtonElement
          ).click();
        } else if (action === "inflight") {
          const firstFrames = frames.slice();
          for (const callback of firstFrames) callback(performance.now());
          await vi.waitFor(() => expect(pressedLaterTab).toBe(true), { timeout: 2_000 });
          await firstNavigation;
          await new Promise((resolve) => window.setTimeout(resolve, 0));
          frames.splice(0, firstFrames.length);
        } else if (laterNavigation) {
          await mounted.router.navigate({
            to: "/$threadId",
            params: { threadId: laterThreadId },
            search: () => ({ view: "editor" as const }),
          });
          await expect
            .element(page.getByRole("button", { name: "Chat 3", exact: true }))
            .toHaveAttribute("aria-pressed", "true");
          if (action === "navigation-back") {
            await mounted.router.navigate({
              to: "/$threadId",
              params: { threadId: THREAD_ID },
              search: () => ({ view: "editor" as const }),
            });
            expect(mounted.router.state.location.pathname).toBe(`/${THREAD_ID}`);
            await new Promise((resolve) => window.setTimeout(resolve, 0));
          }
        } else {
          const targetTab = page.getByRole("button", { name: "Chat 2", exact: true }).element();
          const closeButton = targetTab
            .closest("[data-surface-tab]")!
            .querySelector<HTMLButtonElement>("button[aria-label^='Close ']")!;
          closeButton.click();
          await vi.waitFor(() => {
            expect(useOpenThreadTabsStore.getState().threadIds).not.toContain(OTHER_THREAD_ID);
          });
        }
        animationFrame.mockRestore();
        for (const callback of frames) callback(performance.now());
        await new Promise((resolve) => window.setTimeout(resolve, 550));
        expect(mounted.router.state.location.pathname).toBe(
          `/${action === "navigation" || action === "inflight" ? laterThreadId : THREAD_ID}`,
        );
        if (action === "terminal") {
          await expect
            .element(page.getByRole("button", { name: "Terminal", exact: true }))
            .toHaveAttribute("aria-pressed", "true");
        } else if (action === "inflight") {
          expect(
            page
              .getByRole("button", { name: "Chat 3", exact: true })
              .element()
              .getAttribute("aria-pressed"),
          ).toBe("true");
        } else if (action === "navigation-back") {
          expect(
            page
              .getByRole("button", { name: "Chat 1", exact: true })
              .element()
              .getAttribute("aria-pressed"),
          ).toBe("true");
        } else if (action === "close") {
          expect(useOpenThreadTabsStore.getState().threadIds).not.toContain(OTHER_THREAD_ID);
        }
      } finally {
        vi.restoreAllMocks();
        await mounted.cleanup();
      }
    },
  );

  it.each([false, true])(
    "keeps the trailing sidebar PR state accessible and clear of hover actions (pinned: %s)",
    async (pinned) => {
      const snapshot = createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("sidebar-pr-chip"),
        targetText: "Review the linked pull request",
      });
      const pr = {
        number: 841,
        title: "Fix session recovery",
        url: "https://github.com/acme/synara/pull/841",
        baseBranch: "main",
        headBranch: "fix/session-recovery",
        state: "open" as const,
        isDraft: false,
        mergeability: "mergeable" as const,
      };
      const previousPins = usePinnedThreadsStore.getState().pinnedThreadIds;
      usePinnedThreadsStore.setState({ pinnedThreadIds: pinned ? [THREAD_ID] : [] });
      onTestFinished(() => {
        usePinnedThreadsStore.setState({ pinnedThreadIds: previousPins });
      });
      const mounted = await mountChatView({
        viewport: { ...DEFAULT_VIEWPORT, width: 1280, height: 800 },
        snapshot: {
          ...snapshot,
          threads: snapshot.threads.map((thread) => ({ ...thread, lastKnownPr: pr })),
        },
      });
      try {
        const sidebar = document.querySelector<HTMLElement>('[data-slot="sidebar-container"]')!;
        const row = page.getByRole("button", { name: `Open ${THREAD_TITLE}`, exact: true });
        await vi.waitFor(() =>
          expect(useStore.getState().sidebarThreadSummaryById[THREAD_ID]?.lastKnownPr?.number).toBe(
            841,
          ),
        );
        await expect
          .element(row, { timeout: 2_000 })
          .toHaveAccessibleDescription("#841 PR open: Fix session recovery");
        const rowElement = row.element() as HTMLElement;
        expect(rowElement.querySelector('button[aria-label*="#841"]')).toBeNull();
        const wrapper = sidebar.closest<HTMLElement>('[data-slot="sidebar-wrapper"]')!;
        for (const fontSize of [13, 18]) {
          const scale = getAppTypographyScale(fontSize);
          for (const [token, value] of Object.entries({
            ui: scale.uiPx,
            "ui-lg": scale.uiLgPx,
            "ui-sm": scale.uiSmPx,
            "ui-xs": scale.uiXsPx,
            "ui-meta": scale.uiMetaPx,
          })) {
            document.documentElement.style.setProperty(`--app-font-size-${token}`, `${value}px`);
          }
          for (const width of [208, 320]) {
            wrapper.style.setProperty("--sidebar-width", `${width}px`);
            await vi.waitFor(() =>
              expect(sidebar.getBoundingClientRect().width).toBeCloseTo(width, 0),
            );
            await userEvent.hover(rowElement);
            const actions = rowElement.querySelector<HTMLElement>(
              `[data-testid="thread-hover-actions-${THREAD_ID}"]`,
            )!;
            await vi.waitFor(() => {
              expect(Number(getComputedStyle(actions).opacity)).toBe(1);
              const title = rowElement.querySelector<HTMLElement>(".truncate-fade")!;
              expect(title.getBoundingClientRect().right).toBeLessThanOrEqual(
                actions.getBoundingClientRect().left,
              );
            });
            await userEvent.unhover(rowElement);
          }
        }
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("steps through horizontal tabs with the previous/next tab shortcuts, wrapping at the ends", async () => {
    useOpenThreadTabsStore.setState({ threadIds: [] });
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: MessageId.makeUnsafe("tab-shortcuts"),
      targetText: "Tab shortcuts conversation",
    });
    const thirdId = ThreadId.makeUnsafe("tab-shortcuts-third");
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: addThreadToSnapshot(addThreadToSnapshot(snapshot, OTHER_THREAD_ID), thirdId),
    });
    const pressTabShortcut = async (direction: "next" | "previous") => {
      const key = isMacNavigatorPlatform()
        ? direction === "next"
          ? "ArrowRight"
          : "ArrowLeft"
        : direction === "next"
          ? "PageDown"
          : "PageUp";
      await userEvent.keyboard(
        isMacNavigatorPlatform()
          ? `{Meta>}{Control>}{${key}}{/Control}{/Meta}`
          : `{Control>}{${key}}{/Control}`,
      );
    };
    const expectRoute = (threadId: ThreadId) =>
      vi.waitFor(() => expect(mounted.router.state.location.pathname).toBe(`/${threadId}`));
    try {
      useOpenThreadTabsStore.setState({ threadIds: [THREAD_ID, OTHER_THREAD_ID, thirdId] });
      await vi.waitFor(() =>
        expect(
          document.querySelectorAll('nav[aria-label="Open threads"] [data-surface-tab]'),
        ).toHaveLength(3),
      );

      document.querySelector<HTMLElement>('[contenteditable="true"]')!.focus();
      await userEvent.keyboard("Unsent source draft");
      await pressTabShortcut("next");
      await expectRoute(OTHER_THREAD_ID);
      await pressTabShortcut("next");
      await expectRoute(thirdId);
      await pressTabShortcut("next");
      await expectRoute(THREAD_ID);
      expect(document.querySelector('[contenteditable="true"]')?.textContent).toContain(
        "Unsent source draft",
      );
      await pressTabShortcut("previous");
      await expectRoute(thirdId);
    } finally {
      await mounted.cleanup();
    }
  });

  it.each(["saved"] as const)(
    "switches horizontal tabs without blanking the header or composer (%s)",
    async (targetKind) => {
      onTestFinished(skipReactDevOwnerStacks());
      useOpenThreadTabsStore.setState({ threadIds: [] });
      let snapshot = createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("horizontal-tabs"),
        targetText: "Horizontal tabs conversation",
      });
      {
        const source = snapshot.threads[0]!;
        snapshot = {
          ...snapshot,
          threads: [
            ...snapshot.threads,
            {
              ...source,
              id: OTHER_THREAD_ID,
              title: "Other tab",
              session: source.session ? { ...source.session, threadId: OTHER_THREAD_ID } : null,
              messages: source.messages.map((message) => ({
                ...message,
                id: MessageId.makeUnsafe(`other-${message.id}`),
              })),
            },
          ],
        };
      }
      const commits: number[] = [];
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot,
        onRender: (_id, _phase, duration) => commits.push(duration),
      });
      try {
        useComposerDraftStore.getState().setPrompt(THREAD_ID, "Draft in first tab");
        useComposerDraftStore.getState().setPrompt(OTHER_THREAD_ID, "Draft in second tab");
        useOpenThreadTabsStore.setState({ threadIds: [THREAD_ID, OTHER_THREAD_ID] });
        await vi.waitFor(() =>
          expect(document.querySelector('[contenteditable="true"]')?.textContent).toContain(
            "Draft in first tab",
          ),
        );
        await waitForLayout();

        const samples = [];
        const storageWrites = vi.spyOn(Storage.prototype, "setItem");
        onTestFinished(() => storageWrites.mockRestore());
        // The opt-in runs the same correctness path for longer; do not add a
        // wall-clock threshold to CI. The first round trip warms both targets.
        const rounds = import.meta.env.VITE_TAB_SWITCH_BENCHMARK === "1" ? 12 : 2;
        for (let index = 0; index < rounds * 2; index += 1) {
          const toSecond = index % 2 === 0;
          const targetId = toSecond ? OTHER_THREAD_ID : THREAD_ID;
          const expectedPrompt = toSecond ? "Draft in second tab" : "Draft in first tab";
          const tabButtons = document.querySelectorAll<HTMLButtonElement>(
            'nav[aria-label="Open threads"] [data-surface-tab] > button:not([aria-label])',
          );
          expect(tabButtons).toHaveLength(2);
          commits.length = 0;
          storageWrites.mockClear();
          const startedAt = performance.now();
          let missingHeaderFrames = 0;
          let missingComposerFrames = 0;
          tabButtons[toSecond ? 1 : 0]!.click();
          let ready = false;
          let domReadyMs: number | null = null;
          while (performance.now() - startedAt < 5_000) {
            await nextFrame();
            const activeTab = document.querySelector(
              'nav[aria-label="Open threads"] button[aria-current="page"]',
            );
            const editor = document.querySelector(
              '[data-chat-composer-form="true"] [contenteditable="true"]',
            );
            if (!activeTab) missingHeaderFrames += 1;
            if (!editor) missingComposerFrames += 1;
            if (
              mounted.router.state.location.pathname === `/${targetId}` &&
              activeTab &&
              editor?.textContent === expectedPrompt &&
              document.querySelector(
                `[data-assistant-message-id="${toSecond ? "other-" : ""}msg-assistant-21"]`,
              )
            ) {
              domReadyMs ??= performance.now() - startedAt;
              const scrollContainer = document.querySelector<HTMLElement>(
                '[data-chat-scroll-container="true"]',
              );
              // A row in the DOM can still be transparent while LegendList
              // settles its initial scroll. Include that work in opening time.
              if (scrollContainer && isTranscriptContentVisible(scrollContainer)) {
                ready = true;
                break;
              }
            }
          }
          expect(ready, "Target tab must show its own composer and transcript").toBe(true);
          samples.push({
            target: targetKind,
            ms: performance.now() - startedAt,
            domReadyMs,
            reactMs: commits.reduce((sum, duration) => sum + duration, 0),
            commits: commits.length,
            tabWrites: storageWrites.mock.calls.filter(
              ([key]) => key === "synara:open-thread-tabs:v1",
            ).length,
            missingHeaderFrames,
            missingComposerFrames,
          });
          await waitForLayout();
        }
        if (import.meta.env.VITE_TAB_SWITCH_BENCHMARK === "1") {
          console.info(`TAB_SWITCH_BENCHMARK ${JSON.stringify({ targetKind, samples })}`);
        }
        expect(samples.every((sample) => sample.missingHeaderFrames === 0)).toBe(true);
        expect(samples.every((sample) => sample.missingComposerFrames === 0)).toBe(true);
        expect(samples.every((sample) => sample.tabWrites === 0)).toBe(true);
        expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
          "Draft in first tab",
        );
        expect(useComposerDraftStore.getState().draftsByThreadId[OTHER_THREAD_ID]?.prompt).toBe(
          "Draft in second tab",
        );
        // Retaining the surrounding composer must not retain another chat's
        // Lexical undo history or route its edits into the destination draft.
        const firstEditor = await waitForComposerEditor();
        await userEvent.click(firstEditor);
        await userEvent.keyboard("{End} private text");
        await vi.waitFor(() =>
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toContain(
            "private text",
          ),
        );
        const secondTab = document.querySelectorAll<HTMLButtonElement>(
          'nav[aria-label="Open threads"] [data-surface-tab] > button:not([aria-label])',
        )[1]!;
        secondTab.click();
        await vi.waitFor(() =>
          expect(document.querySelector('[contenteditable="true"]')?.textContent).toBe(
            "Draft in second tab",
          ),
        );
        const secondEditor = await waitForComposerEditor();
        await userEvent.click(secondEditor);
        await userEvent.keyboard(
          isMacNavigatorPlatform() ? "{Meta>}z{/Meta}" : "{Control>}z{/Control}",
        );
        await waitForLayout();
        expect(secondEditor.textContent).toBe("Draft in second tab");
        expect(useComposerDraftStore.getState().draftsByThreadId[OTHER_THREAD_ID]?.prompt).toBe(
          "Draft in second tab",
        );
      } finally {
        await mounted.cleanup();
        useOpenThreadTabsStore.setState({ threadIds: [] });
      }
    },
  );

  it("closing the last visible tab returns to an unsent draft hidden from the strip", async () => {
    useOpenThreadTabsStore.setState({ threadIds: [] });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("last-tab-hidden-draft"),
        targetText: "Completed conversation",
      }),
    });
    try {
      await waitForLayout();
      const draftId = ThreadId.makeUnsafe("hidden-unsent-draft");
      useComposerDraftStore.getState().setProjectDraftThreadId(PROJECT_ID, draftId, {});
      useComposerDraftStore.getState().setPrompt(draftId, "Unsent text behind the only tab");
      // The draft is open but has no tab, so the saved chat is the last one in the strip.
      useOpenThreadTabsStore.setState({ threadIds: [draftId, THREAD_ID] });
      const close = await waitForElement<HTMLButtonElement>(
        () => document.querySelector('nav[aria-label="Open threads"] button[aria-label^="Close "]'),
        "The active thread should have a closeable tab.",
      );
      close.click();
      await waitForURL(
        mounted.router,
        (path) => path === `/${draftId}`,
        "Closing the last visible tab should return to the open draft.",
      );
      expect(useComposerDraftStore.getState().draftsByThreadId[draftId]?.prompt).toBe(
        "Unsent text behind the only tab",
      );
      expect(useOpenThreadTabsStore.getState().threadIds).not.toContain(THREAD_ID);
    } finally {
      await mounted.cleanup();
      useOpenThreadTabsStore.setState({ threadIds: [] });
    }
  });

  it.each(["home", "project"] as const)(
    "closing the last %s tab opens a fresh draft in the same project",
    async (surface) => {
      useOpenThreadTabsStore.setState({ threadIds: [] });
      const snapshot = createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("last-tab-close"),
        targetText: "Completed conversation",
      });
      const projectId = surface === "home" ? HOME_PROJECT_ID : PROJECT_ID;
      const staleDraftId = ThreadId.makeUnsafe("closed-unsent-draft");
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot:
          surface === "home" ? withActiveHomeChatThread(snapshot) : withHomeChatProject(snapshot),
        configureFixture: (nextFixture) => {
          nextFixture.welcome = {
            ...nextFixture.welcome,
            homeDir: "/Users/tester",
            chatWorkspaceRoot: "/Users/tester/Documents/Synara",
          };
        },
      });
      try {
        await waitForLayout();
        useComposerDraftStore.getState().setProjectDraftThreadId(projectId, staleDraftId, {});
        useComposerDraftStore.getState().setPrompt(staleDraftId, "Unsent text from a closed tab");
        useOpenThreadTabsStore.setState({ threadIds: [THREAD_ID] });
        useProjectEnvironmentStore.getState().setProjectEnvMode(projectId, "worktree");
        const close = await waitForElement<HTMLButtonElement>(
          () =>
            document.querySelector('nav[aria-label="Open threads"] button[aria-label^="Close "]'),
          "The active thread should have a closeable rail tab.",
        );
        close.click();
        await vi.waitFor(() => {
          const nextId = mounted.router.state.location.pathname.slice(1) as ThreadId;
          expect(nextId).not.toBe(THREAD_ID);
          expect(nextId).not.toBe(staleDraftId);
          const state = useComposerDraftStore.getState();
          expect(state.getDraftThread(nextId)?.projectId).toBe(projectId);
          expect(state.getDraftThread(nextId)?.envMode).toBe(
            surface === "home" ? "local" : "worktree",
          );
          expect(state.draftsByThreadId[nextId]?.prompt ?? "").toBe("");
          expect(useOpenThreadTabsStore.getState().threadIds).not.toContain(THREAD_ID);
        });
      } finally {
        await mounted.cleanup();
        useOpenThreadTabsStore.setState({ threadIds: [] });
      }
    },
  );

  it("waits for a completed click before switching tabs without remounting the strip", async () => {
    useOpenThreadTabsStore.setState({ threadIds: [] });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: addThreadToSnapshot(
        createSnapshotForTargetUser({
          targetMessageId: MessageId.makeUnsafe("tab-switch-target"),
          targetText: "Conversation behind the first tab",
        }),
        OTHER_THREAD_ID,
      ),
    });
    try {
      await waitForLayout();
      // The first visit to a saved chat must keep the header mounted.
      useOpenThreadTabsStore.setState({ threadIds: [THREAD_ID, OTHER_THREAD_ID] });
      const strip = await waitForElement<HTMLElement>(
        () => document.querySelector('nav[aria-label="Open threads"]'),
        "The rail chat header should show the open-thread strip.",
      );
      const targetTab = await waitForElement<HTMLButtonElement>(
        () => strip.querySelector('button[title="New thread"]'),
        "The saved thread should have a tab.",
      );
      let stripLeftDocument = false;
      const observer = new MutationObserver(() => {
        if (!strip.isConnected) stripLeftDocument = true;
      });
      observer.observe(document.body, { childList: true, subtree: true });
      try {
        targetTab.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0 }),
        );
        await waitForLayout();
        expect(targetTab.getAttribute("aria-current")).toBeNull();
        expect(mounted.router.state.location.pathname).toBe(`/${THREAD_ID}`);

        targetTab.dispatchEvent(new PointerEvent("pointerout", { bubbles: true }));
        targetTab.dispatchEvent(
          new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse", button: 0 }),
        );
        await waitForLayout();
        expect(targetTab.getAttribute("aria-current")).toBeNull();
        expect(mounted.router.state.location.pathname).toBe(`/${THREAD_ID}`);

        await userEvent.click(targetTab);
        await Promise.resolve();
        expect(targetTab.getAttribute("aria-current")).toBe("page");

        await vi.waitFor(() =>
          expect(mounted.router.state.location.pathname).toBe(`/${OTHER_THREAD_ID}`),
        );
        await waitForElement(
          () => document.querySelector('[data-testid="empty-landing-heading"]'),
          "The empty thread's landing should render.",
        );
        await waitForLayout();
        expect(stripLeftDocument).toBe(false);
        expect(targetTab.getAttribute("aria-current")).toBe("page");
      } finally {
        observer.disconnect();
      }
    } finally {
      await mounted.cleanup();
      useOpenThreadTabsStore.setState({ threadIds: [] });
    }
  });

  it("reveals an opened transcript once its end scroll lands, not after the list's fallback delay", async () => {
    onTestFinished(skipReactDevOwnerStacks());
    useOpenThreadTabsStore.setState({ threadIds: [] });
    const base = createSnapshotForTargetUser({
      targetMessageId: MessageId.makeUnsafe("transcript-reveal"),
      targetText: "Transcript reveal conversation",
    });
    const source = base.threads[0]!;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...base,
        threads: [
          source,
          {
            ...source,
            id: OTHER_THREAD_ID,
            title: "Other tab",
            session: source.session ? { ...source.session, threadId: OTHER_THREAD_ID } : null,
            messages: source.messages.map((message) =>
              Object.assign({}, message, { id: MessageId.makeUnsafe(`other-${message.id}`) }),
            ),
          },
        ],
      },
    });
    try {
      useOpenThreadTabsStore.setState({ threadIds: [THREAD_ID, OTHER_THREAD_ID] });
      await waitForLayout();
      const scrollToVisibleMs: number[] = [];
      for (let index = 0; index < 5; index += 1) {
        const toSecond = index % 2 === 0;
        const targetId = toSecond ? OTHER_THREAD_ID : THREAD_ID;
        const tabButtons = document.querySelectorAll<HTMLButtonElement>(
          'nav[aria-label="Open threads"] [data-surface-tab] > button:not([aria-label])',
        );
        let scrolledAt: number | null = null;
        const onScroll = (event: Event) => {
          if ((event.target as HTMLElement | null)?.dataset?.chatScrollContainer === "true") {
            scrolledAt ??= performance.now();
          }
        };
        document.addEventListener("scroll", onScroll, { capture: true });
        const startedAt = performance.now();
        tabButtons[toSecond ? 1 : 0]!.click();
        let visibleAt: number | null = null;
        let distanceFromBottomPx: number | null = null;
        while (performance.now() - startedAt < 5_000) {
          await nextFrame();
          const scrollContainer = document.querySelector<HTMLElement>(
            '[data-chat-scroll-container="true"]',
          );
          if (
            mounted.router.state.location.pathname === `/${targetId}` &&
            scrollContainer?.querySelector(
              `[data-assistant-message-id="${toSecond ? "other-" : ""}msg-assistant-21"]`,
            ) &&
            isTranscriptContentVisible(scrollContainer)
          ) {
            visibleAt = performance.now();
            distanceFromBottomPx =
              scrollContainer.scrollHeight -
              scrollContainer.clientHeight -
              scrollContainer.scrollTop;
            break;
          }
        }
        document.removeEventListener("scroll", onScroll, { capture: true });
        expect(visibleAt, "The opened transcript must become visible").not.toBeNull();
        // Revealing early must not expose a transcript that is not at its end yet.
        expect(distanceFromBottomPx).toBeLessThanOrEqual(1);
        expect(scrolledAt, "Opening a transcript scrolls it to its end").not.toBeNull();
        scrollToVisibleMs.push(visibleAt! - scrolledAt!);
        await waitForLayout();
      }
      // The list hides its rows until its initial end scroll counts as finished. Its target
      // sits past what the scroller can reach (footer and bottom padding), so without the
      // native-end check in the @legendapp/list patch that only happens on a fixed 100 ms
      // fallback: about 80 ms here, against one frame with it. The median keeps one slow
      // frame on a busy worker from deciding.
      const median = scrollToVisibleMs.toSorted((left, right) => left - right)[2]!;
      expect(median, JSON.stringify(scrollToVisibleMs)).toBeLessThan(50);
    } finally {
      await mounted.cleanup();
      useOpenThreadTabsStore.setState({ threadIds: [] });
    }
  });

  it("preserves a home-chat draft when the chat.newChat shortcut is reused after a thread switch", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withActiveHomeChatThread(
        addThreadToSnapshot(
          createSnapshotForTargetUser({
            targetMessageId: "msg-user-home-draft-shortcut-switch" as MessageId,
            targetText: "home draft shortcut switch target",
          }),
          OTHER_THREAD_ID,
        ),
      ),
      configureFixture: (nextFixture) => {
        nextFixture.welcome = {
          ...nextFixture.welcome,
          homeDir: "/Users/tester",
          chatWorkspaceRoot: "/Users/tester/Documents/Synara",
          studioWorkspaceRoot: "/Users/tester/Documents/Synara/Studio",
        };
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "chat.newChat",
              shortcut: {
                key: "n",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: true,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      await waitForLayout();
      const dispatchNewChatShortcut = () => {
        const useMetaForMod = isMacNavigatorPlatform();
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "n",
            metaKey: useMetaForMod,
            ctrlKey: !useMetaForMod,
            altKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      };
      const newThreadPath = await triggerThreadShortcutUntilPath(
        mounted.router,
        dispatchNewChatShortcut,
        (path) => UUID_ROUTE_RE.test(path),
        "chat.newChat should route to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      // Type a draft in the new home chat
      const prompt = "draft typed via chat.newChat";
      useComposerDraftStore.getState().setPrompt(newThreadId, prompt);
      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().draftsByThreadId[newThreadId]?.prompt).toBe(
            prompt,
          );
        },
        { timeout: 8_000, interval: 16 },
      );

      // Switch to another thread and come back via the same shortcut
      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: OTHER_THREAD_ID },
      });
      await waitForLayout();
      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.pathname).toBe(`/${OTHER_THREAD_ID}`);
        },
        { timeout: 8_000, interval: 16 },
      );

      const returnedPath = await triggerThreadShortcutUntilPath(
        mounted.router,
        dispatchNewChatShortcut,
        (path) => UUID_ROUTE_RE.test(path),
        "chat.newChat should route back to a draft thread UUID.",
      );
      await vi.waitFor(
        () => {
          expect(returnedPath).toBe(newThreadPath);
        },
        { timeout: 8_000, interval: 16 },
      );

      // The draft must survive the round trip on the same thread
      expect(useComposerDraftStore.getState().draftsByThreadId[newThreadId]?.prompt).toBe(prompt);
      const composerEditorAfter = await waitForComposerEditor();
      await vi.waitFor(
        () => {
          expect(composerEditorAfter.textContent ?? "").toContain(prompt);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("promotes terminal-first shortcut threads so they render as terminal rows", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-terminal-shortcut-test" as MessageId,
        targetText: "terminal shortcut test",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "chat.newTerminal",
              shortcut: {
                key: "t",
                metaKey: false,
                ctrlKey: false,
                shiftKey: true,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      await waitForLayout();
      const newThreadPath = await triggerTerminalThreadShortcutUntilPath(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new terminal-first draft thread UUID from the shortcut.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      await vi.waitFor(
        () => {
          expect(
            wsRequests.some(
              (request) =>
                request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                typeof request.command === "object" &&
                request.command !== null &&
                "type" in request.command &&
                "threadId" in request.command &&
                request.command.type === "thread.create" &&
                request.command.threadId === newThreadId,
            ),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );

      useStore.getState().syncServerReadModel(addThreadToSnapshot(fixture.snapshot, newThreadId));
      useComposerDraftStore.getState().clearDraftThread(newThreadId);

      await vi.waitFor(
        () => {
          const terminalThreadRow = document.querySelector<HTMLElement>(
            '[data-thread-entry-point="terminal"]',
          );
          expect(terminalThreadRow).not.toBeNull();
          expect(terminalThreadRow?.textContent).toContain("New thread");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("promotes a stored terminal draft using its saved context and model selection", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    const draftThreadId = ThreadId.makeUnsafe("thread-terminal-draft-reuse");
    useComposerDraftStore.setState({
      draftsByThreadId: {
        [draftThreadId]: {
          prompt: "",
          promptHistorySavedDraft: null,
          images: [],
          files: [],
          nonPersistedImageIds: [],
          persistedAttachments: [],
          assistantSelections: [],
          browserAnnotations: [],
          terminalContexts: [],
          fileComments: [],
          pastedTexts: [],
          pullRequestContexts: [],
          skills: [],
          mentions: [],
          queuedTurns: [],
          modelSelectionByProvider: {
            claudeAgent: {
              provider: "claudeAgent",
              model: "claude-opus-4-6",
              options: {
                effort: "max",
              },
            },
          },
          activeProvider: "claudeAgent",
          runtimeMode: null,
          interactionMode: null,
        },
      },
      draftThreadsByThreadId: {
        [draftThreadId]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "approval-required",
          interactionMode: "default",
          entryPoint: "terminal",
          branch: "feature/terminal-title",
          worktreePath: "/repo/project/.worktrees/terminal-title",
          envMode: "worktree",
        },
      },
      projectDraftThreadIdByProjectId: {
        [`${PROJECT_ID}::terminal`]: draftThreadId,
      },
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-terminal-draft-reuse-test" as MessageId,
        targetText: "terminal draft reuse test",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "chat.newTerminal",
              shortcut: {
                key: "t",
                metaKey: false,
                ctrlKey: false,
                shiftKey: true,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      await waitForLayout();
      dispatchTerminalThreadShortcut();

      await waitForURL(
        mounted.router,
        (path) => path === `/${draftThreadId}`,
        "Shortcut should reuse the stored terminal draft thread route.",
      );

      await vi.waitFor(
        () => {
          const createRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              typeof request.command === "object" &&
              request.command !== null &&
              "type" in request.command &&
              "threadId" in request.command &&
              request.command.type === "thread.create" &&
              request.command.threadId === draftThreadId,
          );

          expect(createRequest).toBeTruthy();
          expect(createRequest?.command).toMatchObject({
            branch: "feature/terminal-title",
            worktreePath: "/repo/project/.worktrees/terminal-title",
            runtimeMode: "approval-required",
            modelSelection: {
              provider: "claudeAgent",
              model: "claude-opus-4-6",
              options: {
                effort: "max",
              },
            },
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it.each(["extras panel", "edit button"])(
    "sets a literal control-word goal from the %s",
    async (entryPoint) => {
      const snapshot = createSnapshotForTargetUser({
        targetMessageId: "msg-user-literal-goal-test" as MessageId,
        targetText: "literal goal test",
      });
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: {
          ...snapshot,
          threads: [{ ...snapshot.threads[0]!, goal: "clear" }],
        },
      });
      const restoreNativeApi = installDeterministicSendNativeApi();

      try {
        if (entryPoint === "edit button") {
          await page.getByRole("button", { name: "Edit goal" }).click();
        } else {
          useComposerDraftStore.getState().setPrompt(THREAD_ID, "clear");
          const composerEditor = await waitForComposerEditor();
          await vi.waitFor(() => expect(composerEditor.textContent ?? "").toContain("clear"));
          await page.getByLabelText("Composer extras").click();
          await page.getByText("Set a goal to keep pursuing").click();
        }
        await vi.waitFor(() =>
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
            "/goal -- clear",
          ),
        );
        const sendButton = await waitForSendButton();
        sendButton.click();

        await vi.waitFor(() => {
          const request = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              typeof request.command === "object" &&
              request.command !== null &&
              "type" in request.command &&
              request.command.type === "thread.meta.update" &&
              "goal" in request.command,
          );
          expect(request?.command).toMatchObject({ type: "thread.meta.update", goal: "clear" });
        });
      } finally {
        restoreNativeApi();
        await mounted.cleanup();
      }
    },
  );

  it("activates Debug with /debug and returns to Default from the badge and /default", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-debug-mode-test" as MessageId,
        targetText: "debug mode test",
      }),
    });

    try {
      const readInteractionMode = () =>
        useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.interactionMode ?? "default";
      const runSlashCommand = async (command: string) => {
        useComposerDraftStore.getState().setPrompt(THREAD_ID, command);
        const composerEditor = await waitForComposerEditor();
        await vi.waitFor(() => expect(composerEditor.textContent ?? "").toContain(command));
        const sendButton = await waitForSendButton();
        expect(sendButton.disabled).toBe(false);
        sendButton.click();
      };

      await runSlashCommand("/debug");
      await vi.waitFor(() => expect(readInteractionMode()).toBe("debug"));
      const debugBadge = page.getByTitle("Debug mode — click to return to normal build mode");
      await expect.element(debugBadge).toBeInTheDocument();
      await debugBadge.click();
      await vi.waitFor(() => expect(readInteractionMode()).toBe("default"));

      await runSlashCommand("/debug");
      await vi.waitFor(() => expect(readInteractionMode()).toBe("debug"));
      await runSlashCommand("/default");
      await vi.waitFor(() => expect(readInteractionMode()).toBe("default"));
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a fresh draft after the previous draft thread is promoted", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-promoted-draft-shortcut-test" as MessageId,
        targetText: "promoted draft shortcut test",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "chat.new",
              shortcut: {
                key: "o",
                metaKey: false,
                ctrlKey: false,
                shiftKey: true,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();
      await waitForNewThreadShortcutLabel();
      await waitForServerConfigToApply();
      await newThreadButton.click();

      const promotedThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a promoted draft thread UUID.",
      );
      const promotedThreadId = promotedThreadPath.slice(1) as ThreadId;

      const { syncServerReadModel } = useStore.getState();
      syncServerReadModel(addThreadToSnapshot(fixture.snapshot, promotedThreadId));
      useComposerDraftStore.getState().clearDraftThread(promotedThreadId);

      const freshThreadPath = await triggerChatNewShortcutUntilPath(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path) && path !== promotedThreadPath,
        "Shortcut should create a fresh draft instead of reusing the promoted thread.",
      );
      expect(freshThreadPath).not.toBe(promotedThreadPath);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps long proposed plans lightweight until the user expands them", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithLongProposedPlan(),
    });

    try {
      await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Expand plan",
          ) as HTMLButtonElement | null,
        "Unable to find Expand plan button.",
      );

      expect(document.body.textContent).not.toContain("deep hidden detail only after expand");
      // Proposed plans stay inline: the plan sidebar does not open before execution starts.
      expect(document.querySelector('[aria-label="Close plan sidebar"]')).toBeNull();

      const expandButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Expand plan",
          ) as HTMLButtonElement | null,
        "Unable to find Expand plan button.",
      );
      expandButton.click();

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("deep hidden detail only after expand");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the final transcript row clear of a tall composer panel stack", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithTallComposerStack(),
    });

    const maxFixedClearancePx = 128;

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("2 files changed");
          expect(document.body.textContent).toContain("1 out of 3 tasks completed");
        },
        { timeout: 8_000, interval: 16 },
      );

      const scrollContainer = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Unable to find message scroll container.",
      );
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();

      const readStackLayout = () => {
        const renderedRows = Array.from(
          document.querySelectorAll<HTMLElement>("[data-timeline-row-kind]"),
        );
        const finalTranscriptRow = renderedRows.reduce<HTMLElement | null>((latest, row) => {
          if (!latest) return row;
          return row.getBoundingClientRect().bottom > latest.getBoundingClientRect().bottom
            ? row
            : latest;
        }, null);
        const taskListCard = document.querySelector<HTMLElement>(
          '[data-testid="active-task-list-card"]',
        );
        const stackedPanels = taskListCard?.parentElement ?? null;

        expect(
          finalTranscriptRow,
          "Unable to find the final rendered transcript row.",
        ).toBeTruthy();
        expect(taskListCard, "Unable to find the active task-list card.").toBeTruthy();
        expect(stackedPanels, "Unable to find the stacked composer-panel wrapper.").toBeTruthy();

        const finalRowRect = finalTranscriptRow!.getBoundingClientRect();
        const taskCardRect = taskListCard!.getBoundingClientRect();
        const stackRect = stackedPanels!.getBoundingClientRect();
        return {
          gapPx: stackRect.top - finalRowRect.bottom,
          stackHeightPx: stackRect.height,
          taskCardHeightPx: taskCardRect.height,
          distanceFromBottomPx: getScrollContainerDistanceFromBottom(scrollContainer),
        };
      };

      const waitForBoundedGap = async (phase: string) => {
        let measured = readStackLayout();
        await vi.waitFor(
          () => {
            measured = readStackLayout();
            expect(
              measured.distanceFromBottomPx,
              `${phase}: transcript must stay at the end`,
            ).toBeLessThanOrEqual(AUTO_SCROLL_BOTTOM_THRESHOLD_PX);
            expect(
              measured.gapPx,
              `${phase}: final row must not be obscured`,
            ).toBeGreaterThanOrEqual(-1);
            expect(
              measured.gapPx,
              `${phase}: gap must stay within fixed clearance`,
            ).toBeLessThanOrEqual(maxFixedClearancePx);
          },
          { timeout: 4_000, interval: 16 },
        );
        return measured;
      };

      const expanded = await waitForBoundedGap("expanded");
      expect(expanded.stackHeightPx).toBeGreaterThan(maxFixedClearancePx);

      const collapseButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>('button[aria-label="Collapse task banner"]'),
        "Unable to find the task-banner collapse button.",
      );
      collapseButton.click();
      await vi.waitFor(() => {
        expect(
          document.querySelector<HTMLButtonElement>('button[aria-label="Expand task banner"]'),
        ).not.toBeNull();
      });
      const collapsed = await waitForBoundedGap("collapsed");
      expect(collapsed.taskCardHeightPx).toBeLessThan(expanded.taskCardHeightPx - 20);
      expect(Math.abs(collapsed.gapPx - expanded.gapPx)).toBeLessThanOrEqual(8);

      const expandButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Expand task banner"]'),
        "Unable to find the task-banner expand button.",
      );
      expandButton.click();
      await vi.waitFor(() => {
        expect(
          document.querySelector<HTMLButtonElement>('button[aria-label="Collapse task banner"]'),
        ).not.toBeNull();
      });
      const reexpanded = await waitForBoundedGap("re-expanded");
      expect(reexpanded.taskCardHeightPx).toBeGreaterThan(collapsed.taskCardHeightPx + 20);
      expect(Math.abs(reexpanded.gapPx - expanded.gapPx)).toBeLessThanOrEqual(8);

      const finalCollapseButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>('button[aria-label="Collapse task banner"]'),
        "Unable to find the task-banner collapse button before the away-from-end check.",
      );
      finalCollapseButton.click();
      const finalExpandButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Expand task banner"]'),
        "Unable to find the task-banner expand button before the away-from-end check.",
      );
      await vi.waitFor(() => {
        expect(readStackLayout().taskCardHeightPx).toBeLessThan(expanded.taskCardHeightPx - 20);
      });

      scrollContainer.scrollTop = 0;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await vi.waitFor(() => {
        expect(getScrollContainerDistanceFromBottom(scrollContainer)).toBeGreaterThan(
          AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
        );
      });
      const scrollTopBeforeExpansion = scrollContainer.scrollTop;

      finalExpandButton.click();
      await vi.waitFor(
        () => {
          const awayFromEnd = readStackLayout();
          expect(awayFromEnd.taskCardHeightPx).toBeGreaterThan(expanded.taskCardHeightPx - 2);
        },
        { timeout: 4_000, interval: 16 },
      );
      await waitForLayout();
      expect(readStackLayout().distanceFromBottomPx).toBeGreaterThan(
        AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
      );
      await waitForLayout();
      expect(readStackLayout().distanceFromBottomPx).toBeGreaterThan(
        AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
      );
      expect(Math.abs(scrollContainer.scrollTop - scrollTopBeforeExpansion)).toBeLessThanOrEqual(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("aligns the inline plan card with the composer input", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithActiveInlinePlan(),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("1 out of 3 tasks completed");
          expect(document.body.textContent).toContain("Inspecting ChatView boundaries");
          expect(document.body.textContent).toContain("Patch the shared checklist receiver");
          expect(document.body.textContent).toContain("1 background agent");
        },
        { timeout: 8_000, interval: 16 },
      );

      const transcriptPane = document.querySelector<HTMLElement>("[data-chat-transcript-pane]");
      const taskListCard = document.querySelector<HTMLElement>(
        '[data-testid="active-task-list-card"]',
      );
      const composerShell = document.querySelector<HTMLElement>(
        'form[data-chat-composer-form="true"] .chat-composer-shell',
      );
      expect(transcriptPane).not.toBeNull();
      expect(taskListCard).not.toBeNull();
      expect(composerShell).not.toBeNull();
      expect(transcriptPane!.getBoundingClientRect().bottom).toBeGreaterThan(
        taskListCard!.getBoundingClientRect().top + 1,
      );
      // Active plan activity shares the composer column width while the input keeps its
      // rounded top corners. The stacked frame must stay aligned at every viewport size.
      const taskRect = taskListCard!.getBoundingClientRect();
      const composerRect = composerShell!.getBoundingClientRect();
      expect(Math.abs(taskRect.width - composerRect.width)).toBeLessThanOrEqual(2);
      expect(
        Math.abs(taskRect.left + taskRect.width / 2 - (composerRect.left + composerRect.width / 2)),
      ).toBeLessThanOrEqual(1);
      expect(parseFloat(getComputedStyle(composerShell!).borderTopLeftRadius)).toBeGreaterThan(0);

      const openPlanButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[title="Open tasks sidebar"]'),
        "Unable to find inline active plan sidebar button.",
      );
      openPlanButton.click();

      await expect.element(page.getByLabelText("Close plan sidebar")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides an unfinished task list once the latest turn is settled", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithSettledInlinePlan(),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("Finished the investigation.");
          expect(document.body.textContent).not.toContain("1 out of 3 tasks completed");
          expect(document.querySelector('[data-testid="active-task-list-card"]')).toBeNull();
          expect(document.body.textContent).not.toContain("1 background agent");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides the stop button once a completed turn is no longer live", async () => {
    const settledSnapshot = createSnapshotWithSettledInlinePlan();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...settledSnapshot,
        threads: settledSnapshot.threads.map((thread) =>
          thread.id === THREAD_ID
            ? {
                ...thread,
                messages: thread.messages.map((message) =>
                  message.role === "assistant"
                    ? {
                        ...message,
                        streaming: true,
                      }
                    : message,
                ),
              }
            : thread,
        ),
      },
    });

    try {
      await vi.waitFor(
        () => {
          expect(
            document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
          ).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("collapses a settled leading tool run mid-turn, then folds into Worked for after the grace delay", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithInlineToolOverflow({ active: true }),
    });

    try {
      // The tools already gave way to the assistant's narration block, so even
      // while the turn is live the run compacts behind its summary row.
      await vi.waitFor(
        () => {
          const summaryTrigger = Array.from(
            document.querySelectorAll<HTMLButtonElement>("button[aria-expanded]"),
          ).find((element) => element.textContent?.includes("Used 6 tools"));
          expect(summaryTrigger).not.toBeUndefined();
          expect(summaryTrigger!.getAttribute("aria-expanded")).toBe("false");
          expect(document.body.textContent).not.toContain("Tool 1");
        },
        { timeout: 8_000, interval: 16 },
      );

      const settledSnapshot = createSnapshotWithInlineToolOverflow({ active: false });
      useStore.getState().syncServerReadModel({
        ...settledSnapshot,
        snapshotSequence: fixture.snapshot.snapshotSequence + 1,
      });

      // The first settled paint keeps the live layout: no "Worked for" fold yet.
      expect(document.querySelector("[data-settled-turn-collapse-transition='true']")).toBeNull();
      expect(document.body.textContent).toContain("Used 6 tools");

      await new Promise<void>((resolve) => {
        window.setTimeout(() => resolve(), 260);
      });

      // Once the grace delay lapses the settled turn folds into "Worked for…",
      // but the old details stay mounted briefly inside the shared disclosure
      // close transition so the transcript height eases down instead of snapping.
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("Worked for");
          const transitionClone = document.querySelector(
            "[data-settled-turn-collapse-transition='true']",
          );
          expect(transitionClone).not.toBeNull();
          expect(transitionClone?.hasAttribute("inert")).toBe(true);
          expect(transitionClone?.querySelector("[aria-hidden='true'][inert]")).not.toBeNull();
          expect(transitionClone?.textContent).toContain("Used 6 tools");
        },
        { timeout: 8_000, interval: 16 },
      );

      await new Promise<void>((resolve) => {
        window.setTimeout(() => resolve(), 320);
      });

      // After the close motion finishes, details are only available by opening
      // the "Worked for…" disclosure.
      await vi.waitFor(
        () => {
          expect(
            document.querySelector("[data-settled-turn-collapse-transition='true']"),
          ).toBeNull();
          expect(document.body.textContent).not.toContain("Tool 1");
          const settledTrigger = Array.from(
            document.querySelectorAll<HTMLButtonElement>("button"),
          ).find((element) => element.textContent?.includes("Worked for"));
          if (settledTrigger) {
            expect(settledTrigger.getAttribute("aria-expanded")).toBe("false");
          }
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  // Opening a thread whose turns finished long ago must present them already
  // folded. Replaying the fold — mounting every tool row and easing it closed —
  // is a pure cost on open: it rebuilds the whole turn's DOM twice and drags the
  // transcript height (and the scroll offset with it) up and down before it
  // settles on exactly the layout the first paint could have had.
  it("opens a finished thread already folded, without replaying the collapse", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithInlineToolOverflow({ active: false }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("Worked for");
        },
        { timeout: 8_000, interval: 16 },
      );

      // Sample across the window the replayed close animation would occupy.
      const startedAt = performance.now();
      let transitionFrames = 0;
      let toolRowFrames = 0;
      while (performance.now() - startedAt < 800) {
        await nextFrame();
        if (document.querySelector("[data-settled-turn-collapse-transition='true']")) {
          transitionFrames += 1;
        }
        if ((document.body.textContent ?? "").includes("tool-1")) {
          toolRowFrames += 1;
        }
      }

      expect({ transitionFrames, toolRowFrames }).toEqual({
        transitionFrames: 0,
        toolRowFrames: 0,
      });
    } finally {
      await mounted.cleanup();
    }
  });

  // Thread detail does not always land in one write: a thread can paint its
  // transcript before the record that says its last turn already completed. Until
  // that record lands the tail turn is treated as live, so every tool row renders
  // expanded. The fold that follows is hydration catching up, not a turn ending
  // under the reader's eyes, so it must not be animated.
  it("does not replay the collapse when the completed turn record hydrates after the transcript", async () => {
    const settledSnapshot = createSnapshotWithInlineToolOverflow({ active: false });
    const messagesOnlySnapshot: OrchestrationReadModel = {
      ...settledSnapshot,
      threads: settledSnapshot.threads.map((thread) =>
        thread.id === THREAD_ID ? { ...thread, latestTurn: null } : thread,
      ),
    };

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: messagesOnlySnapshot,
    });

    try {
      // Baseline: with no turn record the tail turn reads as live, so its work
      // sits inline instead of folded into the turn's "Worked for…" disclosure.
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("Wrapped up the inline tool review.");
          expect(document.body.textContent).toContain("Used 6 tools");
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(document.body.textContent).not.toContain("Worked for");

      useStore.getState().syncServerReadModel({
        ...settledSnapshot,
        snapshotSequence: fixture.snapshot.snapshotSequence + 1,
      });

      const startedAt = performance.now();
      let transitionFrames = 0;
      // Height churn is what the eye reads as "jumping up and down": each frame
      // whose transcript height differs from the previous one is one visible step.
      let heightChangeFrames = 0;
      let previousScrollHeight: number | null = null;
      while (performance.now() - startedAt < 800) {
        await nextFrame();
        if (document.querySelector("[data-settled-turn-collapse-transition='true']")) {
          transitionFrames += 1;
        }
        const container = document.querySelector<HTMLElement>(
          "[data-chat-scroll-container='true']",
        );
        if (!container) {
          continue;
        }
        if (previousScrollHeight !== null && container.scrollHeight !== previousScrollHeight) {
          heightChangeFrames += 1;
        }
        previousScrollHeight = container.scrollHeight;
      }

      // The turn must land folded, in one step, with no animated close replay.
      expect(document.body.textContent).toContain("Worked for");
      expect(transitionFrames).toBe(0);
      // One settle step is the floor: the fold itself changes the height once.
      expect(heightChangeFrames).toBeLessThanOrEqual(2);
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not animate historical tool hydration while a newer turn is working", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithHistoricalToolHydrationDuringLiveTurn({
        hydrateHistoricalActivities: false,
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("Wrapped up the inline tool review.");
          expect(document.body.textContent).toContain("Current turn is still running.");
        },
        { timeout: 8_000, interval: 16 },
      );

      const hydratedSnapshot = createSnapshotWithHistoricalToolHydrationDuringLiveTurn({
        hydrateHistoricalActivities: true,
      });
      useStore.getState().syncServerReadModel({
        ...hydratedSnapshot,
        snapshotSequence: fixture.snapshot.snapshotSequence + 1,
      });

      let transitionFrames = 0;
      const startedAt = performance.now();
      while (performance.now() - startedAt < 800) {
        await nextFrame();
        if (document.querySelector("[data-settled-turn-collapse-transition='true']")) {
          transitionFrames += 1;
        }
      }

      expect(document.body.textContent).toContain("Worked for");
      expect(transitionFrames).toBe(0);
    } finally {
      await mounted.cleanup();
    }
  });
});
