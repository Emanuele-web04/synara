import { EventEmitter } from "node:events";
import { lstat, unlink } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearStaleCuaHostSocket } from "./cuaHostSocket";

vi.mock("node:fs/promises", () => ({ lstat: vi.fn(), unlink: vi.fn() }));
vi.mock("node:net", () => ({ createConnection: vi.fn() }));

const endpoint = "/fixture/cua-host.sock";
const identity = (ino = 1, isSocket = true, uid = process.getuid?.() ?? 0) =>
  ({ dev: 1, ino, uid, isSocket: () => isSocket }) as unknown as Awaited<ReturnType<typeof lstat>>;

function connection(outcome: "connect" | "timeout" | NodeJS.ErrnoException): void {
  vi.mocked(createConnection).mockImplementation(() => {
    const socket = new EventEmitter() as Socket;
    socket.destroy = vi.fn(() => socket);
    socket.setTimeout = vi.fn((_ms, callback) => {
      if (outcome === "timeout") queueMicrotask(() => callback?.());
      return socket;
    });
    if (outcome !== "timeout")
      queueMicrotask(() => {
        if (outcome === "connect") socket.emit("connect");
        else socket.emit("error", outcome);
      });
    return socket;
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(lstat).mockResolvedValue(identity());
  vi.mocked(unlink).mockResolvedValue(undefined);
});

describe("standalone host socket startup", () => {
  it("does not probe or remove a missing endpoint", async () => {
    vi.mocked(lstat).mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    await clearStaleCuaHostSocket(endpoint, "linux");
    expect(createConnection).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
  });

  it("preserves ordinary files and symlinks instead of treating them as stale sockets", async () => {
    vi.mocked(lstat).mockResolvedValue(identity(1, false));
    await expect(clearStaleCuaHostSocket(endpoint, "linux")).rejects.toThrow("non-socket");
    expect(createConnection).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
  });

  it("does not delete another user's socket", async () => {
    vi.mocked(lstat).mockResolvedValue(identity(1, true, (process.getuid?.() ?? 0) + 1));
    if (!process.getuid) return;
    await expect(clearStaleCuaHostSocket(endpoint, "linux")).rejects.toThrow("another user");
    expect(createConnection).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
  });

  it("preserves a live listener", async () => {
    connection("connect");
    await expect(clearStaleCuaHostSocket(endpoint, "linux")).rejects.toThrow("live host");
    expect(unlink).not.toHaveBeenCalled();
  });

  it("replaces an unchanged socket only after a refused connection", async () => {
    connection(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));
    await clearStaleCuaHostSocket(endpoint, "linux");
    expect(lstat).toHaveBeenCalledTimes(2);
    expect(unlink).toHaveBeenCalledExactlyOnceWith(endpoint);
  });

  it("preserves the endpoint when the probe is inconclusive", async () => {
    connection("timeout");
    await expect(clearStaleCuaHostSocket(endpoint, "linux")).rejects.toThrow("Could not determine");
    expect(unlink).not.toHaveBeenCalled();
  });

  it("does not interpret access errors as a stale socket", async () => {
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    connection(denied);
    await expect(clearStaleCuaHostSocket(endpoint, "linux")).rejects.toBe(denied);
    expect(unlink).not.toHaveBeenCalled();
  });

  it("preserves a replacement socket that appeared during the probe", async () => {
    vi.mocked(lstat).mockResolvedValueOnce(identity()).mockResolvedValueOnce(identity(2));
    connection(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));
    await expect(clearStaleCuaHostSocket(endpoint, "linux")).rejects.toThrow("socket changed");
    expect(unlink).not.toHaveBeenCalled();
  });

  it("does not touch the path if the original listener removed it while being probed", async () => {
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    vi.mocked(lstat).mockResolvedValueOnce(identity()).mockRejectedValueOnce(missing);
    connection(missing);
    await clearStaleCuaHostSocket(endpoint, "linux");
    expect(unlink).not.toHaveBeenCalled();
  });

  it("does not remove a socket that reappeared after a missing-endpoint response", async () => {
    connection(Object.assign(new Error("missing"), { code: "ENOENT" }));
    await expect(clearStaleCuaHostSocket(endpoint, "linux")).rejects.toThrow("socket changed");
    expect(unlink).not.toHaveBeenCalled();
  });

  it("does not apply Unix socket cleanup to Windows named pipes", async () => {
    await clearStaleCuaHostSocket("\\\\.\\pipe\\cua-host", "win32");
    expect(lstat).not.toHaveBeenCalled();
    expect(createConnection).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
  });
});
