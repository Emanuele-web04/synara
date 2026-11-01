import type * as ChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import type { CuaPreviewTarget } from "@synara/shared/cuaDriverProtocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ComputerFrameTap } from "./computerFrameTap";

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

const target: CuaPreviewTarget = {
  task: { threadId: "thread-frame-tap", turnId: "turn-1" },
  pid: 4242,
  windowId: 77,
};

const taps: ComputerFrameTap[] = [];

function createTap() {
  const children: FakeChild[] = [];
  const spawn = vi.fn((_command: string, _args: readonly string[]) => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => {
      queueMicrotask(() => {
        child.emit("exit", null, "SIGTERM");
        child.emit("close", null, "SIGTERM");
      });
      return true;
    });
    children.push(child);
    return child as unknown as ChildProcess.ChildProcess;
  });
  const onError = vi.fn();
  const tap = new ComputerFrameTap({
    helperPath: "/nonexistent/appsnap-helper",
    send: vi.fn(),
    onError,
    spawn: spawn as unknown as typeof ChildProcess.spawn,
  });
  taps.push(tap);
  return { tap, spawn, children, onError };
}

afterEach(async () => {
  for (const tap of taps.splice(0)) await tap.dispose();
});

describe("ComputerFrameTap", () => {
  it("spawns the capture helper only while a preview is subscribed", async () => {
    const { tap, spawn, children, onError } = createTap();

    tap.update(target);
    // Give the reconcile loop a chance to run; nothing consumes frames yet.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spawn).not.toHaveBeenCalled();

    tap.setSubscribed(true);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    expect(spawn.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(["--computer-frames", "--window-id", "77", "--pid", "4242"]),
    );

    tap.setSubscribed(false);
    await vi.waitFor(() => expect(children[0]?.kill).toHaveBeenCalledWith("SIGTERM"));

    // An unsubscribe retires the helper without poisoning its target.
    tap.setSubscribed(true);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not spawn for a subscriber without a target and stops with the task", async () => {
    const { tap, spawn, children } = createTap();

    tap.setSubscribed(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spawn).not.toHaveBeenCalled();

    tap.update(target);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));

    await tap.endTask(target.task);
    expect(children[0]?.kill).toHaveBeenCalledWith("SIGTERM");

    tap.setSubscribed(false);
    tap.setSubscribed(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
