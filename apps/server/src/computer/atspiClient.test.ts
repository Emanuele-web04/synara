import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import type { ComputerWindow } from "@synara/contracts";

import { AtspiHelperClient } from "./atspiClient.ts";
import { DesktopOperationQueue } from "./DesktopOperationQueue.ts";

class FakeHelperProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn();
  killed = false;
}

const WINDOW: ComputerWindow = {
  id: "window-1",
  title: "Terminal",
  bounds: { x: 0, y: 0, width: 640, height: 480 },
  focused: true,
  minimized: false,
  visible: true,
};

describe("AtspiHelperClient", () => {
  it("ignores replies and errors from a helper replaced after a timeout", async () => {
    vi.useFakeTimers();
    const oldChild = new FakeHelperProcess();
    const child = new FakeHelperProcess();
    const ids: number[] = [];
    child.stdin.on("data", (chunk) => ids.push(JSON.parse(chunk.toString()).id));
    const spawnProcess = vi.fn().mockReturnValueOnce(oldChild).mockReturnValue(child);
    const client = new AtspiHelperClient({ requestTimeoutMs: 100, spawnProcess });
    try {
      const first = expect(client.readTrees([WINDOW])).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(100);
      await first;
      const second = client.setText({ window: WINDOW, path: [], text: "value" });
      let settled = false;
      void second.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(500);
      expect(ids).toHaveLength(1);

      oldChild.stdout.write(JSON.stringify({ id: ids[0], result: { ok: true } }) + "\n");
      oldChild.emit("error", new Error("late helper error"));
      for (const stream of [oldChild.stdin, oldChild.stdout, oldChild.stderr]) {
        stream.emit("error", new Error("late stream error"));
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      expect(child.kill).not.toHaveBeenCalled();

      child.stdout.write(JSON.stringify({ id: ids[0], result: { ok: false } }) + "\n");
      await expect(second).resolves.toBe(false);
      await vi.advanceTimersByTimeAsync(500);
      expect(oldChild.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      await client.dispose();
      vi.useRealTimers();
    }
  });

  it.each(["stdin", "stdout", "stderr"] as const)("contains an idle %s error", async (name) => {
    const child = scriptedHelper([], () => ({ trees: [] }));
    const client = new AtspiHelperClient({
      spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
    });
    try {
      await expect(client.readTrees([WINDOW])).resolves.toEqual([]);
      expect(() => child[name].emit("error", new Error("pipe failed"))).not.toThrow();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      await client.dispose();
    }
  });

  it("does not send a semantic write cancelled during helper restart", async () => {
    vi.useFakeTimers();
    const oldChild = new FakeHelperProcess();
    const child = scriptedHelper([], () => ({ ok: true }));
    const sent = vi.spyOn(child.stdin, "write");
    const spawnProcess = vi.fn().mockReturnValueOnce(oldChild).mockReturnValue(child);
    const client = new AtspiHelperClient({ requestTimeoutMs: 100, spawnProcess });
    const queue = new DesktopOperationQueue();
    const controller = new AbortController();
    try {
      const first = expect(client.readTrees([WINDOW])).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(100);
      await first;
      const write = queue.run(
        () => client.setText({ window: WINDOW, path: [], text: "value" }),
        controller.signal,
      );
      const rejected = expect(write).rejects.toThrow("cancelled");
      await vi.advanceTimersByTimeAsync(100);
      controller.abort(new Error("cancelled"));
      await vi.advanceTimersByTimeAsync(400);
      await rejected;
      expect(sent).not.toHaveBeenCalled();
    } finally {
      await client.dispose();
      await queue.close();
      vi.useRealTimers();
    }
  });

  it("starts the timeout only when the single-threaded helper can accept the next request", async () => {
    vi.useFakeTimers();
    const child = new FakeHelperProcess();
    const ids: number[] = [];
    child.stdin.on("data", (chunk) => ids.push(JSON.parse(chunk.toString()).id));
    const client = new AtspiHelperClient({
      requestTimeoutMs: 100,
      spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
    });
    try {
      const first = client.readTrees([WINDOW]);
      const second = client.readTrees([WINDOW]);
      await vi.advanceTimersByTimeAsync(80);
      expect(ids).toHaveLength(1);
      child.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id: ids[0], result: { trees: [] } }) + "\n",
      );
      await first;
      await vi.advanceTimersByTimeAsync(80);
      expect(ids).toHaveLength(2);
      expect(child.kill).not.toHaveBeenCalled();
      child.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id: ids[1], result: { trees: [] } }) + "\n",
      );
      await second;
    } finally {
      await client.dispose();
      vi.useRealTimers();
    }
  });

  it.each([null, ""])("transmits unlabeled node identity: %s", async (label) => {
    const requests: Array<Record<string, unknown>> = [];
    const child = scriptedHelper(requests, () => ({ ok: true }));
    const client = new AtspiHelperClient({
      spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
    });
    try {
      await client.setText({ window: WINDOW, path: [0], text: "value", label });
      expect(requests[0]?.params).toMatchObject({ label: "" });
    } finally {
      await client.dispose();
    }
  });
  it("starts the first helper request without the reconnect backoff", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeHelperProcess();
      child.stdin.on("data", (chunk) => {
        const message = JSON.parse(chunk.toString()) as { id: number | string };
        child.stdout.write(
          JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { trees: [] } }) + "\n",
        );
      });
      let spawned = false;
      const client = new AtspiHelperClient({
        spawnProcess: () => {
          spawned = true;
          return child as unknown as ChildProcessWithoutNullStreams;
        },
      });
      const request = client.readTrees([WINDOW]);

      await vi.advanceTimersByTimeAsync(0);
      expect(spawned).toBe(true);
      await vi.runAllTicks();
      await expect(request).resolves.toEqual([]);
      await client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("addresses a semantic write by window descriptor and child-index path", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const child = scriptedHelper(requests, () => ({ ok: true }));
    const client = new AtspiHelperClient({
      spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
    });

    await expect(
      client.setText({
        window: WINDOW,
        path: [2, 0],
        text: "héllo",
        role: "entry",
        label: "Name",
      }),
    ).resolves.toBe(true);
    expect(requests).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "set-text",
        params: {
          window: {
            id: "window-1",
            title: "Terminal",
            appName: null,
            pid: null,
            bounds: { x: 0, y: 0, width: 640, height: 480 },
          },
          path: [2, 0],
          text: "héllo",
          role: "entry",
          label: "Name",
        },
      },
    ]);

    await client.dispose();
  });

  it("reports a refused write as false rather than a failure", async () => {
    const child = scriptedHelper([], () => ({ ok: false, reason: "not-editable" }));
    const client = new AtspiHelperClient({
      spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
    });

    await expect(client.setText({ window: WINDOW, path: [], text: "x" })).resolves.toBe(false);

    await client.dispose();
  });

  it("propagates a helper error so the caller can fall back", async () => {
    const child = new FakeHelperProcess();
    child.stdin.on("data", (chunk) => {
      const message = JSON.parse(chunk.toString()) as { id: number | string };
      child.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: "no editable text interface" },
        }) + "\n",
      );
    });
    const client = new AtspiHelperClient({
      spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
    });

    await expect(client.setText({ window: WINDOW, path: [0], text: "x" })).rejects.toThrow(
      "no editable text interface",
    );

    await client.dispose();
  });

  /**
   * The helper answering "that window is gone" is routine — it is what a
   * semantic target that closed mid-walk looks like. Killing the process over
   * it respawned Python on every miss and pushed the reconnect backoff to five
   * seconds, so the next perception request paid for a refusal that had nothing
   * wrong with it.
   */
  it("keeps the helper alive when it reports an error instead of dying", async () => {
    let spawns = 0;
    const child = new FakeHelperProcess();
    child.stdin.on("data", (chunk) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        const message = JSON.parse(line) as { id: number | string; method: string };
        child.stdout.write(
          `${JSON.stringify(
            message.method === "read-tree"
              ? {
                  jsonrpc: "2.0",
                  id: message.id,
                  error: { code: -32000, message: "window closed" },
                }
              : { jsonrpc: "2.0", id: message.id, result: { ok: true } },
          )}\n`,
        );
      }
    });
    const client = new AtspiHelperClient({
      spawnProcess: () => {
        spawns += 1;
        return child as unknown as ChildProcessWithoutNullStreams;
      },
    });

    await expect(client.readTrees([WINDOW])).rejects.toThrow("window closed");
    expect(child.kill).not.toHaveBeenCalled();
    // The same process serves the next call, with no reconnect delay in front
    // of it — the request resolves without any timer being advanced.
    await expect(client.setText({ window: WINDOW, path: [0], text: "x" })).resolves.toBe(true);
    expect(spawns).toBe(1);

    await client.dispose();
  });

  it("still tears down the helper when the transport itself fails", async () => {
    const child = new FakeHelperProcess();
    // Never answers: the request times out, which is a dead transport, not a
    // refusal, and the process must be replaced.
    child.stdin.on("data", () => {});
    const client = new AtspiHelperClient({
      requestTimeoutMs: 5,
      spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
    });

    await expect(client.readTrees([WINDOW])).rejects.toThrow();
    expect(child.kill).toHaveBeenCalled();

    await client.dispose();
  });
});

/** A helper process that records every request and answers with one result. */
function scriptedHelper(
  requests: Array<Record<string, unknown>>,
  result: (request: Record<string, unknown>) => unknown,
): FakeHelperProcess {
  const child = new FakeHelperProcess();
  child.stdin.on("data", (chunk) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      const message = JSON.parse(line) as Record<string, unknown>;
      requests.push(message);
      child.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id: message.id, result: result(message) }) + "\n",
      );
    }
  });
  return child;
}
