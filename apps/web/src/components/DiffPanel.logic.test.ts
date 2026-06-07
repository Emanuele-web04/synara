import { ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { DraftThreadState } from "../composerDraftStore";
import type { Thread } from "../types";
import { resolveDiffPanelThread, resolveDiffSelectAllArmed } from "./DiffPanel.logic";

const PROJECT_ID = ProjectId.makeUnsafe("project-1");
const THREAD_ID = ThreadId.makeUnsafe("thread-1");

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: THREAD_ID,
    codexThreadId: null,
    projectId: PROJECT_ID,
    title: "Thread 1",
    modelSelection: { provider: "codex", model: "gpt-5.4-mini" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-04-16T10:00:00.000Z",
    updatedAt: "2026-04-16T10:00:00.000Z",
    latestTurn: {
      turnId: TurnId.makeUnsafe("turn-1"),
      state: "completed",
      requestedAt: "2026-04-16T10:00:00.000Z",
      startedAt: "2026-04-16T10:00:01.000Z",
      completedAt: "2026-04-16T10:00:02.000Z",
      assistantMessageId: null,
      sourceProposedPlan: undefined,
    },
    lastVisitedAt: "2026-04-16T10:00:02.000Z",
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

function makeDraftThread(overrides: Partial<DraftThreadState> = {}): DraftThreadState {
  return {
    projectId: PROJECT_ID,
    createdAt: "2026-04-16T10:00:00.000Z",
    runtimeMode: "full-access",
    interactionMode: "default",
    entryPoint: "chat",
    branch: null,
    worktreePath: null,
    envMode: "local",
    ...overrides,
  };
}

describe("resolveDiffPanelThread", () => {
  it("keeps the server-backed thread when one exists", () => {
    const serverThread = makeThread({ title: "Server thread" });

    expect(
      resolveDiffPanelThread({
        threadId: THREAD_ID,
        serverThread,
        draftThread: makeDraftThread({ branch: "feature/draft" }),
        fallbackModelSelection: { provider: "codex", model: "gpt-5.4-mini" },
      }),
    ).toBe(serverThread);
  });

  it("builds a local draft-backed thread when the server thread is missing", () => {
    const resolved = resolveDiffPanelThread({
      threadId: THREAD_ID,
      serverThread: undefined,
      draftThread: makeDraftThread({
        branch: "feature/draft",
        worktreePath: "/tmp/worktree",
        envMode: "worktree",
      }),
      fallbackModelSelection: { provider: "codex", model: "gpt-5.4-mini" },
    });

    expect(resolved).toMatchObject({
      id: THREAD_ID,
      projectId: PROJECT_ID,
      title: "New thread",
      envMode: "worktree",
      branch: "feature/draft",
      worktreePath: "/tmp/worktree",
      turnDiffSummaries: [],
    });
  });

  it("returns undefined when neither a server thread nor a draft thread exists", () => {
    expect(
      resolveDiffPanelThread({
        threadId: THREAD_ID,
        serverThread: undefined,
        draftThread: null,
        fallbackModelSelection: null,
      }),
    ).toBeUndefined();
  });
});

describe("resolveDiffSelectAllArmed", () => {
  it("arms on Cmd/Ctrl+A inside the diff viewport", () => {
    expect(
      resolveDiffSelectAllArmed(false, { key: "a", metaKey: true, ctrlKey: false }, true),
    ).toBe(true);
    expect(
      resolveDiffSelectAllArmed(false, { key: "A", metaKey: false, ctrlKey: true }, true),
    ).toBe(true);
  });

  it("does not arm on Cmd/Ctrl+A outside the diff viewport", () => {
    expect(
      resolveDiffSelectAllArmed(false, { key: "a", metaKey: true, ctrlKey: false }, false),
    ).toBe(false);
    expect(
      resolveDiffSelectAllArmed(true, { key: "a", metaKey: false, ctrlKey: true }, false),
    ).toBe(false);
  });

  it("preserves the armed state through the copy half of the gesture", () => {
    expect(
      resolveDiffSelectAllArmed(true, { key: "c", metaKey: true, ctrlKey: false }, false),
    ).toBe(true);
    expect(
      resolveDiffSelectAllArmed(false, { key: "c", metaKey: true, ctrlKey: false }, false),
    ).toBe(false);
  });

  it("preserves the armed state through bare modifier keydowns", () => {
    expect(
      resolveDiffSelectAllArmed(true, { key: "Meta", metaKey: true, ctrlKey: false }, false),
    ).toBe(true);
    expect(
      resolveDiffSelectAllArmed(true, { key: "Shift", metaKey: false, ctrlKey: false }, false),
    ).toBe(true);
  });

  it("disarms on any other key that starts a fresh selection", () => {
    expect(
      resolveDiffSelectAllArmed(true, { key: "ArrowDown", metaKey: false, ctrlKey: false }, true),
    ).toBe(false);
    expect(
      resolveDiffSelectAllArmed(true, { key: "x", metaKey: false, ctrlKey: false }, true),
    ).toBe(false);
  });
});
