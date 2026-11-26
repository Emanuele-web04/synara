import * as NodeServices from "@effect/platform-node/NodeServices";
import type * as Acp from "@agentclientprotocol/sdk";
import {
  ApprovalRequestId,
  CommandId,
  MessageId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@synara/contracts";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  PlatformError,
  Queue,
  Scope,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config";
import {
  AgentGatewayCredentials,
  type AgentGatewayCredentialsShape,
} from "../../agentGateway/Services/AgentGatewayCredentials";
import * as AcpErrors from "../acp/AcpErrors";
import type { AcpParsedSessionEvent, AcpToolCallState } from "../acp/AcpRuntimeModel";
import {
  type AntigravityAcpRuntimeInput,
  makeAntigravityAcpRuntime,
} from "../acp/AntigravityAcpSupport";
import type { AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime";
import { makeFakeAcpSessionRuntime } from "../acp/testing/fakeAcpSessionRuntime";
import {
  createBoundedProcessOutput,
  parseAntigravityCliModelLabel,
  parseAntigravityModelLines,
  resolveAntigravityCliModelLabel,
} from "../antigravityCli";
import { AntigravityAdapter } from "../Services/AntigravityAdapter";
import { PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY } from "../Services/ProviderAdapter";
import {
  type AntigravityAdapterDependencies,
  makeAntigravityAdapterLive,
} from "./AntigravityAdapter";
import {
  useProviderCommandReactorHarness,
  waitFor,
} from "../../orchestration/testing/providerCommandReactorHarness";

const SESSION_ID = "agy-session-1";
const MODELS = {
  currentModelId: "gemini-4-neon-high",
  availableModels: [
    { modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
    { modelId: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)" },
    { modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
  ],
};

/** A fake `agy acp` session whose updates and prompt results the test drives. */
function makeControllableRuntime(
  options: {
    readonly sessionSetupMethod?: "new" | "load" | "resume";
    readonly models?: typeof MODELS;
    readonly omitLegacyModels?: boolean;
    readonly agentVersion?: string;
    readonly sessionId?: string;
    readonly configOptions?: Acp.SessionConfigOption[];
    readonly nativeMode?: string;
    readonly ignoredConfigUpdate?: string;
    readonly modelChanged?: (value: string) => Acp.SessionConfigOption | undefined;
  } = {},
) {
  const events = Effect.runSync(Queue.unbounded<AcpParsedSessionEvent>());
  const requests: Array<{ readonly method: string; readonly payload: unknown }> = [];
  const prompts: Array<ReadonlyArray<Acp.ContentBlock>> = [];
  const runtimeInputs: AntigravityAcpRuntimeInput[] = [];
  const exited = Effect.runSync(Deferred.make<void>());
  const sessionId = options.sessionId ?? SESSION_ID;
  const pendingPrompts: Array<Deferred.Deferred<Acp.PromptResponse, AcpErrors.AcpError>> = [];
  let configOptions = options.configOptions ?? [];
  let nativeMode = options.nativeMode ?? "default";
  let enqueued = 0;
  let cancels = 0;
  let permissionHandler: Parameters<AcpSessionRuntimeShape["handleRequestPermission"]>[0];

  const emit = (event: AcpParsedSessionEvent) => {
    enqueued += 1;
    Effect.runSync(Queue.offer(events, event));
  };
  const finishPrompt = (stopReason: Acp.StopReason, index = pendingPrompts.length - 1) =>
    Effect.runSync(Deferred.succeed(pendingPrompts[index]!, { stopReason }));
  const rejectPrompt = (index: number) =>
    Effect.runSync(
      Deferred.fail(
        pendingPrompts[index]!,
        new AcpErrors.AcpRequestError({ code: -32602, errorMessage: "Steering was rejected" }),
      ),
    );

  const runtime = {
    ...makeFakeAcpSessionRuntime({ sessionId }),
    start: () =>
      Effect.succeed({
        sessionId,
        initializeResult: {
          protocolVersion: 1,
          ...(options.agentVersion
            ? { agentInfo: { name: "agy", version: options.agentVersion } }
            : {}),
        } as Acp.InitializeResponse,
        sessionSetupResult: {
          sessionId,
          ...(options.omitLegacyModels ? {} : { models: options.models ?? MODELS }),
          configOptions,
        } as Acp.NewSessionResponse,
        modelConfigId: "model",
        sessionSetupMethod: options.sessionSetupMethod ?? "new",
      }),
    getEvents: () => Stream.fromQueue(events),
    awaitExit: Deferred.await(exited),
    sessionUpdatesEnqueuedCount: Effect.sync(() => enqueued),
    handleRequestPermission: (handler: typeof permissionHandler) =>
      Effect.sync(() => {
        permissionHandler = handler;
      }),
    getConfigOptions: Effect.sync(() => configOptions),
    getModeState: Effect.sync(() => ({ currentModeId: nativeMode, availableModes: [] })),
    setMode: (modeId: string) =>
      Effect.sync(() => {
        requests.push({ method: "session/set_mode", payload: modeId });
        nativeMode = modeId;
        return {};
      }),
    setConfigOption: (id: string, value: string) =>
      Effect.sync(() => {
        requests.push({ method: "session/set_config_option", payload: { id, value } });
        configOptions = configOptions.map((option) =>
          option.id === id && option.type === "select" && id !== options.ignoredConfigUpdate
            ? { ...option, currentValue: value }
            : option,
        );
        if (id === "model" && options.modelChanged) {
          const thoughtLevel = options.modelChanged(value);
          configOptions = [
            ...configOptions.filter((option) => option.id !== "thought_level"),
            ...(thoughtLevel ? [thoughtLevel] : []),
          ];
        }
        return { configOptions };
      }),
    prompt: (payload: { readonly prompt: ReadonlyArray<Acp.ContentBlock> }) =>
      Effect.gen(function* () {
        prompts.push(payload.prompt);
        const pendingPrompt = yield* Deferred.make<Acp.PromptResponse, AcpErrors.AcpError>();
        pendingPrompts.push(pendingPrompt);
        return yield* Deferred.await(pendingPrompt);
      }),
    cancel: Effect.sync(() => {
      cancels += 1;
      for (const prompt of pendingPrompts)
        Effect.runSync(Deferred.succeed(prompt, { stopReason: "cancelled" }));
    }),
    request: (method: string, payload: unknown) =>
      Effect.sync(() => {
        requests.push({ method, payload });
        return {};
      }),
  };
  const makeRuntime = ((input: AntigravityAcpRuntimeInput) =>
    Effect.sync(() => {
      runtimeInputs.push(input);
      return runtime;
    })) as unknown as NonNullable<AntigravityAdapterDependencies["makeRuntime"]>;

  return {
    makeRuntime,
    emit,
    finishPrompt,
    rejectPrompt,
    exit: Deferred.succeed(exited, undefined),
    requestPermission: (request: Acp.RequestPermissionRequest) =>
      Effect.suspend(() => permissionHandler(request)),
    requests,
    prompts,
    runtimeInputs,
    cancels: () => cancels,
  };
}

const toolCall = (
  toolCallId: string,
  status: NonNullable<AcpToolCallState["status"]>,
  rawInput: Record<string, unknown> = { CommandLine: "sleep 8; echo bgdone" },
  kind = "execute",
): Extract<AcpParsedSessionEvent, { _tag: "ToolCallUpdated" }> => ({
  _tag: "ToolCallUpdated",
  toolCall: {
    toolCallId,
    kind,
    title: "Ran command",
    status,
    command: String(rawInput.CommandLine ?? ""),
    data: { toolCallId, kind, rawInput },
  },
  rawPayload: {},
});

const assistantText = (text: string): AcpParsedSessionEvent => ({
  _tag: "ContentDelta",
  itemId: "assistant-1",
  text,
  streamKind: "assistant_text",
  rawPayload: {},
});

const makeCredentials = (): AgentGatewayCredentialsShape =>
  ({
    mcpEndpointUrl: "http://127.0.0.1:3773/mcp",
    setListeningPort: () => undefined,
    issueSessionToken: () => "session-token",
    verifySessionToken: () => null,
    verifySession: () => null,
    issueStdioBootstrapToken: () => null,
    exchangeStdioBootstrapToken: () => null,
    bindWriteAuthority: () => null,
    verifyWriteAuthority: () => false,
    registerInFlightRequest: () => () => undefined,
    cancelInFlightRequests: () => ({ count: 0, settled: Promise.resolve() }),
    cancelSessionTurnRequests: () => Promise.resolve(),
    retireSessionTurn: () => Promise.resolve(),
    revokeSessionToken: () => undefined,
    connectionForThread: () => ({
      url: "http://127.0.0.1:3773/mcp",
      bearerToken: "session-token",
      connectors: [{ name: "notion", url: "http://127.0.0.1:3773/mcp/connectors/notion-1" }],
    }),
    stdioProxy: { command: "/usr/local/bin/node", args: ["proxy.mjs"] },
    setConnectorServers: () => undefined,
    canUseConnector: () => true,
  }) as unknown as AgentGatewayCredentialsShape;

const runWithAdapter = <A>(
  dependencies: AntigravityAdapterDependencies,
  body: (
    adapter: AntigravityAdapter["Service"],
  ) => Effect.Effect<A, unknown, FileSystem.FileSystem | Scope.Scope>,
  credentials?: AgentGatewayCredentialsShape,
) => {
  const adapterLayer = makeAntigravityAdapterLive({ backgroundQuietMs: 50, ...dependencies });
  const withCredentials =
    credentials === undefined
      ? adapterLayer
      : Layer.provide(adapterLayer, Layer.succeed(AgentGatewayCredentials, credentials));
  const layer = withCredentials.pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "antigravity-acp-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      const adapter = yield* AntigravityAdapter;
      return yield* body(adapter);
    }).pipe(Effect.provide(layer), Effect.scoped) as Effect.Effect<A>,
  );
};

const startInput = (threadId: ThreadId, extra: object = {}) => ({
  provider: "antigravity" as const,
  threadId,
  runtimeMode: "full-access" as const,
  cwd: process.cwd(),
  ...extra,
});

const collectTurn = (adapter: AntigravityAdapter["Service"]) =>
  adapter.streamEvents.pipe(
    Stream.takeUntil((event) => event.type === "turn.completed"),
    Stream.runCollect,
    Effect.map((events) => Array.from(events)),
    Effect.forkChild,
  );

const interaction = (
  sessionId: string,
  toolCallId = "interaction_decision",
): Acp.RequestPermissionRequest => ({
  sessionId,
  toolCall: { toolCallId, title: "Which plan?" },
  options: [
    { optionId: "planner-a", name: "Continue", kind: "allow_once" },
    { optionId: " planner-b ", name: "Continue", kind: "allow_once" },
  ],
});

const thoughtLevel = (selected: string): Acp.SessionConfigOption => ({
  category: "thought_level",
  id: "thought_level",
  name: "Thinking",
  type: "select",
  currentValue: "low",
  options:
    selected === "neon"
      ? [
          { value: "low", name: "Low" },
          { value: "deep", name: "Deep" },
        ]
      : [{ value: "low", name: "Low" }],
});

const modeConfig = (currentValue: string): Acp.SessionConfigOption => ({
  category: "mode",
  id: "execution_mode",
  name: "Execution mode",
  type: "select",
  currentValue,
  options: [
    { value: "default", name: "Default" },
    { value: "auto", name: "Auto" },
    { value: "plan", name: "Plan" },
  ],
});

const { createHarness, readHarnessThread } = useProviderCommandReactorHarness();

describe("Antigravity ACP adapter", () => {
  it.each([true, false])(
    "discovers and reapplies grouped ACP model IDs on resume without CLI substitution (configOnly=%s)",
    async (omitLegacyModels) => {
      const model = {
        id: "model",
        category: "model",
        type: "select",
        name: "Model",
        currentValue: "carbon",
        options: [
          {
            group: "planners",
            name: "Planners",
            options: [
              { value: "neon", name: "Orchestrator" },
              { value: "carbon", name: "Orchestrator" },
            ],
          },
        ],
      } satisfies Acp.SessionConfigOption;
      const fake = makeControllableRuntime({
        sessionSetupMethod: "resume",
        omitLegacyModels,
        configOptions: [model, thoughtLevel("carbon")],
        modelChanged: thoughtLevel,
      });
      await runWithAdapter(
        {
          makeRuntime: fake.makeRuntime,
          runHelper: async () => {
            throw new Error("Legacy discovery ran");
          },
        },
        (adapter) =>
          Effect.gen(function* () {
            const catalog = yield* adapter.listModels!({ provider: "antigravity" });
            expect(
              catalog.models.map((entry) => [
                entry.slug,
                entry.name,
                entry.supportedReasoningEfforts?.map((level) => level.value),
              ]),
            ).toEqual([
              ["neon", "Orchestrator", ["low", "deep"]],
              ["carbon", "Orchestrator", ["low"]],
            ]);
            fake.requests.length = 0;
            const threadId = ThreadId.makeUnsafe("thread-agy-acp-catalog");
            yield* adapter.startSession(
              startInput(threadId, {
                resumeCursor: SESSION_ID,
                modelSelection: {
                  provider: "antigravity",
                  model: "neon",
                  options: { reasoningEffort: "deep" },
                },
              }),
            );
            expect(fake.requests.map((request) => request.payload)).toEqual([
              { id: "model", value: "neon" },
              { id: "thought_level", value: "deep" },
            ]);
            const unavailable = yield* adapter
              .sendTurn({
                threadId,
                input: "should fail",
                attachments: [],
                modelSelection: {
                  provider: "antigravity",
                  model: "Orchestrator",
                  options: { reasoningEffort: "unoffered-planner" },
                },
              })
              .pipe(Effect.flip);
            expect(unavailable.message).toContain("Unoffered Planner");
            const invalidEffort = yield* adapter
              .sendTurn({
                threadId,
                input: "should fail",
                attachments: [],
                modelSelection: {
                  provider: "antigravity",
                  model: "carbon",
                  options: { reasoningEffort: "deep" },
                },
              })
              .pipe(Effect.flip);
            expect(invalidEffort.message).toContain("does not offer 'deep'");
            expect(fake.requests.slice(-2).map((request) => request.payload)).toEqual([
              { id: "model", value: "neon" },
              { id: "thought_level", value: "deep" },
            ]);
            expect(fake.prompts).toHaveLength(0);
          }),
      );
    },
  );

  it.each([undefined, "1.4.9"])(
    "keeps the legacy dispatch path for an unsupported agent version (%s)",
    async (agentVersion) => {
      const fake = makeControllableRuntime(agentVersion ? { agentVersion } : {});
      await runWithAdapter({ makeRuntime: fake.makeRuntime }, (adapter) =>
        Effect.gen(function* () {
          const threadId = ThreadId.makeUnsafe("thread-agy-legacy-steer");
          const session = yield* adapter.startSession(startInput(threadId));
          const turn = yield* adapter.sendTurn({ threadId, input: "First", attachments: [] });
          yield* Effect.promise(() => waitFor(() => fake.prompts.length === 1));
          const refused = yield* adapter.steerTurn!({
            threadId,
            input: "Follow up",
            attachments: [],
          }).pipe(Effect.flip);
          expect(refused.message).toContain("no active turn that supports live steering");
          expect(session.supportsNativeTurnSteering).toBe(false);
          expect(fake.prompts).toHaveLength(1);
          yield* adapter.interruptTurn(threadId, turn.turnId);
        }),
      );
    },
  );

  it("auto-approves an ordinary full-access request and rejects malformed interaction choices", async () => {
    const fake = makeControllableRuntime();
    await runWithAdapter({ makeRuntime: fake.makeRuntime }, (adapter) =>
      Effect.gen(function* () {
        const threadId = ThreadId.makeUnsafe("thread-agy-invalid-choice");
        yield* adapter.startSession(startInput(threadId));
        const requested =
          yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>>();
        yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) =>
            event.type === "user-input.requested"
              ? Deferred.succeed(requested, event)
              : Effect.void,
          ),
          Effect.forkChild,
        );
        const turn = yield* adapter.sendTurn({ threadId, input: "Ask", attachments: [] });
        const request = interaction(SESSION_ID);
        expect(
          yield* fake.requestPermission({
            ...request,
            toolCall: { toolCallId: "normal-tool", title: "Run echo", kind: "execute" },
          }),
        ).toEqual({ outcome: { outcome: "selected", optionId: "planner-a" } });
        expect(
          yield* fake.requestPermission({
            ...request,
            options: [request.options[0]!, request.options[0]!],
          }),
        ).toEqual({ outcome: { outcome: "cancelled" } });
        const native = yield* fake.requestPermission(request).pipe(Effect.forkChild);
        const event = yield* Deferred.await(requested);
        expect(event.turnId).toBe(turn.turnId);
        yield* adapter.respondToUserInput(
          threadId,
          ApprovalRequestId.makeUnsafe(event.requestId!),
          { interaction_decision: "Continue" },
        );
        expect(yield* Fiber.join(native)).toEqual({ outcome: { outcome: "cancelled" } });
        yield* adapter.interruptTurn(threadId, turn.turnId);
      }),
    );
  });

  it("routes native permission requests to the active supervised turn and cancels them on Stop", async () => {
    const fake = makeControllableRuntime({ nativeMode: "auto" });
    await runWithAdapter({ makeRuntime: fake.makeRuntime }, (adapter) =>
      Effect.gen(function* () {
        const threadId = ThreadId.makeUnsafe("thread-agy-supervised");
        yield* adapter.startSession({ ...startInput(threadId), runtimeMode: "approval-required" });
        const requests =
          yield* Queue.unbounded<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
        const resolutions =
          yield* Queue.unbounded<Extract<ProviderRuntimeEvent, { type: "request.resolved" }>>();
        yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) => {
            if (event.type === "request.opened") return Queue.offer(requests, event);
            if (event.type === "request.resolved") return Queue.offer(resolutions, event);
            return Effect.void;
          }),
          Effect.forkChild,
        );
        const permission = {
          sessionId: SESSION_ID,
          toolCall: { toolCallId: "command-1", title: "Run echo", kind: "execute" },
          options: [
            { optionId: "allow", name: "Allow once", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        } satisfies Acp.RequestPermissionRequest;
        expect(yield* fake.requestPermission(permission)).toEqual({
          outcome: { outcome: "cancelled" },
        });

        const turn = yield* adapter.sendTurn({ threadId, input: "Inspect", attachments: [] });
        expect(fake.requests).toContainEqual({ method: "session/set_mode", payload: "default" });
        expect(yield* fake.requestPermission({ ...permission, sessionId: "other" })).toEqual({
          outcome: { outcome: "cancelled" },
        });
        const first = yield* fake.requestPermission(permission).pipe(Effect.forkChild);
        const opened = yield* Queue.take(requests);
        expect(opened.turnId).toBe(turn.turnId);
        yield* adapter.respondToRequest(
          threadId,
          ApprovalRequestId.makeUnsafe(opened.requestId!),
          "accept",
        );
        expect(yield* Fiber.join(first)).toEqual({
          outcome: { outcome: "selected", optionId: "allow" },
        });
        expect((yield* Queue.take(resolutions)).payload.decision).toBe("accept");

        const persistentOnly = yield* fake
          .requestPermission({
            ...permission,
            options: [{ optionId: "always", name: "Always allow", kind: "allow_always" }],
          })
          .pipe(Effect.forkChild);
        const persistentRequest = yield* Queue.take(requests);
        yield* adapter.respondToRequest(
          threadId,
          ApprovalRequestId.makeUnsafe(persistentRequest.requestId!),
          "accept",
        );
        expect(yield* Fiber.join(persistentOnly)).toEqual({ outcome: { outcome: "cancelled" } });
        expect((yield* Queue.take(resolutions)).payload.decision).toBe("cancel");

        const second = yield* fake.requestPermission(permission).pipe(Effect.forkChild);
        const pending = yield* Queue.take(requests);
        expect(pending.turnId).toBe(turn.turnId);
        yield* adapter.interruptTurn(threadId, turn.turnId);
        expect(yield* Fiber.join(second)).toEqual({ outcome: { outcome: "cancelled" } });
      }),
    );
  });

  it("returns cancelled when Stop overtakes an accepted ACP permission response", async () => {
    const fake = makeControllableRuntime();
    const queueFull = Deferred.makeUnsafe<void>();
    let contentEvents = 0;
    let filling = false;
    await runWithAdapter(
      {
        makeRuntime: fake.makeRuntime,
        nativeEventLogger: {
          filePath: "",
          close: () => Effect.void,
          write: () =>
            Effect.suspend(() =>
              filling && ++contentEvents === PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY + 1
                ? Deferred.succeed(queueFull, undefined).pipe(Effect.asVoid)
                : Effect.void,
            ),
        },
      },
      (adapter) =>
        Effect.gen(function* () {
          const threadId = ThreadId.makeUnsafe("thread-agy-approval-backpressure");
          yield* adapter.startSession({
            ...startInput(threadId),
            runtimeMode: "approval-required",
          });
          const turn = yield* adapter.sendTurn({ threadId, input: "Inspect", attachments: [] });
          const opened =
            yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
          const drain = yield* Deferred.make<void>();
          yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) =>
              event.type === "request.opened"
                ? Deferred.succeed(opened, event).pipe(Effect.andThen(Deferred.await(drain)))
                : Effect.void,
            ),
            Effect.forkChild,
          );
          yield* Effect.yieldNow;

          const permission = yield* fake
            .requestPermission({
              sessionId: SESSION_ID,
              toolCall: { toolCallId: "command-1", title: "Run echo", kind: "execute" },
              options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
            })
            .pipe(Effect.forkChild);
          const request = yield* Deferred.await(opened);
          // Keep the event subscriber paused so request.resolved cannot publish until Stop starts.
          filling = true;
          for (let index = 0; index <= PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY; index++) {
            fake.emit(assistantText("pending output"));
          }
          yield* Deferred.await(queueFull);
          yield* adapter.respondToRequest(
            threadId,
            ApprovalRequestId.makeUnsafe(request.requestId!),
            "accept",
          );
          const stopping = yield* adapter
            .interruptTurn(threadId, turn.turnId)
            .pipe(Effect.forkChild);
          yield* Effect.promise(() => waitFor(() => fake.cancels() > 0));
          yield* Deferred.succeed(drain, undefined);
          expect(yield* Fiber.join(permission)).toEqual({ outcome: { outcome: "cancelled" } });
          yield* Fiber.join(stopping);
        }),
    );
  });

  it("resets Auto using the advertised config selector before sending a prompt", async () => {
    const fake = makeControllableRuntime({ configOptions: [modeConfig("auto")] });
    await runWithAdapter({ makeRuntime: fake.makeRuntime }, (adapter) =>
      Effect.gen(function* () {
        const threadId = ThreadId.makeUnsafe("thread-agy-config-auto");
        yield* adapter.startSession({ ...startInput(threadId), runtimeMode: "approval-required" });
        const turn = yield* adapter.sendTurn({ threadId, input: "Inspect", attachments: [] });
        expect(fake.requests).toContainEqual({
          method: "session/set_config_option",
          payload: { id: "execution_mode", value: "default" },
        });
        yield* adapter.interruptTurn(threadId, turn.turnId);
      }),
    );
  });

  it("does not send a prompt if the native config keeps Auto after a reset", async () => {
    const fake = makeControllableRuntime({
      configOptions: [modeConfig("auto")],
      ignoredConfigUpdate: "execution_mode",
    });
    await runWithAdapter({ makeRuntime: fake.makeRuntime }, (adapter) =>
      Effect.gen(function* () {
        const threadId = ThreadId.makeUnsafe("thread-agy-config-auto-held");
        yield* adapter.startSession({ ...startInput(threadId), runtimeMode: "approval-required" });
        const result = yield* adapter
          .sendTurn({ threadId, input: "Inspect", attachments: [] })
          .pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        expect(fake.prompts).toHaveLength(0);
      }),
    );
  });

  it.each([
    { name: "legacy mode state", options: { nativeMode: "plan" } },
    { name: "session config option", options: { configOptions: [modeConfig("plan")] } },
  ])("keeps native Plan ($name) and refuses reverse tool requests in it", async ({ options }) => {
    const fake = makeControllableRuntime(options);
    await runWithAdapter({ makeRuntime: fake.makeRuntime }, (adapter) =>
      Effect.gen(function* () {
        const threadId = ThreadId.makeUnsafe("thread-agy-plan-approval");
        yield* adapter.startSession(startInput(threadId));
        const turn = yield* adapter.sendTurn({ threadId, input: "Plan", attachments: [] });
        expect(fake.requests).not.toContainEqual({
          method: "session/set_mode",
          payload: "default",
        });
        expect(
          yield* fake.requestPermission({
            sessionId: SESSION_ID,
            toolCall: { toolCallId: "write-in-plan", title: "Edit file", kind: "edit" },
            options: [
              { optionId: "allow", name: "Allow once", kind: "allow_once" },
              { optionId: "reject", name: "Reject", kind: "reject_once" },
            ],
          }),
        ).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
        yield* adapter.interruptTurn(threadId, turn.turnId);
      }),
    );
  });

  it.each(["rejected", "stopped"])(
    "records an undelivered steer on its user message (reason=%s)",
    async (reason) => {
      const threadId = ThreadId.makeUnsafe("thread-1");
      const messageId = MessageId.makeUnsafe("undelivered-agy-steer");
      const fake = makeControllableRuntime({ agentVersion: "1.5.1" });
      const harness = await createHarness({
        ingestRuntimeEvents: true,
        threadModelSelection: { provider: "antigravity", model: "Gemini 4 Neon" },
      });
      await runWithAdapter({ makeRuntime: fake.makeRuntime }, (adapter) =>
        Effect.gen(function* () {
          const enteredSteer = yield* Deferred.make<void>();
          const releaseSteer = yield* Deferred.make<void>();
          harness.listSessions.mockImplementation(adapter.listSessions);
          harness.steerTurn.mockImplementation((input, opts) =>
            reason === "stopped"
              ? Deferred.succeed(enteredSteer, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseSteer)),
                  Effect.andThen(adapter.steerTurn!(input, opts)),
                )
              : adapter.steerTurn!(input, opts),
          );
          const events: ProviderRuntimeEvent[] = [];
          yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) =>
              Effect.promise(async () => {
                events.push(event);
                await harness.emitRuntimeEvent(event);
              }),
            ),
            Effect.forkChild,
          );
          yield* adapter.startSession(startInput(threadId));
          const turn = yield* adapter.sendTurn({ threadId, input: "First", attachments: [] });
          yield* Effect.promise(() =>
            waitFor(
              async () =>
                (await readHarnessThread(harness))?.session?.activeTurnId === turn.turnId &&
                fake.prompts.length === 1,
            ),
          );
          yield* harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("agy-undelivered-steer"),
            threadId,
            message: { messageId, role: "user", text: "Steer", attachments: [] },
            dispatchMode: "steer",
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: new Date().toISOString(),
          });
          if (reason === "stopped") {
            yield* Deferred.await(enteredSteer);
            yield* adapter.interruptTurn(threadId, turn.turnId);
            yield* Deferred.succeed(releaseSteer, undefined);
            expect(fake.prompts).toHaveLength(1);
          } else {
            yield* Effect.promise(() => waitFor(() => fake.prompts.length === 2));
            fake.rejectPrompt(1);
          }
          // Finish the original turn even if the steering input could not be sent.
          if (reason === "rejected") fake.finishPrompt("end_turn", 0);
          yield* Effect.promise(() =>
            waitFor(
              async () =>
                (await readHarnessThread(harness))?.activities.some(
                  (activity) =>
                    activity.kind === "provider.turn.start.failed" &&
                    typeof activity.payload === "object" &&
                    activity.payload !== null &&
                    "messageId" in activity.payload &&
                    activity.payload.messageId === messageId,
                ) === true,
            ),
          );
          yield* Effect.promise(() =>
            waitFor(() => events.some((event) => event.type === "turn.completed")),
          );
          expect(
            events
              .filter((event) => event.type === "turn.completed")
              .map((event) => [event.turnId, event.payload.state]),
          ).toEqual([[turn.turnId, reason === "stopped" ? "cancelled" : "completed"]]);
        }),
      );
    },
  );

  it.each(["completed", "cancelled", "failed"])(
    "steers the live ACP session through the reactor and owns a late question (outcome=%s)",
    async (outcome) => {
      const threadId = ThreadId.makeUnsafe("thread-1");
      const sessionId = "acc10000-0000-0000-0000-000000000000";
      const fake = makeControllableRuntime({ sessionId, agentVersion: "1.5.1" });
      const harness = await createHarness({
        ingestRuntimeEvents: true,
        threadModelSelection: { provider: "antigravity", model: "Gemini 4 Neon" },
      });
      await runWithAdapter({ makeRuntime: fake.makeRuntime }, (adapter) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const profileHome = yield* fs.makeTempDirectoryScoped({
            prefix: "synara-antigravity-child-",
          });
          const childId = "acc10000-0000-0000-0000-000000000001";
          const unrelatedChild = "acc10000-0000-0000-0000-000000000002";
          const metadata = (id: string) =>
            join(profileHome, ".gemini", "antigravity-cli", "brain", id, ".system_generated");
          const writeRecord = (dir: string, name: string, value: unknown) =>
            fs
              .makeDirectory(dir, { recursive: true })
              .pipe(Effect.andThen(fs.writeFileString(join(dir, name), JSON.stringify(value))));
          for (const [id, callId] of [
            [childId, "native-child-a"],
            [unrelatedChild, "native-child-b"],
          ] as const) {
            yield* writeRecord(join(metadata(sessionId), "subagents"), `${id}.json`, {
              conversationId: id,
              subagentDescriptor: { role: `role-${callId}` },
              state: "SUBAGENT_STATE_ALIVE",
            });
            yield* writeRecord(join(metadata(id), "messages"), "launch.json", {
              sender: sessionId,
              content: `prompt-${callId}`,
              sourceMetadata: {
                tool: {
                  conversationId: sessionId,
                  toolCall: { id: callId, name: "invoke_subagent" },
                },
              },
            });
          }
          harness.listSessions.mockImplementation(adapter.listSessions);
          harness.steerTurn.mockImplementation((input, opts) => adapter.steerTurn!(input, opts));
          harness.respondToUserInput.mockImplementation(({ threadId, requestId, answers }) =>
            adapter.respondToUserInput(threadId, requestId, answers),
          );
          harness.interruptTurn.mockImplementation(({ threadId, turnId }) =>
            adapter.interruptTurn(threadId, turnId),
          );
          const events: ProviderRuntimeEvent[] = [];
          yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) =>
              Effect.promise(async () => {
                events.push(event);
                await harness.emitRuntimeEvent(event);
              }),
            ),
            Effect.forkChild,
          );
          yield* adapter.startSession(
            startInput(threadId, {
              providerOptions: {
                antigravity: {
                  environment: {
                    HOME: profileHome,
                    USERPROFILE: profileHome,
                    GEMINI_HOME: join(profileHome, "unrelated-gemini-home"),
                  },
                },
              },
            }),
          );
          const turn = yield* adapter.sendTurn({
            threadId,
            input: "Launch two research tasks",
            attachments: [],
          });
          yield* Effect.promise(() =>
            waitFor(
              async () =>
                (await readHarnessThread(harness))?.session?.activeTurnId === turn.turnId &&
                fake.prompts.length === 1,
            ),
          );
          fake.emit(
            toolCall(
              "native-child-a",
              "completed",
              { _toolName: "invoke_subagent", Role: "Research", Prompt: "Read the guide" },
              "other",
            ),
          );
          fake.emit(
            toolCall(
              "native-child-b",
              "completed",
              {
                _toolName: "start_subagent",
                Subagents: [
                  { Role: "Inspect", Prompt: "Read tests" },
                  { Role: "Inspect again", Prompt: "Read config" },
                ],
              },
              "other",
            ),
          );
          fake.emit(
            toolCall(
              "mcp-lookalike",
              "completed",
              { _toolName: "mcp__search__invoke_subagent", Role: "MCP", Prompt: "Ignore" },
              "other",
            ),
          );
          fake.finishPrompt("end_turn", 0);
          yield* Effect.promise(() =>
            waitFor(
              () =>
                events.filter(
                  (event) =>
                    event.type === "item.completed" &&
                    event.payload.itemType === "collab_agent_tool_call" &&
                    JSON.stringify(event.payload.data).includes("receiverAgents"),
                ).length === 2,
            ),
          );
          const childPayloads = events.flatMap((event) =>
            event.type === "item.completed" && event.payload.itemType === "collab_agent_tool_call"
              ? [event.payload.data]
              : [],
          );
          expect(childPayloads).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                providerToolCallId: "native-child-a",
                prompt: "Read the guide",
                receiverAgents: [expect.objectContaining({ threadId: childId })],
              }),
              expect.objectContaining({
                providerToolCallId: "native-child-b",
                prompt: "Inspect\nRead tests\n\nInspect again\nRead config",
                receiverAgents: [expect.objectContaining({ threadId: unrelatedChild })],
              }),
            ]),
          );
          expect(childPayloads).not.toContainEqual(
            expect.objectContaining({ providerToolCallId: "mcp-lookalike" }),
          );
          yield* harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("agy-native-steer"),
            threadId,
            message: {
              messageId: MessageId.makeUnsafe("agy-steering-message"),
              role: "user",
              text: "Use read-only tools",
              attachments: [],
            },
            dispatchMode: "steer",
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: new Date().toISOString(),
          });
          yield* Effect.promise(() => waitFor(() => fake.prompts.length === 2));
          expect(
            fake.prompts[1]?.some(
              (part) => part.type === "text" && part.text.includes("Use read-only tools"),
            ),
          ).toBe(true);
          expect(harness.interruptTurn).not.toHaveBeenCalled();
          expect(harness.startSession).not.toHaveBeenCalled();
          expect(harness.steerTurn.mock.calls[0]?.[1]?.expectedTurnId).toBe(turn.turnId);
          expect(fake.cancels()).toBe(0);
          const response = yield* fake
            .requestPermission(interaction(sessionId))
            .pipe(Effect.forkChild);
          yield* Effect.promise(() =>
            waitFor(() => events.some((event) => event.type === "user-input.requested")),
          );
          const question = events.find((event) => event.type === "user-input.requested")!;
          expect(question.turnId).toBe(turn.turnId);
          const requestId = ApprovalRequestId.makeUnsafe(question.requestId!);
          yield* Effect.promise(() =>
            waitFor(
              async () =>
                (await readHarnessThread(harness))?.activities.some(
                  (activity) => activity.kind === "user-input.requested",
                ) === true,
            ),
          );
          if (outcome === "cancelled") {
            yield* harness.engine.dispatch({
              type: "thread.turn.interrupt",
              commandId: CommandId.makeUnsafe("agy-stop"),
              threadId,
              turnId: turn.turnId,
              createdAt: new Date().toISOString(),
            });
          } else if (outcome === "failed") {
            yield* fake.exit;
          } else {
            yield* harness.engine.dispatch({
              type: "thread.user-input.respond",
              commandId: CommandId.makeUnsafe("agy-answer"),
              threadId,
              requestId,
              answers: { interaction_decision: " planner-b " },
              createdAt: new Date().toISOString(),
            });
            expect(yield* Fiber.join(response)).toEqual({
              outcome: { outcome: "selected", optionId: " planner-b " },
            });
            for (const id of [childId, unrelatedChild])
              yield* writeRecord(join(metadata(sessionId), "messages"), `${id}.json`, {
                sender: id,
                content: "Complete",
              });
            fake.emit(assistantText("Research finished"));
            fake.finishPrompt("end_turn", 1);
          }
          expect(yield* Fiber.join(response)).toEqual({
            outcome:
              outcome === "completed"
                ? { outcome: "selected", optionId: " planner-b " }
                : { outcome: "cancelled" },
          });
          yield* Effect.promise(() =>
            waitFor(() => events.some((event) => event.type === "turn.completed")),
          );
          expect(
            events.filter((event) => event.type === "turn.started").map((event) => event.turnId),
          ).toEqual([turn.turnId]);
          expect(
            events
              .filter((event) => event.type === "turn.completed")
              .map((event) => [event.turnId, event.payload.state]),
          ).toEqual([[turn.turnId, outcome]]);
          expect(
            events
              .filter((event) => event.type === "user-input.resolved")
              .map((event) => [event.requestId, event.turnId]),
          ).toEqual([[question.requestId, turn.turnId]]);
          if (outcome === "completed") {
            expect(
              events.flatMap((event) =>
                event.type === "item.completed" ? [event.payload.data] : [],
              ),
            ).toContainEqual(
              expect.objectContaining({
                providerToolCallId: "native-child-a",
                agentStates: { [childId]: { status: "unreported", latestUpdate: "Complete" } },
              }),
            );
          }
        }),
      );
    },
  );

  it.each([
    { name: "single-folder", extra: {}, folderArgs: [] },
    { name: "empty folders", extra: { additionalDirectories: [] }, folderArgs: [] },
    {
      name: "resumed multi-folder",
      extra: {
        additionalDirectories: ["/repos/api", "/repos/shared package"],
        resumeCursor: "existing-conversation",
      },
      folderArgs: ["--add-dir", "/repos/api", "--add-dir", "/repos/shared package"],
    },
  ])("passes $name project access to the agy process", async ({ extra, folderArgs }) => {
    const commands: unknown[] = [];
    const spawner = ChildProcessSpawner.make((command) => {
      commands.push(command);
      // Stop at the real spawn boundary: this test verifies argv without launching agy.
      return Effect.fail(
        PlatformError.badArgument({
          module: "ChildProcess",
          method: "spawn",
          description: "Captured Antigravity process arguments",
        }),
      );
    });
    const result = await runWithAdapter(
      {
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({ ...input, childProcessSpawner: spawner }),
      },
      (adapter) =>
        adapter
          .startSession(
            startInput(ThreadId.makeUnsafe("thread-agy-folders"), {
              ...extra,
              cwd: "/repos/primary folder",
              providerOptions: { antigravity: { binaryPath: "/opt/agy-fixture" } },
            }),
          )
          .pipe(Effect.exit),
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect(commands).toEqual([
      expect.objectContaining({
        command: "/opt/agy-fixture",
        args: ["acp", ...folderArgs],
        options: expect.objectContaining({ cwd: "/repos/primary folder", shell: false }),
      }),
    ]);
  });

  it("attaches the Synara gateway and every granted connector as session MCP servers", async () => {
    const fake = makeControllableRuntime({ sessionSetupMethod: "resume" });
    await runWithAdapter(
      { makeRuntime: fake.makeRuntime },
      (adapter) =>
        Effect.gen(function* () {
          const session = yield* adapter.startSession(
            startInput(ThreadId.makeUnsafe("thread-agy-mcp"), {
              resumeCursor: "conversation-from-print-mode",
            }),
          );
          expect(session.resumeCursor).toBe(SESSION_ID);
        }),
      makeCredentials(),
    );
    const input = fake.runtimeInputs[0]!;
    expect(input.resumeSessionId).toBe("conversation-from-print-mode");
    const servers = input.buildMcpServers?.({ protocolVersion: 1 } as Acp.InitializeResponse);
    expect(servers?.map((server) => server.name)).toEqual(["synara", "notion"]);
    expect(servers?.[1]).toMatchObject({
      command: "/usr/local/bin/node",
      args: ["proxy.mjs"],
      env: expect.arrayContaining([
        {
          name: "SYNARA_AGENT_GATEWAY_URL",
          value: "http://127.0.0.1:3773/mcp/connectors/notion-1",
        },
      ]),
    });
  });

  it("selects the requested model and effort with session/set_model", async () => {
    const fake = makeControllableRuntime();
    await runWithAdapter({ makeRuntime: fake.makeRuntime }, (adapter) =>
      Effect.gen(function* () {
        const threadId = ThreadId.makeUnsafe("thread-agy-model");
        yield* adapter.startSession(
          startInput(threadId, {
            modelSelection: {
              provider: "antigravity",
              model: "Gemini 3.8 Flash",
              options: { reasoningEffort: "low" },
            },
          }),
        );
        const failure = yield* adapter
          .sendTurn({
            threadId,
            input: "hi",
            attachments: [],
            modelSelection: { provider: "antigravity", model: "Gemini 9 Ultra" },
          })
          .pipe(Effect.flip);
        expect(failure.message).toContain("Gemini 9 Ultra");
      }),
    );
    expect(fake.requests).toEqual([
      {
        method: "session/set_model",
        payload: { sessionId: SESSION_ID, modelId: "gemini-3.8-flash-low" },
      },
    ]);
  });

  it("uses the session planner for a saved Orchestrator without an explicit choice", async () => {
    const neon = { modelId: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)" };
    const fake = makeControllableRuntime({
      sessionSetupMethod: "resume",
      models: { ...MODELS, availableModels: [...MODELS.availableModels, neon] },
    });
    await runWithAdapter(
      {
        makeRuntime: fake.makeRuntime,
        runHelper: async () => ({ code: 0, stdout: "Orchestrator (Carbon)\n", stderr: "" }),
      },
      (adapter) =>
        Effect.gen(function* () {
          yield* adapter.listModels!({ provider: "antigravity" });
          const threadId = ThreadId.makeUnsafe("thread-agy-legacy-orchestrator");
          yield* adapter.startSession(
            startInput(threadId, {
              resumeCursor: "legacy-orchestrator",
              modelSelection: { provider: "antigravity", model: "Orchestrator" },
            }),
          );

          const failure = yield* adapter
            .sendTurn({
              threadId,
              input: "hi",
              attachments: [],
              modelSelection: {
                provider: "antigravity",
                model: "Orchestrator",
                options: { reasoningEffort: "carbon" },
              },
            })
            .pipe(Effect.flip);
          expect(failure.message).toContain("Orchestrator (Carbon)");
        }),
    );
    expect(fake.requests).toEqual([
      { method: "session/set_model", payload: { sessionId: SESSION_ID, modelId: neon.modelId } },
    ]);
  });

  it.each([
    { state: "completed", steer: false, toolError: undefined },
    { state: "cancelled", steer: true, toolError: undefined },
    { state: "failed", steer: true, toolError: "The background build failed." },
  ])(
    "settles the original turn after its background command (outcome=$state)",
    async ({ state, steer, toolError }) => {
      const fake = makeControllableRuntime({ agentVersion: "1.5.1" });
      const { events, turnId } = await runWithAdapter(
        { makeRuntime: fake.makeRuntime },
        (adapter) =>
          Effect.gen(function* () {
            const threadId = ThreadId.makeUnsafe("thread-agy-background");
            yield* adapter.startSession(startInput(threadId));
            const collector = yield* collectTurn(adapter);
            const turn = yield* adapter.sendTurn({
              threadId,
              input: "start it in the background",
              attachments: [],
            });
            fake.emit(toolCall("call-bg", "inProgress"));
            fake.emit(assistantText("started"));
            yield* Effect.sleep("30 millis");
            fake.finishPrompt("end_turn", 0);
            // The prompt returned, but the background command is still running.
            yield* Effect.sleep("200 millis");
            if (steer) {
              yield* adapter.steerTurn!(
                { threadId, input: "Check the build", attachments: [] },
                { expectedTurnId: turn.turnId },
              );
              yield* Effect.promise(() => waitFor(() => fake.prompts.length === 2));
            }
            const tool = toolCall("call-bg", toolError ? "failed" : "completed");
            fake.emit({
              ...tool,
              toolCall: { ...tool.toolCall, ...(toolError ? { detail: toolError } : {}) },
            });
            fake.emit(assistantText(" The background command finished."));
            if (steer) fake.finishPrompt("cancelled", 1);
            const events = yield* Fiber.join(collector).pipe(Effect.timeout("3 seconds"));
            return { events, turnId: turn.turnId };
          }),
      );
      const completion = events.at(-1);
      expect(completion).toMatchObject({
        type: "turn.completed",
        turnId,
        payload: { state, stopReason: steer ? "cancelled" : "end_turn" },
      });
      if (toolError) expect(completion?.payload).toMatchObject({ errorMessage: toolError });
      const followUp = events.find(
        (event) =>
          event.type === "content.delta" &&
          event.payload.delta === " The background command finished.",
      );
      expect(followUp?.turnId).toBe(turnId);
      const toolCompletion = events.find(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "command_execution",
      );
      expect(toolCompletion?.turnId).toBe(turnId);
    },
  );

  it("settles without waiting for a daemon and keeps its updates on the originating turn", async () => {
    const fake = makeControllableRuntime();
    await runWithAdapter({ makeRuntime: fake.makeRuntime }, (adapter) =>
      Effect.gen(function* () {
        const threadId = ThreadId.makeUnsafe("thread-agy-daemon");
        const daemon = { CommandLine: "npm run dev", IsDaemon: true };
        yield* adapter.startSession(startInput(threadId));
        const collector = yield* collectTurn(adapter);
        const first = yield* adapter.sendTurn({
          threadId,
          input: "run the dev server",
          attachments: [],
        });
        fake.emit(toolCall("call-dev", "inProgress", daemon));
        yield* Effect.yieldNow;
        fake.finishPrompt("end_turn");
        const firstEvents = yield* Fiber.join(collector).pipe(Effect.timeout("1 second"));
        const initialTool = firstEvents.find(
          (event) =>
            event.type === "item.updated" && event.payload.itemType === "command_execution",
        );
        expect(initialTool?.itemId).toBeDefined();
        expect(firstEvents.at(-1)).toMatchObject({ type: "turn.completed", turnId: first.turnId });

        const followUpCollector = yield* collectTurn(adapter);
        const second = yield* adapter.sendTurn({ threadId, input: "what port?", attachments: [] });
        fake.emit(toolCall("call-dev", "completed", daemon));
        yield* Effect.yieldNow;
        fake.finishPrompt("end_turn");
        const followUpEvents = yield* Fiber.join(followUpCollector).pipe(
          Effect.timeout("1 second"),
        );
        expect(followUpEvents.find((event) => event.type === "item.completed")).toMatchObject({
          turnId: first.turnId,
          itemId: initialTool?.itemId,
        });
        expect(followUpEvents.at(-1)).toMatchObject({
          type: "turn.completed",
          turnId: second.turnId,
        });
      }),
    );
  });

  it("cancels a turn that is waiting on background commands", async () => {
    const fake = makeControllableRuntime();
    const events = await runWithAdapter({ makeRuntime: fake.makeRuntime }, (adapter) =>
      Effect.gen(function* () {
        const threadId = ThreadId.makeUnsafe("thread-agy-cancel");
        yield* adapter.startSession(startInput(threadId));
        const collector = yield* collectTurn(adapter);
        const turn = yield* adapter.sendTurn({ threadId, input: "build", attachments: [] });
        fake.emit(toolCall("call-build", "inProgress", { CommandLine: "npm run build" }));
        yield* Effect.sleep("30 millis");
        fake.finishPrompt("end_turn");
        yield* Effect.sleep("100 millis");
        yield* adapter.interruptTurn(threadId, turn.turnId);
        return yield* Fiber.join(collector).pipe(Effect.timeout("2 seconds"));
      }),
    );
    const completion = events.at(-1) as Extract<ProviderRuntimeEvent, { type: "turn.completed" }>;
    expect(completion.type).toBe("turn.completed");
    expect(completion.payload.state).toBe("cancelled");
    // The prompt had returned, so closing the session (not session/cancel)
    // stops the background command.
    expect(fake.cancels()).toBe(0);
  });

  it("refuses to replace a conversation it could not resume", async () => {
    const fake = makeControllableRuntime({ sessionSetupMethod: "new" });
    const failure = await runWithAdapter({ makeRuntime: fake.makeRuntime }, (adapter) =>
      adapter
        .startSession(
          startInput(ThreadId.makeUnsafe("thread-agy-resume"), { resumeCursor: "lost-conv" }),
        )
        .pipe(Effect.flip),
    );
    expect(String((failure as Error).message)).toContain("could not resume");
  });
});

describe("Antigravity CLI helpers", () => {
  it("caps combined stdout and stderr diagnostics by UTF-8 byte length", () => {
    const output = createBoundedProcessOutput(16);

    output.append("stdout", "😀".repeat(4));
    output.append("stderr", "x".repeat(16));

    const snapshot = output.snapshot();
    expect(output.byteLength).toBeLessThanOrEqual(16);
    expect(
      Buffer.byteLength(snapshot.stdout, "utf8") + Buffer.byteLength(snapshot.stderr, "utf8"),
    ).toBeLessThanOrEqual(16);
    expect(snapshot.stdout).toBe("");
    expect(snapshot.stderr).toBe("x".repeat(16));
  });

  it("retains valid UTF-8 within the diagnostic budget when a chunk crosses it", () => {
    const output = createBoundedProcessOutput(16);
    output.append("stdout", "€".repeat(6));
    expect(output.snapshot()).toEqual({ stdout: "€".repeat(5), stderr: "" });
    expect(output.byteLength).toBeLessThanOrEqual(16);
  });

  it("evicts complete UTF-8 characters when the combined pipe budget cuts an older chunk", () => {
    const output = createBoundedProcessOutput(16);
    output.append("stdout", "😀".repeat(4));
    output.append("stderr", "x");
    expect(output.snapshot()).toEqual({ stdout: "😀".repeat(3), stderr: "x" });
    expect(output.byteLength).toBe(13);
  });
});

describe("Antigravity CLI model translation", () => {
  it("collapses CLI model/effort labels into base models with effort ladders", () => {
    expect(
      parseAntigravityModelLines(`
Gemini 3.5 Flash (Medium)
Gemini 3.5 Flash (High)
Gemini 3.5 Flash (Low)
Gemini 3.1 Pro (Low)
Gemini 3.1 Pro (High)
Claude Sonnet 4.6 (Thinking)
Claude Opus 4.6 (Thinking)
GPT-OSS 120B (Medium)
`),
    ).toEqual([
      {
        slug: "Gemini 3.5 Flash",
        name: "Gemini 3.5 Flash",
        supportedReasoningEfforts: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
        ],
        defaultReasoningEffort: "medium",
      },
      {
        slug: "Gemini 3.1 Pro",
        name: "Gemini 3.1 Pro",
        supportedReasoningEfforts: [
          { value: "low", label: "Low" },
          { value: "high", label: "High" },
        ],
        defaultReasoningEffort: "low",
      },
      {
        slug: "Claude Sonnet 4.6",
        name: "Claude Sonnet 4.6",
        supportedReasoningEfforts: [{ value: "thinking", label: "Thinking" }],
        defaultReasoningEffort: "thinking",
      },
      {
        slug: "Claude Opus 4.6",
        name: "Claude Opus 4.6",
        supportedReasoningEfforts: [{ value: "thinking", label: "Thinking" }],
        defaultReasoningEffort: "thinking",
      },
      {
        slug: "GPT-OSS 120B",
        name: "GPT-OSS 120B",
        supportedReasoningEfforts: [{ value: "medium", label: "Medium" }],
        defaultReasoningEffort: "medium",
      },
    ]);
  });

  it("collapses tab-separated slug/label rows from newer agy models output", () => {
    expect(
      parseAntigravityModelLines(`
gemini-3.6-flash-high\tGemini 3.6 Flash (High)
gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)
gemini-3.6-flash-low\tGemini 3.6 Flash (Low)
gemini-3.1-pro-high\tGemini 3.1 Pro (High)
gemini-3.1-pro-low\tGemini 3.1 Pro (Low)
claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)
`),
    ).toEqual([
      {
        slug: "Gemini 3.6 Flash",
        name: "Gemini 3.6 Flash",
        supportedReasoningEfforts: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
        ],
        defaultReasoningEffort: "medium",
      },
      {
        slug: "Gemini 3.1 Pro",
        name: "Gemini 3.1 Pro",
        supportedReasoningEfforts: [
          { value: "low", label: "Low" },
          { value: "high", label: "High" },
        ],
        defaultReasoningEffort: "low",
      },
      {
        slug: "Claude Sonnet 4.6",
        name: "Claude Sonnet 4.6",
        supportedReasoningEfforts: [{ value: "thinking", label: "Thinking" }],
        defaultReasoningEffort: "thinking",
      },
    ]);
  });

  it("rebuilds the exact CLI model label only at dispatch and accepts bullet-prefixed output", () => {
    expect(parseAntigravityCliModelLabel("Gemini 3.5 Flash (High)")).toEqual({
      model: "Gemini 3.5 Flash",
      effort: "high",
    });
    expect(parseAntigravityCliModelLabel("gemini-3.6-flash-high\tGemini 3.6 Flash (High)")).toEqual(
      {
        model: "Gemini 3.6 Flash",
        effort: "high",
      },
    );
    expect(resolveAntigravityCliModelLabel("Gemini 3.5 Flash")).toBe("Gemini 3.5 Flash (Medium)");
    expect(resolveAntigravityCliModelLabel("Gemini 3.5 Flash", { reasoningEffort: "high" })).toBe(
      "Gemini 3.5 Flash (High)",
    );
    expect(resolveAntigravityCliModelLabel("Gemini 3.5 Flash (Low)")).toBe(
      "Gemini 3.5 Flash (Low)",
    );
    expect(resolveAntigravityCliModelLabel("gemini-3.6-flash-high\tGemini 3.6 Flash (High)")).toBe(
      "Gemini 3.6 Flash (High)",
    );
    expect(parseAntigravityCliModelLabel("* Gemini 3.5 Flash (High)")).toEqual({
      model: "Gemini 3.5 Flash",
      effort: "high",
    });
    expect(parseAntigravityCliModelLabel("• Claude Sonnet 4.6 (Thinking)")).toEqual({
      model: "Claude Sonnet 4.6",
      effort: "thinking",
    });
  });

  it.each([
    { model: "Gemini 3.7 Flash", effort: "low", label: "Low" },
    { model: "Gemini 3.5 Flash", effort: "high", label: "High" },
  ])(
    "uses an available effort when the usual default is missing for $model",
    ({ model, effort, label }) => {
      const discovered = parseAntigravityModelLines(`${model} (${label})`)[0];
      expect(discovered).toMatchObject({
        supportedReasoningEfforts: [{ value: effort, label }],
        defaultReasoningEffort: effort,
      });
      expect(
        resolveAntigravityCliModelLabel(model, undefined, discovered?.defaultReasoningEffort),
      ).toBe(`${model} (${label})`);
    },
  );
});
