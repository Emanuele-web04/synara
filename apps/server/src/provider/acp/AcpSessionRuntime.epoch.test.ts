// FILE: AcpSessionRuntime.epoch.test.ts
// Purpose: Regression test for atomic session/update capture during the setSessionEpoch transition window.
// Layer: Provider ACP runtime tests

import * as OfficialAcp from "@agentclientprotocol/sdk";
import { Deferred, Effect, Fiber, Layer, Option, Queue, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it } from "vitest";

import type { AcpParsedSessionEvent } from "./AcpRuntimeModel.ts";
import { AcpSessionRuntime } from "./AcpSessionRuntime.ts";

const FINAL_SESSION_ID = "session-epoch-final";
const PENDING_EVENT_CAPACITY = 2_048;

/**
 * Bridges an in-memory OfficialAcp.agent() to the runtime through a fake
 * ChildProcessSpawner: the "child" stdin/stdout are Queue-bridged to the
 * agent's ReadableStream/WritableStream transport.
 */
function makeInMemoryAgentSpawner(
  promptUpdates: ReadonlyArray<OfficialAcp.SessionUpdate> = [],
  options: {
    replayUpdates?: ReadonlyArray<OfficialAcp.SessionUpdate>;
    stopReason?: OfficialAcp.StopReason;
  } = {},
) {
  const clientToAgent = Effect.runSync(Queue.unbounded<Uint8Array>());
  const agentToClient = Effect.runSync(Queue.unbounded<Uint8Array>());

  let agentConnection: OfficialAcp.AgentConnection | undefined;

  const agentInput = new ReadableStream<Uint8Array>({
    pull(controller) {
      return Effect.runPromise(Queue.take(clientToAgent)).then((chunk) => {
        controller.enqueue(chunk);
      });
    },
  });
  const agentOutput = new WritableStream<Uint8Array>({
    write(chunk) {
      return Effect.runPromise(Queue.offer(agentToClient, chunk)).then(() => undefined);
    },
  });

  const agentApp = OfficialAcp.agent({ name: "epoch-test-agent" })
    .onRequest(OfficialAcp.methods.agent.initialize, () => ({
      protocolVersion: 1,
      agentCapabilities: options.replayUpdates ? { loadSession: true } : {},
      authMethods: [],
    }))
    .onRequest(OfficialAcp.methods.agent.session.new, () => ({
      sessionId: FINAL_SESSION_ID,
    }))
    .onRequest(OfficialAcp.methods.agent.session.load, async () => {
      await sendUpdates(options.replayUpdates ?? []);
      return {};
    })
    .onRequest(OfficialAcp.methods.agent.session.prompt, async () => {
      await sendUpdates(promptUpdates);
      return { stopReason: options.stopReason ?? "end_turn" };
    });

  async function sendUpdates(updates: ReadonlyArray<OfficialAcp.SessionUpdate>) {
    if (!agentConnection) throw new Error("agent connection not established");
    for (const update of updates) {
      await agentConnection.client.notify(OfficialAcp.methods.client.session.update, {
        sessionId: FINAL_SESSION_ID,
        update,
      });
    }
  }

  const connectAgent = () => {
    agentConnection = agentApp.connect(OfficialAcp.ndJsonStream(agentOutput, agentInput));
    return agentConnection;
  };

  const spawnerLayer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.sync(() => {
        connectAgent();
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(0x7ff_f_fffe),

          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          stdin: Sink.forEach((chunk: Uint8Array) => Queue.offer(clientToAgent, chunk)),
          stdout: Stream.fromQueue(agentToClient),
          stderr: Stream.never,
          all: Stream.never,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.never,
        });
      }),
    ),
  );

  return {
    spawnerLayer,
    getAgentConnection: () => {
      if (!agentConnection) throw new Error("agent connection not established");
      return agentConnection;
    },
  };
}

/** Settles the in-memory transport and the client's session/update dispatch chain. */
async function flushTransport(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

describe("AcpSessionRuntime session epoch transition", () => {
  it("applies a session/update that arrives during the setSessionEpoch transition window exactly once", async () => {
    const { spawnerLayer, getAgentConnection } = makeInMemoryAgentSpawner();

    const transitionReached = Deferred.makeUnsafe<void>();
    const transitionPause = Deferred.makeUnsafe<void>();

    const runtimeLayer = AcpSessionRuntime.layer({
      spawn: { command: "in-memory-acp-agent", args: [] },
      cwd: process.cwd(),
      clientInfo: { name: "synara-test", version: "0.0.0" },
      authPolicy: "on-demand",
      teardownProcessTree: async () => ({ escalated: false, signalErrors: [] }),
      __testTransitionReached: Deferred.succeed(transitionReached, undefined).pipe(Effect.asVoid),
      __testTransitionPause: Deferred.await(transitionPause),
    }).pipe(Layer.provide(spawnerLayer));

    const program = Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;

      // Start the runtime in a fiber; it will block inside the transition window.
      const startFiber = yield* runtime.start().pipe(Effect.forkChild);

      // Wait until setSessionEpoch has captured the pending buffer but has
      // not yet installed the final epoch.
      yield* Deferred.await(transitionReached);

      // Deliver a session/update for the final session id inside the window
      // and let it settle into the pending buffer.
      yield* Effect.promise(() =>
        getAgentConnection().client.notify(OfficialAcp.methods.client.session.update, {
          sessionId: FINAL_SESSION_ID,
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: [
              { name: "epoch-window-command", description: "delivered mid-transition" },
            ],
          },
        }),
      );
      yield* Effect.promise(() => flushTransport());

      // Resume the transition and join the start fiber.
      yield* Deferred.succeed(transitionPause, undefined);
      const started = yield* Fiber.join(startFiber);
      expect(started.sessionId).toBe(FINAL_SESSION_ID);

      // Let any in-flight handler dispatch settle before asserting.
      yield* Effect.promise(() => flushTransport());

      const commands = yield* runtime.getAvailableCommands;
      const delivered = commands.filter((command) => command.name === "epoch-window-command");
      expect(delivered).toHaveLength(1);
      expect(commands).toHaveLength(1);

      const epoch = yield* runtime.getSessionEpoch();
      expect(Option.isSome(epoch.activeSessionId)).toBe(true);
      expect(Option.getOrThrow(epoch.activeSessionId)).toBe(FINAL_SESSION_ID);

      // No pending state may remain after the transition.
      const pending = yield* runtime.getPendingSessionNotificationCount();
      expect(pending).toBe(0);
    }).pipe(Effect.provide(runtimeLayer), Effect.scoped);

    await Effect.runPromise(program);
  }, 15_000);

  it("counts only retained pending events when the pre-consumer buffer overflows", async () => {
    const { spawnerLayer, getAgentConnection } = makeInMemoryAgentSpawner();
    const runtimeLayer = AcpSessionRuntime.layer({
      spawn: { command: "in-memory-acp-agent", args: [] },
      cwd: process.cwd(),
      clientInfo: { name: "synara-test", version: "0.0.0" },
      authPolicy: "on-demand",
      teardownProcessTree: async () => ({ escalated: false, signalErrors: [] }),
    }).pipe(Layer.provide(spawnerLayer));

    const program = Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      yield* Effect.promise(async () => {
        for (let index = 0; index < PENDING_EVENT_CAPACITY + 2; index++) {
          await getAgentConnection().client.notify(OfficialAcp.methods.client.session.update, {
            sessionId: FINAL_SESSION_ID,
            update: {
              sessionUpdate: "agent_thought_chunk",
              messageId: `pending-${String(index)}`,
              content: { type: "text", text: `pending-${String(index)}` },
            },
          });
        }
        await getAgentConnection().client.notify(OfficialAcp.methods.client.session.update, {
          sessionId: FINAL_SESSION_ID,
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: [{ name: "overflow-settled", description: "sentinel" }],
          },
        });
      });

      yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 10_000; attempt++) {
          const commands = yield* runtime.getAvailableCommands;
          if (commands.some((command) => command.name === "overflow-settled")) return;
          yield* Effect.sleep(1);
        }
        return yield* Effect.die("Timed out waiting for pending events to settle");
      });

      expect(yield* runtime.sessionUpdatesEnqueuedCount).toBe(PENDING_EVENT_CAPACITY);

      const events = Array.from(
        yield* runtime.getEvents().pipe(Stream.take(PENDING_EVENT_CAPACITY), Stream.runCollect),
      );
      expect(events).toHaveLength(PENDING_EVENT_CAPACITY);
      expect(events[0]).toMatchObject({ _tag: "ContentDelta", text: "pending-2" });
      expect(events[PENDING_EVENT_CAPACITY - 1]).toMatchObject({
        _tag: "ContentDelta",
        text: `pending-${String(PENDING_EVENT_CAPACITY + 1)}`,
      });
    }).pipe(Effect.provide(runtimeLayer), Effect.scoped);

    await Effect.runPromise(program);
  }, 30_000);
});

it("separates concurrent owner streams without message IDs and completes each segment", async () => {
  const { spawnerLayer, getAgentConnection } = makeInMemoryAgentSpawner();
  const layer = AcpSessionRuntime.layer({
    spawn: { command: "in-memory-acp-agent", args: [] },
    cwd: process.cwd(),
    clientInfo: { name: "owner-test", version: "0.0.0" },
    authPolicy: "on-demand",
    assistantItemScope: (meta) => (typeof meta?.owner === "string" ? meta.owner : undefined),
    teardownProcessTree: async () => ({ escalated: false, signalErrors: [] }),
  }).pipe(Layer.provide(spawnerLayer));
  await Effect.runPromise(
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();
      const events: AcpParsedSessionEvent[] = [];
      yield* runtime.getEvents().pipe(
        Stream.runForEach((event) => Effect.sync(() => events.push(event))),
        Effect.forkChild,
      );
      for (const [owner, text] of [
        ["first", "One"],
        ["second", "Two"],
        ["first", "Three"],
      ]) {
        yield* Effect.promise(() =>
          getAgentConnection().client.notify(OfficialAcp.methods.client.session.update, {
            sessionId: FINAL_SESSION_ID,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text },
              _meta: { owner },
            },
          }),
        );
        yield* Effect.promise(() => flushTransport());
      }
      yield* Effect.promise(() =>
        getAgentConnection().client.notify(OfficialAcp.methods.client.session.update, {
          sessionId: FINAL_SESSION_ID,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "boundary",
            status: "completed",
            title: "Boundary",
            kind: "other",
            content: [],
          },
        }),
      );
      yield* Effect.promise(() => flushTransport());
      const deltas = events.filter((event) => event._tag === "ContentDelta");
      const ids = deltas.map((event) => event.itemId);
      expect(ids).toHaveLength(3);
      expect(ids.every((id) => typeof id === "string")).toBe(true);
      expect(new Set(ids).size).toBe(3);
      expect(
        events
          .filter((event) => event._tag === "AssistantItemCompleted")
          .map((event) => event.itemId),
      ).toEqual(ids);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
}, 15_000);

const thought = (text: string, owner?: string, messageId?: string) => ({
  sessionUpdate: "agent_thought_chunk" as const,
  content: { type: "text" as const, text },
  ...(owner !== undefined ? { _meta: { owner } } : {}),
  ...(messageId !== undefined ? { messageId } : {}),
});

const isThought = (
  event: AcpParsedSessionEvent,
): event is Extract<AcpParsedSessionEvent, { _tag: "ContentDelta" }> =>
  event._tag === "ContentDelta" && event.streamKind === "reasoning_text";

it("groups ID-less thoughts into scoped ACP items and settles them at transcript boundaries", async () => {
  const { spawnerLayer } = makeInMemoryAgentSpawner([
    thought("Read", "parent"),
    thought(" the spec", "parent"),
    {
      sessionUpdate: "tool_call",
      toolCallId: "check",
      title: "Read files",
      status: "in_progress",
      kind: "read",
      content: [],
    },
    thought("Child thought", "child"),
    thought("Parent thought", "parent"),
    {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Visible answer." },
    },
    thought("Native thought", "parent", "native-thought"),
    thought("Final thought", "parent"),
  ]);
  const layer = AcpSessionRuntime.layer({
    spawn: { command: "in-memory-acp-agent", args: [] },
    cwd: process.cwd(),
    clientInfo: { name: "reasoning-test", version: "0.0.0" },
    authPolicy: "on-demand",
    assistantItemScope: (meta) => (typeof meta?.owner === "string" ? meta.owner : undefined),
    teardownProcessTree: async () => ({ escalated: false, signalErrors: [] }),
  }).pipe(Layer.provide(spawnerLayer));

  await Effect.runPromise(
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();
      const events: AcpParsedSessionEvent[] = [];
      yield* runtime.getEvents().pipe(
        Stream.runForEach((event) => Effect.sync(() => events.push(event))),
        Effect.forkChild,
      );
      yield* runtime.prompt({ prompt: [{ type: "text", text: "First prompt" }] });
      yield* Effect.promise(() => flushTransport());

      const thoughts = events.filter(isThought);
      expect(thoughts.map((event) => event.text)).toEqual([
        "Read",
        " the spec",
        "Child thought",
        "Parent thought",
        "Native thought",
        "Final thought",
      ]);
      const [first, next, child, parent, native, final] = thoughts.map((event) => event.itemId);
      expect(first).toBeDefined();
      expect(next).toBe(first);
      expect(native).toBe("native-thought");
      expect(new Set([first, child, parent, native, final]).size).toBe(5);

      const completed = events.filter((event) => event._tag === "ReasoningItemCompleted");
      expect(completed.map((event) => [event.itemId, event.metadata?.owner])).toEqual([
        [first, "parent"],
        [child, "child"],
        [parent, "parent"],
        [final, "parent"],
      ]);
      expect(events.indexOf(completed[0]!)).toBeLessThan(
        events.findIndex((event) => event._tag === "ToolCallUpdated"),
      );
      expect(events.indexOf(completed[2]!)).toBeLessThan(
        events.findIndex((event) => event._tag === "AssistantItemStarted"),
      );
      expect(
        events.filter(
          (event) => event._tag === "ContentDelta" && event.streamKind === "assistant_text",
        ),
      ).toEqual([expect.objectContaining({ text: "Visible answer." })]);

      events.length = 0;
      yield* runtime.prompt({ prompt: [{ type: "text", text: "Second prompt" }] });
      yield* Effect.promise(() => flushTransport());
      const secondPrompt = events.find(isThought);
      expect(secondPrompt?.itemId).toBeDefined();
      expect(secondPrompt?.itemId).not.toBe(first);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
}, 15_000);

it.each(["end_turn", "cancelled"] as const)(
  "suppresses ID-less history during ACP load and lets a %s prompt settle live reasoning",
  async (stopReason) => {
    const { spawnerLayer } = makeInMemoryAgentSpawner([thought("Live thinking.")], {
      replayUpdates: [thought("History, do not repeat.")],
      stopReason,
    });
    const layer = AcpSessionRuntime.layer({
      spawn: { command: "in-memory-acp-agent", args: [] },
      cwd: process.cwd(),
      clientInfo: { name: "reasoning-replay-test", version: "0.0.0" },
      authPolicy: "on-demand",
      resumeSessionId: FINAL_SESSION_ID,
      loadReplayPolicy: { quietMs: 5, hardTimeoutMs: 100 },
      teardownProcessTree: async () => ({ escalated: false, signalErrors: [] }),
    }).pipe(Layer.provide(spawnerLayer));

    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime;
        yield* runtime.start();
        const events: AcpParsedSessionEvent[] = [];
        yield* runtime.getEvents().pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkChild,
        );
        const response = yield* runtime.prompt({ prompt: [{ type: "text", text: "Resume" }] });
        yield* Effect.promise(() => flushTransport());

        expect(response.stopReason).toBe(stopReason);
        const thoughts = events.filter(isThought);
        expect(thoughts.map((event) => event.text)).toEqual(["Live thinking."]);
        expect(thoughts[0]?.itemId).toBeDefined();
        const closed = events.filter((event) => event._tag === "ReasoningItemCompleted");
        // Canceled prompts settle as failed through the adapter's terminal turn event.
        expect(closed.map((event) => event.itemId)).toEqual(
          stopReason === "cancelled" ? [] : [thoughts[0]?.itemId],
        );
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );
  },
  15_000,
);
