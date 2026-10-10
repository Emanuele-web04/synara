import { describe, expect, it, vi } from "vitest";
import { Effect, Layer, Option } from "effect";
import { ApprovalRequestId, type OrchestrationThread } from "@synara/contracts";
import { makeLocalAutoReviewer } from "./reviewer";
import { LocalAuto, type LocalAutoDecision } from "./LocalAuto";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../orchestration/Services/ProjectionSnapshotQuery";
import {
  ProviderRuntimeEventRepository,
  type ProviderRuntimeEventRepositoryShape,
} from "../persistence/Services/ProviderRuntimeEvents";
import {
  ProjectionTurnRepository,
  type ProjectionTurnRepositoryShape,
} from "../persistence/Services/ProjectionTurns";
import {
  ProjectionPendingInteractionRepository,
  type ProjectionPendingInteractionRepositoryShape,
  type ProjectionPendingInteraction,
} from "../persistence/Services/ProjectionPendingInteractions";
import { request, started, threadId, turnId, turn, userMessage } from "./testFixtures";

// Service doubles implement only the methods exercised by the reviewer.
function partial<T>(value: Partial<T>): T {
  return value as T;
}
async function runReview(
  options: {
    decision?: LocalAutoDecision;
    beforeResult?: (state: {
      thread: OrchestrationThread;
      pending: ProjectionPendingInteraction;
    }) => void;
    runtimeMode?: OrchestrationThread["runtimeMode"];
    stale?: boolean;
    request?: typeof request;
  } = {},
) {
  const thread = partial<OrchestrationThread>({
    id: threadId,
    runtimeMode: options.runtimeMode ?? "auto-local",
    messages: [userMessage],
    session: {
      threadId,
      status: "running",
      providerName: options.request?.provider ?? "claudeAgent",
      runtimeMode: "auto-local",
      activeTurnId: turnId,
      lastError: null,
      updatedAt: new Date().toISOString(),
    },
  });
  const state = {
    thread,
    pending: {
      threadId,
      requestId: ApprovalRequestId.makeUnsafe("approval-1"),
      turnId,
      lifecycleGeneration: "generation-1",
      status: "pending",
      interactionKind: "approval",
      decision: null,
      responseCommandId: null,
      responseRequestedAt: null,
      createdAt: userMessage.createdAt,
      resolvedAt: null,
    } as ProjectionPendingInteraction,
  };
  const dispatch = vi.fn((_command: import("@synara/contracts").OrchestrationCommand) =>
    Effect.succeed({ sequence: 1 }),
  );
  const classify = vi.fn(() =>
    Effect.sync(() => {
      options.beforeResult?.(state);
      return options.decision ?? { decision: "approve" as const, pDeny: 0.01 };
    }),
  );
  const layer = Layer.mergeAll(
    Layer.succeed(LocalAuto, { classify, manage: () => Effect.die("not used") }),
    Layer.succeed(OrchestrationEngineService, partial<OrchestrationEngineShape>({ dispatch })),
    Layer.succeed(
      ProjectionSnapshotQuery,
      partial<ProjectionSnapshotQueryShape>({
        getThreadDetailForExportById: () => Effect.succeed(Option.some(state.thread)),
      }),
    ),
    Layer.succeed(
      ProviderRuntimeEventRepository,
      partial<ProviderRuntimeEventRepositoryShape>({
        readThreadEvents: () =>
          Effect.succeed([
            {
              sequence: 1,
              event: { ...started, provider: options.request?.provider ?? started.provider },
            },
          ]),
      }),
    ),
    Layer.succeed(
      ProjectionTurnRepository,
      partial<ProjectionTurnRepositoryShape>({ listByThreadId: () => Effect.succeed([turn]) }),
    ),
    Layer.succeed(
      ProjectionPendingInteractionRepository,
      partial<ProjectionPendingInteractionRepositoryShape>({
        getByIdentity: () => Effect.succeed(Option.some(state.pending)),
      }),
    ),
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const enqueue = yield* makeLocalAutoReviewer;
        const event = {
          ...(options.request ?? request),
          createdAt: options.stale ? request.createdAt : new Date(Date.now() + 1000).toISOString(),
        };
        yield* enqueue(event, 2);
        yield* enqueue(event, 2);
        yield* Effect.sleep("30 millis");
      }),
    ).pipe(Effect.provide(layer)),
  );
  return {
    classify,
    commands: dispatch.mock.calls.map((args) => (args as unknown as [Record<string, unknown>])[0]),
  };
}

describe("Local Auto approval lifecycle", () => {
  it("classifies once and uses the durable, one-call approval command", async () => {
    const { classify, commands } = await runReview();
    expect(classify).toHaveBeenCalledTimes(1);
    expect(commands.map((command) => command.type)).toEqual([
      "thread.activity.append",
      "thread.approval.respond",
    ]);
    expect(commands[1]).toMatchObject({
      requestId: "approval-1",
      decision: "accept",
      lifecycleGeneration: "generation-1",
    });
  });
  it.each(["deny", "ask"] as const)("keeps %s outcomes interactive", async (decision) => {
    const { commands } = await runReview({ decision: { decision } });
    expect(commands.map((command) => command.type)).toEqual(["thread.activity.append"]);
  });
  it.each(["approval-required", "auto", "full-access"] as const)(
    "does not interfere with %s",
    async (runtimeMode) => {
      expect((await runReview({ runtimeMode })).classify).not.toHaveBeenCalled();
    },
  );
  it("does not review approvals replayed from an earlier server", async () => {
    expect((await runReview({ stale: true })).classify).not.toHaveBeenCalled();
  });
  it.each(["human", "generation", "mode", "turn", "steer", "stop"])(
    "discards a result after %s changes",
    async (change) => {
      const { commands } = await runReview({
        beforeResult: (state) => {
          if (change === "human") state.pending = { ...state.pending, status: "responding" };
          if (change === "generation")
            state.pending = { ...state.pending, lifecycleGeneration: "new" };
          if (change === "mode")
            state.thread = { ...state.thread, runtimeMode: "approval-required" };
          if (change === "turn")
            state.thread = {
              ...state.thread,
              session: { ...state.thread.session!, activeTurnId: null },
            };
          if (change === "steer")
            state.thread = {
              ...state.thread,
              messages: [userMessage, { ...userMessage, text: "Stop" }],
            };
          if (change === "stop")
            state.thread = {
              ...state.thread,
              session: { ...state.thread.session!, status: "stopped" },
            };
        },
      });
      expect(commands).toEqual([]);
    },
  );
});

it.each([
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "devin",
  "droid",
  "opencode",
  "pi",
  "antigravity",
] as const)("dispatches a one-call local Auto approval for %s", async (provider) => {
  const args =
    provider === "codex"
      ? { command: "ls" }
      : ["cursor", "grok", "devin", "droid"].includes(provider)
        ? {
            options: [{ kind: "allow_once" }],
            toolCall: { kind: "execute", rawInput: { command: "ls" } },
          }
        : provider === "opencode"
          ? { localAutoTool: { permission: "bash", toolName: "bash", input: { command: "ls" } } }
          : { toolName: "bash", input: { command: "ls" } };
  const { classify, commands } = await runReview({
    request: { ...request, provider, payload: { requestType: "command_execution_approval", args } },
  });
  expect(classify).toHaveBeenCalledOnce();
  expect(commands).toContainEqual(
    expect.objectContaining({ type: "thread.approval.respond", decision: "accept" }),
  );
});
