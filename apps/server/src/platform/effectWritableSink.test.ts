// Exercises the compiled, installed dependency used by NodeStdio and child stdin.
import * as NodeSink from "@effect/platform-node/NodeSink";
import { Effect, Fiber, Stream } from "effect";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";

describe("Effect writable sink", () => {
  it.each([1, 1024])("returns asynchronous EPIPE at highWaterMark=%i", async (highWaterMark) => {
    const failure = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    const writable = new Writable({
      highWaterMark,
      write(_chunk, _encoding, callback) {
        setImmediate(() => callback(failure));
      },
    });
    // Keep the unfixed runtime's unhandled event from crashing the test runner.
    const observeError = () => {};
    writable.on("error", observeError);
    const result = await Effect.runPromise(
      Stream.run(
        Stream.make("chunk"),
        NodeSink.fromWritable({
          evaluate: () => writable,
          onError: (error) => error,
          endOnDone: false,
        }),
      ).pipe(Effect.timeout("250 millis"), Effect.flip),
    );
    expect(result).toBe(failure);
    expect(writable.listeners("error")).toEqual([observeError]);
    expect(writable.listenerCount("drain")).toBe(0);
    expect(writable.listenerCount("finish")).toBe(0);
  });

  it("waits for accepted asynchronous writes without ending a shared stream", async () => {
    const written: string[] = [];
    const writable = new Writable({
      write(chunk, _encoding, callback) {
        setImmediate(() => {
          written.push(chunk.toString());
          callback();
        });
      },
    });
    await Effect.runPromise(
      Stream.run(
        Stream.make("first", "second"),
        NodeSink.fromWritable({
          evaluate: () => writable,
          onError: (error) => error,
          endOnDone: false,
        }),
      ),
    );
    expect(written).toEqual(["first", "second"]);
    expect(writable.writableEnded).toBe(false);
    expect(writable.listenerCount("error")).toBe(0);
    writable.destroy();
  });

  it("fails when the pipe closes while waiting for upstream input", async () => {
    const failure = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    const writable = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    writable.on("error", () => {});
    const running = Effect.runPromise(
      Stream.run(
        Stream.never,
        NodeSink.fromWritable({
          evaluate: () => writable,
          onError: (error) => error,
          endOnDone: false,
        }),
      ).pipe(Effect.timeout("250 millis"), Effect.flip),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    writable.destroy(failure);
    expect(await running).toBe(failure);
  });

  it("returns errors while ending the stream", async () => {
    const failure = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    const writable = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
      final(callback) {
        setImmediate(() => callback(failure));
      },
    });
    const observeError = () => {};
    writable.on("error", observeError);
    const result = await Effect.runPromise(
      Stream.run(
        Stream.make("chunk"),
        NodeSink.fromWritable({
          evaluate: () => writable,
          onError: (error) => error,
        }),
      ).pipe(Effect.timeout("250 millis"), Effect.flip),
    );
    expect(result).toBe(failure);
    expect(writable.listenerCount("finish")).toBe(0);
    expect(writable.listeners("error")).toEqual([observeError]);
  });

  it("keeps pending end errors handled after cancellation", async () => {
    let completeEnd: ((error?: Error | null) => void) | undefined;
    const writable = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
      final(callback) {
        completeEnd = callback;
      },
    });
    const observeError = () => {};
    writable.on("error", observeError);
    const fiber = Effect.runFork(
      Stream.run(
        Stream.make("chunk"),
        NodeSink.fromWritable({
          evaluate: () => writable,
          onError: (error) => error,
        }),
      ),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(completeEnd).toBeDefined();
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(writable.listenerCount("finish")).toBe(0);
    expect(writable.listenerCount("error")).toBe(2);
    completeEnd!(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(writable.listeners("error")).toEqual([observeError]);
  });

  it("releases drain listeners on cancellation and handles an already pending write error", async () => {
    let completeWrite: ((error?: Error | null) => void) | undefined;
    const writable = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        completeWrite = callback;
      },
    });
    const observeError = () => {};
    writable.on("error", observeError);
    const fiber = Effect.runFork(
      Stream.run(
        Stream.make("chunk"),
        NodeSink.fromWritable({
          evaluate: () => writable,
          onError: (error) => error,
          endOnDone: false,
        }),
      ),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(completeWrite).toBeDefined();
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(writable.listenerCount("drain")).toBe(0);
    expect(writable.listenerCount("error")).toBe(2);
    completeWrite!(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(writable.listeners("error")).toEqual([observeError]);
  });
});
