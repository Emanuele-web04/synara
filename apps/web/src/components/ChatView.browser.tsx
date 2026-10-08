Warning: truncated output (original token count: 134734)
Total output lines: 14150

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
    "keeps sidebar shortcut hints clear of row content (Activity: $ac…94734 tokens truncated…         {
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
