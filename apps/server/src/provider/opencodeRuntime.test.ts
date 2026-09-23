// FILE: opencodeRuntime.test.ts
// Purpose: Covers OpenCode runtime parsing and local server startup diagnostics.
// Layer: Provider runtime tests
// Exports: Vitest suites for opencodeRuntime.ts

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

import { Deferred, Duration, Effect, Exit, Fiber, Layer, Scope, Sink, Stream } from "effect";
import { systemError } from "effect/PlatformError";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { type ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { TestClock } from "effect/testing";
import type { ChatAttachment } from "@synara/contracts";
import { resolveWindowsComSpec } from "@synara/shared/windowsProcess";
import { describe, expect, it, vi } from "vitest";

import {
  buildOpenCodePermissionRules,
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  makeOpenCodeRuntimeLive,
  OPENCODE_LOCAL_SERVER_IDLE_TTL_MS,
  parseOpenCodeCliModelsOutput,
  parseOpenCodeCredentialProviderIDs,
  supportsVerboseModelsCommandFailure,
  toOpenCodeFileParts,
} from "./opencodeRuntime.ts";
import {
  buildOpenCodeServerProcessEnv,
  openCodeBinarySearchDirectories,
} from "./providerBinaryResolution.ts";

const encoder = new TextEncoder();

describe("OpenCode permission policy", () => {
  it("keeps full access non-interactive while enforcing read-only Plan turns", () => {
    expect(buildOpenCodePermissionRules("full-access")).toEqual([
      { permission: "*", pattern: "*", action: "allow" },
    ]);
    expect(buildOpenCodePermissionRules("full-access", "plan")).toEqual([
      { permission: "*", pattern: "*", action: "deny" },
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "glob", pattern: "*", action: "allow" },
      { permission: "grep", pattern: "*", action: "allow" },
      { permission: "list", pattern: "*", action: "allow" },
      { permission: "lsp", pattern: "*", action: "allow" },
      { permission: "webfetch", pattern: "*", action: "allow" },
      { permission: "websearch", pattern: "*", action: "allow" },
      { permission: "codesearch", pattern: "*", action: "allow" },
      { permission: "todoread", pattern: "*", action: "allow" },
      { permission: "todowrite", pattern: "*", action: "allow" },
      { permission: "question", pattern: "*", action: "allow" },
    ]);
  });
});

function mockOpenCodeServerHandle(input: {
  stdout: string;
  stderr: string;
  pid?: number;
  exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode, never>;
  kill?: () => Effect.Effect<void, never>;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(input.pid ?? 0x7fff_fffe),
    exitCode: input.exitCode ?? Effect.never,
    isRunning: Effect.succeed(true),
    kill: input.kill ?? (() => Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(input.stdout)),
    stderr: Stream.make(encoder.encode(input.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockOpenCodeServerSpawnerLayer(input: {
  stdout: string;
  stderr: string;
  spawnedCommands?: Array<ChildProcess.StandardCommand>;
}) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      if (command._tag === "StandardCommand") input.spawnedCommands?.push(command);
      return Effect.succeed(mockOpenCodeServerHandle(input));
    }),
  );
}

function mockPooledOpenCodeServerSpawnerLayer(state: {
  spawnUrls: Array<string>;
  spawnCwds?: Array<string | undefined>;
  killUrls: Array<string>;
  processUrls?: Map<number, string>;
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
      state.processUrls?.set(pid, url);
      return Effect.succeed(
        mockOpenCodeServerHandle({
          stdout: `opencode server listening on ${url}\n`,
          stderr: "",
          pid,
          kill: () =>
            Effect.sync(() => {
              state.killUrls.push(url);
            }),
        }),
      );
    }),
  );
}

const advanceOpenCodePoolIdleClock = Effect.gen(function* () {
  yield* Effect.yieldNow;
  yield* TestClock.adjust(Duration.millis(OPENCODE_LOCAL_SERVER_IDLE_TTL_MS + 1));
  yield* Effect.yieldNow;
});

const advanceOpenCodePoolAlmostToIdle = Effect.gen(function* () {
  yield* Effect.yieldNow;
  yield* TestClock.adjust(Duration.millis(OPENCODE_LOCAL_SERVER_IDLE_TTL_MS - 1));
  yield* Effect.yieldNow;
});

function openCodeRuntimePoolTestLayer(state: {
  spawnUrls: Array<string>;
  killUrls: Array<string>;
}) {
  const processUrls = new Map<number, string>();
  return Layer.merge(
    makeOpenCodeRuntimeLive({
      netService: {
        canListenOnHost: () => Effect.succeed(true),
        isPortAvailableOnLoopback: () => Effect.succeed(true),
        reserveLoopbackPort: () => Effect.succeed(59_000),
        findAvailablePort: () => Effect.succeed(59_000),
      },
      fetchImpl: () => Promise.resolve(new Response("{}", { status: 200 })),
      teardownProcessTree: async ({ rootPid }) => {
        const url = processUrls.get(rootPid);
        if (url) state.killUrls.push(url);
        return { escalated: false, signalErrors: [] };
      },
    }).pipe(Layer.provide(mockPooledOpenCodeServerSpawnerLayer({ ...state, processUrls }))),
    TestClock.layer(),
  );
}

it("bounds optional console discovery and aborts its stalled HTTP request", async () => {
  const requested = Effect.runSync(Deferred.make<void>());
  let requestSignal: AbortSignal | undefined;
  const client = {
    provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
    app: { agents: async () => ({ data: [] }) },
    experimental: {
      console: {
        get: async (_input: unknown, options?: { signal?: AbortSignal }) => {
          requestSignal = options?.signal;
          Effect.runSync(Deferred.succeed(requested, undefined));
          return await new Promise(() => {});
        },
      },
    },
  } as unknown as OpencodeClient;
  const inventory = await Effect.runPromise(
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const loading = yield* runtime.loadOpenCodeInventory(client).pipe(Effect.forkChild);
      yield* Deferred.await(requested);
      yield* TestClock.adjust("2 seconds");
      return yield* Fiber.join(loading);
    }).pipe(
      Effect.provide(openCodeRuntimePoolTestLayer({ spawnUrls: [], killUrls: [] })),
      Effect.scoped,
    ),
  );
  expect(inventory).toEqual({
    providerList: { all: [], connected: [], default: {} },
    agents: [],
    consoleState: null,
  });
  expect(requestSignal?.aborted).toBe(true);
});

describe("toOpenCodeFileParts", () => {
  it("materializes image attachments as SDK file parts", () => {
    const attachment = {
      type: "image",
      id: "thread-attachment-image",
      name: "screenshot.png",
      mimeType: "image/png",
      sizeBytes: 12,
    } satisfies ChatAttachment;

    expect(
      toOpenCodeFileParts({
        attachments: [attachment],
        resolveAttachmentPath: () => "/tmp/synara-attachments/screenshot.png",
      }),
    ).toEqual([
      {
        type: "file",
        mime: "image/png",
        filename: "screenshot.png",
        url: pathToFileURL("/tmp/synara-attachments/screenshot.png").href,
      },
    ]);
  });

  it("leaves generic files for prompt-path projection", () => {
    const attachment = {
      type: "file",
      id: "thread-attachment-file",
      name: "notes.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: 12,
    } satisfies ChatAttachment;

    expect(
      toOpenCodeFileParts({
        attachments: [attachment],
        resolveAttachmentPath: () => "/tmp/synara-attachments/notes.docx",
      }),
    ).toEqual([]);
  });
});

describe("buildOpenCodeServerProcessEnv", () => {
  it("does not override file-based config with synthetic empty config content", () => {
    const env = buildOpenCodeServerProcessEnv({
      baseEnv: {
        PATH: "/usr/bin",
      },
    });

    expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(env.PATH?.split(delimiter)[0]).toBe("/usr/bin");
  });

  it("preserves an explicitly configured config-content environment value", () => {
    const env = buildOpenCodeServerProcessEnv({
      baseEnv: {
        OPENCODE_CONFIG_CONTENT: '{"provider":{"openai":{}}}',
      },
    });

    expect(env.OPENCODE_CONFIG_CONTENT).toBe('{"provider":{"openai":{}}}');
  });

  it("strips inherited Synara authority from managed server processes", () => {
    const env = buildOpenCodeServerProcessEnv({
      baseEnv: {
        OPENAI_API_KEY: "provider-key",
        SYNARA_AUTH_TOKEN: "server-secret",
        SYNARA_BROWSER_USE_PIPE_PATH: "/tmp/browser.sock",
      },
    });

    expect(env.OPENAI_API_KEY).toBe("provider-key");
    expect(env.SYNARA_AUTH_TOKEN).toBeUndefined();
    expect(env.SYNARA_BROWSER_USE_PIPE_PATH).toBeUndefined();
  });

  it("appends install directories containing the CLI to PATH", () => {
    const home = mkdtempSync(join(tmpdir(), "synara-opencode-env-"));
    try {
      mkdirSync(join(home, ".opencode", "bin"), { recursive: true });
      const binary = join(home, ".opencode", "bin", "opencode");
      writeFileSync(binary, "#!/bin/sh\n");
      chmodSync(binary, 0o755);
      const env = buildOpenCodeServerProcessEnv({
        baseEnv: {
          PATH: "/usr/bin",
          HOME: home,
        },
      });
      expect(env.PATH?.split(":")).toContain(join(home, ".opencode", "bin"));
      expect(env.PATH?.startsWith("/usr/bin")).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("lists the installer and program dirs under Windows", () => {
    const dirs = openCodeBinarySearchDirectories({
      platform: "win32",
      env: {
        USERPROFILE: "C:\\Users\\test",
        LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
      },
    });
    expect(dirs).toContain("C:\\Users\\test\\.opencode\\bin");
    expect(dirs).toContain("C:\\Users\\test\\AppData\\Local\\Programs\\opencode");
  });
});

describe("OpenCodeRuntime startup diagnostics", () => {
  it("wraps Windows .cmd server shims before spawning", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const spawnedCommands: Array<ChildProcess.StandardCommand> = [];

    try {
      const server = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* OpenCodeRuntime;
            return yield* runtime.startOpenCodeServerProcess({
              binaryPath: "C:\\Users\\Test User\\AppData\\Roaming\\npm\\opencode.cmd",
              hostname: "127.0.0.1",
              port: 58_123,
            });
          }),
        ).pipe(
          Effect.provide(
            makeOpenCodeRuntimeLive({
              fetchImpl: () => Promise.resolve(new Response("{}", { status: 200 })),
              teardownProcessTree: async () => ({
                escalated: false,
                signalErrors: [],
              }),
            }).pipe(
              Layer.provide(
                mockOpenCodeServerSpawnerLayer({
                  stdout: "opencode server listening on http://127.0.0.1:58123\n",
                  stderr: "",
                  spawnedCommands,
                }),
              ),
            ),
          ),
        ),
      );

      expect(server.url).toBe("http://127.0.0.1:58123");
      expect(server.serverPassword).toMatch(/^[A-Za-z0-9_-]{32,}$/u);
      expect(spawnedCommands).toHaveLength(1);
      expect(spawnedCommands[0]).toMatchObject({
        command: resolveWindowsComSpec(),
        args: [
          "/d",
          "/s",
          "/v:off",
          "/c",
          'call "C:\\Users\\Test User\\AppData\\Roaming\\npm\\opencode.cmd" "serve" "--hostname" "127.0.0.1" "--port" "58123"',
        ],
        options: {
          shell: false,
          windowsVerbatimArguments: true,
        },
      });
      const spawnOptions = spawnedCommands[0]?.options as { env?: NodeJS.ProcessEnv } | undefined;
      expect(spawnOptions?.env?.OPENCODE_SERVER_USERNAME).toBe("opencode");
      expect(spawnOptions?.env?.OPENCODE_SERVER_PASSWORD).toBe(server.serverPassword);
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("includes command and partial process output when server startup times out", async () => {
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          return yield* runtime
            .startOpenCodeServerProcess({
              binaryPath: "/custom/bin/opencode",
              hostname: "127.0.0.1",
              port: 58123,
              timeoutMs: 5,
            })
            .pipe(Effect.flip);
        }),
      ).pipe(
        Effect.provide(
          makeOpenCodeRuntimeLive({
            teardownProcessTree: async () => ({
              escalated: false,
              signalErrors: [],
            }),
          }).pipe(
            Layer.provide(
              mockOpenCodeServerSpawnerLayer({
                stdout: "booting custom OpenCode wrapper\n",
                stderr: "loading provider credentials\n",
              }),
            ),
          ),
        ),
      ),
    );

    expect(OpenCodeRuntimeError.is(error)).toBe(true);
    expect(error.detail).toContain("Timed out waiting for OpenCode server start after 5ms.");
    expect(error.detail).toContain(
      "command: /custom/bin/opencode serve --hostname 127.0.0.1 --port 58123",
    );
    expect(error.detail).toContain('OpenCode ready prefix: "server listening"');
    expect(error.detail).toContain("stdout:\nbooting custom OpenCode wrapper");
    expect(error.detail).toContain("stderr:\nloading provider credentials");
  });

  it("accepts the OpenCode 2.x server startup marker", async () => {
    const server = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          return yield* runtime.startOpenCodeServerProcess({
            binaryPath: "opencode",
            hostname: "127.0.0.1",
            port: 58_123,
          });
        }),
      ).pipe(
        Effect.provide(
          makeOpenCodeRuntimeLive({
            fetchImpl: () => Promise.resolve(new Response("{}", { status: 200 })),
            teardownProcessTree: async () => ({
              escalated: false,
              signalErrors: [],
            }),
          }).pipe(
            Layer.provide(
              mockOpenCodeServerSpawnerLayer({
                stdout: "server listening on http://127.0.0.1:58123\n",
                stderr: "",
              }),
            ),
          ),
        ),
      ),
    );

    expect(server.url).toBe("http://127.0.0.1:58123");
  });

  it("fails startup when the server does not serve the legacy surface", async () => {
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          return yield* runtime
            .startOpenCodeServerProcess({
              binaryPath: "opencode",
              hostname: "127.0.0.1",
              port: 58_123,
            })
            .pipe(Effect.flip);
        }),
      ).pipe(
        Effect.provide(
          makeOpenCodeRuntimeLive({
            fetchImpl: () => Promise.resolve(new Response("{}", { status: 404 })),
            teardownProcessTree: async () => ({
              escalated: false,
              signalErrors: [],
            }),
          }).pipe(
            Layer.provide(
              mockOpenCodeServerSpawnerLayer({
                stdout: "server listening on http://127.0.0.1:58123\n",
                stderr: "",
              }),
            ),
          ),
        ),
      ),
    );

    expect(OpenCodeRuntimeError.is(error)).toBe(true);
    expect(error.detail).toContain("does not serve the legacy surface");
    expect(error.detail).toContain("GET /provider → HTTP 404");
    expect(error.detail).not.toContain("2.x");
  });

  it("retries the surface probe through a transient failure before succeeding", async () => {
    let probeCalls = 0;
    const server = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          return yield* runtime.startOpenCodeServerProcess({
            binaryPath: "opencode",
            hostname: "127.0.0.1",
            port: 58_123,
          });
        }),
      ).pipe(
        Effect.provide(
          makeOpenCodeRuntimeLive({
            fetchImpl: () => {
              probeCalls += 1;
              return Promise.resolve(new Response("{}", { status: probeCalls === 1 ? 500 : 200 }));
            },
            teardownProcessTree: async () => ({
              escalated: false,
              signalErrors: [],
            }),
          }).pipe(
            Layer.provide(
              mockOpenCodeServerSpawnerLayer({
                stdout: "server listening on http://127.0.0.1:58123\n",
                stderr: "",
              }),
            ),
          ),
        ),
      ),
    );

    expect(server.url).toBe("http://127.0.0.1:58123");
    expect(probeCalls).toBe(2);
  });

  it("reports a distinct probe error for non-surface statuses like 401", async () => {
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          return yield* runtime
            .startOpenCodeServerProcess({
              binaryPath: "opencode",
              hostname: "127.0.0.1",
              port: 58_123,
            })
            .pipe(Effect.flip);
        }),
      ).pipe(
        Effect.provide(
          makeOpenCodeRuntimeLive({
            fetchImpl: () => Promise.resolve(new Response("{}", { status: 401 })),
            teardownProcessTree: async () => ({
              escalated: false,
              signalErrors: [],
            }),
          }).pipe(
            Layer.provide(
              mockOpenCodeServerSpawnerLayer({
                stdout: "server listening on http://127.0.0.1:58123\n",
                stderr: "",
              }),
            ),
          ),
        ),
      ),
    );

    expect(OpenCodeRuntimeError.is(error)).toBe(true);
    expect(error.detail).toContain("did not pass the legacy surface probe");
    expect(error.detail).toContain("HTTP 401");
    expect(error.detail).toContain("rejected the credentials");
    expect(error.detail).not.toContain("2.x");
  });

  it("adds the install hint to spawn permission failures", async () => {
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          return yield* runtime
            .startOpenCodeServerProcess({
              binaryPath: "opencode",
              hostname: "127.0.0.1",
              port: 58_123,
            })
            .pipe(Effect.flip);
        }),
      ).pipe(
        Effect.provide(
          makeOpenCodeRuntimeLive({
            teardownProcessTree: async () => ({
              escalated: false,
              signalErrors: [],
            }),
          }).pipe(
            Layer.provide(
              Layer.succeed(
                ChildProcessSpawner.ChildProcessSpawner,
                ChildProcessSpawner.make(() =>
                  Effect.fail(
                    systemError({
                      _tag: "PermissionDenied",
                      module: "ChildProcess",
                      method: "spawn",
                      description: "spawn opencode: EACCES",
                    }),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );

    expect(OpenCodeRuntimeError.is(error)).toBe(true);
    expect(error.detail).toContain("install it (https://opencode.ai)");
  });

  it("recognizes the OpenCode 2.x verbose-models flag error", () => {
    expect(
      supportsVerboseModelsCommandFailure(
        "",
        "Unrecognized flag: --verbose in command opencode models",
      ),
    ).toBe(true);
  });

  it("redacts likely secrets from startup timeout diagnostics and causes", async () => {
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          return yield* runtime
            .startOpenCodeServerProcess({
              binaryPath: "/custom/bin/opencode",
              hostname: "127.0.0.1",
              port: 58123,
              timeoutMs: 5,
            })
            .pipe(Effect.flip);
        }),
      ).pipe(
        Effect.provide(
          makeOpenCodeRuntimeLive({
            teardownProcessTree: async () => ({
              escalated: false,
              signalErrors: [],
            }),
          }).pipe(
            Layer.provide(
              mockOpenCodeServerSpawnerLayer({
                stdout: "OPENAI_API_KEY=sk-live-123\nauth_token: token-abc\nsafe line\n",
                stderr: 'Authorization: Bearer auth-secret\nserverPassword="pw-secret"\n',
              }),
            ),
          ),
        ),
      ),
    );
    const causeJson = JSON.stringify(error.cause);

    expect(error.detail).toContain("OPENAI_API_KEY=[redacted]");
    expect(error.detail).toContain("auth_token: [redacted]");
    expect(error.detail).toContain("Authorization: Bearer [redacted]");
    expect(error.detail).toContain('serverPassword="[redacted]"');
    expect(error.detail).toContain("safe line");
    for (const secret of ["sk-live-123", "token-abc", "auth-secret", "pw-secret"]) {
      expect(error.detail).not.toContain(secret);
      expect(causeJson).not.toContain(secret);
    }
  });
});

describe("OpenCodeRuntime local server pool", () => {
  it("keeps server scope closure pending until process-tree exit is proven", async () => {
    let proveExit: (() => void) | undefined;
    const exitProof = new Promise<void>((resolve) => {
      proveExit = resolve;
    });
    let teardownCalls = 0;
    const layer = makeOpenCodeRuntimeLive({
      netService: {
        canListenOnHost: () => Effect.succeed(true),
        isPortAvailableOnLoopback: () => Effect.succeed(true),
        reserveLoopbackPort: () => Effect.succeed(59_000),
        findAvailablePort: () => Effect.succeed(59_000),
      },
      fetchImpl: () => Promise.resolve(new Response("{}", { status: 200 })),
      teardownProcessTree: async ({ rootPid }) => {
        teardownCalls += 1;
        expect(rootPid).toBe(0x7fff_fffe);
        await exitProof;
        return { escalated: false, signalErrors: [] };
      },
    }).pipe(
      Layer.provide(
        mockOpenCodeServerSpawnerLayer({
          stdout: "opencode server listening on http://127.0.0.1:59000\n",
          stderr: "",
        }),
      ),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const serverScope = yield* Scope.make("sequential");
          yield* runtime
            .startOpenCodeServerProcess({ binaryPath: "opencode" })
            .pipe(Effect.provideService(Scope.Scope, serverScope));

          const closing = yield* Scope.close(serverScope, Exit.void).pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          expect(teardownCalls).toBe(1);
          expect(closing.pollUnsafe()).toBeUndefined();

          proveExit?.();
          yield* Fiber.join(closing);
        }),
      ).pipe(Effect.provide(layer)),
    );
  });

  it("reuses a local server while scoped sessions are active and closes it after idling", async () => {
    const state = { spawnUrls: [] as Array<string>, killUrls: [] as Array<string> };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const firstScope = yield* Scope.make();
          const secondScope = yield* Scope.make();

          const first = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode" })
            .pipe(Effect.provideService(Scope.Scope, firstScope));
          const second = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode" })
            .pipe(Effect.provideService(Scope.Scope, secondScope));

          expect(first.external).toBe(false);
          expect(first.url).toBe(second.url);
          expect(state.spawnUrls).toEqual(["http://127.0.0.1:59000"]);

          yield* Scope.close(firstScope, Exit.void);
          yield* advanceOpenCodePoolIdleClock;
          expect(state.killUrls).toEqual([]);

          yield* Scope.close(secondScope, Exit.void);
          yield* advanceOpenCodePoolIdleClock;
          expect(state.killUrls).toEqual(["http://127.0.0.1:59000"]);

          const thirdScope = yield* Scope.make();
          const third = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode" })
            .pipe(Effect.provideService(Scope.Scope, thirdScope));
          expect(third.url).toBe("http://127.0.0.1:59001");
          expect(state.spawnUrls).toEqual(["http://127.0.0.1:59000", "http://127.0.0.1:59001"]);
          yield* Scope.close(thirdScope, Exit.void);
        }),
      ).pipe(Effect.provide(openCodeRuntimePoolTestLayer(state))),
    );
  });

  it("isolates same-cwd owners and closes private servers immediately on release", async () => {
    const state = { spawnUrls: [] as Array<string>, killUrls: [] as Array<string> };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const firstScope = yield* Scope.make();
          const secondScope = yield* Scope.make();
          const first = yield* runtime
            .connectToOpenCodeServer({
              binaryPath: "opencode",
              cwd: "/repo",
              poolIsolationKey: "synara-thread-a",
            })
            .pipe(Effect.provideService(Scope.Scope, firstScope));
          const second = yield* runtime
            .connectToOpenCodeServer({
              binaryPath: "opencode",
              cwd: "/repo",
              poolIsolationKey: "synara-thread-b",
            })
            .pipe(Effect.provideService(Scope.Scope, secondScope));

          expect(first.url).not.toBe(second.url);
          expect(state.spawnUrls).toEqual(["http://127.0.0.1:59000", "http://127.0.0.1:59001"]);

          yield* Scope.close(firstScope, Exit.void);
          expect(state.killUrls).toEqual(["http://127.0.0.1:59000"]);
          yield* Scope.close(secondScope, Exit.void);
          expect(state.killUrls).toEqual(["http://127.0.0.1:59000", "http://127.0.0.1:59001"]);
        }),
      ).pipe(Effect.provide(openCodeRuntimePoolTestLayer(state))),
    );
  });

  it("does not spawn or pool when an external OpenCode server URL is configured", async () => {
    const state = { spawnUrls: [] as Array<string>, killUrls: [] as Array<string> };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const connection = yield* runtime.connectToOpenCodeServer({
            binaryPath: "opencode",
            serverUrl: " http://127.0.0.1:9999 ",
          });

          expect(connection).toMatchObject({
            url: "http://127.0.0.1:9999",
            exitCode: null,
            external: true,
          });
          expect(state.spawnUrls).toEqual([]);
          expect(state.killUrls).toEqual([]);
        }),
      ).pipe(Effect.provide(openCodeRuntimePoolTestLayer(state))),
    );
  });

  it("keeps the warm server alive when a new session starts before idle expiry", async () => {
    const state = { spawnUrls: [] as Array<string>, killUrls: [] as Array<string> };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const firstScope = yield* Scope.make();
          const first = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode" })
            .pipe(Effect.provideService(Scope.Scope, firstScope));

          yield* Scope.close(firstScope, Exit.void);
          yield* advanceOpenCodePoolAlmostToIdle;

          const secondScope = yield* Scope.make();
          const second = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode" })
            .pipe(Effect.provideService(Scope.Scope, secondScope));

          expect(second.url).toBe(first.url);
          expect(state.spawnUrls).toEqual(["http://127.0.0.1:59000"]);

          yield* advanceOpenCodePoolIdleClock;
          expect(state.killUrls).toEqual([]);

          yield* Scope.close(secondScope, Exit.void);
          yield* advanceOpenCodePoolIdleClock;
          expect(state.killUrls).toEqual(["http://127.0.0.1:59000"]);
        }),
      ).pipe(Effect.provide(openCodeRuntimePoolTestLayer(state))),
    );
  });

  it("keeps incompatible local server keys separate", async () => {
    const state = { spawnUrls: [] as Array<string>, killUrls: [] as Array<string> };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const firstScope = yield* Scope.make();
          const secondScope = yield* Scope.make();

          const defaultServer = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode" })
            .pipe(Effect.provideService(Scope.Scope, firstScope));
          const customServer = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "/custom/bin/opencode" })
            .pipe(Effect.provideService(Scope.Scope, secondScope));

          expect(defaultServer.url).toBe("http://127.0.0.1:59000");
          expect(customServer.url).toBe("http://127.0.0.1:59001");
          expect(state.spawnUrls).toEqual(["http://127.0.0.1:59000", "http://127.0.0.1:59001"]);

          yield* Scope.close(firstScope, Exit.void);
          yield* Scope.close(secondScope, Exit.void);
        }),
      ).pipe(Effect.provide(openCodeRuntimePoolTestLayer(state))),
    );
  });

  it("starts local servers in the requested cwd and separates cwd-specific pools", async () => {
    const state = {
      spawnUrls: [] as Array<string>,
      spawnCwds: [] as Array<string | undefined>,
      killUrls: [] as Array<string>,
    };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const firstScope = yield* Scope.make();
          const secondScope = yield* Scope.make();
          const thirdScope = yield* Scope.make();

          const first = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode", cwd: "/repo/alpha" })
            .pipe(Effect.provideService(Scope.Scope, firstScope));
          const second = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode", cwd: "/repo/beta" })
            .pipe(Effect.provideService(Scope.Scope, secondScope));
          const third = yield* runtime
            .connectToOpenCodeServer({ binaryPath: "opencode", cwd: "/repo/alpha" })
            .pipe(Effect.provideService(Scope.Scope, thirdScope));

          expect(first.url).toBe("http://127.0.0.1:59000");
          expect(second.url).toBe("http://127.0.0.1:59001");
          expect(third.url).toBe(first.url);
          expect(state.spawnCwds).toEqual(["/repo/alpha", "/repo/beta"]);

          yield* Scope.close(firstScope, Exit.void);
          yield* Scope.close(secondScope, Exit.void);
          yield* Scope.close(thirdScope, Exit.void);
        }),
      ).pipe(Effect.provide(openCodeRuntimePoolTestLayer(state))),
    );
  });
});

describe("parseOpenCodeCliModelsOutput", () => {
  it("parses verbose OpenCode model output with metadata blocks", () => {
    const models = parseOpenCodeCliModelsOutput(`
openai/gpt-5.4
{
  "id": "gpt-5.4",
  "providerID": "openai",
  "name": "GPT-5.4",
  "variants": {
    "low": {
      "reasoningEffort": "low"
    },
    "high": {
      "reasoningEffort": "high"
    }
  }
}
opencode/gpt-5-nano
{
  "id": "gpt-5-nano",
  "providerID": "opencode",
  "name": "GPT-5 Nano",
  "variants": {}
}
`);

    expect(models).toEqual([
      {
        slug: "opencode/gpt-5-nano",
        providerID: "opencode",
        modelID: "gpt-5-nano",
        name: "GPT-5 Nano",
        variants: [],
        supportedReasoningEfforts: [],
      },
      {
        slug: "openai/gpt-5.4",
        providerID: "openai",
        modelID: "gpt-5.4",
        name: "GPT-5.4",
        variants: ["high", "low"],
        supportedReasoningEfforts: [
          {
            value: "low",
          },
          {
            value: "high",
          },
        ],
      },
    ]);
  });

  it("falls back to slug-derived metadata when only plain model lines are present", () => {
    const models = parseOpenCodeCliModelsOutput(`
warning: cached model metadata is unavailable
openai/gpt-5.4
opencode/minimax-m2.5-free
`);

    expect(models).toEqual([
      {
        slug: "openai/gpt-5.4",
        providerID: "openai",
        modelID: "gpt-5.4",
        name: "gpt-5.4",
        variants: [],
        supportedReasoningEfforts: [],
      },
      {
        slug: "opencode/minimax-m2.5-free",
        providerID: "opencode",
        modelID: "minimax-m2.5-free",
        name: "minimax-m2.5-free",
        variants: [],
        supportedReasoningEfforts: [],
      },
    ]);
  });

  it("deduplicates repeated slug entries by keeping the latest descriptor", () => {
    const models = parseOpenCodeCliModelsOutput(`
openai/gpt-5.4
{
  "id": "gpt-5.4",
  "providerID": "openai",
  "name": "GPT-5.4"
}
openai/gpt-5.4
{
  "id": "gpt-5.4",
  "providerID": "openai",
  "name": "GPT-5.4 Latest"
}
`);

    expect(models).toEqual([
      {
        slug: "openai/gpt-5.4",
        providerID: "openai",
        modelID: "gpt-5.4",
        name: "GPT-5.4 Latest",
        variants: [],
        supportedReasoningEfforts: [],
      },
    ]);
  });

  it("keeps verbose reasoning metadata from CLI output", () => {
    const models = parseOpenCodeCliModelsOutput(`
openai/gpt-5.4
{
  "id": "gpt-5.4",
  "providerID": "openai",
  "name": "GPT-5.4",
  "options": {
    "reasoningEffort": "medium"
  },
  "variants": {
    "none": {
      "reasoningEffort": "none"
    },
    "low": {
      "reasoningEffort": "low"
    },
    "medium": {
      "reasoningEffort": "medium"
    },
    "high": {
      "reasoningEffort": "high"
    }
  }
}
`);

    expect(models).toEqual([
      {
        slug: "openai/gpt-5.4",
        providerID: "openai",
        modelID: "gpt-5.4",
        name: "GPT-5.4",
        variants: ["high", "low", "medium", "none"],
        supportedReasoningEfforts: [
          { value: "none" },
          { value: "low" },
          { value: "medium" },
          { value: "high" },
        ],
        defaultReasoningEffort: "medium",
      },
    ]);
  });

  it.each([
    { reasoningOptions: [{ type: "budget_tokens", min: 1024, max: 8192 }] },
    { reasoningOptions: [{ type: "effort", values: ["low", "high", "max"] }] },
    { reasoningOptions: null },
  ])("preserves normalized CLI variants when raw metadata is %j", ({ reasoningOptions }) => {
    const models = parseOpenCodeCliModelsOutput(
      `anthropic/claude-test\n${JSON.stringify({
        reasoning_options: reasoningOptions,
        variants: { high: { thinking: { budgetTokens: 4096 } } },
      })}`,
    );

    expect(models[0]?.supportedReasoningEfforts).toEqual([{ value: "high" }]);
  });

  it.each([{ variants: {} }, { variants: { creative: { temperature: 0.9 } } }])(
    "does not restore reasoning disabled in normalized CLI variants: %j",
    ({ variants }) => {
      const models = parseOpenCodeCliModelsOutput(
        `anthropic/claude-test\n${JSON.stringify({
          reasoning_options: [{ type: "effort", values: ["low", "high"] }],
          variants,
        })}`,
      );

      expect(models[0]?.supportedReasoningEfforts).toEqual([]);
    },
  );

  it("reads models.dev reasoning_options when verbose output has no variants", () => {
    const models = parseOpenCodeCliModelsOutput(`
opencode-go/muse-spark-1.3-contributor
{
  "id": "muse-spark-1.3-contributor",
  "providerID": "opencode-go",
  "name": "Muse Spark 1.3 Contributor",
  "reasoning_options": [
    {
      "type": "effort",
      "values": ["minimal", "low", "medium", "high", "xhigh"]
    }
  ]
}
`);

    expect(models).toEqual([
      {
        slug: "opencode-go/muse-spark-1.3-contributor",
        providerID: "opencode-go",
        modelID: "muse-spark-1.3-contributor",
        name: "Muse Spark 1.3 Contributor",
        variants: [],
        supportedReasoningEfforts: [
          { value: "minimal" },
          { value: "low" },
          { value: "medium" },
          { value: "high" },
          { value: "xhigh" },
        ],
      },
    ]);
  });

  it("reads current OpenCode variant effort shapes from verbose CLI output", () => {
    const models = parseOpenCodeCliModelsOutput(`
opencode/claude-opus-4-7
{
  "id": "claude-opus-4-7",
  "providerID": "opencode",
  "name": "Claude Opus 4.7",
  "options": {
    "effort": "high"
  },
  "variants": {
    "low": {
      "thinking": {
        "type": "adaptive"
      }
    },
    "medium": {
      "thinking": {
        "type": "adaptive"
      },
      "effort": "medium"
    },
    "high": {
      "thinking": {
        "type": "adaptive"
      },
      "effort": "high"
    },
    "xhigh": {
      "thinking": {
        "type": "adaptive"
      },
      "effort": "xhigh"
    },
    "max": {
      "thinking": {
        "type": "adaptive"
      },
      "effort": "max"
    }
  }
}
opencode/gemini-3-flash
{
  "id": "gemini-3-flash",
  "providerID": "opencode",
  "name": "Gemini 3 Flash",
  "variants": {
    "minimal": {
      "thinkingConfig": {
        "thinkingLevel": "minimal"
      }
    },
    "high": {
      "thinkingConfig": {
        "thinkingLevel": "high"
      }
    }
  }
}
openrouter/grok-3-mini
{
  "id": "grok-3-mini",
  "providerID": "openrouter",
  "name": "Grok 3 Mini",
  "variants": {
    "low": {
      "reasoning": {
        "effort": "low"
      }
    },
    "high": {
      "reasoning": {
        "effort": "high"
      }
    }
  }
}
amazon-bedrock/nova-reel
{
  "id": "nova-reel",
  "providerID": "amazon-bedrock",
  "name": "Nova Reel",
  "variants": {
    "medium": {
      "reasoningConfig": {
        "maxReasoningEffort": "medium"
      }
    }
  }
}
`);

    expect(models).toEqual([
      {
        slug: "opencode/claude-opus-4-7",
        providerID: "opencode",
        modelID: "claude-opus-4-7",
        name: "Claude Opus 4.7",
        variants: ["high", "low", "max", "medium", "xhigh"],
        supportedReasoningEfforts: [
          { value: "low" },
          { value: "medium" },
          { value: "high" },
          { value: "xhigh" },
          { value: "max" },
        ],
        defaultReasoningEffort: "high",
      },
      {
        slug: "opencode/gemini-3-flash",
        providerID: "opencode",
        modelID: "gemini-3-flash",
        name: "Gemini 3 Flash",
        variants: ["high", "minimal"],
        supportedReasoningEfforts: [{ value: "minimal" }, { value: "high" }],
      },
      {
        slug: "openrouter/grok-3-mini",
        providerID: "openrouter",
        modelID: "grok-3-mini",
        name: "Grok 3 Mini",
        variants: ["high", "low"],
        supportedReasoningEfforts: [{ value: "low" }, { value: "high" }],
      },
      {
        slug: "amazon-bedrock/nova-reel",
        providerID: "amazon-bedrock",
        modelID: "nova-reel",
        name: "Nova Reel",
        variants: ["medium"],
        supportedReasoningEfforts: [{ value: "medium" }],
      },
    ]);
  });
});

describe("parseOpenCodeCredentialProviderIDs", () => {
  it("returns top-level provider ids from the OpenCode credential store", () => {
    const providerIDs = parseOpenCodeCredentialProviderIDs(`{
  "openai": {
    "type": "oauth"
  },
  "opencode": {
    "type": "api"
  }
}`);

    expect(providerIDs).toEqual(["openai", "opencode"]);
  });

  it("ignores non-object entries and empty keys", () => {
    const providerIDs = parseOpenCodeCredentialProviderIDs(`{
  "": {
    "type": "oauth"
  },
  "openai": {
    "type": "oauth"
  },
  "broken": "nope"
}`);

    expect(providerIDs).toEqual(["openai"]);
  });
});
