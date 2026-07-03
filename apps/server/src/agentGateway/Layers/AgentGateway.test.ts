import { assert, describe, it } from "@effect/vitest";
import type {
  AutomationCreateInput,
  OrchestrationCommand,
  OrchestrationProjectShell,
  OrchestrationThread,
  OrchestrationThreadShell,
  ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import { ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";

import { AutomationService } from "../../automation/Services/AutomationService.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { AgentGateway } from "../Services/AgentGateway.ts";
import { AgentGatewayCredentials } from "../Services/AgentGatewayCredentials.ts";
import { AgentGatewayLive } from "./AgentGateway.ts";

const NOW = "2026-03-01T10:00:00.000Z";
const PROJECT_ID = ProjectId.makeUnsafe("project-1");

function makeProjectShell(): OrchestrationProjectShell {
  return {
    id: PROJECT_ID,
    kind: "project",
    title: "Demo project",
    workspaceRoot: "/tmp/demo",
    defaultModelSelection: null,
    scripts: [],
    isPinned: false,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeThreadShell(
  id: string,
  overrides?: Partial<OrchestrationThreadShell>,
): OrchestrationThreadShell {
  return {
    id: ThreadId.makeUnsafe(id),
    projectId: PROJECT_ID,
    title: `Thread ${id}`,
    modelSelection: { provider: "codex", model: "gpt-5.5" },
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
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    handoff: null,
    session: null,
    ...overrides,
  };
}

function makeThreadDetail(shell: OrchestrationThreadShell): OrchestrationThread {
  return {
    ...shell,
    deletedAt: null,
    pinnedMessages: [],
    threadMarkers: [],
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
  };
}

interface GatewayHarness {
  readonly dispatched: Array<OrchestrationCommand>;
  readonly automationCreates: Array<AutomationCreateInput>;
  readonly automationUpdates: Array<{ id: string; enabled?: boolean | undefined }>;
  readonly callTool: (input: {
    readonly token: string;
    readonly name: string;
    readonly args: Record<string, unknown>;
  }) => Effect.Effect<{ status: number; result: Record<string, unknown> | undefined }>;
  readonly postRaw: (input: {
    readonly authorizationHeader: string | undefined;
    readonly body: unknown;
  }) => Effect.Effect<{ status: number; body?: unknown }>;
}

const VALID_TOKENS: Record<string, string> = {
  "token-parent": "thread-parent",
  "token-ghost": "thread-ghost",
};

function makeHarnessLayer(threads: ReadonlyArray<OrchestrationThreadShell>) {
  const dispatched: Array<OrchestrationCommand> = [];
  const automationCreates: Array<AutomationCreateInput> = [];
  const automationUpdates: Array<{ id: string; enabled?: boolean | undefined }> = [];

  const credentialsLayer = Layer.succeed(AgentGatewayCredentials, {
    mcpEndpointUrl: "http://127.0.0.1:3773/mcp",
    issueSessionToken: (threadId: ThreadIdType) => `token-for-${threadId}`,
    verifySessionToken: (token: string) => VALID_TOKENS[token] ?? null,
    connectionForThread: (threadId: ThreadIdType) => ({
      url: "http://127.0.0.1:3773/mcp",
      bearerToken: `token-for-${threadId}`,
    }),
    stdioProxy: { command: "node", args: ["/tmp/proxy.mjs"] },
  });

  const threadsById = new Map(threads.map((thread) => [thread.id as string, thread]));

  const snapshotLayer = Layer.succeed(ProjectionSnapshotQuery, {
    getShellSnapshot: () =>
      Effect.succeed({
        snapshotSequence: 1,
        projects: [makeProjectShell()],
        threads,
        updatedAt: NOW,
      }),
    getThreadShellById: (threadId: ThreadIdType) =>
      Effect.succeed(Option.fromNullishOr(threadsById.get(threadId as string))),
    getProjectShellById: (projectId: string) =>
      Effect.succeed(
        projectId === (PROJECT_ID as string)
          ? Option.some(makeProjectShell())
          : Option.none<OrchestrationProjectShell>(),
      ),
    getThreadDetailById: (threadId: ThreadIdType) =>
      Effect.succeed(
        Option.map(Option.fromNullishOr(threadsById.get(threadId as string)), makeThreadDetail),
      ),
  } as unknown as (typeof ProjectionSnapshotQuery)["Service"]);

  const engineLayer = Layer.succeed(OrchestrationEngineService, {
    dispatch: (command: OrchestrationCommand) =>
      Effect.sync(() => {
        dispatched.push(command);
        return { sequence: dispatched.length };
      }),
  } as unknown as (typeof OrchestrationEngineService)["Service"]);

  const automationLayer = Layer.succeed(AutomationService, {
    create: (input: AutomationCreateInput) =>
      Effect.sync(() => {
        automationCreates.push(input);
        return {
          ...input,
          id: "automation-1",
          enabled: true,
          nextRunAt: NOW,
          completionPolicyVersion: 0,
          completionPolicyUpdatedAt: NOW,
          iterationCount: 0,
          createdAt: NOW,
          updatedAt: NOW,
          archivedAt: null,
        };
      }),
    update: (input: { id: string; enabled?: boolean }) =>
      Effect.sync(() => {
        automationUpdates.push(input);
        return { id: input.id };
      }),
    delete: () => Effect.void,
    list: () => Effect.succeed({ definitions: [], runs: [] }),
  } as unknown as (typeof AutomationService)["Service"]);

  const gitLayer = Layer.succeed(GitCore, {
    statusDetails: () => Effect.succeed({ isRepo: true, branch: "main" }),
    createWorktree: (input: { newBranch?: string }) =>
      Effect.succeed({
        worktree: {
          path: `/tmp/worktrees/${input.newBranch ?? "generated"}`,
          branch: input.newBranch ?? "generated",
        },
      }),
  } as unknown as (typeof GitCore)["Service"]);

  const gatewayLayer = AgentGatewayLive.pipe(
    Layer.provide(credentialsLayer),
    Layer.provide(snapshotLayer),
    Layer.provide(engineLayer),
    Layer.provide(automationLayer),
    Layer.provide(gitLayer),
  );

  const makeHarness = Effect.gen(function* () {
    const gateway = yield* AgentGateway;
    const postRaw: GatewayHarness["postRaw"] = (input) => gateway.handleMcpPost(input);
    const callTool: GatewayHarness["callTool"] = ({ token, name, args }) =>
      gateway
        .handleMcpPost({
          authorizationHeader: `Bearer ${token}`,
          body: {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: args },
          },
        })
        .pipe(
          Effect.map((response) => ({
            status: response.status,
            result: (response.body as { result?: Record<string, unknown> } | undefined)?.result,
          })),
        );
    return {
      dispatched,
      automationCreates,
      automationUpdates,
      callTool,
      postRaw,
    } satisfies GatewayHarness;
  });

  return { gatewayLayer, makeHarness };
}

function toolResultJson(result: Record<string, unknown> | undefined): Record<string, unknown> {
  const content = (result?.content as Array<{ text: string }> | undefined) ?? [];
  return JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown>;
}

function isToolError(result: Record<string, unknown> | undefined): boolean {
  return result?.isError === true;
}

function toolErrorText(result: Record<string, unknown> | undefined): string {
  const content = (result?.content as Array<{ text: string }> | undefined) ?? [];
  return content[0]?.text ?? "";
}

describe("AgentGateway", () => {
  const baseThreads = [
    makeThreadShell("thread-parent"),
    makeThreadShell("thread-child", { parentThreadId: ThreadId.makeUnsafe("thread-parent") }),
    makeThreadShell("thread-archived", { archivedAt: NOW }),
  ];

  it.effect("rejects requests without a valid bearer token", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const missing = yield* harness.postRaw({
        authorizationHeader: undefined,
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      assert.equal(missing.status, 401);
      const invalid = yield* harness.postRaw({
        authorizationHeader: "Bearer nope",
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      assert.equal(invalid.status, 401);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("answers initialize with instructions and lists tools", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const init = yield* harness.postRaw({
        authorizationHeader: "Bearer token-parent",
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18" },
        },
      });
      assert.equal(init.status, 200);
      const initResult = (init.body as { result: Record<string, unknown> }).result;
      assert.equal(initResult.protocolVersion, "2025-06-18");
      assert.isString(initResult.instructions);

      const list = yield* harness.postRaw({
        authorizationHeader: "Bearer token-parent",
        body: { jsonrpc: "2.0", id: 2, method: "tools/list" },
      });
      const tools = (list.body as { result: { tools: Array<{ name: string }> } }).result.tools;
      const names = tools.map((tool) => tool.name);
      assert.includeMembers(names, [
        "synara_list_projects",
        "synara_list_threads",
        "synara_read_thread",
        "synara_create_thread",
        "synara_send_message",
        "synara_interrupt_thread",
        "synara_set_thread_title",
        "synara_set_thread_archived",
        "synara_create_automation",
        "synara_list_automations",
        "synara_cancel_automation",
      ]);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("acknowledges notifications without a body", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.postRaw({
        authorizationHeader: "Bearer token-parent",
        body: { jsonrpc: "2.0", method: "notifications/initialized" },
      });
      assert.equal(response.status, 202);
      assert.isUndefined(response.body);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("lists threads hiding archived ones and marking the caller", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_list_threads",
        args: {},
      });
      const payload = toolResultJson(response.result);
      const threads = payload.threads as Array<Record<string, unknown>>;
      assert.equal(threads.length, 2);
      assert.isUndefined(threads.find((thread) => thread.threadId === "thread-archived"));
      const self = threads.find((thread) => thread.threadId === "thread-parent");
      assert.equal(self?.isSelf, true);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("reports the full matching count when the limit truncates the thread list", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_list_threads",
        args: { limit: 1 },
      });
      const payload = toolResultJson(response.result);
      const threads = payload.threads as Array<Record<string, unknown>>;
      assert.equal(threads.length, 1);
      assert.equal(payload.totalMatching, 2);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("creates a standalone cross-provider thread and dispatches the initial turn", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_thread",
        args: { prompt: "analyze the feature", provider: "grok" },
      });
      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      const payload = toolResultJson(response.result);
      assert.equal(payload.provider, "grok");
      assert.strictEqual("parentThreadId" in payload, false);

      assert.equal(harness.dispatched.length, 2);
      const create = harness.dispatched[0]!;
      assert.equal(create.type, "thread.create");
      if (create.type === "thread.create") {
        // Gateway-created threads are ordinary top-level threads, not subagents.
        assert.strictEqual("parentThreadId" in create, false);
        assert.strictEqual("subagentNickname" in create, false);
        assert.equal(create.modelSelection.provider, "grok");
        // Project and runtime mode default from the calling thread.
        assert.equal(create.projectId, PROJECT_ID);
        assert.equal(create.runtimeMode, "approval-required");
        // Same placeholder title flow as UI threads so the first-turn reactor
        // replaces it with a model-generated title.
        assert.equal(create.title, "analyze the feature");
      }
      const turn = harness.dispatched[1]!;
      assert.equal(turn.type, "thread.turn.start");
      if (turn.type === "thread.turn.start") {
        assert.equal(turn.dispatchOrigin, "agent");
        assert.equal(turn.message.text, "analyze the feature");
      }
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("creates an isolated worktree when environment=worktree", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_thread",
        args: {
          prompt: "refactor module X",
          provider: "claudeAgent",
          environment: "worktree",
          branchName: "agent/refactor-x",
        },
      });
      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      const payload = toolResultJson(response.result);
      assert.equal(payload.branch, "agent/refactor-x");
      assert.equal(payload.worktreePath, "/tmp/worktrees/agent/refactor-x");
      const create = harness.dispatched[0]!;
      if (create.type === "thread.create") {
        assert.equal(create.envMode, "worktree");
        assert.equal(create.branch, "agent/refactor-x");
      }
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("creates an unlimited number of threads regardless of prior spawns", () => {
    // Gateway-created threads are standalone, so no depth or max-children
    // guard applies: spawning must keep working even when many threads exist.
    const crowded = [
      makeThreadShell("thread-parent"),
      ...Array.from({ length: 12 }, (_, index) => makeThreadShell(`thread-other-${index}`)),
    ];
    const { gatewayLayer, makeHarness } = makeHarnessLayer(crowded);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_thread",
        args: { prompt: "one more", provider: "codex" },
      });
      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      assert.equal(harness.dispatched.length, 2);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("sends a follow-up message with the agent dispatch origin", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer([
      ...baseThreads.filter((thread) => thread.id !== "thread-child"),
      makeThreadShell("thread-child", {
        parentThreadId: ThreadId.makeUnsafe("thread-parent"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-child"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: TurnId.makeUnsafe("turn-live"),
          lastError: null,
          updatedAt: NOW,
        },
      }),
    ]);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_send_message",
        args: { threadId: "thread-child", message: "status check please", mode: "steer" },
      });
      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      const turn = harness.dispatched[0]!;
      assert.equal(turn.type, "thread.turn.start");
      if (turn.type === "thread.turn.start") {
        assert.equal(turn.dispatchOrigin, "agent");
        assert.equal(turn.dispatchMode, "steer");
        assert.equal(turn.threadId, "thread-child");
      }
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("passes an idle steer through so the reactor's live-state guard decides", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_send_message",
        args: { threadId: "thread-child", message: "status check please", mode: "steer" },
      });
      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      // The projection snapshot can lag the runtime in both directions, so
      // the gateway must not downgrade; the reactor rechecks live state.
      assert.equal(toolResultJson(response.result).dispatched, "steer");
      const turn = harness.dispatched[0]!;
      assert.equal(turn.type, "thread.turn.start");
      if (turn.type === "thread.turn.start") {
        assert.equal(turn.dispatchMode, "steer");
      }
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("rejects sends that would drive a higher-privileged thread", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer([
      ...baseThreads,
      makeThreadShell("thread-full-access", { runtimeMode: "full-access" }),
    ]);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_send_message",
        args: { threadId: "thread-full-access", message: "run something dangerous" },
      });
      assert.isTrue(isToolError(response.result));
      assert.include(toolErrorText(response.result), "full-access");
      assert.equal(harness.dispatched.length, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("rejects heartbeats that would target a higher-privileged thread", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer([
      ...baseThreads,
      makeThreadShell("thread-full-access", { runtimeMode: "full-access" }),
    ]);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_automation",
        args: {
          name: "escalate",
          prompt: "keep running privileged work",
          targetThreadId: "thread-full-access",
        },
      });
      assert.isTrue(isToolError(response.result));
      assert.include(toolErrorText(response.result), "full-access");
      assert.equal(harness.automationCreates.length, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("rejects sends from worktree-isolated callers to local-checkout threads", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer([
      makeThreadShell("thread-parent", {
        envMode: "worktree",
        worktreePath: "/tmp/worktrees/caller",
        branch: "agent/caller",
      }),
      makeThreadShell("thread-local"),
    ]);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_send_message",
        args: { threadId: "thread-local", message: "edit the main checkout" },
      });
      assert.isTrue(isToolError(response.result));
      assert.include(toolErrorText(response.result), "local");
      assert.equal(harness.dispatched.length, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("rejects tokens whose caller thread no longer exists", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.postRaw({
        authorizationHeader: "Bearer token-ghost",
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      assert.equal(response.status, 401);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("keeps worktree-isolated callers from spawning local workers", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer([
      makeThreadShell("thread-parent", {
        envMode: "worktree",
        worktreePath: "/tmp/worktrees/caller",
        branch: "agent/caller",
      }),
    ]);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;

      const rejected = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_thread",
        args: { prompt: "touch the main checkout", provider: "codex", environment: "local" },
      });
      assert.isTrue(isToolError(rejected.result));
      assert.include(toolErrorText(rejected.result), "isolated worktree");
      assert.equal(harness.dispatched.length, 0);

      // Omitting environment defaults to an isolated worktree, not local.
      const defaulted = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_thread",
        args: { prompt: "do isolated work", provider: "codex" },
      });
      assert.isFalse(isToolError(defaulted.result), toolErrorText(defaulted.result));
      assert.equal(toolResultJson(defaulted.result).environment, "worktree");
      const create = harness.dispatched[0]!;
      assert.equal(create.type, "thread.create");
      if (create.type === "thread.create") {
        assert.equal(create.envMode, "worktree");
      }
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("rejects runtime-mode escalation beyond the calling thread", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_thread",
        args: { prompt: "escalate please", provider: "codex", runtimeMode: "full-access" },
      });
      assert.isTrue(isToolError(response.result));
      assert.include(toolErrorText(response.result), "approval-required");
      assert.equal(harness.dispatched.length, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("creates a heartbeat automation on the caller thread by default", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_automation",
        args: { name: "monitor children", prompt: "check the child threads", everyMinutes: 5 },
      });
      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      assert.equal(harness.automationCreates.length, 1);
      const created = harness.automationCreates[0]!;
      assert.equal(created.mode, "heartbeat");
      assert.equal(created.targetThreadId, "thread-parent");
      assert.deepEqual(created.schedule, { type: "interval", everySeconds: 300 });
      assert.equal(created.maxIterations, 50);
      // Local-checkout targets must carry the matching environment + risk
      // acknowledgement so AutomationService policy checks stay enforced.
      assert.equal(created.worktreeMode, "local");
      assert.deepEqual(created.acknowledgedRisks, ["local-checkout"]);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("disables an automation on cancel", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_cancel_automation",
        args: { automationId: "automation-1" },
      });
      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      assert.deepEqual(harness.automationUpdates, [{ id: "automation-1", enabled: false }]);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("archives and renames threads through meta commands", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* harness.callTool({
        token: "token-parent",
        name: "synara_set_thread_title",
        args: { threadId: "thread-child", title: "Renamed worker" },
      });
      yield* harness.callTool({
        token: "token-parent",
        name: "synara_set_thread_archived",
        args: { threadId: "thread-child", archived: true },
      });
      assert.equal(harness.dispatched[0]?.type, "thread.meta.update");
      assert.equal(harness.dispatched[1]?.type, "thread.archive");
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("reports unknown tools as invalid params", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.postRaw({
        authorizationHeader: "Bearer token-parent",
        body: {
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: { name: "synara_unknown" },
        },
      });
      const error = (response.body as { error?: { code: number } }).error;
      assert.equal(error?.code, -32602);
    }).pipe(Effect.provide(gatewayLayer));
  });
});
