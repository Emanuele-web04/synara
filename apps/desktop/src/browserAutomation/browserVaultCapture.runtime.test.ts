import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import type { BrowserVault } from "./browserVault";
import { BrowserVaultCapture } from "./browserVaultCapture";

// Deliberately do not mock betterwright/capture. Changes to the installed
// sensor's context, page, or CDP surface must exercise the Electron adapter.
function fixture() {
  const saveCaptured = vi.fn(async () => {});
  const askSave = vi.fn(async () => "save" as const);
  const trackSecret = vi.fn();
  const reportCaptureReady = vi.fn();
  const reportCaptureFailure = vi.fn();
  const vault = {
    onChanged: () => () => {},
    snapshot: async () => ({
      settings: { offerSave: true },
      protection: { locked: false },
      logins: [],
    }),
    saveCaptured,
    askSave,
    trackSecret,
    shouldOfferSave: () => true,
    reportCaptureReady,
    reportCaptureFailure,
  } as unknown as BrowserVault;
  const capture = new BrowserVaultCapture(vault);
  let nextSession = 0;
  const debuggerApi = Object.assign(new EventEmitter(), {
    isAttached: () => true,
    sendCommand: vi.fn(async (method: string) => {
      if (method === "Target.getTargetInfo") return { targetInfo: { targetId: "own-target" } };
      if (method === "Target.attachToTarget") return { sessionId: `capture-${++nextSession}` };
      if (method === "Page.addScriptToEvaluateOnNewDocument")
        return { identifier: "sensor-script" };
      return {};
    }),
  });
  const runtime = {
    webContents: { debugger: debuggerApi, isDestroyed: () => false },
  } as unknown as BrowserAutomationVisibleRuntime;
  const emit = (method: string, payload: unknown, sessionId = "capture-1") =>
    debuggerApi.emit("message", {}, method, payload, sessionId);
  const binding = (payload: unknown, sessionId = "capture-1") =>
    emit(
      "Runtime.bindingCalled",
      {
        name: "__bwVaultEvent",
        executionContextId: 7,
        payload: JSON.stringify(payload),
      },
      sessionId,
    );
  return {
    capture,
    runtime,
    debuggerApi,
    emit,
    binding,
    saveCaptured,
    askSave,
    trackSecret,
    reportCaptureReady,
    reportCaptureFailure,
  };
}

afterEach(() => vi.useRealTimers());

describe("BrowserVaultCapture with the installed BetterWright sensor", () => {
  it("installs on existing and late pages and detaches only its own sessions", async () => {
    const f = fixture();
    const foreignListener = vi.fn();
    f.debuggerApi.on("message", foreignListener);
    const unregister = f.capture.register(f.runtime);
    try {
      await vi.waitFor(() => expect(f.reportCaptureReady).toHaveBeenCalledOnce());
      expect(f.debuggerApi.sendCommand).toHaveBeenCalledWith(
        "Page.addScriptToEvaluateOnNewDocument",
        {
          source: expect.stringContaining("__bwVaultEvent"),
          worldName: "betterwright-vault",
          runImmediately: true,
        },
        "capture-1",
      );
      f.capture.register(f.runtime);
      await vi.waitFor(() => expect(f.reportCaptureReady).toHaveBeenCalledTimes(2));
      unregister();
      await vi.waitFor(() =>
        expect(f.debuggerApi.sendCommand).toHaveBeenCalledWith("Target.detachFromTarget", {
          sessionId: "capture-1",
        }),
      );
      expect(f.reportCaptureFailure).not.toHaveBeenCalled();
    } finally {
      await f.capture.dispose();
    }
    expect(f.debuggerApi.listeners("message")).toEqual([foreignListener]);
    expect(f.debuggerApi.sendCommand).toHaveBeenCalledWith("Target.detachFromTarget", {
      sessionId: "capture-2",
    });
  });

  it("keeps a native save prompt alive beyond the upstream 30-second default", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let answer!: (choice: "save") => void;
    f.askSave.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    f.capture.register(f.runtime);
    try {
      await vi.waitFor(() => expect(f.reportCaptureReady).toHaveBeenCalledOnce());
      f.emit("Runtime.executionContextCreated", {
        context: { id: 7, name: "betterwright-vault", auxData: { frameId: "frame" } },
      });
      const submitted = {
        type: "submitCapture",
        origin: "https://login.example",
        href: "https://login.example/signin",
        username: "synthetic-user",
        password: "synthetic-only",
      };
      f.binding(submitted, "foreign-session");
      expect(f.trackSecret).not.toHaveBeenCalled();
      f.binding(submitted);
      f.binding({ type: "fieldsCleared" });
      await vi.waitFor(() => expect(f.askSave).toHaveBeenCalledOnce());
      expect(f.askSave).toHaveBeenCalledWith({
        origin: "https://login.example",
        username: "synthetic-user",
        mode: "save",
      });
      await vi.advanceTimersByTimeAsync(90_000);
      answer("save");
      await vi.waitFor(() => expect(f.saveCaptured).toHaveBeenCalledOnce());
      expect(f.saveCaptured).toHaveBeenCalledWith(
        "https://login.example",
        {
          username: "synthetic-user",
          password: "synthetic-only",
          label: "login.example",
          deferToPending: true,
        },
        "user",
      );
      expect(f.reportCaptureFailure).not.toHaveBeenCalled();
    } finally {
      await f.capture.dispose();
    }
  });
});
