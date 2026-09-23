import { describe, expect, it } from "vitest";

import {
  wlClipboardToolsPresent,
  spawnClipboardCommand,
  writeWlClipboardForPaste,
  type ClipboardCommandResult,
  type ClipboardCommandSpec,
} from "./wlClipboard.ts";

/**
 * The process primitive is exercised against real children, because everything
 * it has to get right — a forking child that keeps stderr open, a kill on the
 * output cap, a kill on the deadline — only happens with real pipes. Node runs
 * the children so the suite depends on nothing but the runtime it already has.
 */
function node(source: string, options: Partial<ClipboardCommandSpec> = {}) {
  return spawnClipboardCommand({
    command: process.execPath,
    args: ["-e", source],
    ...options,
  });
}

describe("spawnClipboardCommand", () => {
  it("hands wl-clipboard the desktop's environment and none of the server's secrets", async () => {
    const saved = process.env.SYNARA_AUTH_TOKEN;
    process.env.SYNARA_AUTH_TOKEN = "server-secret";
    try {
      const result = await spawnClipboardCommand(
        {
          command: process.execPath,
          args: [
            "-e",
            "process.stdout.write(JSON.stringify([process.env.SYNARA_AUTH_TOKEN ?? null, process.env.WAYLAND_DISPLAY ?? null]))",
          ],
        },
        { WAYLAND_DISPLAY: "nested-0" },
      );
      expect(JSON.parse(result.stdout)).toEqual([null, "nested-0"]);
    } finally {
      if (saved === undefined) delete process.env.SYNARA_AUTH_TOKEN;
      else process.env.SYNARA_AUTH_TOKEN = saved;
    }
  });

  it("settles with bounded diagnostics when stderr exceeds its limit", async () => {
    const result = await node("process.stderr.write('x'.repeat(20000)); process.exitCode=1");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("diagnostic truncated");
    expect(result.stderr.length).toBeLessThan(8300);
  });
  it("collects output and the exit status of a command that does not fork", async () => {
    await expect(
      node("process.stdout.write('paste me'); process.stderr.write('noise'); process.exit(3)"),
    ).resolves.toEqual({ outcome: "exited", code: 3, stdout: "paste me", stderr: "noise" });
  });

  it("feeds the payload through stdin", async () => {
    const input = "line one\nline two";
    await expect(node("process.stdin.pipe(process.stdout)", { input })).resolves.toMatchObject({
      outcome: "exited",
      code: 0,
      stdout: input,
    });
  });

  /**
   * wl-copy forks a child that serves the selection and inherits stderr, so the
   * pipes stay open long after the parent is gone. Waiting for them would pin
   * the turn until the next clipboard change.
   */
  it("resolves on parent exit when the command leaves a child holding stderr", async () => {
    // The grandchild inherits our stderr pipe and runs until it is killed, so
    // the pipe never closes on its own: the only way the promise settles is
    // by the parent's exit. Its pid arrives on stdout for the liveness check
    // and the kill.
    const result = await node(
      [
        "const child = require('node:child_process').spawn(process.execPath,",
        "  ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'ignore', 2] });",
        "child.unref();",
        "process.stdout.write(String(child.pid));",
        "process.exit(0);",
      ].join(" "),
      { forks: true },
    );
    const grandchild = Number(result.stdout);
    try {
      expect(result).toMatchObject({ outcome: "exited", code: 0 });
      expect(Number.isInteger(grandchild) && grandchild > 0).toBe(true);
      // Settled while the grandchild, and so the stderr pipe, were still alive.
      expect(() => process.kill(grandchild, 0)).not.toThrow();
    } finally {
      // Best effort: a grandchild that is already gone is the assertion's
      // failure to report, not this cleanup's.
      try {
        if (grandchild > 0) process.kill(grandchild, "SIGKILL");
      } catch {
        // already exited
      }
    }
  });

  it("reports when a watched forked child has exited", async () => {
    // The grandchild keeps our stderr for 300 ms, as wl-copy's paste-once
    // child does until the paste (or a replacement) arrives.
    const startedAt = Date.now();
    const result = await node(
      [
        "require('node:child_process').spawn(process.execPath,",
        "  ['-e', 'setTimeout(() => {}, 300)'], { stdio: ['ignore', 'ignore', 2] }).unref();",
        "process.exit(0);",
      ].join(" "),
      { forks: true, observeFork: true },
    );
    expect(result).toMatchObject({ outcome: "exited", code: 0 });
    expect(Date.now() - startedAt).toBeLessThan(250);
    await result.forkExited;
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
  });

  it("ends a watched forked child on request, whose pid nothing reports", async () => {
    const startedAt = Date.now();
    const result = await node(
      [
        "require('node:child_process').spawn(process.execPath,",
        "  ['-e', 'setTimeout(() => {}, 20000)'], { stdio: ['ignore', 'ignore', 2] }).unref();",
        "process.exit(0);",
      ].join(" "),
      { forks: true, observeFork: true },
    );
    expect(result.endFork).toBeTypeOf("function");
    result.endFork?.();
    await result.forkExited;
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    // Ending again, once it is gone, signals nothing.
    result.endFork?.();
  });

  it("watches nothing unless asked", async () => {
    const result = await node("process.exit(0)", { forks: true });
    expect(result.forkExited).toBeUndefined();
  });

  it("kills a command that passes the output cap", async () => {
    await expect(
      node("process.stdout.write('a'.repeat(64)); setTimeout(() => {}, 4000);", {
        maxOutputBytes: 8,
      }),
    ).resolves.toMatchObject({ outcome: "output-limit" });
  });

  it("kills a command that outlives the deadline", async () => {
    await expect(node("setTimeout(() => {}, 4000)", { timeoutMs: 50 })).resolves.toMatchObject({
      outcome: "timed-out",
      code: null,
    });
  });

  it("rejects with the spawn error when the binary is missing", async () => {
    await expect(
      spawnClipboardCommand({ command: "synara-absent-clipboard-binary", args: [] }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("writeWlClipboardForPaste", () => {
  it("offers the text for one paste and hands back the offer's end", async () => {
    const specs: ClipboardCommandSpec[] = [];
    const ended = Promise.withResolvers<void>();
    const offer = await writeWlClipboardForPaste(async (spec): Promise<ClipboardCommandResult> => {
      specs.push(spec);
      return { outcome: "exited", code: 0, stdout: "", stderr: "", forkExited: ended.promise };
    }, "agent text");
    expect(specs).toEqual([
      {
        command: "wl-copy",
        args: ["--paste-once", "--type", "text/plain"],
        input: "agent text",
        forks: true,
        observeFork: true,
      },
    ]);
    let consumed = false;
    void offer.consumed.then(() => {
      consumed = true;
    });
    await Promise.resolve();
    expect(consumed).toBe(false);
    ended.resolve();
    await offer.consumed;
  });

  it("can withdraw the offer, ending wl-copy's background child", async () => {
    let ended = 0;
    const offer = await writeWlClipboardForPaste(
      async (): Promise<ClipboardCommandResult> => ({
        outcome: "exited",
        code: 0,
        stdout: "",
        stderr: "",
        forkExited: new Promise(() => undefined),
        endFork: () => {
          ended += 1;
        },
      }),
      "agent text",
    );
    offer.withdraw();
    expect(ended).toBe(1);
  });

  it("fails like an ordinary write when wl-copy fails", async () => {
    await expect(
      writeWlClipboardForPaste(
        async () => ({ outcome: "exited", code: 1, stdout: "", stderr: "no seat\n" }),
        "x",
      ),
    ).rejects.toThrow("wl-copy failed to write the desktop clipboard: no seat");
  });
});

describe("wlClipboardToolsPresent", () => {
  it.each<string[]>([[], ["wl-copy"], ["wl-paste"]])(
    "requires both utilities: %j",
    (...commands) => {
      expect(wlClipboardToolsPresent((command) => commands.includes(command))).toBe(false);
    },
  );

  it("recognizes both directions", () => {
    expect(wlClipboardToolsPresent((command) => ["wl-copy", "wl-paste"].includes(command))).toBe(
      true,
    );
  });
});
