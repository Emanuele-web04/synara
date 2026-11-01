// FILE: GrokAdapter.resume.test.ts
// Purpose: Covers that a Grok restart only reloads a native session created with the
//          requested process-start model flags (`-m` / `--reasoning-effort`).
// Layer: Provider adapter tests
// Note: kept apart from GrokAdapter.test.ts because it mocks the Grok ACP runtime module.

import * as NodeServices from "@effect/platform-node/NodeServices";
import { type GrokModelOptions, ThreadId } from "@synara/contracts";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";

import { ServerConfig } from "../../config.ts";
import type { GrokAcpRuntimeInput } from "../acp/GrokAcpSupport.ts";
import { makeFakeAcpSessionRuntime } from "../acp/testing/fakeAcpSessionRuntime.ts";
import { ProviderAdapterProcessError } from "../Errors.ts";
import { GrokAdapter } from "../Services/GrokAdapter.ts";
import { makeGrokAdapterLive } from "./GrokAdapter.ts";

const SESSION_ID = "grok-test-session";
const spawns = vi.hoisted(() => [] as Array<{ model?: string; resumeSessionId?: string }>);

vi.mock("../acp/GrokAcpSupport.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../acp/GrokAcpSupport.ts")>()),
  makeGrokAcpRuntime: (input: GrokAcpRuntimeInput) =>
    Effect.sync(() => {
      spawns.push({
        ...(input.grokSettings?.model ? { model: input.grokSettings.model } : {}),
        ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
      });
      return makeFakeAcpSessionRuntime({ sessionId: SESSION_ID });
    }),
}));

const startWith = (input: {
  readonly resumeCursor?: unknown;
  readonly model?: string;
  readonly reasoningEffort?: GrokModelOptions["reasoningEffort"];
}) => {
  spawns.length = 0;
  const layer = makeGrokAdapterLive().pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "grok-resume-model-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      const adapter = yield* GrokAdapter;
      const threadId = ThreadId.makeUnsafe("thread-grok-resume-model");
      const result = yield* adapter
        .startSession({
          provider: "grok" as const,
          threadId,
          runtimeMode: "full-access",
          cwd: process.cwd(),
          ...(input.model
            ? {
                modelSelection: {
                  provider: "grok" as const,
                  model: input.model,
                  ...(input.reasoningEffort
                    ? { options: { reasoningEffort: input.reasoningEffort } }
                    : {}),
                },
              }
            : {}),
          ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        })
        .pipe(Effect.result);
      const live = yield* adapter.hasSession(threadId);
      yield* adapter.stopAll();
      return { result, live, spawns: [...spawns] };
    }).pipe(Effect.provide(layer)),
  );
};

describe("Grok resume model pinning", () => {
  it("records the spawn flags and reloads only a session created with them", async () => {
    const fresh = await startWith({ model: "grok-build", reasoningEffort: "high" });
    expect(fresh.result._tag).toBe("Success");
    const cursor = fresh.result._tag === "Success" ? fresh.result.success.resumeCursor : undefined;
    expect(cursor).toEqual({
      schemaVersion: 1,
      sessionId: SESSION_ID,
      model: "grok-build",
      reasoningEffort: "high",
    });

    const reloaded = await startWith({
      model: "grok-build",
      reasoningEffort: "high",
      resumeCursor: cursor,
    });
    expect(reloaded.result._tag).toBe("Success");
    expect(reloaded.spawns).toEqual([{ model: "grok-build", resumeSessionId: SESSION_ID }]);
    expect(reloaded.result._tag === "Success" && reloaded.result.success.resumeCursor).toEqual(
      cursor,
    );
  });

  it.each([
    {
      name: "another model",
      resumeCursor: { schemaVersion: 1, sessionId: SESSION_ID, model: "grok-4.6" },
      reasoningEffort: undefined,
    },
    {
      name: "another reasoning effort",
      resumeCursor: {
        schemaVersion: 1,
        sessionId: SESSION_ID,
        model: "grok-build",
        reasoningEffort: "high",
      },
      reasoningEffort: "low" as const,
    },
    {
      name: "a legacy cursor that never recorded its flags",
      resumeCursor: { schemaVersion: 1, sessionId: SESSION_ID },
      reasoningEffort: undefined,
    },
  ])(
    "refuses to reload a session created for $name before spawning Grok",
    async ({ resumeCursor, reasoningEffort }) => {
      const {
        result,
        live,
        spawns: started,
      } = await startWith({
        model: "grok-build",
        ...(reasoningEffort ? { reasoningEffort } : {}),
        resumeCursor,
      });
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toBeInstanceOf(ProviderAdapterProcessError);
        expect(result.failure).toMatchObject({ reason: "resume-state-unavailable" });
      }
      expect(started).toEqual([]);
      expect(live).toBe(false);
    },
  );
});
