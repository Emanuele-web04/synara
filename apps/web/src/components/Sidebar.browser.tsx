import "../index.css";

import {
  ORCHESTRATION_WS_METHODS,
  type MessageId,
  type OrchestrationReadModel,
  type ProjectId,
  type ServerConfig,
  type ThreadId,
  type WsWelcomePayload,
  WS_METHODS,
} from "@t3tools/contracts";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { ws, http, HttpResponse } from "msw";
import { setupWorker } from "msw/browser";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";

import { useComposerDraftStore } from "../composerDraftStore";
import { getRouter } from "../router";
import { createShellSnapshotFromFixtureSnapshot } from "../test/fixtureToShell";
import {
  installRpcBridge,
  suppressKnownEffectRpcBrowserHarnessRejections,
} from "../test/wsRpcMockBridge";
import { __resetWsNativeApiForTests } from "../wsNativeApi";
import { useStore } from "../store";

const PROJECT_ID = "project-sidebar-test" as ProjectId;
const THREAD_PLAIN = "thread-plain" as ThreadId;
const THREAD_PARENT = "thread-parent" as ThreadId;
const THREAD_CHILD = "thread-child" as ThreadId;
const THREAD_PENDING = "thread-pending" as ThreadId;
const NOW_ISO = "2026-03-04T12:00:00.000Z";

interface TestFixture {
  snapshot: OrchestrationReadModel;
  serverConfig: ServerConfig;
  welcome: WsWelcomePayload;
}

let fixture: TestFixture;

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

function baseThread(
  id: ThreadId,
  title: string,
  overrides: Partial<OrchestrationReadModel["threads"][number]> = {},
): OrchestrationReadModel["threads"][number] {
  return {
    id,
    projectId: PROJECT_ID,
    title,
    modelSelection: { provider: "codex", model: "gpt-5" },
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
        id: `${id}-msg-1` as MessageId,
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
      threadId: id,
      status: "ready",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: NOW_ISO,
    },
    ...overrides,
    providerItems: overrides.providerItems ?? [],
  };
}

function createSnapshot(): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    projects: [
      {
        id: PROJECT_ID,
        kind: "project",
        title: "Sidebar Project",
        workspaceRoot: "/repo/project",
        defaultModelSelection: { provider: "codex", model: "gpt-5" },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
    threads: [
      baseThread(THREAD_PLAIN, "Plain thread"),
      baseThread(THREAD_PARENT, "Parent thread"),
      baseThread(THREAD_CHILD, "Child subagent", {
        parentThreadId: THREAD_PARENT,
        subagentAgentId: "agent-1",
        subagentNickname: "Scout",
        subagentRole: "explorer",
      }),
      baseThread(THREAD_PENDING, "Pending thread", { hasPendingApprovals: true }),
    ],
    updatedAt: NOW_ISO,
  };
}

function buildFixture(): TestFixture {
  return {
    snapshot: createSnapshot(),
    serverConfig: createBaseServerConfig(),
    welcome: {
      cwd: "/repo/project",
      projectName: "Sidebar Project",
      bootstrapProjectId: PROJECT_ID,
      bootstrapThreadId: THREAD_PLAIN,
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
    installRpcBridge(client, {
      resolveRpc: (tag) => {
        if (tag === ORCHESTRATION_WS_METHODS.getShellSnapshot) {
          return createShellSnapshotFromFixtureSnapshot(fixture.snapshot);
        }
        return resolveWsRpc(tag);
      },
      onStreamOpen: (tag, payload, emit) => {
        if (tag === WS_METHODS.subscribeServerLifecycle) {
          emit({ type: "welcome", payload: fixture.welcome });
        } else if (tag === ORCHESTRATION_WS_METHODS.subscribeShell) {
          emit({
            kind: "snapshot",
            snapshot: createShellSnapshotFromFixtureSnapshot(fixture.snapshot),
          });
        } else if (tag === ORCHESTRATION_WS_METHODS.subscribeThread) {
          const threadId = (payload as { threadId?: ThreadId })?.threadId;
          if (!threadId) return;
          const thread = fixture.snapshot.threads.find((entry) => entry.id === threadId);
          if (!thread) return;
          emit({
            kind: "snapshot",
            snapshot: {
              snapshotSequence: fixture.snapshot.snapshotSequence,
              thread,
            },
          });
        }
      },
    });
  }),
  http.get("*/attachments/:attachmentId", () => new HttpResponse(null, { status: 204 })),
  http.get("*/api/project-favicon", () => new HttpResponse(null, { status: 204 })),
);

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
    { timeout: 8_000, interval: 16 },
  );
  return element!;
}

async function waitForCondition(check: () => boolean, errorMessage: string): Promise<void> {
  await vi.waitFor(
    () => {
      expect(check(), errorMessage).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
}

function threadArchiveEl(threadId: ThreadId): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="thread-archive-${threadId}"]`);
}

function hasThreadRowText(text: string): boolean {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-thread-item]")).some((el) =>
    (el.textContent ?? "").includes(text),
  );
}

async function mountApp(): Promise<{ cleanup: () => Promise<void> }> {
  await page.viewport(1280, 900);
  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.width = "100vw";
  host.style.height = "100vh";
  host.style.display = "grid";
  host.style.overflow = "hidden";
  document.body.append(host);

  const router = getRouter(createMemoryHistory({ initialEntries: [`/${THREAD_PLAIN}`] }));
  const screen = await render(<RouterProvider router={router} />, { container: host });

  await waitForCondition(
    () => hasThreadRowText("Plain thread"),
    "Sidebar should render the plain thread row",
  );

  return {
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("Sidebar render gate", () => {
  let cleanupHarnessRejectionSuppression: (() => void) | null = null;

  beforeAll(async () => {
    cleanupHarnessRejectionSuppression = suppressKnownEffectRpcBrowserHarnessRejections();
    fixture = buildFixture();
    await worker.start({
      onUnhandledRequest: "bypass",
      quiet: true,
      serviceWorker: { url: "/mockServiceWorker.js" },
    });
  });

  afterAll(async () => {
    cleanupHarnessRejectionSuppression?.();
    cleanupHarnessRejectionSuppression = null;
    await worker.stop();
  });

  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
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

  afterEach(async () => {
    await __resetWsNativeApiForTests();
    document.body.innerHTML = "";
  });

  it("renders thread rows with titles and archive affordances", async () => {
    const mounted = await mountApp();
    try {
      expect(hasThreadRowText("Plain thread")).toBe(true);
      expect(hasThreadRowText("Parent thread")).toBe(true);

      const archive = await waitForElement(
        () => threadArchiveEl(THREAD_PLAIN),
        "Plain thread row should expose an archive action",
      );
      expect(archive.getAttribute("title")).toBe("Archive thread");
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders the project header and new-thread action", async () => {
    const mounted = await mountApp();
    try {
      const newThreadButton = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="new-thread-button"]'),
        "Project header should expose a new-thread button",
      );
      expect(newThreadButton).toBeTruthy();
      expect(document.body.textContent).toContain("Sidebar Project");
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders thread rows as interactive buttons carrying the entry-point attribute", async () => {
    const mounted = await mountApp();
    try {
      const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-thread-entry-point]"));
      expect(rows.length).toBeGreaterThanOrEqual(3);
      // Local (non-terminal) threads default to a "chat" entry point.
      expect(rows.every((row) => row.getAttribute("data-thread-entry-point") === "chat")).toBe(
        true,
      );
      expect(rows.every((row) => row.getAttribute("role") === "button")).toBe(true);
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders a pending-approval pill on threads awaiting approval", async () => {
    const mounted = await mountApp();
    try {
      await waitForCondition(
        () => hasThreadRowText("Pending thread"),
        "Pending thread row should render",
      );
      const pendingLabels = Array.from(
        document.querySelectorAll<HTMLElement>('[aria-label="Pending approval"]'),
      );
      expect(pendingLabels.length).toBeGreaterThan(0);
      expect(pendingLabels.some((el) => (el.textContent ?? "").includes("Pending"))).toBe(true);
    } finally {
      await mounted.cleanup();
    }
  });
});
