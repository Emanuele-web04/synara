import * as NodeServices from "@effect/platform-node/NodeServices";
import type * as Acp from "@agentclientprotocol/sdk";
import { ThreadId, type ProviderRuntimeEvent } from "@synara/contracts";
import { Deferred, Effect, Fiber, Layer, Queue, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config";
import {
  AgentGatewayCredentials,
  type AgentGatewayCredentialsShape,
} from "../../agentGateway/Services/AgentGatewayCredentials";
import type * as AcpErrors from "../acp/AcpErrors";
import type { AcpParsedSessionEvent, AcpToolCallState } from "../acp/AcpRuntimeModel";
import type { AntigravityAcpRuntimeInput } from "../acp/AntigravityAcpSupport";
import { makeFakeAcpSessionRuntime } from "../acp/testing/fakeAcpSessionRuntime";
import {
  createBoundedProcessOutput,
  parseAntigravityCliModelLabel,
  parseAntigravityModelLines,
  resolveAntigravityCliModelLabel,
} from "../antigravityCli";
import { AntigravityAdapter } from "../Services/AntigravityAdapter";
import {
  type AntigravityAdapterDependencies,
  makeAntigravityAdapterLive,
} from "./AntigravityAdapter";

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
  options: { readonly sessionSetupMethod?: "new" | "load" | "resume" } = {},
) {
  const events = Effect.runSync(Queue.unbounded<AcpParsedSessionEvent>());
  const requests: Array<{ readonly method: string; readonly payload: unknown }> = [];
  const prompts: Array<ReadonlyArray<Acp.ContentBlock>> = [];
  const runtimeInputs: AntigravityAcpRuntimeInput[] = [];
  let enqueued = 0;
  let cancels = 0;
  let pendingPrompt: Deferred.Deferred<Acp.PromptResponse, AcpErrors.AcpError> | undefined;

  const emit = (event: AcpParsedSessionEvent) => {
    enqueued += 1;
    Effect.runSync(Queue.offer(events, event));
  };
  const finishPrompt = (stopReason: Acp.StopReason) =>
    Effect.runSync(Deferred.succeed(pendingPrompt!, { stopReason }));

  const runtime = {
    ...makeFakeAcpSessionRuntime({ sessionId: SESSION_ID }),
    start: () =>
      Effect.succeed({
        sessionId: SESSION_ID,
        initializeResult: { protocolVersion: 1 } as Acp.InitializeResponse,
        sessionSetupResult: { sessionId: SESSION_ID, models: MODELS } as Acp.NewSessionResponse,
        modelConfigId: "model",
        sessionSetupMethod: options.sessionSetupMethod ?? "new",
      }),
    getEvents: () => Stream.fromQueue(events),
    sessionUpdatesEnqueuedCount: Effect.sync(() => enqueued),
    prompt: (payload: { readonly prompt: ReadonlyArray<Acp.ContentBlock> }) =>
      Effect.gen(function* () {
        prompts.push(payload.prompt);
        pendingPrompt = yield* Deferred.make<Acp.PromptResponse, AcpErrors.AcpError>();
        return yield* Deferred.await(pendingPrompt);
      }),
    cancel: Effect.sync(() => {
      cancels += 1;
      if (pendingPrompt)
        Effect.runSync(Deferred.succeed(pendingPrompt, { stopReason: "cancelled" }));
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
): AcpParsedSessionEvent => ({
  _tag: "ToolCallUpdated",
  toolCall: {
    toolCallId,
    kind: "execute",
    title: "Ran command",
    status,
    command: String(rawInput.CommandLine ?? ""),
    data: { toolCallId, kind: "execute", rawInput },
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
  body: (adapter: AntigravityAdapter["Service"]) => Effect.Effect<A, unknown>,
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

describe("Antigravity ACP adapter", () => {
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

  it("keeps a turn open until its background command finishes and the agent replies", async () => {
    const fake = makeControllableRuntime();
    const events = await runWithAdapter({ makeRuntime: fake.makeRuntime }, (adapter) =>
      Effect.gen(function* () {
        const threadId = ThreadId.makeUnsafe("thread-agy-background");
        yield* adapter.startSession(startInput(threadId));
        const collector = yield* collectTurn(adapter);
        yield* adapter.sendTurn({ threadId, input: "start it in the background", attachments: [] });
        fake.emit(toolCall("call-bg", "inProgress"));
        fake.emit(assistantText("started"));
        yield* Effect.sleep("30 millis");
        fake.finishPrompt("end_turn");
        // The prompt returned, but the background command is still running.
        yield* Effect.sleep("200 millis");
        fake.emit(toolCall("call-bg", "completed"));
        fake.emit(assistantText(" The background command finished."));
        return yield* Fiber.join(collector).pipe(Effect.timeout("3 seconds"));
      }),
    );
    const turnEvents = events.filter(
      (event): event is ProviderRuntimeEvent => event.type !== "session.started",
    );
    const types = turnEvents.map((event) => event.type);
    expect(types.at(-1)).toBe("turn.completed");
    const completion = turnEvents.at(-1) as Extract<
      ProviderRuntimeEvent,
      { type: "turn.completed" }
    >;
    expect(completion.payload.state).toBe("completed");
    const turnId = completion.turnId;
    const followUp = turnEvents.find(
      (event) =>
        event.type === "content.delta" &&
        event.payload.delta === " The background command finished.",
    );
    expect(followUp?.turnId).toBe(turnId);
    const toolCompletion = turnEvents.find(
      (event) => event.type === "item.completed" && event.payload.itemType === "command_execution",
    );
    expect(toolCompletion?.turnId).toBe(turnId);
  });

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
