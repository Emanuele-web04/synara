// FILE: browserUsePipeServer.test.ts
// Purpose: Guards the desktop browser-use native pipe path helpers.
// Layer: Desktop test
// Depends on: Vitest and browserUsePipeServer path resolution exports

import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { basename, dirname, join } from "node:path";
import { endianness, tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import {
  BrowserUsePipeServer,
  SYNARA_BROWSER_USE_PIPE_ENV,
  resolveBrowserUsePipeBackendEnv,
  resolveConfiguredBrowserUsePipePath,
  resolveDefaultBrowserUsePipePath,
} from "./browserUsePipeServer";

function encodeRequest(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  if (endianness() === "BE") {
    header.writeUInt32BE(payload.length);
  } else {
    header.writeUInt32LE(payload.length);
  }
  return Buffer.concat([header, payload]);
}

async function connect(pipePath: string): Promise<Socket> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(pipePath, () => resolve(socket));
    socket.once("error", reject);
  });
}

async function request(socket: Socket, message: unknown): Promise<Record<string, unknown>> {
  const response = readMessage(socket);
  socket.write(encodeRequest(message));
  return await response;
}

async function readMessage(socket: Socket): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
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
}

async function withPipeServer(
  options: {
    maxInFlightRequests?: number;
    maxQueuedOutputBytes?: number;
    browserManager?: unknown;
  },
  run: (socket: Socket) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "synara-browser-pipe-test-"));
  const pipePath = join(directory, "browser.sock");
  const browserManager = options.browserManager ?? { getBrowserUseSnapshot: () => null };
  const server = new BrowserUsePipeServer(browserManager as never, {
    pipePath,
    ...(options.maxInFlightRequests !== undefined
      ? { maxInFlightRequests: options.maxInFlightRequests }
      : {}),
    ...(options.maxQueuedOutputBytes !== undefined
      ? { maxQueuedOutputBytes: options.maxQueuedOutputBytes }
      : {}),
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

describe("browser-use pipe path resolution", () => {
  it("creates a discoverable unix socket path under the Codex browser-use directory", () => {
    const pipePath = resolveDefaultBrowserUsePipePath("darwin");

    expect(dirname(pipePath)).toBe("/tmp/codex-browser-use");
    expect(basename(pipePath)).toMatch(/^synara-iab-\d+-[0-9a-f-]{36}\.sock$/);
  });

  it("prefers an explicit Synara pipe path from the environment", () => {
    expect(
      resolveConfiguredBrowserUsePipePath(
        {
          [SYNARA_BROWSER_USE_PIPE_ENV]: "/tmp/codex-browser-use/synara.sock",
        },
        "darwin",
      ),
    ).toBe("/tmp/codex-browser-use/synara.sock");
  });

  it("falls back to the generated path when the environment is empty", () => {
    expect(resolveConfiguredBrowserUsePipePath({}, "darwin")).toMatch(
      /codex-browser-use\/synara-iab-\d+-[0-9a-f-]{36}\.sock$/,
    );
  });

  it("publishes the browser-use pipe only after a listener becomes active", () => {
    const inheritedEnv = {
      KEEP_ME: "yes",
      [SYNARA_BROWSER_USE_PIPE_ENV]: "/tmp/codex-browser-use/stale.sock",
    };
    expect(resolveBrowserUsePipeBackendEnv(inheritedEnv, null)).toEqual({ KEEP_ME: "yes" });
    expect(resolveBrowserUsePipeBackendEnv(inheritedEnv, "  ")).toEqual({ KEEP_ME: "yes" });
    expect(
      resolveBrowserUsePipeBackendEnv(inheritedEnv, "/tmp/codex-browser-use/synara.sock"),
    ).toEqual({
      KEEP_ME: "yes",
      [SYNARA_BROWSER_USE_PIPE_ENV]: "/tmp/codex-browser-use/synara.sock",
    });
  });

  it("uses an unguessable path for each browser-use server generation", () => {
    expect(resolveDefaultBrowserUsePipePath("darwin")).not.toBe(
      resolveDefaultBrowserUsePipePath("darwin"),
    );
  });

  it("fails closed on Windows until the named-pipe ACL is explicitly proven", () => {
    expect(resolveDefaultBrowserUsePipePath("win32")).toBe("");
    expect(
      resolveConfiguredBrowserUsePipePath(
        { [SYNARA_BROWSER_USE_PIPE_ENV]: String.raw`\\.\pipe\synara-browser` },
        "win32",
      ),
    ).toBe("");
  });
});

describe("browser-use pipe RPC compatibility", () => {
  it("echoes and binds the Codex session id expected by IAB discovery", async () => {
    await withPipeServer({}, async (socket) => {
      const info = await request(socket, {
        jsonrpc: "2.0",
        id: 1,
        method: "getInfo",
        params: { session_id: "codex-session-1" },
      });
      expect(info).toMatchObject({
        id: 1,
        result: {
          type: "iab",
          metadata: {
            codexAppBuildFlavor: "prod",
            codexSessionId: "codex-session-1",
          },
        },
      });

      await expect(
        request(socket, {
          jsonrpc: "2.0",
          id: 2,
          method: "getTabs",
          params: { session_id: "codex-session-1" },
        }),
      ).resolves.toMatchObject({ id: 2, result: [] });

      await expect(
        request(socket, {
          jsonrpc: "2.0",
          id: 3,
          method: "getTabs",
          params: { session_id: "other-session" },
        }),
      ).resolves.toMatchObject({ id: 3, error: { message: expect.stringContaining("lease") } });
    });
  });

  it("settles requests instead of destroying the pipe at the in-flight limit", async () => {
    await withPipeServer({ maxInFlightRequests: 0 }, async (socket) => {
      for (const id of [1, 2]) {
        await expect(
          request(socket, { jsonrpc: "2.0", id, method: "ping", params: {} }),
        ).resolves.toMatchObject({
          id,
          error: { message: "Too many in-flight browser-use requests" },
        });
        expect(socket.destroyed).toBe(false);
      }
    });
  });

  it("preserves successful RPC outcomes when their replies exceed the queue budget", async () => {
    let executeCalls = 0;
    const browserManager = {
      getBrowserUseSnapshot: () => ({
        threadId: "thread-1",
        state: {
          open: true,
          activeTabId: "tab-1",
          tabs: [
            {
              id: "tab-1",
              title: "Tab",
              url: "about:blank",
              lastCommittedUrl: null,
            },
          ],
        },
      }),
      executeCdp: async () => {
        executeCalls += 1;
        return { payload: "x".repeat(1_024) };
      },
    };

    await withPipeServer({ maxQueuedOutputBytes: 1, browserManager }, async (socket) => {
      const info = await request(socket, {
        jsonrpc: "2.0",
        id: 1,
        method: "getInfo",
        params: { session_id: "codex-session-1" },
      });
      expect(info).toMatchObject({ id: 1, result: { type: "iab" } });

      const tabs = await request(socket, {
        jsonrpc: "2.0",
        id: 2,
        method: "getTabs",
        params: { session_id: "codex-session-1" },
      });
      const tabId = (tabs.result as Array<{ id: number }>)[0]?.id;

      await expect(
        request(socket, {
          jsonrpc: "2.0",
          id: 3,
          method: "executeCdp",
          params: {
            session_id: "codex-session-1",
            target: { tabId },
            method: "Runtime.evaluate",
          },
        }),
      ).resolves.toMatchObject({ id: 3, result: { payload: "x".repeat(1_024) } });
      expect(executeCalls).toBe(1);
      expect(socket.destroyed).toBe(false);
    });
  });

  it("signals CDP detachment instead of silently dropping notifications at capacity", async () => {
    let cdpListener: ((event: { method: string; params?: unknown }) => void) | null = null;
    let disposeCalls = 0;
    const browserManager = {
      getBrowserUseSnapshot: () => ({
        threadId: "thread-1",
        state: {
          open: true,
          activeTabId: "tab-1",
          tabs: [
            {
              id: "tab-1",
              title: "Tab",
              url: "about:blank",
              lastCommittedUrl: null,
            },
          ],
        },
      }),
      attachBrowserUseTab: async () => {},
      subscribeToCdpEvents: (
        _target: unknown,
        listener: (event: { method: string; params?: unknown }) => void,
      ) => {
        cdpListener = listener;
        return () => {
          cdpListener = null;
          disposeCalls += 1;
        };
      },
    };

    await withPipeServer({ maxQueuedOutputBytes: 256, browserManager }, async (socket) => {
      await request(socket, {
        jsonrpc: "2.0",
        id: 1,
        method: "getInfo",
        params: { session_id: "codex-session-1" },
      });
      const tabs = await request(socket, {
        jsonrpc: "2.0",
        id: 2,
        method: "getTabs",
        params: { session_id: "codex-session-1" },
      });
      const tabId = (tabs.result as Array<{ id: number }>)[0]?.id;
      await request(socket, {
        jsonrpc: "2.0",
        id: 3,
        method: "attach",
        params: { session_id: "codex-session-1", tabId },
      });

      const notification = readMessage(socket);
      cdpListener?.({
        method: "Network.dataReceived",
        params: { payload: "x".repeat(1_024) },
      });

      await expect(notification).resolves.toMatchObject({
        method: "onCDPEvent",
        params: {
          source: { tabId },
          method: "Inspector.detached",
          params: { reason: "Browser-use output capacity exceeded" },
        },
      });
      expect(disposeCalls).toBe(1);
      expect(socket.destroyed).toBe(false);
    });
  });
});
