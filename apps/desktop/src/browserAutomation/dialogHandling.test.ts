import { EventEmitter } from "node:events";

import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";

import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import { evaluateInContext } from "./cdpRuntime";
import { MAX_DIALOGS_PER_COMMAND, withDialogHandling } from "./dialogHandling";

class FakeDebugger extends EventEmitter {
  readonly commands: Array<{ method: string; params: Record<string, unknown> }> = [];
  drainPrompts: unknown[] = [];
  onDialogHandled: (() => void) | undefined;

  isAttached = () => true;
  sendCommand = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    this.commands.push({ method, params });
    if (method === "Page.handleJavaScriptDialog") this.onDialogHandled?.();
    if (method === "Runtime.evaluate") {
      const expression = String(params.expression ?? "");
      if (expression.includes("return state.dialogs.splice")) {
        return { result: { value: this.drainPrompts.splice(0) } };
      }
      return { result: { value: true } };
    }
    return {};
  });
}

const makeRuntime = (debuggerInstance = new FakeDebugger()): BrowserAutomationVisibleRuntime => {
  const webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    debugger: debuggerInstance,
  }) as unknown as WebContents;
  return {
    threadId: "thread-dialog" as BrowserAutomationVisibleRuntime["threadId"],
    tabId: "tab-dialog",
    webContents,
  };
};

describe("browser JavaScript dialog handling", () => {
  it("unblocks a command through the debugger event path and applies the safe policy", async () => {
    const debuggerInstance = new FakeDebugger();
    const runtime = makeRuntime(debuggerInstance);

    const result = await withDialogHandling(runtime, async () => {
      const unblocked = new Promise<string>((resolve) => {
        debuggerInstance.onDialogHandled = () => resolve("completed");
      });
      debuggerInstance.emit("message", {}, "Page.javascriptDialogOpening", {
        type: "alert",
        message: "Ready",
      });
      return unblocked;
    });

    expect(result.value).toBe("completed");
    expect(result.dialogs).toEqual([
      expect.objectContaining({
        kind: "alert",
        message: "Ready",
        action: "accepted",
      }),
    ]);
    expect(debuggerInstance.commands).toContainEqual({
      method: "Page.handleJavaScriptDialog",
      params: { accept: true },
    });
  });

  it("collects deterministic dialog shim events and bounds the command result", async () => {
    const debuggerInstance = new FakeDebugger();
    debuggerInstance.drainPrompts = Array.from(
      { length: MAX_DIALOGS_PER_COMMAND + 5 },
      (_, index) => ({
        kind: "prompt",
        message: `Prompt ${index}`,
        defaultPrompt: "default",
        action: "dismissed",
        openedAt: new Date().toISOString(),
      }),
    );

    const result = await withDialogHandling(makeRuntime(debuggerInstance), async () => 42);

    expect(result.value).toBe(42);
    expect(result.dialogs).toHaveLength(MAX_DIALOGS_PER_COMMAND);
    expect(
      result.dialogs.every((dialog) => dialog.kind === "prompt" && dialog.action === "dismissed"),
    ).toBe(true);
  });

  it("still cleans up after navigation destroys the dialog shim execution context", async () => {
    const debuggerInstance = new FakeDebugger();
    debuggerInstance.sendCommand.mockImplementation(
      async (method: string, params: Record<string, unknown> = {}) => {
        debuggerInstance.commands.push({ method, params });
        if (
          method === "Runtime.evaluate" &&
          String(params.expression ?? "").includes("delete window")
        ) {
          throw new Error("Execution context was destroyed");
        }
        if (method === "Runtime.evaluate") return { result: { value: [] } };
        return {};
      },
    );

    await expect(
      withDialogHandling(makeRuntime(debuggerInstance), async () => "navigated"),
    ).resolves.toMatchObject({ value: "navigated", dialogs: [] });
  });

  it("does not send cleanup evaluations into a document replaced by navigation", async () => {
    const debuggerInstance = new FakeDebugger();
    const runtime = makeRuntime(debuggerInstance);

    await expect(
      withDialogHandling(runtime, async () => {
        debuggerInstance.emit("message", {}, "Page.frameNavigated", {
          frame: { id: "main-frame", loaderId: "next-loader", url: "https://example.test/next" },
        });
        return "navigated";
      }),
    ).resolves.toMatchObject({ value: "navigated", dialogs: [] });

    const evaluations = debuggerInstance.commands.filter(
      ({ method }) => method === "Runtime.evaluate",
    );
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0]?.params.expression).toContain("state.installed");
  });

  it("restores main-world dialog APIs after an aborted evaluation has drained", async () => {
    const debuggerInstance = new FakeDebugger();
    const runtime = makeRuntime(debuggerInstance);
    const controller = new AbortController();
    let releaseEvaluation: (() => void) | undefined;
    debuggerInstance.sendCommand.mockImplementation(
      async (method: string, params: Record<string, unknown> = {}) => {
        debuggerInstance.commands.push({ method, params });
        if (
          method === "Runtime.evaluate" &&
          String(params.expression ?? "") === "window.__synaraBlockingEvaluation"
        ) {
          await new Promise<void>((resolve) => {
            releaseEvaluation = resolve;
          });
        }
        return { result: { value: true } };
      },
    );

    const pending = withDialogHandling(
      runtime,
      () =>
        evaluateInContext(runtime, "window.__synaraBlockingEvaluation", {
          signal: controller.signal,
        }),
      controller.signal,
    );
    const rejected = expect(pending).rejects.toThrow("stopped");
    await vi.waitFor(() => expect(releaseEvaluation).toBeTypeOf("function"));

    controller.abort(new Error("stopped"));
    await vi.waitFor(() =>
      expect(
        debuggerInstance.commands.some(({ method }) => method === "Runtime.terminateExecution"),
      ).toBe(true),
    );
    releaseEvaluation?.();
    await rejected;

    const terminationIndex = debuggerInstance.commands.findIndex(
      ({ method }) => method === "Runtime.terminateExecution",
    );
    const restoreIndex = debuggerInstance.commands.findIndex(
      ({ method, params }) =>
        method === "Runtime.evaluate" &&
        String(params.expression ?? "").includes("delete window[key]"),
    );
    expect(terminationIndex).toBeGreaterThanOrEqual(0);
    expect(restoreIndex).toBeGreaterThan(terminationIndex);
    expect(debuggerInstance.commands[restoreIndex]?.params.timeout).toBe(1_000);
  });

  it("preserves the command result when bounded dialog cleanup fails", async () => {
    const debuggerInstance = new FakeDebugger();
    debuggerInstance.sendCommand.mockImplementation(
      async (method: string, params: Record<string, unknown> = {}) => {
        debuggerInstance.commands.push({ method, params });
        if (method !== "Runtime.evaluate") return {};
        const expression = String(params.expression ?? "");
        if (expression.includes("state.dialogs.splice")) return { result: { value: [] } };
        if (expression.includes("delete window[key]")) throw new Error("Execution timed out");
        return { result: { value: true } };
      },
    );

    await expect(
      withDialogHandling(makeRuntime(debuggerInstance), async () => "completed"),
    ).resolves.toMatchObject({ value: "completed", dialogs: [] });

    const cleanup = debuggerInstance.commands.find(
      ({ method, params }) =>
        method === "Runtime.evaluate" &&
        String(params.expression ?? "").includes("delete window[key]"),
    );
    expect(cleanup?.params.timeout).toBe(1_000);
  });

  it("drains an aborted Page.enable and removes every partially installed listener", async () => {
    const debuggerInstance = new FakeDebugger();
    let resolveEnable: (() => void) | undefined;
    debuggerInstance.sendCommand.mockImplementation(
      async (method: string, params: Record<string, unknown> = {}) => {
        debuggerInstance.commands.push({ method, params });
        if (method === "Page.enable") {
          await new Promise<void>((resolve) => {
            resolveEnable = resolve;
          });
        }
        return {};
      },
    );
    const runtime = makeRuntime(debuggerInstance);
    const controller = new AbortController();
    const operation = vi.fn(async () => "never");
    const pending = withDialogHandling(runtime, operation, controller.signal);
    const rejected = expect(pending).rejects.toThrow("stopped during enable");
    await vi.waitFor(() => expect(resolveEnable).toBeTypeOf("function"));

    controller.abort(new Error("stopped during enable"));
    resolveEnable?.();
    await rejected;

    expect(operation).not.toHaveBeenCalled();
    expect(debuggerInstance.listenerCount("message")).toBe(0);
    expect((runtime.webContents as unknown as EventEmitter).listenerCount("destroyed")).toBe(0);
    expect(debuggerInstance.commands.map(({ method }) => method)).toEqual(["Page.enable"]);
  });

  it("drains the direct orphan-dialog dismissal when cancellation races it", async () => {
    const debuggerInstance = new FakeDebugger();
    let resolveDismiss: (() => void) | undefined;
    debuggerInstance.sendCommand.mockImplementation(
      async (method: string, params: Record<string, unknown> = {}) => {
        debuggerInstance.commands.push({ method, params });
        if (method === "Page.handleJavaScriptDialog") {
          await new Promise<void>((resolve) => {
            resolveDismiss = resolve;
          });
        }
        return {};
      },
    );
    const runtime = makeRuntime(debuggerInstance);
    const controller = new AbortController();
    const operation = vi.fn(async () => "never");
    const pending = withDialogHandling(runtime, operation, controller.signal);
    const rejected = expect(pending).rejects.toThrow("stopped during dismiss");
    await vi.waitFor(() => expect(resolveDismiss).toBeTypeOf("function"));

    controller.abort(new Error("stopped during dismiss"));
    resolveDismiss?.();
    await rejected;

    expect(operation).not.toHaveBeenCalled();
    expect(debuggerInstance.listenerCount("message")).toBe(0);
    expect((runtime.webContents as unknown as EventEmitter).listenerCount("destroyed")).toBe(0);
    expect(debuggerInstance.commands.map(({ method }) => method)).toEqual([
      "Page.enable",
      "Page.handleJavaScriptDialog",
    ]);
  });

  it("removes a failed monitor so the next command initializes a fresh one", async () => {
    const debuggerInstance = new FakeDebugger();
    let enableAttempts = 0;
    debuggerInstance.sendCommand.mockImplementation(
      async (method: string, params: Record<string, unknown> = {}) => {
        debuggerInstance.commands.push({ method, params });
        if (method === "Page.enable" && enableAttempts++ === 0) {
          throw new Error("debugger initialization failed");
        }
        if (method === "Runtime.evaluate") return { result: { value: [] } };
        return {};
      },
    );
    const runtime = makeRuntime(debuggerInstance);

    await expect(withDialogHandling(runtime, async () => "first")).rejects.toThrow();
    expect(debuggerInstance.listenerCount("message")).toBe(0);
    expect((runtime.webContents as unknown as EventEmitter).listenerCount("destroyed")).toBe(0);

    await expect(withDialogHandling(runtime, async () => "second")).resolves.toMatchObject({
      value: "second",
    });
    expect(enableAttempts).toBe(2);
    expect(debuggerInstance.listenerCount("message")).toBe(1);
    expect((runtime.webContents as unknown as EventEmitter).listenerCount("destroyed")).toBe(1);
  });

  it("does not touch Electron's invalid debugger wrapper after WebContents is destroyed", async () => {
    let destroyed = false;
    const debuggerInstance = new FakeDebugger();
    const removeListener = debuggerInstance.removeListener.bind(debuggerInstance);
    debuggerInstance.removeListener = vi.fn(
      (event: string | symbol, listener: (...args: unknown[]) => void) => {
        if (destroyed) throw new Error("Object has been destroyed");
        return removeListener(event, listener);
      },
    );
    const webContents = Object.assign(new EventEmitter(), {
      isDestroyed: () => destroyed,
      debugger: debuggerInstance,
    }) as unknown as WebContents;
    const runtime: BrowserAutomationVisibleRuntime = {
      threadId: "thread-dialog-destroyed" as BrowserAutomationVisibleRuntime["threadId"],
      tabId: "tab-dialog-destroyed",
      webContents,
    };

    await expect(withDialogHandling(runtime, async () => "ready")).resolves.toMatchObject({
      value: "ready",
    });

    vi.mocked(debuggerInstance.removeListener).mockClear();
    destroyed = true;
    expect(() => (webContents as unknown as EventEmitter).emit("destroyed")).not.toThrow();
    expect(debuggerInstance.removeListener).not.toHaveBeenCalled();
  });

  it("distinguishes the expected no-dialog response from a failed direct dismissal", async () => {
    const expectedDebugger = new FakeDebugger();
    expectedDebugger.sendCommand.mockImplementation(
      async (method: string, params: Record<string, unknown> = {}) => {
        expectedDebugger.commands.push({ method, params });
        if (method === "Page.handleJavaScriptDialog") throw new Error("No dialog is showing");
        if (method === "Runtime.evaluate") return { result: { value: [] } };
        return {};
      },
    );
    await expect(
      withDialogHandling(makeRuntime(expectedDebugger), async () => "ready"),
    ).resolves.toMatchObject({ value: "ready" });

    const failedDebugger = new FakeDebugger();
    failedDebugger.sendCommand.mockImplementation(
      async (method: string, params: Record<string, unknown> = {}) => {
        failedDebugger.commands.push({ method, params });
        if (method === "Page.handleJavaScriptDialog") throw new Error("debugger detached");
        return {};
      },
    );
    const failedRuntime = makeRuntime(failedDebugger);
    await expect(withDialogHandling(failedRuntime, async () => "unreachable")).rejects.toThrow(
      "debugger detached",
    );
    expect(failedDebugger.listenerCount("message")).toBe(0);
    expect((failedRuntime.webContents as unknown as EventEmitter).listenerCount("destroyed")).toBe(
      0,
    );
  });
});
