// FILE: effectProcessRuntime.test.ts
// Purpose: Verifies shared Windows launch decisions reach Effect child-process commands.
// Layer: Server platform runtime test

import { describe, expect, it } from "vitest";
import os from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ServerSettingsService } from "../serverSettings";

import { makeEffectProcessCommand, spawnProviderProcess } from "./effectProcessRuntime";

describe("spawnProviderProcess", () => {
  it.each([false, true])(
    "wires the server setting into a real Effect child (enabled=%s)",
    async (enabled) => {
      const serverPriority = os.getPriority();
      const observed = await Effect.runPromise(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const child = yield* spawnProviderProcess(spawner, process.execPath, [
            "-e",
            `
              const os = require('node:os');
              const report = () => {
              const child = require('node:child_process').spawnSync(process.execPath, ['-e', 'console.log(require("node:os").getPriority())']);
              const threads = process.platform === 'linux'
                ? require('node:fs').readdirSync('/proc/self/task').map(tid => {
                    const stat = require('node:fs').readFileSync('/proc/self/task/' + tid + '/stat', 'utf8');
                    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[16]);
                  })
                : [os.getPriority()];
              console.log(JSON.stringify({ parent: os.getPriority(), descendant: Number(child.stdout), threads }));
              };
              // Windows remains post-spawn; this probe does not prove the shim race absent.
              if (process.platform === 'win32') setTimeout(report, 100);
              else report();
            `,
          ]);
          return yield* Stream.mkString(Stream.decodeText(child.stdout));
        }).pipe(
          Effect.scoped,
          Effect.provide(NodeServices.layer),
          Effect.provide(
            ServerSettingsService.layerTest({ lowerProviderProcessPriority: enabled }),
          ),
        ),
      );
      const expected = enabled
        ? Math.max(serverPriority, process.platform === "win32" ? 10 : 5)
        : serverPriority;
      const priorities = JSON.parse(observed);
      expect(priorities.parent).toBe(expected);
      expect(priorities.descendant).toBe(expected);
      expect(priorities.threads.length).toBeGreaterThan(0);
      expect(priorities.threads.every((priority: number) => priority === expected)).toBe(true);
      expect(os.getPriority()).toBe(serverPriority);
    },
  );
});

describe("makeEffectProcessCommand", () => {
  it("keeps PowerShell provider probes hidden on Windows", () => {
    const command = makeEffectProcessCommand("cursor-agent.ps1", ["--version"], {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
    });

    expect(command).toMatchObject({
      _tag: "StandardCommand",
      command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "cursor-agent.ps1", "--version"],
      options: {
        shell: false,
        windowsHide: true,
      },
    });
  });
});
