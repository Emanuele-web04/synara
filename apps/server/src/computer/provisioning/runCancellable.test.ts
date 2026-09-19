import { watch } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { isProcessRunning } from "../../platform/processTreeController.ts";
import {
  CommandFailedError,
  CommandTimeoutError,
  runCancellable,
  stderrTail,
} from "./runCancellable.ts";

const node = process.execPath;
const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "synara-run-cancellable-"));
  temps.push(dir);
  return dir;
}

/** Resolves once `name` appears in `dir`, without polling. */
function whenFileAppears(dir: string, name: string): Promise<void> {
  return new Promise((resolve) => {
    const watcher = watch(dir, (_event, filename) => {
      if (filename === name) {
        watcher.close();
        resolve();
      }
    });
  });
}

/** Whether `pid` is a live (non-zombie) process, as the OS sees it. */
const alive = (pid: number) => isProcessRunning(pid);

describe("runCancellable", () => {
  it("resolves with the streams and exit code of a successful command", async () => {
    const result = await runCancellable(node, [
      "-e",
      "console.log('one'); console.log('two'); process.stderr.write('note')",
    ]);
    expect(result).toEqual({ stdout: "one\ntwo\n", stderr: "note", code: 0 });
  });

  it("rejects a non-zero exit with an error that carries the stderr tail", async () => {
    const error = await runCancellable(node, [
      "-e",
      "console.error('first'); console.error('the actual reason'); process.exit(3)",
    ]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommandFailedError);
    const failed = error as CommandFailedError;
    expect(failed.code).toBe(3);
    expect(failed.command).toBe(node);
    expect(failed.stderrTail).toContain("the actual reason");
    expect(failed.message).toContain(node);
    expect(failed.message).toContain("the actual reason");
  });

  it("keeps only the last lines of a long stderr in the tail", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const tail = stderrTail(`${lines.join("\n")}\n`);
    expect(tail.split("\n")).toHaveLength(12);
    expect(tail.endsWith("line 39")).toBe(true);
  });

  it("rejects when the command does not exist", async () => {
    await expect(runCancellable(join(await temp(), "no-such-binary"), [])).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("bounds captured output and keeps the tail, which is where the answer is", async () => {
    const result = await runCancellable(
      node,
      [
        "-e",
        "for (let i = 0; i < 20000; i++) console.log('filler line ' + i); console.log('last')",
      ],
      { maxOutputBytes: 2048 },
    );
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(2048);
    expect(result.stdout.trimEnd().split("\n").at(-1)).toBe("last");
  });

  it("rejects with the abort reason and takes the whole process tree down", async () => {
    const dir = await temp();
    const ready = whenFileAppears(dir, "ready");
    const controller = new AbortController();
    const reason = new Error("caller gave up");
    // A child that spawns a grandchild, records both pids, and then lives on
    // until told otherwise - the shape of `bash -> cmake -> ninja -> cc`.
    const script = `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const dir = process.argv[1];
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      fs.writeFileSync(dir + '/ready.tmp', JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
      fs.renameSync(dir + '/ready.tmp', dir + '/ready');
      setInterval(() => {}, 1000);
    `;
    const run = runCancellable(node, ["-e", script, dir], { signal: controller.signal });
    await ready;
    const pids = JSON.parse(await readFile(join(dir, "ready"), "utf8")) as {
      child: number;
      grandchild: number;
    };
    expect(await alive(pids.grandchild)).toBe(true);

    controller.abort(reason);
    await expect(run).rejects.toBe(reason);
    // Settled only after the tree is gone: nothing here waits or polls.
    expect(await alive(pids.child)).toBe(false);
    expect(await alive(pids.grandchild)).toBe(false);
  });

  it("rejects an already-aborted signal with its reason before spawning anything", async () => {
    const controller = new AbortController();
    const reason = new Error("never started");
    controller.abort(reason);
    await expect(
      runCancellable(node, ["-e", "process.exit(0)"], { signal: controller.signal }),
    ).rejects.toBe(reason);
  });

  it("stops a command that outlives its timeout and names it in the error", async () => {
    const dir = await temp();
    const ready = whenFileAppears(dir, "ready");
    const script = `
      const fs = require('node:fs');
      fs.writeFileSync(process.argv[1] + '/ready', String(process.pid));
      setInterval(() => {}, 1000);
    `;
    const run = runCancellable(node, ["-e", script, dir], { timeoutMs: 100 });
    await ready;
    const pid = Number(await readFile(join(dir, "ready"), "utf8"));
    const error = await run.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommandTimeoutError);
    expect((error as CommandTimeoutError).command).toBe(node);
    expect((error as CommandTimeoutError).message).toContain(node);
    expect(await alive(pid)).toBe(false);
  });

  it("escalates to SIGKILL for a child that ignores SIGTERM", async () => {
    const dir = await temp();
    const ready = whenFileAppears(dir, "ready");
    const controller = new AbortController();
    const reason = new Error("stop");
    const script = `
      const fs = require('node:fs');
      process.on('SIGTERM', () => {});
      fs.writeFileSync(process.argv[1] + '/ready', String(process.pid));
      setInterval(() => {}, 1000);
    `;
    const run = runCancellable(node, ["-e", script, dir], { signal: controller.signal });
    await ready;
    const pid = Number(await readFile(join(dir, "ready"), "utf8"));
    controller.abort(reason);
    await expect(run).rejects.toBe(reason);
    expect(await alive(pid)).toBe(false);
  }, 15_000);
});
