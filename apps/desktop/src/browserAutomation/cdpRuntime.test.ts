import { ThreadId } from "@synara/contracts";
import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";

import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import { callFunctionOn, drainOnAbort, evaluateInContext } from "./cdpRuntime";

const runtimeWithFailure = (): BrowserAutomationVisibleRuntime => ({
  threadId: ThreadId.makeUnsafe("thread-cdp-errors"),
  tabId: "fcb69a74-b5e1-43ad-823a-09a8c8bc42fc",
  webContents: {
    isDestroyed: () => false,
    debugger: {
      isAttached: () => true,
      attach: vi.fn(),
      sendCommand: vi.fn(async () => {
        throw new Error("renderer disconnected after dispatch");
      }),
    },
  } as unknown as WebContents,
});

describe("CDP ambiguous effects", () => {
  it("passes a native Chromium deadline to Runtime.evaluate", async () => {
    const sendCommand = vi.fn(async () => ({ result: { value: "ready" } }));
    const runtime = {
      threadId: ThreadId.makeUnsafe("thread-cdp-timeout"),
      tabId: "3ff525b5-ebd6-46ad-ab82-e20b1fbf7b9a",
      webContents: {
        isDestroyed: () => false,
        debugger: {
          isAttached: () => true,
          attach: vi.fn(),
          sendCommand,
        },
      } as unknown as WebContents,
    } satisfies BrowserAutomationVisibleRuntime;

    await expect(
      evaluateInContext<string>(runtime, "document.readyState", { timeoutMs: 1_000 }),
    ).resolves.toMatchObject({ value: "ready" });
    expect(sendCommand).toHaveBeenCalledWith(
      "Runtime.evaluate",
      expect.objectContaining({ expression: "document.readyState", timeout: 1_000 }),
    );
  });

  it("does not finish internal cancellation draining before cleanup is acknowledged", async () => {
    let rejectOperation!: (error: Error) => void;
    const operation = new Promise<never>((_resolve, reject) => {
      rejectOperation = reject;
    });
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const controller = new AbortController();
    const draining = drainOnAbort(operation, controller.signal, () => cleanup);

    controller.abort(new Error("turn stopped"));
    rejectOperation(new Error("operation interrupted"));
    let settled = false;
    void draining
      .finally(() => {
        settled = true;
      })
      .catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    releaseCleanup();
    await expect(draining).rejects.toThrow("turn stopped");
  });

  it("does not advertise a mutating callFunctionOn transport failure as safely retryable", async () => {
    await expect(
      callFunctionOn(runtimeWithFailure(), "remote-object", "function () { this.click(); }"),
    ).rejects.toMatchObject({
      browserError: {
        code: "BrowserAmbiguousResult",
        retryable: false,
        effectMayHaveCommitted: true,
      },
    });
  });

  it("keeps observation failures retryable while preserving explicit evaluation effects", async () => {
    await expect(evaluateInContext(runtimeWithFailure(), "document.title")).rejects.toMatchObject({
      browserError: {
        code: "BrowserRuntimeDisconnected",
        retryable: true,
        effectMayHaveCommitted: false,
      },
    });

    await expect(
      evaluateInContext(runtimeWithFailure(), "localStorage.clear()", {
        effectMayHaveCommitted: true,
      }),
    ).rejects.toMatchObject({
      browserError: {
        code: "BrowserAmbiguousResult",
        retryable: false,
        effectMayHaveCommitted: true,
      },
    });
  });
});
