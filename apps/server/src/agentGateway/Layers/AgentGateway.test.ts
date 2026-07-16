import { assert, describe, it } from "@effect/vitest";
import type {
  AutomationCreateInput,
  AutomationDefinition,
  OrchestrationCommand,
  OrchestrationProjectShell,
  OrchestrationThread,
  OrchestrationThreadShell,
  ProviderKind,
  ServerProviderStatus,
  ThreadId as ThreadIdType,
} from "@synara/contracts";
import { AutomationId, MessageId, ProjectId, ThreadId, TurnId } from "@synara/contracts";
import { Effect, Fiber, Layer, Option, Stream } from "effect";
import { TestClock } from "effect/testing";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { AutomationService } from "../../automation/Services/AutomationService.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProviderDiscoveryService } from "../../provider/Services/ProviderDiscoveryService.ts";
import { ProviderHealth } from "../../provider/Services/ProviderHealth.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { AgentGateway } from "../Services/AgentGateway.ts";
import { AgentGatewayCredentials } from "../Services/AgentGatewayCredentials.ts";
import {
  AgentGatewayOperationRepository,
  type AgentGatewayOperationRecord,
} from "../Services/AgentGatewayOperationRepository.ts";
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
    latestTurn:
      id === "thread-parent"
        ? {
            turnId: TurnId.makeUnsafe("turn-parent-active"),
            state: "running",
            requestedAt: NOW,
            startedAt: NOW,
            completedAt: null,
            assistantMessageId: null,
          }
        : null,
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
  readonly automationDeletes: Array<{ id: string }>;
  readonly worktreeCreates: Array<{ newBranch?: string }>;
  readonly worktreeRemoves: Array<{ path: string }>;
  readonly branchDeletes: Array<{ branch: string }>;
  readonly setThreadDetail: (thread: OrchestrationThread) => void;
  readonly setProjectionTurn: (input: {
    readonly threadId: string;
    readonly turnId: string;
    readonly state: "pending" | "running" | "completed" | "error" | "interrupted";
    readonly assistantMessageId?: string | null;
  }) => void;
  readonly setProviderStatuses: (statuses: ReadonlyArray<ServerProviderStatus>) => void;
  readonly getOperationStatus: (callerTurnId: string) => string | null;
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

function makeAutomationDefinition(
  overrides: Partial<AutomationDefinition> = {},
): AutomationDefinition {
  return {
    id: AutomationId.makeUnsafe("automation-1"),
    projectId: PROJECT_ID,
    sourceThreadId: ThreadId.makeUnsafe("thread-parent"),
    name: "Monitor children",
    prompt: "check children",
    schedule: { type: "interval", everySeconds: 300 },
    enabled: true,
    nextRunAt: NOW,
    modelSelection: { provider: "codex", model: "gpt-5.5" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    worktreeMode: "local",
    mode: "heartbeat",
    targetThreadId: ThreadId.makeUnsafe("thread-parent"),
    maxIterations: 50,
    stopOnError: true,
    completionPolicyVersion: 0,
    completionPolicyUpdatedAt: NOW,
    minimumIntervalSeconds: 60,
    maxRuntimeSeconds: 3600,
    retryPolicy: { type: "none" },
    misfirePolicy: "coalesce",
    acknowledgedRisks: ["local-checkout"],
    iterationCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    ...overrides,
  };
}

const VALID_TOKENS: Record<string, string> = {
  "token-parent": "thread-parent",
  "token-parent-claude": "thread-parent",
  "token-parent-readonly": "thread-parent",
  "token-ghost": "thread-ghost",
};

function makeHarnessLayer(
  threads: ReadonlyArray<OrchestrationThreadShell>,
  automationDefinitions: ReadonlyArray<AutomationDefinition> = [],
  options: {
    readonly threadDetails?: ReadonlyMap<string, OrchestrationThread>;
    readonly failDispatch?: (command: OrchestrationCommand) => boolean;
    readonly dispatchDelayMs?: number;
    readonly interruptedOperations?: ReadonlyArray<AgentGatewayOperationRecord>;
    readonly providerStatuses?: ReadonlyArray<ServerProviderStatus>;
    readonly existingBranches?: ReadonlyArray<string>;
    readonly failDeleteBranch?: boolean;
  } = {},
) {
  const dispatched: Array<OrchestrationCommand> = [];
  const automationCreates: Array<AutomationCreateInput> = [];
  const automationUpdates: Array<{ id: string; enabled?: boolean | undefined }> = [];
  const automationDeletes: Array<{ id: string }> = [];
  const worktreeCreates: Array<{ newBranch?: string }> = [];
  const worktreeRemoves: Array<{ path: string }> = [];
  const branchDeletes: Array<{ branch: string }> = [];

  const credentialsLayer = Layer.succeed(AgentGatewayCredentials, {
    mcpEndpointUrl: "http://127.0.0.1:3773/mcp",
    issueSessionToken: (threadId: ThreadIdType) => `token-for-${threadId}`,
    verifySessionToken: (token: string) => VALID_TOKENS[token] ?? null,
    verifySession: (token: string) => {
      const threadId = VALID_TOKENS[token];
      return threadId
        ? {
            sessionKey: `session-for-${threadId}`,
            threadId: ThreadId.makeUnsafe(threadId),
            provider:
              token === "token-parent-claude" ? ("claudeAgent" as const) : ("codex" as const),
            issuedAt: 0,
            expiresAt: Number.MAX_SAFE_INTEGER,
            capabilities:
              token === "token-parent-readonly"
                ? new Set(["thread:read"] as const)
                : new Set(["thread:read", "thread:write", "automation:write"] as const),
          }
        : null;
    },
    revokeSessionToken: () => undefined,
    connectionForThread: (threadId: ThreadIdType) => ({
      url: "http://127.0.0.1:3773/mcp",
      bearerToken: `token-for-${threadId}`,
    }),
    stdioProxy: { command: "node", args: ["/tmp/proxy.mjs"] },
  });

  const threadsById = new Map(threads.map((thread) => [thread.id as string, thread]));
  const threadDetailsById = new Map(options.threadDetails ?? []);
  const projectionTurnsByKey = new Map<
    string,
    {
      readonly threadId: string;
      readonly turnId: string;
      readonly state: "pending" | "running" | "completed" | "error" | "interrupted";
      readonly assistantMessageId: string | null;
    }
  >();

  const snapshotLayer = Layer.succeed(ProjectionSnapshotQuery, {
    getShellSnapshot: () =>
      Effect.succeed({
        snapshotSequence: 1,
        projects: [makeProjectShell()],
        threads: [...threadsById.values()],
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
        Option.fromNullishOr(
          threadDetailsById.get(threadId as string) ??
            Option.getOrUndefined(
              Option.map(
                Option.fromNullishOr(threadsById.get(threadId as string)),
                makeThreadDetail,
              ),
            ),
        ),
      ),
  } as unknown as (typeof ProjectionSnapshotQuery)["Service"]);

  const engineLayer = Layer.succeed(OrchestrationEngineService, {
    dispatch: (command: OrchestrationCommand) =>
      Effect.sleep(options.dispatchDelayMs ?? 0).pipe(
        Effect.flatMap(() =>
          Effect.suspend(() => {
            dispatched.push(command);
            return options.failDispatch?.(command)
              ? Effect.fail(new Error("injected dispatch failure"))
              : Effect.succeed({ sequence: dispatched.length });
          }),
        ),
      ),
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
    delete: (input: { id: string }) =>
      Effect.sync(() => {
        automationDeletes.push(input);
      }),
    list: (input?: { projectId?: string; includeArchived?: boolean }) =>
      Effect.succeed({
        definitions: automationDefinitions
          .filter((definition) =>
            input?.projectId ? definition.projectId === input.projectId : true,
          )
          .filter((definition) => (input?.includeArchived ? true : definition.archivedAt === null)),
        runs: [],
      }),
  } as unknown as (typeof AutomationService)["Service"]);

  const gitLayer = Layer.succeed(GitCore, {
    statusDetails: () => Effect.succeed({ isRepo: true, branch: "main" }),
    listBranches: () =>
      Effect.succeed({
        isRepo: true,
        hasOriginRemote: false,
        branches: (options.existingBranches ?? []).map((name) => ({
          name,
          current: false,
          isDefault: false,
          worktreePath: null,
        })),
      }),
    createWorktree: (input: { newBranch?: string }) =>
      Effect.sync(() => {
        worktreeCreates.push(input);
        return {
          worktree: {
            path: `/tmp/worktrees/${input.newBranch ?? "generated"}`,
            branch: input.newBranch ?? "generated",
          },
        };
      }),
    removeWorktree: (input: { path: string }) =>
      Effect.sync(() => {
        worktreeRemoves.push(input);
      }),
    deleteBranch: (input: { branch: string }) =>
      Effect.sync(() => {
        branchDeletes.push(input);
      }).pipe(
        Effect.flatMap(() =>
          options.failDeleteBranch
            ? Effect.fail(new Error("injected branch deletion failure"))
            : Effect.void,
        ),
      ),
  } as unknown as (typeof GitCore)["Service"]);

  const providerDiscoveryLayer = Layer.succeed(ProviderDiscoveryService, {
    listModels: ({ provider }: { provider: string }) => {
      const modelsByProvider: Record<string, ReadonlyArray<Record<string, unknown>>> = {
        codex: [
          { slug: "gpt-5.5", name: "GPT-5.5" },
          {
            slug: "gpt-5.6-terra",
            name: "GPT-5.6 Terra",
            supportedReasoningEfforts: [
              { value: "low", label: "Low" },
              { value: "high", label: "High" },
            ],
          },
        ],
        claudeAgent: [{ slug: "claude-sonnet-5", name: "Claude Sonnet 5" }],
        cursor: [{ slug: "auto", name: "Auto" }],
        gemini: [{ slug: "auto-gemini-3", name: "Auto Gemini 3" }],
        grok: [{ slug: "grok-build", name: "Grok Build" }],
        droid: [{ slug: "claude-opus-4-8", name: "Claude Opus 4.8" }],
        kilo: [{ slug: "kilo/kilo-auto/free", name: "Kilo Auto" }],
        opencode: [{ slug: "openai/gpt-5", name: "OpenAI GPT-5" }],
        pi: [{ slug: "test-pi", name: "Test Pi" }],
      };
      return Effect.succeed({ models: modelsByProvider[provider] ?? [], source: "test" });
    },
  } as unknown as (typeof ProviderDiscoveryService)["Service"]);

  const providerKinds: ReadonlyArray<ProviderKind> = [
    "codex",
    "claudeAgent",
    "cursor",
    "gemini",
    "grok",
    "droid",
    "kilo",
    "opencode",
    "pi",
  ];
  let providerStatuses =
    options.providerStatuses ??
    providerKinds.map(
      (provider): ServerProviderStatus => ({
        provider,
        status: "ready",
        available: true,
        authStatus: "authenticated",
        checkedAt: NOW,
      }),
    );
  const providerHealthLayer = Layer.succeed(ProviderHealth, {
    getStatuses: Effect.sync(() => providerStatuses),
    refresh: Effect.sync(() => providerStatuses),
    updateProvider: () => Effect.die("Provider updates are not used by gateway tests."),
    streamChanges: Stream.empty,
  } as unknown as (typeof ProviderHealth)["Service"]);

  const operationsByScope = new Map<string, AgentGatewayOperationRecord>();
  for (const operation of options.interruptedOperations ?? []) {
    operationsByScope.set(
      `${operation.callerThreadId}:${operation.callerTurnId}:${operation.operationKind}`,
      operation,
    );
  }
  const operationLayer = Layer.succeed(AgentGatewayOperationRepository, {
    reserve: (input: {
      operationId: string;
      callerThreadId: string;
      callerTurnId: string;
      operationKind: "create_threads";
      requestId: string;
      fingerprint: string;
      requestedCount: number;
      planJson: string;
      now: string;
    }) =>
      Effect.sync(() => {
        const key = `${input.callerThreadId}:${input.callerTurnId}:${input.operationKind}`;
        const existing = operationsByScope.get(key);
        if (existing) {
          const kind =
            existing.requestId !== input.requestId
              ? "creation_plan_locked"
              : existing.fingerprint !== input.fingerprint
                ? "idempotency_conflict"
                : "replay";
          return { kind, operation: existing };
        }
        const operation: AgentGatewayOperationRecord = {
          ...input,
          status: "reserved",
          resultJson: null,
          errorJson: null,
          createdAt: input.now,
          updatedAt: input.now,
        };
        operationsByScope.set(key, operation);
        return { kind: "reserved" as const, operation };
      }),
    markDispatching: ({ operationId, now }: { operationId: string; now: string }) =>
      Effect.sync(() => {
        for (const [key, operation] of operationsByScope) {
          if (operation.operationId !== operationId || operation.status !== "reserved") continue;
          operationsByScope.set(key, { ...operation, status: "dispatching", updatedAt: now });
          return true;
        }
        return false;
      }),
    markCompensating: ({ operationId, now }: { operationId: string; now: string }) =>
      Effect.sync(() => {
        for (const [key, operation] of operationsByScope) {
          if (operation.operationId === operationId) {
            operationsByScope.set(key, {
              ...operation,
              status: "compensating",
              updatedAt: now,
            });
          }
        }
      }),
    complete: ({
      operationId,
      resultJson,
      now,
    }: {
      operationId: string;
      resultJson: string;
      now: string;
    }) =>
      Effect.sync(() => {
        for (const [key, operation] of operationsByScope) {
          if (operation.operationId === operationId) {
            operationsByScope.set(key, {
              ...operation,
              status: "completed",
              resultJson,
              updatedAt: now,
            });
          }
        }
      }),
    fail: ({
      operationId,
      errorJson,
      now,
    }: {
      operationId: string;
      errorJson: string;
      now: string;
    }) =>
      Effect.sync(() => {
        for (const [key, operation] of operationsByScope) {
          if (operation.operationId === operationId) {
            operationsByScope.set(key, {
              ...operation,
              status: "failed",
              errorJson,
              updatedAt: now,
            });
          }
        }
      }),
    getById: (operationId: string) =>
      Effect.sync(
        () =>
          [...operationsByScope.values()].find(
            (operation) => operation.operationId === operationId,
          ) ?? null,
      ),
    getByScope: (input: {
      callerThreadId: string;
      callerTurnId: string;
      operationKind: "create_threads";
    }) =>
      Effect.sync(
        () =>
          operationsByScope.get(
            `${input.callerThreadId}:${input.callerTurnId}:${input.operationKind}`,
          ) ?? null,
      ),
    listNonTerminal: () =>
      Effect.sync(() =>
        [...operationsByScope.values()].filter(
          (operation) =>
            operation.status === "reserved" ||
            operation.status === "dispatching" ||
            operation.status === "compensating",
        ),
      ),
  });

  const projectionTurnsLayer = Layer.succeed(ProjectionTurnRepository, {
    getByTurnId: ({ threadId, turnId }: { threadId: string; turnId: string }) => {
      const pinned = projectionTurnsByKey.get(`${threadId}:${turnId}`);
      if (pinned) {
        return Effect.succeed(
          Option.some({
            threadId: ThreadId.makeUnsafe(pinned.threadId),
            turnId: TurnId.makeUnsafe(pinned.turnId),
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId:
              pinned.assistantMessageId === null
                ? null
                : MessageId.makeUnsafe(pinned.assistantMessageId),
            state: pinned.state,
            requestedAt: NOW,
            startedAt: pinned.state === "pending" ? null : NOW,
            completedAt:
              pinned.state === "completed" ||
              pinned.state === "error" ||
              pinned.state === "interrupted"
                ? NOW
                : null,
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
          }),
        );
      }
      const thread = threadsById.get(threadId);
      const turn = thread?.latestTurn;
      return Effect.succeed(
        turn?.turnId === turnId
          ? Option.some({
              threadId: ThreadId.makeUnsafe(threadId),
              turnId: TurnId.makeUnsafe(turnId),
              pendingMessageId: null,
              sourceProposedPlanThreadId: null,
              sourceProposedPlanId: null,
              assistantMessageId: turn.assistantMessageId,
              state: turn.state,
              requestedAt: turn.requestedAt,
              startedAt: turn.startedAt,
              completedAt: turn.completedAt,
              checkpointTurnCount: null,
              checkpointRef: null,
              checkpointStatus: null,
              checkpointFiles: [],
            })
          : Option.none(),
      );
    },
  } as unknown as (typeof ProjectionTurnRepository)["Service"]);

  const gatewayLayer = AgentGatewayLive.pipe(
    Layer.provide(credentialsLayer),
    Layer.provide(snapshotLayer),
    Layer.provide(engineLayer),
    Layer.provide(automationLayer),
    Layer.provide(gitLayer),
    Layer.provide(providerDiscoveryLayer),
    Layer.provide(providerHealthLayer),
    Layer.provide(ServerSettingsService.layerTest()),
    Layer.provide(operationLayer),
    Layer.provide(projectionTurnsLayer),
    Layer.provide(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provide(NodeServices.layer),
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
      automationDeletes,
      worktreeCreates,
      worktreeRemoves,
      branchDeletes,
      setThreadDetail: (thread) => {
        threadsById.set(thread.id, thread);
        threadDetailsById.set(thread.id, thread);
      },
      setProjectionTurn: (input) => {
        projectionTurnsByKey.set(`${input.threadId}:${input.turnId}`, {
          threadId: input.threadId,
          turnId: input.turnId,
          state: input.state,
          assistantMessageId: input.assistantMessageId ?? null,
        });
      },
      setProviderStatuses: (statuses) => {
        providerStatuses = statuses;
      },
      getOperationStatus: (callerTurnId) =>
        [...operationsByScope.values()].find((operation) => operation.callerTurnId === callerTurnId)
          ?.status ?? null,
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

  it.effect("rejects a provider-scoped token that no longer owns the thread", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.postRaw({
        authorizationHeader: "Bearer token-parent-claude",
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      assert.equal(response.status, 401);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("enforces provider-session capabilities before destructive dispatch", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent-readonly",
        name: "synara_create_threads",
        args: {
          requestId: "readonly-create",
          threads: [
            {
              prompt: "should not run",
              target: { provider: "codex", model: "gpt-5.5" },
            },
          ],
        },
      });
      assert.equal(
        (toolResultJson(response.result).error as { code: string }).code,
        "capability_denied",
      );
      assert.equal(harness.dispatched.length, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("rejects oversized and duplicate-id JSON-RPC batches before dispatch", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const request = (id: number, requestId: string) => ({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name: "synara_create_threads",
          arguments: {
            requestId,
            threads: [
              {
                prompt: requestId,
                target: { provider: "codex", model: "gpt-5.5" },
              },
            ],
          },
        },
      });

      const duplicate = yield* harness.postRaw({
        authorizationHeader: "Bearer token-parent",
        body: [request(7, "duplicate-a"), request(7, "duplicate-b")],
      });
      assert.equal(duplicate.status, 400);
      assert.include(JSON.stringify(duplicate.body), "Duplicate JSON-RPC request id");

      const oversized = yield* harness.postRaw({
        authorizationHeader: "Bearer token-parent",
        body: Array.from({ length: 51 }, (_, index) => request(index, `oversized-${index}`)),
      });
      assert.equal(oversized.status, 400);
      assert.include(JSON.stringify(oversized.body), "at most 50");
      assert.equal(harness.dispatched.length, 0);
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
        "synara_context",
        "synara_capabilities",
        "synara_list_projects",
        "synara_list_threads",
        "synara_read_thread",
        "synara_wait_for_threads",
        "synara_create_threads",
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
        args: { requestId: "create-grok", prompt: "analyze the feature", provider: "grok" },
      });
      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      const payload = toolResultJson(response.result);
      assert.equal(payload.provider, "grok");
      assert.strictEqual("parentThreadId" in payload, false);

      assert.equal(harness.dispatched.length, 3);
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
          requestId: "create-worktree",
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

  it.effect("allows one exact plan in a new active turn even when unrelated threads exist", () => {
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
        args: { requestId: "create-crowded", prompt: "one more", provider: "codex" },
      });
      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      assert.equal(harness.dispatched.length, 3);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("compensates deterministic interrupted operations during gateway startup", () => {
    const interrupted: AgentGatewayOperationRecord = {
      operationId: "gateway:create:restart",
      callerThreadId: "thread-parent",
      callerTurnId: "turn-parent-active",
      operationKind: "create_threads",
      requestId: "restart-request",
      fingerprint: "restart-fingerprint",
      requestedCount: 1,
      planJson: JSON.stringify([
        {
          workspaceRoot: "/tmp/demo",
          environment: "local",
          newBranch: null,
          plannedWorktreePath: null,
          ownershipPreflightPassed: true,
          ids: {
            threadId: "agent:restart-child",
            compensateCommandId: "agent:restart-child:compensate-delete",
          },
        },
      ]),
      status: "dispatching",
      resultJson: null,
      errorJson: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const { gatewayLayer, makeHarness } = makeHarnessLayer(
      [
        ...baseThreads,
        makeThreadShell("agent:restart-child", {
          creationSource: "synara_mcp",
          sourceThreadId: ThreadId.makeUnsafe("thread-parent"),
          sourceTurnId: TurnId.makeUnsafe("turn-parent-active"),
          gatewayOperationId: "gateway:create:restart",
          gatewayOperationIndex: 0,
        }),
      ],
      [],
      { interruptedOperations: [interrupted] },
    );
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      assert.deepEqual(
        harness.dispatched.filter((command) => command.type === "thread.delete"),
        [
          {
            type: "thread.delete",
            commandId: "agent:restart-child:compensate-delete",
            threadId: "agent:restart-child",
          },
        ],
      );
      assert.equal(
        harness.dispatched.filter((command) => command.type === "thread.create").length,
        0,
      );
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("does not compensate a reserved operation that never began dispatch", () => {
    const reserved: AgentGatewayOperationRecord = {
      operationId: "gateway:create:reserved",
      callerThreadId: "thread-parent",
      callerTurnId: "turn-parent-active",
      operationKind: "create_threads",
      requestId: "reserved-request",
      fingerprint: "reserved-fingerprint",
      requestedCount: 1,
      planJson: JSON.stringify([
        {
          workspaceRoot: "/tmp/demo",
          environment: "worktree",
          newBranch: "user/pre-existing",
          plannedWorktreePath: "/tmp/user-pre-existing",
          ownershipPreflightPassed: false,
          ids: {
            threadId: "agent:reserved-child",
            compensateCommandId: "agent:reserved-child:compensate-delete",
          },
        },
      ]),
      status: "reserved",
      resultJson: null,
      errorJson: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, [], {
      interruptedOperations: [reserved],
    });
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      assert.equal(harness.dispatched.length, 0);
      assert.deepEqual(harness.worktreeRemoves, []);
      assert.deepEqual(harness.branchDeletes, []);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("keeps startup recovery compensating when an owned branch cannot be deleted", () => {
    const interrupted: AgentGatewayOperationRecord = {
      operationId: "gateway:create:branch-cleanup",
      callerThreadId: "thread-parent",
      callerTurnId: "turn-parent-active",
      operationKind: "create_threads",
      requestId: "branch-cleanup-request",
      fingerprint: "branch-cleanup-fingerprint",
      requestedCount: 1,
      planJson: JSON.stringify([
        {
          workspaceRoot: "/tmp/demo",
          environment: "worktree",
          newBranch: "agent/owned-branch",
          plannedWorktreePath: "/tmp/missing-owned-worktree",
          ownershipPreflightPassed: true,
          ids: {
            threadId: "agent:branch-cleanup-child",
            compensateCommandId: "agent:branch-cleanup-child:compensate-delete",
          },
        },
      ]),
      status: "dispatching",
      resultJson: null,
      errorJson: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, [], {
      interruptedOperations: [interrupted],
      existingBranches: ["agent/owned-branch"],
      failDeleteBranch: true,
    });
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      assert.equal(harness.branchDeletes.length, 1);
      assert.equal(harness.branchDeletes[0]?.branch, "agent/owned-branch");
      assert.equal(harness.getOperationStatus("turn-parent-active"), "compensating");
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("rejects a pre-existing worktree branch before reservation or cleanup", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, [], {
      existingBranches: ["agent/user-owned"],
    });
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_threads",
        args: {
          requestId: "pre-existing-branch",
          threads: [
            {
              prompt: "must not reuse it",
              target: { provider: "codex", model: "gpt-5.5" },
              environment: "worktree",
              branchName: "agent/user-owned",
            },
          ],
        },
      });
      assert.isTrue(isToolError(response.result));
      assert.include(toolErrorText(response.result), "already exists");
      assert.equal(harness.dispatched.length, 0);
      assert.equal(harness.worktreeCreates.length, 0);
      assert.equal(harness.worktreeRemoves.length, 0);
      assert.equal(harness.branchDeletes.length, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("rejects detached creation after the caller turn completed", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer([
      makeThreadShell("thread-parent", {
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-parent-complete"),
          state: "completed",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: NOW,
          assistantMessageId: null,
        },
      }),
    ]);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_threads",
        args: {
          requestId: "detached-attempt",
          threads: [
            {
              prompt: "create too late",
              target: { provider: "codex", model: "gpt-5.5" },
            },
          ],
        },
      });
      assert.isTrue(isToolError(response.result));
      assert.equal(
        (toolResultJson(response.result).error as { code: string }).code,
        "caller_turn_inactive",
      );
      assert.equal(harness.dispatched.length, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("rejects every destructive tool after the caller turn completes", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer([
      makeThreadShell("thread-parent", {
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-parent-complete"),
          state: "completed",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: NOW,
          assistantMessageId: null,
        },
      }),
      makeThreadShell("thread-child"),
    ]);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const attempts = [
        {
          name: "synara_create_threads",
          args: {
            requestId: "late-batch",
            threads: [{ prompt: "late", target: { provider: "codex", model: "gpt-5.5" } }],
          },
        },
        {
          name: "synara_create_thread",
          args: { requestId: "late-single", prompt: "late", provider: "codex" },
        },
        {
          name: "synara_send_message",
          args: { threadId: "thread-child", message: "late" },
        },
        { name: "synara_interrupt_thread", args: { threadId: "thread-child" } },
        {
          name: "synara_set_thread_title",
          args: { threadId: "thread-child", title: "Late rename" },
        },
        {
          name: "synara_set_thread_archived",
          args: { threadId: "thread-child", archived: true },
        },
        {
          name: "synara_create_automation",
          args: { name: "late monitor", prompt: "late" },
        },
        {
          name: "synara_cancel_automation",
          args: { automationId: "automation-1" },
        },
      ];

      for (const attempt of attempts) {
        const response = yield* harness.callTool({ token: "token-parent", ...attempt });
        assert.equal(
          (toolResultJson(response.result).error as { code: string }).code,
          "caller_turn_inactive",
          attempt.name,
        );
      }
      assert.equal(harness.dispatched.length, 0);
      assert.deepEqual(harness.automationCreates, []);
      assert.deepEqual(harness.automationUpdates, []);
      assert.deepEqual(harness.automationDeletes, []);

      const read = yield* harness.callTool({
        token: "token-parent",
        name: "synara_list_threads",
        args: {},
      });
      assert.isFalse(isToolError(read.result), toolErrorText(read.result));
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("replays an identical exact batch without creating more threads", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const args = {
        requestId: "two-workers",
        threads: [
          { prompt: "worker one", target: { provider: "codex", model: "gpt-5.5" } },
          {
            prompt: "worker two",
            target: { provider: "claudeAgent", model: "claude-sonnet-5" },
          },
        ],
      };
      const first = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_threads",
        args,
      });
      harness.setProviderStatuses([
        {
          provider: "codex",
          status: "error",
          available: false,
          authStatus: "unauthenticated",
          checkedAt: NOW,
          message: "temporarily unavailable after dispatch",
        },
        {
          provider: "claudeAgent",
          status: "error",
          available: false,
          authStatus: "unauthenticated",
          checkedAt: NOW,
          message: "temporarily unavailable after dispatch",
        },
      ]);
      const replay = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_threads",
        args,
      });
      assert.isFalse(isToolError(first.result), toolErrorText(first.result));
      assert.isFalse(isToolError(replay.result), toolErrorText(replay.result));
      assert.deepEqual(
        toolResultJson(replay.result).threadIds,
        toolResultJson(first.result).threadIds,
      );
      assert.equal(
        harness.dispatched.filter((command) => command.type === "thread.create").length,
        2,
      );
      assert.equal(
        harness.dispatched.filter((command) => command.type === "thread.turn.start").length,
        2,
      );
      const creationRecaps = harness.dispatched.filter(
        (command) =>
          command.type === "thread.activity.append" &&
          command.activity.kind === "synara.threads.created",
      );
      assert.equal(creationRecaps.length, 1);
      const creationRecap = creationRecaps[0];
      assert.equal(creationRecap?.type, "thread.activity.append");
      if (creationRecap?.type === "thread.activity.append") {
        assert.equal(creationRecap.threadId, ThreadId.makeUnsafe("thread-parent"));
        assert.equal(creationRecap.activity.turnId, TurnId.makeUnsafe("turn-parent-active"));
        assert.deepInclude(creationRecap.activity.payload as Record<string, unknown>, {
          source: "synara_mcp",
          requestedCount: 2,
          createdCount: 2,
        });
      }
      const conflict = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_threads",
        args: {
          ...args,
          threads: [
            {
              prompt: "changed payload",
              target: { provider: "codex", model: "made-up-model" },
            },
          ],
        },
      });
      assert.equal(
        (toolResultJson(conflict.result).error as { code: string }).code,
        "idempotency_conflict",
      );
      const operationId = toolResultJson(first.result).operationId as string;
      const creates = harness.dispatched.filter((command) => command.type === "thread.create");
      assert.deepEqual(
        creates.map((command) => ({
          creationSource: command.creationSource,
          sourceThreadId: command.sourceThreadId,
          sourceTurnId: command.sourceTurnId,
          gatewayOperationId: command.gatewayOperationId,
          gatewayOperationIndex: command.gatewayOperationIndex,
          parentThreadId: command.parentThreadId,
        })),
        [0, 1].map((index) => ({
          creationSource: "synara_mcp" as const,
          sourceThreadId: ThreadId.makeUnsafe("thread-parent"),
          sourceTurnId: TurnId.makeUnsafe("turn-parent-active"),
          gatewayOperationId: operationId,
          gatewayOperationIndex: index,
          parentThreadId: undefined,
        })),
      );
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("coalesces concurrent identical creation calls onto one operation", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, [], {
      dispatchDelayMs: 15,
    });
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const call = () =>
        harness.callTool({
          token: "token-parent",
          name: "synara_create_threads",
          args: {
            requestId: "concurrent-exact-plan",
            threads: [
              {
                prompt: "one exact worker",
                target: { provider: "codex", model: "gpt-5.5" },
              },
            ],
          },
        });
      const fibers = yield* Effect.forEach([call(), call()], (effect) =>
        effect.pipe(Effect.forkChild),
      );
      yield* TestClock.adjust("1 second");
      const responses = yield* Effect.forEach(fibers, (fiber) => Fiber.join(fiber));
      const first = responses[0]!;
      const second = responses[1]!;
      assert.isFalse(isToolError(first.result), toolErrorText(first.result));
      assert.isFalse(isToolError(second.result), toolErrorText(second.result));
      assert.deepEqual(toolResultJson(first.result), toolResultJson(second.result));
      assert.equal(
        harness.dispatched.filter((command) => command.type === "thread.create").length,
        1,
      );
      assert.equal(
        harness.dispatched.filter((command) => command.type === "thread.turn.start").length,
        1,
      );
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("locks a second distinct creation plan in the same caller turn", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const create = (requestId: string, prompt: string) =>
        harness.callTool({
          token: "token-parent",
          name: "synara_create_threads",
          args: {
            requestId,
            threads: [{ prompt, target: { provider: "codex", model: "gpt-5.5" } }],
          },
        });
      yield* create("first-plan", "first");
      const second = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_threads",
        args: {
          requestId: "second-plan",
          threads: [
            {
              prompt: "invalid second plan",
              target: { provider: "codex", model: "made-up-model" },
            },
          ],
        },
      });
      assert.isTrue(isToolError(second.result));
      assert.equal(
        (toolResultJson(second.result).error as { code: string }).code,
        "creation_plan_locked",
      );
      assert.equal(
        harness.dispatched.filter((command) => command.type === "thread.create").length,
        1,
      );
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("rejects guessed Terra Low slugs before any dispatch", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_threads",
        args: {
          requestId: "bad-terra",
          threads: [
            {
              prompt: "inspect repo",
              target: { provider: "codex", model: "gpt-5.6-terra-low" },
            },
          ],
        },
      });
      assert.isTrue(isToolError(response.result));
      assert.equal(
        (toolResultJson(response.result).error as { code: string }).code,
        "model_unavailable",
      );
      assert.equal(harness.dispatched.length, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("rejects an unavailable or unauthenticated provider before dispatch", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, [], {
      providerStatuses: [
        {
          provider: "claudeAgent",
          status: "error",
          available: false,
          authStatus: "unauthenticated",
          checkedAt: NOW,
          message: "Claude is not authenticated.",
        },
      ],
    });
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_threads",
        args: {
          requestId: "unavailable-provider",
          threads: [
            {
              prompt: "must not dispatch",
              target: { provider: "claudeAgent", model: "claude-sonnet-5" },
            },
          ],
        },
      });
      assert.equal(
        (toolResultJson(response.result).error as { code: string }).code,
        "provider_unavailable",
      );
      assert.equal(harness.dispatched.length, 0);
      assert.equal(harness.worktreeCreates.length, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("persists canonical Terra Low as model plus reasoning option", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_threads",
        args: {
          requestId: "terra-low",
          threads: [
            {
              prompt: "inspect repo",
              target: {
                provider: "codex",
                model: "gpt-5.6-terra",
                options: { reasoningEffort: "low" },
              },
            },
          ],
        },
      });
      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      const create = harness.dispatched.find((command) => command.type === "thread.create");
      assert.equal(create?.type, "thread.create");
      if (create?.type === "thread.create") {
        assert.deepEqual(create.modelSelection, {
          provider: "codex",
          model: "gpt-5.6-terra",
          options: { reasoningEffort: "low" },
        });
      }
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("preflights the whole batch so one invalid target creates nothing", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_threads",
        args: {
          requestId: "atomic-preflight",
          threads: [
            { prompt: "valid", target: { provider: "codex", model: "gpt-5.5" } },
            {
              prompt: "invalid",
              target: { provider: "claudeAgent", model: "made-up-claude" },
            },
          ],
        },
      });
      assert.isTrue(isToolError(response.result));
      assert.equal(harness.dispatched.length, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("compensates operation-owned threads and worktrees after dispatch failure", () => {
    let turnStarts = 0;
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, [], {
      failDispatch: (command) => {
        if (command.type !== "thread.turn.start") return false;
        turnStarts += 1;
        return turnStarts === 2;
      },
    });
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_threads",
        args: {
          requestId: "compensated-batch",
          threads: [
            {
              prompt: "first",
              target: { provider: "codex", model: "gpt-5.5" },
              environment: "worktree",
              branchName: "agent/compensate-first",
            },
            {
              prompt: "second",
              target: { provider: "claudeAgent", model: "claude-sonnet-5" },
              environment: "worktree",
              branchName: "agent/compensate-second",
            },
          ],
        },
      });
      assert.isTrue(isToolError(response.result));
      assert.equal(
        (toolResultJson(response.result).error as { code: string }).code,
        "operation_failed",
      );
      assert.equal(
        harness.dispatched.filter((command) => command.type === "thread.create").length,
        2,
      );
      assert.equal(
        harness.dispatched.filter((command) => command.type === "thread.delete").length,
        2,
      );
      assert.equal(harness.worktreeCreates.length, 2);
      assert.equal(harness.worktreeRemoves.length, 2);
      assert.equal(harness.branchDeletes.length, 2);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("keeps a durable compensating status when cleanup itself fails", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, [], {
      failDispatch: (command) =>
        command.type === "thread.turn.start" || command.type === "thread.delete",
    });
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_threads",
        args: {
          requestId: "cleanup-failure",
          threads: [
            {
              prompt: "fail and compensate",
              target: { provider: "codex", model: "gpt-5.5" },
            },
          ],
        },
      });
      const payload = toolResultJson(response.result);
      assert.equal((payload.error as { code: string }).code, "operation_failed");
      assert.equal(
        (payload.error as { details: { compensationPending: boolean } }).details
          .compensationPending,
        true,
      );
      assert.equal(harness.getOperationStatus("turn-parent-active"), "compensating");
      assert.equal(
        harness.dispatched.filter((command) => command.type === "thread.create").length,
        1,
      );
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("waits for two pinned terminal turns without creating replacements", () => {
    const first = makeThreadShell("thread-result-a", {
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-result-a"),
        state: "completed",
        requestedAt: NOW,
        startedAt: NOW,
        completedAt: NOW,
        assistantMessageId: MessageId.makeUnsafe("message-result-a"),
      },
    });
    const second = makeThreadShell("thread-result-b", {
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-result-b"),
        state: "completed",
        requestedAt: NOW,
        startedAt: NOW,
        completedAt: NOW,
        assistantMessageId: MessageId.makeUnsafe("message-result-b"),
      },
    });
    const firstDetail: OrchestrationThread = {
      ...makeThreadDetail(first),
      messages: [
        {
          id: MessageId.makeUnsafe("message-result-a"),
          role: "assistant",
          text: "First result",
          turnId: TurnId.makeUnsafe("turn-result-a"),
          streaming: false,
          source: "native",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    };
    const secondDetail: OrchestrationThread = {
      ...makeThreadDetail(second),
      messages: [
        {
          id: MessageId.makeUnsafe("message-result-b"),
          role: "assistant",
          text: "Second result",
          turnId: TurnId.makeUnsafe("turn-result-b"),
          streaming: false,
          source: "native",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    };
    const { gatewayLayer, makeHarness } = makeHarnessLayer(
      [makeThreadShell("thread-parent"), first, second],
      [],
      {
        threadDetails: new Map([
          ["thread-result-a", firstDetail],
          ["thread-result-b", secondDetail],
        ]),
      },
    );
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_wait_for_threads",
        args: { threadIds: ["thread-result-a", "thread-result-b"], timeoutMs: 0 },
      });
      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      const payload = toolResultJson(response.result);
      assert.equal(payload.allTerminal, true);
      assert.deepEqual(payload.runIds, ["turn-result-a", "turn-result-b"]);
      assert.deepEqual(
        (payload.threads as Array<{ summary: string }>).map((entry) => entry.summary),
        ["First result", "Second result"],
      );
      assert.equal(harness.dispatched.length, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("replays the original two-agent incident without runaway replacements", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const args = {
        requestId: "repo-summary-pair",
        threads: [
          {
            prompt: "What is this repository about?",
            target: {
              provider: "codex",
              model: "gpt-5.6-terra",
              options: { reasoningEffort: "low" },
            },
          },
          {
            prompt: "What is this repository about?",
            target: { provider: "claudeAgent", model: "claude-sonnet-5" },
          },
        ],
      };
      const created = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_threads",
        args,
      });
      const replay = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_threads",
        args,
      });
      assert.isFalse(isToolError(created.result), toolErrorText(created.result));
      assert.isFalse(isToolError(replay.result), toolErrorText(replay.result));
      const threadIds = toolResultJson(created.result).threadIds as string[];
      assert.deepEqual(toolResultJson(replay.result).threadIds, threadIds);
      assert.equal(threadIds.length, 2);

      threadIds.forEach((threadId, index) => {
        const runId = TurnId.makeUnsafe(`turn-repo-summary-${index}`);
        const messageId = MessageId.makeUnsafe(`message-repo-summary-${index}`);
        const shell = makeThreadShell(threadId, {
          modelSelection:
            index === 0
              ? {
                  provider: "codex",
                  model: "gpt-5.6-terra",
                  options: { reasoningEffort: "low" },
                }
              : { provider: "claudeAgent", model: "claude-sonnet-5" },
          latestTurn: {
            turnId: runId,
            state: "completed",
            requestedAt: NOW,
            startedAt: NOW,
            completedAt: NOW,
            assistantMessageId: messageId,
          },
        });
        harness.setThreadDetail({
          ...makeThreadDetail(shell),
          messages: [
            {
              id: messageId,
              role: "assistant",
              text: index === 0 ? "Terra repository summary" : "Claude repository summary",
              turnId: runId,
              streaming: false,
              source: "native",
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
        });
      });

      const waited = yield* harness.callTool({
        token: "token-parent",
        name: "synara_wait_for_threads",
        args: { threadIds, timeoutMs: 0 },
      });
      assert.deepEqual(
        (toolResultJson(waited.result).threads as Array<{ summary: string }>).map(
          ({ summary }) => summary,
        ),
        ["Terra repository summary", "Claude repository summary"],
      );

      harness.setThreadDetail(
        makeThreadDetail(
          makeThreadShell("thread-parent", {
            latestTurn: {
              turnId: TurnId.makeUnsafe("turn-parent-active"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: null,
            },
          }),
        ),
      );
      const detachedFallback = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_threads",
        args: {
          requestId: "detached-opencode-fallback",
          threads: [
            {
              prompt: "Try again",
              target: { provider: "opencode", model: "openai/gpt-5" },
            },
          ],
        },
      });
      assert.equal(
        (toolResultJson(detachedFallback.result).error as { code: string }).code,
        "caller_turn_inactive",
      );
      const creates = harness.dispatched.filter((command) => command.type === "thread.create");
      assert.equal(creates.length, 2);
      assert.deepEqual(
        creates.map((command) => command.modelSelection),
        [
          {
            provider: "codex",
            model: "gpt-5.6-terra",
            options: { reasoningEffort: "low" },
          },
          { provider: "claudeAgent", model: "claude-sonnet-5" },
        ],
      );
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("wait reports idle, failure, timeout, and a later-completed pinned run", () => {
    const idle = makeThreadShell("thread-wait-idle");
    const failed = makeThreadShell("thread-wait-failed", {
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-wait-failed"),
        state: "error",
        requestedAt: NOW,
        startedAt: NOW,
        completedAt: NOW,
        assistantMessageId: null,
      },
      session: {
        threadId: ThreadId.makeUnsafe("thread-wait-failed"),
        status: "error",
        providerName: "claudeAgent",
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: "Child failed",
        updatedAt: NOW,
      },
    });
    const running = makeThreadShell("thread-wait-running", {
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-wait-pinned"),
        state: "running",
        requestedAt: NOW,
        startedAt: NOW,
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const { gatewayLayer, makeHarness } = makeHarnessLayer([
      makeThreadShell("thread-parent"),
      idle,
      failed,
      running,
    ]);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const first = yield* harness.callTool({
        token: "token-parent",
        name: "synara_wait_for_threads",
        args: {
          threadIds: ["thread-wait-idle", "thread-wait-failed", "thread-wait-running"],
          timeoutMs: 0,
        },
      });
      const firstThreads = toolResultJson(first.result).threads as Array<{
        state: string;
        timedOut: boolean;
        error: string | null;
      }>;
      assert.deepEqual(
        firstThreads.map(({ state, timedOut }) => ({ state, timedOut })),
        [
          { state: "idle", timedOut: false },
          { state: "error", timedOut: false },
          { state: "running", timedOut: true },
        ],
      );
      assert.equal(firstThreads[1]?.error, "Child failed");

      harness.setProjectionTurn({
        threadId: "thread-wait-running",
        turnId: "turn-wait-pinned",
        state: "completed",
        assistantMessageId: "message-wait-pinned",
      });
      harness.setThreadDetail({
        ...makeThreadDetail(
          makeThreadShell("thread-wait-running", {
            latestTurn: {
              turnId: TurnId.makeUnsafe("turn-wait-later"),
              state: "running",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: null,
              assistantMessageId: null,
            },
          }),
        ),
        messages: [
          {
            id: MessageId.makeUnsafe("message-wait-pinned"),
            role: "assistant",
            text: "Pinned run finished",
            turnId: TurnId.makeUnsafe("turn-wait-pinned"),
            streaming: false,
            source: "native",
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      });
      harness.setThreadDetail(
        makeThreadDetail(
          makeThreadShell("thread-parent", {
            latestTurn: {
              turnId: TurnId.makeUnsafe("turn-parent-active"),
              state: "interrupted",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: null,
            },
          }),
        ),
      );
      const second = yield* harness.callTool({
        token: "token-parent",
        name: "synara_wait_for_threads",
        args: {
          threadIds: ["thread-wait-running"],
          runIds: ["turn-wait-pinned"],
          timeoutMs: 0,
        },
      });
      const secondThread = (
        toolResultJson(second.result).threads as Array<{
          state: string;
          summary: string;
        }>
      )[0];
      assert.equal(secondThread?.state, "completed");
      assert.equal(secondThread?.summary, "Pinned run finished");
      assert.equal(harness.dispatched.length, 0);
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

  it.effect("rejects interrupts that would drive a higher-privileged thread", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer([
      ...baseThreads,
      makeThreadShell("thread-full-access", { runtimeMode: "full-access" }),
    ]);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_interrupt_thread",
        args: { threadId: "thread-full-access" },
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
        args: {
          requestId: "create-local-rejected",
          prompt: "touch the main checkout",
          provider: "codex",
          environment: "local",
        },
      });
      assert.isTrue(isToolError(rejected.result));
      assert.include(toolErrorText(rejected.result), "isolated worktree");
      assert.equal(harness.dispatched.length, 0);

      // Omitting environment defaults to an isolated worktree, not local.
      const defaulted = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_thread",
        args: { requestId: "create-isolated", prompt: "do isolated work", provider: "codex" },
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
        args: {
          requestId: "create-escalated",
          prompt: "escalate please",
          provider: "codex",
          runtimeMode: "full-access",
        },
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
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, [
      makeAutomationDefinition(),
    ]);
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

  it.effect("rejects automation cancellation when the caller cannot own or drive it", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(
      [
        ...baseThreads,
        makeThreadShell("thread-elevated", { runtimeMode: "full-access" }),
        makeThreadShell("thread-other"),
      ],
      [
        makeAutomationDefinition({
          id: AutomationId.makeUnsafe("automation-elevated"),
          sourceThreadId: ThreadId.makeUnsafe("thread-other"),
          targetThreadId: ThreadId.makeUnsafe("thread-elevated"),
          runtimeMode: "full-access",
          acknowledgedRisks: ["full-access", "local-checkout"],
        }),
      ],
    );
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_cancel_automation",
        args: { automationId: "automation-elevated" },
      });
      assert.isTrue(isToolError(response.result));
      assert.include(toolErrorText(response.result), "full-access");
      assert.deepEqual(harness.automationUpdates, []);
      assert.deepEqual(harness.automationDeletes, []);
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

  it.effect("rejects metadata changes when the caller cannot drive the target thread", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer([
      ...baseThreads,
      makeThreadShell("thread-elevated", { runtimeMode: "full-access" }),
    ]);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;

      const rename = yield* harness.callTool({
        token: "token-parent",
        name: "synara_set_thread_title",
        args: { threadId: "thread-elevated", title: "Hidden work" },
      });
      assert.isTrue(isToolError(rename.result));
      assert.include(toolErrorText(rename.result), "full-access");

      const archive = yield* harness.callTool({
        token: "token-parent",
        name: "synara_set_thread_archived",
        args: { threadId: "thread-elevated", archived: true },
      });
      assert.isTrue(isToolError(archive.result));
      assert.include(toolErrorText(archive.result), "full-access");
      assert.equal(harness.dispatched.length, 0);
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
