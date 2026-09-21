// exercises the installed Effect patch including its compiled runtime entrypoint
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { makeEffectProcessCommand } from "./effectProcessRuntime";

const nodeChildProcess = createRequire(import.meta.url)(
  "node:child_process",
) as typeof import("node:child_process");

describe("Effect process signal guards", () => {
  it.each([undefined, 0, 1, -1, 1.5, NaN, Infinity, 2 ** 32 + 1])(
    "never turns invalid child PID %s into a group signal",
    async (pid) => {
      const fake = Object.assign(new EventEmitter(), {
        pid,
        stdin: null,
        stdout: null,
        stderr: null,
        stdio: [],
        kill: vi.fn(() => true),
      });
      // no OS signals may leave this test, even when validating an unpatched runtime
      const kill = vi.spyOn(process, "kill").mockReturnValue(true);
      const spawn = vi.spyOn(nodeChildProcess, "spawn").mockImplementation(() => {
        queueMicrotask(() => fake.emit("spawn"));
        return fake as unknown as import("node:child_process").ChildProcess;
      });
      const exec = vi.spyOn(nodeChildProcess, "exec").mockImplementation((...args: unknown[]) => {
        const callback = args.at(-1);
        if (typeof callback === "function") callback(null, "", "");
        return fake as unknown as import("node:child_process").ChildProcess;
      });
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
              yield* child.exitCode;
            }),
          ).pipe(Effect.provide(NodeServices.layer)),
        );
        expect(kill).not.toHaveBeenCalled();
        expect(exec).not.toHaveBeenCalled();
      } finally {
        spawn.mockRestore();
        exec.mockRestore();
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
