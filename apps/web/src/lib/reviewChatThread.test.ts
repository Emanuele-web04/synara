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

const retainThreadDetailSubscriptionMock = vi.hoisted(() =>
  vi.fn((_threadId: ThreadId) => vi.fn()),
);

vi.mock("../threadDetailSubscriptionRetention", () => ({
  retainThreadDetailSubscription: retainThreadDetailSubscriptionMock,
}));

import {
  buildReviewChatTarget,
  clearReviewChatThreadCacheForTests,
  findProjectForReviewChat,
  prewarmReviewChatThread,
  reviewChatTargetsEqual,
  REVIEW_RISKS_NATIVE_REVIEW_QUESTION,
  sendReviewChatQuestion,
  startNewReviewChatThread,
} from "./reviewChatThread";

type ReviewChatTestApi = {
  orchestration: {
    dispatchCommand: (command: ClientOrchestrationCommand) => Promise<{ sequence: number }>;
    getShellSnapshot: () => Promise<OrchestrationShellSnapshot>;
  };
};

type ThreadCreateCommand = Extract<ClientOrchestrationCommand, { type: "thread.create" }>;
type ThreadMetaUpdateCommand = Extract<ClientOrchestrationCommand, { type: "thread.meta.update" }>;
type ThreadSessionEnsureCommand = Extract<
  ClientOrchestrationCommand,
  { type: "thread.session.ensure" }
>;
type ThreadContextInjectCommand = Extract<
  ClientOrchestrationCommand,
  { type: "thread.context.inject" }
>;
type ThreadTurnStartCommand = Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>;

const initialStoreState = useStore.getState();
const projectId = ProjectId.makeUnsafe("project-review-chat");

const rejectUnrequestedSessionEnsure = (): void => {
  throw new Error("session ensure was not requested");
};

afterEach(() => {
  useStore.setState(initialStoreState, true);
  clearReviewChatThreadCacheForTests();
  retainThreadDetailSubscriptionMock.mockClear();
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

function isThreadContextInjectCommand(
  command: ClientOrchestrationCommand,
): command is ThreadContextInjectCommand {
  return command.type === "thread.context.inject";
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

function syncReadyReviewChatSession(input: {
  readonly threadId: ThreadId;
  readonly reviewChatTarget: ReturnType<typeof buildReviewChatTarget>;
  readonly modelSelection: ModelSelection;
}): void {
  const previousThread = useStore.getState().threads.find((thread) => thread.id === input.threadId);
  useStore.getState().syncServerShellSnapshot(
    makeShellSnapshot({
      existingThreadId: input.threadId,
      reviewChatTarget: input.reviewChatTarget,
      existingModelSelection: previousThread?.modelSelection ?? input.modelSelection,
      session: {
        threadId: input.threadId,
        status: "ready",
        providerName: input.modelSelection.provider,
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: "2026-06-07T12:00:01.000Z",
      },
    }),
  );
}

function syncReadyReviewChatSessionForEnsure(input: {
  readonly command: ClientOrchestrationCommand;
  readonly commands: readonly ClientOrchestrationCommand[];
  readonly reviewChatTarget?: ReturnType<typeof buildReviewChatTarget>;
}): void {
  if (!isThreadSessionEnsureCommand(input.command)) {
    return;
  }
  const modelSelection = input.command.modelSelection;
  if (modelSelection === undefined) {
    return;
  }
  const sessionEnsureCommand = input.command;
  const createCommand = input.commands
    .filter(isThreadCreateCommand)
    .find((command) => command.threadId === sessionEnsureCommand.threadId);
  const reviewChatTarget = input.reviewChatTarget ?? createCommand?.reviewChatTarget ?? null;
  if (!reviewChatTarget) {
    return;
  }
  syncReadyReviewChatSession({
    threadId: sessionEnsureCommand.threadId,
    reviewChatTarget,
    modelSelection,
  });
}

function makeReadyReviewChatSnapshot(input: {
  readonly commands: readonly ClientOrchestrationCommand[];
  readonly reviewChatTarget?: ReturnType<typeof buildReviewChatTarget> | undefined;
}): OrchestrationShellSnapshot {
  const createCommand = input.commands.find(isThreadCreateCommand);
  const ensureCommand = input.commands.find(isThreadSessionEnsureCommand);
  if (!createCommand || !ensureCommand?.modelSelection) {
    return makeShellSnapshot({});
  }
  return makeShellSnapshot({
    createCommand,
    reviewChatTarget: input.reviewChatTarget,
    session: {
      threadId: createCommand.threadId,
      status: "ready",
      providerName: ensureCommand.modelSelection.provider,
      runtimeMode: "approval-required",
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-06-07T12:00:01.000Z",
    },
  });
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
          syncReadyReviewChatSessionForEnsure({ command, commands });
          return { sequence: commands.length };
        }),
        getShellSnapshot: vi.fn(async () => {
          events.push("shell-snapshot");
          return makeShellSnapshot({
            createCommand: commands.find(isThreadCreateCommand),
          });
        }),
      },
    };

    const result = await sendReviewChatQuestion({
      payload: makePayload(),
      question: "What should I review first?",
      api,
    });

    expect(result.status).toBe("queued");
    await vi.waitFor(() => {
      expect(commands.filter(isThreadTurnStartCommand)).toHaveLength(1);
    });
    const createCommand = commands.find(isThreadCreateCommand);
    const turnCommand = commands.find(isThreadTurnStartCommand);
    expect(createCommand?.worktreePath).toBeNull();
    expect(createCommand?.reviewChatTarget?.number).toBe(7884);
    expect(createCommand?.reviewChatTarget?.headSha).toBe("abc123");
    expect(createCommand?.runtimeMode).toBe("approval-required");
    expect(turnCommand?.threadId).toBe(createCommand?.threadId);
    expect(turnCommand?.message.text).toContain("gh pr diff");
    expect(turnCommand?.message.text).toContain("What should I review first?");
    expect(commands.map((command) => command.type)).toEqual([
      "thread.create",
      "thread.session.ensure",
      "thread.turn.start",
    ]);
    expect(events.indexOf("thread.turn.start")).toBeGreaterThan(events.indexOf("thread.create"));
    expect(events.indexOf("shell-snapshot")).toBeGreaterThan(events.indexOf("thread.create"));
    expect(retainThreadDetailSubscriptionMock).toHaveBeenCalledWith(createCommand?.threadId);
    for (const result of retainThreadDetailSubscriptionMock.mock.results) {
      const release = result.value;
      expect(release).toHaveBeenCalledTimes(1);
    }
  });

  it("routes the review risks suggestion through native base-branch review", async () => {
    useStore.getState().syncServerShellSnapshot(makeShellSnapshot({}));
    const commands: ClientOrchestrationCommand[] = [];
    const api: ReviewChatTestApi = {
      orchestration: {
        dispatchCommand: vi.fn(async (command) => {
          commands.push(command);
          syncReadyReviewChatSessionForEnsure({ command, commands });
          return { sequence: commands.length };
        }),
        getShellSnapshot: vi.fn(async () => {
          return makeShellSnapshot({
            createCommand: commands.find(isThreadCreateCommand),
          });
        }),
      },
    };

    const result = await sendReviewChatQuestion({
      payload: makePayload(),
      question: REVIEW_RISKS_NATIVE_REVIEW_QUESTION,
      api,
    });

    expect(result.status).toBe("queued");
    await vi.waitFor(() => {
      expect(commands.filter(isThreadTurnStartCommand)).toHaveLength(1);
    });
    const turnCommand = commands.find(isThreadTurnStartCommand);
    expect(turnCommand?.reviewTarget).toEqual({ type: "baseBranch", branch: "main" });
    expect(turnCommand?.message.text).toBe(REVIEW_RISKS_NATIVE_REVIEW_QUESTION);
  });

  it("passes selected skill references through review chat turns", async () => {
    useStore.getState().syncServerShellSnapshot(makeShellSnapshot({}));
    const commands: ClientOrchestrationCommand[] = [];
    const api: ReviewChatTestApi = {
      orchestration: {
        dispatchCommand: vi.fn(async (command) => {
          commands.push(command);
          syncReadyReviewChatSessionForEnsure({ command, commands });
          return { sequence: commands.length };
        }),
        getShellSnapshot: vi.fn(async () =>
          makeShellSnapshot({
            createCommand: commands.find(isThreadCreateCommand),
          }),
        ),
      },
    };

    const result = await sendReviewChatQuestion({
      payload: makePayload(),
      question: "Use $hallmark here",
      skills: [{ name: "hallmark", path: "/Users/tylersheffield/.agents/skills/hallmark" }],
      api,
    });

    expect(result.status).toBe("queued");
    await vi.waitFor(() => {
      expect(commands.filter(isThreadTurnStartCommand)).toHaveLength(1);
    });
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
          syncReadyReviewChatSessionForEnsure({ command, commands, reviewChatTarget: target });
          return { sequence: commands.length };
        }),
        getShellSnapshot: vi.fn(async () =>
          makeShellSnapshot({ existingThreadId, reviewChatTarget: target }),
        ),
      },
    };

    const result = await sendReviewChatQuestion({
      payload,
      question: "Summarize this PR",
      api,
    });

    expect(result).toMatchObject({ status: "queued", threadId: existingThreadId, created: false });
    await vi.waitFor(() => {
      expect(commands.filter(isThreadTurnStartCommand)).toHaveLength(1);
    });
    expect(commands.map((command) => command.type)).toEqual([
      "thread.session.ensure",
      "thread.turn.start",
    ]);
    expect(commands.find(isThreadTurnStartCommand)?.threadId).toBe(existingThreadId);
    expect(commands.find(isThreadTurnStartCommand)?.message.text).toContain("Summarize this PR");
  });

  it("notifies when a queued review turn is being dispatched to the provider", async () => {
    const payload = makePayload();
    const target = buildReviewChatTarget(payload, projectId);
    const existingThreadId = ThreadId.makeUnsafe("thread-existing-review-chat-provider-start");
    useStore.getState().syncServerShellSnapshot(
      makeShellSnapshot({
        existingThreadId,
        reviewChatTarget: target,
      }),
    );
    const events: string[] = [];
    const api: ReviewChatTestApi = {
      orchestration: {
        dispatchCommand: vi.fn(async (command) => {
          events.push(command.type);
          syncReadyReviewChatSessionForEnsure({
            command,
            commands: [command],
            reviewChatTarget: target,
          });
          return { sequence: events.length };
        }),
        getShellSnapshot: vi.fn(async () =>
          makeShellSnapshot({ existingThreadId, reviewChatTarget: target }),
        ),
      },
    };

    const result = await sendReviewChatQuestion({
      payload,
      question: "Summarize this PR",
      api,
      onQueuedProviderStartRequested: () => events.push("provider-start-requested"),
    });

    expect(result).toMatchObject({ status: "queued", threadId: existingThreadId, created: false });
    await vi.waitFor(() => {
      expect(events).toContain("thread.turn.start");
    });
    expect(events).toEqual([
      "thread.session.ensure",
      "provider-start-requested",
      "thread.turn.start",
    ]);
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
          syncReadyReviewChatSessionForEnsure({ command, commands, reviewChatTarget: target });
          return { sequence: commands.length };
        }),
        getShellSnapshot: vi.fn(async () =>
          makeShellSnapshot({
            existingThreadId: commands.find(isThreadCreateCommand)?.threadId,
            reviewChatTarget: target,
          }),
        ),
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
    const target = buildReviewChatTarget(payload, projectId);
    const selectedThreadId = ThreadId.makeUnsafe("thread-newly-selected-review-chat");
    useStore.getState().syncServerShellSnapshot(
      makeShellSnapshot({
        existingThreadId: selectedThreadId,
        reviewChatTarget: target,
        session: {
          threadId: selectedThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-06-07T12:00:01.000Z",
        },
      }),
    );
    const commands: ClientOrchestrationCommand[] = [];
    const api: ReviewChatTestApi = {
      orchestration: {
        dispatchCommand: vi.fn(async (command) => {
          commands.push(command);
          syncReadyReviewChatSessionForEnsure({ command, commands, reviewChatTarget: target });
          return { sequence: commands.length };
        }),
        getShellSnapshot: vi.fn(async () =>
          makeShellSnapshot({
            createCommand: commands.find(isThreadCreateCommand),
            reviewChatTarget: target,
          }),
        ),
      },
    };

    const result = await sendReviewChatQuestion({
      payload,
      threadId: selectedThreadId,
      question: "Focus on the risky file",
      api,
    });

    const turnCommand = commands.find(isThreadTurnStartCommand);
    expect(result).toMatchObject({ status: "sent", threadId: selectedThreadId, created: false });
    expect(result.status === "sent" ? result.turnRequestedAt : null).toBeTruthy();
    expect(commands.find(isThreadCreateCommand)).toBeUndefined();
    expect(turnCommand?.threadId).toBe(selectedThreadId);
    expect(turnCommand?.message.text).toContain("gh pr diff");
    expect(turnCommand?.message.text).toContain("Focus on the risky file");
  });

  it("queues a review question for an explicitly selected cold review thread", async () => {
    const payload = makePayload();
    const target = buildReviewChatTarget(payload, projectId);
    const selectedThreadId = ThreadId.makeUnsafe("thread-selected-cold-review-chat");
    useStore.getState().syncServerShellSnapshot(
      makeShellSnapshot({
        existingThreadId: selectedThreadId,
        reviewChatTarget: target,
      }),
    );
    const commands: ClientOrchestrationCommand[] = [];
    let resolveSessionEnsure: () => void = rejectUnrequestedSessionEnsure;
    const api: ReviewChatTestApi = {
      orchestration: {
        dispatchCommand: vi.fn(async (command) => {
          commands.push(command);
          if (isThreadSessionEnsureCommand(command)) {
            await new Promise<void>((resolve) => {
              resolveSessionEnsure = resolve;
            });
            if (target && command.modelSelection) {
              syncReadyReviewChatSession({
                threadId: command.threadId,
                reviewChatTarget: target,
                modelSelection: command.modelSelection,
              });
            }
          }
          return { sequence: commands.length };
        }),
        getShellSnapshot: vi.fn(async () =>
          makeShellSnapshot({
            createCommand: commands.find(isThreadCreateCommand),
            reviewChatTarget: target,
          }),
        ),
      },
    };

    const result = await sendReviewChatQuestion({
      payload,
      threadId: selectedThreadId,
      question: "Focus on the risky file",
      api,
    });

    expect(result).toMatchObject({
      status: "queued",
      threadId: selectedThreadId,
      created: false,
      reason: "session_warming",
    });
    expect(commands.filter(isThreadTurnStartCommand)).toHaveLength(0);
    await vi.waitFor(() => {
      expect(commands.filter(isThreadSessionEnsureCommand)).toHaveLength(1);
    });

    resolveSessionEnsure();
    await vi.waitFor(() => {
      expect(commands.filter(isThreadTurnStartCommand)).toHaveLength(1);
    });
    const turnCommand = commands.find(isThreadTurnStartCommand);
    expect(turnCommand?.threadId).toBe(selectedThreadId);
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
          syncReadyReviewChatSessionForEnsure({ command, commands, reviewChatTarget: target });
          return { sequence: commands.length };
        }),
        getShellSnapshot: vi.fn(async () =>
          makeShellSnapshot({ existingThreadId, reviewChatTarget: target }),
        ),
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

    expect(result).toMatchObject({ status: "queued", threadId: existingThreadId, created: false });
    await vi.waitFor(() => {
      expect(commands.filter(isThreadTurnStartCommand)).toHaveLength(1);
    });
    expect(commands.map((command) => command.type)).toEqual([
      "thread.session.ensure",
      "thread.turn.start",
    ]);
    expect(commands.find(isThreadCreateCommand)).toBeUndefined();
    expect(commands.find(isThreadTurnStartCommand)?.threadId).toBe(existingThreadId);
  });

  it("starts a new review thread when the PR head changes", async () => {
    const payload = makePayload();
    const existingThreadId = ThreadId.makeUnsafe("thread-existing-review-chat-old-head");
    useStore.getState().syncServerShellSnapshot(
      makeShellSnapshot({
        existingThreadId,
        reviewChatTarget: buildReviewChatTarget(payload, projectId),
      }),
    );
    const commands: ClientOrchestrationCommand[] = [];
    const api: ReviewChatTestApi = {
      orchestration: {
        dispatchCommand: vi.fn(async (command) => {
          commands.push(command);
          syncReadyReviewChatSessionForEnsure({ command, commands });
          return { sequence: commands.length };
        }),
        getShellSnapshot: vi.fn(async () =>
          makeShellSnapshot({
            createCommand: commands.find(isThreadCreateCommand),
          }),
        ),
      },
    };

    const result = await sendReviewChatQuestion({
      payload: { ...payload, headSha: "def456" },
      question: "What changed after the force push?",
      api,
    });

    const createCommand = commands.find(isThreadCreateCommand);
    expect(result.status).toBe("queued");
    await vi.waitFor(() => {
      expect(commands.filter(isThreadTurnStartCommand)).toHaveLength(1);
    });
    expect(createCommand?.threadId).not.toBe(existingThreadId);
    expect(createCommand?.reviewChatTarget?.headSha).toBe("def456");
  });

  it("reuses a just-created review thread before the shell snapshot catches up", async () => {
    useStore.getState().syncServerShellSnapshot(makeShellSnapshot({}));
    const commands: ClientOrchestrationCommand[] = [];
    const api: ReviewChatTestApi = {
      orchestration: {
        dispatchCommand: vi.fn(async (command) => {
          commands.push(command);
          syncReadyReviewChatSessionForEnsure({ command, commands });
          return { sequence: commands.length };
        }),
        getShellSnapshot: vi.fn(async () => makeReadyReviewChatSnapshot({ commands })),
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

    expect(first.status).toBe("queued");
    expect(["queued", "sent"]).toContain(second.status);
    await vi.waitFor(() => {
      expect(commands.filter(isThreadTurnStartCommand)).toHaveLength(2);
    });
    const createCommands = commands.filter(isThreadCreateCommand);
    const turnCommands = commands.filter(isThreadTurnStartCommand);
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
          syncReadyReviewChatSessionForEnsure({ command, commands });
          return { sequence: commands.length };
        }),
        getShellSnapshot: vi.fn(async () => makeReadyReviewChatSnapshot({ commands })),
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

    expect(first.status).toBe("queued");
    expect(["queued", "sent"]).toContain(second.status);
    await vi.waitFor(() => {
      expect(commands.filter(isThreadTurnStartCommand)).toHaveLength(2);
    });
    const createCommands = commands.filter(isThreadCreateCommand);
    const turnCommands = commands.filter(isThreadTurnStartCommand);
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
          syncReadyReviewChatSessionForEnsure({ command, commands });
          return { sequence: commands.length };
        }),
        getShellSnapshot: vi.fn(async () => makeReadyReviewChatSnapshot({ commands })),
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

    expect(first.status).toBe("queued");
    expect(["queued", "sent"]).toContain(second.status);
    await vi.waitFor(() => {
      expect(commands.filter(isThreadTurnStartCommand)).toHaveLength(2);
    });
    const createCommands = commands.filter(isThreadCreateCommand);
    const turnCommands = commands.filter(isThreadTurnStartCommand);
    expect(createCommands).toHaveLength(1);
    expect(turnCommands).toHaveLength(2);
    expect(turnCommands[0]?.threadId).toBe(createCommands[0]?.threadId);
    expect(turnCommands[1]?.threadId).toBe(createCommands[0]?.threadId);
  });

  it("prewarms a review thread by injecting context and sends the first visible question on the same thread", async () => {
    const payload = makePayload();
    const target = buildReviewChatTarget(payload, projectId);
    useStore.getState().syncServerShellSnapshot(makeShellSnapshot({}));
    const commands: ClientOrchestrationCommand[] = [];
    const api: ReviewChatTestApi = {
      orchestration: {
        dispatchCommand: vi.fn(async (command) => {
          commands.push(command);
          if (target && isThreadSessionEnsureCommand(command) && command.modelSelection) {
            syncReadyReviewChatSession({
              threadId: command.threadId,
              reviewChatTarget: target,
              modelSelection: command.modelSelection,
            });
          }
          return { sequence: commands.length };
        }),
        getShellSnapshot: vi.fn(async () => makeReadyReviewChatSnapshot({ commands })),
      },
    };

    const prewarm = await prewarmReviewChatThread({
      payload,
      api,
    });
    const send = await sendReviewChatQuestion({
      payload,
      question: "Summarize this PR",
      api,
    });

    expect(prewarm.status).toBe("ready");
    expect(["queued", "sent"]).toContain(send.status);
    await vi.waitFor(() => {
      expect(commands.filter(isThreadTurnStartCommand)).toHaveLength(1);
    });
    const createCommands = commands.filter(isThreadCreateCommand);
    const ensureCommands = commands.filter(isThreadSessionEnsureCommand);
    const injectCommands = commands.filter(isThreadContextInjectCommand);
    const turnCommands = commands.filter(isThreadTurnStartCommand);
    expect(createCommands).toHaveLength(1);
    expect(ensureCommands).toHaveLength(1);
    // Codex review chats no longer use thread.context.inject during prewarm
    // to avoid head-of-line blocking. Context is included in the first turn.
    expect(injectCommands).toHaveLength(0);
    expect(turnCommands).toHaveLength(1);
    expect(ensureCommands[0]?.threadId).toBe(createCommands[0]?.threadId);
    expect(turnCommands[0]?.threadId).toBe(createCommands[0]?.threadId);
    expect(turnCommands[0]?.message.text).toContain("Changed files:");
    expect(turnCommands[0]?.message.text).toContain("Summarize this PR");
  });

  it("refreshes placeholder review chat metadata when full PR context arrives", async () => {
    const payload = makePayload();
    const target = buildReviewChatTarget(payload, projectId);
    useStore.getState().syncServerShellSnapshot(makeShellSnapshot({}));
    const commands: ClientOrchestrationCommand[] = [];
    const api: ReviewChatTestApi = {
      orchestration: {
        dispatchCommand: vi.fn(async (command) => {
          commands.push(command);
          if (target && isThreadSessionEnsureCommand(command) && command.modelSelection) {
            syncReadyReviewChatSession({
              threadId: command.threadId,
              reviewChatTarget: target,
              modelSelection: command.modelSelection,
            });
          }
          return { sequence: commands.length };
        }),
        getShellSnapshot: vi.fn(async () => makeShellSnapshot({})),
      },
    };

    const earlyPrewarm = await prewarmReviewChatThread({
      payload: makeIncompletePayload(),
      api,
    });
    const completePrewarm = await prewarmReviewChatThread({
      payload,
      api,
    });

    const metaUpdate = commands.find(isThreadMetaUpdateCommand);
    expect(earlyPrewarm.status).toBe("ready");
    expect(completePrewarm.status).toBe("ready");
    expect(metaUpdate).toMatchObject({
      title: "Review #7884: fix(wellsky): correct OT physical-assessment scale",
      branch: "main",
      lastKnownPr: {
        number: 7884,
        title: "fix(wellsky): correct OT physical-assessment scale",
        url: "https://github.com/enzo-health/bonaparte/pull/7884",
        baseBranch: "main",
        headBranch: "fix/ot-eval-physical-assessment-scale",
        state: "open",
      },
      reviewChatTarget: target,
    });
  });

  it("revalidates session readiness when early and complete Codex prewarm targets differ", async () => {
    const payload = makePayload();
    const target = buildReviewChatTarget(payload, projectId);
    useStore.getState().syncServerShellSnapshot(makeShellSnapshot({}));
    const commands: ClientOrchestrationCommand[] = [];
    const api: ReviewChatTestApi = {
      orchestration: {
        dispatchCommand: vi.fn(async (command) => {
          commands.push(command);
          if (target && isThreadSessionEnsureCommand(command) && command.modelSelection) {
            syncReadyReviewChatSession({
              threadId: command.threadId,
              reviewChatTarget: target,
              modelSelection: command.modelSelection,
            });
          }
          return { sequence: commands.length };
        }),
        getShellSnapshot: vi.fn(async () => makeShellSnapshot({})),
      },
    };

    const incomplete = await prewarmReviewChatThread({
      payload: makeIncompletePayload(),
      api,
    });
    const complete = await prewarmReviewChatThread({
      payload,
      api,
    });

    expect(incomplete.status).toBe("ready");
    expect(complete.status).toBe("ready");
    expect(commands.filter(isThreadCreateCommand)).toHaveLength(1);
    expect(commands.filter(isThreadSessionEnsureCommand)).toHaveLength(2);
    // Codex review chats no longer inject context during prewarm.
    // Context is deferred to the first visible user message.
    expect(commands.filter(isThreadContextInjectCommand)).toHaveLength(0);
    expect(commands.filter(isThreadTurnStartCommand)).toHaveLength(0);
  });

  it("queues visible send while an in-flight prewarm finishes session readiness", async () => {
    vi.useFakeTimers();
    const payload = makePayload();
    const target = buildReviewChatTarget(payload, projectId);
    useStore.getState().syncServerShellSnapshot(makeShellSnapshot({}));
    const commands: ClientOrchestrationCommand[] = [];
    let resolveSessionEnsure: () => void = rejectUnrequestedSessionEnsure;
    const api: ReviewChatTestApi = {
      orchestration: {
        dispatchCommand: vi.fn(async (command) => {
          commands.push(command);
          if (isThreadSessionEnsureCommand(command)) {
            await new Promise<void>((resolve) => {
              resolveSessionEnsure = resolve;
            });
            if (target && command.modelSelection) {
              syncReadyReviewChatSession({
                threadId: command.threadId,
                reviewChatTarget: target,
                modelSelection: command.modelSelection,
              });
            }
          }
          return { sequence: commands.length };
        }),
        getShellSnapshot: vi.fn(async () => makeShellSnapshot({})),
      },
    };

    const prewarm = prewarmReviewChatThread({
      payload,
      api,
    });
    prewarm.catch(() => undefined);
    await vi.waitFor(() => {
      expect(commands.some(isThreadSessionEnsureCommand)).toBe(true);
    });
    const send = sendReviewChatQuestion({
      payload,
      question: "Summarize this PR",
      api,
    });
    expect(commands.filter(isThreadTurnStartCommand)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(150);
    await expect(send).resolves.toMatchObject({ status: "queued" });
    expect(commands.filter(isThreadTurnStartCommand)).toHaveLength(0);

    resolveSessionEnsure();
    await vi.waitFor(() => {
      expect(commands.filter(isThreadTurnStartCommand)).toHaveLength(1);
    });
    await expect(prewarm).resolves.toMatchObject({ status: "ready" });

    const turnCommands = commands.filter(isThreadTurnStartCommand);
    expect(commands.filter(isThreadCreateCommand)).toHaveLength(1);
    expect(turnCommands).toHaveLength(1);
    expect(turnCommands[0]?.message.text).toContain("Summarize this PR");
    expect(turnCommands[0]?.message.text).toContain("Changed files:");
    expect(turnCommands[0]?.threadId).toBe(commands.find(isThreadCreateCommand)?.threadId);
    vi.useRealTimers();
  });

  it("queues visible send when the selected shell thread is still warming", async () => {
    vi.useFakeTimers();
    const payload = makePayload();
    const target = buildReviewChatTarget(payload, projectId);
    useStore.getState().syncServerShellSnapshot(makeShellSnapshot({}));
    const commands: ClientOrchestrationCommand[] = [];
    let resolveSessionEnsure: () => void = rejectUnrequestedSessionEnsure;
    const api: ReviewChatTestApi = {
      orchestration: {
        dispatchCommand: vi.fn(async (command) => {
          commands.push(command);
          if (isThreadSessionEnsureCommand(command)) {
            await new Promise<void>((resolve) => {
              resolveSessionEnsure = resolve;
            });
            if (target && command.modelSelection) {
              syncReadyReviewChatSession({
                threadId: command.threadId,
                reviewChatTarget: target,
                modelSelection: command.modelSelection,
              });
            }
          }
          return { sequence: commands.length };
        }),
        getShellSnapshot: vi.fn(async () => makeShellSnapshot({})),
      },
    };

    let selectedShellThreadId: ThreadId | null = null;
    const prewarm = prewarmReviewChatThread({
      payload,
      api,
      onThreadReady: (threadId) => {
        selectedShellThreadId = threadId;
      },
    });
    prewarm.catch(() => undefined);
    await vi.waitFor(() => {
      expect(selectedShellThreadId).not.toBeNull();
      expect(commands.some(isThreadSessionEnsureCommand)).toBe(true);
    });

    const send = sendReviewChatQuestion({
      payload,
      question: "Summarize this PR",
      threadId: selectedShellThreadId ?? undefined,
      api,
    });
    expect(commands.filter(isThreadTurnStartCommand)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(150);
    await expect(send).resolves.toMatchObject({
      status: "queued",
      threadId: selectedShellThreadId,
    });
    expect(commands.filter(isThreadTurnStartCommand)).toHaveLength(0);

    resolveSessionEnsure();
    await vi.waitFor(() => {
      expect(commands.filter(isThreadTurnStartCommand)).toHaveLength(1);
    });
    await expect(prewarm).resolves.toMatchObject({ status: "ready" });

    const turnCommand = commands.find(isThreadTurnStartCommand);
    expect(commands.filter(isThreadCreateCommand)).toHaveLength(1);
    expect(commands.filter(isThreadSessionEnsureCommand)).toHaveLength(1);
    expect(turnCommand?.threadId).toBe(selectedShellThreadId);
    expect(turnCommand?.message.text).toContain("Summarize this PR");
    vi.useRealTimers();
  });

  it("returns queued instead of blocking visible send behind the full prewarm timeout", async () => {
    vi.useFakeTimers();
    const payload = makePayload();
    const target = buildReviewChatTarget(payload, projectId);
    useStore.getState().syncServerShellSnapshot(makeShellSnapshot({}));
    const commands: ClientOrchestrationCommand[] = [];
    let resolveSessionEnsure: () => void = rejectUnrequestedSessionEnsure;
    const api: ReviewChatTestApi = {
      orchestration: {
        dispatchCommand: vi.fn(async (command) => {
          commands.push(command);
          if (isThreadSessionEnsureCommand(command)) {
            await new Promise<void>((resolve) => {
              resolveSessionEnsure = resolve;
            });
            if (target && command.modelSelection) {
              syncReadyReviewChatSession({
                threadId: command.threadId,
                reviewChatTarget: target,
                modelSelection: command.modelSelection,
              });
            }
          }
          return { sequence: commands.length };
        }),
        getShellSnapshot: vi.fn(async () => makeShellSnapshot({})),
      },
    };

    const prewarm = prewarmReviewChatThread({
      payload,
      api,
    });
    prewarm.catch(() => undefined);
    await vi.waitFor(() => {
      expect(commands.some(isThreadSessionEnsureCommand)).toBe(true);
    });

    let sendSettled = false;
    const send = sendReviewChatQuestion({
      payload,
      question: "Summarize this PR",
      api,
    });
    send.finally(() => {
      sendSettled = true;
    });

    await vi.advanceTimersByTimeAsync(149);
    expect(sendSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(send).resolves.toMatchObject({
      status: "queued",
      reason: "session_warming",
    });
    expect(commands.filter(isThreadTurnStartCommand)).toHaveLength(0);

    resolveSessionEnsure();
    await expect(prewarm).resolves.toMatchObject({ status: "ready" });
    await vi.waitFor(() => {
      expect(commands.filter(isThreadTurnStartCommand)).toHaveLength(1);
    });
    vi.useRealTimers();
  });

  it("reports queued review question failure without starting a turn after failed session warmup", async () => {
    useStore.getState().syncServerShellSnapshot(makeShellSnapshot({}));
    const commands: ClientOrchestrationCommand[] = [];
    const queuedFailures: string[] = [];
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
      onQueuedTurnFailed: (_threadId, _queuedAt, reason) => {
        queuedFailures.push(reason);
      },
      api,
    });

    await expect(prewarm).rejects.toThrow("session ensure failed");
    const createCommands = commands.filter(isThreadCreateCommand);
    const turnCommands = commands.filter(isThreadTurnStartCommand);
    expect(send).toMatchObject({
      status: "queued",
      reason: "session_warming",
    });
    await vi.waitFor(() => {
      expect(queuedFailures).toEqual(["session ensure failed"]);
    });
    expect(createCommands).toHaveLength(1);
    expect(turnCommands).toHaveLength(0);
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
          syncReadyReviewChatSessionForEnsure({ command, commands, reviewChatTarget: target });
          return { sequence: commands.length };
        }),
        getShellSnapshot: vi.fn(async () => makeShellSnapshot({})),
      },
    };

    const result = await sendReviewChatQuestion({
      payload,
      question: "Summarize this PR",
      api,
    });

    expect(result.status).toBe("queued");
    await vi.waitFor(() => {
      expect(commands.filter(isThreadTurnStartCommand)).toHaveLength(1);
    });
    const createCommand = commands.find(isThreadCreateCommand);
    const turnCommand = commands.find(isThreadTurnStartCommand);
    expect(createCommand?.threadId).not.toBe(staleThreadId);
    expect(turnCommand?.threadId).toBe(createCommand?.threadId);
  });

  it("sends Codex review chat model changes with the turn start command", async () => {
    const payload = makePayload();
    const target = buildReviewChatTarget(payload, projectId);
    const existingThreadId = ThreadId.makeUnsafe("thread-existing-review-chat-codex-model");
    useStore.getState().syncServerShellSnapshot(
      makeShellSnapshot({
        existingThreadId,
        reviewChatTarget: target,
        existingModelSelection: {
          provider: "codex",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
          options: { reasoningEffort: "medium" },
        },
      }),
    );
    const commands: ClientOrchestrationCommand[] = [];
    const api: ReviewChatTestApi = {
      orchestration: {
        dispatchCommand: vi.fn(async (command) => {
          commands.push(command);
          syncReadyReviewChatSessionForEnsure({ command, commands, reviewChatTarget: target });
          return { sequence: commands.length };
        }),
        getShellSnapshot: vi.fn(async () =>
          makeShellSnapshot({ existingThreadId, reviewChatTarget: target }),
        ),
      },
    };
    const modelSelection = {
      provider: "codex",
      model: "gpt-5.3-codex-spark",
      options: { reasoningEffort: "low" },
    } as const;

    const result = await sendReviewChatQuestion({
      payload,
      question: "Summarize this PR",
      modelSelection,
      api,
    });

    expect(result).toMatchObject({ status: "queued", threadId: existingThreadId, created: false });
    await vi.waitFor(() => {
      expect(commands.filter(isThreadTurnStartCommand)).toHaveLength(1);
    });
    expect(commands.map((command) => command.type)).toEqual([
      "thread.session.ensure",
      "thread.turn.start",
    ]);
    expect(commands.find(isThreadTurnStartCommand)?.modelSelection).toEqual(modelSelection);
  });

  it("updates the review chat model before starting a turn when switching provider", async () => {
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
          syncReadyReviewChatSessionForEnsure({ command, commands, reviewChatTarget: target });
          return { sequence: commands.length };
        }),
        getShellSnapshot: vi.fn(async () =>
          makeShellSnapshot({ existingThreadId, reviewChatTarget: target }),
        ),
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

    expect(result).toMatchObject({ status: "queued", threadId: existingThreadId, created: false });
    await vi.waitFor(() => {
      expect(commands.filter(isThreadTurnStartCommand)).toHaveLength(1);
    });
    expect(commands.map((command) => command.type)).toEqual([
      "thread.session.ensure",
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

  it("uses a bootstrap turn instead of context inject for non-Codex review chat prewarm", async () => {
    const payload = makePayload();
    const target = buildReviewChatTarget(payload, projectId);
    useStore.getState().syncServerShellSnapshot(makeShellSnapshot({}));
    const commands: ClientOrchestrationCommand[] = [];
    const api: ReviewChatTestApi = {
      orchestration: {
        dispatchCommand: vi.fn(async (command) => {
          commands.push(command);
          if (target && isThreadSessionEnsureCommand(command) && command.modelSelection) {
            syncReadyReviewChatSession({
              threadId: command.threadId,
              reviewChatTarget: target,
              modelSelection: command.modelSelection,
            });
          }
          return { sequence: commands.length };
        }),
        getShellSnapshot: vi.fn(async () => makeShellSnapshot({})),
      },
    };
    const claudeModelSelection = {
      provider: "claudeAgent",
      model: "claude-sonnet-4-6",
    } as const;

    const prewarm = await prewarmReviewChatThread({
      payload,
      modelSelection: claudeModelSelection,
      api,
    });

    expect(prewarm.status).toBe("ready");
    const injectCommands = commands.filter(isThreadContextInjectCommand);
    const turnCommands = commands.filter(isThreadTurnStartCommand);
    // Non-Codex providers use a bootstrap turn, not context injection.
    expect(injectCommands).toHaveLength(0);
    expect(turnCommands).toHaveLength(1);
    expect(turnCommands[0]?.message.text).toContain("Changed files:");
    expect(turnCommands[0]?.message.source).toBe("review-context-bootstrap");
  });
});
