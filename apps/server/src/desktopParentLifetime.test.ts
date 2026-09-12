import { once } from "node:events";
import { PassThrough } from "node:stream";

import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it, vi } from "vitest";

import { consumeDesktopParentInput, withDesktopParentLifetime } from "./desktopParentLifetime";

function runningProgram(onStarted: () => void, onReleased: () => void) {
  return Effect.acquireUseRelease(
    Effect.sync(onStarted),
    () => Effect.never,
    () => Effect.sync(onReleased),
  );
}

describe("desktop parent lifetime", () => {
  it("consumes the marker once and leaves ordinary CLI input untouched", () => {
    const input = new PassThrough();
    const readInput = vi.fn(() => input);
    const env: NodeJS.ProcessEnv = { SYNARA_DESKTOP_PARENT_STDIN: "1" };
    expect(consumeDesktopParentInput(env, readInput)).toBe(input);
    expect(env.SYNARA_DESKTOP_PARENT_STDIN).toBeUndefined();
    expect(consumeDesktopParentInput(env, readInput)).toBeUndefined();
    expect(readInput).toHaveBeenCalledTimes(1);
    expect(
      consumeDesktopParentInput({ SYNARA_DESKTOP_PARENT_STDIN: "0" }, readInput),
    ).toBeUndefined();
    expect(readInput).toHaveBeenCalledTimes(1);
  });

  it.each(["end", "close", "error"] as const)("cleans up the runtime on input %s", async (event) => {
    const input = new PassThrough();
    const released = vi.fn();
    const started = Promise.withResolvers<void>();
    const result = Effect.runPromise(
      withDesktopParentLifetime(runningProgram(started.resolve, released), input),
    );
    await started.promise;
    expect(released).not.toHaveBeenCalled();
    if (event === "end") input.end();
    else if (event === "close") input.destroy();
    else input.destroy(new Error("owner pipe failed"));
    await result;
    expect(released).toHaveBeenCalledTimes(1);
    for (const name of ["end", "close", "error"]) expect(input.listenerCount(name)).toBe(0);
  });

  it("does not start when the owner pipe is already closed", async () => {
    const input = new PassThrough();
    input.destroy();
    const started = vi.fn();
    await Effect.runPromise(withDesktopParentLifetime(Effect.sync(started), input));
    expect(started).not.toHaveBeenCalled();
  });

  it("does not start when EOF was delivered before the watcher attached", async () => {
    const input = new PassThrough({ autoDestroy: false });
    const ended = once(input, "end");
    input.resume();
    input.end();
    await ended;
    expect(input.destroyed).toBe(false);
    const started = vi.fn();
    await Effect.runPromise(withDesktopParentLifetime(Effect.sync(started), input));
    expect(started).not.toHaveBeenCalled();
  });

  it("preserves signal-driven interruption while the owner remains alive", async () => {
    const input = new PassThrough();
    const started = Promise.withResolvers<void>();
    const released = vi.fn();
    const fiber = Effect.runFork(
      withDesktopParentLifetime(runningProgram(started.resolve, released), input),
    );
    await started.promise;
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(released).toHaveBeenCalledOnce();
    for (const name of ["end", "close", "error"]) expect(input.listenerCount(name)).toBe(0);
  });

  it("waits for resource finalizers before finishing parent-loss shutdown", async () => {
    const input = new PassThrough();
    const gate = Deferred.makeUnsafe<void>();
    const finalizing = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const completed = vi.fn();
    const program = Effect.acquireUseRelease(
      Effect.sync(started.resolve),
      () => Effect.never,
      () => Effect.sync(finalizing.resolve).pipe(Effect.andThen(Deferred.await(gate))),
    );
    const result = Effect.runPromise(withDesktopParentLifetime(program, input)).then(completed);
    await started.promise;
    input.end();
    await finalizing.promise;
    expect(completed).not.toHaveBeenCalled();
    Deferred.doneUnsafe(gate, Effect.void);
    await result;
    expect(completed).toHaveBeenCalledOnce();
  });

  it("preserves normal completion and failure while the owner stays alive", async () => {
    const input = new PassThrough();
    expect(await Effect.runPromise(withDesktopParentLifetime(Effect.succeed(42), input))).toBe(42);
    await expect(
      Effect.runPromise(withDesktopParentLifetime(Effect.fail("startup failed"), input)),
    ).rejects.toThrow("startup failed");
    expect(input.isPaused()).toBe(true);
    for (const name of ["end", "close", "error"]) expect(input.listenerCount(name)).toBe(0);
    expect(await Effect.runPromise(withDesktopParentLifetime(Effect.succeed(42), undefined))).toBe(42);
  });
});
