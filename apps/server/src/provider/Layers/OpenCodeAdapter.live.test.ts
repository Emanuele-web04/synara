// Run against an installed native CLI, not a simulated provider transport:
// SYNARA_LIVE_OPENCODE=1 bun run --cwd apps/server test src/provider/Layers/OpenCodeAdapter.live.test.ts
import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, type ProviderRuntimeEvent } from "@synara/contracts";
import { Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { ServerConfig } from "../../config.ts";
import { OpenCodeAdapter } from "../Services/OpenCodeAdapter.ts";
import { makeOpenCodeAdapterLive } from "./OpenCodeAdapter.ts";
import {
  assertSessionTeardownConformance,
  assertTerminalOutcomeConformance,
} from "../testSupport/adapterLifecycleConformance.ts";

const live = process.env.SYNARA_LIVE_OPENCODE === "1";
const model = process.env.OPENCODE_LIVE_MODEL ?? "opencode/mimo-v2.6-flash-free";
const binary = process.env.OPENCODE_LIVE_BINARY ?? "opencode";

describe.runIf(live)("native OpenCode lifecycle", () => {
  it("isolates real native sessions and observes cancellation through replacement completion", async () => {
    const workspace = await fs.mkdtemp(path.join(tmpdir(), "synara-native-fixture-"));
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const adapter = yield* OpenCodeAdapter;
            const config = yield* ServerConfig;
            const events: ProviderRuntimeEvent[] = [];
            yield* Stream.runForEach(adapter.streamEvents, (event) =>
              Effect.sync(() => {
                events.push(event);
              }),
            ).pipe(Effect.forkScoped);
            const first = ThreadId.makeUnsafe("native-first");
            const second = ThreadId.makeUnsafe("native-second");
            const start = (threadId: ThreadId, lifecycleGeneration: string) =>
              adapter.startSession({
                provider: "opencode",
                threadId,
                lifecycleGeneration,
                cwd: config.homeDir,
                runtimeMode: "approval-required",
                modelSelection: { provider: "opencode", model },
                providerOptions: {
                  opencode: {
                    binaryPath: binary,
                    ...(process.env.OPENCODE_LIVE_SERVER_URL
                      ? { serverUrl: process.env.OPENCODE_LIVE_SERVER_URL }
                      : {}),
                    ...(process.env.OPENCODE_LIVE_SERVER_PASSWORD
                      ? { serverPassword: process.env.OPENCODE_LIVE_SERVER_PASSWORD }
                      : {}),
                  },
                },
              });
            const wait = (match: (event: ProviderRuntimeEvent) => boolean) =>
              Effect.gen(function* () {
                const deadline = Date.now() + 90_000;
                while (Date.now() < deadline) {
                  const hit = events.find(match);
                  if (hit) return hit;
                  yield* Effect.sleep(50);
                }
                return yield* Effect.fail(
                  new Error(
                    `Native lifecycle did not settle: ${events.map((e) => e.type).join(", ")}`,
                  ),
                );
              });
            const firstSession = yield* start(first, "native-generation-first");
            const secondSession = yield* start(second, "native-generation-second");
            expect(firstSession.resumeCursor).not.toEqual(secondSession.resumeCursor);
            const interrupted = yield* adapter.sendTurn({
              threadId: first,
              input: "Without tools, count from one to one thousand.",
              attachments: [],
              modelSelection: { provider: "opencode", model },
            });
            yield* wait(
              (event) =>
                event.threadId === first &&
                event.turnId === interrupted.turnId &&
                event.type === "content.delta",
            );
            yield* adapter.interruptTurn(first, interrupted.turnId);
            const cancelled = yield* wait(
              (event) =>
                event.threadId === first &&
                event.turnId === interrupted.turnId &&
                (event.type === "turn.aborted" || event.type === "turn.completed"),
            );
            expect(cancelled.type).toBe("turn.aborted");
            yield* adapter.stopSession(first);
            yield* adapter.stopSession(first);
            expect(yield* adapter.hasSession(first)).toBe(false);
            expect(yield* adapter.hasSession(second)).toBe(true);
            const replacement = yield* adapter.sendTurn({
              threadId: second,
              input: "Reply with exactly NATIVE_LIFECYCLE_OK. Do not use tools.",
              attachments: [],
              modelSelection: { provider: "opencode", model },
            });
            const completed = yield* wait(
              (event) =>
                event.threadId === second &&
                event.turnId === replacement.turnId &&
                event.type === "turn.completed",
            );
            expect(completed.type === "turn.completed" && completed.payload.state).toBe(
              "completed",
            );
            const output = events
              .filter(
                (event) =>
                  event.threadId === second &&
                  event.turnId === replacement.turnId &&
                  event.type === "content.delta",
              )
              .map((event) => (event.type === "content.delta" ? event.payload.delta : ""))
              .join("");
            expect(output).toContain("NATIVE_LIFECYCLE_OK");
            assertTerminalOutcomeConformance(events);
            assertSessionTeardownConformance(events, first);
            yield* adapter.stopAll();
            yield* adapter.stopAll();
            expect(yield* adapter.listSessions()).toEqual([]);
          }).pipe(
            Effect.provide(
              makeOpenCodeAdapterLive().pipe(
                Layer.provideMerge(
                  ServerConfig.layerTest(workspace, path.join(workspace, "state"), {
                    homeDir: workspace,
                  }),
                ),
                Layer.provideMerge(NodeServices.layer),
              ),
            ),
          ),
        ),
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  }, 180_000);
});
