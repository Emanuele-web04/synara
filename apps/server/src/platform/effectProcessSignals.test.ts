// Exercises the installed Effect patch, including its compiled runtime entrypoint.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { makeEffectProcessCommand } from "./effectProcessRuntime";
import { spawnProcess } from "@synara/shared/processRuntime";
import { once } from "node:events";

const nodeChildProcess = createRequire(import.meta.url)(
  "node:child_process",
) as typeof import("node:child_process");

it.skipIf(process.platform === "win32")(
  "keeps signal ownership until asynchronous runtime finalizers finish",
  async () => {
    const child = spawnProcess(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
        import { runMain } from '@effect/platform-node/NodeRuntime';
        import { Effect } from 'effect';
        runMain(Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Effect.promise(async () => {
            await new Promise(resolve => setTimeout(resolve, 100));
            process.stdout.write('finalized');
          }));
          // signal-exit installs after runMain when a provider loads it. If
          // runtime ownership disappears, it re-raises the same OS signal.
          function lateExitHandler() {
            if (process.listenerCount('SIGTERM') === 1) {
              process.removeListener('SIGTERM', lateExitHandler);
              process.kill(process.pid, 'SIGTERM');
            }
          }
          process.on('SIGTERM', lateExitHandler);
          process.stdout.write('ready');
          yield* Effect.never;
        }).pipe(Effect.scoped));
        `,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout!.on("data", (chunk) => {
      output += chunk.toString();
    });
    const closed = once(child, "close");
    try {
      await vi.waitFor(() => expect(output).toContain("ready"));
      child.kill("SIGTERM");
      const [code, signal] = await closed;
      expect(signal).toBeNull();
      expect(code).toBe(130);
      expect(output).toContain("finalized");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
  },
);

describe("Effect process signal guards", () => {
  const invalidPids = [undefined, 0, 1, -1, 1.5, NaN, Infinity, 2 ** 32 + 1];
  const cases = [...new Set([process.platform, "win32"])]
    .flatMap((platform) => invalidPids.map((pid) => ({ platform, pid, cleanup: false })))
    .concat([{ platform: "win32", pid: 32123, cleanup: true }]);

  it.each(cases)(
    "Windows console policy and PID guard: $platform pid=$pid",
    async ({ platform, pid, cleanup }) => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
      const fake = Object.assign(new EventEmitter(), {
        pid,
        stdin: null,
        stdout: null,
        stderr: null,
        stdio: [],
        kill: vi.fn(() => true),
      });
      // No OS signals may leave this test, even against an unpatched runtime.
      const kill = vi.spyOn(process, "kill").mockReturnValue(true);
      const spawn = vi.spyOn(nodeChildProcess, "spawn").mockImplementation(() => {
        queueMicrotask(() => fake.emit("spawn"));
        return fake as unknown as import("node:child_process").ChildProcess;
      });
      const complete = (...args: unknown[]) => {
        const callback = args.at(-1);
        if (typeof callback === "function") callback(null, "", "");
        return fake as unknown as import("node:child_process").ChildProcess;
      };
      const exec = vi.spyOn(nodeChildProcess, "exec").mockImplementation(complete);
      const execFile = vi.spyOn(nodeChildProcess, "execFile").mockImplementation(complete);
      Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
      syncBuiltinESMExports();
      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
              const child = yield* spawner.spawn(
                makeEffectProcessCommand("fake-signal-test", [], {
                  stdin: "ignore",
                  stdout: "ignore",
                  stderr: "ignore",
                }),
              );
              fake.emit("exit", 1, null);
              expect(yield* child.exitCode).toBe(1);
            }),
          ).pipe(Effect.provide(NodeServices.layer)),
        );
        if (cleanup) {
          expect(execFile).toHaveBeenCalledWith(
            "taskkill",
            ["/pid", String(pid), "/T", "/F"],
            expect.objectContaining({ windowsHide: true }),
            expect.any(Function),
          );
        } else {
          expect(execFile).not.toHaveBeenCalled();
        }
        expect(exec).not.toHaveBeenCalled();
        expect(kill).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(process, "platform", originalPlatform);
        spawn.mockRestore();
        exec.mockRestore();
        execFile.mockRestore();
        kill.mockRestore();
        syncBuiltinESMExports();
      }
    },
  );
});

it("does not replace the process-wide signal function when the controller is imported", async () => {
  const originalKill = process.kill;
  await import("./processTreeController");
  expect(process.kill).toBe(originalKill);
});

it.skipIf(process.platform === "win32")(
  "cleans an owned group after its leader exits nonzero",
  async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synara-group-exit-"));
    const marker = path.join(directory, "descendant-stopped");
    const descendant = `
    process.on('SIGTERM', () => {
      require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'stopped');
      process.exit(0);
    });
    process.send('ready');
    setTimeout(() => process.exit(0), 4000);
  `;
    const leader = `
    const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    child.once('message', () => { child.disconnect(); process.exit(1); });
    setTimeout(() => process.exit(1), 3000);
  `;
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            const child = yield* spawner.spawn(
              makeEffectProcessCommand(process.execPath, ["-e", leader], {
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
              }),
            );
            expect(yield* child.exitCode).toBe(1);
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
      );
      await vi.waitFor(async () => expect(await fs.readFile(marker, "utf8")).toBe("stopped"), {
        timeout: 2000,
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);
