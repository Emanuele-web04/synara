import { EventEmitter } from "node:events";

import { ThreadId } from "@synara/contracts";
import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";

import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import { BrowserDiagnosticsStore } from "./browserDiagnostics";

const THREAD_ID = ThreadId.makeUnsafe("thread-diagnostics");
const TAB_ID = "025aa711-edf6-4c63-b957-d7c96a3fdabb";

const createRuntime = () => {
  const events = new EventEmitter();
  const sendCommand = vi.fn(async () => ({}));
  const webContents = {
    isDestroyed: () => false,
    once: vi.fn(),
    debugger: {
      isAttached: () => true,
      attach: vi.fn(),
      sendCommand,
      on: events.on.bind(events),
      removeListener: events.removeListener.bind(events),
    },
  } as unknown as WebContents;
  return {
    runtime: {
      threadId: THREAD_ID,
      tabId: TAB_ID,
      webContents,
    } satisfies BrowserAutomationVisibleRuntime,
    emit: (method: string, params: unknown) => events.emit("message", {}, method, params),
    sendCommand,
  };
};

const createDestroyableRuntime = (options?: { readonly removeListenerError?: Error }) => {
  const lifecycleEvents = new EventEmitter();
  const debuggerEvents = new EventEmitter();
  const sendCommand = vi.fn(async () => ({}));
  let destroyed = false;
  const debuggerSession = {
    isAttached: () => true,
    attach: vi.fn(),
    sendCommand,
    on: debuggerEvents.on.bind(debuggerEvents),
    removeListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (options?.removeListenerError) throw options.removeListenerError;
      debuggerEvents.removeListener(event, listener);
    }),
  };
  const webContents = {
    isDestroyed: () => destroyed,
    once: lifecycleEvents.once.bind(lifecycleEvents),
    removeListener: lifecycleEvents.removeListener.bind(lifecycleEvents),
  } as unknown as WebContents;
  Object.defineProperty(webContents, "debugger", {
    get: () => {
      if (destroyed) throw new TypeError("Object has been destroyed");
      return debuggerSession;
    },
  });
  return {
    runtime: {
      threadId: THREAD_ID,
      tabId: TAB_ID,
      webContents,
    } satisfies BrowserAutomationVisibleRuntime,
    destroy: () => {
      destroyed = true;
      lifecycleEvents.emit("destroyed");
    },
    debuggerListenerCount: () => debuggerEvents.listenerCount("message"),
    lifecycleListenerCount: () => lifecycleEvents.listenerCount("destroyed"),
  };
};

describe("browser diagnostics store", () => {
  it("does not access the debugger after WebContents is destroyed", async () => {
    const { runtime, destroy, debuggerListenerCount, lifecycleListenerCount } =
      createDestroyableRuntime();
    const diagnostics = new BrowserDiagnosticsStore();
    await diagnostics.observe(runtime);

    expect(debuggerListenerCount()).toBe(1);
    expect(lifecycleListenerCount()).toBe(1);
    expect(destroy).not.toThrow();
    expect(lifecycleListenerCount()).toBe(0);
    expect(() => diagnostics.dispose(runtime)).not.toThrow();
  });

  it("detaches lifecycle listeners and tolerates repeated explicit disposal", async () => {
    const { runtime, destroy, debuggerListenerCount, lifecycleListenerCount } =
      createDestroyableRuntime();
    const diagnostics = new BrowserDiagnosticsStore();
    await diagnostics.observe(runtime);

    diagnostics.dispose(runtime);
    expect(debuggerListenerCount()).toBe(0);
    expect(lifecycleListenerCount()).toBe(0);
    expect(() => diagnostics.dispose(runtime)).not.toThrow();
    expect(destroy).not.toThrow();
  });

  it("does not mask cleanup errors while WebContents is alive", async () => {
    const { runtime } = createDestroyableRuntime({
      removeListenerError: new Error("debugger listener cleanup failed"),
    });
    const diagnostics = new BrowserDiagnosticsStore();
    await diagnostics.observe(runtime);

    expect(() => diagnostics.dispose(runtime)).toThrow("debugger listener cleanup failed");
    expect(() => diagnostics.dispose(runtime)).toThrow("debugger listener cleanup failed");
  });

  it("captures bounded console and network metadata without headers or bodies", async () => {
    const { runtime, emit, sendCommand } = createRuntime();
    const diagnostics = new BrowserDiagnosticsStore();
    await diagnostics.observe(runtime);

    emit("Runtime.consoleAPICalled", {
      type: "warn",
      args: [{ value: "Careful" }, { description: "Error: boom" }],
      stackTrace: {
        callFrames: [{ url: "https://example.test/app.js", lineNumber: 4, columnNumber: 8 }],
      },
    });
    emit("Network.requestWillBeSent", {
      requestId: "request-1",
      request: {
        url: "https://api-user:api-password@api.example.test/users?access_token=secret-token&filter=active#private-fragment",
        method: "POST",
        headers: { Authorization: "Bearer secret" },
        postData: "private-body",
      },
    });
    emit("Network.responseReceived", {
      requestId: "request-1",
      response: {
        url: "https://api.example.test/users",
        status: 201,
        mimeType: "application/json",
        headers: { "Set-Cookie": "secret=true" },
      },
    });

    const output = await diagnostics.read(runtime, {
      includeConsole: true,
      includeNetwork: true,
      limit: 100,
    });

    expect(output.entries).toHaveLength(3);
    expect(output.entries[0]).toMatchObject({
      kind: "console",
      level: "warn",
      text: "Careful Error: boom",
    });
    expect(output.entries[2]).toMatchObject({
      kind: "network",
      phase: "response",
      status: 201,
      method: "POST",
    });
    expect(output.entries[1]).toMatchObject({
      kind: "network",
      url: "https://api.example.test/users?access_token=%5BREDACTED%5D&filter=%5BREDACTED%5D",
    });
    expect(JSON.stringify(output)).not.toContain("Bearer secret");
    expect(JSON.stringify(output)).not.toContain("private-body");
    expect(JSON.stringify(output)).not.toContain("Set-Cookie");
    expect(JSON.stringify(output)).not.toContain("secret-token");
    expect(JSON.stringify(output)).not.toContain("api-password");
    expect(JSON.stringify(output)).not.toContain("private-fragment");
    expect(sendCommand).toHaveBeenCalledWith("Runtime.enable", {});
    expect(sendCommand).toHaveBeenCalledWith("Network.enable", expect.any(Object));
  });

  it("keeps a fixed-size ring and reports dropped entries", async () => {
    const { runtime, emit } = createRuntime();
    const diagnostics = new BrowserDiagnosticsStore();
    await diagnostics.observe(runtime);
    for (let index = 0; index < 1_050; index += 1) {
      emit("Runtime.consoleAPICalled", { type: "log", args: [{ value: `line-${index}` }] });
    }

    const output = await diagnostics.read(runtime, {
      includeConsole: true,
      includeNetwork: false,
      limit: 200,
    });

    expect(output.entries).toHaveLength(200);
    expect(output.entries.at(-1)).toMatchObject({ text: "line-1049" });
    expect(output.droppedCount).toBe(50);
    expect(output.truncated).toBe(true);
  });

  it("filters entry kinds without mutating the captured history", async () => {
    const { runtime, emit } = createRuntime();
    const diagnostics = new BrowserDiagnosticsStore();
    await diagnostics.observe(runtime);
    emit("Runtime.consoleAPICalled", { type: "error", args: [{ value: "console" }] });
    emit("Network.requestWillBeSent", {
      requestId: "request-1",
      request: { url: "https://example.test/data", method: "GET" },
    });

    const networkOnly = await diagnostics.read(runtime, {
      includeConsole: false,
      includeNetwork: true,
      limit: 100,
    });
    const all = await diagnostics.read(runtime, {
      includeConsole: true,
      includeNetwork: true,
      limit: 100,
    });

    expect(networkOnly.entries.map((entry) => entry.kind)).toEqual(["network"]);
    expect(all.entries).toHaveLength(2);
    expect(all.truncated).toBe(false);
  });

  it("keeps the serialized response below the contract budget", async () => {
    const { runtime, emit } = createRuntime();
    const diagnostics = new BrowserDiagnosticsStore();
    await diagnostics.observe(runtime);
    for (let index = 0; index < 200; index += 1) {
      emit("Network.requestWillBeSent", {
        requestId: `large-request-${index}`,
        request: {
          method: "GET",
          url: `https://example.test/${"x".repeat(8_000)}?token=secret-${index}`,
        },
      });
    }

    const output = await diagnostics.read(runtime, {
      includeConsole: false,
      includeNetwork: true,
      limit: 200,
    });

    expect(Buffer.byteLength(JSON.stringify(output), "utf8")).toBeLessThanOrEqual(320 * 1_024);
    expect(output.entries.length).toBeLessThan(200);
    expect(output.truncated).toBe(true);
  });
});
