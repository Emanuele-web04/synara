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
            "setTimeout(() => console.log(require('node:os').getPriority()), 100)",
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
      expect(Number(observed)).toBe(
        enabled ? Math.max(serverPriority, process.platform === "win32" ? 10 : 5) : serverPriority,
      );
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
