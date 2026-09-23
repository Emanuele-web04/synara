import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import type { ComputerWindow } from "@synara/contracts";

import {
  ATSPI_HELPER_PROTOCOL,
  AtspiHelperClient,
  AtspiHelperUnavailableError,
  atspiHelperEnvironment,
} from "./atspiClient.ts";
import { DesktopOperationQueue } from "./DesktopOperationQueue.ts";

class FakeHelperProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn();
  killed = false;
}

const EMPTY_TREES = { protocol: ATSPI_HELPER_PROTOCOL, trees: [] };
const PROBE_OK = { ok: true, protocol: ATSPI_HELPER_PROTOCOL, atspi: true, reason: null };

const WINDOW: ComputerWindow = {
  id: "window-1",
  title: "Terminal",
  bounds: { x: 0, y: 0, width: 640, height: 480 },
  focused: true,
  minimized: false,
  visible: true,
};

describe("AtspiHelperClient", () => {
  it("stops an idle helper on release and starts a fresh one on the next request", async () => {
    const children: FakeHelperProcess[] = [];
    const spawnProcess = vi.fn(() => {
      const child = new FakeHelperProcess();
      child.stdin.on("data", (chunk) => {
        const { id } = JSON.parse(chunk.toString()) as { id: number };
        child.stdout.write(`${JSON.stringify({ id, result: EMPTY_TREES })}\n`);
      });
      children.push(child);
      return child as unknown as ChildProcessWithoutNullStreams;
    });
    const client = new AtspiHelperClient({ requestTimeoutMs: 1_000, spawnProcess });
    try {
      await expect(client.readTrees([WINDOW])).resolves.toEqual([]);
      await client.release();
      expect(children[0]!.stdin.writableEnded).toBe(true);
      // The released helper's exit is ours, not a crash: nothing latches.
      children[0]!.emit("exit", null, "SIGTERM");
      expect(client.unavailableReason()).toBeUndefined();

      await expect(client.readTrees([WINDOW])).resolves.toEqual([]);
      expect(spawnProcess).toHaveBeenCalledTimes(2);
    } finally {
      await client.dispose();
    }
  });

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
    const child = scriptedHelper([], () => EMPTY_TREES);
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
        JSON.stringify({ jsonrpc: "2.0", id: ids[0], result: EMPTY_TREES }) + "\n",
      );
      await first;
      await vi.advanceTimersByTimeAsync(80);
      expect(ids).toHaveLength(2);
      expect(child.kill).not.toHaveBeenCalled();
      child.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id: ids[1], result: EMPTY_TREES }) + "\n",
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
          JSON.stringify({ jsonrpc: "2.0", id: message.id, result: EMPTY_TREES }) + "\n",
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
          protocol: ATSPI_HELPER_PROTOCOL,
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
    // A timeout is transient: the next request may still spawn a helper.
    expect(client.unavailableReason()).toBeUndefined();

    await client.dispose();
  });

  it("accepts a partial reply as a normal response from a healthy helper", async () => {
    const tree = {
      windowId: WINDOW.id,
      clientSize: { width: 640, height: 480 },
      root: {
        role: "frame",
        label: "Terminal",
        value: null,
        description: null,
        frame: { x: 0, y: 0, width: 640, height: 480 },
        editable: false,
        children: [],
      },
    };
    let spawns = 0;
    const child = scriptedHelper([], () => ({
      protocol: ATSPI_HELPER_PROTOCOL,
      trees: [tree],
      partial: true,
    }));
    const client = new AtspiHelperClient({
      spawnProcess: () => {
        spawns += 1;
        return child as unknown as ChildProcessWithoutNullStreams;
      },
    });
    try {
      await expect(client.readTrees([WINDOW])).resolves.toEqual([tree]);
      await expect(client.readTrees([WINDOW])).resolves.toEqual([tree]);
      expect(child.kill).not.toHaveBeenCalled();
      expect(spawns).toBe(1);
      expect(client.unavailableReason()).toBeUndefined();
    } finally {
      await client.dispose();
    }
  });

  /**
   * A machine without python3 fails every spawn the same way. Before the
   * latch, every tree read paid the spawn plus up to five seconds of backoff
   * to rediscover that, and the reason was never surfaced.
   */
  it("latches unavailable after a spawn failure until probed again", async () => {
    vi.useFakeTimers();
    let spawns = 0;
    let helper: FakeHelperProcess = failingSpawn("ENOENT");
    const client = new AtspiHelperClient({
      spawnProcess: () => {
        spawns += 1;
        return helper as unknown as ChildProcessWithoutNullStreams;
      },
    });
    try {
      await expect(client.readTrees([WINDOW])).rejects.toThrow();
      expect(client.unavailableReason()).toContain("ENOENT");

      // Fake timers: had either call waited on a reconnect backoff or a
      // request timeout it would never settle here.
      await expect(client.readTrees([WINDOW])).rejects.toThrow(AtspiHelperUnavailableError);
      await expect(client.readTrees([WINDOW])).rejects.toThrow("ENOENT");
      await expect(client.setText({ window: WINDOW, path: [0], text: "x" })).resolves.toBe(false);
      expect(spawns).toBe(1);

      helper = scriptedHelper([], () => PROBE_OK);
      await client.probe();
      expect(client.unavailableReason()).toBeUndefined();
      expect(spawns).toBe(2);
      helper.stdin.removeAllListeners("data");
      helper.stdin.on("data", (chunk) => {
        const message = JSON.parse(chunk.toString()) as { id: number };
        helper.stdout.write(JSON.stringify({ id: message.id, result: EMPTY_TREES }) + "\n");
      });
      await expect(client.readTrees([WINDOW])).resolves.toEqual([]);
      expect(spawns).toBe(2);
    } finally {
      await client.dispose();
      vi.useRealTimers();
    }
  });

  it("latches unavailable with the stderr tail when the helper dies before answering", async () => {
    vi.useFakeTimers();
    let spawns = 0;
    const child = new FakeHelperProcess();
    child.stdin.on("data", () => {
      child.stderr.write("Traceback (most recent call last):\n");
      child.stderr.write("ModuleNotFoundError: No module named 'gi'\n");
      child.emit("exit", 1, null);
    });
    const client = new AtspiHelperClient({
      spawnProcess: () => {
        spawns += 1;
        return child as unknown as ChildProcessWithoutNullStreams;
      },
    });
    try {
      await expect(client.readTrees([WINDOW])).rejects.toThrow("ModuleNotFoundError");
      expect(client.unavailableReason()).toContain("No module named 'gi'");
      await expect(client.readTrees([WINDOW])).rejects.toThrow(AtspiHelperUnavailableError);
      await expect(client.setText({ window: WINDOW, path: [0], text: "x" })).resolves.toBe(false);
      expect(spawns).toBe(1);
    } finally {
      await client.dispose();
      vi.useRealTimers();
    }
  });

  it("keeps only a bounded tail of stderr", async () => {
    const child = new FakeHelperProcess();
    child.stdin.on("data", () => {
      child.stderr.write("a".repeat(64 * 1024));
      child.stderr.write("\nlast line\n");
      child.emit("exit", 2, null);
    });
    const client = new AtspiHelperClient({
      spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
    });
    try {
      await expect(client.readTrees([WINDOW])).rejects.toThrow("last line");
      const reason = client.unavailableReason();
      expect(reason).toContain("last line");
      expect(reason!.length).toBeLessThan(5 * 1024);
    } finally {
      await client.dispose();
    }
  });

  it("does not latch on a helper that dies after it has answered", async () => {
    vi.useFakeTimers();
    let spawns = 0;
    const first = scriptedHelper([], () => EMPTY_TREES);
    const second = scriptedHelper([], () => EMPTY_TREES);
    const client = new AtspiHelperClient({
      spawnProcess: () => {
        spawns += 1;
        return (spawns === 1 ? first : second) as unknown as ChildProcessWithoutNullStreams;
      },
    });
    try {
      await expect(client.readTrees([WINDOW])).resolves.toEqual([]);
      first.emit("exit", 1, null);
      expect(client.unavailableReason()).toBeUndefined();
      const next = client.readTrees([WINDOW]);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(next).resolves.toEqual([]);
      expect(spawns).toBe(2);
    } finally {
      await client.dispose();
      vi.useRealTimers();
    }
  });

  it("latches unavailable when the probe reports no AT-SPI bindings", async () => {
    vi.useFakeTimers();
    let spawns = 0;
    let atspi = false;
    const child = scriptedHelper([], () => ({
      ok: true,
      protocol: ATSPI_HELPER_PROTOCOL,
      atspi,
      reason: atspi ? null : "gi",
    }));
    const client = new AtspiHelperClient({
      spawnProcess: () => {
        spawns += 1;
        return child as unknown as ChildProcessWithoutNullStreams;
      },
    });
    try {
      await client.probe();
      expect(client.unavailableReason()).toContain("gi");
      await expect(client.readTrees([WINDOW])).rejects.toThrow(AtspiHelperUnavailableError);
      await expect(client.setText({ window: WINDOW, path: [0], text: "x" })).resolves.toBe(false);
      // The helper answered, so it stays; only the latch stops the requests.
      expect(child.kill).not.toHaveBeenCalled();

      atspi = true;
      await client.probe();
      expect(client.unavailableReason()).toBeUndefined();
      expect(spawns).toBe(1);
    } finally {
      await client.dispose();
      vi.useRealTimers();
    }
  });

  it("runs one probe for concurrent callers and refuses a helper without the probe", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const child = new FakeHelperProcess();
    child.stdin.on("data", (chunk) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        const message = JSON.parse(line) as Record<string, unknown>;
        requests.push(message);
        child.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32000, message: "Unknown AT-SPI helper method" },
          }) + "\n",
        );
      }
    });
    const client = new AtspiHelperClient({
      spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
    });
    try {
      await Promise.all([client.probe(), client.probe()]);
      expect(requests.map((request) => request.method)).toEqual(["probe"]);
      // A helper that cannot answer the probe is not the build this client
      // speaks to; reading its trees would be a guess.
      expect(client.unavailableReason()).toContain("probe failed");
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      await client.dispose();
    }
  });
});

describe("AtspiHelperClient availability", () => {
  /**
   * R1: libatspi aborted the helper on an unreachable accessibility bus, and
   * every read respawned it into the same abort — a core dump and a crash
   * notification each time. A signal before the first tree now latches.
   */
  it("latches a helper killed by a signal before its first tree, with a retry window", async () => {
    let now = 0;
    let spawns = 0;
    const helpers: FakeHelperProcess[] = [];
    const client = new AtspiHelperClient({
      now: () => now,
      spawnProcess: () => {
        spawns += 1;
        const child = new FakeHelperProcess();
        child.stdin.on("data", (chunk) => {
          for (const line of chunk.toString().split("\n").filter(Boolean)) {
            const message = JSON.parse(line) as { id: number; method: string };
            if (message.method === "probe") {
              child.stdout.write(`${JSON.stringify({ id: message.id, result: PROBE_OK })}\n`);
            } else {
              child.stderr.write("dbind-ERROR **: AT-SPI: Couldn't connect to accessibility bus\n");
              child.emit("exit", null, "SIGABRT");
            }
          }
        });
        helpers.push(child);
        return child as unknown as ChildProcessWithoutNullStreams;
      },
    });
    try {
      await client.probe();
      await expect(client.readTrees([WINDOW])).rejects.toThrow("SIGABRT");
      expect(client.unavailableReason()).toContain("dbind-ERROR");
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await expect(client.readTrees([WINDOW])).rejects.toThrow(AtspiHelperUnavailableError);
      }
      expect(spawns).toBe(1);

      // Past the retry window one request looks again — and the same crash
      // latches again for twice as long.
      now += 30_000;
      expect(client.unavailableReason()).toBeUndefined();
      await expect(client.readTrees([WINDOW])).rejects.toThrow();
      await expect(client.readTrees([WINDOW])).rejects.toThrow();
      expect(spawns).toBe(2);
      now += 30_000;
      await expect(client.readTrees([WINDOW])).rejects.toThrow(AtspiHelperUnavailableError);
      expect(spawns).toBe(2);
    } finally {
      await client.dispose();
    }
  });

  it("latches an unreachable accessibility bus without killing the helper", async () => {
    let now = 0;
    const requests: Array<Record<string, unknown>> = [];
    const child = new FakeHelperProcess();
    child.stdin.on("data", (chunk) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        const message = JSON.parse(line) as { id: number };
        requests.push(message);
        child.stdout.write(
          `${JSON.stringify({
            id: message.id,
            error: { code: -32010, message: "org.a11y.Bus is not running" },
          })}\n`,
        );
      }
    });
    const client = new AtspiHelperClient({
      now: () => now,
      spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
    });
    try {
      await expect(client.readTrees([WINDOW])).rejects.toThrow(AtspiHelperUnavailableError);
      expect(client.unavailableReason()).toContain("org.a11y.Bus is not running");
      await expect(client.setText({ window: WINDOW, path: [0], text: "x" })).resolves.toBe(false);
      await expect(
        client.validateNode({ window: WINDOW, path: [0], role: "entry", label: "Name" }),
      ).resolves.toEqual({ ok: false, reason: "unavailable" });
      expect(requests).toHaveLength(1);
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      await client.dispose();
    }
  });

  it("refuses trees from a helper that speaks another protocol", async () => {
    const child = scriptedHelper([], () => ({ trees: [] }));
    const client = new AtspiHelperClient({
      spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
    });
    try {
      await expect(client.readTrees([WINDOW])).rejects.toThrow(AtspiHelperUnavailableError);
      expect(client.unavailableReason()).toContain("protocol");
    } finally {
      await client.dispose();
    }
  });

  it("latches a probe from an older helper as a protocol mismatch", async () => {
    const child = scriptedHelper([], () => ({ ok: true, atspi: true, reason: null }));
    const client = new AtspiHelperClient({
      spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
    });
    try {
      await client.probe();
      expect(client.unavailableReason()).toContain(`needs ${ATSPI_HELPER_PROTOCOL}`);
    } finally {
      await client.dispose();
    }
  });
});

describe("AtspiHelperClient requests", () => {
  it("asks for a cached tree only with an age the caller allows", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const child = scriptedHelper(requests, () => EMPTY_TREES);
    const client = new AtspiHelperClient({
      spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
    });
    try {
      await client.readTrees([WINDOW], { maxAgeMs: 2_500.4 });
      await client.readTrees([WINDOW], { maxAgeMs: 0 });
      expect(requests.map((request) => request.params)).toEqual([
        expect.objectContaining({ protocol: ATSPI_HELPER_PROTOCOL, maxAgeMs: 2_500 }),
        expect.not.objectContaining({ maxAgeMs: expect.anything() }),
      ]);
    } finally {
      await client.dispose();
    }
  });

  it("validates a node and returns its fresh extents", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const child = scriptedHelper(requests, () => ({
      ok: true,
      frame: { x: 1, y: 2, width: 3, height: 4 },
      clientSize: { width: 640, height: 480 },
      showing: true,
    }));
    const client = new AtspiHelperClient({
      spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
    });
    try {
      await expect(
        client.validateNode({ window: WINDOW, path: [2, 0], role: "button", label: null }),
      ).resolves.toEqual({
        ok: true,
        frame: { x: 1, y: 2, width: 3, height: 4 },
        clientSize: { width: 640, height: 480 },
        showing: true,
      });
      expect(requests[0]).toMatchObject({
        method: "validate-node",
        params: { protocol: ATSPI_HELPER_PROTOCOL, path: [2, 0], role: "button", label: "" },
      });
    } finally {
      await client.dispose();
    }
  });

  /**
   * One helper, one request at a time: a write or a one-window read queued
   * behind a desktop-wide walk used to wait for all of it, and for every
   * other desktop-wide walk queued before it.
   */
  it("serves writes and scoped reads before queued desktop-wide reads", async () => {
    const child = new FakeHelperProcess();
    const methods: string[] = [];
    const pending: Array<{ id: number; method: string }> = [];
    child.stdin.on("data", (chunk) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        const message = JSON.parse(line) as {
          id: number;
          method: string;
          params: Record<string, unknown>;
        };
        methods.push(
          message.method === "read-tree"
            ? `read-tree:${(message.params.windows as unknown[]).length}`
            : message.method,
        );
        pending.push(message);
      }
    });
    const answer = () => {
      const message = pending.shift()!;
      child.stdout.write(
        `${JSON.stringify({
          id: message.id,
          result: message.method === "read-tree" ? EMPTY_TREES : { ok: true },
        })}\n`,
      );
    };
    const client = new AtspiHelperClient({
      spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
    });
    const other = { ...WINDOW, id: "window-2" };
    try {
      const first = client.readTrees([WINDOW, other]);
      await vi.waitFor(() => expect(methods).toHaveLength(1));
      const second = client.readTrees([WINDOW, other]);
      const write = client.setText({ window: WINDOW, path: [0], text: "x" });
      const scoped = client.readTrees([WINDOW]);
      for (let index = 0; index < 4; index += 1) {
        await vi.waitFor(() => expect(pending).toHaveLength(1));
        answer();
      }
      await Promise.all([first, second, write, scoped]);
      expect(methods).toEqual(["read-tree:2", "set-text", "read-tree:1", "read-tree:2"]);
    } finally {
      await client.dispose();
    }
  });
});

/** A child whose spawn fails asynchronously, the way node reports ENOENT. */
function failingSpawn(code: string): FakeHelperProcess {
  const child = new FakeHelperProcess();
  process.nextTick(() => {
    child.emit("error", Object.assign(new Error(`spawn python3 ${code}`), { code }));
  });
  return child;
}

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

describe("atspiHelperEnvironment", () => {
  const server = {
    PATH: "/usr/bin",
    AT_SPI_BUS_ADDRESS: "unix:path=/run/user/1000/at-spi/bus_1",
    SYNARA_AUTH_TOKEN: "secret",
  };

  it("layers the overrides on the server's environment by default", () => {
    expect(
      atspiHelperEnvironment({ env: { DBUS_SESSION_BUS_ADDRESS: "unix:abstract=x" } }, server),
    ).toEqual({ ...server, DBUS_SESSION_BUS_ADDRESS: "unix:abstract=x", PYTHONUNBUFFERED: "1" });
  });

  it("gives exactly the overrides when told not to inherit, host accessibility bus included", () => {
    const env = atspiHelperEnvironment(
      { env: { PATH: "/usr/bin", DBUS_SESSION_BUS_ADDRESS: "unix:abstract=x" }, inheritEnv: false },
      server,
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      DBUS_SESSION_BUS_ADDRESS: "unix:abstract=x",
      PYTHONUNBUFFERED: "1",
    });
  });
});
