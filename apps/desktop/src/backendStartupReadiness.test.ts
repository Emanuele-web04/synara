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
    const cancelHttpWait = vi.fn();

    await expect(
      waitForBackendStartupReady({
        listeningPromise: Promise.reject(error),
        waitForHttpReady: () => new Promise<void>(() => {}),
        cancelHttpWait,
      }),
    ).rejects.toThrow("backend exited");

    expect(cancelHttpWait).toHaveBeenCalledTimes(1);
  });

  it("does not cancel http after http readiness already won", async () => {
    let resolveHttpReady!: () => void;
    let rejectListening!: (error: Error) => void;
    const listeningPromise = new Promise<void>((_resolve, reject) => {
      rejectListening = reject;
    });
    const waitForHttpReady = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveHttpReady = resolve;
        }),
    );
    const cancelHttpWait = vi.fn();

    const resultPromise = waitForBackendStartupReady({
      listeningPromise,
      waitForHttpReady,
      cancelHttpWait,
    });

    resolveHttpReady();
    await expect(resultPromise).resolves.toBe("http");

    rejectListening(new Error("late backend exit"));
    await Promise.resolve();

    expect(cancelHttpWait).not.toHaveBeenCalled();
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
