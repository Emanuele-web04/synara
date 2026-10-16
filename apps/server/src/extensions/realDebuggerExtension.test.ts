import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  EditorDebugActionResult,
  EditorDebugSnapshot,
  EditorDebugStartResult,
} from "@synara/contracts";
import { ExtensionRuntime } from "./extensionRuntime";
import { z } from "zod";

const runtimeFile = process.env.SYNARA_TEST_CODE_OSS_HOST;
const enabled = Boolean(runtimeFile) && process.env.SYNARA_TEST_EXTENSION_SANDBOX === "1";

describe.skipIf(!enabled)("real debugger extension", () => {
  it("runs the actual Native Debug VSIX through Code-OSS and Synara's debugger contract", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "synara-debug-extension-"));
    const cwd = path.join(temporary, "workspace"),
      stateDir = path.join(temporary, "state");
    await mkdir(cwd);
    await mkdir(stateDir);
    await mkdir(path.join(cwd, ".vscode"));
    const contents =
      "int main(void) {\n  volatile int answer = 42;\n  return answer == 42 ? 0 : 1;\n}\n";
    await writeFile(path.join(cwd, "fixture.c"), contents);
    execFileSync(
      "cc",
      ["-g", "-O0", path.join(cwd, "fixture.c"), "-o", path.join(cwd, "fixture")],
      { timeout: 15_000 },
    );
    await writeFile(
      path.join(cwd, ".vscode/launch.json"),
      JSON.stringify({
        version: "0.2.0",
        configurations: [
          {
            name: "Native Debug fixture",
            type: "gdb",
            request: "launch",
            target: "${workspaceFolder}/fixture",
            cwd: "${workspaceFolder}",
            stopAtEntry: true,
            valuesFormatting: "parseText",
          },
        ],
      }),
    );
    const runtime = new ExtensionRuntime(stateDir, runtimeFile);
    const owner = "debugger-extension-fixture";
    let hostId: string | undefined;
    try {
      const installed = await runtime.request(owner, {
        operation: "install",
        id: "webfreak.debug",
      });
      await runtime.request(owner, {
        operation: "setEnabled",
        id: "webfreak.debug",
        enabled: true,
        consent: installed.extensions.map(({ id, digest }) => ({ id, digest })),
      });
      await runtime.request(owner, { operation: "setTrust", cwd, trusted: true });
      hostId = (
        await runtime.runtimeRequest(owner, {
          operation: "start",
          cwd,
          documents: [{ relativePath: "fixture.c", contents, version: 1 }],
        })
      ).hostId;
      await expect
        .poll(
          async () => {
            const state = await runtime.runtimeRequest(owner, {
              operation: "poll",
              cwd,
              hostId: hostId!,
            });
            if (state.status === "failed") throw new Error(JSON.stringify(state.events));
            return state.status;
          },
          { timeout: 30_000, interval: 100 },
        )
        .toBe("running");
      const debug = async (params: Record<string, unknown>) => {
        const result = await runtime.runtimeRequest(owner, {
          operation: "request",
          cwd,
          hostId: hostId!,
          method: "debug",
          paramsJson: JSON.stringify(params),
        });
        return JSON.parse(result.resultJson!);
      };
      const configurations = z
        .array(z.object({ id: z.string(), name: z.string() }))
        .parse(await debug({ operation: "configurations" }));
      expect(configurations).toHaveLength(1);
      const { sessionId } = Schema.decodeUnknownSync(EditorDebugStartResult)(
        await debug({
          operation: "start",
          configurationId: configurations[0]!.id,
          relativePath: "fixture.c",
          breakpoints: [{ relativePath: "fixture.c", line: 3 }],
        }),
      );
      const poll = async () =>
        Schema.decodeUnknownSync(EditorDebugSnapshot)(
          await debug({ operation: "poll", sessionId, after: 0 }),
        );
      await expect
        .poll(async () => (await poll()).events.some((event) => event.event === "stopped"), {
          timeout: 15_000,
          interval: 100,
        })
        .toBe(true);
      const threads = Schema.decodeUnknownSync(EditorDebugActionResult)(
        await debug({ operation: "action", sessionId, action: "threads" }),
      );
      const threadId = threads.threads![0]!.id;
      const stack = Schema.decodeUnknownSync(EditorDebugActionResult)(
        await debug({ operation: "action", sessionId, action: "stackTrace", threadId }),
      );
      expect(stack.frames!.some((frame) => frame.relativePath === "fixture.c")).toBe(true);
      const frameId = stack.frames![0]!.id;
      const scopes = Schema.decodeUnknownSync(EditorDebugActionResult)(
        await debug({ operation: "action", sessionId, action: "scopes", frameId }),
      );
      expect(scopes.scopes!.length).toBeGreaterThan(0);
      const value = Schema.decodeUnknownSync(EditorDebugActionResult)(
        await debug({
          operation: "action",
          sessionId,
          action: "evaluate",
          frameId,
          // Native Debug passes spaced expressions to GDB/MI without quoting.
          // Verify its supported expression form; document the upstream limitation.
          expression: "6*7",
          context: "watch",
        }),
      );
      expect(value.evaluation!.value).toContain("42");
      await debug({ operation: "action", sessionId, action: "continue", threadId });
      await runtime.runtimeRequest(owner, { operation: "stop", cwd, hostId });
      console.log(
        "REAL_DEBUGGER_EXTENSION",
        JSON.stringify({
          extensions: installed.extensions.map(({ id, version, digest }) => ({
            id,
            version,
            digest,
          })),
          actualVsix: true,
          upstreamDescriptor: true,
          nativeDebugContracts: true,
          breakpoint: true,
          stack: true,
          scopes: true,
          watch: true,
          sandboxedCleanup: true,
        }),
      );
    } catch (error) {
      if (hostId)
        console.error(
          "DEBUG_EXTENSION_EVENTS",
          JSON.stringify(
            (
              await runtime
                .runtimeRequest(owner, { operation: "poll", cwd, hostId })
                .catch(() => undefined)
            )?.events.slice(-16),
          ).slice(-16_000),
        );
      throw error;
    } finally {
      await runtime.dispose();
      await rm(temporary, { recursive: true, force: true });
    }
  }, 120_000);
});
