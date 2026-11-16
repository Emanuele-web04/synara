// FILE: openCodeConfigPaths.test.ts
// Purpose: Locks the OpenCode config path resolution order and the config
//          fingerprint used to invalidate the model discovery cache.
// Layer: Server provider tests

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import nodePath from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  openCodeCompatibleConfigFingerprint,
  resolveOpenCodeCompatibleConfigPaths,
} from "./openCodeConfigPaths.ts";

const homeDir = "/home/user";

describe("resolveOpenCodeCompatibleConfigPaths", () => {
  it("uses ~/.config on Linux and does not consult AppData", () => {
    const paths = resolveOpenCodeCompatibleConfigPaths({
      homeDir,
      platform: "linux",
      env: {},
      dataDirectoryName: "opencode",
    });

    expect(paths).toEqual([
      nodePath.join(homeDir, ".config", "opencode", "opencode.json"),
      nodePath.join(homeDir, ".config", "opencode", "opencode.jsonc"),
    ]);
    expect(paths.some((value) => /appdata/i.test(value))).toBe(false);
  });

  it("honors XDG_CONFIG_HOME on every platform before the default ~/.config path", () => {
    const paths = resolveOpenCodeCompatibleConfigPaths({
      homeDir,
      platform: "linux",
      env: { XDG_CONFIG_HOME: "/custom/config" },
      dataDirectoryName: "opencode",
    });

    expect(paths[0]).toBe(nodePath.join("/custom/config", "opencode", "opencode.json"));
    expect(paths).toContain(nodePath.join(homeDir, ".config", "opencode", "opencode.json"));
  });

  it("honors the OPENCODE_CONFIG_DIR override first", () => {
    const paths = resolveOpenCodeCompatibleConfigPaths({
      homeDir,
      platform: "linux",
      env: { OPENCODE_CONFIG_DIR: "/override/opencode" },
      dataDirectoryName: "opencode",
    });

    expect(paths.slice(0, 2)).toEqual([
      nodePath.join("/override/opencode", "opencode.json"),
      nodePath.join("/override/opencode", "opencode.jsonc"),
    ]);
  });

  it("uses the driver's own directory name (kilo) without an OPENCODE override", () => {
    const paths = resolveOpenCodeCompatibleConfigPaths({
      homeDir,
      platform: "linux",
      env: { OPENCODE_CONFIG_DIR: "/should/not/apply" },
      dataDirectoryName: "kilo",
    });

    expect(paths).toEqual([
      nodePath.join(homeDir, ".config", "kilo", "opencode.json"),
      nodePath.join(homeDir, ".config", "kilo", "opencode.jsonc"),
    ]);
  });

  it("adds the Windows APPDATA fallback", () => {
    const paths = resolveOpenCodeCompatibleConfigPaths({
      homeDir,
      platform: "win32",
      env: {},
      dataDirectoryName: "opencode",
    });

    expect(paths).toContain(
      nodePath.join(homeDir, "AppData", "Roaming", "opencode", "opencode.json"),
    );
  });
});

describe("openCodeCompatibleConfigFingerprint", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  const fixture = () => {
    const directory = mkdtempSync(nodePath.join(tmpdir(), "opencode-config-fingerprint-"));
    directories.push(directory);
    return directory;
  };

  it("returns null when no config file exists", async () => {
    const home = fixture();

    await expect(
      openCodeCompatibleConfigFingerprint({
        homeDir: home,
        platform: "linux",
        env: {},
        dataDirectoryName: "opencode",
      }),
    ).resolves.toBeNull();
  });

  it("changes when the config file contents change", async () => {
    const home = fixture();
    const configDir = nodePath.join(home, ".config", "opencode");
    const configPath = nodePath.join(configDir, "opencode.json");

    await expect(
      openCodeCompatibleConfigFingerprint({
        homeDir: home,
        platform: "linux",
        env: {},
        dataDirectoryName: "opencode",
      }),
    ).resolves.toBeNull();

    // Creating the file must change the fingerprint (null -> value).
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, '{"provider":{}}', { flag: "w" });
    const created = await openCodeCompatibleConfigFingerprint({
      homeDir: home,
      platform: "linux",
      env: {},
      dataDirectoryName: "opencode",
    });
    expect(created).not.toBeNull();

    // A rename inside the file changes its size, so the fingerprint must move.
    writeFileSync(configPath, '{"provider":{"renamed-model":{}}}');
    const renamed = await openCodeCompatibleConfigFingerprint({
      homeDir: home,
      platform: "linux",
      env: {},
      dataDirectoryName: "opencode",
    });
    expect(renamed).not.toBe(created);
  });
});
