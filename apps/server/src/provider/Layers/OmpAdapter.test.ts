import { TurnId } from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it } from "vitest";
import { SYNARA_HARNESS_POLICY_MARKER } from "../../agentGateway/harnessPolicy.ts";
import { ServerConfig } from "../../config.ts";

import {
  isOmpNestedTaskToolCall,
  isRenderableOmpAssistantDelta,
  makeOmpAdapter,
  resolveOmpSessionCwd,
  scopeOmpRuntimeItemIdForTurn,
  scopeOmpToolCallStateForTurn,
  shouldIgnoreOmpInterrupt,
  takeOmpSynaraHarnessPolicyTextPart,
} from "./OmpAdapter.ts";

describe("OMP Synara harness policy", () => {
  it("delivers private scoped host context once", () => {
    const state: { harnessPolicyDelivered?: boolean } = {};
    expect(takeOmpSynaraHarnessPolicyTextPart(state, true)?.text).toContain(
      SYNARA_HARNESS_POLICY_MARKER,
    );
    expect(takeOmpSynaraHarnessPolicyTextPart(state, true)).toBeNull();
  });
});

describe("OmpAdapter model discovery", () => {
  it("returns only the CLI catalog without reading role config, sharing it across projects", async () => {
    let spawns = 0;
    const spawner = ChildProcessSpawner.make((command) => {
      expect(command).toMatchObject({ command: "/bin/omp-fixture", args: ["models", "--json"] });
      spawns += 1;
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(0x7fff_fffe),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.make(
            new TextEncoder().encode(
              JSON.stringify({
                models: [
                  {
                    selector: "upstream/model",
                    name: "Model",
                    provider: "upstream",
                    thinking: ["high"],
                  },
                ],
              }),
            ),
          ),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    });
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const adapter = yield* makeOmpAdapter({ binaryPath: "/bin/omp-fixture" }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(ServerConfig, serverConfig),
          Effect.provideService(FileSystem.FileSystem, {
            ...fileSystem,
            exists: () => Effect.die("Model discovery must not inspect config files."),
            readFileString: () => Effect.die("Model discovery must not read role config."),
          }),
        );
        const listModels = adapter.listModels!;
        const first = yield* listModels({ provider: "omp", cwd: "/first" });
        const second = yield* listModels({ provider: "omp", cwd: "/second" });
        return { first, second };
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(results.first).toEqual({
      models: [
        {
          slug: "upstream/model",
          name: "Model",
          upstreamProviderId: "upstream",
          supportedReasoningEfforts: [{ value: "high", label: "High" }],
        },
      ],
      source: "omp-cli",
      cached: false,
    });
    expect(results.second).toEqual({ ...results.first, cached: true });
    expect(spawns).toBe(1);
  });
});

const serverConfig = {
  cwd: "/server/cwd",
  homeDir: "/home/test",
} as Parameters<typeof resolveOmpSessionCwd>[1];

describe("resolveOmpSessionCwd", () => {
  it("prefers an explicit cwd over the active thread session cwd", () => {
    expect(resolveOmpSessionCwd("/explicit", serverConfig, "/thread")).toBe("/explicit");
  });

  it("uses the active thread session cwd before the server fallback", () => {
    expect(resolveOmpSessionCwd(undefined, serverConfig, "/thread")).toBe("/thread");
  });
});

describe("OmpAdapter runtime event scoping", () => {
  it("makes reused ACP assistant segment ids unique per turn", () => {
    const providerItemId = "assistant:omp-session:segment:5";

    expect(scopeOmpRuntimeItemIdForTurn(TurnId.makeUnsafe("turn-a"), providerItemId)).toBe(
      "omp:turn-a:assistant:omp-session:segment:5",
    );
    expect(scopeOmpRuntimeItemIdForTurn(TurnId.makeUnsafe("turn-b"), providerItemId)).toBe(
      "omp:turn-b:assistant:omp-session:segment:5",
    );
  });

  it("preserves the provider tool id while scoping the runtime item id", () => {
    const scoped = scopeOmpToolCallStateForTurn(TurnId.makeUnsafe("turn-a"), {
      toolCallId: "call-1",
      kind: "execute",
      status: "completed",
      title: "Ran command",
      data: {
        toolCallId: "call-1",
      },
    });

    expect(scoped.toolCallId).toBe("omp:turn-a:call-1");
    expect(scoped.data).toMatchObject({
      toolCallId: "call-1",
      providerToolCallId: "call-1",
    });
  });

  it("only treats visible assistant text as renderable OMP content", () => {
    expect(
      isRenderableOmpAssistantDelta({
        streamKind: "assistant_text",
        text: "done",
      }),
    ).toBe(true);
    expect(
      isRenderableOmpAssistantDelta({
        streamKind: "assistant_text",
        text: "   ",
      }),
    ).toBe(false);
  });

  it("recognizes nested Task rows whose child progress is hidden from parent ACP", () => {
    expect(
      isOmpNestedTaskToolCall({
        toolCallId: "task-1",
        title: "Task",
        status: "pending",
        data: { rawInput: { subagent_type: "worker" } },
      }),
    ).toBe(true);
    expect(
      isOmpNestedTaskToolCall({
        toolCallId: "read-1",
        title: "Read",
        status: "pending",
        data: {},
      }),
    ).toBe(false);
  });

  it("ignores a delayed stop when its turn is no longer active", () => {
    const oldTurnId = TurnId.makeUnsafe("turn-a");
    const newTurnId = TurnId.makeUnsafe("turn-b");

    expect(shouldIgnoreOmpInterrupt(oldTurnId, newTurnId)).toBe(true);
    expect(shouldIgnoreOmpInterrupt(oldTurnId, undefined)).toBe(true);
    expect(shouldIgnoreOmpInterrupt(newTurnId, newTurnId)).toBe(false);
    expect(shouldIgnoreOmpInterrupt(undefined, newTurnId)).toBe(false);
  });
});
