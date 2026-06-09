import {
  DEFAULT_MODEL_BY_PROVIDER,
  type OrchestrationSession,
  ProjectId,
  ThreadId,
  type ClientOrchestrationCommand,
  type ModelSelection,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useStore } from "../store";
import type { ReviewSidechatContextPayload } from "../components/review/reviewSidechatContext";
import { createSidebarDisplayThreadsSelector } from "../storeSelectors";
import {
  buildReviewChatTarget,
  clearReviewChatThreadCacheForTests,
  findProjectForReviewChat,
  prewarmReviewChatThread,
  reviewChatTargetsEqual,
  sendReviewChatQuestion,
  startNewReviewChatThread,
} from "./reviewChatThread";

type ReviewChatTestApi = {
  orchestration: {
    dispatchCommand: (command: ClientOrchestrationCommand) => Promise<{ sequence: number }>;
    getShellSnapshot: () => Promise<OrchestrationShellSnapshot>;
    subscribeThread: (input: { threadId: ThreadId }) => Promise<void>;
  };
};

type ThreadCreateCommand = Extract<ClientOrchestrationCommand, { type: "thread.create" }>;
type ThreadMetaUpdateCommand = Extract<ClientOrchestrationCommand, { type: "thread.meta.update" }>;
type ThreadSessionEnsureCommand = Extract<
  ClientOrchestrationCommand,
  { type: "thread.session.ensure" }
>;
type ThreadTurnStartCommand = Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>;

const initialStoreState = useStore.getState();
const projectId = ProjectId.makeUnsafe("project-review-chat");

afterEach(() => {
  useStore.setState(initialStoreState, true);
  clearReviewChatThreadCacheForTests();
  vi.restoreAllMocks();
});

function makePayload(): ReviewSidechatContextPayload {
  return {
    cwd: "/repo/bonaparte",
    reference: "7884",
    url: "https://github.com/enzo-health/bonaparte/pull/7884",
    number: 7884,
    title: "fix(wellsky): correct OT physical-assessment scale",
    author: "randylevan",
    state: "open",
    isDraft: false,
    baseBranch: "main",
    headBranch: "fix/ot-eval-physical-assessment-scale",
    headSha: "abc123",
    reviewDecision: null,
    mergeable: "MERGEABLE",
    checksStatus: "failing",
    repositoryId: "enzo-health/bonaparte",
    source: { _tag: "pullRequest", reference: "7884" },
    target: { _tag: "pullRequest", repositoryId: "enzo-health/bonaparte", number: 7884 },
    stats: {
      files: 24,
      additions: 834,
      deletions: 69,
      commits: 2,
    },
    body: "Fixes WellSky mapping behavior.",
    labels: [],
    reviewers: [],
    checks: [
      { name: "build_validation", state: "failure", workflow: "CI", description: null, url: null },
    ],
    files: [
      {
        path: "apps/integrations/lib/core/wellsky-writeback/__tests__/lpn-snv-regression.test.ts",
        status: "modified",
        insertions: 46,
        deletions: 0,
      },
    ],
    recentConversation: [],
    currentView: "files",
    selectedFilePath:
      "apps/integrations/lib/core/wellsky-writeback/__tests__/lpn-snv-regression.test.ts",
  };
}

function makeIncompletePayload(): ReviewSidechatContextPayload {
  return {
    ...makePayload(),
    headSha: null,
    target: null,
    files: [],
  };
}

function isThreadCreateCommand(
  command: ClientOrchestrationCommand,
): command is ThreadCreateCommand {
  return command.type === "thread.create";
}

function isThreadTurnStartCommand(
  command: ClientOrchestrationCommand,
): command is ThreadTurnStartCommand {
  return command.type === "thread.turn.start";
}

function isThreadMetaUpdateCommand(
  command: ClientOrchestrationCommand,
): command is ThreadMetaUpdateCommand {
  return command.type === "thread.meta.update";
}

function isThreadSessionEnsureCommand(
  command: ClientOrchestrationCommand,
): command is ThreadSessionEnsureCommand {
  return command.type === "thread.session.ensure";
}

function makeShellSnapshot(input: {
  createCommand?: ThreadCreateCommand | undefined;
  existingThreadId?: ThreadId | undefined;
  existingModelSelection?: ModelSelection | undefined;
  reviewChatTarget?: ReturnType<typeof buildReviewChatTarget> | undefined;
  latestUserMessageAt?: string | null | undefined;
  session?: OrchestrationSession | null | undefined;
}): OrchestrationShellSnapshot {
  const createdAt = input.createCommand?.createdAt ?? "2026-06-07T12:00:00.000Z";
  const threadId = input.existingThreadId ?? input.createCommand?.threadId ?? null;
  const target = input.reviewChatTarget ?? input.createCommand?.reviewChatTarget ?? null;
  const modelSelection = input.createCommand?.modelSelection ??
    input.existingModelSelection ?? {
      provider: "codex",
      model: DEFAULT_MODEL_BY_PROVIDER.codex,
    };
  return {
    snapshotSequence: 1,
    projects: [
      {
        id: projectId,
        kind: "project",
        title: "Bonaparte",
        workspaceRoot: "/repo/bonaparte",
        defaultModelSelection: null,
        scripts: [],
        createdAt,
        updatedAt: createdAt,
      },
    ],
    threads:
      threadId && target
        ? [
            {
              id: threadId,
              projectId,
              title: "Review #7884: fix(wellsky): correct OT physical-assessment scale",
              modelSelection,
              runtimeMode: "approval-required",
              interactionMode: "default",
              envMode: "local",
              branch: "main",
              worktreePath: null,
              associatedWorktreePath: null,
              associatedWorktreeBranch: null,
              associatedWorktreeRef: null,
              createBranchFlowCompleted: false,
              parentThreadId: null,
              subagentAgentId: null,
              subagentNickname: null,
              subagentRole: null,
              forkSourceThreadId: null,
              sidechatSourceThreadId: null,
              lastKnownPr: {
                number: 7884,
                title: "fix(wellsky): correct OT physical-assessment scale",
                url: "https://github.com/enzo-health/bonaparte/pull/7884",
                baseBranch: "main",
                headBranch: "fix/ot-eval-physical-assessment-scale",
                state: "open",
              },
              reviewChatTarget: target,
              latestTurn: null,
              latestUserMessageAt: input.latestUserMessageAt ?? null,
              createdAt,
              updatedAt: createdAt,
              archivedAt: null,
              handoff: null,
              session: input.session ?? null,
            },
          ]
        : [],
    updatedAt: createdAt,
  };
}

describe("reviewChatThread", () => {
  it("matches review chat threads by durable PR target", () => {
    useStore.getState().syncServerShellSnapshot(makeShellSnapshot({}));
    const project = findProjectForReviewChat(useStore.getState().projects, "/repo/bonaparte");
    expect(project?.id).toBe(projectId);
    const target = project ? buildReviewChatTarget(makePayload(), project.id) : null;
    expect(target?.repositoryId).toBe("enzo-health/bonaparte");
    expect(reviewChatTargetsEqual(target, target)).toBe(true);
  });

  it("creates a PR-bound thread and starts a review-only turn", async () => {
    useStore.getState().syncServerShellSnapshot(makeShellSnapshot({}));
    const commands: ClientOrchestrationCommand[] = [];
    const events: string[] = [];
    const api: ReviewChatTestApi = {
      orchestration: {
        dispatchCommand: vi.fn(async (command) => {
          commands.push(command);
          events.push(command.type);
          return { sequence: commands.length };
        }),
        getShellSnapshot: vi.fn(async () => {
          events.push("shell-snapshot");
          return makeShellSnapshot({
            createCommand: commands.find(isThreadCreateCommand),
          });
        }),
        subscribeThread: vi.fn(async () => undefined),
      },
    };

    const result = await sendReviewChatQuestion({
      payload: makePayload(),
      question: "What should I review first?",
      api,
    });

    expect(result.status).toBe("sent");
    const createCommand = commands.find(isThreadCreateCommand);
    const turnCommand = commands.find(isThreadTurnStartCommand);
    expect(createCommand?.worktreePath).toBeNull();
    expect(createCommand?.reviewChatTarget?.number).toBe(7884);
    expect(createCommand?.runtimeMode).toBe("approval-required");
    expect(turnCommand?.threadId).toBe(createCommand?.threadId);
    expect(turnCommand?.message.text).toContain("Do not create a new worktree");
    expect(turnCommand?.message.text).toContain("What should I review first?");
    expect(commands.map((command) => command.type)).toEqual(["thread.create", "thread.turn.start"]);
    expect(events.indexOf("thread.turn.start")).toBeGreaterThan(events.indexOf("thread.create"));
    expect(events.indexOf("shell-snapshot")).toBeGreaterThan(events.indexOf("thread.turn.start"));
  });

  it("passes selected skill references through review chat turns", async () => {
    useStore.getState().syncServerShellSnapshot(makeShellSnapshot({}));
    const commands: ClientOrchestrationCommand[] = [];
    const api: ReviewChatTestApi = {
      orchestration: {
        dispatchCommand: vi.fn(async (command) => {
          commands.push(command);
          return { sequence: commands.length };
        }),
        getShellSnapshot: vi.fn(async () =>
          makeShellSnapshot({
            createCommand: commands.find(isThreadCreateCommand),
          }),
        ),
        subscribeThread: vi.fn(async () => undefined),
      },
    };

    const result = await sendReviewChatQuestion({
      payload: makePayload(),
      question: "Use $hallmark here",
      skills: [{ name: "hallmark", path: "/Users/tylersheffield/.agents/skills/hallmark" }],
      api,
    });

    expect(result.status).toBe("sent");
    expect(commands.find(isThreadTurnStartCommand)?.message.skills).toEqual([
      { name: "hallmark", path: "/Users/tylersheffield/.agents/skills/hallmark" },
    ]);
  });

  it("reuses an existing bound review thread", async () => {
    const payload = makePayload();
    const target = buildReviewChatTarget(payload, projectId);
    const existingThreadId = ThreadId.makeUnsafe("thread-existing-review-chat");
    useStore.getState().syncServerShellSnapshot(
      makeShellSnapshot({
        existingThreadId,
        reviewChatTarget: target,
        latestUserMessageAt: "2026-06-07T12:05:00.000Z",
      }),
    );
    const commands: ClientOrchestrationCommand[] = [];
    const api: ReviewChatTestApi = {
      orchestration: {
        dispatchCommand: vi.fn(async (command) => {
          commands.push(command);
          return { sequence: commands.length };
        }),
        getShellSnapshot: vi.fn(async () =>
          makeShellSnapshot({ existingThreadId, reviewChatTarget: target }),
        ),
        subscribeThread: vi.fn(async () => undefined),
      },
    };

    const result = await sendReviewChatQuestion({
      payload,
      question: "Summarize this PR",
      api,
    });

    expect(result).toEqual({ status: "sent", threadId: existingThreadId, created: false });
    expect(commands.map((command) => command.type)).toEqual(["thread.turn.start"]);
    expect(commands.find(isThreadTurnStartCommand)?.threadId).toBe(existingThreadId);
    expect(commands.find(isThreadTurnStartCommand)?.message.text).toBe("Summarize this PR");
  });

  it("can start a fresh bound review thread even when one already exists", async () => {
    const payload = makePayload();
    const target = buildReviewChatTarget(payload, projectId);
    const existingThreadId = ThreadId.makeUnsafe("thread-existing-review-chat");
    useStore.getState().syncServerShellSnapshot(
      makeShellSnapshot({
        existingThreadId,
        reviewChatTarget: target,
        latestUserMessageAt: "2026-06-07T12:05:00.000Z",
      }),
    );
    const commands: ClientOrchestrationCommand[] = [];
    const api: ReviewChatTestApi = {
      orchestration: {
        dispatchCommand: vi.fn(async (command) => {
          commands.push(command);
          return { sequence: commands.length };
        }),
        getShellSnapshot: vi.fn(async () =>
          makeShellSnapshot({
            existingThreadId: commands.find(isThreadCreateCommand)?.threadId,
            reviewChatTarget: target,
          }),
        ),
        subscribeThread: vi.fn(async () => undefined),
      },
    };

    const result = await startNewReviewChatThread({
      payload,
      api,
    });

    const createCommand = commands.find(isThreadCreateCommand);
    const ensureCommand = commands.find(isThreadSessionEnsureCommand);
    expect(result.status).toBe("ready");
    expect(result.status === "ready" ? result.threadId : null).not.toBe(existingThreadId);
    expect(createCommand?.threadId).toBe(result.status === "ready" ? result.threadId : undefined);
    expect(createCommand?.reviewChatTarget?.number).toBe(7884);
    expect(ensureCommand?.threadId).toBe(createCommand?.threadId);
    expect(commands.map((command) => command.type)).toEqual([
      "thread.create",
      "thread.session.ensure",
    ]);
  });

  it("sends a review question to the explicitly selected review thread", async () => {
    const payload = makePayload();
    const selectedThreadId = ThreadId.makeUnsafe("thread-newly-selected-review-chat");
    useStore.getState().syncServerShellSnapshot(makeShellSnapshot({}));
    const commands: ClientOrchestrationCommand[] = [];
    const api: ReviewChatTestApi = {
      orchestration: {
        dispatchCommand: vi.fn(async (command) => {
          commands.push(command);
          return { sequence: commands.length };
        }),
        getShellSnapshot: vi.fn(async () => makeShellSnapshot({})),
        subscribeThread: vi.fn(async () => undefined),
      },
    };

    const result = await sendReviewChatQuestion({
      payload,
      threadId: selectedThreadId,
      question: "Focus on the risky file",
      api,
    });

    const turnCommand = commands.find(isThreadTurnStartCommand);
    expect(result).toEqual({ status: "sent", threadId: selectedThreadId, created: false });
    expect(commands.find(isThreadCreateCommand)).toBeUndefined();
    expect(turnCommand?.threadId).toBe(selectedThreadId);
    expect(turnCommand?.message.text).toContain("Do not create a new worktree");
    expect(turnCommand?.message.text).toContain("Focus on the risky file");
  });

  it("reuses the same review thread when route reference or url formatting changes", async () => {
    const payload = makePayload();
    const target = buildReviewChatTarget(payload, projectId);
    const existingThreadId = ThreadId.makeUnsafe("thread-existing-review-chat-by-number");
    useStore.getState().syncServerShellSnapshot(
      makeShellSnapshot({
        existingThreadId,
        reviewChatTarget: target,
        latestUserMessageAt: "2026-06-07T12:05:00.000Z",
      }),
    );
    const commands: ClientOrchestrationCommand[] = [];
    const api: ReviewChatTestApi = {
      orchestration: {
        dispatchCommand: vi.fn(async (command) => {
          commands.push(command);
          return { sequence: commands.length };
        }),
        getShellSnapshot: vi.fn(async () =>
          makeShellSnapshot({ existingThreadId, reviewChatTarget: target }),
        ),
        subscribeThread: vi.fn(async () => undefined),
      },
    };

    const result = await sendReviewChatQuestion({
      payload: {
        ...payload,
        reference: "https://github.com/enzo-health/bonaparte/pull/7884",
        url: "https://github.com/enzo-health/bonaparte/pull/7884?notification_referrer_id=1",
      },
      question: "What changed?",
      api,
    });

    expect(result).toEqual({ status: "sent", threadId: existingThreadId, created: false });
    expect(commands.map((command) => command.type)).toEqual(["thread.turn.start"]);
    expect(commands.find(isThreadCreateCommand)).toBeUndefined();
    expect(commands.find(isThreadTurnStartCommand)?.threadId).toBe(existingThreadId);
  });

  it("reuses a just-created review thread before the shell snapshot catches up", async () => {
    useStore.getState().syncServerShellSnapshot(makeShellSnapshot({}));
    const commands: ClientOrchestrationCommand[] = [];
    const api: ReviewChatTestApi = {
      orchestration: {
        dispatchCommand: vi.fn(async (command) => {
          commands.push(command);
          return { sequence: commands.length };
        }),
        getShellSnapshot: vi.fn(async () => makeShellSnapshot({})),
        subscribeThread: vi.fn(async () => undefined),
      },
    };

    const first = await sendReviewChatQuestion({
      payload: makePayload(),
      question: "Summarize this PR",
      api,
    });
    const second = await sendReviewChatQuestion({
      payload: makePayload(),
      question: "What should I review first?",
      api,
    });

    const createCommands = commands.filter(isThreadCreateCommand);
    const turnCommands = commands.filter(isThreadTurnStartCommand);
    expect(first.status).toBe("sent");
    expect(second.status).toBe("sent");
    expect(createCommands).toHaveLength(1);
    expect(turnCommands).toHaveLength(2);
    expect(turnCommands[0]?.threadId).toBe(createCommands[0]?.threadId);
    expect(turnCommands[1]?.threadId).toBe(createCommands[0]?.threadId);
    expect(turnCommands[0]?.message.text).toContain("Summarize this PR");
    expect(turnCommands[1]?.message.text).toBe("What should I review first?");
  });

  it("reuses a just-created review thread after the route reference normalizes", async () => {
    useStore.getState().syncServerShellSnapshot(makeShellSnapshot({}));
    const commands: ClientOrchestrationCommand[] = [];
    const api: ReviewChatTestApi = {
      orchestration: {
        dispatchCommand: vi.fn(async (command) => {
          commands.push(command);
          return { sequence: commands.length };
        }),
        getShellSnapshot: vi.fn(async () => makeShellSnapshot({})),
        subscribeThread: vi.fn(async () => undefined),
      },
    };
    const payload = makePayload();

    const first = await sendReviewChatQuestion({
      payload: {
        ...payload,
        reference: "https://github.com/enzo-health/bonaparte/pull/7884",
        url: "https://github.com/enzo-health/bonaparte/pull/7884?notification_referrer_id=1",
      },
      question: "Summarize this PR",
      api,
    });
    const second = await sendReviewChatQuestion({
      payload,
      question: "What should I review first?",
      api,
    });

    const createCommands = commands.filter(isThreadCreateCommand);
    const turnCommands = commands.filter(isThreadTurnStartCommand);
    expect(first.status).toBe("sent");
    expect(second.status).toBe("sent");
    expect(createCommands).toHaveLength(1);
    expect(turnCommands).toHaveLength(2);
    expect(turnCommands[0]?.threadId).toBe(createCommands[0]?.threadId);
    expect(turnCommands[1]?.threadId).toBe(createCommands[0]?.threadId);
  });

  it("reuses a just-created review thread after repository metadata loads", async () => {
    useStore.getState().syncServerShellSnapshot(makeShellSnapshot({}));
    const commands: ClientOrchestrationCommand[] = [];
    const api: ReviewChatTestApi = {
      orchestration: {
        dispatchCommand: vi.fn(async (command) => {
          commands.push(command);
          return { sequence: commands.length };
        }),
        getShellSnapshot: vi.fn(async () => makeShellSnapshot({})),
        subscribeThread: vi.fn(async () => undefined),
      },
    };
    const payload = makePayload();

    const first = await sendReviewChatQuestion({
      payload: {
        ...payload,
        repositoryId: null,
        target: null,
      },
      question: "Summarize this PR",
      api,
    });
    const second = await sendReviewChatQuestion({
      payload,
      question: "What should I review first?",
      api,
    });

    const createCommands = commands.filter(isThreadCreateCommand);
    const turnCommands = commands.filter(isThreadTurnStartCommand);
    expect(first.status).toBe("sent");
    expect(second.status).toBe("sent");
    expect(createCommands).toHaveLength(1);
    expect(turnCommands).toHaveLength(2);
    expect(turnCommands[0]?.threadId).toBe(createCommands[0]?.threadId);
    expect(turnCommands[1]?.threadId).toBe(createCommands[0]?.threadId);
  });

  it("prewarms a review thread and sends the first visible question on the same thread", async () => {
    useStore.getState().syncServerShellSnapshot(makeShellSnapshot({}));
    const commands: ClientOrchestrationCommand[] = [];
    const api: ReviewChatTestApi = {
      orchestration: {
        dispatchCommand: vi.fn(async (command) => {
          commands.push(command);
          return { sequence: commands.length };
        }),
        getShellSnapshot: vi.fn(async () => makeShellSnapshot({})),
        subscribeThread: vi.fn(async () => undefined),
      },
    };

    const prewarm = await prewarmReviewChatThread({
      payload: makePayload(),
      api,
    });
    const send = await sendReviewChatQuestion({
      payload: makePayload(),
      question: "Summarize this PR",
      api,
    });

    const createCommands = commands.filter(isThreadCreateCommand);
    const ensureCommands = commands.filter(isThreadSessionEnsureCommand);
    const turnCommands = commands.filter(isThreadTurnStartCommand);
    expect(prewarm.status).toBe("ready");
    expect(send.status).toBe("sent");
    expect(createCommands).toHaveLength(1);
    expect(ensureCommands).toHaveLength(1);
    expect(turnCommands).toHaveLength(2);
    expect(ensureCommands[0]?.threadId).toBe(createCommands[0]?.threadId);
    expect(turnCommands[0]?.threadId).toBe(createCommands[0]?.threadId);
    expect(turnCommands[0]?.message.source).toBe("review-context-bootstrap");
    expect(turnCommands[0]?.message.text).toContain("Changed files:");
    expect(turnCommands[0]?.message.text).toContain("Reply exactly: ready");
    expect(turnCommands[1]?.threadId).toBe(createCommands[0]?.threadId);
    expect(turnCommands[1]?.message.text).toBe("Summarize this PR");
  });

  it("starts a hidden review context turn only after complete context is available", async () => {
    useStore.getState().syncServerShellSnapshot(makeShellSnapshot({}));
    const commands: ClientOrchestrationCommand[] = [];
    const api: ReviewChatTestApi = {
      orchestration: {
        dispatchCommand: vi.fn(async (command) => {
          commands.push(command);
          return { sequence: commands.length };
        }),
        getShellSnapshot: vi.fn(async () => makeShellSnapshot({})),
        subscribeThread: vi.fn(async () => undefined),
      },
    };

    const incomplete = await prewarmReviewChatThread({
      payload: makeIncompletePayload(),
      api,
    });
    const complete = await prewarmReviewChatThread({
      payload: makePayload(),
      api,
    });

    expect(incomplete.status).toBe("ready");
    expect(complete.status).toBe("ready");
    expect(commands.filter(isThreadCreateCommand)).toHaveLength(1);
    expect(commands.filter(isThreadSessionEnsureCommand)).toHaveLength(2);
    const turnCommands = commands.filter(isThreadTurnStartCommand);
    expect(turnCommands).toHaveLength(1);
    expect(turnCommands[0]?.message.source).toBe("review-context-bootstrap");
    expect(turnCommands[0]?.message.text).toContain("Changed files:");
  });

  it("does not wait indefinitely for an in-flight prewarm before sending the visible review question", async () => {
    vi.useFakeTimers();
    useStore.getState().syncServerShellSnapshot(makeShellSnapshot({}));
    const commands: ClientOrchestrationCommand[] = [];
    let resolveSessionEnsure: (() => void) | null = null;
    const api: ReviewChatTestApi = {
      orchestration: {
        dispatchCommand: vi.fn(async (command) => {
          commands.push(command);
          if (isThreadSessionEnsureCommand(command)) {
            await new Promise<void>((resolve) => {
              resolveSessionEnsure = resolve;
            });
          }
          return { sequence: commands.length };
        }),
        getShellSnapshot: vi.fn(async () => makeShellSnapshot({})),
        subscribeThread: vi.fn(async () => undefined),
      },
    };

    const prewarm = prewarmReviewChatThread({
      payload: makePayload(),
      api,
    });
    prewarm.catch(() => undefined);
    await vi.waitFor(() => {
      expect(commands.some(isThreadSessionEnsureCommand)).toBe(true);
    });
    const send = sendReviewChatQuestion({
      payload: makePayload(),
      question: "Summarize this PR",
      api,
    });
    await vi.advanceTimersByTimeAsync(251);
    await vi.waitFor(() => {
      expect(commands.filter(isThreadTurnStartCommand)).toHaveLength(1);
    });

    resolveSessionEnsure?.();
    await expect(prewarm).resolves.toMatchObject({ status: "ready" });
    await expect(send).resolves.toMatchObject({ status: "sent" });

    const turnCommands = commands.filter(isThreadTurnStartCommand);
    expect(commands.filter(isThreadCreateCommand)).toHaveLength(1);
    expect(turnCommands).toHaveLength(1);
    expect(turnCommands[0]?.message.text).toContain("Summarize this PR");
    expect(turnCommands[0]?.message.text).toContain("Changed files:");
    expect(turnCommands[0]?.threadId).toBe(commands.find(isThreadCreateCommand)?.threadId);
    vi.useRealTimers();
  });

  it("does not block a visible review question behind a failed prewarm", async () => {
    useStore.getState().syncServerShellSnapshot(makeShellSnapshot({}));
    const commands: ClientOrchestrationCommand[] = [];
    const api: ReviewChatTestApi = {
      orchestration: {
        dispatchCommand: vi.fn(async (command) => {
          commands.push(command);
          if (isThreadSessionEnsureCommand(command)) {
            throw new Error("session ensure failed");
          }
          return { sequence: commands.length };
        }),
        getShellSnapshot: vi.fn(async () => makeShellSnapshot({})),
        subscribeThread: vi.fn(async () => undefined),
      },
    };

    const prewarm = prewarmReviewChatThread({
      payload: makePayload(),
      api,
    });
    prewarm.catch(() => undefined);
    await vi.waitFor(() => {
      expect(commands.some(isThreadSessionEnsureCommand)).toBe(true);
    });

    const send = await sendReviewChatQuestion({
      payload: makePayload(),
      question: "Summarize this PR",
      api,
    });

    await expect(prewarm).rejects.toThrow("session ensure failed");
    const createCommands = commands.filter(isThreadCreateCommand);
    const turnCommands = commands.filter(isThreadTurnStartCommand);
    expect(send.status).toBe("sent");
    expect(createCommands).toHaveLength(1);
    expect(turnCommands).toHaveLength(1);
    expect(turnCommands[0]?.threadId).toBe(createCommands[0]?.threadId);
    expect(turnCommands[0]?.message.text).toContain("Summarize this PR");
  });

  it("skips stale stopped review threads when resolving the active PR chat", async () => {
    const payload = makePayload();
    const target = buildReviewChatTarget(payload, projectId);
    const staleThreadId = ThreadId.makeUnsafe("thread-stale-review-chat");
    useStore.getState().syncServerShellSnapshot(
      makeShellSnapshot({
        existingThreadId: staleThreadId,
        reviewChatTarget: target,
        latestUserMessageAt: "2026-06-07T12:05:00.000Z",
        session: {
          threadId: staleThreadId,
          status: "stopped",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: "thread/resume failed: no rollout found for thread id 019db5ad",
          updatedAt: "2026-06-07T12:06:00.000Z",
        },
      }),
    );
    const commands: ClientOrchestrationCommand[] = [];
    const api: ReviewChatTestApi = {
      orchestration: {
        dispatchCommand: vi.fn(async (command) => {
          commands.push(command);
          return { sequence: commands.length };
        }),
        getShellSnapshot: vi.fn(async () => makeShellSnapshot({})),
        subscribeThread: vi.fn(async () => undefined),
      },
    };

    const result = await sendReviewChatQuestion({
      payload,
      question: "Summarize this PR",
      api,
    });

    const createCommand = commands.find(isThreadCreateCommand);
    const turnCommand = commands.find(isThreadTurnStartCommand);
    expect(result.status).toBe("sent");
    expect(createCommand?.threadId).not.toBe(staleThreadId);
    expect(turnCommand?.threadId).toBe(createCommand?.threadId);
  });

  it("updates the review chat model before starting a turn on an existing thread", async () => {
    const payload = makePayload();
    const target = buildReviewChatTarget(payload, projectId);
    const existingThreadId = ThreadId.makeUnsafe("thread-existing-review-chat-model");
    useStore
      .getState()
      .syncServerShellSnapshot(makeShellSnapshot({ existingThreadId, reviewChatTarget: target }));
    const commands: ClientOrchestrationCommand[] = [];
    const api: ReviewChatTestApi = {
      orchestration: {
        dispatchCommand: vi.fn(async (command) => {
          commands.push(command);
          return { sequence: commands.length };
        }),
        getShellSnapshot: vi.fn(async () =>
          makeShellSnapshot({ existingThreadId, reviewChatTarget: target }),
        ),
        subscribeThread: vi.fn(async () => undefined),
      },
    };
    const modelSelection = {
      provider: "claudeAgent",
      model: "claude-sonnet-4-6",
    } as const;

    const result = await sendReviewChatQuestion({
      payload,
      question: "Summarize this PR",
      modelSelection,
      api,
    });

    expect(result).toEqual({ status: "sent", threadId: existingThreadId, created: false });
    expect(commands.map((command) => command.type)).toEqual([
      "thread.meta.update",
      "thread.turn.start",
    ]);
    expect(commands.find(isThreadMetaUpdateCommand)?.modelSelection).toEqual(modelSelection);
    expect(commands.find(isThreadTurnStartCommand)?.modelSelection).toEqual(modelSelection);
  });

  it("keeps review-bound threads out of normal sidebar display", () => {
    const payload = makePayload();
    const target = buildReviewChatTarget(payload, projectId);
    const existingThreadId = ThreadId.makeUnsafe("thread-sidebar-hidden-review-chat");
    useStore
      .getState()
      .syncServerShellSnapshot(makeShellSnapshot({ existingThreadId, reviewChatTarget: target }));

    const selectSidebarDisplayThreads = createSidebarDisplayThreadsSelector();

    expect(selectSidebarDisplayThreads(useStore.getState())).toEqual([]);
  });
});
