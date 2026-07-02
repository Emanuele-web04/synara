// FILE: ClaudeTextGeneration.test.ts
// Purpose: Verifies Claude CLI text-generation behavior not covered by provider routing tests.
// Layer: Server git text-generation tests
// Exports: Vitest specs for ClaudeTextGenerationServiceLive

import { describe, it, assert } from "@effect/vitest";
import { Effect, Layer, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ClaudeTextGeneration } from "../Services/TextGeneration.ts";
import { ClaudeTextGenerationServiceLive } from "./ClaudeTextGeneration.ts";

const encoder = new TextEncoder();

function mockHandle(result: { stdout: string; stderr: string; code: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout)),
    stderr: Stream.make(encoder.encode(result.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockSpawnerLayer(
  handler: (
    args: ReadonlyArray<string>,
    command: string,
    env: NodeJS.ProcessEnv | undefined,
  ) => {
    stdout: string;
    stderr: string;
    code: number;
  },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as {
        command: string;
        args: ReadonlyArray<string>;
        options?: { env?: NodeJS.ProcessEnv };
      };
      return Effect.succeed(mockHandle(handler(cmd.args, cmd.command, cmd.options?.env)));
    }),
  );
}

function withProcessPlatform<T, E, R>(
  platform: NodeJS.Platform,
  effect: Effect.Effect<T, E, R>,
): Effect.Effect<T, E, R> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", { value: platform });
      return descriptor;
    }),
    () => effect,
    (descriptor) =>
      Effect.sync(() => {
        if (descriptor) {
          Object.defineProperty(process, "platform", descriptor);
        }
      }),
  );
}

describe("ClaudeTextGenerationServiceLive", () => {
  it.effect("uses configured Claude instance home as a Windows profile environment", () =>
    withProcessPlatform(
      "win32",
      Effect.gen(function* () {
        const textGeneration = yield* ClaudeTextGeneration;
        const generated = yield* textGeneration.generateThreadTitle({
          cwd: "C:\\repo",
          message: "Add provider instances",
          modelSelection: {
            instanceId: "claude_work",
            model: "claude-sonnet-4-5",
          },
          providerOptions: {
            claudeAgent: {
              binaryPath: "claude",
              homePath: "C:\\Users\\work\\.claude-work",
              environment: { ANTHROPIC_AUTH_TOKEN: "work-token" },
            },
          },
        });

        assert.strictEqual(generated.title, "Provider instances");
      }),
    ).pipe(
      Effect.provide(ClaudeTextGenerationServiceLive),
      Effect.provide(
        mockSpawnerLayer((args, command, env) => {
          assert.strictEqual(command, "claude");
          assert.deepStrictEqual(args.slice(0, 2), ["-p", "--output-format"]);
          // Pure text generation must run with an empty tool set so untrusted
          // prompt content cannot reach the workspace.
          const toolsFlagIndex = args.indexOf("--tools");
          assert.notStrictEqual(toolsFlagIndex, -1);
          assert.strictEqual(args[toolsFlagIndex + 1], "");
          assert.strictEqual(env?.HOME, "C:\\Users\\work\\.claude-work");
          assert.strictEqual(env?.USERPROFILE, "C:\\Users\\work\\.claude-work");
          assert.strictEqual(env?.APPDATA, "C:\\Users\\work\\.claude-work\\AppData\\Roaming");
          assert.strictEqual(env?.LOCALAPPDATA, "C:\\Users\\work\\.claude-work\\AppData\\Local");
          assert.strictEqual(env?.HOMEDRIVE, "C:");
          assert.strictEqual(env?.HOMEPATH, "\\Users\\work\\.claude-work");
          assert.strictEqual(env?.ANTHROPIC_AUTH_TOKEN, "work-token");
          return {
            stdout: '{"structured_output":{"title":"Provider instances"}}\n',
            stderr: "",
            code: 0,
          };
        }),
      ),
    ),
  );
});
