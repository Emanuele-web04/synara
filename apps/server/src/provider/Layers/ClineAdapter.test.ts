import type * as Acp from "@agentclientprotocol/sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, type ProviderRuntimeEvent } from "@synara/contracts";
import { Deferred, Effect, Exit, Fiber, Layer, Queue, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config.ts";
import { AcpRequestError } from "../acp/AcpErrors.ts";
import type {
  AcpSessionRuntimeShape,
  AcpSessionRuntimeStartResult,
} from "../acp/AcpSessionRuntime.ts";
import type { ClineAcpRuntimeInput } from "../acp/ClineAcpSupport.ts";
import type { AcpParsedSessionEvent } from "../acp/AcpRuntimeModel.ts";
import { ClineAdapter } from "../Services/ClineAdapter.ts";
import { makeClineAdapterLive } from "./ClineAdapter.ts";

const threadId = ThreadId.makeUnsafe("cline-test-thread");
const modelOption: Acp.SessionConfigOption = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "vendor/Model-A",
  options: [
    { value: "vendor/Model-A", name: "Model A" },
    { value: "vendor/Model-B", name: "Model B" },
  ],
};

function makeHarness() {
  const updates = Effect.runSync(Queue.unbounded<AcpParsedSessionEvent>());
  const result = Effect.runSync(Deferred.make<Acp.PromptResponse, AcpRequestError>());
  const exited = Effect.runSync(Deferred.make<void>());
  const calls: Array<[string, unknown]> = [];
  let queued = 0;
  let closed = 0;
  let failMode = false;
  let sessionSetupMethod: "new" | "load" = "new";
  let permission: Parameters<AcpSessionRuntimeShape["handleRequestPermission"]>[0] | undefined;
  const register = () => Effect.void;
  const runtime: AcpSessionRuntimeShape = {
    handleRequestPermission: (handler) =>
      Effect.sync(() => {
        permission = handler;
      }),
    handleElicitation: register,
    handleReadTextFile: register,
    handleWriteTextFile: register,
    handleCreateTerminal: register,
    handleTerminalOutput: register,
    handleTerminalWaitForExit: register,
    handleTerminalKill: register,
    handleTerminalRelease: register,
    handleSessionUpdate: register,
    handleElicitationComplete: register,
    handleExtRequest: register,
    handleExtNotification: register,
    start: () =>
      Effect.sync(
        () =>
          ({
            sessionId: "cline-test-session",
            initializeResult: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
            sessionSetupResult: {
              sessionId: "cline-test-session",
              configOptions: [
                modelOption,
                { id: "auto_approve", name: "Auto approve", type: "boolean", currentValue: false },
              ],
            },
            modelConfigId: "model",
            sessionSetupMethod,
          }) satisfies AcpSessionRuntimeStartResult,
      ),
    awaitExit: Deferred.await(exited),
    getEvents: () => Stream.fromQueue(updates),
    sessionUpdatesEnqueuedCount: Effect.sync(() => queued),
    supportsSessionFork: Effect.succeed(false),
    supportsSessionRecovery: Effect.succeed(true),
    getModeState: Effect.succeed({
      currentModeId: "act",
      availableModes: [
        { id: "plan", name: "Plan" },
        { id: "act", name: "Act" },
      ],
    }),
    getSessionEpoch: () => Effect.succeed(0 as never),
    getPendingSessionNotificationCount: () => Effect.succeed(0),
    getConfigOptions: Effect.succeed([modelOption]),
    getAvailableCommands: Effect.succeed([]),
    awaitLoadReplayReady: Effect.void,
    prompt: (payload) =>
      Effect.sync(() => {
        calls.push(["prompt", payload]);
      }).pipe(Effect.andThen(Deferred.await(result))),
    cancel: Effect.sync(() => {
      calls.push(["cancel", null]);
    }),
    setMode: (mode) =>
      Effect.suspend(() =>
        failMode
          ? Effect.fail(new AcpRequestError({ code: -32602, errorMessage: "mode rejected" }))
          : Effect.sync(() => {
              calls.push(["mode", mode]);
              return {};
            }),
      ),
    setConfigOption: (id, value) =>
      Effect.sync(() => {
        calls.push([id, value]);
        return { configOptions: [modelOption] };
      }),
    setModel: () => Effect.void,
    forkSession: () =>
      Effect.fail(new AcpRequestError({ code: -32601, errorMessage: "unsupported" })),
    request: () => Effect.succeed({}),
    notify: () => Effect.void,
  };
  const makeAcpRuntime = (input: ClineAcpRuntimeInput) =>
    Effect.gen(function* () {
      calls.push(["spawn", input]);
      sessionSetupMethod = input.resumeSessionId ? "load" : "new";
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          closed += 1;
        }),
      );
      return runtime;
    });
  const layer = makeClineAdapterLive({}, { makeAcpRuntime }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "cline-adapter-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  return {
    runtime,
    calls,
    layer,
    result,
    exited,
    closed: () => closed,
    failMode: () => {
      failMode = true;
    },
    permission: (params: Acp.RequestPermissionRequest) =>
      Effect.suspend(() => {
        if (!permission) return Effect.die("Handler not registered");
        return permission(params);
      }),
    emit: (event: AcpParsedSessionEvent) =>
      Effect.sync(() => {
        queued += 1;
      }).pipe(Effect.andThen(Queue.offer(updates, event))),
  };
}
const permissionRequest: Acp.RequestPermissionRequest = {
  sessionId: "cline-test-session",
  toolCall: { toolCallId: "write-file", title: "Write file", kind: "edit" },
  options: [
    { optionId: "yes", name: "Allow", kind: "allow_once" },
    { optionId: "no", name: "Reject", kind: "reject_once" },
  ],
};
const pause = Effect.sleep("20 millis");

describe("Cline adapter lifecycle", () => {
  it("starts with exact provider settings, discovers models, and disposes probes", async () => {
    const h = makeHarness();
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* ClineAdapter;
        const models = yield* adapter.listModels!({
          provider: "cline",
          binaryPath: "/custom/cline",
          cwd: process.cwd(),
        });
        expect(models.source).toBe("cline.acp");
        expect(models.models.map((m) => m.slug)).toEqual([
          "default",
          "vendor/Model-A",
          "vendor/Model-B",
        ]);
        expect(h.closed()).toBe(1);
        expect(yield* adapter.listSessions()).toEqual([]);
        const session = yield* adapter.startSession({
          threadId,
          provider: "cline",
          runtimeMode: "approval-required",
          cwd: process.cwd(),
          providerOptions: { cline: { binaryPath: "/another/cline" } },
        });
        expect(session.provider).toBe("cline");
        expect(session.resumeCursor).toEqual({ schemaVersion: 1, sessionId: "cline-test-session" });
        expect(h.calls.findLast(([key]) => key === "spawn")?.[1]).toMatchObject({
          clineSettings: { binaryPath: "/another/cline" },
        });
        yield* adapter.stopSession(threadId);
        expect(h.closed()).toBe(2);
      }).pipe(Effect.provide(h.layer), Effect.scoped),
    );
  });
  it("streams and drains the final delta before completing consecutive turns", async () => {
    const h = makeHarness();
    const observed: ProviderRuntimeEvent[] = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* ClineAdapter;
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            observed.push(event);
          }),
        ).pipe(Effect.forkScoped);
        yield* pause;
        yield* adapter.startSession({
          threadId,
          runtimeMode: "approval-required",
          lifecycleGeneration: "generation-1",
        });
        const first = yield* adapter.sendTurn({
          threadId,
          input: "Hello",
          modelSelection: { provider: "cline", model: "vendor/Model-B" },
        });
        yield* h.emit({ _tag: "ContentDelta", text: "First answer", rawPayload: {} });
        yield* Deferred.succeed(h.result, { stopReason: "end_turn" });
        yield* pause;
        const second = yield* adapter.sendTurn({ threadId, input: "Continue" });
        yield* pause;
        expect(observed.filter((e) => e.type === "turn.completed").map((e) => e.turnId)).toEqual([
          first.turnId,
          second.turnId,
        ]);
        const deltaIndex = observed.findIndex((e) => e.type === "content.delta");
        const doneIndex = observed.findIndex((e) => e.type === "turn.completed");
        expect(deltaIndex).toBeGreaterThan(-1);
        expect(deltaIndex).toBeLessThan(doneIndex);
        expect((yield* adapter.listSessions())[0]?.model).toBe("vendor/Model-B");
      }).pipe(Effect.provide(h.layer), Effect.scoped),
    );
  });
  it("requires approval in supervised mode and cancels idle requests", async () => {
    const h = makeHarness();
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* ClineAdapter;
        yield* adapter.startSession({ threadId, runtimeMode: "approval-required" });
        expect(yield* h.permission(permissionRequest)).toEqual({
          outcome: { outcome: "cancelled" },
        });
        const opened = yield* Deferred.make<ProviderRuntimeEvent>();
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          event.type === "request.opened"
            ? Deferred.succeed(opened, event).pipe(Effect.asVoid)
            : Effect.void,
        ).pipe(Effect.forkScoped);
        yield* pause;
        yield* adapter.sendTurn({ threadId, input: "Write a file" });
        const pending = yield* h.permission(permissionRequest).pipe(Effect.forkScoped);
        const event = yield* Deferred.await(opened);
        expect(event.requestId).toBeDefined();
        yield* adapter.respondToRequest(threadId, event.requestId! as never, "accept");
        expect(yield* Fiber.join(pending)).toEqual({
          outcome: { outcome: "selected", optionId: "yes" },
        });
      }).pipe(Effect.provide(h.layer), Effect.scoped, Effect.timeout("5 seconds")),
    );
  });
  it("enforces native plan mode even for full-access sessions", async () => {
    const h = makeHarness();
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* ClineAdapter;
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({ threadId, input: "Plan changes", interactionMode: "plan" });
        expect(h.calls).toContainEqual(["mode", "plan"]);
        expect(yield* h.permission(permissionRequest)).toEqual({
          outcome: { outcome: "selected", optionId: "no" },
        });
      }).pipe(Effect.provide(h.layer), Effect.scoped),
    );
  });
  it("never dispatches a turn when mode configuration fails", async () => {
    const h = makeHarness();
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* ClineAdapter;
        yield* adapter.startSession({ threadId, runtimeMode: "approval-required" });
        h.failMode();
        const outcome = yield* Effect.exit(
          adapter.sendTurn({ threadId, input: "Plan", interactionMode: "plan" }),
        );
        expect(Exit.isFailure(outcome)).toBe(true);
        expect(h.calls.some(([key]) => key === "prompt")).toBe(false);
        expect(yield* adapter.hasSession(threadId)).toBe(false);
        expect(h.closed()).toBe(1);
      }).pipe(Effect.provide(h.layer), Effect.scoped),
    );
  });
  it("cancels a pending approval, settles once, retires the process and resumes", async () => {
    const h = makeHarness();
    const observed: ProviderRuntimeEvent[] = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* ClineAdapter;
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            observed.push(event);
          }),
        ).pipe(Effect.forkScoped);
        yield* pause;
        const session = yield* adapter.startSession({ threadId, runtimeMode: "approval-required" });
        const turn = yield* adapter.sendTurn({ threadId, input: "Work" });
        const pending = yield* h.permission(permissionRequest).pipe(Effect.forkScoped);
        yield* pause;
        expect(
          Exit.isFailure(yield* Effect.exit(adapter.sendTurn({ threadId, input: "Overlap" }))),
        ).toBe(true);
        yield* adapter.interruptTurn(threadId, turn.turnId);
        expect(yield* Fiber.join(pending)).toEqual({ outcome: { outcome: "cancelled" } });
        expect(yield* adapter.hasSession(threadId)).toBe(false);
        expect(h.closed()).toBe(1);
        yield* pause;
        expect(
          observed.filter((e) => e.type === "turn.completed" && e.turnId === turn.turnId),
        ).toHaveLength(1);
        const resumed = yield* adapter.startSession({
          threadId,
          runtimeMode: "approval-required",
          resumeCursor: session.resumeCursor,
        });
        expect(
          adapter.didResumeSession?.(
            { threadId, runtimeMode: "approval-required", resumeCursor: session.resumeCursor },
            resumed,
          ),
        ).toBe(true);
      }).pipe(Effect.provide(h.layer), Effect.scoped),
    );
  });
  it("fails a turn and removes the session on unexpected process exit", async () => {
    const h = makeHarness();
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* ClineAdapter;
        yield* adapter.startSession({ threadId, runtimeMode: "approval-required" });
        yield* adapter.sendTurn({ threadId, input: "Work" });
        yield* Deferred.succeed(h.exited, undefined);
        yield* pause;
        expect(yield* adapter.hasSession(threadId)).toBe(false);
        expect(h.closed()).toBe(1);
      }).pipe(Effect.provide(h.layer), Effect.scoped),
    );
  });
  it("rejects malformed cursors and mismatched models without launching a process", async () => {
    const h = makeHarness();
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* ClineAdapter;
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              adapter.startSession({
                threadId,
                runtimeMode: "approval-required",
                resumeCursor: {},
              }),
            ),
          ),
        ).toBe(true);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              adapter.startSession({
                threadId,
                runtimeMode: "approval-required",
                modelSelection: { provider: "codex", model: "default" },
              }),
            ),
          ),
        ).toBe(true);
        expect(h.calls).toEqual([]);
      }).pipe(Effect.provide(h.layer), Effect.scoped),
    );
  });
});
