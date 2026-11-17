import type * as ChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { PassThrough } from "node:stream";

import type { CuaPreviewTarget } from "@synara/shared/cuaDriverProtocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ComputerFrameTap, type ComputerPreviewFrame } from "./computerFrameTap";

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
  const send = vi.fn<(channel: string, frame: ComputerPreviewFrame) => void>();
  const tap = new ComputerFrameTap({
    helperPath: "/nonexistent/appsnap-helper",
    send,
    onError,
    spawn: spawn as unknown as typeof ChildProcess.spawn,
  });
  taps.push(tap);
  return { tap, spawn, children, onError, send };
}

async function startAttachedTap() {
  const result = createTap();
  result.tap.update(target);
  result.tap.setSubscribed(true);
  await vi.waitFor(() => expect(result.spawn).toHaveBeenCalledTimes(1));
  // Feed exact socket chunks through the real handler, independent of OS coalescing.
  const connect = () => {
    const socket = new EventEmitter() as Socket;
    socket.destroy = vi.fn(() => {
      socket.emit("close");
      return socket;
    });
    result.tap["attach"](result.tap["active"]!, socket);
    return socket;
  };
  return { ...result, connect, socket: connect() };
}

function frame(payload: Buffer): Buffer {
  const wire = Buffer.alloc(4 + payload.length);
  wire.writeUInt32LE(payload.length);
  payload.copy(wire, 4);
  return wire;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const tap of taps.splice(0)) await tap.dispose();
});

describe("ComputerFrameTap", () => {
  it.each([
    [17, 1],
    [31, 3],
    [4 * 1024 * 1024, 64 * 1024],
    [31, Infinity],
  ])(
    "delivers a %i-byte frame in %s-byte chunks with at most one copy",
    async (size, chunkSize) => {
      const { socket, send, onError } = await startAttachedTap();
      const payload = Buffer.alloc(size, 0xa7);
      const wire = frame(payload);
      const concat = vi.spyOn(Buffer, "concat");
      for (let offset = 0; offset < wire.length; offset += chunkSize) {
        socket.emit("data", wire.subarray(offset, offset + chunkSize));
      }
      const joins = concat.mock.calls.length;
      concat.mockRestore();
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]![1]).toMatchObject({ windowId: target.windowId, seq: 1 });
      expect(payload.equals(send.mock.calls[0]![1].jpeg)).toBe(true);
      expect(joins).toBe(chunkSize === Infinity ? 0 : 1);
      if (chunkSize === Infinity) expect(send.mock.calls[0]![1].jpeg.buffer).toBe(wire.buffer);
      expect(onError).not.toHaveBeenCalled();
    },
  );

  it("preserves coalesced frames and an incomplete trailing frame across empty reads", async () => {
    const { socket, send } = await startAttachedTap();
    const payloads = [Buffer.from([1, 2, 3]), Buffer.from("next"), Buffer.from([4, 5])];
    const wire = Buffer.concat(payloads.map(frame));
    socket.emit("data", wire.subarray(0, 9));
    expect(send).toHaveBeenCalledTimes(1);
    socket.emit("data", wire.subarray(9, -1));
    socket.emit("data", Buffer.alloc(0));
    expect(send).toHaveBeenCalledTimes(2);
    socket.emit("data", wire.subarray(-1));
    expect(send.mock.calls.map(([, value]) => value.jpeg)).toEqual(payloads);
    expect(send.mock.calls.map(([, value]) => value.seq)).toEqual([1, 2, 3]);
  });

  it.each([
    [0, 1],
    [0, 4],
    [4 * 1024 * 1024 + 1, 1],
    [4 * 1024 * 1024 + 1, 4],
  ])("rejects invalid length %i in %i-byte chunks", async (length, chunkSize) => {
    const { socket, send, onError } = await startAttachedTap();
    const header = Buffer.alloc(4);
    header.writeUInt32LE(length);
    for (let offset = 0; offset < header.length; offset += chunkSize) {
      socket.emit("data", header.subarray(offset, offset + chunkSize));
    }
    await vi.waitFor(() => expect(socket.destroy).toHaveBeenCalled());
    expect(onError).toHaveBeenCalledWith(new Error("Computer frame tap sent a malformed frame."));
    expect(send).not.toHaveBeenCalled();
  });

  it("discards an incomplete frame on close before a replacement connection", async () => {
    const { socket, connect, send, onError } = await startAttachedTap();
    socket.emit("data", frame(Buffer.from("unfinished")).subarray(0, 6));
    socket.destroy();
    connect().emit("data", frame(Buffer.from("replacement")));
    expect(send.mock.calls.map(([, value]) => value.jpeg)).toEqual([Buffer.from("replacement")]);
    expect(onError).not.toHaveBeenCalled();
  });

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
