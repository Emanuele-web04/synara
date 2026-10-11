import { afterEach, describe, expect, it, vi } from "vitest";
import * as executable from "./executable";
import os from "node:os";
import path from "node:path";

import { execShellCommandSync, spawnProcess } from "./processRuntime";

function run(
  args: readonly string[],
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const child = spawnProcess(process.execPath, args, {
    stdio: "pipe",
    requireExecutable: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout, stderr, code }));
  });
}

afterEach(() => vi.restoreAllMocks());

describe("processRuntime", () => {
  it
    .runIf(process.platform !== "win32")
    .each(["unresolved executable", "missing POSIX shell"] as const)(
    "applies post-spawn priority for a successful direct launch (%s)",
    async (reason) => {
      const resolveExecutable = executable.resolveExecutable;
      vi.spyOn(executable, "resolveExecutable").mockImplementation((command, options) =>
        reason === "unresolved executable" || command === "/bin/sh"
          ? null
          : resolveExecutable(command, options),
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(os, "getPriority").mockReturnValue(0);
      const setPriority = vi.spyOn(os, "setPriority").mockImplementation(() => {});
      const child = spawnProcess(process.execPath, ["-e", "process.exit(0)"], {
        lowerPriority: true,
        stdio: "pipe",
      });
      expect(setPriority).toHaveBeenCalledWith(child.pid, 5);
      if (reason === "missing POSIX shell") {
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("/bin/sh is unavailable"));
      } else {
        expect(warn).not.toHaveBeenCalled();
      }
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
      });
    },
  );

  it.runIf(process.platform !== "win32").each(["bare", "absolute"] as const)(
    "preserves spawn ENOENT with priority enabled for a missing %s executable",
    async (kind) => {
      const command =
        kind === "bare"
          ? "synara-missing-priority-test-executable"
          : path.join(os.tmpdir(), "synara-missing-priority-test-executable");
      const serverPriority = os.getPriority();
      const child = spawnProcess(command, [], {
        lowerPriority: true,
        stdio: "pipe",
        env: { ...process.env, PATH: "" },
      });
      const error = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
        child.once("error", resolve);
        child.once("close", () =>
          reject(new Error("missing executable exited without a spawn error")),
        );
      });
      expect(error.code).toBe("ENOENT");
      expect(error.message).toContain(command);
      expect(child.pid).toBeUndefined();
      expect(os.getPriority()).toBe(serverPriority);
    },
  );

  it.each([false, true])(
    "applies opt-in priority before descendants launch (enabled=%s)",
    async (enabled) => {
      const serverPriority = os.getPriority();
      const expectedPriority = enabled
        ? Math.max(serverPriority, process.platform === "win32" ? 10 : 5)
        : serverPriority;
      const child = spawnProcess(
        process.execPath,
        [
          "-e",
          `
      const os = require('node:os');
      const { spawnSync } = require('node:child_process');
      const report = () => {
      const descendant = spawnSync(process.execPath, ['-e', 'console.log(require("node:os").getPriority())']);
      const threads = process.platform === 'linux'
        ? require('node:fs').readdirSync('/proc/self/task').map(tid => {
            const stat = require('node:fs').readFileSync('/proc/self/task/' + tid + '/stat', 'utf8');
            return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[16]);
          })
        : [os.getPriority()];
      console.log(JSON.stringify({ parent: os.getPriority(), descendant: Number(descendant.stdout), threads }));
      };
      // Windows still adjusts after spawn; keep its inheritance probe gated.
      if (process.platform === 'win32') { process.stdin.resume(); process.stdin.once('end', report); }
      else report();
    `,
        ],
        { stdio: "pipe", lowerPriority: enabled },
      );
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      const exited = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
      });
      child.stdin.end();
      await exited;
      const observed = JSON.parse(stdout);
      expect(observed.parent).toBe(expectedPriority);
      expect(observed.descendant).toBe(expectedPriority);
      expect(observed.threads.length).toBeGreaterThan(0);
      expect(observed.threads.every((priority: number) => priority === expectedPriority)).toBe(
        true,
      );
      expect(os.getPriority()).toBe(serverPriority);
    },
  );
  it("runs a normal process and preserves UTF-8 stdout/stderr", async () => {
    await expect(
      run(["-e", "process.stdout.write('ok 日本語'); process.stderr.write('diagnostic €')"]),
    ).resolves.toEqual({ stdout: "ok 日本語", stderr: "diagnostic €", code: 0 });
  });

  it("reports the real non-zero exit code without a shell wrapper", async () => {
    await expect(run(["-e", "process.exit(7)"])).resolves.toEqual({
      stdout: "",
      stderr: "",
      code: 7,
    });
  });

  it.runIf(process.platform !== "win32")(
    "runs intentional shell snippets with the supplied environment",
    () => {
      expect(
        execShellCommandSync('printf "%s" "$SYNARA_PROCESS_RUNTIME_TEST"', {
          encoding: "utf8",
          env: { ...process.env, SYNARA_PROCESS_RUNTIME_TEST: "shell-ok" },
        }),
      ).toBe("shell-ok");
    },
  );
});
