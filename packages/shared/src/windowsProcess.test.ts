// FILE: windowsProcess.test.ts
// Purpose: Verifies Windows process preparation avoids Node shell-mode deprecations.
// Layer: Shared Node runtime utility tests

import { spawnSync as spawnChildSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildWindowsBatchCommandArgs,
  isWindowsBatchCommand,
  prepareWindowsSafeProcess,
  resolveWindowsCommandPath,
  resolveWindowsComSpec,
} from "./windowsProcess";

describe("windowsProcess", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("leaves non-Windows commands shell-free and otherwise unchanged", () => {
    expect(
      prepareWindowsSafeProcess("codex", ["app-server"], {
        platform: "darwin",
      }),
    ).toEqual({ command: "codex", args: ["app-server"], shell: false });
  });

  it("resolves Windows PATH commands through where.exe", () => {
    const spawnSync = vi.fn(() => ({
      stdout: "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd\r\n",
      status: 0,
    }));

    expect(
      resolveWindowsCommandPath("codex", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync,
      }),
    ).toBe("C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd");
    expect(spawnSync).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\where.exe",
      ["codex"],
      expect.objectContaining({ shell: false, windowsHide: true }),
    );
  });

  it("prefers .cmd over extensionless npm shims from where.exe", () => {
    const spawnSync = vi.fn(() => ({
      stdout: [
        "C:\\Users\\test\\AppData\\Roaming\\npm\\codex",
        "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd",
      ].join("\r\n"),
      status: 0,
    }));

    expect(
      resolveWindowsCommandPath("codex", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync,
      }),
    ).toBe("C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd");
  });

  it("skips current-directory command hits from where.exe", () => {
    const spawnSync = vi.fn(() => ({
      stdout: [
        "C:\\projects\\synara\\codex.cmd",
        "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd",
      ].join("\r\n"),
      status: 0,
    }));

    expect(
      resolveWindowsCommandPath("codex", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync,
      }),
    ).toBe("C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd");
  });

  it("filters current-directory hits before preferring spawn-safe candidates", () => {
    const spawnSync = vi.fn(() => ({
      stdout: [
        "C:\\projects\\synara\\codex.cmd",
        "C:\\Users\\test\\AppData\\Roaming\\npm\\codex",
        "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd",
      ].join("\r\n"),
      status: 0,
    }));

    expect(
      resolveWindowsCommandPath("codex", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync,
      }),
    ).toBe("C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd");
  });

  it("uses process.cwd for current-directory filtering when cwd is omitted", () => {
    vi.spyOn(process, "cwd").mockReturnValue("C:\\projects\\synara");
    const spawnSync = vi.fn(() => ({
      stdout: [
        "C:\\projects\\synara\\codex.cmd",
        "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd",
      ].join("\r\n"),
      status: 0,
    }));

    expect(
      resolveWindowsCommandPath("codex", {
        platform: "win32",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync,
      }),
    ).toBe("C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd");
    expect(spawnSync).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\where.exe",
      ["codex"],
      expect.objectContaining({ cwd: "C:\\projects\\synara" }),
    );
  });

  it("resolves extensionless path-like Windows shims before spawning", () => {
    const spawnSync = vi.fn(() => ({
      stdout: [
        "C:\\Users\\test\\AppData\\Roaming\\npm\\codex",
        "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd",
      ].join("\r\n"),
      status: 0,
    }));

    expect(
      resolveWindowsCommandPath("C:\\Users\\test\\AppData\\Roaming\\npm\\codex", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync,
      }),
    ).toBe("C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd");
    expect(spawnSync).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\where.exe",
      ["C:\\Users\\test\\AppData\\Roaming\\npm\\codex"],
      expect.objectContaining({ shell: false, windowsHide: true }),
    );
  });

  it("keeps explicit path-like Windows executables without resolving", () => {
    const spawnSync = vi.fn();

    expect(
      resolveWindowsCommandPath("C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync,
      }),
    ).toBe("C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd");
    expect(
      resolveWindowsCommandPath("C:\\Program Files\\Codex\\codex.exe", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync,
      }),
    ).toBe("C:\\Program Files\\Codex\\codex.exe");
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("wraps .cmd shims through cmd.exe without shell true", () => {
    const spawnSync = vi.fn(() => ({
      stdout: "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd\r\n",
      status: 0,
    }));

    expect(
      prepareWindowsSafeProcess("codex", ["app-server"], {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { ComSpec: "C:\\Windows\\System32\\cmd.exe", SystemRoot: "C:\\Windows" },
        spawnSync,
      }),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/v:off",
        "/c",
        'call "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd" "app-server"',
      ],
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  });

  it("wraps resolved extensionless path-like shims through cmd.exe", () => {
    const spawnSync = vi.fn(() => ({
      stdout: [
        "C:\\Users\\test\\AppData\\Roaming\\npm\\codex",
        "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd",
      ].join("\r\n"),
      status: 0,
    }));

    expect(
      prepareWindowsSafeProcess("C:\\Users\\test\\AppData\\Roaming\\npm\\codex", ["app-server"], {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { ComSpec: "C:\\Windows\\System32\\cmd.exe", SystemRoot: "C:\\Windows" },
        spawnSync,
      }),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/v:off",
        "/c",
        'call "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd" "app-server"',
      ],
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  });

  it("wraps a configured .cmd Codex path without truncating it", () => {
    const spawnSync = vi.fn();
    const customPath = "C:\\Users\\Test User\\AppData\\Roaming\\npm\\codex.cmd";

    expect(
      prepareWindowsSafeProcess(customPath, ["app-server"], {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { ComSpec: "C:\\Windows\\System32\\cmd.exe", SystemRoot: "C:\\Windows" },
        spawnSync,
      }),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/v:off",
        "/c",
        'call "C:\\Users\\Test User\\AppData\\Roaming\\npm\\codex.cmd" "app-server"',
      ],
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("encodes one cmd.exe command line with quoted command and argument tokens", () => {
    expect(
      buildWindowsBatchCommandArgs("C:\\Users\\Test User\\npm\\tool.cmd", [
        "path with spaces",
        "flag=value",
      ]),
    ).toEqual([
      "/d",
      "/s",
      "/v:off",
      "/c",
      'call "C:\\Users\\Test User\\npm\\tool.cmd" "path with spaces" "flag=value"',
    ]);
  });

  it("preserves literal quotes in existing Codex config arguments", () => {
    expect(
      buildWindowsBatchCommandArgs("C:\\tools\\codex.cmd", [
        "exec",
        "--config",
        'approval_policy="never"',
        "--config",
        'model_reasoning_effort="high"',
      ]),
    ).toEqual([
      "/d",
      "/s",
      "/v:off",
      "/c",
      'call "C:\\tools\\codex.cmd" "exec" "--config" "approval_policy=""never""" "--config" "model_reasoning_effort=""high"""',
    ]);
  });

  it("rejects batch tokens with cmd.exe control characters", () => {
    expect(() => buildWindowsBatchCommandArgs("C:\\tools\\bad%path\\codex.cmd", [])).toThrow(
      /Cannot safely execute Windows batch command/,
    );
    expect(() => buildWindowsBatchCommandArgs("C:\\tools\\codex.cmd", ["one&two"])).toThrow(
      /Cannot safely execute Windows batch argument/,
    );
  });

  it("allows batch paths with spaces and parentheses", () => {
    expect(
      buildWindowsBatchCommandArgs("C:\\Program Files (x86)\\Tool\\tool.cmd", ["--version"]),
    ).toEqual([
      "/d",
      "/s",
      "/v:off",
      "/c",
      'call "C:\\Program Files (x86)\\Tool\\tool.cmd" "--version"',
    ]);
  });

  it("quotes batch paths containing parentheses even without spaces", () => {
    expect(buildWindowsBatchCommandArgs("C:\\tools(x86)\\codex.cmd", ["--version"])).toEqual([
      "/d",
      "/s",
      "/v:off",
      "/c",
      'call "C:\\tools(x86)\\codex.cmd" "--version"',
    ]);
  });

  it.runIf(process.platform === "win32")(
    "preserves quoted Codex arguments through a real cmd.exe batch launch",
    () => {
      const root = mkdtempSync(Path.join(tmpdir(), "synara-windows-process-"));
      const commandDir = Path.join(root, "tools(x86)");
      const scriptPath = Path.join(commandDir, "capture.mjs");
      const commandPath = Path.join(commandDir, "codex.cmd");
      const expectedArgs = [
        "exec",
        "--config",
        'approval_policy="never"',
        "--config",
        'model_reasoning_effort="high"',
      ];

      try {
        mkdirSync(commandDir);
        writeFileSync(scriptPath, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
        writeFileSync(commandPath, `@echo off\r\n"${process.execPath}" "%~dp0capture.mjs" %*\r\n`);

        const prepared = prepareWindowsSafeProcess(commandPath, expectedArgs, {
          platform: "win32",
          env: process.env,
        });
        const result = spawnChildSync(prepared.command, prepared.args, {
          encoding: "utf8",
          shell: false,
          windowsHide: true,
          windowsVerbatimArguments: prepared.windowsVerbatimArguments,
        });

        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual(expectedArgs);
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
  );

  it("rejects batch tokens with line breaks", () => {
    expect(() => buildWindowsBatchCommandArgs("C:\\tools\\codex.cmd", ["line\nbreak"])).toThrow(
      /Cannot safely execute Windows batch argument/,
    );
  });

  it("keeps resolved .exe commands direct", () => {
    const spawnSync = vi.fn(() => ({
      stdout: "C:\\Program Files\\Codex\\codex.exe\r\n",
      status: 0,
    }));

    expect(
      prepareWindowsSafeProcess("codex", ["--version"], {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync,
      }),
    ).toEqual({
      command: "C:\\Program Files\\Codex\\codex.exe",
      args: ["--version"],
      shell: false,
      windowsHide: true,
    });
  });

  it("keeps a configured native Codex executable path intact", () => {
    const spawnSync = vi.fn();

    expect(
      prepareWindowsSafeProcess(
        "C:\\Users\\test\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe",
        ["app-server"],
        {
          platform: "win32",
          cwd: "C:\\projects\\synara",
          env: { SystemRoot: "C:\\Windows" },
          spawnSync,
        },
      ),
    ).toEqual({
      command: "C:\\Users\\test\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe",
      args: ["app-server"],
      shell: false,
      windowsHide: true,
    });
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("resolves ComSpec from environment before falling back", () => {
    expect(resolveWindowsComSpec({ ComSpec: "D:\\cmd.exe" })).toBe("D:\\cmd.exe");
    expect(resolveWindowsComSpec({ SystemRoot: "D:\\Windows" })).toBe(
      "D:\\Windows\\System32\\cmd.exe",
    );
  });

  it("detects batch shims by extension", () => {
    expect(isWindowsBatchCommand("codex.cmd")).toBe(true);
    expect(isWindowsBatchCommand("tool.bat")).toBe(true);
    expect(isWindowsBatchCommand("tool.exe")).toBe(false);
  });
});
