// FILE: opencodeRuntime.poolIdentity.test.ts
// Purpose: Covers managed OpenCode server pool identity normalization.
// Layer: Provider runtime tests
// Exports: Vitest regressions for OpenCode local server reuse

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { Effect, Exit, Layer, Scope, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it } from "vitest";

import { makeOpenCodeRuntimeLive, OpenCodeRuntime, OPENCODE_CLI_SPEC } from "./opencodeRuntime.ts";

const encoder = new TextEncoder();

function mockPooledOpenCodeServerSpawnerLayer(state: {
  spawnUrls: Array<string>;
  spawnCwds?: Array<string | undefined>;
}) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as {
        options?: { cwd?: string };
      };
      const url = `http://127.0.0.1:${59000 + state.spawnUrls.length}`;
      const pid = 59_000 + state.spawnUrls.length;
      state.spawnUrls.push(url);
      state.spawnCwds?.push(cmd.options?.cwd);
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(pid),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode(`opencode server listening on ${url}\n`)),
          stderr: Stream.make(encoder.encode("")),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    }),
  );
}

function openCodeRuntimePoolTestLayer(state: {
  spawnUrls: Array<string>;
  spawnCwds?: Array<string | undefined>;
}) {
  return makeOpenCodeRuntimeLive({
    netService: {
      canListenOnHost: () => Effect.succeed(true),
      isPortAvailableOnLoopback: () => Effect.succeed(true),
      reserveLoopbackPort: () => Effect.succeed(59_000),
      findAvailablePort: () => Effect.succeed(59_000),
    },
    teardownProcessTree: async () => ({ escalated: false, signalErrors: [] }),
  }).pipe(Layer.provide(mockPooledOpenCodeServerSpawnerLayer(state)));
}

describe("OpenCode local server pool identity", () => {
  it("normalizes equivalent cwd spellings before pooling and spawning", async () => {
    const state = {
      spawnUrls: [] as Array<string>,
      spawnCwds: [] as Array<string | undefined>,
    };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const firstScope = yield* Scope.make();
          const secondScope = yield* Scope.make();

          const first = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode", cwd: "." })
            .pipe(Effect.provideService(Scope.Scope, firstScope));
          const second = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode", cwd: process.cwd() })
            .pipe(Effect.provideService(Scope.Scope, secondScope));

          expect(second.url).toBe(first.url);
          expect(state.spawnUrls).toEqual(["http://127.0.0.1:59000"]);
          expect(state.spawnCwds).toEqual([process.cwd()]);

          yield* Scope.close(firstScope, Exit.void);
          yield* Scope.close(secondScope, Exit.void);
        }),
      ).pipe(Effect.provide(openCodeRuntimePoolTestLayer(state))),
    );
  });

  it("ignores CLI metadata that does not change the managed server process", async () => {
    const state = { spawnUrls: [] as Array<string> };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const firstScope = yield* Scope.make();
          const secondScope = yield* Scope.make();

          const first = yield* runtime
            .connectToOpenCodeServer({
              binaryPath: "opencode",
              cliSpec: OPENCODE_CLI_SPEC,
            })
            .pipe(Effect.provideService(Scope.Scope, firstScope));
          const second = yield* runtime
            .connectToOpenCodeServer({
              binaryPath: "opencode",
              cliSpec: { ...OPENCODE_CLI_SPEC, displayName: "OpenCode discovery" },
            })
            .pipe(Effect.provideService(Scope.Scope, secondScope));

          expect(second.url).toBe(first.url);
          expect(state.spawnUrls).toEqual(["http://127.0.0.1:59000"]);

          yield* Scope.close(firstScope, Exit.void);
          yield* Scope.close(secondScope, Exit.void);
        }),
      ).pipe(Effect.provide(openCodeRuntimePoolTestLayer(state))),
    );
  });

  it.each(["absolute", "relative"])(
    "preserves %s cwd parent traversal through a symlink",
    async (spelling) => {
      const fixture = realpathSync(mkdtempSync(join(tmpdir(), "opencode-pool-")));
      const workspace = join(fixture, "workspace");
      const target = join(fixture, "target");
      const child = join(target, "child");
      const state = {
        spawnUrls: [] as Array<string>,
        spawnCwds: [] as Array<string | undefined>,
      };

      try {
        mkdirSync(workspace);
        mkdirSync(child, { recursive: true });
        symlinkSync(
          child,
          join(workspace, "link"),
          process.platform === "win32" ? "junction" : "dir",
        );
        // join/resolve would erase the parent traversal before the test reaches the runtime.
        const absoluteCwd = `${workspace}${sep}link${sep}..`;
        const cwd =
          spelling === "relative"
            ? `${relative(process.cwd(), workspace)}${sep}link${sep}..`
            : absoluteCwd;

        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const runtime = yield* OpenCodeRuntime;
              const throughLink = yield* runtime.connectToOpenCodeServer({
                binaryPath: "opencode",
                cwd,
              });
              const direct = yield* runtime.connectToOpenCodeServer({
                binaryPath: "opencode",
                cwd: workspace,
              });

              expect(throughLink.url).not.toBe(direct.url);
              expect(state.spawnCwds).toEqual([cwd, workspace]);
              // Exercise the OS cwd semantics rather than Node's lexical JS realpath implementation.
              const physicalCwd = (directory: string) =>
                execFileSync(process.execPath, ["-p", "process.cwd()"], {
                  cwd: directory,
                  encoding: "utf8",
                }).trim();
              expect(physicalCwd(state.spawnCwds[0]!)).toBe(physicalCwd(cwd));
              if (process.platform !== "win32") {
                expect(physicalCwd(state.spawnCwds[0]!)).toBe(physicalCwd(target));
              }
              expect(physicalCwd(state.spawnCwds[1]!)).toBe(physicalCwd(workspace));
            }),
          ).pipe(Effect.provide(openCodeRuntimePoolTestLayer(state))),
        );
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not hide a missing directory before parent traversal",
    async () => {
      const fixture = realpathSync(mkdtempSync(join(tmpdir(), "opencode-pool-")));
      const cwd = `${fixture}${sep}missing${sep}..`;
      const state = {
        spawnUrls: [] as Array<string>,
        spawnCwds: [] as Array<string | undefined>,
      };

      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const runtime = yield* OpenCodeRuntime;
              yield* runtime.connectToOpenCodeServer({ binaryPath: "opencode", cwd });
              expect(state.spawnCwds).toEqual([cwd]);
              expect(() =>
                execFileSync(process.execPath, ["-p", "process.cwd()"], {
                  cwd: state.spawnCwds[0],
                }),
              ).toThrow();
            }),
          ).pipe(Effect.provide(openCodeRuntimePoolTestLayer(state))),
        );
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    },
  );
});
