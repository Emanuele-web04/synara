import { describe, expect, it } from "vitest";
import { ProjectId, ThreadId, TurnId, type OrchestrationThreadShell } from "@synara/contracts";
import { Effect } from "effect";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeAgentGatewayKanbanTools } from "./kanbanTools.ts";
import type { McpToolCallResult } from "./protocol.ts";
import { GatewayToolError, type ToolContext, type ToolEntry } from "./toolRuntime.ts";

const NOW_ISO = "2026-08-16T10:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

const WORKSPACE_PATHS = {
  homeDir: "/home/tester",
  chatWorkspaceRoot: "/home/tester/chats",
};

const context: ToolContext = {
  principal: {
    kind: "provider-session",
    sessionKey: "gateway-session:kanban",
    threadId: "thread-caller",
    provider: "claudeAgent",
    turnId: "turn-caller",
  },
  callerThreadId: "thread-caller",
  callerSessionKey: "gateway-session:kanban",
  callerProvider: "claudeAgent",
  callerCapabilities: new Set(["thread:read", "thread:write"]),
  callerTurnId: "turn-caller",
  assertCallerTurnActive: () => Effect.void,
  jsonRpcRequestId: 1,
};

const readOnlyContext: ToolContext = {
  ...context,
  callerCapabilities: new Set(["thread:read"]),
};

const inactiveTurnContext: ToolContext = {
  ...context,
  assertCallerTurnActive: () =>
    Effect.fail(new GatewayToolError("caller_turn_inactive", "turn is over")),
};

function makeProjectShell(
  projectId = "project-a",
  title = "Project A",
  workspaceRoot = `/repos/${title}`,
  kind: "project" | "chat" = "project",
) {
  return {
    id: ProjectId.makeUnsafe(projectId),
    title,
    kind,
    workspaceRoot,
  } as const;
}

type ProjectShellRow = ReturnType<typeof makeProjectShell>;

const projectA = [makeProjectShell()];

function makeThreadShell(
  threadId: string,
  projectId = "project-a",
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id: ThreadId.makeUnsafe(threadId),
    projectId: ProjectId.makeUnsafe(projectId),
    title: threadId,
    modelSelection: { provider: "codex", model: "gpt-5.6-sol" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    envMode: "local",
    branch: null,
    worktreePath: null,
    associatedWorktreePath: null,
    associatedWorktreeBranch: null,
    associatedWorktreeRef: null,
    createBranchFlowCompleted: false,
    isPinned: false,
    parentThreadId: null,
    subagentAgentId: null,
    subagentNickname: null,
    subagentRole: null,
    forkSourceThreadId: null,
    sidechatSourceThreadId: null,
    lastKnownPr: null,
    latestTurn: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    archivedAt: null,
    handoff: null,
    session: null,
    ...overrides,
  };
}

/** Completed-turn shell with an idle live session row (a settled card). */
function makeSessionShell(
  threadId: string,
  projectId = "project-a",
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return makeThreadShell(threadId, projectId, {
    latestTurn: {
      turnId: TurnId.makeUnsafe(`turn-${threadId}`),
      state: "completed",
      requestedAt: NOW_ISO,
      startedAt: NOW_ISO,
      completedAt: NOW_ISO,
      assistantMessageId: null,
    },
    session: {
      threadId: ThreadId.makeUnsafe(threadId),
      status: "idle",
      providerName: "codex",
      runtimeMode: "approval-required",
      activeTurnId: null,
      lastError: null,
      updatedAt: NOW_ISO,
    },
    ...overrides,
  });
}

/** Settled card whose turn is running against a live session row. */
const makeRunningShell = (threadId: string): OrchestrationThreadShell =>
  makeSessionShell(threadId, "project-a", {
    latestTurn: {
      ...makeSessionShell(threadId).latestTurn!,
      state: "running",
      completedAt: null,
    },
    session: {
      threadId: ThreadId.makeUnsafe(threadId),
      status: "running",
      providerName: "codex",
      runtimeMode: "approval-required",
      activeTurnId: TurnId.makeUnsafe(`turn-${threadId}`),
      lastError: null,
      updatedAt: NOW_ISO,
    },
  });

function makeSnapshot(
  threads: ReadonlyArray<OrchestrationThreadShell>,
  projects: ReadonlyArray<ProjectShellRow>,
): ProjectionSnapshotQueryShape {
  return {
    getShellSnapshot: () => Effect.succeed({ projects: [...projects], threads: [...threads] }),
  } as unknown as ProjectionSnapshotQueryShape;
}

function makeTools(input: {
  threads: ReadonlyArray<OrchestrationThreadShell>;
  projects?: ReadonlyArray<ProjectShellRow>;
  runCreateThreads?: (args: unknown) => unknown;
  startTurn?: (args: unknown) => unknown;
  interruptTurn?: (args: unknown) => unknown;
  createDraftThread?: (args: unknown) => unknown;
  updateThreadMeta?: (args: unknown) => unknown;
  deleteThread?: (args: unknown) => unknown;
  assertCallerMayDriveThread?: () => Effect.Effect<void>;
}) {
  const started: Array<{
    threadId: string;
    message: string;
    dispatchMode: string;
  }> = [];
  const interrupted: Array<{ threadId: string }> = [];
  const created: Array<unknown> = [];
  const drafted: Array<unknown> = [];
  const metaUpdated: Array<unknown> = [];
  const deleted: Array<unknown> = [];
  const tools = makeAgentGatewayKanbanTools({
    snapshotQuery: makeSnapshot(input.threads, input.projects ?? projectA),
    workspacePaths: WORKSPACE_PATHS,
    now: () => NOW_MS,
    helpers: {
      requireThreadShell: (threadId) => {
        const found = input.threads.find((thread) => String(thread.id) === threadId);
        if (found) return Effect.succeed(found);
        if (threadId === "thread-caller" || threadId === "thread-other") {
          return Effect.succeed(makeThreadShell(threadId));
        }
        return Effect.fail(new Error(`missing thread ${threadId}`));
      },
      assertCallerMayDriveThread: (input.assertCallerMayDriveThread ??
        (() => Effect.void)) as never,
      runCreateThreads: ((args: unknown) => {
        created.push(args);
        return input.runCreateThreads ? input.runCreateThreads(args) : Effect.succeed(mcpOk({}));
      }) as never,
      startTurn: ((args: unknown) => {
        started.push(args as never);
        return input.startTurn ? input.startTurn(args) : Effect.succeed({ sequence: 42 });
      }) as never,
      interruptTurn: ((args: unknown) => {
        interrupted.push(args as never);
        return input.interruptTurn ? input.interruptTurn(args) : Effect.succeed({ sequence: 7 });
      }) as never,
      createDraftThread: ((args: unknown) => {
        drafted.push(args as never);
        return input.createDraftThread
          ? input.createDraftThread(args)
          : Effect.succeed({ threadId: "thread-draft-created" });
      }) as never,
      updateThreadMeta: ((args: unknown) => {
        metaUpdated.push(args as never);
        return input.updateThreadMeta ? input.updateThreadMeta(args) : Effect.void;
      }) as never,
      deleteThread: ((args: unknown) => {
        deleted.push(args as never);
        return input.deleteThread ? input.deleteThread(args) : Effect.void;
      }) as never,
    },
  });
  return { tools, started, interrupted, created, drafted, metaUpdated, deleted };
}

function mcpOk(text: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(text) }] };
}

const toolById = (tools: ReadonlyArray<ToolEntry>, name: string): ToolEntry => {
  const tool = tools.find((entry) => entry.definition.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool;
};

const runHandler = (tool: ToolEntry, args: Record<string, unknown>, ctx = context) =>
  Effect.runPromise(tool.handler(args, ctx));

/** Loose view of every kanban payload shape; per-test field reads stay self-documenting. */
type JsonPayload = Record<string, any>;

const jsonText = (result: McpToolCallResult): JsonPayload => {
  const content = result.content[0];
  // Surface the raw isError flag alongside the parsed text so callers can
  // assert error-ness and payload fields against one view.
  if (result.isError) {
    return {
      isError: true,
      __errorText: content?.type === "text" ? content.text : "",
    };
  }
  return {
    isError: false,
    ...(JSON.parse(content?.type === "text" ? content.text : "{}") as JsonPayload),
  };
};

type BoardPayload = {
  isError?: boolean;
  __errorText?: string;
  projects: Array<{
    projectId: string;
    columns: Array<{ key: string; cards: Array<Record<string, any>> }>;
  }>;
  truncated?: boolean;
  truncatedReason?: string;
  asOf?: string;
  callerThreadId?: string;
};

/** Run the board read and index every project's cards by column key. */
async function boardByColumn(tools: ReadonlyArray<ToolEntry>, args: Record<string, unknown> = {}) {
  const payload = jsonText(
    await runHandler(toolById(tools, "synara_read_kanban_board"), args),
  ) as BoardPayload & {
    projects: Array<{
      columns: Array<{ key: string; cards: Array<{ threadId: string }> }>;
    }>;
  };
  return {
    payload,
    columnsOf: (index = 0) =>
      Object.fromEntries(
        payload.projects[index]!.columns.map((column) => [column.key, column.cards]),
      ),
  };
}


describe("synara_read_kanban_board", () => {
  it("derives v2 columns + attention flags and skips non-project containers", async () => {
    const { tools } = makeTools({
      threads: [
        makeThreadShell("thread-draft"),
        makeRunningShell("thread-running"),
        makeSessionShell("thread-waiting", "project-a", {
          hasPendingApprovals: true,
        }),
        makeSessionShell("thread-done"),
        makeThreadShell("thread-chat", "chat-container"),
      ],
      projects: [
        makeProjectShell(),
        makeProjectShell("chat-container", "Chats", WORKSPACE_PATHS.chatWorkspaceRoot, "chat"),
      ],
    });

    const { payload, columnsOf } = await boardByColumn(tools);
    expect(payload.projects).toHaveLength(1);
    expect(payload.projects[0]!.projectId).toBe("project-a");
    const byColumn = columnsOf();
    expect(
      ["draft", "inProgress", "awaitingYou", "done"].map((key) =>
        (byColumn[key] ?? []).map((card) => card.threadId),
      ),
    ).toEqual([["thread-draft"], ["thread-running"], ["thread-waiting"], ["thread-done"]]);
    const waitingCard = byColumn.awaitingYou![0]!;
    expect(waitingCard.attention).toContain("awaiting-approval");
    // The chat container's thread must not surface on the ordinary-project board.
    expect(Object.values(byColumn).flatMap((cards) => cards.map((c) => c.threadId))).not.toContain(
      "thread-chat",
    );
  });
});

describe("synara_read_kanban_card", () => {
  it("returns the single card with column and attention flags", async () => {
    const { tools } = makeTools({
      threads: [
        makeSessionShell("thread-waiting", "project-a", {
          hasPendingApprovals: true,
        }),
      ],
    });

    const result = jsonText(
      await runHandler(toolById(tools, "synara_read_kanban_card"), {
        threadId: "thread-waiting",
      }),
    ) as {
      card: {
        threadId: string;
        column: string;
        attention: string[];
        model: string;
      };
      asOf: string;
      callerThreadId: string;
    };
    expect(result.card.threadId).toBe("thread-waiting");
    expect(result.card.column).toBe("awaitingYou");
    expect(result.card.attention).toContain("awaiting-approval");
    expect(result.card.model).toBe("gpt-5.6-sol");
    expect(result.asOf).toBe(NOW_ISO);
    expect(result.callerThreadId).toBe("thread-caller");
  });
});

describe("synara_create_kanban_task", () => {
  /** A creation-saga payload that satisfies the SynaraCreateThreadsResult contract. */
  const createOk = (threadIds: string[]) =>
    Effect.succeed(
      mcpOk({
        operationId: "op-1",
        requestId: "req-1",
        requestedCount: threadIds.length,
        createdCount: threadIds.length,
        threadIds,
        threads: threadIds.map((threadId, index) => ({
          index,
          threadId,
          projectId: "project-a",
          title: "created",
          target: { provider: "claudeAgent", model: "sonnet-5" },
          provider: "claudeAgent",
          model: "sonnet-5",
          runtimeMode: "approval-required",
          environment: "local",
          branch: null,
          worktreePath: null,
          status: "task_dispatched",
        })),
      }),
    );

  it("forwards the spec to runCreateThreads and returns threadId + card", async () => {
    const { tools, created } = makeTools({
      threads: [makeSessionShell("thread-created")],
      runCreateThreads: () => createOk(["thread-created"]),
    });

    const result = jsonText(
      await runHandler(toolById(tools, "synara_create_kanban_task"), {
        title: "Fix bug",
        requestId: "req-1",
      }),
    ) as { threadId: string; title: string; card: { column: string } };
    expect(created).toHaveLength(1);
    const spec = (
      created[0] as {
        threads: Array<{
          title: string;
          prompt: string;
          target: { provider: string };
        }>;
      }
    ).threads[0]!;
    expect(spec.title).toBe("Fix bug");
    expect(spec.prompt).toBe("Fix bug");
    expect(spec.target.provider).toBe("claudeAgent");
    expect(result.threadId).toBe("thread-created");
    expect(result.card.column).toBe("done");
  });

  it("rejects an over-long title", async () => {
    const { tools, created } = makeTools({
      threads: [makeSessionShell("thread-created")],
      runCreateThreads: () => createOk(["thread-created"]),
    });

    const longTitle = jsonText(
      await runHandler(toolById(tools, "synara_create_kanban_task"), {
        title: "x".repeat(257),
        requestId: "req-long-1",
      }),
    );
    expect(longTitle.isError).toBe(true);
    expect(longTitle.__errorText).toContain("at most 256");
    expect(created).toHaveLength(0);
  });
});

describe("synara_move_kanban_card", () => {
  const move = async (
    tools: ReadonlyArray<ToolEntry>,
    threadId: string,
    target: string,
    extra: Record<string, unknown> = {},
    ctx: ToolContext = context,
  ) =>
    jsonText(
      await runHandler(
        toolById(tools, "synara_move_kanban_card"),
        { threadId, target, ...extra },
        ctx,
      ),
    );

  it("starts a turn with an explicit message on a draft card", async () => {
    const { tools, started } = makeTools({
      threads: [makeThreadShell("thread-draft")],
    });

    const result = await move(tools, "thread-draft", "inProgress", {
      message: "Start this work",
    });
    expect(started).toEqual([
      {
        threadId: "thread-draft",
        message: "Start this work",
        dispatchMode: "queue",
        runtimeMode: "approval-required",
        interactionMode: "default",
      },
    ]);
    expect(result.turnStarted).toBe(true);
    expect(result.card.column).toBe("inProgress");
  });

  it("interrupts a live turn for target done", async () => {
    const { tools, interrupted } = makeTools({
      threads: [makeRunningShell("thread-live")],
    });

    const result = await move(tools, "thread-live", "done");
    expect(interrupted).toEqual([{ threadId: "thread-live" }]);
    expect(result.interruptRequested).toBe(true);
    expect(result.eventSequence).toBe(7);
  });

  it("refuses to drive an awaiting-you card into a new turn and reports why", async () => {
    const { tools, started } = makeTools({
      threads: [
        makeSessionShell("thread-waiting", "project-a", {
          hasPendingApprovals: true,
        }),
      ],
    });

    const result = await move(tools, "thread-waiting", "inProgress");
    expect(result.isError ?? false).toBe(false);
    expect(result.alreadyInProgress).toBe(true);
    expect(result.awaitingYou).toBe(true);
    expect(started).toHaveLength(0);
  });

  it("rejects moving an awaiting-you card to done", async () => {
    const { tools, interrupted } = makeTools({
      threads: [
        makeSessionShell("thread-waiting", "project-a", {
          hasPendingApprovals: true,
        }),
      ],
    });

    const result = await move(tools, "thread-waiting", "done");
    expect(result.isError).toBe(true);
    expect(result.__errorText).toContain("Awaiting-you cards cannot be force-moved");
    expect(interrupted).toHaveLength(0);
  });

  it("rejects moving a card in a different project from the caller", async () => {
    const { tools, started, interrupted } = makeTools({
      threads: [makeThreadShell("thread-foreign", "project-b")],
    });

    const result = await move(tools, "thread-foreign", "inProgress", {
      message: "Start work",
    });
    expect(result.isError).toBe(true);
    expect(result.__errorText).toContain("different project");
    expect(started).toHaveLength(0);
    expect(interrupted).toHaveLength(0);
  });

  it.each([
    { target: "inProgress", extraArgs: { message: "hi" } },
    { target: "done", extraArgs: {} },
  ] as const)("rejects an archived thread for target $target", async ({ target, extraArgs }) => {
    const { tools, started, interrupted } = makeTools({
      threads: [
        makeThreadShell("thread-archived", "project-a", {
          archivedAt: NOW_ISO,
        }),
      ],
    });

    const result = await move(tools, "thread-archived", target, extraArgs);
    expect(result.isError).toBe(true);
    expect(result.__errorText).toContain("archived");
    expect(started).toHaveLength(0);
    expect(interrupted).toHaveLength(0);
  });
});

describe("kanban write concurrency per card", () => {
  it("fails fast on a second concurrent move of the same card", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { tools, started } = makeTools({
      threads: [makeThreadShell("thread-a")],
      startTurn: () => Effect.promise(() => held.then(() => ({ sequence: 1 }))),
    });
    const tool = toolById(tools, "synara_move_kanban_card");
    const first = runHandler(tool, {
      threadId: "thread-a",
      target: "inProgress",
      message: "go",
    });
    // Yield so the first call holds its per-card key before the duplicate arrives.
    await Promise.resolve();
    const duplicate = await runHandler(tool, {
      threadId: "thread-a",
      target: "inProgress",
      message: "go again",
    });
    expect(duplicate.isError).toBe(true);
    expect((jsonText(duplicate) as { __errorText?: string }).__errorText).toContain(
      "already in flight",
    );

    release();
    const won = jsonText(await first);
    expect(won.turnStarted).toBe(true);
    // Exactly one turn started: the duplicate never dispatched.
    expect(started).toHaveLength(1);
  });

  it("keeps moves on different cards fully parallel", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { tools, started } = makeTools({
      threads: [makeThreadShell("thread-a"), makeThreadShell("thread-b")],
      startTurn: () => Effect.promise(() => held.then(() => ({ sequence: 1 }))),
    });
    const tool = toolById(tools, "synara_move_kanban_card");
    const first = runHandler(tool, {
      threadId: "thread-a",
      target: "inProgress",
      message: "go a",
    });
    await Promise.resolve();
    const second = runHandler(tool, {
      threadId: "thread-b",
      target: "inProgress",
      message: "go b",
    });
    await Promise.resolve();
    release();
    const [resultA, resultB] = await Promise.all([first, second]);
    expect(resultA.isError).toBeFalsy();
    expect(resultB.isError).toBeFalsy();
    expect(started).toHaveLength(2);
  });
});

describe("kanban write tool surface", () => {
  it.each([
    {
      name: "synara_create_kanban_draft",
      args: { title: "Draft", requestId: "req-x" },
    },
    {
      name: "synara_delete_kanban_card",
      args: { threadId: "thread-a" },
    },
    {
      name: "synara_update_kanban_card",
      args: { threadId: "thread-a", title: "New" },
    },
    {
      name: "synara_set_kanban_goal",
      args: { threadId: "thread-a", goal: "goal" },
    },
  ])("rejects $name without write scope or an active turn", async ({ name, args }) => {
    const { tools, drafted, metaUpdated, deleted } = makeTools({
      threads: [makeThreadShell("thread-a")],
    });
    const tool = toolById(tools, name);

    const noScope = jsonText(await runHandler(tool, args, readOnlyContext));
    expect(noScope.isError).toBe(true);
    expect(noScope.__errorText).toContain("thread:write");

    const noTurn = jsonText(await runHandler(tool, args, inactiveTurnContext));
    expect(noTurn.isError).toBe(true);
    expect(noTurn.__errorText).toContain("caller_turn_inactive");

    expect(drafted).toHaveLength(0);
    expect(metaUpdated).toHaveLength(0);
    expect(deleted).toHaveLength(0);
  });
});

describe("synara_create_kanban_draft", () => {
  it("creates a thread without dispatching and returns a draft card", async () => {
    const { tools, drafted, metaUpdated, started } = makeTools({
      threads: [makeThreadShell("thread-draft-created")],
      createDraftThread: () => Effect.succeed({ threadId: "thread-draft-created" }),
    });

    const result = jsonText(
      await runHandler(toolById(tools, "synara_create_kanban_draft"), {
        title: "Draft it",
        description: "Do it well",
        requestId: "req-draft-1",
      }),
    ) as { threadId: string; title: string; status: string; card: { column: string } };
    expect(result.threadId).toBe("thread-draft-created");
    expect(result.status).toBe("draft_created");
    expect(result.card.column).toBe("draft");
    expect(drafted).toHaveLength(1);
    const spec = drafted[0] as {
      title: string;
      projectId: string;
      modelSelection: { provider: string };
    };
    expect(spec.title).toBe("Draft it");
    expect(spec.projectId).toBe("project-a");
    expect(spec.modelSelection.provider).toBe("claudeAgent");
    expect(metaUpdated).toEqual([{ threadId: "thread-draft-created", notes: "Do it well" }]);
    // No turn started: the card stays a draft.
    expect(started).toHaveLength(0);
  });
});

describe("synara_delete_kanban_card", () => {
  it("deletes an own-project card from a live column", async () => {
    const { tools, deleted } = makeTools({
      threads: [makeRunningShell("thread-live")],
    });

    const result = jsonText(
      await runHandler(toolById(tools, "synara_delete_kanban_card"), {
        threadId: "thread-live",
      }),
    ) as { threadId: string; deleted: boolean };
    expect(result.threadId).toBe("thread-live");
    expect(result.deleted).toBe(true);
    expect(deleted).toEqual([{ threadId: "thread-live" }]);
  });
});

describe("synara_update_kanban_card", () => {
  it("edits title and description", async () => {
    const { tools, metaUpdated } = makeTools({
      threads: [makeThreadShell("thread-draft", "project-a", { title: "Old" })],
    });

    const result = jsonText(
      await runHandler(toolById(tools, "synara_update_kanban_card"), {
        threadId: "thread-draft",
        title: "New",
        description: "Better",
      }),
    ) as {
      threadId: string;
      title: string;
      titleUpdated: boolean;
      descriptionUpdated: boolean;
      card: { column: string };
    };
    expect(result.threadId).toBe("thread-draft");
    expect(result.title).toBe("New");
    expect(result.titleUpdated).toBe(true);
    expect(result.descriptionUpdated).toBe(true);
    expect(result.card.column).toBe("draft");
    expect(metaUpdated).toEqual([{ threadId: "thread-draft", title: "New", notes: "Better" }]);
  });
});

describe("synara_set_kanban_goal", () => {
  it("sets the goal on a live card", async () => {
    const { tools, metaUpdated } = makeTools({
      threads: [makeRunningShell("thread-live")],
    });

    const result = jsonText(
      await runHandler(toolById(tools, "synara_set_kanban_goal"), {
        threadId: "thread-live",
        goal: "  Ship it  ",
      }),
    ) as { threadId: string; goal: string | null };
    expect(result.threadId).toBe("thread-live");
    expect(result.goal).toBe("Ship it");
    expect(metaUpdated).toEqual([{ threadId: "thread-live", goal: "Ship it" }]);
  });

  it("clears the goal on null", async () => {
    const { tools, metaUpdated } = makeTools({
      threads: [makeSessionShell("thread-done")],
    });

    const result = jsonText(
      await runHandler(toolById(tools, "synara_set_kanban_goal"), {
        threadId: "thread-done",
        goal: null,
      }),
    ) as { threadId: string; goal: string | null };
    expect(result.goal).toBeNull();
    expect(metaUpdated).toEqual([{ threadId: "thread-done", goal: "" }]);
  });

  it("rejects an over-long goal", async () => {
    const { tools, metaUpdated } = makeTools({
      threads: [makeThreadShell("thread-draft")],
    });

    const result = jsonText(
      await runHandler(toolById(tools, "synara_set_kanban_goal"), {
        threadId: "thread-draft",
        goal: "x".repeat(4097),
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.__errorText).toContain("at most 4096");
    expect(metaUpdated).toHaveLength(0);
  });
});
