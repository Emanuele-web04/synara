import "../index.css";

import {
  type CanvasDrawingSnapshot,
  type NativeApi,
  ProjectId,
  ThreadId,
} from "@synara/contracts";
import { EMPTY_CANVAS_SCENE } from "@synara/shared/excalidrawScene";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { resetWsNativeApiForTest } from "../wsNativeApi";
import { useStore } from "../store";
import { CanvasWorkspaceView } from "./CanvasWorkspaceView";

vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-router")>(
    "@tanstack/react-router",
  );
  return {
    ...actual,
    useNavigate: () => vi.fn(async () => undefined),
  };
});

const PROJECT_ID = ProjectId.makeUnsafe("project-canvas-browser");
const THREAD_ID = ThreadId.makeUnsafe("thread-canvas-browser");
const NOW_ISO = "2026-07-14T00:00:00.000Z";

function makeSnapshot(): CanvasDrawingSnapshot {
  return {
    relativePath: "drawings/thread-canvas-browser.excalidraw",
    scene: EMPTY_CANVAS_SCENE,
    revision: "revision-1",
  };
}

describe("CanvasWorkspaceView", () => {
  let previousNativeApi: NativeApi | undefined;

  beforeEach(() => {
    previousNativeApi = window.nativeApi;
    resetWsNativeApiForTest();
    localStorage.clear();
    document.body.innerHTML = "";
    useStore.setState({
      projects: [
        {
          id: PROJECT_ID,
          kind: "local",
          name: "Canvas Project",
          remoteName: "Canvas Project",
          folderName: "canvas-project",
          localName: null,
          cwd: "/repo/canvas-project",
          defaultModelSelection: { provider: "grok", model: "grok-4" },
          expanded: true,
          scripts: [],
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
        },
      ],
      threads: [
        {
          id: THREAD_ID,
          codexThreadId: null,
          projectId: PROJECT_ID,
          surface: "canvas",
          title: "Canvas Thread",
          modelSelection: { provider: "grok", model: "grok-4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          session: null,
          messages: [],
          proposedPlans: [],
          error: null,
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
          latestTurn: null,
          turnDiffSummaries: [],
          activities: [],
          branch: null,
          worktreePath: null,
        },
      ],
      threadIds: [THREAD_ID],
      threadShellById: {
        [THREAD_ID]: {
          id: THREAD_ID,
          codexThreadId: null,
          projectId: PROJECT_ID,
          surface: "canvas",
          title: "Canvas Thread",
          modelSelection: { provider: "grok", model: "grok-4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          error: null,
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
          latestUserMessageAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
          branch: null,
          worktreePath: null,
        },
      },
      sidebarThreadSummaryById: {},
      threadsHydrated: true,
    });

    const snapshot = makeSnapshot();
    Object.defineProperty(window, "nativeApi", {
      configurable: true,
      value: {
        canvas: {
          readDrawing: vi.fn(async () => snapshot),
          saveDrawing: vi.fn(async () => snapshot),
          deleteDrawing: vi.fn(async () => ({ deleted: true })),
          createDrawing: vi.fn(async () => snapshot),
        },
        orchestration: {
          dispatchCommand: vi.fn(async () => ({ sequence: 1 })),
        },
      } satisfies Partial<NativeApi>,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "nativeApi", {
      configurable: true,
      value: previousNativeApi,
    });
    resetWsNativeApiForTest();
    document.body.innerHTML = "";
  });

  it("renders the canvas shell and toggles the persistent chat pane", async () => {
    const screen = await render(
      <div style={{ width: "1440px", height: "900px" }}>
        <CanvasWorkspaceView
          threadId={THREAD_ID}
          projectId={PROJECT_ID}
          projectName="Canvas Project"
          chatPanel={<div>Persistent Chat</div>}
        />
      </div>,
    );

    try {
      await expect.element(page.getByText("Canvas Project")).toBeInTheDocument();
      await expect.element(
        page.getByRole("button", { name: "Canvas Thread" }),
      ).toBeInTheDocument();
      await expect.element(
        page.getByRole("main").getByText("Canvas Thread"),
      ).toBeInTheDocument();
      await expect.element(page.getByText("Persistent Chat")).toBeInTheDocument();
      await expect.element(page.getByText("Saved locally")).toBeInTheDocument();

      await page.getByRole("button", { name: "Hide chat panel" }).click();
      await expect.element(page.getByText("Persistent Chat")).not.toBeVisible();

      await page.getByRole("button", { name: "Show chat panel" }).click();
      await expect.element(page.getByText("Persistent Chat")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
});
