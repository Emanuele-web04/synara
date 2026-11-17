import { ApprovalRequestId, ThreadId, TurnId } from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  Agent,
  OpencodeClient,
  Part,
  PermissionRequest,
  Provider,
  QuestionRequest,
} from "@opencode-ai/sdk/v2";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Logger, Option, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, it, expect, vi } from "vitest";

import { ServerConfig } from "../../config.ts";
import {
  SYNARA_HARNESS_POLICY_MARKER,
  SYNARA_HARNESS_POLICY_VERSION,
} from "../../agentGateway/harnessPolicy.ts";
import {
  AgentGatewayCredentials,
  type AgentGatewayConnectorServer,
  type AgentGatewayCredentialsShape,
} from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import {
  type OpenCodeCliModelDescriptor,
  OpenCodeRuntimeError,
  type OpenCodeInventory,
  type OpenCodeRuntimeShape,
} from "../opencodeRuntime.ts";
import { OpenCodeAdapter, type OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import {
  appendOpenCodeAssistantTextDelta,
  makeOpenCodeAdapterLive,
  normalizeOpenCodeTokenUsage,
  resolveOpenCodePermissionPolicyReply,
} from "./OpenCodeAdapter.ts";

describe("OpenCode permission policy", () => {
  const computerPermission = {
    permission: "mcp__synara__computer_click",
    metadata: {},
  } as const;

  it("lets active approval-required Computer calls reach the gateway once", () => {
    expect(
      resolveOpenCodePermissionPolicyReply({
        runtimeMode: "approval-required",
        interactionMode: "default",
        activeTurn: true,
        computerControlEnabled: true,
        ...computerPermission,
      }),
    ).toBe("once");
  });

  it("preserves Plan, Auto, inactive-turn, disabled, and namespace boundaries", () => {
    const base = {
      runtimeMode: "approval-required" as const,
      interactionMode: "default" as const,
      activeTurn: true,
      computerControlEnabled: true,
      ...computerPermission,
    };

    expect(resolveOpenCodePermissionPolicyReply({ ...base, interactionMode: "plan" })).toBe(
      "reject",
    );
    expect(resolveOpenCodePermissionPolicyReply({ ...base, runtimeMode: "auto" })).toBeUndefined();
    expect(resolveOpenCodePermissionPolicyReply({ ...base, activeTurn: false })).toBeUndefined();
    expect(
      resolveOpenCodePermissionPolicyReply({ ...base, computerControlEnabled: false }),
    ).toBeUndefined();
    expect(
      resolveOpenCodePermissionPolicyReply({
        ...base,
        permission: "mcp__other__computer_click",
      }),
    ).toBeUndefined();
  });

  it("approves Synara group tools once when the session opted in behind a live gateway lease", () => {
    const base = {
      runtimeMode: "approval-required" as const,
      interactionMode: "default" as const,
      activeTurn: true,
      computerControlEnabled: false,
      autoApproveSynaraTools: true,
      gatewaySessionActive: true,
      metadata: {} as const,
    };

    expect(
      resolveOpenCodePermissionPolicyReply({
        ...base,
        permission: "mcp__synara__synara_create_thread",
      }),
    ).toBe("once");
    expect(
      resolveOpenCodePermissionPolicyReply({
        ...base,
        permission: "synara_project_link_repository",
      }),
    ).toBe("once");
    // File edits and shell still ask in approval-required mode.
    expect(resolveOpenCodePermissionPolicyReply({ ...base, permission: "edit" })).toBeUndefined();
    expect(resolveOpenCodePermissionPolicyReply({ ...base, permission: "bash" })).toBeUndefined();
    // The flag is inert without a live gateway session and when not opted in.
    expect(
      resolveOpenCodePermissionPolicyReply({
        ...base,
        gatewaySessionActive: false,
        permission: "mcp__synara__synara_create_thread",
      }),
    ).toBeUndefined();
    expect(
      resolveOpenCodePermissionPolicyReply({
        ...base,
        autoApproveSynaraTools: false,
        permission: "mcp__synara__synara_create_thread",
      }),
    ).toBeUndefined();
  });
});

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

// The shared guard throws synchronously, so the tagged adapter error can arrive
// as either a typed failure or a defect. Read the tag from the squashed cause.
function failureTag(exit: Exit.Exit<unknown, unknown>): string | undefined {
  if (Exit.isSuccess(exit)) {
    return undefined;
  }
  const squashed: unknown = Cause.squash(exit.cause);
  return squashed !== null &&
    typeof squashed === "object" &&
    "_tag" in squashed &&
    typeof (squashed as { readonly _tag?: unknown })._tag === "string"
    ? (squashed as { readonly _tag: string })._tag
    : undefined;
}

const OPEN_CODE_PLAN_PERMISSION_RULES = [
  { permission: "*", pattern: "*", action: "deny" },
  { permission: "read", pattern: "*", action: "allow" },
  { permission: "glob", pattern: "*", action: "allow" },
  { permission: "grep", pattern: "*", action: "allow" },
  { permission: "list", pattern: "*", action: "allow" },
  { permission: "lsp", pattern: "*", action: "allow" },
  { permission: "webfetch", pattern: "*", action: "allow" },
  { permission: "websearch", pattern: "*", action: "allow" },
  { permission: "codesearch", pattern: "*", action: "allow" },
  { permission: "todoread", pattern: "*", action: "allow" },
  { permission: "todowrite", pattern: "*", action: "allow" },
  { permission: "question", pattern: "*", action: "allow" },
] as const;

function createMockOpenCodeRuntime(options?: {
  readonly inventory?: OpenCodeInventory;
  readonly inventoryError?: OpenCodeRuntimeError;
  readonly connectError?: OpenCodeRuntimeError;
  readonly cliModelsError?: OpenCodeRuntimeError;
  readonly cliModels?: ReadonlyArray<OpenCodeCliModelDescriptor>;
  readonly events?: AsyncIterable<unknown>;
  readonly eventSubscriptions?: ReadonlyArray<AsyncIterable<unknown>>;
  readonly prompt?: (input: Record<string, unknown>) => Promise<unknown>;
  readonly promptAsync?: (input: Record<string, unknown>) => Promise<unknown>;
  readonly commandList?: () => Promise<{
    data?: ReadonlyArray<{ name: string; description?: string }>;
  }>;
  readonly commandLists?: ReadonlyArray<ReadonlyArray<{ name: string; description?: string }>>;
  readonly messages?: () => Promise<{
    data: Array<{ info: Record<string, unknown>; parts: Part[] }>;
  }>;
  readonly session?: Record<string, unknown>;
  readonly childrenBySessionId?: Readonly<Record<string, ReadonlyArray<{ id: string }>>>;
  readonly children?: (input: { sessionID: string }) => Promise<unknown>;
  readonly pendingPermissions?: ReadonlyArray<PermissionRequest>;
  readonly permissionList?: () => Promise<unknown>;
  readonly pendingQuestions?: ReadonlyArray<QuestionRequest>;
  readonly questionList?: () => Promise<unknown>;
  readonly permissionReply?: (input: Record<string, unknown>) => Promise<unknown>;
  readonly mcpAdd?: (
    input: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ) => Promise<unknown>;
  readonly serverExit?: Effect.Effect<number>;
  readonly serverPassword?: string;
  readonly sessionCreateError?: Error;
  readonly sessionUpdate?: (input: Record<string, unknown>) => Promise<unknown>;
  readonly scopeCloseDefect?: boolean;
  readonly connectBarrier?: Effect.Effect<void>;
  readonly abortBarrier?: () => Promise<void>;
  readonly onScopeClose?: () => void;
}) {
  const abortCalls: Array<{ sessionID: string }> = [];
  const cliModelCalls: Array<Parameters<OpenCodeRuntimeShape["listOpenCodeCliModels"]>[0]> = [];
  const connectCalls: Array<Parameters<OpenCodeRuntimeShape["connectToOpenCodeServer"]>[0]> = [];
  const createClientCalls: Array<Parameters<OpenCodeRuntimeShape["createOpenCodeSdkClient"]>[0]> =
    [];
  const createCalls: Array<Record<string, unknown>> = [];
  const updateCalls: Array<Record<string, unknown>> = [];
  const forkCalls: Array<{ sessionID: string }> = [];
  const permissionReplyCalls: Array<Record<string, unknown>> = [];
  const questionReplyCalls: Array<Record<string, unknown>> = [];
  const questionRejectCalls: Array<Record<string, unknown>> = [];
  const promptCalls: Array<Record<string, unknown>> = [];
  const promptCallKinds: Array<"async" | "sync"> = [];
  const mcpAddCalls: Array<Record<string, unknown>> = [];
  let eventSubscribeCallCount = 0;
  const emptySubscription = {
    async *[Symbol.asyncIterator]() {
      // No provider-side events needed for these adapter lifecycle tests.
    },
  };
  const client = {
    event: {
      subscribe: async () => {
        const subscriptionIndex = eventSubscribeCallCount;
        eventSubscribeCallCount += 1;
        return {
          stream:
            options?.eventSubscriptions?.[subscriptionIndex] ??
            options?.events ??
            emptySubscription,
        };
      },
    },
    session: {
      create: async (input: Record<string, unknown>) => {
        createCalls.push(input);
        if (options?.sessionCreateError) throw options.sessionCreateError;
        return { data: { id: "opencode-session-1" } };
      },
      update: async (input: Record<string, unknown>) => {
        updateCalls.push(input);
        return options?.sessionUpdate ? options.sessionUpdate(input) : { data: null };
      },
      promptAsync: async (promptInput: Record<string, unknown>) => {
        promptCalls.push(promptInput);
        promptCallKinds.push("async");
        if (options?.promptAsync) {
          return options.promptAsync(promptInput);
        }
        return { data: null };
      },
      prompt: async (promptInput: Record<string, unknown>) => {
        promptCalls.push(promptInput);
        promptCallKinds.push("sync");
        if (options?.prompt) {
          return options.prompt(promptInput);
        }
        return { data: null };
      },
      abort: async (input: { sessionID: string }) => {
        abortCalls.push(input);
        if (options?.abortBarrier) {
          await options.abortBarrier();
        }
        return { data: null };
      },
      messages: options?.messages ?? (async () => ({ data: [] })),
      children: async (input: { sessionID: string }) =>
        options?.children
          ? options.children(input)
          : { data: options?.childrenBySessionId?.[input.sessionID] ?? [] },
      get: async () => ({ data: { directory: process.cwd(), ...(options?.session ?? {}) } }),
      revert: async () => ({ data: null }),
      summarize: async () => ({ data: null }),
      fork: async (input: { sessionID: string }) => {
        forkCalls.push(input);
        return { data: { id: "forked-session-1" } };
      },
    },
    permission: {
      list: async () =>
        options?.permissionList
          ? options.permissionList()
          : { data: options?.pendingPermissions ?? [] },
      reply: async (input: Record<string, unknown>) => {
        permissionReplyCalls.push(input);
        return options?.permissionReply ? options.permissionReply(input) : { data: null };
      },
    },
    question: {
      list: async () =>
        options?.questionList ? options.questionList() : { data: options?.pendingQuestions ?? [] },
      reply: async (input: Record<string, unknown>) => {
        questionReplyCalls.push(input);
        return { data: true };
      },
      reject: async (input: Record<string, unknown>) => {
        questionRejectCalls.push(input);
        return { data: true };
      },
    },
    command: {
      list: options?.commandList ?? (async () => ({ data: [] })),
    },
    mcp: {
      add: async (input: Record<string, unknown>, requestOptions?: { signal?: AbortSignal }) => {
        mcpAddCalls.push(input);
        return options?.mcpAdd
          ? options.mcpAdd(input, requestOptions)
          : { data: { synara: { status: "connected" } } };
      },
    },
  };
  let createClientCallCount = 0;

  const unexpectedOperation = (operation: string) =>
    Effect.fail(
      new OpenCodeRuntimeError({
        operation,
        detail: `Unexpected runtime operation: ${operation}`,
      }),
    );

  const createOpenCodeSdkClient: OpenCodeRuntimeShape["createOpenCodeSdkClient"] = (input) => {
    createClientCalls.push(input);
    const commandList = options?.commandLists?.[createClientCallCount];
    createClientCallCount += 1;
    if (!commandList) {
      return client as unknown as OpencodeClient;
    }
    return {
      ...client,
      command: {
        list: async () => ({ data: commandList }),
      },
    } as unknown as OpencodeClient;
  };

  const runtime: OpenCodeRuntimeShape = {
    startOpenCodeServerProcess: () => unexpectedOperation("startOpenCodeServerProcess"),
    connectToOpenCodeServer: (input) =>
      Effect.gen(function* () {
        connectCalls.push(input);
        if (options?.connectError) {
          return yield* options.connectError;
        }
        if (options?.scopeCloseDefect) {
          const scope = yield* Scope.Scope;
          yield* Scope.addFinalizer(scope, Effect.die(new Error("scope close defect")));
        }
        if (options?.onScopeClose) {
          const scope = yield* Scope.Scope;
          yield* Scope.addFinalizer(scope, Effect.sync(options.onScopeClose));
        }
        if (options?.connectBarrier) yield* options.connectBarrier;
        return {
          url: input.serverUrl ?? "http://127.0.0.1:4099",
          exitCode: options?.serverExit ?? null,
          external: Boolean(input.serverUrl),
          ...(options?.serverPassword ? { serverPassword: options.serverPassword } : {}),
        };
      }),
    runOpenCodeCommand: () => unexpectedOperation("runOpenCodeCommand"),
    createOpenCodeSdkClient,
    loadOpenCodeInventory: () =>
      options?.inventoryError
        ? Effect.fail(options.inventoryError)
        : Effect.succeed(
            options?.inventory ?? {
              providerList: { connected: [], all: [], default: {} },
              agents: [],
              consoleState: null,
            },
          ),
    listOpenCodeCliModels: (input) =>
      Effect.gen(function* () {
        cliModelCalls.push(input);
        if (options?.cliModelsError) {
          return yield* options.cliModelsError;
        }
        return options?.cliModels ?? [];
      }),
    loadOpenCodeCredentialProviderIDs: () => Effect.succeed([]),
  };

  return {
    abortCalls,
    cliModelCalls,
    connectCalls,
    createClientCalls,
    createCalls,
    updateCalls,
    forkCalls,
    permissionReplyCalls,
    questionReplyCalls,
    questionRejectCalls,
    promptCalls,
    promptCallKinds,
    mcpAddCalls,
    get eventSubscribeCallCount() {
      return eventSubscribeCallCount;
    },
    runtime,
  };
}

function makeAdapterTestLayer(
  options: Parameters<typeof makeOpenCodeAdapterLive>[0],
  credentials?: AgentGatewayCredentialsShape,
) {
  const adapter = makeOpenCodeAdapterLive(options);
  return (
    credentials
      ? adapter.pipe(Layer.provide(Layer.succeed(AgentGatewayCredentials, credentials)))
      : adapter
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );
}

function makeOpenCodeAdapterTestLayer(runtime: OpenCodeRuntimeShape) {
  return makeAdapterTestLayer({ runtime });
}

type TestAdapter = Pick<OpenCodeAdapterShape, "sendTurn" | "startSession">;

function sendTestTurn(
  adapter: TestAdapter,
  threadId: ThreadId,
  input: string,
  model = "openai/gpt-5.4",
) {
  return adapter.sendTurn({
    threadId,
    input,
    attachments: [],
    modelSelection: { provider: "opencode", model },
  });
}

function startFullAccess(adapter: TestAdapter, threadId: ThreadId) {
  return adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
}

function promptContainsHarnessPolicy(prompt: Record<string, unknown> | undefined): boolean {
  return JSON.stringify(prompt).includes(SYNARA_HARNESS_POLICY_MARKER);
}

function makeGatewayCredentials(options?: {
  readonly cancelSessionTurnRequests?: (token: string, turnId: string) => Promise<void>;
  readonly connectors?: ReadonlyArray<AgentGatewayConnectorServer>;
}) {
  let nextToken = 0;
  const revoked: string[] = [];
  const leasedCapabilities: Array<readonly string[]> = [];
  const cancelledTurns: Array<{ readonly token: string; readonly turnId: string }> = [];
  const ownerByToken = new Map<string, string>();
  const credentials: AgentGatewayCredentialsShape = {
    mcpEndpointUrl: "http://127.0.0.1:3773/mcp",
    setListeningPort: () => undefined,
    issueSessionToken: (threadId) => {
      const token = `gateway-token-${String(++nextToken)}`;
      ownerByToken.set(token, threadId);
      return token;
    },
    verifySessionToken: (token) => ownerByToken.get(token) ?? null,
    verifySession: () => null,
    issueStdioBootstrapToken: () => "gateway-bootstrap",
    exchangeStdioBootstrapToken: () => null,
    bindWriteAuthority: () => null,
    verifyWriteAuthority: () => false,
    registerInFlightRequest: () => () => undefined,
    cancelInFlightRequests: () => ({ count: 0, settled: Promise.resolve() }),
    cancelSessionTurnRequests: (token, turnId) => {
      cancelledTurns.push({ token, turnId });
      return options?.cancelSessionTurnRequests?.(token, turnId) ?? Promise.resolve();
    },
    retireSessionTurn: (token, turnId) => {
      cancelledTurns.push({ token, turnId });
      return options?.cancelSessionTurnRequests?.(token, turnId) ?? Promise.resolve();
    },
    revokeSessionToken: (token) => {
      revoked.push(token);
      ownerByToken.delete(token);
    },
    connectionForThread: (threadId, _provider, leaseOptions) => {
      leasedCapabilities.push(leaseOptions?.additionalCapabilities ?? []);
      const token = credentials.issueSessionToken(threadId, "opencode");
      return {
        url: credentials.mcpEndpointUrl,
        bearerToken: token,
        ...(options?.connectors ? { connectors: options.connectors } : {}),
      };
    },
    stdioProxy: { command: process.execPath, args: [] },
  };
  return { cancelledTurns, credentials, leasedCapabilities, ownerByToken, revoked };
}

function createSubscribedEventQueue() {
  const pendingEvents: Array<unknown> = [];
  let waitingResolver: ((result: IteratorResult<unknown>) => void) | undefined;
  let closed = false;

  return {
    push(event: unknown) {
      if (closed) {
        return;
      }
      if (waitingResolver) {
        const resolve = waitingResolver;
        waitingResolver = undefined;
        resolve({ value: event, done: false });
        return;
      }
      pendingEvents.push(event);
    },
    close() {
      closed = true;
      if (waitingResolver) {
        const resolve = waitingResolver;
        waitingResolver = undefined;
        resolve({ value: undefined, done: true });
      }
    },
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next: async (): Promise<IteratorResult<unknown>> => {
            if (pendingEvents.length > 0) {
              return {
                value: pendingEvents.shift(),
                done: false,
              };
            }
            if (closed) {
              return { value: undefined, done: true };
            }
            return await new Promise<IteratorResult<unknown>>((resolve) => {
              waitingResolver = resolve;
            });
          },
        };
      },
    },
  };
}

type MockOpenCodeRuntime = ReturnType<typeof createMockOpenCodeRuntime>;
type SubscribedEventQueue = ReturnType<typeof createSubscribedEventQueue>;

/** Feeds the queue to every event subscription the mock SDK client opens. */
function routeEventsTo(runtime: MockOpenCodeRuntime, queue: SubscribedEventQueue) {
  const client = runtime.runtime.createOpenCodeSdkClient({
    baseUrl: "http://127.0.0.1:4099",
    directory: process.cwd(),
  }) as unknown as {
    event: { subscribe: () => Promise<{ stream: AsyncIterable<unknown> }> };
  };
  client.event.subscribe = async () => ({ stream: queue.stream });
}

const assistantRoleKnown = (id: string) => ({
  type: "message.updated",
  properties: { sessionID: "opencode-session-1", info: { id, role: "assistant" } },
});

const sessionIdle = () => ({
  type: "session.status",
  properties: { sessionID: "opencode-session-1", status: { type: "idle" } },
});

function makeInventoryWithContextLimit(input: {
  readonly providerId?: string;
  readonly modelId?: string;
  readonly contextLimit?: number;
}): OpenCodeInventory {
  const providerId = input.providerId ?? "openai";
  const modelId = input.modelId ?? "gpt-5.4";
  return {
    providerList: {
      connected: [providerId],
      all: [
        {
          id: providerId,
          name: "OpenAI",
          source: "api",
          models: {
            [modelId]: {
              id: modelId,
              name: "GPT-5.4",
              limit: {
                context: input.contextLimit ?? 200_000,
                output: 8_192,
              },
            },
          },
        } as unknown as Provider,
      ],
      default: {},
    },
    agents: [],
    consoleState: null,
  };
}

function assistantMessageUpdated(input?: {
  readonly id?: string;
  readonly tokens?: {
    readonly input: number;
    readonly output: number;
    readonly reasoning: number;
    readonly cache: {
      readonly read: number;
      readonly write: number;
    };
  };
  readonly cost?: number;
}) {
  return {
    type: "message.updated",
    properties: {
      sessionID: "opencode-session-1",
      info: {
        id: input?.id ?? "assistant-message-usage",
        role: "assistant",
        tokens: input?.tokens ?? {
          input: 120,
          output: 80,
          reasoning: 30,
          cache: {
            read: 10,
            write: 5,
          },
        },
        cost: input?.cost ?? 0.1234,
      },
    },
  };
}

describe("normalizeOpenCodeTokenUsage", () => {
  it("returns undefined for missing, malformed, negative, infinite, or all-zero usage", () => {
    const validBase = {
      input: 1,
      output: 1,
      reasoning: 1,
      cache: {
        read: 1,
        write: 1,
      },
    };

    expect(normalizeOpenCodeTokenUsage(undefined)).toBeUndefined();
    expect(normalizeOpenCodeTokenUsage({ ...validBase, input: -1 })).toBeUndefined();
    expect(
      normalizeOpenCodeTokenUsage({ ...validBase, output: Number.POSITIVE_INFINITY }),
    ).toBeUndefined();
    expect(
      normalizeOpenCodeTokenUsage({ ...validBase, cache: { read: Number.NaN, write: 1 } }),
    ).toBeUndefined();
    expect(
      normalizeOpenCodeTokenUsage({
        input: 0,
        output: 0,
        reasoning: 0,
        cache: {
          read: 0,
          write: 0,
        },
      }),
    ).toBeUndefined();
    expect(
      normalizeOpenCodeTokenUsage({
        input: 1,
        output: 1,
        reasoning: 1,
      }),
    ).toBeUndefined();
  });

  it("clamps used tokens to the model context limit while preserving total processed tokens", () => {
    expect(
      normalizeOpenCodeTokenUsage(
        {
          input: 150,
          output: 75,
          reasoning: 50,
          cache: {
            read: 25,
            write: 25,
          },
        },
        200,
      ),
    ).toMatchObject({
      usedTokens: 200,
      totalProcessedTokens: 325,
      maxTokens: 200,
      lastUsedTokens: 200,
    });
    expect(
      normalizeOpenCodeTokenUsage({
        input: 150,
        output: 75,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      }),
    ).not.toHaveProperty("maxTokens");
  });
});

describe("OpenCode host policy delivery", () => {
  const modelSelection = { provider: "opencode", model: "openai/gpt-5" } as const;

  it("passes the managed server password to the SDK client", async () => {
    const runtime = createMockOpenCodeRuntime({ serverPassword: "managed-server-password" });

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* startFullAccess(adapter, asThreadId("thread-managed-server-auth"));
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(runtime.createClientCalls[0]?.serverPassword).toBe("managed-server-password");
  });

  it("injects the host policy exactly once for a new native session", async () => {
    const runtime = createMockOpenCodeRuntime();
    const threadId = asThreadId("thread-host-policy-new-session");

    const cursors = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* startFullAccess(adapter, threadId);
        const first = yield* adapter.sendTurn({
          threadId,
          input: "first turn",
          attachments: [],
          modelSelection,
        });
        const second = yield* adapter.sendTurn({
          threadId,
          input: "second turn",
          attachments: [],
          modelSelection,
        });
        return [first.resumeCursor, second.resumeCursor];
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(runtime.promptCalls.map(promptContainsHarnessPolicy)).toEqual([true, false]);
    for (const cursor of cursors) {
      expect(cursor).toMatchObject({
        openCodeSessionId: "opencode-session-1",
        harnessPolicyDelivery: {
          sessionId: "opencode-session-1",
          policyVersion: SYNARA_HARNESS_POLICY_VERSION,
          gatewayControlAvailable: false,
        },
      });
    }
  });

  it("refreshes Computer context on activation profile changes while preserving unchanged resume delivery", async () => {
    const runtime = createMockOpenCodeRuntime();
    const gateway = makeGatewayCredentials();
    const threadId = asThreadId("thread-computer-profile-resume");
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        let resumeCursor: unknown = undefined;
        for (const enableComputerControl of [false, true, true, false]) {
          yield* adapter.startSession({
            provider: "opencode",
            threadId,
            runtimeMode: "full-access",
            enableComputerControl,
            ...(resumeCursor ? { resumeCursor } : {}),
          });
          const result = yield* adapter.sendTurn({
            threadId,
            input: "next",
            attachments: [],
            modelSelection,
          });
          resumeCursor = result.resumeCursor;
        }
        yield* adapter.stopSession(threadId);
      }).pipe(
        Effect.provide(makeAdapterTestLayer({ runtime: runtime.runtime }, gateway.credentials)),
      ),
    );
    expect(runtime.promptCalls.map(promptContainsHarnessPolicy)).toEqual([true, true, false, true]);
    expect(
      runtime.promptCalls.map((prompt) =>
        JSON.stringify(prompt).includes("## Synara computer use"),
      ),
    ).toEqual([false, true, false, false]);
  });

  it("does not re-inject the host policy when the same native session is restarted", async () => {
    const runtime = createMockOpenCodeRuntime();
    const threadId = asThreadId("thread-host-policy-same-session-restart");

    const resumedSession = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* startFullAccess(adapter, threadId);
        const first = yield* adapter.sendTurn({
          threadId,
          input: "first turn",
          attachments: [],
          modelSelection,
        });
        const resumed = yield* adapter.startSession({
          provider: "opencode",
          threadId,
          runtimeMode: "full-access",
          resumeCursor: first.resumeCursor,
        });
        yield* adapter.sendTurn({
          threadId,
          input: "after restart",
          attachments: [],
          modelSelection,
        });
        return resumed;
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(runtime.promptCalls.map(promptContainsHarnessPolicy)).toEqual([true, false]);
    expect(resumedSession.resumeCursor).toMatchObject({
      openCodeSessionId: "opencode-session-1",
      harnessPolicyDelivery: {
        sessionId: "opencode-session-1",
        policyVersion: SYNARA_HARNESS_POLICY_VERSION,
        gatewayControlAvailable: false,
      },
    });
  });

  it("rehydrates host policy state after adapter teardown and recreation", async () => {
    const runtime = createMockOpenCodeRuntime();
    const threadId = asThreadId("thread-host-policy-adapter-recreation");

    const resumeCursor = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* adapter.startSession({
          provider: "opencode",
          threadId,
          runtimeMode: "full-access",
        });
        const first = yield* adapter.sendTurn({
          threadId,
          input: "before teardown",
          attachments: [],
          modelSelection,
        });
        return first.resumeCursor;
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* adapter.startSession({
          provider: "opencode",
          threadId,
          runtimeMode: "full-access",
          resumeCursor,
        });
        yield* adapter.sendTurn({
          threadId,
          input: "after recreation",
          attachments: [],
          modelSelection,
        });
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(runtime.promptCalls.map(promptContainsHarnessPolicy)).toEqual([true, false]);
  });

  it("retries host policy delivery after the first prompt is rejected", async () => {
    let promptAttempt = 0;
    const runtime = createMockOpenCodeRuntime({
      promptAsync: async () => {
        promptAttempt += 1;
        if (promptAttempt === 1) {
          throw new Error("prompt rejected");
        }
        return { data: null };
      },
    });
    const threadId = asThreadId("thread-host-policy-rejected-prompt");

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* startFullAccess(adapter, threadId);
        const firstExit = yield* Effect.exit(
          adapter.sendTurn({
            threadId,
            input: "rejected turn",
            attachments: [],
            modelSelection,
          }),
        );
        const [failedSession] = yield* adapter.listSessions();
        yield* adapter.startSession({
          provider: "opencode",
          threadId,
          runtimeMode: "full-access",
          resumeCursor: failedSession?.resumeCursor,
        });
        const retry = yield* adapter.sendTurn({
          threadId,
          input: "retry turn",
          attachments: [],
          modelSelection,
        });
        return {
          firstFailed: Exit.isFailure(firstExit),
          failedCursor: failedSession?.resumeCursor,
          retryCursor: retry.resumeCursor,
        };
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(result.firstFailed).toBe(true);
    expect(result.failedCursor).not.toHaveProperty("harnessPolicyDelivery");
    expect(runtime.promptCalls.map(promptContainsHarnessPolicy)).toEqual([true, true]);
    expect(result.retryCursor).toMatchObject({
      harnessPolicyDelivery: {
        sessionId: "opencode-session-1",
        policyVersion: SYNARA_HARNESS_POLICY_VERSION,
      },
    });
  });

  it("re-injects the host policy when an in-memory restart has a stale policy version", async () => {
    const runtime = createMockOpenCodeRuntime();
    const threadId = asThreadId("thread-host-policy-stale-version-restart");

    const secondCursor = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* startFullAccess(adapter, threadId);
        const first = yield* adapter.sendTurn({
          threadId,
          input: "first turn",
          attachments: [],
          modelSelection,
        });
        const firstCursor = first.resumeCursor as {
          readonly openCodeSessionId: string;
          readonly cwd: string;
          readonly harnessPolicyDelivery: {
            readonly sessionId: string;
            readonly gatewayControlAvailable: boolean;
          };
        };
        yield* adapter.startSession({
          provider: "opencode",
          threadId,
          runtimeMode: "full-access",
          resumeCursor: {
            ...firstCursor,
            harnessPolicyDelivery: {
              ...firstCursor.harnessPolicyDelivery,
              policyVersion: "2026-10-12.1",
            },
          },
        });
        const second = yield* adapter.sendTurn({
          threadId,
          input: "after policy update",
          attachments: [],
          modelSelection,
        });
        return second.resumeCursor;
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(runtime.promptCalls.map(promptContainsHarnessPolicy)).toEqual([true, true]);
    expect(secondCursor).toMatchObject({
      harnessPolicyDelivery: {
        sessionId: "opencode-session-1",
        policyVersion: SYNARA_HARNESS_POLICY_VERSION,
      },
    });
  });

  it("injects the host policy when the native session id changes", async () => {
    const runtime = createMockOpenCodeRuntime();
    const threadId = asThreadId("thread-host-policy-changed-session");

    const secondCursor = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* startFullAccess(adapter, threadId);
        const first = yield* adapter.sendTurn({
          threadId,
          input: "first turn",
          attachments: [],
          modelSelection,
        });
        const firstCursor = first.resumeCursor as Record<string, unknown>;
        yield* adapter.startSession({
          provider: "opencode",
          threadId,
          runtimeMode: "full-access",
          resumeCursor: {
            ...firstCursor,
            openCodeSessionId: "opencode-session-2",
          },
        });
        const second = yield* adapter.sendTurn({
          threadId,
          input: "new native session",
          attachments: [],
          modelSelection,
        });
        return second.resumeCursor;
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(runtime.promptCalls.map(promptContainsHarnessPolicy)).toEqual([true, true]);
    expect(secondCursor).toMatchObject({
      openCodeSessionId: "opencode-session-2",
      harnessPolicyDelivery: {
        sessionId: "opencode-session-2",
        policyVersion: SYNARA_HARNESS_POLICY_VERSION,
        gatewayControlAvailable: false,
      },
    });
  });
});

describe("OpenCodeAdapter runtime lifecycle", () => {
  it.each([false, true])(
    "recovers missed V2 tool output before completing a reconnected turn (snapshot retry: %s)",
    async (failFirstSnapshot) => {
      const disconnected = createSubscribedEventQueue();
      const reconnected = createSubscribedEventQueue();
      let snapshots: Array<{ info: Record<string, unknown>; parts: Part[] }> = [];
      const runtime = createMockOpenCodeRuntime({
        eventSubscriptions: [disconnected.stream, reconnected.stream],
        messages: async () => {
          if (snapshots.length && failFirstSnapshot) {
            failFirstSnapshot = false;
            throw new Error("snapshot temporarily unavailable");
          }
          return { data: snapshots };
        },
      });
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* OpenCodeAdapter;
          const collected = yield* adapter.streamEvents.pipe(
            Stream.takeUntil((event) => event.type === "turn.completed"),
            Stream.runCollect,
            Effect.forkChild,
          );
          const threadId = asThreadId("v2-reconnect-output");
          yield* startFullAccess(adapter, threadId);
          yield* sendTestTurn(adapter, threadId, "inspect", "local/model");
          snapshots = [
            {
              info: { id: "msg-missed", role: "assistant", time: { completed: 3 }, finish: "stop" },
              parts: [
                {
                  id: "part-missed",
                  messageID: "msg-missed",
                  sessionID: "opencode-session-1",
                  type: "tool",
                  tool: "bash",
                  callID: "call-missed",
                  state: {
                    status: "completed",
                    input: { command: "pwd" },
                    title: "pwd",
                    output: "/workspace",
                    metadata: {},
                    time: { start: 1, end: 3 },
                  },
                },
              ],
            },
          ];
          disconnected.close();
          reconnected.push({
            id: "evt-terminal",
            type: "synara.opencode.execution",
            properties: { sessionID: "opencode-session-1", outcome: "succeeded" },
          });
          reconnected.push({
            id: "evt-terminal-retry",
            type: "synara.opencode.execution",
            properties: { sessionID: "opencode-session-1", outcome: "succeeded" },
          });
          const events = yield* Fiber.join(collected);
          reconnected.close();
          yield* adapter.stopSession(threadId);
          return events;
        }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
      );
      const toolIndex = result.findIndex(
        (event) => event.type === "item.completed" && event.itemId === "call-missed",
      );
      const terminalIndex = result.findIndex((event) => event.type === "turn.completed");
      expect(toolIndex).toBeGreaterThanOrEqual(0);
      expect(toolIndex).toBeLessThan(terminalIndex);
      expect(result[toolIndex]?.payload).toMatchObject({
        data: { state: { output: "/workspace" } },
      });
    },
  );

  it("marks provider retries with a constant message so repeats can merge", async () => {
    const queue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime({ eventSubscriptions: [queue.stream] });
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const collected = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        const threadId = asThreadId("v2-retry-warnings");
        yield* startFullAccess(adapter, threadId);
        yield* sendTestTurn(adapter, threadId, "hello", "local/model");
        for (const attempt of [1, 2]) {
          queue.push({
            id: `retry-status-${attempt}`,
            type: "session.status",
            properties: {
              sessionID: "opencode-session-1",
              status: {
                type: "retry",
                attempt,
                message: `Overloaded (attempt ${attempt})`,
                next: 1,
              },
            },
          });
        }
        queue.push({
          id: "retried-next",
          type: "session.next.retried",
          properties: {
            sessionID: "opencode-session-1",
            timestamp: 1,
            attempt: 3,
            error: { message: "Overloaded (attempt 3)" },
          },
        });
        queue.push({
          id: "end",
          type: "synara.opencode.execution",
          properties: { sessionID: "opencode-session-1", outcome: "succeeded" },
        });
        const result = yield* Fiber.join(collected);
        queue.close();
        yield* adapter.stopSession(threadId);
        return result;
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );
    const warnings = Array.from(events).filter((event) => event.type === "runtime.warning");
    expect(warnings).toHaveLength(3);
    expect(new Set(warnings.map((event) => event.payload.message))).toEqual(
      new Set(["OpenCode is retrying the request."]),
    );
    expect(warnings.every((event) => event.payload.willRetry === true)).toBe(true);
  });

  it("emits the reconnect warning only from the second consecutive failed attempt", async () => {
    const first = createSubscribedEventQueue();
    const second = createSubscribedEventQueue();
    const third = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime({
      eventSubscriptions: [first.stream, second.stream, third.stream],
    });
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const collected = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        const threadId = asThreadId("v2-reconnect-warning");
        yield* startFullAccess(adapter, threadId);
        yield* sendTestTurn(adapter, threadId, "hello", "local/model");
        first.close();
        second.close();
        third.push({
          id: "end",
          type: "synara.opencode.execution",
          properties: { sessionID: "opencode-session-1", outcome: "succeeded" },
        });
        const result = yield* Fiber.join(collected);
        third.close();
        yield* adapter.stopSession(threadId);
        return result;
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );
    const warnings = Array.from(events).filter((event) => event.type === "runtime.warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.payload.message).toBe("OpenCode event stream disconnected; reconnecting.");
  });

  it("projects a native background continuation as a new turn without submitting another prompt", async () => {
    const queue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    routeEventsTo(runtime, queue);
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        let ended = 0;
        const collected = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed" && ++ended === 2),
          Stream.runCollect,
          Effect.forkChild,
        );
        const threadId = asThreadId("v2-continuation");
        yield* startFullAccess(adapter, threadId);
        yield* sendTestTurn(adapter, threadId, "hello", "local/model");
        queue.push({
          id: "first-end",
          type: "synara.opencode.execution",
          properties: { sessionID: "opencode-session-1", outcome: "succeeded" },
        });
        queue.push({
          id: "native-wakeup",
          type: "synara.opencode.execution.started",
          properties: { sessionID: "opencode-session-1" },
        });
        queue.push({
          id: "second-end",
          type: "synara.opencode.execution",
          properties: { sessionID: "opencode-session-1", outcome: "succeeded" },
        });
        const result = yield* Fiber.join(collected);
        queue.close();
        yield* adapter.stopSession(threadId);
        return result;
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );
    const starts = events.filter((event) => event.type === "turn.started");
    expect(starts).toHaveLength(2);
    expect(starts[0]?.turnId).not.toBe(starts[1]?.turnId);
    expect(runtime.promptCalls).toHaveLength(1);
  });
  it.each([
    ["succeeded", "completed"],
    ["failed", "failed"],
    ["interrupted", "interrupted"],
  ] as const)(
    "settles V2 execution %s with its authoritative outcome",
    async (outcome, expected) => {
      const queue = createSubscribedEventQueue();
      const runtime = createMockOpenCodeRuntime();
      routeEventsTo(runtime, queue);
      const events = await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* OpenCodeAdapter;
          const collected = yield* adapter.streamEvents.pipe(
            Stream.takeUntil((event) => event.type === "turn.completed"),
            Stream.runCollect,
            Effect.forkChild,
          );
          const threadId = asThreadId("v2-outcome");
          yield* startFullAccess(adapter, threadId);
          yield* sendTestTurn(adapter, threadId, "hello", "local/model");
          queue.push({
            id: "evt_end",
            type: "synara.opencode.execution",
            properties: {
              sessionID: "opencode-session-1",
              outcome,
              ...(outcome === "failed" ? { message: "Native failure" } : {}),
            },
          });
          const result = yield* Fiber.join(collected);
          queue.close();
          yield* adapter.stopSession(threadId);
          return result;
        }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
      );
      expect(events.find((event) => event.type === "turn.completed")?.payload).toMatchObject({
        state: expected,
      });
    },
  );
  it("rejects a cancelled question and routes normal answers to the owning directory", async () => {
    const threadId = asThreadId("thread-question-cancel");
    const question = {
      sessionID: "opencode-session-1",
      questions: [
        {
          question: "Proceed?",
          header: "Confirm",
          options: [{ label: "Yes", description: "Continue" }],
          multiple: false,
          custom: false,
        },
      ],
    };
    const runtime = createMockOpenCodeRuntime({
      pendingQuestions: [
        { ...question, id: "question-cancel" },
        { ...question, id: "question-answer" },
      ],
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const questionsFiber = yield* Stream.runCollect(
          Stream.take(
            Stream.filter(adapter.streamEvents, (event) => event.type === "user-input.requested"),
            2,
          ),
        ).pipe(Effect.forkChild);
        yield* adapter.startSession({
          provider: "opencode",
          threadId,
          runtimeMode: "full-access",
          resumeCursor: { openCodeSessionId: "opencode-session-1", cwd: process.cwd() },
        });
        yield* Fiber.join(questionsFiber);
        yield* adapter.respondToUserInput(
          threadId,
          ApprovalRequestId.makeUnsafe("question-cancel"),
          {},
        );
        yield* adapter.respondToUserInput(
          threadId,
          ApprovalRequestId.makeUnsafe("question-answer"),
          {
            "question-0-confirm": "Yes",
          },
        );
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(runtime.questionRejectCalls).toEqual([
      { requestID: "question-cancel", directory: process.cwd() },
    ]);
    expect(runtime.questionReplyCalls).toEqual([
      { requestID: "question-answer", directory: process.cwd(), answers: [["Yes"]] },
    ]);
  });

  it("lists OpenCode models from the CLI before falling back to server inventory", async () => {
    const runtime = createMockOpenCodeRuntime({
      cliModels: [
        {
          slug: "opencode/minimax-m2.5-free",
          providerID: "opencode",
          modelID: "minimax-m2.5-free",
          name: "MiniMax M2.5 Free",
          variants: [],
          supportedReasoningEfforts: [],
        },
        {
          slug: "opencode-go/kimi-k2.6",
          providerID: "opencode-go",
          modelID: "kimi-k2.6",
          name: "Kimi K2.6",
          variants: [],
          supportedReasoningEfforts: [],
        },
      ],
      inventory: {
        providerList: {
          connected: ["openai"],
          default: {},
          all: [
            {
              id: "openai",
              name: "OpenAI",
              source: "api",
              models: { "gpt-5": { id: "gpt-5", name: "GPT-5" } },
            } as unknown as Provider,
          ],
        },
        agents: [],
        consoleState: null,
      },
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const listModels = adapter.listModels;
        if (!listModels) {
          throw new Error("Expected OpenCode adapter to support runtime model listing.");
        }
        return yield* listModels({
          provider: "opencode",
          binaryPath: "opencode",
          cwd: "/repo/model-discovery-config",
        });
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(result).toMatchObject({
      source: "opencode-cli",
      cached: false,
    });
    expect(result?.models.map((model) => model.slug)).toEqual([
      "openai/gpt-5",
      "opencode/minimax-m2.5-free",
      "opencode-go/kimi-k2.6",
    ]);
    expect(runtime.connectCalls).toHaveLength(1);
    expect(runtime.connectCalls[0]).toMatchObject({ cwd: "/repo/model-discovery-config" });
    expect(runtime.cliModelCalls).toHaveLength(1);
    expect(runtime.cliModelCalls[0]).toMatchObject({ cwd: "/repo/model-discovery-config" });
  });

  it.each([
    {
      name: "ambient session then explicit empty discovery",
      sessionEnvironment: undefined,
      discoveryEnvironment: {},
    },
    {
      name: "explicit empty session then ambient discovery",
      sessionEnvironment: {},
      discoveryEnvironment: undefined,
    },
  ])(
    "does not reuse $name envelopes",
    async ({ name, sessionEnvironment, discoveryEnvironment }) => {
      const serverUrl = "http://127.0.0.1:4666";
      const runtime = createMockOpenCodeRuntime();

      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* OpenCodeAdapter;
          const listModels = adapter.listModels;
          if (!listModels) {
            throw new Error("Expected OpenCode adapter to support runtime model listing.");
          }

          yield* adapter.startSession({
            provider: "opencode",
            threadId: asThreadId(`thread-${name.replaceAll(" ", "-")}`),
            cwd: "/repo/discovery-environment-boundary",
            runtimeMode: "full-access",
            providerOptions: {
              opencode: {
                serverUrl,
                ...(sessionEnvironment !== undefined ? { environment: sessionEnvironment } : {}),
              },
            },
          });

          return yield* listModels({
            provider: "opencode",
            cwd: "/repo/discovery-environment-boundary",
            serverUrl,
            ...(discoveryEnvironment !== undefined ? { environment: discoveryEnvironment } : {}),
          });
        }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
      );

      expect(runtime.connectCalls).toHaveLength(2);
      expect(runtime.connectCalls.map((call) => call.environment)).toEqual([
        sessionEnvironment,
        discoveryEnvironment,
      ]);
    },
  );

  it("passes the resolved nondefault OpenCode instance through external thread reads", async () => {
    const runtime = createMockOpenCodeRuntime();
    const providerInstanceId = "opencode_work";

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        if (!adapter.readExternalThread) {
          throw new Error("Expected OpenCode external thread reads.");
        }
        return yield* adapter.readExternalThread({
          externalThreadId: "external-session",
          cwd: "/repo/external-import",
          providerInstanceId,
        });
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(runtime.connectCalls).toHaveLength(1);
    expect(runtime.connectCalls[0]).toMatchObject({
      cwd: "/repo/external-import",
      instanceId: providerInstanceId,
    });
  });

  it("keeps the stopped OpenCode account on a graceful exit after the thread switches accounts", async () => {
    const runtime = createMockOpenCodeRuntime();
    const threadId = asThreadId("thread-opencode-account-switch");

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 5)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          providerInstanceId: "opencode_account_a",
          threadId,
          runtimeMode: "full-access",
        });
        yield* adapter.stopSession(threadId);
        yield* adapter.startSession({
          provider: "opencode",
          providerInstanceId: "opencode_account_b",
          threadId,
          runtimeMode: "full-access",
        });

        return Array.from(yield* Fiber.join(eventsFiber));
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    const exited = events.find((event) => event.type === "session.exited");
    const rebound = events.filter((event) => event.type === "session.started").at(-1);
    expect(exited?.providerInstanceId).toBe("opencode_account_a");
    expect(rebound?.providerInstanceId).toBe("opencode_account_b");
  });

  it("retains custom CLI models like OmniRoute when connected providers are in server inventory", async () => {
    const runtime = createMockOpenCodeRuntime({
      cliModels: [
        {
          slug: "opencode/minimax-m2.5-free",
          providerID: "opencode",
          modelID: "minimax-m2.5-free",
          name: "MiniMax M2.5 Free",
          variants: [],
          supportedReasoningEfforts: [],
        },
        {
          slug: "omniroute/antigravity/gemini-3.7-flash-high",
          providerID: "omniroute",
          modelID: "antigravity/gemini-3.7-flash-high",
          name: "Gemini 3.7 Flash High",
          variants: [],
          supportedReasoningEfforts: [],
        },
      ],
      inventory: {
        providerList: {
          connected: ["opencode"],
          default: {},
          all: [
            {
              id: "opencode",
              name: "OpenCode",
              source: "api",
              models: {
                "minimax-m2.5-free": {
                  id: "minimax-m2.5-free",
                  name: "MiniMax M2.5 Free",
                },
              },
            } as unknown as Provider,
          ],
        },
        agents: [],
        consoleState: null,
      },
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const listModels = adapter.listModels;
        if (!listModels) {
          throw new Error("Expected OpenCode adapter to support runtime model listing.");
        }
        return yield* listModels({
          provider: "opencode",
          binaryPath: "opencode",
          cwd: "/repo/model-discovery-config",
        });
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(result?.models.map((model) => model.slug)).toEqual([
      "omniroute/antigravity/gemini-3.7-flash-high",
      "opencode/minimax-m2.5-free",
    ]);
  });

  it("lists OpenCode CLI models when server inventory discovery fails", async () => {
    const runtime = createMockOpenCodeRuntime({
      connectError: new OpenCodeRuntimeError({
        operation: "connectToOpenCodeServer",
        detail: "OpenCode server failed to start.",
      }),
      cliModels: [
        {
          slug: "opencode/nemotron-3-ultra-free",
          providerID: "opencode",
          modelID: "nemotron-3-ultra-free",
          name: "Nemotron 3 Ultra Free",
          variants: [],
          supportedReasoningEfforts: [],
        },
      ],
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const listModels = adapter.listModels;
        if (!listModels) {
          throw new Error("Expected OpenCode adapter to support runtime model listing.");
        }
        return yield* listModels({
          provider: "opencode",
          binaryPath: "opencode",
          cwd: "/repo/server-startup-fails",
        });
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(result).toMatchObject({
      source: "opencode-cli",
      cached: false,
      degraded: true,
    });
    expect(result?.models.map((model) => model.slug)).toEqual(["opencode/nemotron-3-ultra-free"]);
    expect(runtime.connectCalls).toHaveLength(1);
    expect(runtime.connectCalls[0]).toMatchObject({ cwd: "/repo/server-startup-fails" });
    expect(runtime.cliModelCalls).toHaveLength(1);
    expect(runtime.cliModelCalls[0]).toMatchObject({ cwd: "/repo/server-startup-fails" });
  });

  it.each([false, true])(
    "distinguishes an empty CLI catalog from failed discovery (failed: %s)",
    async (failed) => {
      const runtime = createMockOpenCodeRuntime({
        ...(failed
          ? {
              cliModelsError: new OpenCodeRuntimeError({
                operation: "listOpenCodeCliModels",
                detail: "CLI unavailable",
              }),
            }
          : {}),
      });
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* OpenCodeAdapter;
          return yield* adapter.listModels!({ provider: "opencode", cwd: process.cwd() });
        }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
      );

      expect(result.models).toEqual([]);
      expect(result.degraded).toBe(failed);
    },
  );

  it("lists OpenCode agents from the active discovery cwd", async () => {
    const runtime = createMockOpenCodeRuntime({
      inventory: {
        providerList: {
          connected: [],
          default: {},
          all: [],
        },
        agents: [
          {
            name: "project-review",
            displayName: "Project Review",
            description: "Review code with the project-local agent",
            mode: "primary",
            hidden: false,
          } as unknown as Agent,
        ],
        consoleState: null,
      },
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const listAgents = adapter.listAgents;
        if (!listAgents) {
          throw new Error("Expected OpenCode adapter to support runtime agent listing.");
        }
        return yield* listAgents({
          provider: "opencode",
          binaryPath: "opencode",
          cwd: "/repo/agent-discovery-config",
        });
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(result).toMatchObject({
      source: "opencode",
      cached: false,
      agents: [
        {
          name: "project-review",
          displayName: "Project Review",
          description: "Review code with the project-local agent",
        },
      ],
    });
    expect(runtime.connectCalls).toHaveLength(1);
    expect(runtime.connectCalls[0]).toMatchObject({ cwd: "/repo/agent-discovery-config" });
  });

  it("does not reuse an unrelated active OpenCode session for command discovery", async () => {
    const runtime = createMockOpenCodeRuntime({
      commandLists: [[{ name: "wrong-thread" }], [{ name: "review", description: "Review code" }]],
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const listCommands = adapter.listCommands;
        if (!listCommands) {
          throw new Error("Expected OpenCode adapter to support command listing.");
        }

        yield* startFullAccess(adapter, asThreadId("thread-active"));

        return yield* listCommands({
          provider: "opencode",
          cwd: process.cwd(),
        });
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(result).toEqual({
      commands: [{ name: "review", description: "Review code" }],
      source: "opencode",
      cached: false,
    });
  });

  it.each([true, false])(
    "leases a managed session's computer control when enableComputerControl is %s",
    async (enableComputerControl) => {
      const runtime = createMockOpenCodeRuntime();
      const gateway = makeGatewayCredentials();
      const threadId = asThreadId("thread-opencode-computer-control");

      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* OpenCodeAdapter;
          yield* adapter.startSession({
            provider: "opencode",
            threadId,
            runtimeMode: "full-access",
            cwd: "/computer/repo",
            enableComputerControl,
          });
          yield* sendTestTurn(adapter, threadId, "inspect", "openai/gpt-4o");
          yield* sendTestTurn(adapter, threadId, "continue", "openai/gpt-4o");
          yield* adapter.stopSession(threadId);
        }).pipe(
          Effect.provide(makeAdapterTestLayer({ runtime: runtime.runtime }, gateway.credentials)),
        ),
      );

      expect(JSON.stringify(runtime.promptCalls[0]).includes("## Synara computer use")).toBe(
        enableComputerControl,
      );
      expect(JSON.stringify(runtime.promptCalls[1])).not.toContain("## Synara computer use");
      expect(gateway.leasedCapabilities).toEqual([
        enableComputerControl ? ["computer:control"] : [],
      ]);
    },
  );

  it("isolates same-cwd managed sessions, injects distinct gateway tokens, and revokes them", async () => {
    const runtime = createMockOpenCodeRuntime();
    const gateway = makeGatewayCredentials();
    const firstThread = asThreadId("thread-gateway-a");
    const secondThread = asThreadId("thread-gateway-b");

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        for (const threadId of [firstThread, secondThread]) {
          yield* adapter.startSession({
            provider: "opencode",
            threadId,
            runtimeMode: "full-access",
            cwd: "/same/repo",
          });
          yield* sendTestTurn(adapter, threadId, "coordinate work", "openai/gpt-5");
        }
        yield* adapter.stopSession(firstThread);
        expect(gateway.ownerByToken.has("gateway-token-1")).toBe(false);
        expect(gateway.ownerByToken.get("gateway-token-2")).toBe(secondThread);
        yield* adapter.stopSession(secondThread);
      }).pipe(
        Effect.provide(makeAdapterTestLayer({ runtime: runtime.runtime }, gateway.credentials)),
      ),
    );

    expect(runtime.connectCalls).toHaveLength(2);
    expect(runtime.connectCalls[0]).toMatchObject({ cwd: "/same/repo" });
    expect(runtime.connectCalls[1]).toMatchObject({ cwd: "/same/repo" });
    expect(runtime.connectCalls[0]?.poolIsolationKey).toBeTruthy();
    expect(runtime.connectCalls[1]?.poolIsolationKey).toBeTruthy();
    expect(runtime.connectCalls[0]?.poolIsolationKey).not.toBe(
      runtime.connectCalls[1]?.poolIsolationKey,
    );
    expect(runtime.mcpAddCalls).toHaveLength(2);
    expect(runtime.mcpAddCalls.map((call) => call.config)).toEqual([
      expect.objectContaining({
        headers: { Authorization: "Bearer gateway-token-1" },
      }),
      expect.objectContaining({
        headers: { Authorization: "Bearer gateway-token-2" },
      }),
    ]);
    expect(runtime.promptCalls).toHaveLength(2);
    for (const prompt of runtime.promptCalls) {
      expect(JSON.stringify(prompt)).toContain("Use the synara_* tools");
    }
    expect(gateway.revoked).toEqual(["gateway-token-1", "gateway-token-2"]);
  });

  it.each(["connected", "failed", "missing"] as const)(
    "keeps optional connector status %s non-blocking and logs failures without credentials",
    async (status) => {
      const messages: string[] = [];
      const logger = Logger.make(({ message }) => messages.push(JSON.stringify(message)));
      const runtime = createMockOpenCodeRuntime({
        mcpAdd: async (input) =>
          input.name === "synara"
            ? { data: { synara: { status: "connected" } } }
            : {
                data:
                  status === "missing"
                    ? {}
                    : {
                        docs_connector: {
                          status,
                          error: "upstream failure echoed Bearer gateway-token-1",
                        },
                      },
              },
      });
      const gateway = makeGatewayCredentials({
        connectors: [{ name: "docs_connector", url: "http://127.0.0.1:3773/connectors/docs" }],
      });
      const threadId = asThreadId("thread-optional-connector-status");

      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* OpenCodeAdapter;
          yield* adapter.startSession({
            provider: "opencode",
            threadId,
            runtimeMode: "full-access",
            cwd: "/repo",
          });
          expect(yield* adapter.hasSession(threadId)).toBe(true);
          yield* adapter.stopSession(threadId);
        }).pipe(
          Effect.provide(
            makeOpenCodeAdapterTestLayer(runtime.runtime).pipe(
              Layer.provide(Layer.succeed(AgentGatewayCredentials, gateway.credentials)),
            ),
          ),
          Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        ),
      );

      expect(runtime.mcpAddCalls.map((call) => call.name)).toEqual(["synara", "docs_connector"]);
      const warnings = messages.filter((message) =>
        message.includes("OpenCode connector MCP install failed"),
      );
      expect(warnings).toHaveLength(status === "connected" ? 0 : 1);
      if (status !== "connected") expect(warnings[0]).toContain(`status: ${status}`);
      expect(messages.join("\n")).not.toContain("gateway-token-1");
      expect(messages.join("\n")).not.toContain("upstream failure");
    },
  );

  it("keeps shared external OpenCode servers identity-only and never installs a token", async () => {
    const runtime = createMockOpenCodeRuntime();
    const gateway = makeGatewayCredentials();
    const firstThread = asThreadId("thread-external-gateway-a");
    const secondThread = asThreadId("thread-external-gateway-b");

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        for (const threadId of [firstThread, secondThread]) {
          yield* adapter.startSession({
            provider: "opencode",
            threadId,
            runtimeMode: "full-access",
            cwd: "/same/external/repo",
            providerOptions: {
              opencode: { serverUrl: "http://127.0.0.1:9999" },
            },
          });
        }
        yield* sendTestTurn(adapter, firstThread, "coordinate first", "openai/gpt-5");
        const secondTurn = yield* sendTestTurn(
          adapter,
          secondThread,
          "coordinate second",
          "openai/gpt-5",
        ).pipe(Effect.forkChild);
        yield* Effect.sleep(20);
        expect(runtime.promptCalls).toHaveLength(2);
        expect(
          runtime.mcpAddCalls.filter(
            (call) => (call.config as { enabled?: boolean } | undefined)?.enabled !== false,
          ),
        ).toHaveLength(0);

        yield* adapter.interruptTurn(firstThread);
        yield* Fiber.join(secondTurn);
        expect(runtime.promptCalls).toHaveLength(2);
        yield* adapter.interruptTurn(secondThread);
        yield* adapter.stopSession(firstThread);
        expect(gateway.ownerByToken.has("gateway-token-1")).toBe(false);
        expect(gateway.ownerByToken.has("gateway-token-2")).toBe(false);
        yield* adapter.stopSession(secondThread);
      }).pipe(
        Effect.provide(makeAdapterTestLayer({ runtime: runtime.runtime }, gateway.credentials)),
      ),
    );

    expect(runtime.connectCalls).toHaveLength(2);
    for (const connection of runtime.connectCalls) {
      expect(connection).toMatchObject({
        cwd: "/same/external/repo",
        serverUrl: "http://127.0.0.1:9999",
      });
      expect(connection.poolIsolationKey).toBeUndefined();
    }
    expect(runtime.createClientCalls).toHaveLength(2);
    expect(runtime.createClientCalls.map((call) => call.directory)).toEqual([
      "/same/external/repo",
      "/same/external/repo",
    ]);
    for (const clientInput of runtime.createClientCalls) {
      expect(clientInput).not.toHaveProperty("workspaceId");
    }
    expect(runtime.mcpAddCalls).toEqual([]);
    expect(gateway.ownerByToken.size).toBe(0);
    expect(gateway.revoked).toEqual([]);
    expect(runtime.promptCalls).toHaveLength(2);
    for (const prompt of runtime.promptCalls) {
      expect(JSON.stringify(prompt)).toContain("Synara MCP control is unavailable");
    }
  });

  it("treats missing and repeated session stops as successful cleanup", async () => {
    const runtime = createMockOpenCodeRuntime();
    const threadId = asThreadId("thread-idempotent-stop");

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 3)).pipe(
          Effect.forkChild,
        );
        yield* adapter.stopSession(threadId);
        yield* adapter.startSession({
          provider: "opencode",
          threadId,
          runtimeMode: "full-access",
          cwd: "/repo",
        });
        yield* adapter.stopSession(threadId);
        yield* adapter.stopSession(threadId);

        // Deletion, inactivity and the single graceful exit are asserted
        // independently: the false probe alone no longer proves removal.
        expect(yield* adapter.hasSession(threadId)).toBe(false);
        expect((yield* adapter.listSessions()).some((s) => s.threadId === threadId)).toBe(false);
        const events = Array.from(yield* Fiber.join(eventsFiber));
        const exitEvents = events.filter((event) => event.type === "session.exited");
        expect(exitEvents).toHaveLength(1);
        expect(exitEvents[0]?.payload).toMatchObject({ exitKind: "graceful" });
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(runtime.abortCalls).toHaveLength(1);
  });

  it("reports an interrupted stop as inactive and resumes the thread on the next start", async () => {
    const abortBarrier = Deferred.makeUnsafe<void>();
    const closeScope = vi.fn();
    const runtime = createMockOpenCodeRuntime({
      onScopeClose: closeScope,
      abortBarrier: () => Deferred.await(abortBarrier).pipe(Effect.runPromise),
    });
    const threadId = asThreadId("thread-interrupted-stop-recovery");

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const started = yield* adapter.startSession({
          provider: "opencode",
          threadId,
          runtimeMode: "full-access",
          cwd: "/repo",
        });
        expect(yield* adapter.hasSession(threadId)).toBe(true);

        const stopFiber = yield* adapter.stopSession(threadId).pipe(Effect.forkChild);
        yield* Effect.promise(() => vi.waitFor(() => expect(runtime.abortCalls).toHaveLength(1)));
        yield* Fiber.interrupt(stopFiber);

        // The interrupted stop leaves a stopped context registered: the probe must
        // report it inactive while the map still owns it.
        yield* Effect.gen(function* () {
          // Recovery must not abandon the old managed server and gateway scope.
          expect(closeScope).toHaveBeenCalledTimes(1);
          expect(yield* adapter.hasSession(threadId)).toBe(false);
          expect((yield* adapter.listSessions()).some((s) => s.threadId === threadId)).toBe(true);
        }).pipe(Effect.ensuring(Effect.sync(() => Deferred.doneUnsafe(abortBarrier, Effect.void))));

        yield* adapter.startSession({
          provider: "opencode",
          threadId,
          runtimeMode: "full-access",
          resumeCursor: started.resumeCursor,
        });
        expect(yield* adapter.hasSession(threadId)).toBe(true);
        expect(closeScope).toHaveBeenCalledTimes(1);

        const turn = yield* sendTestTurn(adapter, threadId, "recovered turn", "openai/gpt-5");
        expect(turn.threadId).toBe(threadId);
        expect(runtime.createCalls).toHaveLength(1);
        expect(runtime.updateCalls.some((call) => call.sessionID === "opencode-session-1")).toBe(
          true,
        );
        expect(runtime.promptCalls).toHaveLength(1);
        expect(runtime.promptCalls[0]?.sessionID).toBe("opencode-session-1");
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );
  });

  it("PR1160 TASK-04 keeps the probe and the shared guard in agreement across session states", async () => {
    const abortBarrier = Deferred.makeUnsafe<void>();
    const runtime = createMockOpenCodeRuntime({
      abortBarrier: () => Deferred.await(abortBarrier).pipe(Effect.runPromise),
    });
    const absentThreadId = asThreadId("thread-probe-guard-absent");
    const stoppedThreadId = asThreadId("thread-probe-guard-stopped");

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const guardedOps = (threadId: ThreadId) => [
          {
            name: "sendTurn",
            run: () => sendTestTurn(adapter, threadId, "probe", "openai/gpt-5"),
          },
          { name: "interruptTurn", run: () => adapter.interruptTurn(threadId) },
          {
            name: "respondToRequest",
            run: () =>
              adapter.respondToRequest(
                threadId,
                ApprovalRequestId.makeUnsafe("probe-request"),
                "accept",
              ),
          },
          {
            name: "respondToUserInput",
            run: () =>
              adapter.respondToUserInput(threadId, ApprovalRequestId.makeUnsafe("probe-request"), {
                answer: "yes",
              }),
          },
          { name: "readThread", run: () => adapter.readThread(threadId) },
          { name: "rollbackThread", run: () => adapter.rollbackThread(threadId, 1) },
          { name: "compactThread", run: () => adapter.compactThread!(threadId) },
        ];

        // Absent: the probe is false and every guarded operation reports missing.
        expect(yield* adapter.hasSession(absentThreadId)).toBe(false);
        for (const op of guardedOps(absentThreadId)) {
          expect({ op: op.name, tag: failureTag(yield* op.run().pipe(Effect.exit)) }).toEqual({
            op: op.name,
            tag: "ProviderAdapterSessionNotFoundError",
          });
        }

        // Live: the probe is true.
        yield* adapter.startSession({
          provider: "opencode",
          threadId: stoppedThreadId,
          runtimeMode: "full-access",
          cwd: "/repo",
        });
        expect(yield* adapter.hasSession(stoppedThreadId)).toBe(true);

        // Stopped-retained: the probe is false while the map still owns the
        // context, and every guarded operation reports the closed session.
        const stopFiber = yield* adapter.stopSession(stoppedThreadId).pipe(Effect.forkChild);
        yield* Effect.promise(() => vi.waitFor(() => expect(runtime.abortCalls).toHaveLength(1)));
        yield* Fiber.interrupt(stopFiber);

        yield* Effect.gen(function* () {
          expect(yield* adapter.hasSession(stoppedThreadId)).toBe(false);
          expect((yield* adapter.listSessions()).some((s) => s.threadId === stoppedThreadId)).toBe(
            true,
          );
          for (const op of guardedOps(stoppedThreadId)) {
            expect({ op: op.name, tag: failureTag(yield* op.run().pipe(Effect.exit)) }).toEqual({
              op: op.name,
              tag: "ProviderAdapterSessionClosedError",
            });
          }
        }).pipe(Effect.ensuring(Effect.sync(() => Deferred.doneUnsafe(abortBarrier, Effect.void))));
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );
  });

  it("does not touch an external OpenCode MCP registry when its setup hook would fail", async () => {
    let activeSetupAttempts = 0;
    const runtime = createMockOpenCodeRuntime({
      mcpAdd: async (input) => {
        const config = input.config as { enabled?: boolean } | undefined;
        if (config?.enabled === false) {
          return { data: { synara: { status: "disabled" } } };
        }
        activeSetupAttempts += 1;
        return activeSetupAttempts === 1
          ? { data: { synara: { status: "failed", error: "gateway unavailable" } } }
          : { data: { synara: { status: "connected" } } };
      },
    });
    const gateway = makeGatewayCredentials();
    const threadId = asThreadId("thread-external-gateway-retry");

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* adapter.startSession({
          provider: "opencode",
          threadId,
          runtimeMode: "full-access",
          cwd: "/external/retry-repo",
          providerOptions: {
            opencode: { serverUrl: "http://127.0.0.1:9998" },
          },
        });

        const failed = yield* sendTestTurn(adapter, threadId, "first attempt", "openai/gpt-5").pipe(
          Effect.exit,
        );
        expect(Exit.isFailure(failed)).toBe(false);
        expect(runtime.promptCalls).toHaveLength(1);

        yield* sendTestTurn(adapter, threadId, "second attempt", "openai/gpt-5");
        expect(runtime.promptCalls).toHaveLength(2);
        yield* adapter.interruptTurn(threadId);
        yield* adapter.stopSession(threadId);
      }).pipe(
        Effect.provide(makeAdapterTestLayer({ runtime: runtime.runtime }, gateway.credentials)),
      ),
    );

    expect(activeSetupAttempts).toBe(0);
    expect(runtime.mcpAddCalls).toEqual([]);
    expect(JSON.stringify(runtime.promptCalls[0])).toContain("Synara MCP control is unavailable");
    expect(gateway.revoked).toEqual([]);
  });

  it("keeps managed sessions identity-only and revokes credentials when MCP setup is not connected", async () => {
    const runtime = createMockOpenCodeRuntime({
      mcpAdd: async () => ({ data: { synara: { status: "failed", error: "offline" } } }),
    });
    const gateway = makeGatewayCredentials();

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-gateway-setup-failed");
        yield* startFullAccess(adapter, threadId);
        yield* sendTestTurn(adapter, threadId, "coordinate work", "openai/gpt-5");
      }).pipe(
        Effect.provide(makeAdapterTestLayer({ runtime: runtime.runtime }, gateway.credentials)),
      ),
    );

    expect(gateway.revoked).toEqual(["gateway-token-1"]);
    expect(gateway.ownerByToken.size).toBe(0);
    expect(JSON.stringify(runtime.promptCalls[0])).toContain("Synara MCP control is unavailable");
  });

  it.each(["failed status", "transport error"] as const)(
    "rejects enabled Computer startup on MCP %s and releases its private scope once",
    async (failure) => {
      const closeScope = vi.fn();
      const runtime = createMockOpenCodeRuntime({
        mcpAdd: async () => {
          if (failure === "transport error") throw new Error("Gateway offline");
          return { data: { synara: { status: "failed", error: "Gateway offline" } } };
        },
        onScopeClose: closeScope,
      });
      const gateway = makeGatewayCredentials();
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* OpenCodeAdapter;
          const threadId = asThreadId("thread-computer-gateway-failed");
          const error = yield* Effect.flip(
            adapter.startSession({
              provider: "opencode",
              threadId,
              runtimeMode: "full-access",
              enableComputerControl: true,
            }),
          );
          expect(error).toMatchObject({
            _tag: "ProviderAdapterProcessError",
            detail: expect.stringContaining("Computer Use could not start"),
          });
          expect(yield* adapter.hasSession(threadId)).toBe(false);
        }).pipe(
          Effect.provide(makeAdapterTestLayer({ runtime: runtime.runtime }, gateway.credentials)),
        ),
      );
      expect(runtime.createCalls).toEqual([]);
      expect(runtime.updateCalls).toEqual([]);
      expect(runtime.promptCalls).toEqual([]);
      expect(gateway.revoked).toEqual(["gateway-token-1"]);
      expect(gateway.ownerByToken.size).toBe(0);
      expect(closeScope).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["external server", "missing gateway"] as const)(
    "rejects enabled Computer startup with %s before connecting or minting credentials",
    async (unavailable) => {
      const runtime = createMockOpenCodeRuntime();
      const gateway = makeGatewayCredentials();
      const layer = makeAdapterTestLayer({ runtime: runtime.runtime });
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* OpenCodeAdapter;
          const threadId = asThreadId("thread-computer-unavailable");
          const error = yield* Effect.flip(
            adapter.startSession({
              provider: "opencode",
              threadId,
              runtimeMode: "full-access",
              enableComputerControl: true,
              ...(unavailable === "external server"
                ? { providerOptions: { opencode: { serverUrl: "http://127.0.0.1:9998" } } }
                : {}),
            }),
          );
          expect(error.message).toContain("Computer Use");
          expect(error.message).toContain(
            unavailable === "external server" ? "external server URL" : "gateway is unavailable",
          );
          expect(yield* adapter.hasSession(threadId)).toBe(false);
        }).pipe(
          Effect.provide(
            unavailable === "external server"
              ? layer.pipe(
                  Layer.provide(Layer.succeed(AgentGatewayCredentials, gateway.credentials)),
                )
              : layer,
          ),
        ),
      );
      expect(runtime.connectCalls).toEqual([]);
      expect(runtime.createCalls).toEqual([]);
      expect(runtime.mcpAddCalls).toEqual([]);
      expect(runtime.promptCalls).toEqual([]);
      expect(gateway.leasedCapabilities).toEqual([]);
      expect(gateway.revoked).toEqual([]);
    },
  );

  it.each([false, true])(
    "cancels stalled MCP setup with Computer enabled=%s",
    async (enableComputerControl) => {
      const requested = Effect.runSync(Deferred.make<void>());
      let requestSignal: AbortSignal | undefined;
      const runtime = createMockOpenCodeRuntime({
        mcpAdd: async (_input, options) => {
          requestSignal = options?.signal;
          Effect.runSync(Deferred.succeed(requested, undefined));
          return await new Promise(() => {});
        },
      });
      const gateway = makeGatewayCredentials();
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* OpenCodeAdapter;
          const threadId = asThreadId("thread-stalled-gateway");
          const starting = yield* adapter
            .startSession({
              provider: "opencode",
              threadId,
              runtimeMode: "full-access",
              enableComputerControl,
            })
            .pipe(Effect.exit, Effect.forkChild);
          yield* Deferred.await(requested);
          yield* TestClock.adjust("10 seconds");
          const started = yield* Fiber.join(starting);
          expect(requestSignal?.aborted).toBe(true);
          if (enableComputerControl) {
            expect(Exit.isFailure(started)).toBe(true);
            expect(yield* adapter.hasSession(threadId)).toBe(false);
            expect(runtime.createCalls).toEqual([]);
            expect(runtime.promptCalls).toEqual([]);
            expect(gateway.revoked).toEqual(["gateway-token-1"]);
          } else {
            expect(started).toMatchObject({ _tag: "Success", value: { status: "ready" } });
            yield* sendTestTurn(adapter, threadId, "hello", "openai/gpt-5");
            yield* adapter.stopSession(threadId);
            expect(JSON.stringify(runtime.promptCalls[0])).toContain(
              "Synara MCP control is unavailable",
            );
          }
        }).pipe(
          Effect.provide(makeAdapterTestLayer({ runtime: runtime.runtime }, gateway.credentials)),
          Effect.provide(TestClock.layer()),
          Effect.scoped,
        ),
      );
      expect(gateway.ownerByToken.size).toBe(0);
    },
  );

  it("submits OpenCode turns through the asynchronous prompt endpoint", async () => {
    const runtime = createMockOpenCodeRuntime({
      prompt: async () => {
        throw new Error("OpenCode's blocking prompt endpoint must not be used");
      },
    });
    const threadId = asThreadId("thread-opencode-async-prompt");

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* adapter.startSession({
          provider: "opencode",
          threadId,
          runtimeMode: "full-access",
          cwd: "/repo",
        });
        yield* sendTestTurn(adapter, threadId, "perform a long-running task", "openai/gpt-5");
        yield* adapter.stopSession(threadId);
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(runtime.promptCallKinds).toEqual(["async"]);
    expect(runtime.promptCalls[0]).toMatchObject({
      sessionID: "opencode-session-1",
    });
  });

  it("revokes a managed gateway lease exactly once when the server exits unexpectedly", async () => {
    const serverExit = Deferred.makeUnsafe<number>();
    const runtime = createMockOpenCodeRuntime({ serverExit: Deferred.await(serverExit) });
    const gateway = makeGatewayCredentials();
    const threadId = asThreadId("thread-gateway-unexpected-exit");

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* startFullAccess(adapter, threadId);
        expect(gateway.ownerByToken.get("gateway-token-1")).toBe(threadId);

        Deferred.doneUnsafe(serverExit, Effect.succeed(17));
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(gateway.ownerByToken.has("gateway-token-1")).toBe(false)),
        );
        expect(yield* adapter.hasSession(threadId)).toBe(false);
        expect((yield* adapter.listSessions()).some((s) => s.threadId === threadId)).toBe(false);
      }).pipe(
        Effect.provide(makeAdapterTestLayer({ runtime: runtime.runtime }, gateway.credentials)),
      ),
    );

    expect(gateway.revoked).toEqual(["gateway-token-1"]);
  });

  it("revokes a managed gateway lease even when failed-start scope cleanup defects", async () => {
    const runtime = createMockOpenCodeRuntime({
      sessionCreateError: new Error("session create failed"),
      scopeCloseDefect: true,
    });
    const gateway = makeGatewayCredentials();

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        return yield* Effect.exit(
          startFullAccess(adapter, asThreadId("thread-gateway-failed-start")),
        );
      }).pipe(
        Effect.provide(makeAdapterTestLayer({ runtime: runtime.runtime }, gateway.credentials)),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(gateway.ownerByToken.size).toBe(0);
    expect(gateway.revoked).toEqual(["gateway-token-1"]);
  });

  it("closes the private server scope and revokes its lease when startup is interrupted", async () => {
    const connectBarrier = Deferred.makeUnsafe<void>();
    let scopeCloseCount = 0;
    const runtime = createMockOpenCodeRuntime({
      connectBarrier: Deferred.await(connectBarrier),
      onScopeClose: () => {
        scopeCloseCount += 1;
      },
    });
    const gateway = makeGatewayCredentials();

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const startFiber = yield* adapter
          .startSession({
            provider: "opencode",
            threadId: asThreadId("thread-gateway-interrupted-start"),
            runtimeMode: "full-access",
          })
          .pipe(Effect.forkChild);
        yield* Effect.promise(() => vi.waitFor(() => expect(runtime.connectCalls).toHaveLength(1)));

        yield* Fiber.interrupt(startFiber);
      }).pipe(
        Effect.provide(makeAdapterTestLayer({ runtime: runtime.runtime }, gateway.credentials)),
      ),
    );

    expect(scopeCloseCount).toBe(1);
    expect(gateway.ownerByToken.size).toBe(0);
    expect(gateway.revoked).toEqual(["gateway-token-1"]);
  });

  it("retains startup ownership until a connected session is registered", async () => {
    const beforeInstallEntered = Deferred.makeUnsafe<void>();
    const installBarrier = Deferred.makeUnsafe<void>();
    let scopeCloseCount = 0;
    const runtime = createMockOpenCodeRuntime({
      onScopeClose: () => {
        scopeCloseCount += 1;
      },
    });
    const gateway = makeGatewayCredentials();
    const threadId = asThreadId("thread-gateway-interrupted-before-install");

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const startFiber = yield* adapter
          .startSession({
            provider: "opencode",
            threadId,
            runtimeMode: "full-access",
          })
          .pipe(Effect.forkChild);

        yield* Deferred.await(beforeInstallEntered);
        expect(gateway.ownerByToken.get("gateway-token-1")).toBe(threadId);
        expect(yield* adapter.hasSession(threadId)).toBe(false);

        yield* Fiber.interrupt(startFiber);
        expect(yield* adapter.hasSession(threadId)).toBe(false);
      }).pipe(
        Effect.provide(
          makeAdapterTestLayer(
            {
              runtime: runtime.runtime,
              beforeSessionInstall: Effect.sync(() =>
                Deferred.doneUnsafe(beforeInstallEntered, Effect.void),
              ).pipe(Effect.andThen(Deferred.await(installBarrier))),
            },
            gateway.credentials,
          ),
        ),
      ),
    );

    expect(scopeCloseCount).toBe(1);
    expect(gateway.ownerByToken.size).toBe(0);
    expect(gateway.revoked).toEqual(["gateway-token-1"]);
  });

  it("uses the persisted resume cursor cwd when resuming OpenCode sessions", async () => {
    const runtime = createMockOpenCodeRuntime();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        return yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-resume-cwd"),
          runtimeMode: "full-access",
          resumeCursor: { openCodeSessionId: "existing-session-1", cwd: "/repo/resume" },
        });
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(runtime.createCalls).toEqual([]);
    expect(runtime.connectCalls).toHaveLength(1);
    expect(runtime.connectCalls[0]).toMatchObject({ cwd: "/repo/resume" });
    expect(result.cwd).toBe("/repo/resume");
    expect(result.resumeCursor).toMatchObject({
      openCodeSessionId: "existing-session-1",
      cwd: "/repo/resume",
    });
  });

  it("reports no native resume when a supplied cursor has no session id", async () => {
    const runtime = createMockOpenCodeRuntime();

    const confirmed = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const input = {
          provider: "opencode" as const,
          threadId: asThreadId("thread-malformed-resume-cursor"),
          runtimeMode: "full-access" as const,
          resumeCursor: { cwd: "/repo/resume" },
        };
        const session = yield* adapter.startSession(input);
        return adapter.didResumeSession?.(input, session) ?? false;
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(confirmed).toBe(false);
    expect(runtime.createCalls).toHaveLength(1);
    expect(runtime.updateCalls).toEqual([]);
  });

  it("applies fail-closed resume permissions and restores Full Access for a new turn", async () => {
    const runtime = createMockOpenCodeRuntime();

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-resume-permissions");
        yield* adapter.startSession({
          provider: "opencode",
          threadId,
          runtimeMode: "full-access",
          resumeCursor: { openCodeSessionId: "existing-session-1", cwd: "/repo/resume" },
        });
        yield* adapter.sendTurn({
          threadId,
          input: "Implement the change",
          attachments: [],
          interactionMode: "default",
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(runtime.createCalls).toEqual([]);
    expect(runtime.updateCalls).toEqual([
      {
        sessionID: "existing-session-1",
        permission: OPEN_CODE_PLAN_PERMISSION_RULES,
      },
      {
        sessionID: "existing-session-1",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      },
    ]);
  });

  it("fails closed and aborts when resume Plan permissions cannot be applied", async () => {
    const runtime = createMockOpenCodeRuntime({
      sessionUpdate: async () => {
        throw new Error("session.update unavailable during resume");
      },
    });

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* OpenCodeAdapter;
          yield* adapter.startSession({
            provider: "opencode",
            threadId: asThreadId("thread-resume-plan-permission-failure"),
            runtimeMode: "full-access",
            resumeCursor: { openCodeSessionId: "existing-session-1", cwd: "/repo/resume" },
          });
        }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
      ),
    ).rejects.toMatchObject({
      _tag: "ProviderAdapterRequestError",
      provider: "opencode",
      method: "session.update",
      detail: "session.update unavailable during resume",
    });

    expect(runtime.updateCalls).toEqual([
      { sessionID: "existing-session-1", permission: OPEN_CODE_PLAN_PERMISSION_RULES },
    ]);
    expect(runtime.abortCalls).toContainEqual({ sessionID: "existing-session-1" });
    expect(runtime.promptCalls).toEqual([]);
  });

  it("declines inactive OpenCode native fork when source and target cwd differ", async () => {
    const runtime = createMockOpenCodeRuntime();

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* OpenCodeAdapter;
          const forkThread = adapter.forkThread;
          if (!forkThread) {
            throw new Error("Expected OpenCode adapter to support native thread forking.");
          }
          return yield* forkThread({
            sourceThreadId: asThreadId("thread-source"),
            threadId: asThreadId("thread-target"),
            sourceResumeCursor: { openCodeSessionId: "source-session-1" },
            sourceCwd: "/repo/source",
            cwd: "/repo/target",
            runtimeMode: "full-access",
          });
        }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
      ),
    ).rejects.toThrow("native fork cannot cross cwd boundaries");

    expect(runtime.forkCalls).toEqual([]);
    expect(runtime.connectCalls).toEqual([]);
  });

  it("defaults inactive OpenCode native forks to the source cwd", async () => {
    const runtime = createMockOpenCodeRuntime();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const forkThread = adapter.forkThread;
        if (!forkThread) {
          throw new Error("Expected OpenCode adapter to support native thread forking.");
        }
        return yield* forkThread({
          sourceThreadId: asThreadId("thread-source"),
          threadId: asThreadId("thread-target"),
          sourceResumeCursor: { openCodeSessionId: "source-session-1" },
          sourceCwd: "/repo/source",
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(runtime.forkCalls).toEqual([{ sessionID: "source-session-1" }]);
    // Only the scoped fork client connects: the target session starts later
    // under a ProviderService lifecycle lease, not inside forkThread.
    expect(runtime.connectCalls).toHaveLength(1);
    expect(runtime.connectCalls[0]).toMatchObject({ cwd: "/repo/source" });
    expect(result.resumeCursor).toMatchObject({
      openCodeSessionId: "forked-session-1",
      cwd: "/repo/source",
    });
  });

  it("reuses the matching active OpenCode thread for command discovery", async () => {
    const threadId = asThreadId("thread-command-discovery");
    const runtime = createMockOpenCodeRuntime({
      commandLists: [[{ name: "active-thread-command" }], [{ name: "scoped-client-command" }]],
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const listCommands = adapter.listCommands;
        if (!listCommands) {
          throw new Error("Expected OpenCode adapter to support command listing.");
        }

        yield* startFullAccess(adapter, threadId);

        return yield* listCommands({
          provider: "opencode",
          threadId,
          cwd: process.cwd(),
        });
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(result.commands.map((command) => command.name)).toEqual(["active-thread-command"]);
  });

  it("returns no OpenCode commands when command discovery is unsupported", async () => {
    const runtime = createMockOpenCodeRuntime({
      commandList: async () => {
        throw new Error("status=404 body={}");
      },
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const listCommands = adapter.listCommands;
        if (!listCommands) {
          throw new Error("Expected OpenCode adapter to support command listing.");
        }

        return yield* listCommands({
          provider: "opencode",
          cwd: process.cwd(),
        });
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(result).toEqual({
      commands: [],
      source: "unsupported",
      cached: false,
    });
  });

  it("pins the initial model on new OpenCode sessions", async () => {
    const runtime = createMockOpenCodeRuntime();

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-model-pin"),
          runtimeMode: "full-access",
          modelSelection: {
            provider: "opencode",
            model: "opencode/big-pickle",
            options: {
              agent: "build",
              variant: "fast",
            },
          },
        });
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(runtime.createCalls[0]).toMatchObject({
      model: {
        providerID: "opencode",
        id: "big-pickle",
        variant: "fast",
      },
      agent: "build",
      title: "Synara thread-model-pin",
    });
  });

  it("clears adapter session state when interrupting an active OpenCode turn", async () => {
    const runtime = createMockOpenCodeRuntime();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-1"),
          lifecycleGeneration: "generation-opencode-a",
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-1"),
          input: "hello",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
            options: {
              variant: "high",
            },
          },
        });

        const [runningSession] = yield* adapter.listSessions();

        yield* adapter.interruptTurn(asThreadId("thread-1"));

        const [readySession] = yield* adapter.listSessions();
        const events = Array.from(yield* Fiber.join(eventsFiber));

        return { events, readySession, runningSession };
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(runtime.promptCalls).toHaveLength(1);
    const firstPromptText = (
      runtime.promptCalls[0]?.parts as ReadonlyArray<{ readonly text?: string }> | undefined
    )?.[0]?.text;
    expect(firstPromptText).toContain(SYNARA_HARNESS_POLICY_MARKER);
    expect(firstPromptText).toContain("Synara MCP control is unavailable");
    expect(runtime.promptCalls[0]).toMatchObject({
      model: {
        providerID: "openai",
        modelID: "gpt-5.4",
      },
      variant: "high",
    });
    expect(runtime.abortCalls.length).toBeGreaterThanOrEqual(1);
    expect(runtime.abortCalls[0]).toEqual({ sessionID: "opencode-session-1" });
    expect(result.runningSession?.status).toBe("running");
    expect(result.runningSession?.activeTurnId).toBeDefined();
    expect(result.readySession).toMatchObject({
      provider: "opencode",
      status: "ready",
      model: "openai/gpt-5.4",
    });
    expect(result.readySession?.activeTurnId).toBeUndefined();
    expect(result.events.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "turn.aborted",
    ]);
    expect(
      result.events.every((event) => event.lifecycleGeneration === "generation-opencode-a"),
    ).toBe(true);
    expect(result.events[3]).toMatchObject({
      type: "turn.aborted",
      payload: {
        reason: "Interrupted by user.",
      },
    });
  });

  it("cancels only the exact OpenCode gateway turn and awaits its barrier", async () => {
    const runtime = createMockOpenCodeRuntime();
    let releaseGateway!: () => void;
    const gatewayBarrier = new Promise<void>((resolve) => {
      releaseGateway = resolve;
    });
    const gateway = makeGatewayCredentials({
      cancelSessionTurnRequests: () => gatewayBarrier,
    });
    const threadId = asThreadId("thread-gateway-interrupt");

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* startFullAccess(adapter, threadId);
        const turn = yield* sendTestTurn(adapter, threadId, "wait in the visible browser");

        const interruptFiber = yield* adapter
          .interruptTurn(threadId, turn.turnId)
          .pipe(Effect.forkChild);
        yield* Effect.promise(() =>
          vi.waitFor(() =>
            expect(gateway.cancelledTurns).toEqual([
              { token: "gateway-token-1", turnId: turn.turnId },
            ]),
          ),
        );
        expect(runtime.abortCalls).toContainEqual({ sessionID: "opencode-session-1" });
        expect(interruptFiber.pollUnsafe()).toBeUndefined();

        releaseGateway();
        yield* Fiber.join(interruptFiber);
        const abortCount = runtime.abortCalls.length;
        yield* adapter.interruptTurn(threadId, TurnId.makeUnsafe("stale-turn"));
        expect(runtime.abortCalls).toHaveLength(abortCount);
        expect(gateway.cancelledTurns).toHaveLength(1);
        yield* adapter.stopSession(threadId);
      }).pipe(
        Effect.provide(makeAdapterTestLayer({ runtime: runtime.runtime }, gateway.credentials)),
      ),
    );
  });

  it("replays assistant text when OpenCode sends delta before part snapshot and assistant role", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    routeEventsTo(runtime, eventQueue);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
          Effect.forkChild,
        );

        yield* startFullAccess(adapter, asThreadId("thread-ordered-events"));

        const turn = yield* sendTestTurn(adapter, asThreadId("thread-ordered-events"), "hello");

        eventQueue.push({
          type: "message.part.delta",
          properties: {
            sessionID: "opencode-session-1",
            partID: "part-1",
            delta: "Hello",
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-1",
              messageID: "assistant-message-1",
              type: "text",
              // The cumulative snapshot may already contain the earlier buffered delta.
              text: "Hello",
              time: {
                start: 1,
              },
            },
          },
        });
        eventQueue.push(assistantRoleKnown("assistant-message-1"));
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-1",
              messageID: "assistant-message-1",
              type: "text",
              text: "Hello",
              time: {
                start: 1,
                end: 2,
              },
            },
          },
        });
        eventQueue.push(sessionIdle());

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();

        return { events, turn };
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(result.turn.turnId).toBeDefined();
    expect(result.events.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
    expect(result.events[3]).toMatchObject({
      type: "content.delta",
      payload: {
        streamKind: "assistant_text",
        delta: "Hello",
      },
    });
    expect(result.events[4]).toMatchObject({
      type: "item.completed",
      payload: {
        itemType: "assistant_message",
        detail: "Hello",
      },
    });
  });

  it("keeps a delta buffered after a role-unknown snapshot even when its suffix matches", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    routeEventsTo(runtime, eventQueue);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
          Effect.forkChild,
        );

        yield* startFullAccess(adapter, asThreadId("thread-role-late-delta"));

        yield* sendTestTurn(adapter, asThreadId("thread-role-late-delta"), "hello");

        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-role-late",
              messageID: "assistant-message-role-late",
              type: "text",
              text: "lo",
              time: { start: 1 },
            },
          },
        });
        eventQueue.push({
          type: "message.part.delta",
          properties: {
            sessionID: "opencode-session-1",
            partID: "part-role-late",
            delta: "lo",
          },
        });
        eventQueue.push(assistantRoleKnown("assistant-message-role-late"));
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-role-late",
              messageID: "assistant-message-role-late",
              type: "text",
              text: "lolo",
              time: { start: 1, end: 2 },
            },
          },
        });
        eventQueue.push(sessionIdle());

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
    expect(result[3]).toMatchObject({
      type: "content.delta",
      payload: { streamKind: "assistant_text", delta: "lolo" },
    });
    expect(result[4]).toMatchObject({
      type: "item.completed",
      payload: { itemType: "assistant_message", detail: "lolo" },
    });
  });

  it("filters synthetic and ignored text parts from assistant transcript", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    routeEventsTo(runtime, eventQueue);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
          Effect.forkChild,
        );

        yield* startFullAccess(adapter, asThreadId("thread-synthetic-parts"));

        yield* sendTestTurn(adapter, asThreadId("thread-synthetic-parts"), "hello");

        eventQueue.push(assistantRoleKnown("assistant-message-filtered"));
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-synthetic",
              messageID: "assistant-message-filtered",
              type: "text",
              text: "Initializing snapshot...",
              synthetic: true,
              time: {
                start: 1,
              },
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-ignored",
              messageID: "assistant-message-filtered",
              type: "text",
              text: "Internal warning",
              ignored: true,
              time: {
                start: 2,
              },
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-visible",
              messageID: "assistant-message-filtered",
              type: "text",
              text: "Actual answer",
              time: {
                start: 3,
                end: 4,
              },
            },
          },
        });
        eventQueue.push(sessionIdle());

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
    expect(result[3]).toMatchObject({
      type: "content.delta",
      payload: {
        streamKind: "assistant_text",
        delta: "Actual answer",
      },
    });
    expect(JSON.stringify(result)).not.toContain("Initializing snapshot");
    expect(JSON.stringify(result)).not.toContain("Internal warning");
  });

  it("sends plan-mode prompt instructions and captures tagged markdown as a proposed plan", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    routeEventsTo(runtime, eventQueue);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
          Effect.forkChild,
        );

        yield* startFullAccess(adapter, asThreadId("thread-plan-events"));

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-plan-events"),
          input: "plan this",
          interactionMode: "plan",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push(assistantRoleKnown("assistant-message-plan"));
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-plan",
              messageID: "assistant-message-plan",
              type: "text",
              text: "<proposed_plan>\n# OpenCode plan\n\n- capture it\n</proposed_plan>",
              time: {
                start: 1,
                end: 2,
              },
            },
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(runtime.promptCalls[0]).toMatchObject({ agent: "plan" });
    expect(runtime.promptCalls[0]?.parts).toEqual([
      {
        type: "text",
        text: expect.stringContaining("Synara plan mode is active."),
      },
    ]);
    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "turn.proposed.completed",
      "item.completed",
    ]);
    expect(result[4]).toMatchObject({
      type: "turn.proposed.completed",
      payload: {
        planMarkdown: "# OpenCode plan\n\n- capture it",
      },
    });
  });

  it("projects generic file attachments into text instead of native OpenCode file parts", async () => {
    const runtime = createMockOpenCodeRuntime();

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* startFullAccess(adapter, asThreadId("thread-docx-attachment"));

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-docx-attachment"),
          input: "summarize this",
          interactionMode: "default",
          attachments: [
            {
              type: "file",
              id: "thread-docx-attachment-00000000-0000-4000-8000-000000000001",
              name: "minutes.docx",
              mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              sizeBytes: 4_096,
            },
          ],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    const parts = runtime.promptCalls[0]?.parts as Array<Record<string, unknown>> | undefined;
    expect(parts).toHaveLength(1);
    expect(parts?.[0]).toMatchObject({ type: "text" });
    expect(parts?.[0]?.text).toEqual(expect.stringContaining("<attached_files>"));
    expect(parts?.[0]?.text).toEqual(expect.stringContaining('"minutes.docx"'));
    expect(parts?.[0]?.text).toEqual(
      expect.stringContaining(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    );
    expect(parts?.[0]?.text).toEqual(expect.stringContaining(".docx"));
  });

  it.each([
    ["ignores a stale plan agent option in default interaction mode", "plan", "build"],
    ["preserves an explicitly selected agent", "reviewer", "reviewer"],
  ])("%s", async (_name, selectedAgent, expectedAgent) => {
    const runtime = createMockOpenCodeRuntime();

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-agent-selection");
        yield* startFullAccess(adapter, threadId);
        yield* adapter.sendTurn({
          threadId,
          input: "implement this",
          interactionMode: "default",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
            options: { agent: selectedAgent },
          },
        });
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(runtime.promptCalls[0]).toMatchObject({ agent: expectedAgent });
  });

  it("does not capture tagged markdown as a proposed plan outside plan mode", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    routeEventsTo(runtime, eventQueue);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 5)).pipe(
          Effect.forkChild,
        );

        yield* startFullAccess(adapter, asThreadId("thread-default-tagged-plan"));

        yield* sendTestTurn(
          adapter,
          asThreadId("thread-default-tagged-plan"),
          "show an example tagged block",
        );

        eventQueue.push(assistantRoleKnown("assistant-message-default-plan"));
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-default-plan",
              messageID: "assistant-message-default-plan",
              type: "text",
              text: "<proposed_plan>\n# Not a Synara plan\n</proposed_plan>",
              time: {
                start: 1,
                end: 2,
              },
            },
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
    ]);
    expect(result[4]).toMatchObject({
      type: "item.completed",
      payload: {
        itemType: "assistant_message",
        detail: "<proposed_plan>\n# Not a Synara plan\n</proposed_plan>",
      },
    });
  });

  it("projects context usage once for identical assistant message updates", async () => {
    const sentinelText = "usage-dedup-observation-complete";
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime({
      inventory: makeInventoryWithContextLimit({ contextLimit: 200_000 }),
    });
    routeEventsTo(runtime, eventQueue);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil(
            (event) => event.type === "content.delta" && event.payload.delta === sentinelText,
          ),
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* startFullAccess(adapter, asThreadId("thread-usage-dedup"));

        const turn = yield* sendTestTurn(adapter, asThreadId("thread-usage-dedup"), "count tokens");

        const message = assistantMessageUpdated();
        eventQueue.push(message);
        eventQueue.push(message);
        // This later text proves both usage updates passed through the serial event pump.
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "usage-dedup-sentinel-part",
              messageID: message.properties.info.id,
              type: "text",
              text: sentinelText,
              time: { start: 1 },
            },
          },
        });

        const runtimeEvents = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return { events: runtimeEvents, turn };
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(result.events.at(-1)).toMatchObject({
      type: "content.delta",
      payload: { streamKind: "assistant_text", delta: sentinelText },
    });
    const usageEvents = result.events.filter(
      (event) => event.type === "thread.token-usage.updated",
    );
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      type: "thread.token-usage.updated",
      turnId: result.turn.turnId,
      payload: {
        usage: {
          usedTokens: 245,
          totalProcessedTokens: 245,
          inputTokens: 120,
          cachedInputTokens: 15,
          outputTokens: 80,
          reasoningOutputTokens: 30,
          maxTokens: 200_000,
          lastUsedTokens: 245,
          lastInputTokens: 120,
          lastCachedInputTokens: 15,
          lastOutputTokens: 80,
          lastReasoningOutputTokens: 30,
        },
      },
      raw: {
        source: "opencode.sdk.event",
      },
    });
  });

  it("maps OpenCode todo updates into shared turn tasks", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    routeEventsTo(runtime, eventQueue);

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
          Effect.forkChild,
        );

        yield* startFullAccess(adapter, asThreadId("thread-todo-updated"));

        yield* sendTestTurn(adapter, asThreadId("thread-todo-updated"), "work through todos");

        eventQueue.push({
          type: "todo.updated",
          properties: {
            sessionID: "opencode-session-1",
            todos: [
              { content: "Inspect OpenCode events", status: "completed", priority: "high" },
              { content: "Wire todo updates", status: "in_progress", priority: "medium" },
              { content: "Report back", status: "pending", priority: "low" },
            ],
          },
        });

        const runtimeEvents = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return runtimeEvents;
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    const taskEvent = events.find((event) => event.type === "turn.tasks.updated");
    expect(taskEvent?.type).toBe("turn.tasks.updated");
    if (taskEvent?.type === "turn.tasks.updated") {
      expect(taskEvent.payload.tasks).toEqual([
        { task: "Inspect OpenCode events", status: "completed" },
        { task: "Wire todo updates", status: "inProgress" },
        { task: "Report back", status: "pending" },
      ]);
    }
  });

  it("enforces Plan permissions under full access and restores them for Debug", async () => {
    const runtime = createMockOpenCodeRuntime();

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-plan-permissions");
        yield* startFullAccess(adapter, threadId);
        yield* adapter.sendTurn({
          threadId,
          input: "Plan the change",
          attachments: [],
          interactionMode: "plan",
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        yield* adapter.interruptTurn(threadId);
        yield* adapter.sendTurn({
          threadId,
          input: "Implement the change",
          attachments: [],
          interactionMode: "debug",
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(runtime.updateCalls).toEqual([
      {
        sessionID: "opencode-session-1",
        permission: OPEN_CODE_PLAN_PERMISSION_RULES,
      },
      {
        sessionID: "opencode-session-1",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      },
    ]);
  });

  it("auto-approves a child-session permission before task metadata arrives", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime({
      childrenBySessionId: {
        "opencode-session-1": [{ id: "opencode-child-1" }],
      },
    });
    routeEventsTo(runtime, eventQueue);

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-child-permission");
        yield* startFullAccess(adapter, threadId);
        yield* sendTestTurn(adapter, threadId, "Delegate a read-only check");
        eventQueue.push({
          type: "permission.asked",
          properties: {
            id: "child-permission-1",
            sessionID: "opencode-child-1",
            permission: "external_directory",
            patterns: ["/tmp/**"],
            metadata: {},
            always: [],
          },
        });
        yield* Effect.sleep(20);
        eventQueue.close();
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(runtime.permissionReplyCalls).toContainEqual({
      requestID: "child-permission-1",
      reply: "once",
    });
  });

  it("rejects stale child permissions when resuming a full-access session", async () => {
    const runtime = createMockOpenCodeRuntime({
      childrenBySessionId: {
        "existing-session-1": [{ id: "existing-child-1" }],
      },
      pendingPermissions: [
        {
          id: "resumed-child-permission",
          sessionID: "existing-child-1",
          permission: "bash",
          patterns: ["git status"],
          metadata: {},
          always: [],
        },
      ],
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-resumed-child-permission"),
          runtimeMode: "full-access",
          resumeCursor: { openCodeSessionId: "existing-session-1", cwd: process.cwd() },
        });
        yield* Effect.sleep(20);
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(runtime.permissionReplyCalls).toContainEqual({
      requestID: "resumed-child-permission",
      reply: "reject",
    });
  });

  it("recovers root permissions when child or question discovery fails", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime({
      events: eventQueue.stream,
      children: async () => {
        throw new Error("session.children unavailable");
      },
      pendingPermissions: [
        {
          id: "resumed-root-permission",
          sessionID: "existing-session-1",
          permission: "bash",
          patterns: ["git status"],
          metadata: {},
          always: [],
        },
      ],
      questionList: async () => {
        throw new Error("question.list unavailable");
      },
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-partial-reconciliation"),
          runtimeMode: "full-access",
          resumeCursor: { openCodeSessionId: "existing-session-1", cwd: process.cwd() },
        });
        yield* Effect.sleep(20);
        eventQueue.close();
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(runtime.permissionReplyCalls).toContainEqual({
      requestID: "resumed-root-permission",
      reply: "reject",
    });
  });

  it("fails a full-access turn instead of falling back to a visible approval", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime({
      permissionReply: async () => {
        throw new Error("permission endpoint unavailable");
      },
    });
    routeEventsTo(runtime, eventQueue);

    const eventTypes = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
          Effect.forkChild,
        );
        const threadId = asThreadId("thread-full-access-reply-failure");
        yield* startFullAccess(adapter, threadId);
        yield* sendTestTurn(adapter, threadId, "Run a command");
        eventQueue.push({
          type: "permission.asked",
          properties: {
            id: "permission-failure-1",
            sessionID: "opencode-session-1",
            permission: "bash",
            patterns: ["npm test"],
            metadata: {},
            always: [],
          },
        });
        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events.map((event) => event.type);
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(eventTypes).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "turn.completed",
    ]);
    expect(runtime.abortCalls).toContainEqual({ sessionID: "opencode-session-1" });
  });

  it("auto-approves OpenCode permission asks in full access without surfacing approvals", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    routeEventsTo(runtime, eventQueue);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
          Effect.forkChild,
        );

        yield* startFullAccess(adapter, asThreadId("thread-full-access-permission"));

        yield* sendTestTurn(adapter, asThreadId("thread-full-access-permission"), "hello");

        eventQueue.push({
          id: "evt-permission-asked",
          type: "permission.asked",
          properties: {
            id: "permission-1",
            sessionID: "opencode-session-1",
            permission: "external_directory",
            patterns: ["/outside/project/**"],
            metadata: {},
            always: [],
          },
        });
        eventQueue.push({
          id: "evt-permission-replied",
          type: "permission.replied",
          properties: {
            sessionID: "opencode-session-1",
            requestID: "permission-1",
            reply: "once",
          },
        });
        eventQueue.push({
          id: "evt-next-text-delta",
          type: "session.next.text.delta",
          properties: {
            timestamp: 1,
            sessionID: "opencode-session-1",
            delta: "Hello",
          },
        });
        eventQueue.push({
          id: "evt-next-text-ended",
          type: "session.next.text.ended",
          properties: {
            timestamp: 2,
            sessionID: "opencode-session-1",
            text: "Hello",
          },
        });
        eventQueue.push({
          id: "evt-next-step-ended",
          type: "session.next.step.ended",
          properties: {
            timestamp: 3,
            sessionID: "opencode-session-1",
            finish: "stop",
            cost: 0,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: {
                read: 0,
                write: 0,
              },
            },
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
    expect(result[3]).toMatchObject({
      type: "content.delta",
      payload: { streamKind: "assistant_text", delta: "Hello" },
    });
    expect(result[4]).toMatchObject({
      type: "item.completed",
      payload: { itemType: "assistant_message", detail: "Hello" },
    });
    expect(runtime.permissionReplyCalls).toEqual([{ requestID: "permission-1", reply: "once" }]);
  });

  it("suppresses a permission.replied echo that arrives after turn teardown", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    routeEventsTo(runtime, eventQueue);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 7)).pipe(
          Effect.forkChild,
        );

        yield* startFullAccess(adapter, asThreadId("thread-late-permission-echo"));

        yield* sendTestTurn(adapter, asThreadId("thread-late-permission-echo"), "hello");

        // Auto-approved ask at the tail of the turn; the reply echo has not arrived yet
        // when the turn completes and active-turn state is torn down.
        eventQueue.push({
          id: "evt-permission-asked",
          type: "permission.asked",
          properties: {
            id: "permission-late-1",
            sessionID: "opencode-session-1",
            permission: "external_directory",
            patterns: ["/outside/project/**"],
            metadata: {},
            always: [],
          },
        });
        eventQueue.push({
          id: "evt-next-text-delta",
          type: "session.next.text.delta",
          properties: {
            timestamp: 1,
            sessionID: "opencode-session-1",
            delta: "Hello",
          },
        });
        eventQueue.push({
          id: "evt-next-text-ended",
          type: "session.next.text.ended",
          properties: {
            timestamp: 2,
            sessionID: "opencode-session-1",
            text: "Hello",
          },
        });
        eventQueue.push({
          id: "evt-next-step-ended",
          type: "session.next.step.ended",
          properties: {
            timestamp: 3,
            sessionID: "opencode-session-1",
            finish: "stop",
            cost: 0,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: {
                read: 0,
                write: 0,
              },
            },
          },
        });
        // Late echo after teardown: must be swallowed as the auto-approved reply, not
        // surfaced as a request.resolved for a request the UI never saw opened.
        eventQueue.push({
          id: "evt-late-permission-replied",
          type: "permission.replied",
          properties: {
            sessionID: "opencode-session-1",
            requestID: "permission-late-1",
            reply: "once",
          },
        });
        // A queued question flushes the stream: the queue is FIFO, so its
        // user-input.requested must be the next event, proving the late echo emitted nothing.
        eventQueue.push({
          id: "evt-question-asked",
          type: "question.asked",
          properties: {
            id: "question-1",
            sessionID: "opencode-session-1",
            questions: [
              {
                question: "Proceed?",
                header: "Confirm",
                options: [{ label: "Yes", description: "" }],
                multiple: false,
                custom: false,
              },
            ],
            tool: undefined,
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
      "turn.completed",
      "user-input.requested",
    ]);
    expect(runtime.permissionReplyCalls).toEqual([
      { requestID: "permission-late-1", reply: "once" },
    ]);
  });

  // Permissions outside bash/read/edit used to be classified as "unknown", which
  // maps to no approval kind: the card never rendered and the turn hung forever.
  it.each([
    ["bash", "rm -rf *", "command_execution_approval"],
    ["webfetch", "https://example.com", "tool_approval"],
  ])(
    "surfaces OpenCode %s permission asks as %s approvals in approval-required mode",
    async (permission, pattern, requestType) => {
      const eventQueue = createSubscribedEventQueue();
      const runtime = createMockOpenCodeRuntime();
      routeEventsTo(runtime, eventQueue);

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* OpenCodeAdapter;
          const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
            Effect.forkChild,
          );
          const threadId = asThreadId("thread-approval-required-permission");
          yield* adapter.startSession({
            provider: "opencode",
            threadId,
            runtimeMode: "approval-required",
          });
          yield* sendTestTurn(adapter, threadId, "hello");
          eventQueue.push({
            id: "evt-permission-asked",
            type: "permission.asked",
            properties: {
              id: "permission-1",
              sessionID: "opencode-session-1",
              permission,
              patterns: [pattern],
              metadata: {},
              always: [],
            },
          });
          const events = Array.from(yield* Fiber.join(eventsFiber));
          eventQueue.close();
          return events;
        }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
      );

      expect(result.map((event) => event.type)).toEqual([
        "session.started",
        "thread.started",
        "turn.started",
        "request.opened",
      ]);
      expect(result[3]).toMatchObject({
        type: "request.opened",
        payload: { requestType, detail: pattern },
      });
      expect(runtime.permissionReplyCalls).toEqual([]);
    },
  );

  it("confirms a human permission reply from permission.list and continues the same turn", async () => {
    const eventQueue = createSubscribedEventQueue();
    let replySubmitted = false;
    const runtime = createMockOpenCodeRuntime({
      permissionReply: async () => {
        replySubmitted = true;
        return { data: null };
      },
      permissionList: async () => ({ data: [] }),
    });
    routeEventsTo(runtime, eventQueue);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-human-permission-ack");
        yield* adapter.startSession({
          provider: "opencode",
          threadId,
          runtimeMode: "approval-required",
        });
        yield* sendTestTurn(adapter, threadId, "Search the web");

        const openedFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
          Effect.forkChild,
        );
        eventQueue.push({
          type: "permission.asked",
          properties: {
            id: "permission-human-1",
            sessionID: "opencode-session-1",
            permission: "websearch",
            patterns: ["Synara handoff"],
            metadata: {},
            always: [],
          },
        });
        const opened = Array.from(yield* Fiber.join(openedFiber));

        const continuedFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
          Effect.forkChild,
        );
        yield* adapter.respondToRequest(
          threadId,
          ApprovalRequestId.makeUnsafe("permission-human-1"),
          "accept",
        );
        // The runtime echo may arrive after permission.list already confirmed the reply.
        eventQueue.push({
          type: "permission.replied",
          properties: {
            sessionID: "opencode-session-1",
            requestID: "permission-human-1",
            reply: "once",
          },
        });
        // Reconnect replay can repeat both the reply and the original ask. The settled request id
        // remains guarded for the lifetime of the adapter session, so neither becomes a second UI
        // interaction.
        eventQueue.push({
          type: "permission.asked",
          properties: {
            id: "permission-human-1",
            sessionID: "opencode-session-1",
            permission: "websearch",
            patterns: ["Synara handoff"],
            metadata: {},
            always: [],
          },
        });
        eventQueue.push({
          type: "session.next.text.delta",
          properties: {
            timestamp: 1,
            sessionID: "opencode-session-1",
            delta: "Search complete",
          },
        });
        eventQueue.push({
          type: "session.next.text.ended",
          properties: {
            timestamp: 2,
            sessionID: "opencode-session-1",
            text: "Search complete",
          },
        });
        eventQueue.push({
          type: "session.next.step.ended",
          properties: {
            timestamp: 3,
            sessionID: "opencode-session-1",
            finish: "stop",
            cost: 0,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          },
        });
        const continued = Array.from(yield* Fiber.join(continuedFiber));
        eventQueue.close();
        return [...opened, ...continued];
      }).pipe(
        Effect.provide(
          makeAdapterTestLayer({
            runtime: runtime.runtime,
            permissionReplyAckDelaysMs: [],
          }),
        ),
      ),
    );

    expect(replySubmitted).toBe(true);
    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "request.opened",
      "request.resolved",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
    expect(result.filter((event) => event.type === "request.resolved")).toHaveLength(1);
    expect(result[4]).toMatchObject({
      type: "request.resolved",
      payload: { decision: "accept" },
    });
    expect(runtime.permissionReplyCalls).toEqual([
      { requestID: "permission-human-1", reply: "once" },
    ]);
  });

  it("settles a human permission exactly once when the SSE reply races acknowledgement", async () => {
    const eventQueue = createSubscribedEventQueue();
    let replySubmitted = false;
    let markListStarted: (() => void) | undefined;
    let releaseList: (() => void) | undefined;
    const listStarted = new Promise<void>((resolve) => {
      markListStarted = resolve;
    });
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    const permission = {
      id: "permission-race-1",
      sessionID: "opencode-session-1",
      permission: "bash",
      patterns: ["git status"],
      metadata: {},
      always: [],
    } satisfies PermissionRequest;
    const runtime = createMockOpenCodeRuntime({
      permissionReply: async () => {
        replySubmitted = true;
        return { data: null };
      },
      permissionList: async () => {
        if (!replySubmitted) {
          return { data: [] };
        }
        markListStarted?.();
        await listGate;
        return { data: [permission] };
      },
    });
    routeEventsTo(runtime, eventQueue);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-human-permission-race");
        yield* adapter.startSession({
          provider: "opencode",
          threadId,
          runtimeMode: "approval-required",
        });
        yield* sendTestTurn(adapter, threadId, "Inspect status");
        const openedFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
          Effect.forkChild,
        );
        eventQueue.push({ type: "permission.asked", properties: permission });
        yield* Fiber.join(openedFiber);

        const resolvedFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 1)).pipe(
          Effect.forkChild,
        );
        const responseFiber = yield* adapter
          .respondToRequest(
            threadId,
            ApprovalRequestId.makeUnsafe(permission.id),
            "acceptForSession",
          )
          .pipe(Effect.forkChild);
        yield* Effect.promise(() => listStarted);
        const conflictingResponse = yield* adapter
          .respondToRequest(threadId, ApprovalRequestId.makeUnsafe(permission.id), "decline")
          .pipe(Effect.result);
        eventQueue.push({
          type: "permission.replied",
          properties: {
            sessionID: permission.sessionID,
            requestID: permission.id,
            reply: "always",
          },
        });
        const resolved = Array.from(yield* Fiber.join(resolvedFiber));
        releaseList?.();
        yield* Fiber.join(responseFiber);
        eventQueue.close();
        return { conflictingResponse, resolved };
      }).pipe(
        Effect.provide(
          makeAdapterTestLayer({
            runtime: runtime.runtime,
            permissionReplyAckDelaysMs: [],
          }),
        ),
      ),
    );

    expect(result.conflictingResponse).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "ProviderAdapterRequestError",
        method: "permission.reply",
      },
    });
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]).toMatchObject({
      type: "request.resolved",
      payload: { decision: "acceptForSession" },
    });
    expect(runtime.permissionReplyCalls).toEqual([{ requestID: permission.id, reply: "always" }]);
  });

  it("does not block session teardown when permission resolution backpressure is interrupted", async () => {
    const eventQueue = createSubscribedEventQueue();
    const permission = {
      id: "permission-backpressure-1",
      sessionID: "opencode-session-1",
      permission: "bash",
      patterns: ["git status"],
      metadata: {},
      always: [],
    } satisfies PermissionRequest;
    const runtime = createMockOpenCodeRuntime();
    routeEventsTo(runtime, eventQueue);

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-human-permission-backpressure");
        const openedFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
          Effect.forkChild,
        );
        yield* adapter.startSession({
          provider: "opencode",
          threadId,
          runtimeMode: "approval-required",
        });
        yield* sendTestTurn(adapter, threadId, "Inspect status");
        eventQueue.push({ type: "permission.asked", properties: permission });
        yield* Fiber.join(openedFiber);

        // Fill the one-slot runtime event queue, then let permission.replied block on the next
        // offer. Layer teardown must still interrupt the session event pump.
        eventQueue.push({
          type: "session.next.text.delta",
          properties: {
            timestamp: 1,
            sessionID: permission.sessionID,
            delta: "queued",
          },
        });
        eventQueue.push({
          type: "permission.replied",
          properties: {
            sessionID: permission.sessionID,
            requestID: permission.id,
            reply: "once",
          },
        });
        yield* Effect.sleep(25);
      }).pipe(
        Effect.provide(
          makeAdapterTestLayer({
            runtime: runtime.runtime,
            runtimeEventBufferCapacity: 1,
          }),
        ),
        Effect.timeout("1 second"),
      ),
    );

    expect(exit).toMatchObject({ _tag: "Success" });
  });

  it.each(["still lists the permission", "fails to list permissions"] as const)(
    "keeps a permission actionable when acknowledgement %s",
    async (ackProblem) => {
      const eventQueue = createSubscribedEventQueue();
      let replySubmitted = false;
      let ackBroken = true;
      const permission = {
        id: "permission-ack-failure-1",
        sessionID: "opencode-session-1",
        permission: "bash",
        patterns: ["git status"],
        metadata: {},
        always: [],
      } satisfies PermissionRequest;
      const runtime = createMockOpenCodeRuntime({
        permissionReply: async () => {
          replySubmitted = true;
          return { data: null };
        },
        permissionList: async () => {
          if (replySubmitted && ackBroken) {
            if (ackProblem === "fails to list permissions") {
              throw new Error("permission.list unavailable");
            }
            return { data: [permission] };
          }
          return { data: [] };
        },
      });
      routeEventsTo(runtime, eventQueue);

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* OpenCodeAdapter;
          const threadId = asThreadId("thread-human-permission-ack-failure");
          yield* adapter.startSession({
            provider: "opencode",
            threadId,
            runtimeMode: "approval-required",
          });
          yield* sendTestTurn(adapter, threadId, "Inspect status");
          const openedFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
            Effect.forkChild,
          );
          eventQueue.push({ type: "permission.asked", properties: permission });
          yield* Fiber.join(openedFiber);

          const firstResponse = yield* adapter
            .respondToRequest(threadId, ApprovalRequestId.makeUnsafe(permission.id), "accept")
            .pipe(Effect.result);
          ackBroken = false;
          const resolvedFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 1)).pipe(
            Effect.forkChild,
          );
          yield* adapter.respondToRequest(
            threadId,
            ApprovalRequestId.makeUnsafe(permission.id),
            "accept",
          );
          const resolved = Array.from(yield* Fiber.join(resolvedFiber));
          eventQueue.close();
          return { firstResponse, resolved };
        }).pipe(
          Effect.provide(
            makeAdapterTestLayer({ runtime: runtime.runtime, permissionReplyAckDelaysMs: [] }),
          ),
        ),
      );

      expect(result.firstResponse._tag).toBe("Failure");
      if (result.firstResponse._tag === "Failure") {
        expect(result.firstResponse.failure).toMatchObject({
          _tag: "ProviderAdapterRequestError",
          method: "permission.reply.acknowledge",
        });
      }
      expect(result.resolved).toHaveLength(1);
      expect(result.resolved[0]?.type).toBe("request.resolved");
      expect(runtime.permissionReplyCalls).toEqual([
        { requestID: permission.id, reply: "once" },
        { requestID: permission.id, reply: "once" },
      ]);
    },
  );

  it("keeps newer OpenCode tool-call steps attached to the active turn", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    routeEventsTo(runtime, eventQueue);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
          Effect.forkChild,
        );

        yield* startFullAccess(adapter, asThreadId("thread-next-tool-call"));

        yield* sendTestTurn(adapter, asThreadId("thread-next-tool-call"), "inspect files");

        eventQueue.push({
          id: "evt-next-step-tool-calls",
          type: "session.next.step.ended",
          properties: {
            timestamp: 3,
            sessionID: "opencode-session-1",
            finish: "tool-calls",
            cost: 0.01,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: {
                read: 0,
                write: 0,
              },
            },
          },
        });
        eventQueue.push({
          id: "evt-next-tool-called",
          type: "session.next.tool.called",
          properties: {
            timestamp: 4,
            sessionID: "opencode-session-1",
            callID: "tool-call-1",
            tool: "read",
            input: {
              filePath: "README.md",
            },
            provider: {
              executed: true,
            },
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "item.started",
    ]);
    expect(result[3]).toMatchObject({
      type: "item.started",
      turnId: result[2]?.turnId,
      payload: {
        itemType: "dynamic_tool_call",
        status: "inProgress",
      },
    });
  });

  it("forwards OpenCode child-session tool activity created by task parts", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    routeEventsTo(runtime, eventQueue);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 5)).pipe(
          Effect.forkChild,
        );

        yield* startFullAccess(adapter, asThreadId("thread-child-session-tools"));

        yield* sendTestTurn(adapter, asThreadId("thread-child-session-tools"), "inspect files");

        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "parent-task-part",
              messageID: "assistant-message-1",
              type: "tool",
              tool: "task",
              callID: "task-call-1",
              state: {
                status: "running",
                title: "\nFind changelog implementation\n",
                input: {
                  description: "Find changelog implementation",
                  prompt: "Explore changelog files.",
                },
                metadata: {
                  sessionId: "child-session-1",
                  parentSessionId: "opencode-session-1",
                },
                time: {
                  start: 1,
                },
              },
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "child-session-1",
            part: {
              id: "child-grep-part",
              messageID: "child-assistant-message-1",
              type: "tool",
              tool: "grep",
              callID: "grep-call-1",
              state: {
                status: "completed",
                input: {
                  pattern: "changelog",
                },
                output: "Found 18 matches",
                time: {
                  start: 2,
                  end: 3,
                },
              },
            },
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "item.updated",
      "item.completed",
    ]);
    expect(result[3]).toMatchObject({
      type: "item.updated",
      payload: {
        itemType: "collab_agent_tool_call",
        status: "inProgress",
        title: "Find changelog implementation",
      },
    });
    expect(result[4]).toMatchObject({
      type: "item.completed",
      turnId: result[2]?.turnId,
      payload: {
        itemType: "dynamic_tool_call",
        status: "completed",
        detail: "Found 18 matches",
      },
    });
  });

  it("projects newer OpenCode shell step events as command executions", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    routeEventsTo(runtime, eventQueue);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 5)).pipe(
          Effect.forkChild,
        );

        yield* startFullAccess(adapter, asThreadId("thread-next-shell"));

        yield* sendTestTurn(adapter, asThreadId("thread-next-shell"), "inspect files");

        eventQueue.push({
          id: "evt-next-shell-started",
          type: "session.next.shell.started",
          properties: {
            timestamp: 4,
            sessionID: "opencode-session-1",
            callID: "shell-call-1",
            command: "cat package.json | grep next",
          },
        });
        eventQueue.push({
          id: "evt-next-shell-ended",
          type: "session.next.shell.ended",
          properties: {
            timestamp: 5,
            sessionID: "opencode-session-1",
            callID: "shell-call-1",
            output: '"next": "15.5.0"',
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(Effect.provide(makeOpenCodeAdapterTestLayer(runtime.runtime))),
    );

    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "item.started",
      "item.completed",
    ]);
    expect(result[3]).toMatchObject({
      type: "item.started",
      payload: {
        itemType: "command_execution",
        status: "inProgress",
        detail: "cat package.json | grep next",
        data: {
          command: "cat package.json | grep next",
        },
      },
    });
    expect(result[4]).toMatchObject({
      type: "item.completed",
      payload: {
        itemType: "command_execution",
        status: "completed",
        detail: '"next": "15.5.0"',
        data: {
          output: '"next": "15.5.0"',
        },
      },
    });
  });

  it("starts and sends a turn while optional model inventory is stalled", async () => {
    const runtime = createMockOpenCodeRuntime();
    let inventoryCancelled = false;
    const stalledRuntime = {
      ...runtime.runtime,
      loadOpenCodeInventory: () =>
        Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              inventoryCancelled = true;
            }),
          ),
        ),
    };

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        return yield* Effect.gen(function* () {
          const session = yield* startFullAccess(adapter, asThreadId("thread-stalled-inventory"));
          const turn = yield* sendTestTurn(adapter, session.threadId, "hello");
          yield* adapter.stopSession(session.threadId);
          return { session, turn };
        }).pipe(Effect.timeoutOption("1 second"));
      }).pipe(Effect.provide(makeAdapterTestLayer({ runtime: stalledRuntime }))),
    );

    expect(Option.isSome(result)).toBe(true);
    expect(runtime.promptCalls).toHaveLength(1);
    expect(inventoryCancelled).toBe(true);
  });

  it("does not block sendTurn when the OpenCode prompt request stalls during startup", async () => {
    const runtime = createMockOpenCodeRuntime({
      promptAsync: async () => await new Promise(() => {}),
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 3)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-stalled-prompt-async"),
          runtimeMode: "full-access",
        });

        const turnReturned = yield* adapter
          .sendTurn({
            threadId: asThreadId("thread-stalled-prompt-async"),
            input: "hello",
            attachments: [],
            modelSelection: {
              provider: "opencode",
              model: "opencode/claude-opus-4-7",
            },
          })
          .pipe(
            Effect.timeoutOption(50),
            Effect.map((turnOption) => turnOption._tag === "Some"),
          );

        const events = Array.from(yield* Fiber.join(eventsFiber));
        return { events, turnReturned };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            promptSubmissionInlineWaitMs: 1,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.turnReturned).toBe(true);
    expect(runtime.promptCalls).toHaveLength(1);
    expect(result.events.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
    ]);
  });

  it("keeps immediate OpenCode prompt failures on the sendTurn failure path", async () => {
    const runtime = createMockOpenCodeRuntime({
      promptAsync: async () => {
        throw new Error("prompt rejected");
      },
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-rejected-prompt-async"),
          runtimeMode: "full-access",
        });

        const sendExit = yield* Effect.exit(
          adapter.sendTurn({
            threadId: asThreadId("thread-rejected-prompt-async"),
            input: "hello",
            attachments: [],
            modelSelection: {
              provider: "opencode",
              model: "opencode/claude-opus-4-7",
            },
          }),
        );

        const events = Array.from(yield* Fiber.join(eventsFiber));
        return { events, sendFailed: sendExit._tag === "Failure" };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            promptSubmissionInlineWaitMs: 50,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.sendFailed).toBe(true);
    expect(result.events.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "turn.aborted",
    ]);
    expect(result.events[3]).toMatchObject({
      type: "turn.aborted",
      payload: {
        reason: "prompt rejected",
      },
    });
  });

  it("treats OpenCode session.idle as turn completion", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const gateway = makeGatewayCredentials();
    routeEventsTo(runtime, eventQueue);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-session-idle"),
          runtimeMode: "full-access",
        });

        const turn = yield* adapter.sendTurn({
          threadId: asThreadId("thread-session-idle"),
          input: "hello",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "msg-session-idle",
              role: "assistant",
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-session-idle",
              messageID: "msg-session-idle",
              type: "text",
              text: "done",
              time: {
                start: 1,
                end: 2,
              },
            },
          },
        });
        eventQueue.push({
          id: "evt-session-idle",
          type: "session.idle",
          properties: {
            sessionID: "opencode-session-1",
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return { events, turn };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provide(Layer.succeed(AgentGatewayCredentials, gateway.credentials)),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.events.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
    expect(gateway.cancelledTurns).toEqual([
      { token: "gateway-token-1", turnId: result.turn.turnId },
    ]);
  });

  it("recovers final parts before settling an early idle", async () => {
    const eventQueue = createSubscribedEventQueue();
    let messageFetchCount = 0;
    let messageSnapshot: Array<{ info: Record<string, unknown>; parts: Part[] }> = [];
    const runtime = createMockOpenCodeRuntime({
      messages: async () => {
        messageFetchCount += 1;
        return { data: messageSnapshot };
      },
    });
    routeEventsTo(runtime, eventQueue);

    const eventTypes = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
          Effect.forkChild,
        );
        const threadId = asThreadId("thread-early-idle-final-assistant");

        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({
          threadId,
          input: "hello",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });

        messageSnapshot = [
          {
            info: {
              id: "msg-early-idle",
              role: "assistant",
              finish: "stop",
              time: { completed: 2 },
            },
            parts: [
              {
                id: "part-early-idle",
                messageID: "msg-early-idle",
                type: "text",
                text: "done",
                time: { start: 1, end: 2 },
              } as Part,
            ],
          },
        ];

        eventQueue.push({
          type: "session.idle",
          properties: { sessionID: "opencode-session-1" },
        });
        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "msg-early-idle",
              role: "assistant",
              finish: "stop",
              time: { completed: 2 },
            },
          },
        });
        // The stream part arrives after the grace period. Synara must first
        // recover the provider snapshot, then ignore this duplicate late event.
        yield* Effect.sleep(30);
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-early-idle",
              messageID: "msg-early-idle",
              type: "text",
              text: "done",
              time: { start: 1, end: 2 },
            },
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events.map((event) => event.type);
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            prematureIdleCompletionGraceMs: 20,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(eventTypes).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
    expect(messageFetchCount).toBeGreaterThanOrEqual(2);
  });

  it("recovers delayed parts when final metadata arrives before idle", async () => {
    const eventQueue = createSubscribedEventQueue();
    let messageFetchCount = 0;
    const runtime = createMockOpenCodeRuntime({
      messages: async () => {
        messageFetchCount += 1;
        return {
          data:
            messageFetchCount === 1
              ? []
              : [
                  {
                    info: {
                      id: "msg-final-before-parts",
                      role: "assistant",
                      finish: "stop",
                      time: { completed: 2 },
                    },
                    // OpenCode can expose final metadata before persisting parts.
                    parts: [],
                  },
                ],
        };
      },
    });
    routeEventsTo(runtime, eventQueue);

    const eventTypes = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
          Effect.forkChild,
        );
        const threadId = asThreadId("thread-final-before-parts");

        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({
          threadId,
          input: "hello",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });

        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "msg-final-before-parts",
              role: "assistant",
              finish: "stop",
              time: { completed: 2 },
            },
          },
        });
        eventQueue.push({
          type: "session.idle",
          properties: { sessionID: "opencode-session-1" },
        });

        // The first recovery sees final metadata with no parts. The late SSE
        // part must still be emitted before the turn completes.
        yield* Effect.sleep(30);
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-final-before-parts",
              messageID: "msg-final-before-parts",
              type: "text",
              text: "done",
              time: { start: 1, end: 2 },
            },
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events.map((event) => event.type);
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            prematureIdleCompletionGraceMs: 20,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(eventTypes).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
    expect(messageFetchCount).toBeGreaterThanOrEqual(2);
  });

  it("waits for every late final-message part before completing a plan turn", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime({
      // Exercise the event-stream fallback: OpenCode's read model may still lag
      // while several final text parts are arriving over SSE.
      messages: async () => ({ data: [] }),
    });
    routeEventsTo(runtime, eventQueue);

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 9)).pipe(
          Effect.forkChild,
        );
        const threadId = asThreadId("thread-late-multipart-plan");

        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({
          threadId,
          input: "plan this",
          interactionMode: "plan",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });

        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "msg-late-multipart-plan",
              role: "assistant",
              finish: "stop",
              time: { completed: 3 },
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-late-multipart-preamble",
              messageID: "msg-late-multipart-plan",
              type: "text",
              text: "I prepared the implementation plan.",
              time: { start: 1, end: 2 },
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-late-multipart-plan",
              messageID: "msg-late-multipart-plan",
              type: "text",
              text: "<proposed_plan>\n# Complete plan\n\n- implement it\n</proposed_plan>",
              time: { start: 2 },
            },
          },
        });
        eventQueue.push({
          type: "session.idle",
          properties: { sessionID: "opencode-session-1" },
        });

        yield* Effect.sleep(10);
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-late-multipart-plan",
              messageID: "msg-late-multipart-plan",
              type: "text",
              text: "<proposed_plan>\n# Complete plan\n\n- implement it\n</proposed_plan>",
              time: { start: 2, end: 3 },
            },
          },
        });

        const collected = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return collected;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            prematureIdleCompletionGraceMs: 20,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
      "content.delta",
      "turn.proposed.completed",
      "item.completed",
      "turn.completed",
    ]);
    expect(events[6]).toMatchObject({
      type: "turn.proposed.completed",
      payload: { planMarkdown: "# Complete plan\n\n- implement it" },
    });
  });

  it("does not recover a final snapshot until all assistant text parts are complete", async () => {
    const eventQueue = createSubscribedEventQueue();
    let messageSnapshot: Array<{ info: Record<string, unknown>; parts: Part[] }> = [];
    const runtime = createMockOpenCodeRuntime({
      messages: async () => ({ data: messageSnapshot }),
    });
    routeEventsTo(runtime, eventQueue);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 9)).pipe(
          Effect.forkChild,
        );
        const threadId = asThreadId("thread-mixed-final-snapshot");

        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({
          threadId,
          input: "plan this",
          interactionMode: "plan",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });

        const finalInfo = {
          id: "msg-mixed-final-snapshot",
          role: "assistant",
          finish: "stop",
          time: { completed: 3 },
        };
        const preamblePart = {
          id: "part-mixed-final-preamble",
          messageID: "msg-mixed-final-snapshot",
          type: "text",
          text: "I prepared the implementation plan.",
          time: { start: 1, end: 2 },
        } as Part;
        const planText = "<proposed_plan>\n# Snapshot plan\n\n- implement it\n</proposed_plan>";
        messageSnapshot = [
          {
            info: finalInfo,
            parts: [
              preamblePart,
              {
                id: "part-mixed-final-plan",
                messageID: "msg-mixed-final-snapshot",
                type: "text",
                text: planText,
                time: { start: 2 },
              } as Part,
            ],
          },
        ];

        eventQueue.push({
          type: "message.updated",
          properties: { sessionID: "opencode-session-1", info: finalInfo },
        });
        eventQueue.push({
          type: "session.idle",
          properties: { sessionID: "opencode-session-1" },
        });

        // The first recovery sees one complete part and one open part. The turn
        // must remain running until the provider snapshot closes the latter.
        yield* Effect.sleep(30);
        const [sessionWhilePlanPartOpen] = yield* adapter.listSessions();
        messageSnapshot = [
          {
            info: finalInfo,
            parts: [
              preamblePart,
              {
                id: "part-mixed-final-plan",
                messageID: "msg-mixed-final-snapshot",
                type: "text",
                text: planText,
                time: { start: 2, end: 3 },
              } as Part,
            ],
          },
        ];

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return { events, sessionWhilePlanPartOpen };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            prematureIdleCompletionGraceMs: 20,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.sessionWhilePlanPartOpen?.status).toBe("running");
    expect(result.events.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
      "content.delta",
      "turn.proposed.completed",
      "item.completed",
      "turn.completed",
    ]);
    expect(result.events[6]).toMatchObject({
      type: "turn.proposed.completed",
      payload: { planMarkdown: "# Snapshot plan\n\n- implement it" },
    });
  });

  it("does not let stale recovery complete a newer turn", async () => {
    const eventQueue = createSubscribedEventQueue();
    let messageFetchCount = 0;
    let startRecovery: (() => void) | undefined;
    let resolveRecovery:
      | ((value: { data: Array<{ info: Record<string, unknown>; parts: Part[] }> }) => void)
      | undefined;
    const recoveryStarted = new Promise<void>((resolve) => {
      startRecovery = resolve;
    });
    const runtime = createMockOpenCodeRuntime({
      messages: async () => {
        messageFetchCount += 1;
        if (messageFetchCount !== 2) {
          return { data: [] };
        }
        startRecovery?.();
        return await new Promise((resolve) => {
          resolveRecovery = resolve;
        });
      },
    });
    routeEventsTo(runtime, eventQueue);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 5)).pipe(
          Effect.forkChild,
        );
        const threadId = asThreadId("thread-stale-recovery");

        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        const firstTurn = yield* adapter.sendTurn({
          threadId,
          input: "first",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        eventQueue.push({
          type: "session.idle",
          properties: { sessionID: "opencode-session-1" },
        });
        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "msg-stale-recovery",
              role: "assistant",
              finish: "stop",
              time: { completed: 2 },
            },
          },
        });

        yield* Effect.promise(() => recoveryStarted);
        yield* adapter.interruptTurn(threadId, firstTurn.turnId);
        const secondTurn = yield* adapter.sendTurn({
          threadId,
          input: "second",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });

        yield* Effect.sync(() => {
          resolveRecovery?.({
            data: [
              {
                info: {
                  id: "msg-stale-recovery",
                  role: "assistant",
                  finish: "stop",
                  time: { completed: 2 },
                },
                parts: [
                  {
                    id: "part-stale-recovery",
                    messageID: "msg-stale-recovery",
                    type: "text",
                    text: "obsolete",
                    time: { start: 1, end: 2 },
                  } as Part,
                ],
              },
            ],
          });
        });
        yield* Effect.sleep(10);

        const [session] = yield* adapter.listSessions();
        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return { events, secondTurn, session };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            prematureIdleCompletionGraceMs: 5,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.events.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "turn.aborted",
      "turn.started",
    ]);
    expect(result.session).toMatchObject({
      status: "running",
      activeTurnId: result.secondTurn.turnId,
    });
  });
});

describe("OpenCode incremental text assembly", () => {
  it("preserves coincidental suffix/prefix overlap in raw provider deltas", () => {
    expect(appendOpenCodeAssistantTextDelta("reset", "ting")).toEqual({
      nextText: "resetting",
      deltaToEmit: "ting",
    });
    expect(appendOpenCodeAssistantTextDelta("plan", "ning")).toEqual({
      nextText: "planning",
      deltaToEmit: "ning",
    });
    expect(appendOpenCodeAssistantTextDelta("lo", "ose")).toEqual({
      nextText: "loose",
      deltaToEmit: "ose",
    });
  });
});

function pushOpenCodePart(
  eventQueue: ReturnType<typeof createSubscribedEventQueue>,
  part: Part,
  sessionID = "opencode-session-1",
) {
  eventQueue.push({
    type: "message.part.updated",
    properties: { sessionID, part },
  });
}

describe("OpenCode background subagent tasks", () => {
  function backgroundTaskToolPart(taskId: string): Part {
    return {
      id: `part-task-${taskId}`,
      messageID: "assistant-message-task",
      sessionID: "opencode-session-1",
      type: "tool",
      tool: "task",
      callID: `call-${taskId}`,
      state: {
        status: "completed",
        title: "Explore the codebase",
        input: {
          description: "Explore the codebase",
          prompt: "Find where sessions are stored",
          subagent_type: "explore",
        },
        output: `<task id="${taskId}" state="running"><summary>Background task started</summary><task_result></task_result></task>`,
        metadata: {
          parentSessionId: "opencode-session-1",
          sessionId: taskId,
          model: "openai/gpt-5.4",
          background: true,
          jobId: taskId,
        },
        time: { start: 1, end: 2 },
      },
    } as unknown as Part;
  }

  async function runWithAdapter<A, E>(
    runtime: ReturnType<typeof createMockOpenCodeRuntime>,
    eventQueue: ReturnType<typeof createSubscribedEventQueue>,
    program: (adapter: OpenCodeAdapterShape, threadId: ThreadId) => Effect.Effect<A, E>,
  ): Promise<A> {
    routeEventsTo(runtime, eventQueue);
    return await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        return yield* program(adapter, asThreadId("thread-background-tasks"));
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );
  }

  const taskEventTypes = new Set(["task.started", "task.updated", "task.completed"]);
  const onlyTaskEvents = (event: { readonly type: string }) => taskEventTypes.has(event.type);

  it("emits task.started and task.updated(isBackgrounded) once for a background task tool call", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();

    const events = await runWithAdapter(runtime, eventQueue, (adapter, threadId) =>
      Effect.gen(function* () {
        const eventsFiber = yield* Stream.runCollect(
          Stream.take(Stream.filter(adapter.streamEvents, onlyTaskEvents), 3),
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          provider: "opencode",
          threadId,
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({
          threadId,
          input: "spawn a background agent",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });

        const part = backgroundTaskToolPart("child-session-1");
        pushOpenCodePart(eventQueue, part);
        // OpenCode re-invokes the tool for a still-running child and returns a
        // "Background task updated" result; it must not re-emit task.started.
        pushOpenCodePart(eventQueue, {
          ...part,
          id: "part-task-duplicate",
          callID: "call-duplicate",
          state: {
            ...((part as { state?: Record<string, unknown> }).state ?? {}),
            output:
              '<task id="child-session-1" state="running"><summary>Background task updated</summary></task>',
          },
        } as unknown as Part);

        // Settle via the child session going idle.
        eventQueue.push({
          type: "session.idle",
          properties: { sessionID: "child-session-1" },
        });

        const collected = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return collected;
      }),
    );

    expect(events.map((event) => event.type)).toEqual([
      "task.started",
      "task.updated",
      "task.completed",
    ]);
    expect(events[0]).toMatchObject({
      payload: {
        taskId: "child-session-1",
        description: "Explore the codebase",
        taskType: "subagent",
        subagentType: "explore",
        toolUseId: "call-child-session-1",
      },
    });
    expect(events[1]).toMatchObject({
      payload: {
        taskId: "child-session-1",
        status: "running",
        isBackgrounded: true,
        toolUseId: "call-child-session-1",
      },
    });
    expect(events[2]).toMatchObject({
      payload: { taskId: "child-session-1", status: "completed" },
    });
  });

  it("settles the background task on child session.idle without completing the parent turn", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();

    const events = await runWithAdapter(runtime, eventQueue, (adapter, threadId) =>
      Effect.gen(function* () {
        const eventsFiber = yield* Stream.runCollect(
          Stream.take(
            Stream.filter(
              adapter.streamEvents,
              (event) => event.type === "task.completed" || event.type === "turn.completed",
            ),
            2,
          ),
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          provider: "opencode",
          threadId,
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({
          threadId,
          input: "spawn a background agent",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });

        pushOpenCodePart(eventQueue, backgroundTaskToolPart("child-session-1"));

        // Assistant text + completion so the parent turn is genuinely settled
        // only by its own idle signal.
        pushOpenCodePart(eventQueue, {
          id: "part-text-1",
          messageID: "assistant-message-1",
          sessionID: "opencode-session-1",
          type: "text",
          text: "Spawned it.",
          time: { start: 1 },
        } as unknown as Part);
        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: { id: "assistant-message-1", role: "assistant" },
          },
        });
        pushOpenCodePart(eventQueue, {
          id: "part-text-1",
          messageID: "assistant-message-1",
          sessionID: "opencode-session-1",
          type: "text",
          text: "Spawned it.",
          time: { start: 1, end: 2 },
        } as unknown as Part);

        // The child's idle arrives before the parent's; it must not settle the turn.
        eventQueue.push({
          type: "session.idle",
          properties: { sessionID: "child-session-1" },
        });
        eventQueue.push({
          type: "session.status",
          properties: { sessionID: "opencode-session-1", status: { type: "idle" } },
        });

        const collected = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return collected;
      }),
    );

    expect(events.map((event) => event.type)).toEqual(["task.completed", "turn.completed"]);
    expect(events[0]).toMatchObject({
      payload: { taskId: "child-session-1", status: "completed" },
    });
    expect(events[1]).toMatchObject({ payload: { state: "completed" } });
  });

  it("tracks a resumed background child after its previous task settled", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();

    const events = await runWithAdapter(runtime, eventQueue, (adapter, threadId) =>
      Effect.gen(function* () {
        const resumedToolCompleted = yield* Deferred.make<void>();
        const eventsFiber = yield* Stream.runCollect(
          adapter.streamEvents.pipe(
            Stream.tap((event) =>
              event.type === "item.completed" && event.itemId === "call-resumed"
                ? Deferred.succeed(resumedToolCompleted, undefined)
                : Effect.void,
            ),
            Stream.takeUntil((event) => event.type === "session.exited"),
          ),
        ).pipe(Effect.forkChild);
        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({
          threadId,
          input: "spawn and resume a background agent",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        const part = backgroundTaskToolPart("child-session-1");
        pushOpenCodePart(eventQueue, part);
        eventQueue.push({ type: "session.idle", properties: { sessionID: "child-session-1" } });
        // task_id resumes the same OpenCode session and reuses its job ID,
        // while this tool invocation has a new call ID.
        pushOpenCodePart(eventQueue, {
          ...part,
          id: "part-resumed",
          callID: "call-resumed",
        } as Part);
        yield* Deferred.await(resumedToolCompleted);
        yield* adapter.stopSession(threadId);
        const collected = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return collected.filter(onlyTaskEvents);
      }),
    );

    expect(events.map((event) => event.type)).toEqual([
      "task.started",
      "task.updated",
      "task.completed",
      "task.started",
      "task.updated",
      "task.completed",
    ]);
    expect(events[3]).toMatchObject({
      payload: { taskId: "child-session-1", toolUseId: "call-resumed" },
    });
    expect(events[4]).toMatchObject({ payload: { status: "running", isBackgrounded: true } });
    expect(events[5]).toMatchObject({ payload: { status: "stopped" } });
  });

  it("preserves a background failure reported after the child went idle", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const events = await runWithAdapter(runtime, eventQueue, (adapter, threadId) =>
      Effect.gen(function* () {
        const eventsFiber = yield* Stream.runCollect(
          Stream.takeUntil(
            adapter.streamEvents,
            (event) => event.type === "item.completed" && event.itemId === "call-marker",
          ),
        ).pipe(Effect.forkChild);
        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({
          threadId,
          input: "spawn a background agent",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        const part = backgroundTaskToolPart("child-session-1");
        pushOpenCodePart(eventQueue, part);
        // OpenCode marks the child idle before task.ts inspects its final
        // assistant/tool result and injects the authoritative error result.
        eventQueue.push({ type: "session.idle", properties: { sessionID: "child-session-1" } });
        pushOpenCodePart(eventQueue, {
          id: "part-late-error",
          messageID: "user-late-error",
          sessionID: "opencode-session-1",
          type: "text",
          synthetic: true,
          text: '<task id="child-session-1" state="error"><summary>Background task failed: tool error</summary></task>',
          time: { start: 1 },
        } as Part);
        pushOpenCodePart(eventQueue, {
          ...part,
          id: "part-marker",
          callID: "call-marker",
          tool: "read",
        } as Part);
        const collected = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return collected.filter((event) => event.type === "task.completed");
      }),
    );
    expect(events.at(-1)).toMatchObject({
      payload: {
        taskId: "child-session-1",
        status: "failed",
        summary: "Background task failed: tool error",
      },
    });
  });

  it("settles background tasks before replacing their provider session", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();

    const events = await runWithAdapter(runtime, eventQueue, (adapter, threadId) =>
      Effect.gen(function* () {
        const startedFiber = yield* Stream.runCollect(
          Stream.take(Stream.filter(adapter.streamEvents, onlyTaskEvents), 2),
        ).pipe(Effect.forkChild);
        const input = {
          provider: "opencode" as const,
          threadId,
          runtimeMode: "full-access" as const,
        };
        yield* adapter.startSession(input);
        yield* adapter.sendTurn({
          threadId,
          input: "spawn a background agent",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        pushOpenCodePart(eventQueue, backgroundTaskToolPart("child-session-1"));
        yield* Fiber.join(startedFiber);

        const replacedFiber = yield* Stream.runCollect(
          Stream.takeUntil(adapter.streamEvents, (event) => event.type === "session.started"),
        ).pipe(Effect.forkChild);
        yield* adapter.startSession(input);
        const collected = Array.from(yield* Fiber.join(replacedFiber));
        eventQueue.close();
        return collected.filter(onlyTaskEvents);
      }),
    );

    expect(events).toMatchObject([
      { type: "task.completed", payload: { taskId: "child-session-1", status: "stopped" } },
    ]);
  });

  it("settles unsettled background tasks as stopped on session teardown", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();

    const events = await runWithAdapter(runtime, eventQueue, (adapter, threadId) =>
      Effect.gen(function* () {
        const startedFiber = yield* Stream.runCollect(
          Stream.take(Stream.filter(adapter.streamEvents, onlyTaskEvents), 2),
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          provider: "opencode",
          threadId,
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({
          threadId,
          input: "spawn a background agent",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        pushOpenCodePart(eventQueue, backgroundTaskToolPart("child-session-1"));

        const started = Array.from(yield* Fiber.join(startedFiber));
        expect(started.map((event) => event.type)).toEqual(["task.started", "task.updated"]);

        const settledFiber = yield* Stream.runCollect(
          Stream.take(
            Stream.filter(adapter.streamEvents, (event) => event.type === "task.completed"),
            1,
          ),
        ).pipe(Effect.forkChild);
        yield* adapter.stopSession(threadId);

        const settled = Array.from(yield* Fiber.join(settledFiber));
        eventQueue.close();
        return settled;
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      payload: { taskId: "child-session-1", status: "stopped" },
    });
  });
});
