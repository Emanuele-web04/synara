// FILE: windowsProcess.test.ts
// Purpose: Verifies Windows process preparation avoids Node shell-mode deprecations.
// Layer: Shared Node runtime utility tests

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
      stdout: "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd\r\n",
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
        '"C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd" "app-server"',
      ],
      shell: false,
      windowsHide: true,
    });
  });

  it("wraps resolved extensionless path-like shims through cmd.exe", () => {
    const spawnSync = vi.fn(() => ({
      stdout: "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd\r\n",
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
        '"C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd" "app-server"',
      ],
      shell: false,
      windowsHide: true,
    });
  });

  it("quotes batch commands and arguments in a single cmd.exe command line", () => {
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
      '"C:\\Users\\Test User\\npm\\tool.cmd" "path with spaces" "flag=value"',
    ]);
  });

  it("escapes batch arguments that cmd.exe can expand or reinterpret", () => {
    expect(
      buildWindowsBatchCommandArgs("C:\\tools\\bad%path\\codex.cmd", [
        "%PATH%",
        'approval_policy="never"',
        "one&two",
        "bang!value",
      ]),
    ).toEqual([
      "/d",
      "/s",
      "/v:off",
      "/c",
      '"C:\\tools\\bad%%path\\codex.cmd" "%%PATH%%" "approval_policy=^"never^"" "one^&two" "bang^!value"',
    ]);
  });

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
