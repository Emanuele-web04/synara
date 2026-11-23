// FILE: windowsProcessEffect.test.ts
// Purpose: Verifies Effect launch and supervised ACP process-tree retirement on Windows.
// Layer: Server process integration test

import * as NodeServices from "@effect/platform-node/NodeServices";
import { prepareWindowsSafeProcess } from "@synara/shared/windowsProcess";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as Path from "node:path";

import { Effect, Layer } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { expect, it, vi } from "vitest";

import { AcpSessionRuntime } from "./provider/acp/AcpSessionRuntime.ts";

it.runIf(process.platform === "win32")(
  "forwards encoded Codex arguments verbatim through the Effect Node spawner",
  async () => {
    const root = mkdtempSync(Path.join(tmpdir(), "synara-effect-windows-process-"));
    const commandDir = Path.join(root, "tools(x86)");
    const scriptPath = Path.join(commandDir, "capture.mjs");
    const commandPath = Path.join(commandDir, "codex.cmd");
    const outputPath = Path.join(root, "args.json");
    const expectedArgs = [
      "exec",
      "--config",
      'approval_policy="never"',
      "--config",
      'model_reasoning_effort="high"',
    ];

    try {
      mkdirSync(commandDir);
      writeFileSync(
        scriptPath,
        [
          'import { writeFileSync } from "node:fs";',
          "writeFileSync(process.env.SYNARA_CAPTURE_PATH, JSON.stringify(process.argv.slice(2)));",
          "",
        ].join("\n"),
      );
      writeFileSync(commandPath, `@echo off\r\n"${process.execPath}" "%~dp0capture.mjs" %*\r\n`);

      const env = { ...process.env, SYNARA_CAPTURE_PATH: outputPath };
      const prepared = prepareWindowsSafeProcess(commandPath, expectedArgs, {
        platform: "win32",
        env,
      });
      const options = {
        env,
        shell: prepared.shell,
        ...(prepared.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      };

      const exitCode = await Effect.runPromise(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const child = yield* spawner.spawn(
            ChildProcess.make(prepared.command, prepared.args, options),
          );
          return yield* child.exitCode;
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      );

      expect(Number(exitCode)).toBe(0);
      expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual(expectedArgs);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

it.runIf(process.platform === "win32")(
  "retires an ACP process and its child before allowing a replacement runtime",
  async () => {
    const root = mkdtempSync(Path.join(tmpdir(), "synara-windows-acp-retirement-"));
    const scriptPath = Path.join(root, "agent.cjs");
    const marker = Path.join(root, "pids.json");
    // Use a real persistent child to exercise process-tree proof, without a
    // provider install or credentials. The timers bound cleanup on test failure.
    const fixture = [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync, renameSync } = require("node:fs");',
      'const worker = spawn(process.execPath, ["-e", "setTimeout(() => {}, 25_000);"], { stdio: "ignore", windowsHide: true });',
      'worker.once("spawn", () => {',
      "  const marker = process.argv[2];",
      '  writeFileSync(marker + ".tmp", JSON.stringify([process.pid, worker.pid]));',
      '  renameSync(marker + ".tmp", marker);',
      "});",
      "setTimeout(() => {}, 25_000);",
    ].join("\n");

    try {
      writeFileSync(scriptPath, fixture);
      for (let launch = 0; launch < 2; launch++) {
        const runtimeLayer = AcpSessionRuntime.layer({
          spawn: { command: process.execPath, args: [scriptPath, marker], cwd: root },
          cwd: root,
          clientInfo: { name: "synara-windows-retirement-test", version: "0.0.0" },
        }).pipe(Layer.provide(NodeServices.layer));
        const pids = await Effect.runPromise(
          Effect.service(AcpSessionRuntime).pipe(
            Effect.flatMap(() =>
              Effect.promise(() =>
                vi.waitFor(
                  () => {
                    const pids = JSON.parse(readFileSync(marker, "utf8")) as number[];
                    expect(pids).toHaveLength(2);
                    for (const pid of pids) expect(process.kill(pid, 0)).toBe(true);
                    return pids;
                  },
                  { timeout: 5_000 },
                ),
              ),
            ),
            Effect.provide(runtimeLayer),
          ),
        );
        for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow(/ESRCH/u);
        rmSync(marker);
      }
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);
