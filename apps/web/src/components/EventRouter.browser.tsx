import "../index.css";

import {
  EventId,
  MessageId,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationShellStreamEvent,
  type OrchestrationShellSnapshot,
  type OrchestrationThread,
  type ServerConfig,
  type WsWelcomePayload,
  WS_CHANNELS,
  WS_METHODS,
} from "@t3tools/contracts";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { HttpResponse, http, ws } from "msw";
import { setupWorker } from "msw/browser";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useComposerDraftStore } from "../composerDraftStore";
import { getRouter } from "../router";
import { useStore } from "../store";
import { getThreadFromState } from "../threadDerivation";

const THREAD_ID = ThreadId.makeUnsafe("thread-root-browser-test");
const PROJECT_ID = ProjectId.makeUnsafe("project-root-browser-test");
const NOW_ISO = "2026-03-04T12:00:00.000Z";

interface TestFixture {
  snapshot: OrchestrationReadModel;
  serverConfig: ServerConfig;
  welcome: WsWelcomePayload;
}

let fixture: TestFixture;
let wsClient: { send: (data: string) => void } | null = null;
let pushSequence = 1;
let delayNextThreadSnapshot = false;

const wsLink = ws.link(/ws(s)?:\/\/.*/);

function createBaseServerConfig(): ServerConfig {
  return {
    cwd: "/repo/project",
    worktreesDir: "/repo/.codex/worktrees",
    keybindingsConfigPath: "/repo/project/.t3code-keybindings.json",
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

function createSnapshot(overrides?: Partial<OrchestrationReadModel["threads"][number]>) {
  return {
    snapshotSequence: 1,
    projects: [
      {
        id: PROJECT_ID,
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
        title: "Root test thread",
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
        messages: [
          {
            id: MessageId.makeUnsafe("msg-user-1"),
            role: "user",
            text: "hello",
            turnId: null,
            streaming: false,
            source: "native",
            createdAt: NOW_ISO,
            updatedAt: NOW_ISO,
          },
        ],
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: {
          threadId: THREAD_ID,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
        ...overrides,
      },
    ],
    updatedAt: NOW_ISO,
  } satisfies OrchestrationReadModel;
}

function buildFixture(): TestFixture {
  return {
    snapshot: createSnapshot(),
    serverConfig: createBaseServerConfig(),
    welcome: {
      cwd: "/repo/project",
      projectName: "Project",
      bootstrapProjectId: PROJECT_ID,
      bootstrapThreadId: THREAD_ID,
    },
  };
}

function createShellSnapshotFromFixtureSnapshot(
  snapshot: OrchestrationReadModel,
): OrchestrationShellSnapshot {
  return {
    snapshotSequence: snapshot.snapshotSequence,
    projects: snapshot.projects
      .filter((project) => project.deletedAt === null)
      .map((project) => ({
        id: project.id,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
        defaultModelSelection: project.defaultModelSelection,
        scripts: project.scripts,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      })),
    threads: snapshot.threads
      .filter((thread) => thread.deletedAt === null)
      .map((thread) => ({
        id: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        modelSelection: thread.modelSelection,
        interactionMode: thread.interactionMode,
        runtimeMode: thread.runtimeMode,
        envMode: thread.envMode,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        associatedWorktreePath: thread.associatedWorktreePath ?? null,
        associatedWorktreeBranch: thread.associatedWorktreeBranch ?? null,
        associatedWorktreeRef: thread.associatedWorktreeRef ?? null,
        parentThreadId: thread.parentThreadId ?? null,
        subagentAgentId: thread.subagentAgentId ?? null,
        subagentNickname: thread.subagentNickname ?? null,
        subagentRole: thread.subagentRole ?? null,
        forkSourceThreadId: thread.forkSourceThreadId ?? null,
        latestTurn: thread.latestTurn,
        latestUserMessageAt: thread.latestUserMessageAt ?? null,
        hasPendingApprovals: thread.hasPendingApprovals ?? false,
        hasPendingUserInput: thread.hasPendingUserInput ?? false,
        hasActionableProposedPlan: thread.hasActionableProposedPlan ?? false,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        archivedAt: thread.archivedAt ?? null,
        handoff: thread.handoff ?? null,
        session: thread.session,
      })),
    updatedAt: snapshot.updatedAt,
  };
}

function getThreadDetailFromFixtureSnapshot(threadId: ThreadId): OrchestrationThread {
  const thread = fixture.snapshot.threads.find((entry) => entry.id === threadId);
  if (!thread) {
    throw new Error(`Missing thread fixture for ${threadId}`);
  }
  return thread;
}

function resolveWsRpc(tag: string): unknown {
  if (tag === ORCHESTRATION_WS_METHODS.getSnapshot) {
    return fixture.snapshot;
  }
  if (tag === WS_METHODS.serverGetConfig) {
    return fixture.serverConfig;
  }
  if (tag === WS_METHODS.gitListBranches) {
    return {
      isRepo: true,
      hasOriginRemote: true,
      branches: [{ name: "main", current: true, isDefault: true, worktreePath: null }],
    };
  }
  if (tag === WS_METHODS.gitStatus) {
    return {
      branch: "main",
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: true,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    };
  }
  if (tag === WS_METHODS.projectsSearchEntries) {
    return { entries: [], truncated: false };
  }
  return {};
}

const worker = setupWorker(
  wsLink.addEventListener("connection", ({ client }) => {
    wsClient = client;
    pushSequence = 1;
    client.send(
      JSON.stringify({
        type: "push",
        sequence: pushSequence++,
        channel: WS_CHANNELS.serverWelcome,
        data: fixture.welcome,
      }),
    );
    client.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        return;
      }
      let request: { id: string; body: { _tag: string } };
      try {
        request = JSON.parse(event.data);
      } catch {
        return;
      }
      const method = request.body?._tag;
      if (typeof method !== "string") {
        return;
      }
      client.send(
        JSON.stringify({
          id: request.id,
          result: resolveWsRpc(method),
        }),
      );
      if (method === ORCHESTRATION_WS_METHODS.subscribeShell) {
        client.send(
          JSON.stringify({
            type: "push",
            sequence: pushSequence++,
            channel: ORCHESTRATION_WS_CHANNELS.shellEvent,
            data: {
              kind: "snapshot",
              snapshot: createShellSnapshotFromFixtureSnapshot(fixture.snapshot),
            },
          }),
        );
      }
      if (method === ORCHESTRATION_WS_METHODS.subscribeThread && "threadId" in request.body) {
        const threadId = request.body.threadId as ThreadId;
        if (delayNextThreadSnapshot) {
          delayNextThreadSnapshot = false;
          return;
        }
        client.send(
          JSON.stringify({
            type: "push",
            sequence: pushSequence++,
            channel: ORCHESTRATION_WS_CHANNELS.threadEvent,
            data: {
              kind: "snapshot",
              snapshot: {
                snapshotSequence: fixture.snapshot.snapshotSequence,
                thread: getThreadDetailFromFixtureSnapshot(threadId),
              },
            },
          }),
        );
      }
    });
  }),
  http.get("*/attachments/:attachmentId", () => new HttpResponse(null, { status: 204 })),
  http.get("*/api/project-favicon", () => new HttpResponse(null, { status: 204 })),
);

async function mountApp(options?: {
  routeThreadId?: ThreadId;
  waitForThreadId?: ThreadId | null;
}): Promise<{ cleanup: () => Promise<void> }> {
  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.width = "100vw";
  host.style.height = "100vh";
  host.style.display = "grid";
  host.style.overflow = "hidden";
  document.body.append(host);

  const routeThreadId = options?.routeThreadId ?? THREAD_ID;
  const router = getRouter(createMemoryHistory({ initialEntries: [`/${routeThreadId}`] }));
  const screen = await render(<RouterProvider router={router} />, { container: host });

  await vi.waitFor(
    () => {
      if (options?.waitForThreadId === null) {
        expect(useStore.getState().threadsHydrated).toBe(true);
        return;
      }
      const expectedThreadId = options?.waitForThreadId ?? THREAD_ID;
      expect(useStore.getState().threads.some((thread) => thread.id === expectedThreadId)).toBe(
        true,
      );
    },
    { timeout: 8_000, interval: 16 },
  );

  return {
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

function sendThreadEventPush(event: OrchestrationEvent) {
  if (!wsClient) {
    throw new Error("WebSocket client not connected");
  }
  wsClient.send(
    JSON.stringify({
      type: "push",
      sequence: pushSequence++,
      channel: ORCHESTRATION_WS_CHANNELS.threadEvent,
      data: {
        kind: "event",
        event,
      },
    }),
  );
}

function sendThreadSnapshotPush(threadId: ThreadId, snapshotSequence: number) {
  if (!wsClient) {
    throw new Error("WebSocket client not connected");
  }
  wsClient.send(
    JSON.stringify({
      type: "push",
      sequence: pushSequence++,
      channel: ORCHESTRATION_WS_CHANNELS.threadEvent,
      data: {
        kind: "snapshot",
        snapshot: {
          snapshotSequence,
          thread: getThreadDetailFromFixtureSnapshot(threadId),
        },
      },
    }),
  );
}

function sendShellEventPush(event: OrchestrationShellStreamEvent) {
  if (!wsClient) {
    throw new Error("WebSocket client not connected");
  }
  wsClient.send(
    JSON.stringify({
      type: "push",
      sequence: pushSequence++,
      channel: ORCHESTRATION_WS_CHANNELS.shellEvent,
      data: event,
    }),
  );
}

describe("EventRouter scoped orchestration sync", () => {
  beforeAll(async () => {
    fixture = buildFixture();
    await worker.start({
      onUnhandledRequest: "bypass",
      quiet: true,
      serviceWorker: { url: "/mockServiceWorker.js" },
    });
  });

  afterAll(async () => {
    await worker.stop();
  });

  beforeEach(() => {
    fixture = buildFixture();
    document.body.innerHTML = "";
    pushSequence = 1;
    delayNextThreadSnapshot = false;
    localStorage.clear();
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });
    useStore.setState({
      projects: [],
      threads: [],
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
      sidebarThreadSummaryById: {},
      threadsHydrated: false,
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("drops duplicate thread events after the thread snapshot sequence advances", async () => {
    const mounted = await mountApp();

    try {
      const firstAssistantChunk = {
        sequence: 2,
        eventId: EventId.makeUnsafe("event-message-2"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        occurredAt: "2026-03-04T12:00:05.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.message-sent",
        payload: {
          threadId: THREAD_ID,
          messageId: MessageId.makeUnsafe("msg-assistant-1"),
          role: "assistant",
          text: "hello",
          turnId: TurnId.makeUnsafe("turn-1"),
          source: "native",
          streaming: true,
          createdAt: "2026-03-04T12:00:05.000Z",
          updatedAt: "2026-03-04T12:00:05.000Z",
        },
      } satisfies Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

      sendThreadEventPush(firstAssistantChunk);

      await vi.waitFor(
        () => {
          const thread = getThreadFromState(useStore.getState(), THREAD_ID);
          const message = thread?.messages.find(
            (entry) => entry.id === MessageId.makeUnsafe("msg-assistant-1"),
          );
          expect(message?.text).toBe("hello");
        },
        { timeout: 4_000, interval: 16 },
      );

      sendThreadEventPush(firstAssistantChunk);

      await new Promise((resolve) => window.setTimeout(resolve, 120));

      const threadAfterDuplicate = useStore.getState();
      expect(
        getThreadFromState(threadAfterDuplicate, THREAD_ID)?.messages.filter(
          (entry) => entry.id === MessageId.makeUnsafe("msg-assistant-1"),
        ),
      ).toHaveLength(1);

      const secondAssistantChunk = {
        ...firstAssistantChunk,
        sequence: 3,
        eventId: EventId.makeUnsafe("event-message-3"),
        occurredAt: "2026-03-04T12:00:06.000Z",
        payload: {
          ...firstAssistantChunk.payload,
          text: "hello world",
          streaming: false,
          updatedAt: "2026-03-04T12:00:06.000Z",
        },
      } satisfies Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

      sendThreadEventPush(secondAssistantChunk);

      await vi.waitFor(
        () => {
          const thread = getThreadFromState(useStore.getState(), THREAD_ID);
          const message = thread?.messages.find(
            (entry) => entry.id === MessageId.makeUnsafe("msg-assistant-1"),
          );
          expect(message?.text).toBe("hello world");
          expect(message?.streaming).toBe(false);
        },
        { timeout: 4_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("flushes only the first assistant chunk immediately for a message", async () => {
    const mounted = await mountApp();

    try {
      const firstAssistantChunk = {
        sequence: 2,
        eventId: EventId.makeUnsafe("event-message-immediate-1"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        occurredAt: "2026-03-04T12:00:05.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.message-sent",
        payload: {
          threadId: THREAD_ID,
          messageId: MessageId.makeUnsafe("msg-assistant-immediate"),
          role: "assistant",
          text: "I’ll start",
          turnId: TurnId.makeUnsafe("turn-immediate"),
          source: "native",
          streaming: true,
          createdAt: "2026-03-04T12:00:05.000Z",
          updatedAt: "2026-03-04T12:00:05.000Z",
        },
      } satisfies Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

      sendThreadEventPush(firstAssistantChunk);

      await vi.waitFor(
        () => {
          const thread = getThreadFromState(useStore.getState(), THREAD_ID);
          const message = thread?.messages.find(
            (entry) => entry.id === MessageId.makeUnsafe("msg-assistant-immediate"),
          );
          expect(message?.text).toBe("I’ll start");
          expect(message?.streaming).toBe(true);
        },
        { timeout: 4_000, interval: 16 },
      );

      const secondAssistantChunk = {
        ...firstAssistantChunk,
        sequence: 3,
        eventId: EventId.makeUnsafe("event-message-immediate-2"),
        occurredAt: "2026-03-04T12:00:05.050Z",
        payload: {
          ...firstAssistantChunk.payload,
          text: " by scanning the repository.",
          updatedAt: "2026-03-04T12:00:05.050Z",
        },
      } satisfies Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

      sendThreadEventPush(secondAssistantChunk);

      await new Promise((resolve) => window.setTimeout(resolve, 20));

      const threadBeforeThrottleFlush = getThreadFromState(useStore.getState(), THREAD_ID);
      const messageBeforeThrottleFlush = threadBeforeThrottleFlush?.messages.find(
        (entry) => entry.id === MessageId.makeUnsafe("msg-assistant-immediate"),
      );
      expect(messageBeforeThrottleFlush?.text).toBe("I’ll start");

      await vi.waitFor(
        () => {
          const thread = getThreadFromState(useStore.getState(), THREAD_ID);
          const message = thread?.messages.find(
            (entry) => entry.id === MessageId.makeUnsafe("msg-assistant-immediate"),
          );
          expect(message?.text).toBe("I’ll start by scanning the repository.");
        },
        { timeout: 4_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("recovers buffered thread events by re-requesting the missing thread snapshot", async () => {
    delayNextThreadSnapshot = true;
    const mounted = await mountApp();

    try {
      const bufferedEvent = {
        sequence: 2,
        eventId: EventId.makeUnsafe("event-buffered-message"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        occurredAt: "2026-03-04T12:00:07.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.message-sent",
        payload: {
          threadId: THREAD_ID,
          messageId: MessageId.makeUnsafe("msg-buffered-assistant"),
          role: "assistant",
          text: "buffered reply",
          turnId: TurnId.makeUnsafe("turn-2"),
          source: "native",
          streaming: false,
          createdAt: "2026-03-04T12:00:07.000Z",
          updatedAt: "2026-03-04T12:00:07.000Z",
        },
      } satisfies Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

      sendThreadEventPush(bufferedEvent);

      let thread;
      await vi.waitFor(
        () => {
          thread = getThreadFromState(useStore.getState(), THREAD_ID);
          const message = thread?.messages.find(
            (entry) => entry.id === MessageId.makeUnsafe("msg-buffered-assistant"),
          );
          expect(message?.text).toBe("buffered reply");
        },
        { timeout: 4_000, interval: 16 },
      );

      sendThreadEventPush(bufferedEvent);

      await new Promise((resolve) => window.setTimeout(resolve, 120));

      thread = getThreadFromState(useStore.getState(), THREAD_ID);
      expect(
        thread?.messages.filter(
          (entry) => entry.id === MessageId.makeUnsafe("msg-buffered-assistant"),
        ),
      ).toHaveLength(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("requests a thread snapshot again when a subscribed draft thread becomes real", async () => {
    const draftThreadId = ThreadId.makeUnsafe("thread-draft-promoted");
    delayNextThreadSnapshot = true;
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {
        [draftThreadId]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          entryPoint: "chat",
          branch: null,
          worktreePath: null,
          envMode: "local",
          isTemporary: false,
        },
      },
      projectDraftThreadIdByProjectId: {
        [PROJECT_ID]: draftThreadId,
      },
    });

    const mounted = await mountApp({
      routeThreadId: draftThreadId,
      waitForThreadId: null,
    });

    try {
      const baseThread = fixture.snapshot.threads[0]!;
      fixture.snapshot = {
        ...fixture.snapshot,
        snapshotSequence: 2,
        threads: [
          ...fixture.snapshot.threads,
          {
            ...baseThread,
            id: draftThreadId,
            title: "Promoted thread",
            messages: [],
            activities: [],
            proposedPlans: [],
            checkpoints: [],
            latestTurn: null,
            updatedAt: "2026-03-04T12:00:08.000Z",
          } satisfies OrchestrationReadModel["threads"][number],
        ],
      };

      sendShellEventPush({
        kind: "thread-upserted",
        sequence: 2,
        thread: createShellSnapshotFromFixtureSnapshot(fixture.snapshot).threads.find(
          (thread) => thread.id === draftThreadId,
        )!,
      });

      await vi.waitFor(
        () => {
          expect(useStore.getState().threads.some((thread) => thread.id === draftThreadId)).toBe(
            true,
          );
        },
        { timeout: 4_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps a live assistant intro when a lagging thread snapshot arrives right after it", async () => {
    const mounted = await mountApp();

    try {
      const introEvent = {
        sequence: 2,
        eventId: EventId.makeUnsafe("event-assistant-intro"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        occurredAt: "2026-03-04T12:00:07.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.message-sent",
        payload: {
          threadId: THREAD_ID,
          messageId: MessageId.makeUnsafe("msg-assistant-intro"),
          role: "assistant",
          text: "I'll start by scanning the repository.",
          turnId: TurnId.makeUnsafe("turn-intro"),
          source: "native",
          streaming: true,
          createdAt: "2026-03-04T12:00:07.000Z",
          updatedAt: "2026-03-04T12:00:07.000Z",
        },
      } satisfies Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

      sendThreadEventPush(introEvent);

      await vi.waitFor(
        () => {
          const thread = getThreadFromState(useStore.getState(), THREAD_ID);
          const message = thread?.messages.find(
            (entry) => entry.id === MessageId.makeUnsafe("msg-assistant-intro"),
          );
          expect(message?.text).toBe("I'll start by scanning the repository.");
        },
        { timeout: 4_000, interval: 16 },
      );

      const previousFixture = fixture;
      fixture = {
        ...fixture,
        snapshot: createSnapshot({
          latestTurn: {
            turnId: TurnId.makeUnsafe("turn-intro"),
            state: "running",
            requestedAt: "2026-03-04T12:00:07.000Z",
            startedAt: "2026-03-04T12:00:07.000Z",
            completedAt: null,
            assistantMessageId: null,
          },
          updatedAt: "2026-03-04T12:00:07.500Z",
        }),
      };

      sendThreadSnapshotPush(THREAD_ID, 3);

      await vi.waitFor(
        () => {
          const thread = getThreadFromState(useStore.getState(), THREAD_ID);
          const message = thread?.messages.find(
            (entry) => entry.id === MessageId.makeUnsafe("msg-assistant-intro"),
          );
          expect(message?.text).toBe("I'll start by scanning the repository.");
          expect(thread?.latestTurn?.assistantMessageId).toBe(
            MessageId.makeUnsafe("msg-assistant-intro"),
          );
        },
        { timeout: 4_000, interval: 16 },
      );

      fixture = previousFixture;
    } finally {
      fixture = buildFixture();
      await mounted.cleanup();
    }
  });
});
