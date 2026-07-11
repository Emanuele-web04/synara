import { describe, expect, it, vi } from "vitest";

import {
  isBackendStartupReadyResponse,
  monitorBackendStartupHealth,
  waitForBackendStartupReady,
} from "./backendStartupReadiness";

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
    let resolveListening!: () => void;
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

    resolveListening();

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

describe("monitorBackendStartupHealth", () => {
  it("reports readiness independently of the listening log detector", async () => {
    let resolveReady!: () => void;
    const waitUntilReady = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveReady = resolve;
        }),
    );
    const onReady = vi.fn();

    monitorBackendStartupHealth({
      waitUntilReady,
      isCurrent: () => true,
      onReady,
    });
    resolveReady();
    await Promise.resolve();

    expect(waitUntilReady).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("does not report readiness after the backend session is cancelled", async () => {
    let resolveReady!: () => void;
    const onReady = vi.fn();
    const monitor = monitorBackendStartupHealth({
      waitUntilReady: () =>
        new Promise<void>((resolve) => {
          resolveReady = resolve;
        }),
      isCurrent: () => true,
      onReady,
    });

    monitor.abort();
    resolveReady();
    await Promise.resolve();

    expect(onReady).not.toHaveBeenCalled();
  });

  it("keeps monitoring when startup readiness arrives after an earlier timeout", async () => {
    vi.useFakeTimers();
    const onReady = vi.fn();
    const waitUntilReady = vi
      .fn<(signal: AbortSignal) => Promise<void>>()
      .mockRejectedValueOnce(new Error("health readiness timed out"))
      .mockResolvedValueOnce(undefined);

    monitorBackendStartupHealth({
      waitUntilReady,
      isCurrent: () => true,
      onReady,
      retryDelayMs: 1_000,
    });
    await Promise.resolve();

    expect(waitUntilReady).toHaveBeenCalledTimes(1);
    expect(onReady).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(waitUntilReady).toHaveBeenCalledTimes(2);
    expect(onReady).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("does not retry a failed health monitor after the backend session is cancelled", async () => {
    vi.useFakeTimers();
    const waitUntilReady = vi
      .fn<(signal: AbortSignal) => Promise<void>>()
      .mockRejectedValue(new Error("health readiness timed out"));
    const monitor = monitorBackendStartupHealth({
      waitUntilReady,
      isCurrent: () => true,
      onReady: vi.fn(),
      retryDelayMs: 1_000,
    });
    await Promise.resolve();

    monitor.abort();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(waitUntilReady).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("requires a successful health response with startupReady enabled", async () => {
    await expect(
      isBackendStartupReadyResponse(
        new Response(JSON.stringify({ startupReady: true }), { status: 200 }),
      ),
    ).resolves.toBe(true);
    await expect(
      isBackendStartupReadyResponse(
        new Response(JSON.stringify({ startupReady: false }), { status: 200 }),
      ),
    ).resolves.toBe(false);
    await expect(
      isBackendStartupReadyResponse(new Response("unavailable", { status: 503 })),
    ).resolves.toBe(false);
  });
});
