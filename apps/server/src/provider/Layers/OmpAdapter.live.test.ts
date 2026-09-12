// Live end-to-end verification for the OMP adapter against a real `omp` binary.
// Skipped unless SYNARA_LIVE_OMP=1 is set; CI never runs it. Run locally:
//   SYNARA_LIVE_OMP=1 bunx vitest run src/provider/Layers/OmpAdapter.live.test.ts
// Requires `omp` on PATH (or OMP_LIVE_BINARY) with working provider credentials.

import { ThreadId, type ProviderRuntimeEvent } from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Stream } from "effect";
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

const adapterLayer = (settings: OmpAcpRuntimeSettings) => {
  const configLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "synara-omp-live-",
  }).pipe(Layer.provide(NodeServices.layer));
  return makeOmpAdapterLive(settings).pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, configLayer)),
  );
};

const withAdapter = <A, E>(
  settings: OmpAcpRuntimeSettings,
  run: (adapter: OmpAdapterShape, events: ProviderRuntimeEvent[]) => Effect.Effect<A, E>,
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
      }).pipe(Effect.provide(adapterLayer(settings))),
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
