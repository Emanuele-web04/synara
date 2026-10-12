import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildCodexMcpConfigToml } from "./agentGateway/mcpInjection";
import {
  buildCodexProcessEnv,
  buildCodexProcessLaunchContext,
  prepareCodexAuthTracking,
  readCodexAuthFingerprintAsync,
  readCodexPreparedAuthTrackingFingerprint,
  readCodexSharedContinuationGeneration,
  resolveCodexProcessSourceEnvironment,
  type CodexProcessEnvInput,
} from "./codexProcessEnv";
import {
  prepareProviderContinuationIdentity,
  providerContinuationIdentity,
} from "./provider/continuationIdentity";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function fixture(withAuth = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "synara-nested-codex-")));
  roots.push(root);
  const sourceHome = path.join(root, "home");
  const parentRuntime = path.join(root, "parent");
  const childRuntime = path.join(root, "child");
  fs.mkdirSync(sourceHome);
  const sourceConfig = 'profile = "work"\n[profiles.work]\nmodel = "gpt-5.6-sol"\n';
  fs.writeFileSync(path.join(sourceHome, "config.toml"), sourceConfig);
  if (withAuth) {
    fs.writeFileSync(path.join(sourceHome, "auth.json"), '{"OPENAI_API_KEY":"dummy-default"}');
  }
  const parentEnv = await buildCodexProcessEnv({
    env: { CODEX_HOME: sourceHome, SYNARA_HOME: parentRuntime },
    platform: "win32",
    appendConfigToml: buildCodexMcpConfigToml("http://127.0.0.1:61240/mcp"),
  });
  const parentOverlay = parentEnv.CODEX_HOME!;
  const parentConfig = fs.readFileSync(path.join(parentOverlay, "config.toml"), "utf8");
  const input: CodexProcessEnvInput = {
    env: { ...parentEnv, SYNARA_HOME: childRuntime },
    platform: "win32",
    appendConfigToml: buildCodexMcpConfigToml("http://127.0.0.1:64449/mcp"),
  };
  return {
    root,
    sourceHome,
    parentRuntime,
    childRuntime,
    parentOverlay,
    parentConfig,
    sourceConfig,
    input,
  };
}

describe("a nested default Codex source", () => {
  it("launches directly from a real parent overlay with one shared source and a new MCP endpoint", async () => {
    const f = await fixture();
    const parentIdentity = providerContinuationIdentity("codex", {
      codex: { homePath: f.sourceHome, environment: { SYNARA_HOME: f.parentRuntime } },
    });
    const launch = await buildCodexProcessLaunchContext(f.input);
    const childOverlay = path.join(f.childRuntime, "codex-home-overlay");
    expect(launch.env.CODEX_HOME).toBe(childOverlay);
    expect(launch.env.CODEX_HOME).not.toBe(f.parentOverlay);
    expect(launch.env.CODEX_SQLITE_HOME).toBe(f.sourceHome);
    expect(launch.appServerArgs).toContain(`sqlite_home=${JSON.stringify(f.sourceHome)}`);
    expect(launch.authTracking.authoritativeAuthFilePath).toBe(
      path.join(f.sourceHome, "auth.json"),
    );
    expect(launch.authTracking.sourceConfigPath).toBe(path.join(f.sourceHome, "config.toml"));
    for (const name of [
      "sessions",
      "archived_sessions",
      "history.jsonl",
      "session_index.jsonl",
      "auth.json",
    ]) {
      expect(fs.lstatSync(path.join(childOverlay, name)).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(path.join(childOverlay, name))).toBe(path.join(f.sourceHome, name));
    }
    const childConfig = fs.readFileSync(path.join(childOverlay, "config.toml"), "utf8");
    expect(childConfig).toContain('url = "http://127.0.0.1:64449/mcp"');
    expect(childConfig).not.toContain("http://127.0.0.1:61240/mcp");
    expect(childConfig.match(/^\[mcp_servers\.synara\]$/gm)).toHaveLength(1);
    expect(childConfig).toContain('[profiles.work]\nmodel = "gpt-5.6-sol"');
    expect(fs.readFileSync(path.join(f.parentOverlay, "config.toml"), "utf8")).toBe(f.parentConfig);
    expect(fs.readFileSync(path.join(f.sourceHome, "config.toml"), "utf8")).toBe(f.sourceConfig);
    expect(fs.readFileSync(path.join(f.sourceHome, "auth.json"), "utf8")).toBe(
      '{"OPENAI_API_KEY":"dummy-default"}',
    );
    expect(fs.lstatSync(path.join(f.parentOverlay, "auth.json")).isSymbolicLink()).toBe(true);
    expect(readCodexSharedContinuationGeneration(f.input)).toBeDefined();
    await expect(readCodexAuthFingerprintAsync(f.input)).resolves.toBe(launch.authFingerprint);

    vi.stubEnv("CODEX_HOME", f.parentOverlay);
    vi.stubEnv("CODEX_SQLITE_HOME", f.sourceHome);
    vi.stubEnv("SYNARA_HOME", f.childRuntime);
    expect(providerContinuationIdentity("codex", undefined)).toBe(parentIdentity);
    await expect(
      prepareProviderContinuationIdentity("codex", undefined, parentIdentity),
    ).resolves.toBe(parentIdentity);
  });

  it("keeps a logged-out parent and source logged out", async () => {
    const f = await fixture(false);
    const launch = await buildCodexProcessLaunchContext(f.input);
    expect(launch.env.CODEX_SQLITE_HOME).toBe(f.sourceHome);
    expect(launch.authFingerprint).toBe('{"storeMode":"file","auth":{"state":"missing"}}');
    expect(fs.existsSync(path.join(launch.env.CODEX_HOME!, "auth.json"))).toBe(false);
  });

  it("revalidates the inherited source without synchronous filesystem work", async () => {
    const f = await fixture();
    const expected = readCodexPreparedAuthTrackingFingerprint(prepareCodexAuthTracking(f.input));
    for (const method of [
      "realpathSync",
      "lstatSync",
      "statSync",
      "openSync",
      "readFileSync",
      "fstatSync",
      "closeSync",
    ] as const) {
      vi.spyOn(fs, method).mockImplementation(() => {
        throw new Error(`blocking ${method}`);
      });
    }
    await expect(readCodexAuthFingerprintAsync(f.input)).resolves.toBe(expected);
  });

  it.each([
    "private-auth",
    "missing-parent-auth",
    "missing-marker",
    "wrong-marker",
    "divergent-archive",
    "source-archive-link",
    "parent-directory-link",
  ] as const)("keeps existing guards when inherited ownership is unproven: %s", async (damage) => {
    const f = await fixture();
    if (damage === "private-auth" || damage === "missing-parent-auth") {
      fs.unlinkSync(path.join(f.parentOverlay, "auth.json"));
      if (damage === "private-auth")
        fs.writeFileSync(
          path.join(f.parentOverlay, "auth.json"),
          '{"OPENAI_API_KEY":"dummy-private"}',
        );
    } else if (damage === "missing-marker") {
      fs.unlinkSync(path.join(f.sourceHome, "synara-shared-continuation-v2.json"));
    } else if (damage === "wrong-marker") {
      const markerPath = path.join(f.sourceHome, "synara-shared-continuation-v2.json");
      const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
      fs.writeFileSync(
        markerPath,
        JSON.stringify({ ...marker, sourceHomeIdentity: f.parentOverlay }),
      );
    } else if (damage === "divergent-archive") {
      const otherArchive = path.join(f.root, "other-archive");
      fs.mkdirSync(otherArchive);
      fs.unlinkSync(path.join(f.parentOverlay, "archived_sessions"));
      fs.symlinkSync(otherArchive, path.join(f.parentOverlay, "archived_sessions"));
    } else if (damage === "source-archive-link") {
      const archive = path.join(f.sourceHome, "archived_sessions");
      fs.renameSync(archive, `${archive}-real`);
      fs.symlinkSync(`${archive}-real`, archive);
    } else {
      fs.renameSync(f.parentOverlay, `${f.parentOverlay}-real`);
      fs.symlinkSync(`${f.parentOverlay}-real`, f.parentOverlay);
    }
    expect(resolveCodexProcessSourceEnvironment(f.input).CODEX_HOME).toBe(f.parentOverlay);
    await expect(buildCodexProcessLaunchContext(f.input)).rejects.toThrow();
    expect(fs.readFileSync(path.join(f.parentOverlay, "config.toml"), "utf8")).toBe(f.parentConfig);
    expect(fs.readFileSync(path.join(f.sourceHome, "config.toml"), "utf8")).toBe(f.sourceConfig);
    expect(fs.existsSync(path.join(f.childRuntime, "codex-home-overlay", "config.toml"))).toBe(
      false,
    );
  });

  it.each(["home", "shadow", "account", "environment-home", "environment-sqlite"] as const)(
    "does not reinterpret explicit %s selection",
    async (selection) => {
      const f = await fixture();
      const input: CodexProcessEnvInput = {
        ...f.input,
        ...(selection === "home" ? { homePath: f.parentOverlay } : {}),
        ...(selection === "shadow" ? { shadowHomePath: path.join(f.root, "private") } : {}),
        ...(selection === "account" ? { accountId: "work" } : {}),
        ...(selection === "environment-home"
          ? { explicitProviderEnvironment: { CODEX_HOME: f.parentOverlay } }
          : {}),
        ...(selection === "environment-sqlite"
          ? { explicitProviderEnvironment: { CODEX_SQLITE_HOME: f.sourceHome } }
          : {}),
      };
      expect(resolveCodexProcessSourceEnvironment(input).CODEX_HOME).toBe(f.parentOverlay);
      await expect(buildCodexProcessLaunchContext(input)).rejects.toThrow();
    },
  );

  it("rejects a parent that acquires private auth during child preparation", async () => {
    const f = await fixture();
    const childAuthPath = path.join(f.childRuntime, "codex-home-overlay", "auth.json");
    const parentAuthPath = path.join(f.parentOverlay, "auth.json");
    await expect(
      buildCodexProcessLaunchContext({
        ...f.input,
        overlayEntryLinker: {
          copyFile: fs.promises.copyFile,
          symlink: async (target, linkPath, type) => {
            await fs.promises.symlink(target, linkPath, type);
            if (linkPath === childAuthPath) {
              fs.unlinkSync(parentAuthPath);
              fs.writeFileSync(parentAuthPath, '{"OPENAI_API_KEY":"dummy-private"}');
            }
          },
        },
      }),
    ).rejects.toThrow("source home changed during app-server launch preparation");
    expect(fs.readFileSync(path.join(f.sourceHome, "auth.json"), "utf8")).toBe(
      '{"OPENAI_API_KEY":"dummy-default"}',
    );
  });
});
