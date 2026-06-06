/**
 * HttpVercelSandboxClient unit tests, driven through a stub `@vercel/sandbox`
 * SDK.
 *
 * These exercise the real client's SDK-facing code path (create, detached-command
 * log line-framing, fire-and-collect, port URL, snapshot, timeout extend, stop,
 * reconnect-based liveness) without installing `@vercel/sandbox`: a stub loader
 * supplies an in-memory SDK with the exact surface the client consumes. This is
 * the only way to cover the credentialed path in CI, since the package is an
 * optional dependency that is not installed.
 *
 * @module vercelSandbox/HttpVercelSandboxClient.test
 */
import { Effect, ManagedRuntime, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { VercelSandboxClient } from "../Services/VercelSandboxClient.ts";
import { makeHttpVercelSandboxClientLive } from "./HttpVercelSandboxClient.ts";
import type { VercelSandboxCredentials } from "./VercelSandboxConfig.ts";
import type {
  VercelSandboxSdk,
  VercelSandboxSdkLoader,
  VercelSdkCommand,
  VercelSdkCreateInput,
  VercelSdkFinishedCommand,
  VercelSdkLogEntry,
  VercelSdkRunCommandInput,
  VercelSdkSandbox,
} from "./vercelSandboxSdk.ts";

const CREDENTIALS: VercelSandboxCredentials = {
  token: "vercel-secret-token",
  teamId: "team_123",
  projectId: "prj_123",
  runtime: undefined,
};

interface StubState {
  readonly created: VercelSdkCreateInput[];
  readonly commands: VercelSdkRunCommandInput[];
  readonly stdinWrites: string[];
  stopped: boolean;
  timeoutMs: number;
}

/**
 * Build a stub SDK whose detached commands yield the scripted log chunks. Chunks
 * deliberately split a line across two entries to prove cross-chunk line framing.
 */
const makeStubSdk = (
  state: StubState,
  detachedLogs: ReadonlyArray<VercelSdkLogEntry>,
): VercelSandboxSdk => {
  const makeSandbox = (sandboxId: string): VercelSdkSandbox => ({
    sandboxId,
    runCommand: async (
      input: VercelSdkRunCommandInput,
    ): Promise<VercelSdkCommand | VercelSdkFinishedCommand> => {
      state.commands.push(input);
      if (input.detached === true) {
        const command: VercelSdkCommand = {
          stdin: {
            write: (chunk) => {
              state.stdinWrites.push(String(chunk));
              return undefined;
            },
            end: () => undefined,
          },
          logs: async function* () {
            for (const entry of detachedLogs) {
              yield entry;
            }
          },
          wait: async () => ({ exitCode: 0 }),
          kill: async () => undefined,
        };
        return command;
      }
      const finished: VercelSdkFinishedCommand = {
        exitCode: 0,
        stdout: async () => `ran ${input.cmd} ${(input.args ?? []).join(" ")}`.trim(),
        stderr: async () => "",
      };
      return finished;
    },
    domain: (port) => `https://${sandboxId}-${port}.vercel.run`,
    writeFiles: async () => undefined,
    readFile: async () => new TextEncoder().encode("file-bytes"),
    createSnapshot: async () => ({ snapshotId: `snap-${sandboxId}` }),
    extendTimeout: async (timeoutMs: number) => {
      state.timeoutMs += timeoutMs;
      return undefined;
    },
    stop: async () => {
      state.stopped = true;
      return undefined;
    },
  });

  return {
    Sandbox: {
      create: async (input) => {
        state.created.push(input);
        return makeSandbox("sbx_real_1");
      },
      get: async ({ sandboxId }) => makeSandbox(sandboxId),
    },
  };
};

const makeRuntime = (loadSdk: VercelSandboxSdkLoader) =>
  ManagedRuntime.make(makeHttpVercelSandboxClientLive(CREDENTIALS, loadSdk));

type ClientRuntime = ReturnType<typeof makeRuntime>;

describe("HttpVercelSandboxClient (stub SDK)", () => {
  let runtime: ClientRuntime | undefined;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
      runtime = undefined;
    }
  });

  it("creates a sandbox with declared ports, ms timeout, and runtime, then resolves preview URLs", async () => {
    const state: StubState = {
      created: [],
      commands: [],
      stdinWrites: [],
      stopped: false,
      timeoutMs: 0,
    };
    runtime = makeRuntime(() => Promise.resolve(makeStubSdk(state, [])));
    const local = runtime;
    const created = await local.runPromise(
      Effect.flatMap(VercelSandboxClient.asEffect(), (client) =>
        client.create({ ports: [3000, 8080], timeoutSeconds: 600, snapshotId: null }),
      ),
    );

    expect(state.created).toHaveLength(1);
    expect(state.created[0]?.token).toBe(CREDENTIALS.token);
    expect(state.created[0]?.ports).toEqual([3000, 8080]);
    // Seconds are forwarded to the SDK as milliseconds.
    expect(state.created[0]?.timeout).toBe(600_000);
    expect(created.ports.map((p) => p.port).toSorted()).toEqual([3000, 8080]);
    for (const port of created.ports) {
      expect(port.url).toMatch(/^https:\/\//);
    }
  });

  it("line-frames a detached command's logs across chunk boundaries and writes stdin", async () => {
    const state: StubState = {
      created: [],
      commands: [],
      stdinWrites: [],
      stopped: false,
      timeoutMs: 0,
    };
    // "frame-1\nfra" + "me-2\n" must reframe to ["frame-1", "frame-2"]; the
    // stderr chunk has no trailing newline so it flushes on stream end.
    const logs: ReadonlyArray<VercelSdkLogEntry> = [
      { stream: "stdout", data: "frame-1\nfra" },
      { stream: "stdout", data: "me-2\n" },
      { stream: "stderr", data: "warn-tail" },
    ];
    runtime = makeRuntime(() => Promise.resolve(makeStubSdk(state, logs)));
    const local = runtime;

    const result = await local.runPromise(
      Effect.gen(function* () {
        const client = yield* VercelSandboxClient;
        const created = yield* client.create({ ports: [], timeoutSeconds: 60, snapshotId: null });
        const handle = yield* client.runCommandStreaming(created.sandboxId, {
          command: "codex",
          args: ["app-server"],
          detached: true,
        });
        yield* handle.writeStdin('{"jsonrpc":"2.0"}');
        const stdout = yield* Stream.runCollect(handle.stdout);
        const stderr = yield* Stream.runCollect(handle.stderr);
        const code = yield* handle.exitCode;
        return { stdout: Array.from(stdout), stderr: Array.from(stderr), code };
      }),
    );

    expect(result.stdout).toEqual(["frame-1", "frame-2"]);
    expect(result.stderr).toEqual(["warn-tail"]);
    expect(result.code).toBe(0);
    expect(state.stdinWrites).toEqual(['{"jsonrpc":"2.0"}\n']);
    expect(state.commands.at(-1)?.detached).toBe(true);
  });

  it("fire-and-collects a blocking command", async () => {
    const state: StubState = {
      created: [],
      commands: [],
      stdinWrites: [],
      stopped: false,
      timeoutMs: 0,
    };
    runtime = makeRuntime(() => Promise.resolve(makeStubSdk(state, [])));
    const local = runtime;
    const result = await local.runPromise(
      Effect.gen(function* () {
        const client = yield* VercelSandboxClient;
        const created = yield* client.create({ ports: [], timeoutSeconds: 60, snapshotId: null });
        return yield* client.runCommandCollect(created.sandboxId, {
          command: "git",
          args: ["status", "--porcelain"],
          detached: false,
        });
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ran git status --porcelain");
  });

  it("resolves a declared port URL, snapshots, extends the timeout, and stops", async () => {
    const state: StubState = {
      created: [],
      commands: [],
      stdinWrites: [],
      stopped: false,
      timeoutMs: 0,
    };
    runtime = makeRuntime(() => Promise.resolve(makeStubSdk(state, [])));
    const local = runtime;
    const out = await local.runPromise(
      Effect.gen(function* () {
        const client = yield* VercelSandboxClient;
        const created = yield* client.create({
          ports: [3000],
          timeoutSeconds: 60,
          snapshotId: null,
        });
        const url = yield* client.getPortUrl(created.sandboxId, 3000);
        const snapshotId = yield* client.snapshot(created.sandboxId);
        yield* client.extendTimeout(created.sandboxId, 300);
        const aliveBefore = yield* client.isAlive(created.sandboxId);
        yield* client.stop(created.sandboxId);
        return { url, snapshotId, aliveBefore };
      }),
    );
    expect(out.url).toMatch(/^https:\/\/sbx_real_1-3000\./);
    expect(out.snapshotId).toBe("snap-sbx_real_1");
    expect(out.aliveBefore).toBe(true);
    // 300s extend forwarded as 300_000ms.
    expect(state.timeoutMs).toBe(300_000);
    expect(state.stopped).toBe(true);
  });

  it("fails loudly when the @vercel/sandbox package is not installed", async () => {
    runtime = makeRuntime(() => Promise.reject(new Error("Cannot find module '@vercel/sandbox'")));
    const local = runtime;
    const exit = await local.runPromiseExit(
      Effect.flatMap(VercelSandboxClient.asEffect(), (client) =>
        client.create({ ports: [], timeoutSeconds: 60, snapshotId: null }),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("redacts the token from a create failure detail", async () => {
    runtime = makeRuntime(() =>
      Promise.resolve({
        Sandbox: {
          create: async () => {
            throw new Error(`create rejected for token ${CREDENTIALS.token}`);
          },
          get: async () => {
            throw new Error("unused");
          },
        },
      }),
    );
    const local = runtime;
    const exit = await local.runPromiseExit(
      Effect.flatMap(VercelSandboxClient.asEffect(), (client) =>
        client.create({ ports: [], timeoutSeconds: 60, snapshotId: null }),
      ),
    );
    expect(exit._tag).toBe("Failure");
    const serialized = JSON.stringify(exit);
    expect(serialized).not.toContain(CREDENTIALS.token);
    expect(serialized).toContain("***");
  });
});
