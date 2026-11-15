import { describe, expect, it, vi } from "vitest";

import {
  BACKEND_COMPILE_CACHE_FLUSH_DELAY_MS,
  releaseBackendCompileCacheEnvironment,
  scheduleBackendCompileCacheFlush,
} from "./backendCompileCache";

describe("releaseBackendCompileCacheEnvironment", () => {
  it("removes the compile cache the desktop set for the backend alone", () => {
    const env: NodeJS.ProcessEnv = {
      NODE_COMPILE_CACHE: "/home/.synara/userdata/cache/backend-compile/1.5.4",
      SYNARA_BACKEND_COMPILE_CACHE: "/home/.synara/userdata/cache/backend-compile/1.5.4",
      PATH: "/usr/bin",
    };
    expect(releaseBackendCompileCacheEnvironment(env)).toBe(true);
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("leaves a compile cache the user configured", () => {
    const env: NodeJS.ProcessEnv = {
      NODE_COMPILE_CACHE: "/users/own-cache",
      SYNARA_BACKEND_COMPILE_CACHE: "/home/.synara/userdata/cache/backend-compile/1.5.4",
    };
    expect(releaseBackendCompileCacheEnvironment(env)).toBe(false);
    expect(env).toEqual({ NODE_COMPILE_CACHE: "/users/own-cache" });

    const untouched: NodeJS.ProcessEnv = { NODE_COMPILE_CACHE: "/users/own-cache" };
    expect(releaseBackendCompileCacheEnvironment(untouched)).toBe(false);
    expect(untouched).toEqual({ NODE_COMPILE_CACHE: "/users/own-cache" });
  });
});

describe("scheduleBackendCompileCacheFlush", () => {
  const scheduler = () => {
    const timer = { unref: vi.fn() };
    const calls: Array<{ run: () => void; delayMs: number }> = [];
    return {
      timer,
      calls,
      schedule: (run: () => void, delayMs: number) => {
        calls.push({ run, delayMs });
        return timer;
      },
    };
  };

  it("writes the desktop's cache once startup has settled, without holding the process open", () => {
    const flush = vi.fn();
    const { schedule, calls, timer } = scheduler();
    expect(scheduleBackendCompileCacheFlush(true, { flush, schedule })).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.delayMs).toBe(BACKEND_COMPILE_CACHE_FLUSH_DELAY_MS);
    expect(timer.unref).toHaveBeenCalledTimes(1);
    expect(flush).not.toHaveBeenCalled();
    calls[0]!.run();
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a cache it does not own or a runtime that cannot flush", () => {
    const flush = vi.fn();
    const first = scheduler();
    expect(scheduleBackendCompileCacheFlush(false, { flush, schedule: first.schedule })).toBe(
      false,
    );
    const second = scheduler();
    expect(
      scheduleBackendCompileCacheFlush(true, { flush: undefined, schedule: second.schedule }),
    ).toBe(false);
    expect(first.calls).toHaveLength(0);
    expect(second.calls).toHaveLength(0);
  });

  it("survives a failed write", () => {
    const { schedule, calls } = scheduler();
    scheduleBackendCompileCacheFlush(true, {
      flush: () => {
        throw new Error("disk full");
      },
      schedule,
    });
    expect(() => calls[0]!.run()).not.toThrow();
  });
});
