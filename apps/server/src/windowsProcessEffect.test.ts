// FILE: windowsProcessEffect.test.ts
// Purpose: Verifies Effect forwards verbatim Windows command lines to Node spawn.
// Layer: Server process integration test

import * as NodeServices from "@effect/platform-node/NodeServices";
import { prepareWindowsSafeProcess } from "@synara/shared/windowsProcess";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as Path from "node:path";

import { Effect } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { expect, it } from "vitest";

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
