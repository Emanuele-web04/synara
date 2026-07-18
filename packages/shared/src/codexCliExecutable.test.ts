// FILE: codexCliExecutable.test.ts
// Purpose: Verifies deterministic Windows Codex CLI executable selection.
// Layer: Shared Node runtime utility tests

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveCodexCliExecutable } from "./codexCliExecutable.ts";

function whereOutput(...candidates: string[]) {
  return vi.fn(() => ({ stdout: candidates.join("\r\n"), status: 0 }));
}

function regularFiles(...paths: string[]) {
  const files = new Set(paths.map((path) => path.toLowerCase()));
  return vi.fn((path: string) => {
    if (!files.has(path.toLowerCase())) {
      throw Object.assign(new Error(`Missing file: ${path}`), { code: "ENOENT" });
    }
    return { isFile: () => true };
  });
}

describe("resolveCodexCliExecutable", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("preserves non-Windows commands exactly without probing", () => {
    const spawnSync = vi.fn();
    const readStat = vi.fn();

    expect(
      resolveCodexCliExecutable(" CoDeX ", {
        platform: "linux",
        env: {},
        spawnSync,
        statSync: readStat,
      }),
    ).toBe(" CoDeX ");
    expect(spawnSync).not.toHaveBeenCalled();
    expect(readStat).not.toHaveBeenCalled();
  });

  it("returns an explicit executable path without probing", () => {
    const spawnSync = vi.fn();
    const readStat = vi.fn();
    const configured = "C:\\Program Files (x86)\\Codex Tools\\custom.exe";

    expect(
      resolveCodexCliExecutable(configured, {
        platform: "win32",
        env: {},
        spawnSync,
        statSync: readStat,
      }),
    ).toBe(configured);
    expect(spawnSync).not.toHaveBeenCalled();
    expect(readStat).not.toHaveBeenCalled();
  });

  it.each([
    {
      configured: "C:\\Users\\test\\AppData\\Roaming\\npm\\codex",
      resolved: "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd",
    },
    {
      configured: "custom-codex",
      resolved: "C:\\tools\\custom-codex.cmd",
    },
  ])(
    "resolves the explicit extensionless command $configured exactly once",
    ({ configured, resolved }) => {
      const spawnSync = whereOutput(configured, resolved);

      expect(
        resolveCodexCliExecutable(configured, {
          platform: "win32",
          cwd: "C:\\projects\\synara",
          env: { SystemRoot: "C:\\Windows" },
          spawnSync,
          statSync: vi.fn(),
        }),
      ).toBe(resolved);
      expect(spawnSync).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps a failed explicit alias without consulting default fallbacks", () => {
    const fallback = "D:\\Codex\\codex.exe";
    const spawnSync = vi.fn(() => ({ stdout: "", status: 1 }));
    const readStat = regularFiles(fallback);

    expect(
      resolveCodexCliExecutable("custom-codex", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows", CODEX_INSTALL_DIR: "D:\\Codex" },
        spawnSync,
        statSync: readStat,
      }),
    ).toBe("custom-codex");
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(readStat).not.toHaveBeenCalled();
  });

  it("prefers a valid native PATH executable over batch and documented fallbacks", () => {
    const extensionless = "C:\\Users\\Test User\\AppData\\Roaming\\npm\\codex";
    const batch = "C:\\Users\\Test User\\AppData\\Roaming\\npm\\codex.cmd";
    const native =
      "C:\\Users\\Test User\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe";
    const installDirNative = "D:\\Codex\\codex.exe";
    const spawnSync = whereOutput(extensionless, batch, native);
    const readStat = regularFiles(batch, native, installDirNative);

    expect(
      resolveCodexCliExecutable(" CoDeX ", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows", CODEX_INSTALL_DIR: "D:\\Codex" },
        spawnSync,
        statSync: readStat,
      }),
    ).toBe(native);
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it("accepts a native .com PATH executable", () => {
    const native = "C:\\tools\\codex.com";

    expect(
      resolveCodexCliExecutable("codex", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync: whereOutput(native),
        statSync: regularFiles(native),
      }),
    ).toBe(native);
  });

  it("honors a case-insensitive CODEX_INSTALL_DIR before a PATH batch shim", () => {
    const batch = "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd";
    const native = "D:\\OpenAI CLI\\codex.exe";

    expect(
      resolveCodexCliExecutable("codex", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { systemroot: "C:\\Windows", codex_install_dir: " D:\\OpenAI CLI " },
        spawnSync: whereOutput(batch),
        statSync: regularFiles(batch, native),
      }),
    ).toBe(native);
  });

  it("uses the documented standalone install before a PATH batch shim", () => {
    const batch = "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd";
    const native =
      "C:\\Users\\Test User\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe";

    expect(
      resolveCodexCliExecutable("codex", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: {
          SystemRoot: "C:\\Windows",
          localappdata: "C:\\Users\\Test User\\AppData\\Local",
        },
        spawnSync: whereOutput(batch),
        statSync: regularFiles(batch, native),
      }),
    ).toBe(native);
  });

  it("uses a valid PATH batch shim before the APPDATA npm fallback", () => {
    const pathBatch = "D:\\node\\codex.bat";
    const npmBatch = "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd";

    expect(
      resolveCodexCliExecutable("codex", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: {
          SystemRoot: "C:\\Windows",
          AppData: "C:\\Users\\test\\AppData\\Roaming",
        },
        spawnSync: whereOutput(pathBatch),
        statSync: regularFiles(pathBatch, npmBatch),
      }),
    ).toBe(pathBatch);
  });

  it("uses the case-insensitive APPDATA npm fallback when PATH resolution fails", () => {
    const npmBatch = "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd";

    expect(
      resolveCodexCliExecutable("codex", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: {
          SystemRoot: "C:\\Windows",
          appdata: "C:\\Users\\test\\AppData\\Roaming",
        },
        spawnSync: vi.fn(() => ({ stdout: "", status: 1 })),
        statSync: regularFiles(npmBatch),
      }),
    ).toBe(npmBatch);
  });

  it("rejects current-directory where.exe hits before validating candidates", () => {
    const cwdHit = "C:\\projects\\synara\\codex.exe";
    const safeNative = "C:\\tools\\codex.exe";
    const readStat = regularFiles(cwdHit, safeNative);

    expect(
      resolveCodexCliExecutable("codex", {
        platform: "win32",
        cwd: "C:\\PROJECTS\\SYNARA",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync: whereOutput(cwdHit, safeNative),
        statSync: readStat,
      }),
    ).toBe(safeNative);
    expect(readStat).not.toHaveBeenCalledWith(cwdHit);
  });

  it("rejects relative, drive-root-relative, missing, and non-file candidates", () => {
    const relative = "tools\\codex.exe";
    const driveRootRelative = "\\tools\\codex.exe";
    const missing = "C:\\missing\\codex.exe";
    const directory = "C:\\directory\\codex.exe";
    const fallback = "D:\\Codex\\codex.exe";
    const readStat = vi.fn((path: string) => {
      if (path === directory) {
        return { isFile: () => false };
      }
      if (path === fallback) {
        return { isFile: () => true };
      }
      throw Object.assign(new Error(`Missing file: ${path}`), { code: "ENOENT" });
    });

    expect(
      resolveCodexCliExecutable("codex", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows", CODEX_INSTALL_DIR: "D:\\Codex" },
        spawnSync: whereOutput(relative, driveRootRelative, missing, directory),
        statSync: readStat,
      }),
    ).toBe(fallback);
    expect(readStat).not.toHaveBeenCalledWith(relative);
    expect(readStat).not.toHaveBeenCalledWith(driveRootRelative);
  });

  it("does not read fallback values from process.env when an env is supplied", () => {
    const globalNative = "C:\\Global\\Programs\\OpenAI\\Codex\\bin\\codex.exe";
    vi.stubEnv("LOCALAPPDATA", "C:\\Global");
    const readStat = regularFiles(globalNative);

    expect(
      resolveCodexCliExecutable("codex", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync: vi.fn(() => ({ stdout: "", status: 1 })),
        statSync: readStat,
      }),
    ).toBe("codex");
    expect(readStat).not.toHaveBeenCalled();
  });

  it("returns bare codex when no valid candidate exists", () => {
    expect(
      resolveCodexCliExecutable("CODEX", {
        platform: "win32",
        cwd: "C:\\projects\\synara",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync: whereOutput("codex", "C:\\missing\\codex.cmd"),
        statSync: regularFiles(),
      }),
    ).toBe("codex");
  });
});
