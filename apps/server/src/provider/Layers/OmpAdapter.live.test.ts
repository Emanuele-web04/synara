// Live end-to-end verification for the OMP adapter against a real `omp` binary.
// Skipped unless SYNARA_LIVE_OMP=1 is set; CI never runs it. Run locally:
//   SYNARA_LIVE_OMP=1 bunx vitest run src/provider/Layers/OmpAdapter.live.test.ts
// Requires `omp` on PATH (or OMP_LIVE_BINARY) with working provider credentials.

import { ThreadId, type ProviderRuntimeEvent } from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as OfficialAcp from "@agentclientprotocol/sdk";
import { Effect, Layer, Queue, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config.ts";
import type { OmpAdapterShape } from "../Services/OmpAdapter.ts";
import { OmpAdapter } from "../Services/OmpAdapter.ts";
import { ProviderAdapterValidationError } from "../Errors.ts";
import type { OmpAcpRuntimeSettings } from "../acp/OmpAcpSupport.ts";
import { makeOmpAdapterLive } from "./OmpAdapter.ts";

const LIVE = process.env.SYNARA_LIVE_OMP === "1";
const BINARY = process.env.OMP_LIVE_BINARY ?? "omp";
const FAST_MODEL = process.env.OMP_LIVE_MODEL ?? "deepseek/deepseek-v4-flash";

const modelSelection = {
  provider: "omp" as const,
  model: FAST_MODEL,
  options: { thinkingLevel: "off" as const },
};

const adapterLayer = (
  settings: OmpAcpRuntimeSettings,
  extraDeps?: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>,
) => {
  const configLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "synara-omp-live-",
  }).pipe(Layer.provide(NodeServices.layer));
  return makeOmpAdapterLive(settings).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, configLayer, ...(extraDeps ? [extraDeps] : [])),
    ),
  );
};

const withAdapter = <A, E>(
  settings: OmpAcpRuntimeSettings,
  run: (adapter: OmpAdapterShape, events: ProviderRuntimeEvent[]) => Effect.Effect<A, E>,
  extraDeps?: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* OmpAdapter;
        const events: ProviderRuntimeEvent[] = [];
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        ).pipe(Effect.forkScoped);
        return yield* run(adapter, events);
      }).pipe(Effect.provide(adapterLayer(settings, extraDeps))),
    ),
  );

const waitForEvent = (
  events: ProviderRuntimeEvent[],
  match: (event: ProviderRuntimeEvent) => boolean,
  timeoutMs: number,
  label: string,
) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = events.find(match);
      if (hit) return hit;
      yield* Effect.sleep(200);
    }
    return yield* Effect.fail(
      new Error(
        `timed out waiting for ${label}; seen: ${events.map((e) => e.type).join(", ") || "(none)"}`,
      ),
    );
  });

const startSession = (
  adapter: OmpAdapterShape,
  threadId: ThreadId,
  extra?: { resumeCursor?: unknown; agentDir?: string },
) =>
  adapter.startSession({
    threadId,
    provider: "omp",
    cwd: "/tmp",
    runtimeMode: "full-access",
    approvalPolicy: "never",
    modelSelection,
    // binaryPath/agentDir come from the adapter-layer settings; providerOptions
    // only carries agentDir when a test overrides it per-session.
    ...(extra?.agentDir ? { providerOptions: { omp: { agentDir: extra.agentDir } } } : undefined),
    ...(extra?.resumeCursor !== undefined ? { resumeCursor: extra.resumeCursor } : undefined),
  });

const sendTurn = (adapter: OmpAdapterShape, threadId: ThreadId, text: string) =>
  adapter.sendTurn({ threadId, input: text, modelSelection });

describe.skipIf(!LIVE)("OmpAdapter live E2E against real `omp acp`", () => {
  it("covers thread lifecycle: create -> stream turn -> concurrent-send guard -> interrupt -> resume -> fork", async () => {
    await withAdapter({ binaryPath: BINARY }, (adapter, events) =>
      Effect.gen(function* () {
        const threadA = ThreadId.makeUnsafe(crypto.randomUUID());

        // 1. Thread create
        const sessionA = yield* startSession(adapter, threadA);
        expect(sessionA.status).toBe("ready");
        expect(sessionA.resumeCursor).toBeDefined();
        const cursor = sessionA.resumeCursor;

        // 2. Turn + streaming
        const turn1 = yield* sendTurn(adapter, threadA, "Reply with exactly: OK");
        const completed1 = yield* waitForEvent(
          events,
          (e) => e.type === "turn.completed" && e.turnId === turn1.turnId,
          90_000,
          "turn 1 completion",
        );
        if (completed1.type !== "turn.completed") {
          return yield* Effect.fail(new Error("unexpected event type"));
        }
        expect(completed1.payload.state).toBe("completed");
        const streamed = events.some(
          (e) => e.type === "item.updated" || e.type === "item.completed",
        );
        expect(streamed).toBe(true);

        // 3. Concurrent sendTurn is rejected while a turn is in flight.
        // sendTurn resolves once the prompt fiber is dispatched, so a second
        // send immediately after is the tightest in-flight race window.
        const turn2 = yield* sendTurn(
          adapter,
          threadA,
          "Write a 3000-word essay about the history of computing. Do not summarize; write the full essay.",
        );
        const concurrentError = yield* Effect.flip(
          sendTurn(adapter, threadA, "ignore this prompt"),
        );
        expect(concurrentError).toBeInstanceOf(ProviderAdapterValidationError);

        // 4. Interrupt the in-flight turn before the provider can finish it
        yield* adapter.interruptTurn(threadA, turn2.turnId);
        const cancelled = yield* waitForEvent(
          events,
          (e) => e.type === "turn.completed" && e.turnId === turn2.turnId,
          60_000,
          "turn 2 cancellation",
        );
        if (cancelled.type !== "turn.completed") {
          return yield* Effect.fail(new Error("unexpected event type"));
        }
        expect(["cancelled", "interrupted"]).toContain(cancelled.payload.state);

        // 5. Stop + resume via cursor
        yield* adapter.stopSession(threadA);
        const threadB = ThreadId.makeUnsafe(crypto.randomUUID());
        const sessionB = yield* startSession(adapter, threadB, { resumeCursor: cursor });
        expect(sessionB.status).toBe("ready");
        if (adapter.didResumeSession !== undefined) {
          expect(
            adapter.didResumeSession(
              { threadId: threadB, runtimeMode: "full-access", resumeCursor: cursor },
              sessionB,
            ),
          ).toBe(true);
        }
        const turnB = yield* sendTurn(adapter, threadB, "Reply with exactly: RESUMED");
        yield* waitForEvent(
          events,
          (e) => e.type === "turn.completed" && e.turnId === turnB.turnId,
          90_000,
          "resumed turn completion",
        );

        // 6. Fork the resumed session into a new thread
        const threadC = ThreadId.makeUnsafe(crypto.randomUUID());
        const forkThread = adapter.forkThread;
        if (forkThread === undefined) {
          return yield* Effect.fail(new Error("omp adapter must implement forkThread"));
        }
        const forked = yield* forkThread({
          sourceThreadId: threadB,
          threadId: threadC,
          sourceResumeCursor: cursor,
          cwd: "/tmp",
          runtimeMode: "full-access",
        });
        expect(forked.threadId).toBe(threadC);
        expect(forked.resumeCursor).toBeDefined();

        yield* adapter.stopAll();
      }),
    );
  }, 300_000);

  it("surfaces a hard failure for a nonexistent binary", async () => {
    await withAdapter({ binaryPath: "/nonexistent-omp-live-bin" }, (adapter) =>
      Effect.gen(function* () {
        const threadId = ThreadId.makeUnsafe(crypto.randomUUID());
        const error = yield* Effect.flip(startSession(adapter, threadId));
        expect(error).toBeInstanceOf(Error);
        yield* adapter.stopAll();
      }),
    );
  }, 90_000);

  it("surfaces failure when the ACP child dies during session setup", async () => {
    // Fake omp: answers initialize, then dies on the next request.
    const dir = mkdtempSync(nodePath.join(tmpdir(), "omp-fake-"));
    const fake = nodePath.join(dir, "omp");
    writeFileSync(
      fake,
      [
        "#!/bin/sh",
        "IFS= read -r line",
        'echo \'{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{"name":"oh-my-pi","version":"0.0.0"},"authMethods":[{"id":"agent"}],"agentCapabilities":{"promptCapabilities":{}}}}\'',
        "exit 1",
      ].join("\n"),
    );
    chmodSync(fake, 0o755);

    await withAdapter({ binaryPath: fake }, (adapter) =>
      Effect.gen(function* () {
        const threadId = ThreadId.makeUnsafe(crypto.randomUUID());
        const error = yield* Effect.flip(startSession(adapter, threadId));
        expect(error).toBeInstanceOf(Error);
        yield* adapter.stopAll();
      }),
    );
  }, 90_000);

  it("discovers models and native commands through the real binary", async () => {
    await withAdapter({ binaryPath: BINARY }, (adapter) =>
      Effect.gen(function* () {
        const listModels = adapter.listModels;
        const listCommands = adapter.listCommands;
        if (listModels === undefined || listCommands === undefined) {
          return yield* Effect.fail(new Error("omp adapter must implement discovery"));
        }
        const models = yield* listModels({ provider: "omp", binaryPath: BINARY });
        expect(models.models.length).toBeGreaterThan(0);
        expect(models.source).toContain("omp");

        const commands = yield* listCommands({
          provider: "omp",
          cwd: "/tmp",
          binaryPath: BINARY,
        });
        expect(commands.source).toBe("omp-acp");
        expect(commands.commands.length).toBeGreaterThan(0);
      }),
    );
  }, 120_000);
});

// Deterministic regression coverage for the settled-turn straggler fix: a
// session/update that lands after the prompt response settles must be
// attributed to the just-settled turn instead of dropped as an orphan. Runs an
// in-memory ACP agent through a fake ChildProcessSpawner, so it needs no real
// `omp` binary and is not gated on SYNARA_LIVE_OMP.
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) + "\n");

describe("OmpAdapter late session/update attribution (in-memory ACP)", () => {
  it("attributes a post-settlement agent_message_chunk to the settled turn", async () => {
    const clientToAgent = Effect.runSync(Queue.unbounded<Uint8Array>());
    const agentToClient = Effect.runSync(Queue.unbounded<Uint8Array>());
    const sessionUpdate = (text: string) =>
      encode({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-omp-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          },
        },
      });

    let agentConnection: { close(error?: unknown): void } | undefined;
    const agentApp = OfficialAcp.agent({ name: "fake-omp" })
      .onRequest(OfficialAcp.methods.agent.initialize, () => ({
        protocolVersion: 1,
        agentInfo: { name: "fake-omp", version: "0.0.0" },
        agentCapabilities: {},
        authMethods: [{ id: "agent", name: "Agent authentication" }],
      }))
      .onRequest(OfficialAcp.methods.agent.authenticate, () => ({}))
      .onRequest(OfficialAcp.methods.agent.session.new, () => ({
        sessionId: "fake-omp-session",
        // currentValue already matches the test's modelSelection, so the
        // adapter's set_config_option calls short-circuit without an RPC.
        configOptions: [
          {
            id: "model",
            name: "Model",
            type: "select",
            category: "model",
            currentValue: FAST_MODEL,
            options: [{ value: FAST_MODEL, name: FAST_MODEL }],
          },
          {
            id: "thinking",
            name: "Thinking",
            type: "select",
            category: "thinking",
            currentValue: "off",
            options: [{ value: "off", name: "Off" }],
          },
        ],
      }))
      .onRequest(OfficialAcp.methods.agent.session.prompt, () => {
        // The turn's normal chunk is written before the response so the one
        // offered after turn.completed below is the straggler under test.
        Effect.runPromise(Queue.offer(agentToClient, sessionUpdate("EARLY")));
        return { stopReason: "end_turn" };
      });
    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() =>
        Effect.sync(() => {
          const input = new ReadableStream<Uint8Array>({
            pull: (controller) =>
              Effect.runPromise(Queue.take(clientToAgent))
                .then((chunk) => {
                  try {
                    controller.enqueue(chunk);
                  } catch {
                    // Stream already closed during teardown.
                  }
                })
                .catch(() => undefined),
          });
          const output = new WritableStream<Uint8Array>({
            write: (chunk) =>
              Effect.runPromise(Queue.offer(agentToClient, chunk)).then(() => undefined),
          });
          agentConnection = agentApp.connect(OfficialAcp.ndJsonStream(output, input));
          return ChildProcessSpawner.makeHandle({
            // Must be a pid no real process can have: stopAll runs the real
            // process-tree teardown, which captures every descendant of this
            // pid and signals it — a small pid like 1 (launchd) makes teardown
            // SIGTERM the whole user session, killing the vitest worker.
            pid: ChildProcessSpawner.ProcessId(0x7fff_fffe),
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

    try {
      await withAdapter(
        {},
        (adapter, events) =>
          Effect.gen(function* () {
            const threadId = ThreadId.makeUnsafe(crypto.randomUUID());
            yield* startSession(adapter, threadId);
            const turn = yield* sendTurn(adapter, threadId, "hi");
            yield* waitForEvent(
              events,
              (e) => e.type === "turn.completed" && e.turnId === turn.turnId,
              30_000,
              "turn completion",
            );
            // Settlement has fully finished: activeTurnId is cleared and the
            // drain is closed. This chunk can only land via the late path.
            yield* Queue.offer(agentToClient, sessionUpdate("LATE-CHUNK"));
            yield* waitForEvent(
              events,
              (e) =>
                e.type === "content.delta" &&
                e.turnId === turn.turnId &&
                JSON.stringify(e.payload).includes("LATE-CHUNK"),
              10_000,
              "late content.delta attribution",
            );
            yield* adapter.stopAll();
          }),
        spawnerLayer,
      );
    } finally {
      agentConnection?.close();
      await Effect.runPromise(Queue.shutdown(clientToAgent));
      await Effect.runPromise(Queue.shutdown(agentToClient));
    }
  }, 45_000);
});
