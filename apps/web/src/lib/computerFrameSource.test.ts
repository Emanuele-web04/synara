import type { ComputerId } from "@synara/contracts";
import { encodeComputerFrame } from "@synara/shared/computerFrame";
import { describe, expect, it, vi } from "vitest";

import { createComputerFrameSource, type WebSocketLike } from "./computerFrameSource";

const COMPUTER_ID = "desktop" as ComputerId;
const EXPLICIT_URL = "ws://127.0.0.1:4321";
type Listener = (event: never) => void;

function createFakeSocket() {
  const listeners = new Map<string, Listener[]>();
  const close = vi.fn();
  const send = vi.fn();
  const socket: WebSocketLike & { emit: (type: string, event: unknown) => void } = {
    binaryType: "blob",
    close,
    send,
    addEventListener: (type, listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    emit: (type, event) => {
      for (const listener of listeners.get(type) ?? []) {
        (listener as (event: unknown) => void)(event);
      }
    },
  };
  return { socket, close, send };
}

function frameBytes(sequence: number) {
  return encodeComputerFrame({
    header: {
      computerId: COMPUTER_ID,
      sequence,
      timestampMs: 1_000,
      keyframe: true,
      codecConfig: false,
    },
    payload: new Uint8Array([1, 2, 3]),
  });
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe("computer frame socket url", () => {
  it("targets the computer frame route and query parameter", () => {
    const { socket } = createFakeSocket();
    let requested = "";
    createComputerFrameSource({
      computerId: COMPUTER_ID,
      explicitUrl: EXPLICIT_URL,
      handlers: { onFrame: vi.fn(), onReset: vi.fn() },
      createSocket: (url) => {
        requested = url;
        return socket;
      },
    });
    const url = new URL(requested);
    expect(url.pathname).toBe("/ws/computer-frames");
    expect(url.searchParams.get("computerId")).toBe(COMPUTER_ID);
  });
});

describe("createComputerFrameSource", () => {
  function subscribe() {
    const { socket, close, send } = createFakeSocket();
    const onFrame = vi.fn();
    const onReset = vi.fn();
    const source = createComputerFrameSource({
      computerId: COMPUTER_ID,
      explicitUrl: EXPLICIT_URL,
      handlers: { onFrame, onReset },
      createSocket: () => socket,
    });
    return { socket, close, send, onFrame, onReset, source };
  }

  it("pins binary delivery and decodes PNG envelopes", () => {
    const { socket, onFrame } = subscribe();
    expect(socket.binaryType).toBe("arraybuffer");
    socket.emit("message", { data: toArrayBuffer(frameBytes(7)) });
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame.mock.calls[0]?.[0].header.computerId).toBe(COMPUTER_ID);
    expect(onFrame.mock.calls[0]?.[0].header.sequence).toBe(7);
    expect([...onFrame.mock.calls[0]?.[0].payload]).toEqual([1, 2, 3]);
  });

  it("defers a resync until the socket opens", () => {
    const { socket, send, source } = subscribe();
    expect(source.requestResync()).toBe(false);
    socket.emit("open", {});
    expect(send).toHaveBeenCalledWith(JSON.stringify({ type: "computer.frame.resync" }));
  });
});
