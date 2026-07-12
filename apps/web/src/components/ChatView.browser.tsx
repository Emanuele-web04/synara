// Production CSS is part of the behavior under test because row height depends on it.
import "../index.css";

import {
  AutomationId,
  type AutomationCreateInput,
  type AutomationDefinition,
  EventId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationReadModel,
  type ProjectId,
  type ServerConfig,
  ThreadId,
  TurnId,
  type WsWelcomePayload,
  WS_METHODS,
  OrchestrationSessionStatus,
} from "@synara/contracts";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { HttpResponse, http, ws } from "msw";
import { setupWorker } from "msw/browser";
import { page } from "vitest/browser";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { type ComposerImageAttachment, useComposerDraftStore } from "../composerDraftStore";
import {
  AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
  getScrollContainerDistanceFromBottom,
} from "../chat-scroll";
import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  type TerminalContextDraft,
  removeInlineTerminalContextPlaceholder,
} from "../lib/terminalContext";
import { isMacPlatform } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { resetHomeChatProjectPrewarmStateForTests } from "../lib/chatProjects";
import { resetStudioProjectPrewarmStateForTests } from "../lib/studioProjects";
import { getRouter } from "../router";
import { useSplitViewStore } from "../splitViewStore";
import { useStore } from "../store";
import {
  createShellSnapshotFromReadModel,
  flattenEffectRpcRequestPayload,
  readEffectRpcClientMessage,
  sendEffectRpcChunk,
  sendEffectRpcExit,
} from "../test/effectRpcWebSocketMock";
import { useTemporaryThreadStore } from "../temporaryThreadStore";
import { useTerminalStateStore } from "../terminalStateStore";
import { resetRetainedThreadDetailSubscriptionsForTests } from "../threadDetailSubscriptionRetention";
import { resetWsNativeApiForTest } from "../wsNativeApi";
import { estimateTimelineMessageHeight } from "./timelineHeight";

const THREAD_ID = "thread-browser-test" as ThreadId;
const OTHER_THREAD_ID = "thread-browser-test-other" as ThreadId;
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
  welcome: WsWelcomePayload;
  gitBranchByCwd: Record<string, string>;
}

let fixture: TestFixture;
const wsRequests: WsRequestEnvelope["body"][] = [];
const wsLink = ws.link(/ws(s)?:\/\/.*/);

interface ViewportSpec {
  name: string;
  width: number;
  height: number;
  textTolerancePx: number;
  attachmentTolerancePx: number;
}

const DEFAULT_VIEWPORT: ViewportSpec = {
  name: "desktop",
  width: 960,
  height: 1_100,
  textTolerancePx: 44,
  attachmentTolerancePx: 56,
};
const TEXT_VIEWPORT_MATRIX = [
  DEFAULT_VIEWPORT,
  { name: "tablet", width: 720, height: 1_024, textTolerancePx: 44, attachmentTolerancePx: 56 },
  { name: "mobile", width: 430, height: 932, textTolerancePx: 56, attachmentTolerancePx: 56 },
  { name: "narrow", width: 320, height: 700, textTolerancePx: 84, attachmentTolerancePx: 56 },
] as const satisfies readonly ViewportSpec[];
const ATTACHMENT_VIEWPORT_MATRIX = [
  DEFAULT_VIEWPORT,
  { name: "mobile", width: 430, height: 932, textTolerancePx: 56, attachmentTolerancePx: 56 },
  { name: "narrow", width: 320, height: 700, textTolerancePx: 84, attachmentTolerancePx: 56 },
] as const satisfies readonly ViewportSpec[];

interface UserRowMeasurement {
  measuredRowHeightPx: number;
  timelineWidthMeasuredPx: number;
  renderedInVirtualizedRegion: boolean;
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
  return {
    cwd: "/repo/project",
    worktreesDir: "/repo/.codex/worktrees",
    keybindingsConfigPath: "/repo/project/.synara-keybindings.json",
    keybindings: [],
    issues: [],
    providers: [
      {
        provider: "codex",
        status: "ready",
        available: true,
        authStatus: "authenticated",
        checkedAt: NOW_ISO,
      },
    ],
    availableEditors: [],
  };
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
    snapshotSequence: 1,
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
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
    updatedAt: NOW_ISO,
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
    gitBranchByCwd: {},
    welcome: {
      cwd: "/repo/project",
      projectName: "Project",
      bootstrapProjectId: PROJECT_ID,
      bootstrapThreadId: THREAD_ID,
    },
  };
}

function getThreadDetailFromFixtureSnapshot(
  threadId: ThreadId,
): OrchestrationReadModel["threads"][number] {
  const thread = fixture.snapshot.threads.find((entry) => entry.id === threadId);
  if (!thread) {
    throw new Error(`Missing thread fixture for ${threadId}`);
  }
  return thread;
}

function findThreadDetailFromFixtureSnapshot(
  threadId: ThreadId,
): OrchestrationReadModel["threads"][number] | null {
  return fixture.snapshot.threads.find((entry) => entry.id === threadId) ?? null;
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
    stopOnError: input.stopOnError ?? true,
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
  if (tag === WS_METHODS.serverGetConfig) {
    return fixture.serverConfig;
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
  if (tag === WS_METHODS.projectsSearchEntries) {
    return {
      entries: [],
      truncated: false,
    };
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
  if (tag === WS_METHODS.shellOpenInEditor || tag === WS_METHODS.terminalWrite) {
    return null;
  }
  return {};
}

function installDeterministicSendNativeApi(): () => void {
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
        createWorktree: async (input: Parameters<typeof wsNativeApi.git.createWorktree>[0]) => {
          const request: WsRequestEnvelope["body"] = {
            _tag: WS_METHODS.gitCreateWorktree,
            ...input,
          };
          wsRequests.push(request);
          return resolveWsRpc(request) as Awaited<
            ReturnType<typeof wsNativeApi.git.createWorktree>
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
      if (
        method === WS_METHODS.subscribeServerProviderStatuses ||
        method === WS_METHODS.subscribeServerSettings ||
        method === WS_METHODS.subscribeTerminalEvents ||
        method === WS_METHODS.subscribeOrchestrationDomainEvents
      ) {
        return;
      }
      sendEffectRpcExit(client, parsed.request.id, resolveWsRpc(requestBody));
    });
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

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

async function waitForLayout(): Promise<void> {
  await nextFrame();
  await nextFrame();
  await nextFrame();
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

async function waitForEnvironmentModeButton(label: string): Promise<HTMLButtonElement> {
  return waitForElement(
    () =>
      Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent?.trim() === label,
      ) ?? null,
    `Unable to find ${label} environment button.`,
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
  const useMetaForMod = isMacPlatform(navigator.platform);
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

function dispatchConfiguredShortcut(
  target: EventTarget,
  input: { key: string; shiftKey?: boolean; altKey?: boolean },
): void {
  const useMetaForMod = isMacPlatform(navigator.platform);
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: input.key,
      shiftKey: input.shiftKey ?? false,
      altKey: input.altKey ?? false,
      metaKey: useMetaForMod,
      ctrlKey: !useMetaForMod,
      bubbles: true,
      cancelable: true,
    }),
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
  const useMetaForMod = isMacPlatform(navigator.platform);
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
  let renderedInVirtualizedRegion = false;
  await vi.waitFor(
    async () => {
      scrollContainer.scrollTop = 0;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await nextFrame();
      const measuredRow = host.querySelector<HTMLElement>(rowSelector);
      expect(measuredRow, "Unable to measure targeted user row height.").toBeTruthy();
      timelineWidthMeasuredPx = measuredRow!.getBoundingClientRect().width;
      measuredRowHeightPx = measuredRow!.getBoundingClientRect().height;
      renderedInVirtualizedRegion = measuredRow!.closest("[data-index]") instanceof HTMLElement;
      expect(timelineWidthMeasuredPx, "Unable to measure timeline width.").toBeGreaterThan(0);
      expect(measuredRowHeightPx, "Unable to measure targeted user row height.").toBeGreaterThan(0);
    },
    {
      timeout: 4_000,
      interval: 16,
    },
  );

  return { measuredRowHeightPx, timelineWidthMeasuredPx, renderedInVirtualizedRegion };
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

async function mountChatView(options: {
  viewport: ViewportSpec;
  snapshot: OrchestrationReadModel;
  configureFixture?: (fixture: TestFixture) => void;
  initialEntry?: string;
}): Promise<MountedChatView> {
  fixture = buildFixture(options.snapshot);
  options.configureFixture?.(fixture);
  await setViewport(options.viewport);
  await waitForProductionStyles();

  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.width = "100vw";
  host.style.height = "100vh";
  host.style.display = "grid";
  host.style.overflow = "hidden";
  document.body.append(host);

  const router = getRouter(
    createMemoryHistory({
      initialEntries: [options.initialEntry ?? `/${THREAD_ID}`],
    }),
  );

  const screen = await render(<RouterProvider router={router} />, {
    container: host,
  });

  await waitForLayout();

  const cleanup = async () => {
    await screen.unmount();
    host.remove();
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

async function measureUserRowAtViewport(options: {
  snapshot: OrchestrationReadModel;
  targetMessageId: MessageId;
  viewport: ViewportSpec;
}): Promise<UserRowMeasurement> {
  const mounted = await mountChatView({
    viewport: options.viewport,
    snapshot: options.snapshot,
  });

  try {
    return await mounted.measureUserRow(options.targetMessageId);
  } finally {
    await mounted.cleanup();
  }
}

describe("ChatView timeline estimator parity (full app)", () => {
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
    await worker.stop();
  });

  beforeEach(async () => {
    resetWsNativeApiForTest();
    resetRetainedThreadDetailSubscriptionsForTests();
    await resetHomeChatProjectPrewarmStateForTests();
    await resetStudioProjectPrewarmStateForTests();
    await setViewport(DEFAULT_VIEWPORT);
    attachmentResponseDelayMs = 0;
    localStorage.clear();
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
      projects: [],
      threads: [],
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
    await resetStudioProjectPrewarmStateForTests();
    resetRetainedThreadDetailSubscriptionsForTests();
    resetWsNativeApiForTest();
    document.body.innerHTML = "";
  });

  it.each(TEXT_VIEWPORT_MATRIX)(
    "keeps long user message estimate close at the $name viewport",
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
        const { measuredRowHeightPx, timelineWidthMeasuredPx, renderedInVirtualizedRegion } =
          await mounted.measureUserRow(targetMessageId);

        expect(renderedInVirtualizedRegion).toBe(true);

        const estimatedHeightPx = estimateTimelineMessageHeight(
          { role: "user", text: userText, attachments: [] },
          { timelineWidthPx: timelineWidthMeasuredPx },
        );

        expect(Math.abs(measuredRowHeightPx - estimatedHeightPx)).toBeLessThanOrEqual(
          viewport.textTolerancePx,
        );
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("tracks wrapping parity while resizing an existing ChatView across the viewport matrix", async () => {
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
      const measurements: Array<
        UserRowMeasurement & { viewport: ViewportSpec; estimatedHeightPx: number }
      > = [];

      for (const viewport of TEXT_VIEWPORT_MATRIX) {
        await mounted.setViewport(viewport);
        const measurement = await mounted.measureUserRow(targetMessageId);
        const estimatedHeightPx = estimateTimelineMessageHeight(
          { role: "user", text: userText, attachments: [] },
          { timelineWidthPx: measurement.timelineWidthMeasuredPx },
        );

        expect(measurement.renderedInVirtualizedRegion).toBe(true);
        expect(Math.abs(measurement.measuredRowHeightPx - estimatedHeightPx)).toBeLessThanOrEqual(
          viewport.textTolerancePx,
        );
        measurements.push({ ...measurement, viewport, estimatedHeightPx });
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
      expect(narrowest.measuredRowHeightPx).toBeGreaterThan(widest.measuredRowHeightPx);
      expect(narrowest.estimatedHeightPx).toBeGreaterThan(widest.estimatedHeightPx);
    } finally {
      await mounted.cleanup();
    }
  });

  it("tracks additional rendered wrapping when ChatView width narrows between desktop and mobile viewports", async () => {
    const userText = "x".repeat(2_400);
    const targetMessageId = "msg-user-target-wrap" as MessageId;
    const snapshot = createSnapshotForTargetUser({
      targetMessageId,
      targetText: userText,
    });
    const desktopMeasurement = await measureUserRowAtViewport({
      viewport: { ...TEXT_VIEWPORT_MATRIX[0], width: 1_400 },
      snapshot,
      targetMessageId,
    });
    const mobileMeasurement = await measureUserRowAtViewport({
      viewport: TEXT_VIEWPORT_MATRIX[2],
      snapshot,
      targetMessageId,
    });

    const estimatedDesktopPx = estimateTimelineMessageHeight(
      { role: "user", text: userText, attachments: [] },
      { timelineWidthPx: desktopMeasurement.timelineWidthMeasuredPx },
    );
    const estimatedMobilePx = estimateTimelineMessageHeight(
      { role: "user", text: userText, attachments: [] },
      { timelineWidthPx: mobileMeasurement.timelineWidthMeasuredPx },
    );

    const measuredDeltaPx =
      mobileMeasurement.measuredRowHeightPx - desktopMeasurement.measuredRowHeightPx;
    const estimatedDeltaPx = estimatedMobilePx - estimatedDesktopPx;
    expect(measuredDeltaPx).toBeGreaterThan(0);
    expect(estimatedDeltaPx).toBeGreaterThan(0);
    const ratio = estimatedDeltaPx / measuredDeltaPx;
    expect(ratio).toBeGreaterThan(0.65);
    expect(ratio).toBeLessThan(1.35);
  });

  it("collapses header actions into overflow before they can overlap the thread title", async () => {
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

  it("renders the active thread title", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-thread-tooltip-target" as MessageId,
        targetText: "thread tooltip target",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(THREAD_TITLE);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the composer visible while a long assistant response forces a viewport relayout", async () => {
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

  it("smoothly re-sticks to the bottom after sending an optimistic user message", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-send-bottom-stick" as MessageId,
        targetText: "bottom stick target",
      }),
    });
    let patchedScrollContainer: HTMLElement | null = null;
    let originalScrollTo: HTMLElement["scrollTo"] | null = null;

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

      const scrollToCalls: ScrollToOptions[] = [];
      patchedScrollContainer = scrollContainer;
      originalScrollTo = scrollContainer.scrollTo;
      scrollContainer.scrollTo = ((options?: ScrollToOptions | number, y?: number) => {
        const normalized: ScrollToOptions =
          typeof options === "object" && options !== null
            ? options
            : {
                ...(typeof options === "number" ? { left: options } : {}),
                ...(typeof y === "number" ? { top: y } : {}),
              };
        scrollToCalls.push(normalized);
        if (typeof normalized.left === "number") {
          scrollContainer.scrollLeft = normalized.left;
        }
        if (typeof normalized.top === "number") {
          scrollContainer.scrollTop = normalized.top;
        }
        scrollContainer.dispatchEvent(new Event("scroll"));
      }) as typeof scrollContainer.scrollTo;

      const prompt = "keep me pinned after send";
      useComposerDraftStore.getState().setPrompt(THREAD_ID, prompt);

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        async () => {
          expect(document.body.textContent).toContain(prompt);
          expect(document.activeElement).toBe(await waitForComposerEditor());
          expect(scrollToCalls.some((call) => call.behavior === "smooth")).toBe(true);
          const layout = await mounted.measureLayout();
          expect(layout.scrollHeightPx).toBeGreaterThan(layout.scrollClientHeightPx);
          expect(layout.distanceFromBottomPx).toBeLessThanOrEqual(AUTO_SCROLL_BOTTOM_THRESHOLD_PX);
        },
        { timeout: 8_000, interval: 16 },
      );
      scrollContainer.scrollTo = originalScrollTo;
    } finally {
      if (patchedScrollContainer && originalScrollTo) {
        patchedScrollContainer.scrollTo = originalScrollTo;
      }
      await mounted.cleanup();
    }
  });

  it("sends unmarked automation questions as normal chat messages", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-automation-question" as MessageId,
        targetText: "automation question target",
      }),
    });

    try {
      const prompt = "how do automations work every day?";
      useComposerDraftStore.getState().setPrompt(THREAD_ID, prompt);
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(
        () => {
          expect(composerEditor.textContent ?? "").toContain(prompt);
        },
        { timeout: 8_000, interval: 16 },
      );

      wsRequests.length = 0;
      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          const turnStartRequest = wsRequests.find((request) => {
            const command = readDispatchedCommand(request);
            return command?.type === "thread.turn.start";
          });
          expect(turnStartRequest).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );

      expect(wsRequests.some((request) => request._tag === WS_METHODS.automationCreate)).toBe(
        false,
      );
    } finally {
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

  it("creates polite composer automation requests as heartbeat runs", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-polite-chat-automation" as MessageId,
        targetText: "polite current chat automation target",
      }),
    });

    try {
      useComposerDraftStore
        .getState()
        .setPrompt(THREAD_ID, "could you say hi every 15 seconds for 3 times");
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(
        () => {
          expect(composerEditor.textContent ?? "").toContain("could you say hi");
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
    "keeps user attachment estimate close at the $name viewport",
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
        const { measuredRowHeightPx, timelineWidthMeasuredPx, renderedInVirtualizedRegion } =
          await mounted.measureUserRow(targetMessageId);

        expect(renderedInVirtualizedRegion).toBe(true);

        const estimatedHeightPx = estimateTimelineMessageHeight(
          {
            role: "user",
            text: userText,
            attachments: [{ id: "attachment-1" }, { id: "attachment-2" }, { id: "attachment-3" }],
          },
          { timelineWidthPx: timelineWidthMeasuredPx },
        );

        expect(Math.abs(measuredRowHeightPx - estimatedHeightPx)).toBeLessThanOrEqual(
          viewport.attachmentTolerancePx,
        );
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

  it("shows branch tools on a fresh top-level thread before any messages", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: addThreadToSnapshot(createDraftOnlySnapshot(), THREAD_ID),
    });

    try {
      await expect.element(page.getByText("What should we do in")).toBeInTheDocument();
      await expect.element(page.getByRole("button", { name: "Local" })).toBeInTheDocument();
      expect(document.body.textContent).toContain("main");
    } finally {
      await mounted.cleanup();
    }
  });

  it("runs project scripts from local draft threads at the project cwd", async () => {
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
      viewport: { ...DEFAULT_VIEWPORT, width: 1_400 },
      snapshot: withProjectScripts(createDraftOnlySnapshot(), [
        {
          id: "lint",
          name: "Lint",
          command: "bun run lint",
          icon: "lint",
          runOnWorktreeCreate: false,
        },
      ]),
    });

    try {
      const runButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.title === "Run Lint",
          ) as HTMLButtonElement | null,
        "Unable to find Run Lint button.",
      );
      runButton.click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) =>
              request._tag === WS_METHODS.terminalOpen && request.cwd === "/repo/project",
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.terminalOpen,
            threadId: THREAD_ID,
            cwd: "/repo/project",
            env: {
              SYNARA_PROJECT_ROOT: "/repo/project",
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
            threadId: THREAD_ID,
            data: "bun run lint\r",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("runs project scripts from worktree draft threads at the worktree cwd", async () => {
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

    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 1_400 },
      snapshot: withProjectScripts(createDraftOnlySnapshot(), [
        {
          id: "test",
          name: "Test",
          command: "bun run test",
          icon: "test",
          runOnWorktreeCreate: false,
        },
      ]),
    });

    try {
      const runButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.title === "Run Test",
          ) as HTMLButtonElement | null,
        "Unable to find Run Test button.",
      );
      runButton.click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) =>
              request._tag === WS_METHODS.terminalOpen &&
              request.cwd === "/repo/worktrees/feature-draft",
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.terminalOpen,
            threadId: THREAD_ID,
            cwd: "/repo/worktrees/feature-draft",
            env: {
              SYNARA_PROJECT_ROOT: "/repo/project",
              SYNARA_WORKTREE_PATH: "/repo/worktrees/feature-draft",
            },
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("toggles plan mode with Shift+Tab only while the composer is focused", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-target-hotkey" as MessageId,
        targetText: "hotkey target",
      }),
    });

    try {
      const readInteractionMode = () =>
        useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.interactionMode ?? "default";
      expect(readInteractionMode()).toBe("default");

      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await waitForLayout();

      expect(readInteractionMode()).toBe("default");

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

      await vi.waitFor(
        () => {
          expect(readInteractionMode()).toBe("plan");
          const planButton = Array.from(
            document.querySelectorAll<HTMLButtonElement>("button"),
          ).find((button) => button.textContent?.trim() === "Plan");
          expect(planButton?.title).toContain("return to normal build mode");
        },
        { timeout: 8_000, interval: 16 },
      );

      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(
        () => {
          expect(readInteractionMode()).toBe("default");
        },
        { timeout: 8_000, interval: 16 },
      );
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

  it("opens the composer model picker surface", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-model-picker-shortcut" as MessageId,
        targetText: "model picker shortcut",
      }),
    });

    try {
      const composerEditor = await waitForComposerEditor();
      await waitForServerConfigToApply();
      composerEditor.focus();
      dispatchComposerPickerShortcut(composerEditor, "m");

      await waitForComposerPickerSurfaceOpen();
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
    });

    try {
      const composerEditor = await waitForComposerEditor();
      await waitForServerConfigToApply();
      composerEditor.focus();
      dispatchComposerPickerShortcut(composerEditor, "e");

      await waitForComposerPickerSurfaceOpen();
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

  it("disables send when the composer only contains an expired terminal pill", async () => {
    const expiredLabel = "Terminal 1 line 4";
    useComposerDraftStore.getState().addTerminalContext(
      THREAD_ID,
      createTerminalContext({
        id: "ctx-expired-only",
        terminalLabel: "Terminal 1",
        lineStart: 4,
        lineEnd: 4,
        text: "",
      }),
    );

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-expired-pill-disabled" as MessageId,
        targetText: "expired pill disabled target",
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
      expect(sendButton.disabled).toBe(true);
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

  it("shows a pointer cursor for the running stop button", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-stop-button-cursor" as MessageId,
        targetText: "stop button cursor target",
        sessionStatus: "running",
      }),
    });

    try {
      const stopButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
        "Unable to find stop generation button.",
      );

      expect(getComputedStyle(stopButton).cursor).toBe("pointer");
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows a queued follow-up row while a turn is running", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_ID, "queue this follow-up");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-running-queue-button" as MessageId,
        targetText: "running queue button target",
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
          expect(document.body.textContent).toContain("queue this follow-up");
          expect(document.body.textContent).toContain("Steer");
        },
        { timeout: 8_000, interval: 16 },
      );

      const queuedRow = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="queued-follow-up-row"]'),
        "Unable to find queued follow-up row.",
      );
      expect(queuedRow).not.toBeNull();

      const stopButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
        "Unable to find stop generation button.",
      );
      expect(stopButton).not.toBeNull();
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
        terminalContexts: [],
        fileComments: [],
        pastedTexts: [],
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
        terminalContexts: [],
        fileComments: [],
        pastedTexts: [],
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
      actionButtons[0]?.click();

      const editMenuItem = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="menu-item"]')).find(
            (item) => item.textContent?.trim() === "Edit queued prompt",
          ) ?? null,
        "Unable to find edit queued prompt menu item.",
      );
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
        terminalContexts: [],
        fileComments: [],
        pastedTexts: [],
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
    }
  });

  it("auto-dispatches a queued chat turn as a chat message even while a plan follow-up is pending", async () => {
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
        terminalContexts: [],
        fileComments: [],
        pastedTexts: [],
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
    }
  });

  it("keeps the new thread selected after clicking the new-thread button", async () => {
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

      // The empty thread view and composer should still be visible.
      await expect.element(page.getByTestId("composer-editor")).toBeInTheDocument();
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
      await projectPickerTrigger.click();

      await expect.element(page.getByText("New project")).toBeInTheDocument();
      await expect.element(page.getByText("Don't work in a project")).toBeInTheDocument();
      await expect.element(page.getByText(/Folders on this/)).not.toBeInTheDocument();

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

  it("coalesces repeated Studio new-chat clicks and stays in Studio after navigation settles", async () => {
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
      // Keep one non-Studio server thread in the snapshot. This matches the real failure: Studio
      // has no persisted chats, while the global missing-thread recovery sees known threads and
      // immediately redirects a transiently-cleared Studio draft to the home index.
      snapshot: withStudioProject(
        withHomeChatProject(
          createSnapshotForTargetUser({
            targetMessageId: "msg-user-studio-draft-regression" as MessageId,
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
      },
    });

    try {
      const newStudioChatButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="New studio chat"]'),
        "Unable to find the Studio new-chat action.",
      );
      newStudioChatButton.click();
      newStudioChatButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "A fresh Studio chat should navigate to a new draft UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
            projectId: STUDIO_PROJECT_ID,
            entryPoint: "chat",
          });
          expect(
            useComposerDraftStore.getState().projectDraftThreadIdByProjectId[HOME_PROJECT_ID],
          ).toBeUndefined();
          expect(mounted.router.state.location.pathname).toBe(newThreadPath);
        },
        { timeout: 8_000, interval: 16 },
      );

      // A superseded navigation resolves the older navigate() promise before the newer route has
      // committed. Give route effects enough time to expose a late Home redirect, then assert the
      // stable final state and cleanup of the displaced Studio draft.
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

      const projectPickerTrigger = page.getByTestId("project-picker-trigger");
      await expect.element(projectPickerTrigger).toBeInTheDocument();
      await projectPickerTrigger.click();
      await page.getByText("Don't work in a project").click();

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
        'form[data-chat-composer-form="true"] + .chat-composer-shell',
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
      await expect.element(page.getByRole("button", { name: "Local" })).toBeInTheDocument();
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      const controlsAfter = document.querySelector<HTMLElement>(
        'form[data-chat-composer-form="true"] + .chat-composer-shell',
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

  it("snapshots sticky codex settings into a new draft thread", async () => {
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
        targetMessageId: "msg-user-sticky-codex-traits-test" as MessageId,
        targetText: "sticky codex traits test",
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

      expect(useComposerDraftStore.getState().draftsByThreadId[newThreadId]).toMatchObject({
        modelSelectionByProvider: {
          codex: {
            provider: "codex",
            model: "gpt-5.3-codex",
            options: {
              fastMode: true,
            },
          },
        },
        activeProvider: "codex",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("offers New worktree from an empty draft thread", async () => {
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
      const envPickerTrigger = await waitForEnvironmentModeButton("Local");
      envPickerTrigger.click();

      const newWorktreeOption = page.getByText("New worktree");
      await expect.element(newWorktreeOption).toBeInTheDocument();
      await newWorktreeOption.click();

      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftThread(newThreadId)?.envMode).toBe(
            "worktree",
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a temporary branch-backed worktree on first send in New worktree mode", async () => {
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
      const envPickerTrigger = await waitForEnvironmentModeButton("Local");
      envPickerTrigger.click();

      const newWorktreeOption = page.getByText("New worktree");
      await expect.element(newWorktreeOption).toBeInTheDocument();
      await newWorktreeOption.click();

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
              request._tag === WS_METHODS.gitCreateWorktree &&
              request.cwd === "/repo/project" &&
              request.branch === "main" &&
              typeof request.newBranch === "string",
          );
          expect(createWorktreeRequest).toBeTruthy();
          expect(createWorktreeRequest?.newBranch).toMatch(/^synara\/[0-9a-f]{8}$/);

          const detachedRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.gitCreateDetachedWorktree,
          );
          expect(detachedRequest).toBeUndefined();

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
            branch: createWorktreeRequest?.newBranch,
            worktreePath: `/repo/.codex/worktrees/project/${String(createWorktreeRequest?.newBranch).replaceAll("/", "-")}`,
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
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
      const envPickerTrigger = await waitForEnvironmentModeButton("Local");
      envPickerTrigger.click();

      const newWorktreeOption = page.getByText("New worktree");
      await expect.element(newWorktreeOption).toBeInTheDocument();
      await newWorktreeOption.click();

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
              candidate._tag === WS_METHODS.gitCreateWorktree &&
              candidate.cwd === "/repo/project" &&
              candidate.branch === "main" &&
              typeof candidate.newBranch === "string",
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
          if (!request || request._tag !== WS_METHODS.gitCreateWorktree) {
            throw new Error("Expected create worktree request.");
          }
          return request;
        },
        { timeout: 10_000, interval: 16 },
      );
      const createWorktreeIndex = wsRequests.indexOf(createWorktreeRequest);
      const worktreePath = `/repo/.codex/worktrees/project/${String(
        createWorktreeRequest.newBranch,
      ).replaceAll("/", "-")}`;

      const terminalOpenRequest = await vi.waitFor(
        () => {
          const request = wsRequests.find(
            (candidate) =>
              candidate._tag === WS_METHODS.terminalOpen &&
              candidate.threadId === newThreadId &&
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
              candidate.threadId === newThreadId &&
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

  it("hydrates the provider alongside a sticky claude model", async () => {
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
    });

    try {
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

  it("falls back to defaults when no sticky composer settings exist", async () => {
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
      await waitForNewThreadShortcutLabel();
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      await waitForLayout();
      await triggerChatNewShortcutUntilPath(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID from the shortcut.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("promotes terminal-first shortcut threads so they render as terminal rows", async () => {
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
    }
  });

  it("promotes a stored terminal draft using its saved context and model selection", async () => {
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
          terminalContexts: [],
          fileComments: [],
          pastedTexts: [],
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
    }
  });

  it("enables plan mode from the composer extras menu", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-plan-mode-toggle-test" as MessageId,
        targetText: "plan mode toggle test",
      }),
    });

    try {
      await page.getByLabelText("Composer extras").click();
      await page.getByText("Plan mode").click();

      await vi.waitFor(() => {
        expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.interactionMode).toBe(
          "plan",
        );
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("distinguishes plan mode from the plan details sidebar button", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithSettledPlanAwaitingFollowUp(),
    });

    try {
      await waitForServerConfigToApply();
      const footer = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]'),
        "Unable to find composer footer.",
      );

      await vi.waitFor(() => {
        const buttonLabels = Array.from(footer.querySelectorAll("button"))
          .map((button) => button.textContent?.trim() ?? "")
          .filter(Boolean);

        expect(buttonLabels.filter((label) => label === "Plan")).toHaveLength(1);
        expect(buttonLabels).toContain("Plan details");
        expect(document.querySelector('button[title="Show plan sidebar"]')).toBeNull();
      });
      await expect
        .element(page.getByTitle("Plan mode — click to return to normal build mode"))
        .toBeInTheDocument();
      await expect.element(page.getByLabelText("Show plan details sidebar")).toBeInTheDocument();
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

  it("keeps proposed plans inline until execution starts", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithLongProposedPlan(),
    });

    try {
      await expect.element(page.getByText("Expand plan")).toBeInTheDocument();
      expect(document.querySelector('[aria-label="Close plan sidebar"]')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the skinny inline plan card for active turn plans", async () => {
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
      // Active plan activity shares the centered queued-follow-up rail, intentionally inset to
      // eleven twelfths of the composer width while the input keeps its rounded top corners.
      const taskRect = taskListCard!.getBoundingClientRect();
      const composerRect = composerShell!.getBoundingClientRect();
      expect(Math.abs(taskRect.width - (composerRect.width * 11) / 12)).toBeLessThanOrEqual(2);
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

  it("hides the inline plan card once the latest turn is settled", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithSettledInlinePlan(),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("Finished the investigation.");
          expect(document.body.textContent).not.toContain("1 out of 3 tasks completed");
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

  it("keeps the live inline-tool layout through the first settled paint, then relaxes after the grace delay", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithInlineToolOverflow({ active: true }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("Tool 6");
          expect(document.body.textContent).not.toContain("Tool 1");
        },
        { timeout: 8_000, interval: 16 },
      );

      useStore
        .getState()
        .syncServerReadModel(createSnapshotWithInlineToolOverflow({ active: false }));

      expect(document.body.textContent).toContain("Tool 6");
      expect(document.body.textContent).not.toContain("Tool 1");

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
          expect(document.body.textContent).toContain("Tool 6");
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
          expect(document.body.textContent).not.toContain("Tool 6");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });
});
