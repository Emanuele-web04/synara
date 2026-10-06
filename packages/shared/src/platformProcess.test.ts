import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExecutableNotFoundError, prepareProcess } from "./platformProcess";
import { spawnProcess } from "./processRuntime";
import os from "node:os";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "synara-platform-process-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function windowsEnv(pathValue = root): NodeJS.ProcessEnv {
  return {
    PATH: pathValue,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    SystemRoot: "C:\\Windows",
  };
}

describe("prepareProcess", () => {
  it.each(["linux", "darwin"] as const)(
    "preserves lower inherited priority before exec on %s",
    (platform) => {
      vi.spyOn(os, "getPriority").mockReturnValue(15);
      const plan = prepareProcess("agent", ["literal $arg"], { platform, lowerPriority: true });
      expect(plan).toMatchObject({ command: "/bin/sh", resolvedCommand: "agent" });
      expect(plan.args.slice(2)).toEqual(["synara-agent-priority", "15", "agent", "literal $arg"]);
    },
  );

  it("logs an inherited priority read failure and still plans the launch", () => {
    vi.spyOn(os, "getPriority").mockImplementation(() => {
      throw new Error("access denied");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      prepareProcess("agent", [], { platform: "linux", lowerPriority: true }).args.slice(2),
    ).toEqual(["synara-agent-priority", "5", "agent"]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("inherited agent process priority"),
      expect.any(Error),
    );
  });
  it.runIf(process.platform !== "win32").each([
    ["native", false],
    ["native", true],
    ["wsl", false],
    ["wsl", true],
  ] as const)(
    "sets %s priority before exec and tolerates failure (reniceFails=%s)",
    async (backend, reniceFails) => {
      if (reniceFails)
        writeFileSync(path.join(root, "renice"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      const plan = prepareProcess(
        process.execPath,
        [
          "-e",
          "console.log(JSON.stringify({ pid: process.pid, priority: require('node:os').getPriority(), args: process.argv.slice(1) }))",
          "--",
          "a b",
          "quote'\"$",
          "--flag",
        ],
        {
          ...(backend === "wsl"
            ? { platform: "win32" as const, cwd: "\\\\wsl.localhost\\Ubuntu\\home\\agent" }
            : {}),
          lowerPriority: true,
        },
      );
      // Execute the guest-side argv locally; Windows/WSL host launch remains platform-specific.
      const guestArgs =
        backend === "wsl"
          ? plan.args.slice(plan.args.indexOf("--exec") + 1)
          : [plan.command, ...plan.args];
      expect(guestArgs[0]).toBe("/bin/sh");
      const child = spawnProcess(guestArgs[0]!, guestArgs.slice(1), {
        stdio: "pipe",
        env: { ...process.env, PATH: reniceFails ? root : process.env.PATH },
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`exit ${code}: ${stderr}`)),
        );
      });
      expect(JSON.parse(stdout)).toEqual({
        pid: child.pid,
        priority: reniceFails ? os.getPriority() : Math.max(5, os.getPriority()),
        args: ["a b", "quote'\"$", "--flag"],
      });
      if (reniceFails) expect(stderr).toContain("failed to lower agent process priority");
    },
  );
  it.skipIf(process.platform === "win32")(
    "keeps the POSIX path shell-free and resolves through the supplied environment",
    () => {
      const executable = path.join(root, "tool");
      writeFileSync(executable, "#!/bin/sh\n", { mode: 0o755 });

      expect(
        prepareProcess("tool", ["one", "two"], {
          platform: "linux",
          env: { PATH: root },
          requireExecutable: true,
        }),
      ).toMatchObject({
        command: executable,
        args: ["one", "two"],
        shell: false,
        requestedCommand: "tool",
        resolvedCommand: executable,
        executionBackend: "native",
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "uses the native POSIX search path when PATH is absent",
    () => {
      expect(
        prepareProcess("sh", [], {
          platform: "linux",
          env: {},
          requireExecutable: true,
        }).resolvedCommand,
      ).toMatch(/\/sh$/);

      expect(() =>
        prepareProcess("sh", [], {
          platform: "linux",
          env: { PATH: "" },
          requireExecutable: true,
        }),
      ).toThrow(ExecutableNotFoundError);
    },
  );

  it.skipIf(process.platform === "win32")(
    "resolves a qualified relative command against the launch cwd, not the server cwd",
    () => {
      const binDir = path.join(root, "bin");
      mkdirSync(binDir, { recursive: true });
      const executable = path.join(binDir, "tool");
      writeFileSync(executable, "#!/bin/sh\n", { mode: 0o755 });

      expect(
        prepareProcess("./bin/tool", [], {
          platform: "linux",
          cwd: root,
          env: { PATH: "/nonexistent" },
          requireExecutable: true,
        }),
      ).toMatchObject({ command: "./bin/tool", resolvedCommand: "./bin/tool" });

      expect(() =>
        prepareProcess("./bin/tool", [], {
          platform: "linux",
          env: { PATH: "/nonexistent" },
          requireExecutable: true,
        }),
      ).toThrow(ExecutableNotFoundError);
    },
  );

  it("uses PATHEXT precedence consistently for Windows discovery and launch", () => {
    const executable = path.join(root, "foo.EXE");
    const batch = path.join(root, "foo.CMD");
    writeFileSync(executable, "native");
    writeFileSync(batch, "@echo off\r\n");

    expect(
      prepareProcess("foo", ["--version"], {
        platform: "win32",
        env: windowsEnv(),
        requireExecutable: true,
      }),
    ).toMatchObject({
      command: executable,
      resolvedCommand: executable,
      args: ["--version"],
      shell: false,
      executionBackend: "native",
    });
  });

  it("supports native .com executables and empty argument lists", () => {
    const executable = path.join(root, "legacy.COM");
    writeFileSync(executable, "native");

    expect(
      prepareProcess("legacy", [], {
        platform: "win32",
        env: windowsEnv(),
        requireExecutable: true,
      }),
    ).toMatchObject({
      command: executable,
      resolvedCommand: executable,
      args: [],
      shell: false,
    });
  });

  it("routes .cmd and .bat shims through the same cmd.exe boundary", () => {
    const cmdPath = path.join(root, "tool.CMD");
    const batPath = path.join(root, "other.BAT");
    writeFileSync(cmdPath, "@echo off\r\n");
    writeFileSync(batPath, "@echo off\r\n");

    for (const [command, resolved] of [
      ["tool", cmdPath],
      ["other", batPath],
    ] as const) {
      const plan = prepareProcess(command, ["path with spaces", 'quoted="value"', "日本語"], {
        platform: "win32",
        env: windowsEnv(),
        requireExecutable: true,
      });
      expect(plan).toMatchObject({
        command: "C:\\Windows\\System32\\cmd.exe",
        resolvedCommand: resolved,
        shell: false,
        windowsVerbatimArguments: true,
      });
      expect(plan.args).toEqual([
        "/d",
        "/s",
        "/v:off",
        "/c",
        `call "${resolved}" "path with spaces" "quoted=""value""" "日本語"`,
      ]);
    }
  });

  it("supports manual executable paths with spaces, empty args, and Unicode", () => {
    const executable = path.join(root, "Tools 日本語", "provider.exe");
    mkdirSync(path.dirname(executable), { recursive: true });
    writeFileSync(executable, "native");

    expect(
      prepareProcess(executable, ["", "two words", "日本語"], {
        platform: "win32",
        env: windowsEnv(),
        requireExecutable: true,
      }),
    ).toMatchObject({
      command: executable,
      args: ["", "two words", "日本語"],
      resolvedCommand: executable,
    });
  });

  it("accepts an explicit Windows executable independently of PATHEXT", () => {
    const executable = path.join(root, "Tools", "provider.exe");
    mkdirSync(path.dirname(executable), { recursive: true });
    writeFileSync(executable, "native");

    expect(
      prepareProcess(executable, [], {
        platform: "win32",
        env: { ...windowsEnv(), PATHEXT: ".COM;.CMD" },
        requireExecutable: true,
      }),
    ).toMatchObject({
      command: executable,
      resolvedCommand: executable,
      executionBackend: "native",
    });
  });

  it("fails before spawn when an executable is required but missing", () => {
    expect(() =>
      prepareProcess("missing-provider", [], {
        platform: "win32",
        env: windowsEnv(),
        requireExecutable: true,
      }),
    ).toThrow(ExecutableNotFoundError);
  });

  it("preserves native Windows support while isolating WSL UNC execution", () => {
    expect(
      prepareProcess("provider", ["serve"], {
        platform: "win32",
        cwd: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\dev\\project",
        env: windowsEnv(),
      }),
    ).toMatchObject({
      command: "C:\\Windows\\System32\\wsl.exe",
      args: [
        "--distribution",
        "Ubuntu-24.04",
        "--cd",
        "/home/dev/project",
        "--exec",
        "provider",
        "serve",
      ],
      executionBackend: "wsl",
      shell: false,
    });
  });
});
