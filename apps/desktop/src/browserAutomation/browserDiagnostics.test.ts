import { EventEmitter } from "node:events";

import { ThreadId } from "@synara/contracts";
import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";

import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import { BROWSER_DIAGNOSTICS_IDLE_QUIESCE_MS, BrowserDiagnosticsStore } from "./browserDiagnostics";

const THREAD_ID = ThreadId.makeUnsafe("thread-diagnostics");
const TAB_ID = "025aa711-edf6-4c63-b957-d7c96a3fdabb";
const OTHER_TAB_ID = "ff0ba38f-6df8-48bf-b419-a0f8185e6e3b";

const createRuntime = () => {
  const events = new EventEmitter();
  const sendCommand = vi.fn(async (_method: string, _params: unknown) => ({}));
  let attached = true;
  const webContents = {
    isDestroyed: () => false,
    once: vi.fn(),
    debugger: {
      isAttached: () => attached,
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
    listenerCount: () => events.listenerCount("message"),
    setAttached: (value: boolean) => {
      attached = value;
    },
  };
};

const sentMethods = (sendCommand: ReturnType<typeof createRuntime>["sendCommand"]): string[] =>
  sendCommand.mock.calls.map(([method]) => method);

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
  it("quiesces capture on release, keeps history, and re-enables on the next acquisition", async () => {
    const { runtime, emit, sendCommand, listenerCount } = createRuntime();
    const diagnostics = new BrowserDiagnosticsStore();
    await diagnostics.observe(runtime);
    emit("Runtime.consoleAPICalled", { type: "log", args: [{ value: "before-release" }] });

    await diagnostics.quiesce(runtime);
    await diagnostics.quiesce(runtime);

    expect(sentMethods(sendCommand)).toEqual([
      "Runtime.enable",
      "Log.enable",
      "Network.enable",
      "Runtime.disable",
      "Log.disable",
      "Runtime.discardConsoleEntries",
      "Log.clear",
    ]);
    expect(listenerCount()).toBe(1);
    // Runtime/Log are disabled, but the shared listener keeps capturing Network.

    sendCommand.mockClear();
    const output = await diagnostics.read(runtime, {
      includeConsole: true,
      includeNetwork: true,
      limit: 100,
    });
    expect(sentMethods(sendCommand)).toEqual(["Runtime.enable", "Log.enable", "Network.enable"]);
    expect(listenerCount()).toBe(1);
    expect(output.entries.map((entry) => entry.kind === "console" && entry.text)).toEqual([
      "before-release",
    ]);

    emit("Runtime.consoleAPICalled", { type: "log", args: [{ value: "after-reacquire" }] });
    const next = await diagnostics.read(runtime, {
      includeConsole: true,
      includeNetwork: false,
      limit: 100,
    });
    expect(next.entries.map((entry) => entry.kind === "console" && entry.text)).toEqual([
      "before-release",
      "after-reacquire",
    ]);
    diagnostics.dispose(runtime);
  });

  it("quiesces after the idle window following the last acquisition", async () => {
    vi.useFakeTimers();
    try {
      const { runtime, sendCommand } = createRuntime();
      const diagnostics = new BrowserDiagnosticsStore();
      await diagnostics.observe(runtime);
      await vi.advanceTimersByTimeAsync(BROWSER_DIAGNOSTICS_IDLE_QUIESCE_MS - 1_000);
      // A new acquisition restarts the idle window.
      await diagnostics.observe(runtime);
      await vi.advanceTimersByTimeAsync(BROWSER_DIAGNOSTICS_IDLE_QUIESCE_MS - 1_000);
      expect(sentMethods(sendCommand)).not.toContain("Runtime.disable");

      await vi.advanceTimersByTimeAsync(1_000);
      expect(sentMethods(sendCommand)).toContain("Runtime.disable");
      expect(sentMethods(sendCommand)).toContain("Runtime.discardConsoleEntries");
      diagnostics.dispose(runtime);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps network capture and in-flight metadata through an idle quiesce", async () => {
    vi.useFakeTimers();
    const { runtime, emit } = createRuntime();
    const diagnostics = new BrowserDiagnosticsStore();
    try {
      await diagnostics.observe(runtime);
      emit("Network.requestWillBeSent", {
        requestId: "before-idle",
        request: { url: "https://example.test/before", method: "POST" },
      });
      await vi.advanceTimersByTimeAsync(BROWSER_DIAGNOSTICS_IDLE_QUIESCE_MS);
      emit("Network.responseReceived", {
        requestId: "before-idle",
        response: { url: "https://example.test/before", status: 201 },
      });
      emit("Network.requestWillBeSent", {
        requestId: "while-idle",
        request: { url: "https://example.test/idle", method: "PATCH" },
      });
      emit("Network.loadingFailed", { requestId: "while-idle", errorText: "fixture failure" });
      const output = await diagnostics.read(runtime, {
        includeConsole: false,
        includeNetwork: true,
        limit: 100,
      });
      expect(output.entries).toMatchObject([
        { kind: "network", phase: "request", requestId: "before-idle", method: "POST" },
        {
          kind: "network",
          phase: "response",
          requestId: "before-idle",
          method: "POST",
          status: 201,
        },
        { kind: "network", phase: "request", requestId: "while-idle", method: "PATCH" },
        {
          kind: "network",
          phase: "failure",
          requestId: "while-idle",
          method: "PATCH",
          url: "https://example.test/idle",
        },
      ]);
    } finally {
      diagnostics.dispose(runtime);
      vi.useRealTimers();
    }
  });

  it("skips disable commands when the debugger already detached", async () => {
    const { runtime, sendCommand, listenerCount, setAttached } = createRuntime();
    const diagnostics = new BrowserDiagnosticsStore();
    await diagnostics.observe(runtime);
    sendCommand.mockClear();
    setAttached(false);

    await diagnostics.quiesce(runtime);

    expect(sendCommand).not.toHaveBeenCalled();
    expect(listenerCount()).toBe(1);
    diagnostics.dispose(runtime);
  });

  it("does not touch the debugger when quiescing after WebContents is destroyed", async () => {
    const { runtime, destroy } = createDestroyableRuntime();
    const diagnostics = new BrowserDiagnosticsStore();
    await diagnostics.observe(runtime);
    destroy();

    await expect(diagnostics.quiesce(runtime)).resolves.toBeUndefined();
  });

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

  it("resets captured diagnostics when one WebContents is rebound to another tab", async () => {
    const { runtime, emit, sendCommand } = createRuntime();
    const diagnostics = new BrowserDiagnosticsStore();
    await diagnostics.observe(runtime);
    emit("Runtime.consoleAPICalled", { type: "log", args: [{ value: "tab-a-only" }] });

    const reboundRuntime = {
      ...runtime,
      tabId: OTHER_TAB_ID,
    } satisfies BrowserAutomationVisibleRuntime;
    await diagnostics.observe(reboundRuntime);
    emit("Runtime.consoleAPICalled", { type: "log", args: [{ value: "tab-b-only" }] });

    const output = await diagnostics.read(reboundRuntime, {
      includeConsole: true,
      includeNetwork: true,
      limit: 100,
    });

    expect(output.tabId).toBe(OTHER_TAB_ID);
    expect(output.entries).toHaveLength(1);
    expect(output.entries[0]).toMatchObject({ kind: "console", text: "tab-b-only" });
    expect(JSON.stringify(output)).not.toContain("tab-a-only");
    expect(sendCommand.mock.calls.filter(([method]) => method === "Runtime.enable")).toHaveLength(
      2,
    );
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

  it("drops the oldest entry when the untruncated response is one byte over budget", async () => {
    const readFixture = async (padding: number) => {
      const { runtime, emit } = createRuntime();
      const diagnostics = new BrowserDiagnosticsStore();
      await diagnostics.observe(runtime);
      try {
        for (let index = 0; index < 41; index += 1) {
          emit("Network.requestWillBeSent", {
            requestId: `request-${index}`,
            request: {
              method: "GET",
              url: `https://example.test/${"x".repeat(index < 40 ? 8_000 : padding)}`,
            },
          });
        }
        return await diagnostics.read(runtime, {
          includeConsole: false,
          includeNetwork: true,
          limit: 200,
        });
      } finally {
        diagnostics.dispose(runtime);
      }
    };
    const short = await readFixture(0);
    expect(short.entries).toHaveLength(41);
    expect(short.truncated).toBe(false);
    const padding = 320 * 1_024 + 1 - Buffer.byteLength(JSON.stringify(short), "utf8");
    expect(padding).toBeGreaterThan(0);
    expect(padding).toBeLessThan(8_000);
    const last = short.entries[40];
    if (last?.kind !== "network") throw new Error("Expected a network entry in the fixture");
    const full = {
      ...short,
      entries: short.entries.with(40, { ...last, url: last.url + "x".repeat(padding) }),
    };
    expect(Buffer.byteLength(JSON.stringify(full), "utf8")).toBe(320 * 1_024 + 1);
    const output = await readFixture(padding);
    expect(output.entries).toHaveLength(40);
    expect(output.entries[0]).toMatchObject({ requestId: "request-1" });
    expect(output.truncated).toBe(true);
  });

  it.each([
    { kind: "network", text: "x" },
    { kind: "console", text: "多" },
    { kind: "console", text: '"\\' },
  ])(
    "keeps the largest newest suffix under the JSON byte budget ($kind/$text)",
    async ({ kind, text }) => {
      const { runtime, emit } = createRuntime();
      const diagnostics = new BrowserDiagnosticsStore();
      await diagnostics.observe(runtime);
      const captured = [];
      for (let index = 0; index < 200; index += 1) {
        if (kind === "network") {
          emit("Network.requestWillBeSent", {
            requestId: `large-request-${index}`,
            request: {
              method: "GET",
              url: `https://example.test/${text.repeat(8_000)}?token=secret-${index}`,
            },
          });
        } else {
          emit("Log.entryAdded", {
            entry: { level: "info", text: `${index}:${text.repeat(4_096)}` },
          });
        }
        const latest = await diagnostics.read(runtime, {
          includeConsole: true,
          includeNetwork: true,
          limit: 1,
        });
        captured.push(latest.entries[0]!);
      }
      if (kind === "console") {
        expect(captured[0]).toMatchObject({ kind, text: expect.stringContaining(text) });
      }

      const output = await diagnostics.read(runtime, {
        includeConsole: true,
        includeNetwork: true,
        limit: 200,
      });

      expect(Buffer.byteLength(JSON.stringify(output), "utf8")).toBeLessThanOrEqual(320 * 1_024);
      expect(output.entries.length).toBeLessThan(200);
      expect(output.truncated).toBe(true);
      const expected = { ...output, entries: captured, truncated: false };
      while (
        expected.entries.length > 0 &&
        Buffer.byteLength(JSON.stringify(expected), "utf8") > 320 * 1_024
      ) {
        expected.entries = expected.entries.slice(1);
        expected.truncated = true;
      }
      expect(output).toEqual(expected);
      diagnostics.dispose(runtime);
    },
    15_000,
  );
});
