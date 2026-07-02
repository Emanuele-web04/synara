// FILE: electronUpdaterSecurity.test.ts
// Purpose: Verifies the Windows updater hardening stays shell-free.
// Layer: Desktop update runtime tests

import { describe, expect, it, vi } from "vitest";

import {
  buildPowerShellExecArgs,
  buildPowerShellExecutablePath,
  hardenElectronUpdater,
  parseDistinguishedName,
  verifyWindowsUpdateCodeSignature,
} from "./electronUpdaterSecurity";

describe("electronUpdaterSecurity", () => {
  it("uses the absolute Windows PowerShell executable", () => {
    expect(buildPowerShellExecutablePath({ SystemRoot: "D:\\Windows" })).toBe(
      "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });

  it("runs PowerShell with arguments instead of a shell command", () => {
    const args = buildPowerShellExecArgs("Get-AuthenticodeSignature test.exe");

    expect(args).toContain("-NoProfile");
    expect(args).toContain("-NonInteractive");
    expect(args).toContain("-Command");
    expect(args.join(" ")).toContain("Get-AuthenticodeSignature test.exe");
    expect(args.join(" ")).not.toContain("cmd.exe");
  });

  it("parses distinguished names the same way as builder-util-runtime", () => {
    const parsed = parseDistinguishedName('CN=Synara, O="Acme, Inc.", OU=Tools\\2C Desktop');

    expect(parsed.get("CN")).toBe("Synara");
    expect(parsed.get("O")).toBe("Acme, Inc.");
    expect(parsed.get("OU")).toBe("Tools, Desktop");
  });

  it("validates a matching full distinguished name with shell-free execFile options", async () => {
    const execFile = vi.fn((file, args, options, callback) => {
      callback(
        null,
        JSON.stringify({
          Status: 0,
          Path: "C:\\Users\\test\\AppData\\Local\\Temp\\SynaraSetup.exe",
          SignerCertificate: {
            Subject: "CN=Synara, O=Acme Tools",
          },
        }),
        "",
      );
    });

    const result = await verifyWindowsUpdateCodeSignature(
      ["CN=Synara, O=Acme Tools"],
      "C:\\Users\\test\\AppData\\Local\\Temp\\SynaraSetup.exe",
      { info: vi.fn(), warn: vi.fn() },
      {
        env: { SystemRoot: "C:\\Windows" },
        execFile,
      },
    );

    expect(result).toBeNull();
    expect(execFile).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      expect.arrayContaining(["-NoProfile", "-NonInteractive", "-Command"]),
      expect.objectContaining({
        encoding: "utf8",
        shell: false,
        windowsHide: true,
        env: expect.objectContaining({ PSModulePath: "" }),
      }),
      expect.any(Function),
    );
  });

  it("keeps the upstream CN-only fallback warning", async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const result = await verifyWindowsUpdateCodeSignature(
      ["Synara"],
      "C:\\Temp\\SynaraSetup.exe",
      logger,
      {
        env: { SystemRoot: "C:\\Windows" },
        execFile: vi.fn((_file, _args, _options, callback) => {
          callback(
            null,
            JSON.stringify({
              Status: 0,
              Path: "C:\\Temp\\SynaraSetup.exe",
              SignerCertificate: { Subject: "CN=Synara, O=Acme Tools" },
            }),
            "",
          );
        }),
      },
    );

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Signature validated using only CN Synara"),
    );
  });

  it("returns a mismatch summary for an unexpected publisher", async () => {
    const result = await verifyWindowsUpdateCodeSignature(
      ["CN=Synara, O=Acme Tools"],
      "C:\\Temp\\SynaraSetup.exe",
      { info: vi.fn(), warn: vi.fn() },
      {
        env: { SystemRoot: "C:\\Windows" },
        execFile: vi.fn((_file, _args, _options, callback) => {
          callback(
            null,
            JSON.stringify({
              Status: 0,
              Path: "C:\\Temp\\SynaraSetup.exe",
              SignerCertificate: { Subject: "CN=Someone Else, O=Acme Tools" },
            }),
            "",
          );
        }),
      },
    );

    expect(result).toContain("publisherNames: CN=Synara, O=Acme Tools");
    expect(result).toContain("Someone Else");
  });

  it("patches electron-updater BaseUpdater spawnSyncLog only on Windows", () => {
    class FakeBaseUpdater {}
    const updaterModule = { BaseUpdater: FakeBaseUpdater };
    const prototype = FakeBaseUpdater.prototype as {
      spawnSyncLog?: (cmd: string, args?: string[]) => string;
      __synaraSpawnSyncLogPatched?: boolean;
    };

    hardenElectronUpdater(updaterModule, {}, "darwin");
    expect("spawnSyncLog" in prototype).toBe(false);

    hardenElectronUpdater(updaterModule, {}, "win32");
    const instance = {
      _logger: { info: vi.fn(), error: vi.fn() },
    };
    const output = prototype.spawnSyncLog?.call(instance, process.execPath, ["--version"]);

    expect(output).toMatch(/^v\d+\.\d+\.\d+/);
    expect(prototype.__synaraSpawnSyncLogPatched).toBe(true);
  });

  it("replaces the NSIS signature verifier on Windows", async () => {
    const updater = {
      verifyUpdateCodeSignature: vi.fn(async () => "old verifier"),
    };
    const oldVerifier = updater.verifyUpdateCodeSignature;

    hardenElectronUpdater({ BaseUpdater: class {} }, updater, "win32");

    expect(updater.verifyUpdateCodeSignature).not.toBe(oldVerifier);
    expect(oldVerifier).not.toHaveBeenCalled();
  });
});
