import { describe, expect, it, vi } from "vitest";

import { waitForBackendStartupReady } from "./backendStartupReadiness";

describe("waitForBackendStartupReady", () => {
  it("resolves from http when no listening promise is provided", async () => {
    const waitForHttpReady = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const cancelHttpWait = vi.fn();

    await expect(
      waitForBackendStartupReady({
        waitForHttpReady,
        cancelHttpWait,
      }),
    ).resolves.toBe("http");

    expect(waitForHttpReady).toHaveBeenCalledTimes(1);
    expect(cancelHttpWait).not.toHaveBeenCalled();
  });

  it("prefers the listening signal and cancels the http wait", async () => {
    let resolveListening: (() => void) | null = null;
    const listeningPromise = new Promise<void>((resolve) => {
      resolveListening = resolve;
    });
    const waitForHttpReady = vi.fn(() => new Promise<void>(() => {}));
    const cancelHttpWait = vi.fn();

    const resultPromise = waitForBackendStartupReady({
      listeningPromise,
      waitForHttpReady,
      cancelHttpWait,
    });

    resolveListening?.();

    await expect(resultPromise).resolves.toBe("listening");
    expect(cancelHttpWait).toHaveBeenCalledTimes(1);
  });

  it("rejects when the listening promise fails before http is ready", async () => {
    const error = new Error("backend exited");

    await expect(
      waitForBackendStartupReady({
        listeningPromise: Promise.reject(error),
        waitForHttpReady: () => new Promise<void>(() => {}),
        cancelHttpWait: vi.fn(),
      }),
    ).rejects.toThrow("backend exited");
  });
});
