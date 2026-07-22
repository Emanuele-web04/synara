import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { endianness, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { BrowserAutomationHostError } from "./browserAutomation/hostErrors";
import {
  BrowserHostPipeServer,
  SYNARA_BROWSER_HOST_CAPABILITY_FD_ENV,
  SYNARA_BROWSER_HOST_PIPE_ENV,
  SYNARA_BROWSER_USE_PIPE_ENV,
  resolveBrowserHostPipeBackendEnv,
  resolveConfiguredBrowserHostPipePath,
  resolveDefaultBrowserHostPipePath,
} from "./browserUsePipeServer";

const TEST_CAPABILITY = "synara-browser-host-test-capability-0123456789";

const encodeRequest = (message: unknown): Buffer => {
  const payload = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  if (endianness() === "BE") header.writeUInt32BE(payload.length);
  else header.writeUInt32LE(payload.length);
  return Buffer.concat([header, payload]);
};

const connect = (pipePath: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(pipePath, () => resolve(socket));
    socket.once("error", reject);
  });

const readMessage = (socket: Socket): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    let pending = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length < 4) return;
      const length = endianness() === "BE" ? pending.readUInt32BE(0) : pending.readUInt32LE(0);
      if (pending.length < 4 + length) return;
      socket.off("error", onError);
      socket.off("data", onData);
      resolve(JSON.parse(pending.subarray(4, 4 + length).toString("utf8")));
    };
    const onError = (error: Error) => {
      socket.off("data", onData);
      reject(error);
    };
    socket.on("data", onData);
    socket.once("error", onError);
  });

const request = async (socket: Socket, message: unknown): Promise<Record<string, unknown>> => {
  const response = readMessage(socket);
  socket.write(encodeRequest(message));
  return response;
};

async function withPipeServer(
  options: {
    readonly maxInFlightRequests?: number;
    readonly maxQueuedOutputBytes?: number;
    readonly automationHost?: { executeTool: (request: unknown) => Promise<unknown> };
  },
  run: (socket: Socket) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "synara-browser-host-test-"));
  const pipePath = join(directory, "browser.sock");
  const server = new BrowserHostPipeServer({} as never, {
    pipePath,
    capability: TEST_CAPABILITY,
    ...(options.maxInFlightRequests === undefined
      ? {}
      : { maxInFlightRequests: options.maxInFlightRequests }),
    ...(options.maxQueuedOutputBytes === undefined
      ? {}
      : { maxQueuedOutputBytes: options.maxQueuedOutputBytes }),
    ...(options.automationHost ? { automationHost: options.automationHost as never } : {}),
  });
  await server.start();
  const socket = await connect(pipePath);
  try {
    await run(socket);
  } finally {
    socket.destroy();
    await server.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

describe("canonical browser host pipe resolution", () => {
  it("creates a private unguessable Unix socket path", () => {
    const first = resolveDefaultBrowserHostPipePath("darwin", 123);
    const second = resolveDefaultBrowserHostPipePath("darwin", 123);
    expect(dirname(first)).toBe(`${tmpdir()}/synara-browser-host`);
    expect(basename(first)).toMatch(/^synara-browser-host-123-[0-9a-f-]{36}\.sock$/);
    expect(first).not.toBe(second);
  });

  it("creates an unguessable per-process Windows named pipe", () => {
    const pipePath = resolveDefaultBrowserHostPipePath("win32", 456);
    expect(pipePath).toMatch(/^\\\\\.\\pipe\\synara-browser-host-456-[0-9a-f-]{36}$/);
    expect(pipePath).not.toBe(resolveDefaultBrowserHostPipePath("win32", 456));
  });

  it("prefers the canonical env and accepts the legacy env as fallback", () => {
    expect(
      resolveConfiguredBrowserHostPipePath(
        {
          [SYNARA_BROWSER_HOST_PIPE_ENV]: "/canonical.sock",
          [SYNARA_BROWSER_USE_PIPE_ENV]: "/legacy.sock",
        },
        "darwin",
      ),
    ).toBe("/canonical.sock");
    expect(
      resolveConfiguredBrowserHostPipePath(
        {
          [SYNARA_BROWSER_USE_PIPE_ENV]: String.raw`\\.\pipe\legacy`,
        },
        "win32",
      ),
    ).toBe(String.raw`\\.\pipe\legacy`);
  });

  it("publishes both env names only while a listener is active", () => {
    const inherited = {
      KEEP_ME: "yes",
      [SYNARA_BROWSER_HOST_PIPE_ENV]: "/stale-canonical.sock",
      [SYNARA_BROWSER_USE_PIPE_ENV]: "/stale-legacy.sock",
    };
    expect(resolveBrowserHostPipeBackendEnv(inherited, null, null)).toEqual({ KEEP_ME: "yes" });
    expect(resolveBrowserHostPipeBackendEnv(inherited, "/active.sock", 3)).toEqual({
      KEEP_ME: "yes",
      [SYNARA_BROWSER_HOST_PIPE_ENV]: "/active.sock",
      [SYNARA_BROWSER_USE_PIPE_ENV]: "/active.sock",
      [SYNARA_BROWSER_HOST_CAPABILITY_FD_ENV]: "3",
    });
  });

  it("rejects a non-private configured parent without changing its permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "synara-browser-host-public-test-"));
    await chmod(directory, 0o755);
    const server = new BrowserHostPipeServer({} as never, {
      pipePath: join(directory, "browser.sock"),
      capability: TEST_CAPABILITY,
      automationHost: { executeTool: async () => ({}) } as never,
    });
    try {
      await expect(server.start()).rejects.toThrow("permissions are not private");
      expect((await stat(directory)).mode & 0o777).toBe(0o755);
    } finally {
      await server.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("canonical browser host RPC", () => {
  it("rejects a discovered same-user pipe before binding any claimed session", async () => {
    const executeTool = vi.fn(async () => ({ available: true }));
    await withPipeServer({ automationHost: { executeTool } }, async (socket) => {
      await expect(
        request(socket, {
          jsonrpc: "2.0",
          id: 1,
          method: "getInfo",
          params: { session_id: "forged-session", capability: "not-the-backend" },
        }),
      ).resolves.toMatchObject({
        id: 1,
        error: {
          code: -32_010,
          data: { error: { code: "BrowserAuthorizationDenied", phase: "auth" } },
        },
      });
      await expect(
        request(socket, {
          jsonrpc: "2.0",
          id: 2,
          method: "executeTool",
          params: {
            session_id: "forged-session",
            provider: "codex",
            thread_id: "forged-thread",
            name: "browser_status",
            arguments: {},
          },
        }),
      ).resolves.toMatchObject({ error: { message: expect.any(String) } });
      expect(executeTool).not.toHaveBeenCalled();
    });
  });

  it("binds getInfo then routes executeTool with session and thread scope", async () => {
    const executeTool = vi.fn(async () => ({ available: true }));
    await withPipeServer({ automationHost: { executeTool } }, async (socket) => {
      await expect(
        request(socket, {
          jsonrpc: "2.0",
          id: 1,
          method: "getInfo",
          params: { session_id: "session-1", capability: TEST_CAPABILITY },
        }),
      ).resolves.toMatchObject({
        id: 1,
        result: {
          type: "synara-browser-host",
          metadata: { sessionId: "session-1", physicalScope: "visible-shared-electron-webview" },
        },
      });
      await expect(
        request(socket, {
          jsonrpc: "2.0",
          id: 2,
          method: "executeTool",
          params: {
            session_id: "session-1",
            provider: "claude",
            thread_id: "thread-1",
            name: "browser_status",
            arguments: {},
            workspace_root: "/workspace/project-one",
          },
        }),
      ).resolves.toMatchObject({ id: 2, result: { available: true } });
      expect(executeTool).toHaveBeenCalledWith({
        sessionId: "session-1",
        provider: "claude",
        threadId: "thread-1",
        name: "browser_status",
        arguments: {},
        workspaceRoot: "/workspace/project-one",
        signal: expect.any(AbortSignal),
      });
    });
  });

  it("rejects a workspace root that is not an absolute bounded host field", async () => {
    const executeTool = vi.fn(async () => ({ available: true }));
    await withPipeServer({ automationHost: { executeTool } }, async (socket) => {
      await request(socket, {
        jsonrpc: "2.0",
        id: 1,
        method: "getInfo",
        params: { session_id: "session-1", capability: TEST_CAPABILITY },
      });
      await expect(
        request(socket, {
          jsonrpc: "2.0",
          id: 2,
          method: "executeTool",
          params: {
            session_id: "session-1",
            provider: "codex",
            thread_id: "thread-1",
            name: "browser_upload",
            arguments: {},
            workspace_root: "../project-one",
          },
        }),
      ).resolves.toMatchObject({
        id: 2,
        error: { data: { error: { code: "BrowserInputUnsupported" } } },
      });
      expect(executeTool).not.toHaveBeenCalled();
    });
  });

  it("returns canonical errors in JSON-RPC error.data", async () => {
    const automationHost = {
      executeTool: async () => {
        throw new BrowserAutomationHostError({
          code: "BrowserAuthorizationDenied",
          retryable: false,
          phase: "auth",
          effectMayHaveCommitted: false,
        });
      },
    };
    await withPipeServer({ automationHost }, async (socket) => {
      await request(socket, {
        jsonrpc: "2.0",
        id: 1,
        method: "getInfo",
        params: { session_id: "session-1", capability: TEST_CAPABILITY },
      });
      await expect(
        request(socket, {
          jsonrpc: "2.0",
          id: 2,
          method: "executeTool",
          params: {
            session_id: "session-1",
            provider: "cursor",
            thread_id: "thread-1",
            name: "browser_tabs",
            arguments: {},
          },
        }),
      ).resolves.toMatchObject({
        error: {
          code: -32_010,
          data: {
            type: "synara_browser_error",
            version: 1,
            error: { code: "BrowserAuthorizationDenied", phase: "auth" },
          },
        },
      });
    });
  });

  it("does not expose the retired low-level CDP/IAB methods", async () => {
    await withPipeServer({}, async (socket) => {
      await request(socket, {
        jsonrpc: "2.0",
        id: 1,
        method: "getInfo",
        params: { session_id: "session-1", capability: TEST_CAPABILITY },
      });
      for (const [index, method] of ["getTabs", "createTab", "attach", "executeCdp"].entries()) {
        await expect(
          request(socket, {
            jsonrpc: "2.0",
            id: index + 2,
            method,
            params: { session_id: "session-1" },
          }),
        ).resolves.toMatchObject({ error: { message: expect.stringContaining("No handler") } });
      }
    });
  });

  it("settles overload requests without destroying the connection", async () => {
    await withPipeServer({ maxInFlightRequests: 0 }, async (socket) => {
      await expect(
        request(socket, {
          jsonrpc: "2.0",
          id: 1,
          method: "ping",
          params: {},
        }),
      ).resolves.toMatchObject({
        id: 1,
        error: { message: "Too many in-flight browser host requests" },
      });
      expect(socket.destroyed).toBe(false);
    });
  });

  it("aborts an in-flight desktop tool when its pipe client disconnects", async () => {
    let observedSignal: AbortSignal | undefined;
    let resolveAborted!: () => void;
    const aborted = new Promise<void>((resolve) => {
      resolveAborted = resolve;
    });
    const executeTool = vi.fn((rawRequest: unknown) => {
      const signal = (rawRequest as { signal: AbortSignal }).signal;
      observedSignal = signal;
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            resolveAborted();
            reject(new Error("cancelled"));
          },
          { once: true },
        );
      });
    });
    await withPipeServer({ automationHost: { executeTool } }, async (socket) => {
      await request(socket, {
        jsonrpc: "2.0",
        id: 1,
        method: "getInfo",
        params: { session_id: "session-abort", capability: TEST_CAPABILITY },
      });
      socket.write(
        encodeRequest({
          jsonrpc: "2.0",
          id: 2,
          method: "executeTool",
          params: {
            session_id: "session-abort",
            provider: "codex",
            thread_id: "thread-1",
            name: "browser_wait",
            arguments: {},
          },
        }),
      );
      await vi.waitFor(() => expect(executeTool).toHaveBeenCalledTimes(1));
      socket.destroy();
      await aborted;
      expect(observedSignal?.aborted).toBe(true);
    });
  });

  it("preserves a successful bounded response above the notification queue budget", async () => {
    const payload = "x".repeat(4_096);
    await withPipeServer(
      {
        maxQueuedOutputBytes: 1,
        automationHost: { executeTool: async () => ({ payload }) },
      },
      async (socket) => {
        await request(socket, {
          jsonrpc: "2.0",
          id: 1,
          method: "getInfo",
          params: { session_id: "session-1", capability: TEST_CAPABILITY },
        });
        await expect(
          request(socket, {
            jsonrpc: "2.0",
            id: 2,
            method: "executeTool",
            params: {
              session_id: "session-1",
              provider: "gemini",
              thread_id: "thread-1",
              name: "browser_status",
              arguments: {},
            },
          }),
        ).resolves.toMatchObject({ result: { payload } });
        expect(socket.destroyed).toBe(false);
      },
    );
  });

  it("frames a screenshot-sized response larger than the former 8 MiB ceiling", async () => {
    const payload = "x".repeat(8 * 1024 * 1024 + 1_024);
    await withPipeServer(
      {
        maxQueuedOutputBytes: 1,
        automationHost: { executeTool: async () => ({ payload }) },
      },
      async (socket) => {
        await request(socket, {
          jsonrpc: "2.0",
          id: 1,
          method: "getInfo",
          params: { session_id: "session-large", capability: TEST_CAPABILITY },
        });
        const response = await request(socket, {
          jsonrpc: "2.0",
          id: 2,
          method: "executeTool",
          params: {
            session_id: "session-large",
            provider: "codex",
            thread_id: "thread-1",
            name: "browser_snapshot",
            arguments: {},
          },
        });
        expect((response.result as { payload: string }).payload).toHaveLength(payload.length);
        expect(socket.destroyed).toBe(false);
      },
    );
  });
});
