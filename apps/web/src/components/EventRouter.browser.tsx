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
    });
  }),
  http.get("*/attachments/:attachmentId", () => new HttpResponse(null, { status: 204 })),
  http.get("*/api/project-favicon", () => new HttpResponse(null, { status: 204 })),
);

async function mountApp(): Promise<{ cleanup: () => Promise<void> }> {
  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.width = "100vw";
  host.style.height = "100vh";
  host.style.display = "grid";
  host.style.overflow = "hidden";
  document.body.append(host);

  const router = getRouter(createMemoryHistory({ initialEntries: [`/${THREAD_ID}`] }));
  const screen = await render(<RouterProvider router={router} />, { container: host });

  await vi.waitFor(
    () => {
      expect(useStore.getState().threads.some((thread) => thread.id === THREAD_ID)).toBe(true);
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

function sendDomainEventPush(event: OrchestrationEvent) {
  if (!wsClient) {
    throw new Error("WebSocket client not connected");
  }
  wsClient.send(
    JSON.stringify({
      type: "push",
      sequence: pushSequence++,
      channel: ORCHESTRATION_WS_CHANNELS.domainEvent,
      data: event,
    }),
  );
}

describe("EventRouter snapshot catch-up", () => {
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
    wsClient = null;
    pushSequence = 1;
    localStorage.clear();
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });
    useStore.setState({
      projects: [],
      threads: [],
      sidebarThreadSummaryById: {},
      threadsHydrated: false,
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps live turn state while snapshots are behind, then reconciles when they catch up", async () => {
    const mounted = await mountApp();

    try {
      const runningEvent = {
        sequence: 2,
        eventId: EventId.makeUnsafe("event-running"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        occurredAt: "2026-03-04T12:00:05.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.session-set",
        payload: {
          threadId: THREAD_ID,
          session: {
            threadId: THREAD_ID,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: TurnId.makeUnsafe("turn-1"),
            lastError: null,
            updatedAt: "2026-03-04T12:00:05.000Z",
          },
        },
      } satisfies Extract<OrchestrationEvent, { type: "thread.session-set" }>;

      sendDomainEventPush(runningEvent);

      await vi.waitFor(
        () => {
          const thread = useStore.getState().threads.find((entry) => entry.id === THREAD_ID);
          expect(thread?.session?.orchestrationStatus).toBe("running");
          expect(thread?.latestTurn).toMatchObject({
            turnId: TurnId.makeUnsafe("turn-1"),
            state: "running",
          });
        },
        { timeout: 4_000, interval: 16 },
      );

      await new Promise((resolve) => window.setTimeout(resolve, 120));

      const threadDuringLag = useStore.getState().threads.find((entry) => entry.id === THREAD_ID);
      expect(threadDuringLag?.session?.orchestrationStatus).toBe("running");
      expect(threadDuringLag?.latestTurn?.state).toBe("running");

      fixture.snapshot = {
        ...createSnapshot({
          updatedAt: "2026-03-04T12:00:05.000Z",
          latestTurn: {
            turnId: TurnId.makeUnsafe("turn-1"),
            state: "running",
            requestedAt: "2026-03-04T12:00:05.000Z",
            startedAt: "2026-03-04T12:00:05.000Z",
            completedAt: null,
            assistantMessageId: null,
          },
          session: {
            threadId: THREAD_ID,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: TurnId.makeUnsafe("turn-1"),
            lastError: null,
            updatedAt: "2026-03-04T12:00:05.000Z",
          },
        }),
        snapshotSequence: 2,
        updatedAt: "2026-03-04T12:00:05.000Z",
      };

      await vi.waitFor(
        () => {
          const thread = useStore.getState().threads.find((entry) => entry.id === THREAD_ID);
          expect(thread?.updatedAt).toBe("2026-03-04T12:00:05.000Z");
          expect(thread?.session?.orchestrationStatus).toBe("running");
          expect(thread?.latestTurn).toMatchObject({
            turnId: TurnId.makeUnsafe("turn-1"),
            state: "running",
            requestedAt: "2026-03-04T12:00:05.000Z",
          });
        },
        { timeout: 4_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });
});
