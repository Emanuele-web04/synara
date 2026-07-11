import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  chmodSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  buildCodexAppServerArgs,
  buildCodexProcessLaunchContext,
  buildCodexProcessEnv,
  disableCodexConfigSections,
  isCodexSharedContinuationStatePrepared,
  linkOrCopyCodexOverlayEntry,
  prioritizeCodexOverlayEntries,
} from "./codexProcessEnv";
import { isProviderCredentialKey } from "./providerChildEnvironment.ts";
import { buildCodexMcpConfigToml } from "./agentGateway/mcpInjection.ts";
import { resolveActiveCodexHomeWritePath } from "./codexHomePaths.ts";

describe("linkOrCopyCodexOverlayEntry", () => {
  it("copies auth.json when symlink creation is unavailable", async () => {
    const symlink = vi.fn(async () => {
      throw new Error("symlinks unavailable");
    });
    const copyFile = vi.fn(async () => undefined);

    await linkOrCopyCodexOverlayEntry(
      {
        entryName: "auth.json",
        sourcePath: "C:\\Users\\test\\.codex\\auth.json",
        targetPath: "C:\\Users\\test\\.synara\\codex-home-overlay\\auth.json",
        type: "file",
      },
      { symlink, copyFile },
    );

    expect(symlink).toHaveBeenCalledWith(
      "C:\\Users\\test\\.codex\\auth.json",
      "C:\\Users\\test\\.synara\\codex-home-overlay\\auth.json",
      "file",
    );
    expect(copyFile).toHaveBeenCalledWith(
      "C:\\Users\\test\\.codex\\auth.json",
      "C:\\Users\\test\\.synara\\codex-home-overlay\\auth.json",
    );
  });

  it("keeps symlink failures visible for other overlay entries", async () => {
    const symlink = vi.fn(async () => {
      throw new Error("symlinks unavailable");
    });

    await expect(
      linkOrCopyCodexOverlayEntry(
        {
          entryName: "sessions",
          sourcePath: "C:\\Users\\test\\.codex\\sessions",
          targetPath: "C:\\Users\\test\\.synara\\codex-home-overlay\\sessions",
          type: "dir",
        },
        { symlink, copyFile: vi.fn(async () => undefined) },
      ),
    ).rejects.toThrow("symlinks unavailable");
  });
});

describe("prioritizeCodexOverlayEntries", () => {
  it("prepares auth.json before entries whose symlinks may fail first", () => {
    expect(prioritizeCodexOverlayEntries(["sessions", "auth.json", "config.toml"])).toEqual([
      "auth.json",
      "sessions",
      "config.toml",
    ]);
  });
});

describe("disableCodexConfigSections", () => {
  const canonicalHeader = '[plugins."computer-use@openai-bundled"]';

  it.each([
    ["literal-quoted", "[plugins.'computer-use@openai-bundled']"],
    ["whitespace-varied", '[ plugins . "computer-use@openai-bundled" ]'],
    ["escaped basic-quoted", String.raw`[plugins."computer-use\u0040openai-bundled"]`],
    ["trailing-comment", "[plugins.'computer-use@openai-bundled'] # keep this comment"],
  ])("disables a semantically equivalent %s table without appending a duplicate", (_, header) => {
    const result = disableCodexConfigSections(
      `${header}\nenabled = true\n\n[plugins.other]\nenabled = true`,
      [canonicalHeader],
      true,
    );

    expect(result).toBe(`${header}\nenabled = false\n\n[plugins.other]\nenabled = true`);
    expect(result.match(/enabled = false/g)).toHaveLength(1);
    expect(result).not.toContain(canonicalHeader);
  });
});

describe("buildCodexProcessEnv", () => {
  it("repairs mixed transports in the saved gateway config during an auth probe", async () => {
    const sourceHome = mkdtempSync(path.join(os.tmpdir(), "synara-codex-source-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "synara-codex-runtime-"));
    const sourceConfig = [
      "[mcp_servers.synara]",
      'command = "external-bridge"',
      "args = []",
      "[mcp_servers.user-tool]",
      'command = "user-tool"',
      "",
    ].join("\n");
    const sourceConfigPath = path.join(sourceHome, "config.toml");
    writeFileSync(sourceConfigPath, sourceConfig);
    const input = { env: { SYNARA_HOME: runtimeHome }, homePath: sourceHome };
    const managedConfig = buildCodexMcpConfigToml("http://127.0.0.1:3773/mcp");

    try {
      const env = await buildCodexProcessEnv({ ...input, appendConfigToml: managedConfig });
      const overlayConfigPath = path.join(env.CODEX_HOME!, "config.toml");
      const cleanConfig = readFileSync(overlayConfigPath, "utf8");
      // An external MCP registration can leave stdio fields in the saved HTTP block.
      writeFileSync(
        overlayConfigPath,
        cleanConfig
          .replace(
            "[mcp_servers.synara]",
            '[mcp_servers.synara]\ncommand = "external-bridge"\nargs = [\n  "serve",\n]\ncwd = "/tmp"',
          )
          .replace(
            "[shell_environment_policy]",
            '[mcp_servers.synara.env]\nSTDIO_ONLY = "value"\n\n[shell_environment_policy]',
          ),
      );

      await buildCodexProcessEnv(input);

      expect(readFileSync(overlayConfigPath, "utf8")).toBe(cleanConfig);
      expect(readFileSync(sourceConfigPath, "utf8")).toBe(sourceConfig);
    } finally {
      rmSync(sourceHome, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it("pins app-server continuation and credential-store config at CLI precedence", async () => {
    const codexHome = mkdtempSync(path.join(os.tmpdir(), 'synara-codex-home-"quoted"-'));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "synara-runtime-home-"));
    writeFileSync(path.join(codexHome, "config.toml"), "", "utf8");

    try {
      const launch = await buildCodexProcessLaunchContext({
        env: {
          SYNARA_HOME: runtimeHome,
          CODEX_SQLITE_HOME: path.join(runtimeHome, "inherited-wrong-home"),
        },
        homePath: codexHome,
        platform: "win32",
      });

      expect(launch.env.CODEX_SQLITE_HOME).toBe(codexHome);
      expect(launch.appServerArgs).toEqual([
        "app-server",
        "--config",
        `sqlite_home=${JSON.stringify(codexHome)}`,
        "--config",
        'cli_auth_credentials_store="file"',
      ]);
      expect(launch.appServerArgs).toEqual(buildCodexAppServerArgs(codexHome));
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it("registers the active custom provider env key for diagnostic redaction", async () => {
    const codexHome = mkdtempSync(path.join(os.tmpdir(), "synara-codex-provider-key-"));
    writeFileSync(
      path.join(codexHome, "config.toml"),
      [
        'model_provider = "acme"',
        "",
        "[model_providers.acme]",
        'env_key = "ACME-LICENSE.INTEGRATION"',
      ].join("\n"),
      "utf8",
    );

    try {
      await buildCodexProcessEnv({ env: { CODEX_HOME: codexHome }, platform: "win32" });
      expect(isProviderCredentialKey("ACME-LICENSE.INTEGRATION")).toBe(true);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("pins CODEX_SQLITE_HOME to the source home for the session overlay", async () => {
    const codexHome = mkdtempSync(path.join(os.tmpdir(), "synara-codex-sqlite-home-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "synara-runtime-home-"));
    const sqliteHome = mkdtempSync(path.join(os.tmpdir(), "synara-user-sqlite-home-"));
    writeFileSync(path.join(codexHome, "config.toml"), 'model = "gpt-5.5"', "utf8");

    try {
      const env = await buildCodexProcessEnv({
        env: { SYNARA_HOME: runtimeHome, CODEX_SQLITE_HOME: sqliteHome },
        homePath: codexHome,
        platform: "win32",
      });

      expect(env.CODEX_HOME).toBe(path.join(runtimeHome, "codex-home-overlay"));
      expect(env.CODEX_SQLITE_HOME).toBe(codexHome);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
      rmSync(sqliteHome, { recursive: true, force: true });
    }
  });

  it("rejects a config sqlite_home that escapes the source Codex home", async () => {
    const codexHome = mkdtempSync(path.join(os.tmpdir(), "synara-codex-sqlite-config-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "synara-runtime-home-"));
    writeFileSync(path.join(codexHome, "config.toml"), 'sqlite_home = "/tmp/other-codex"', "utf8");

    try {
      await expect(
        buildCodexProcessEnv({
          env: { SYNARA_HOME: runtimeHome },
          homePath: codexHome,
          platform: "win32",
        }),
      ).rejects.toThrow(/sqlite_home.*source CODEX_HOME/);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it("rejects root sqlite_home despite a misleading selected-profile source path", async () => {
    const codexHome = mkdtempSync(path.join(os.tmpdir(), "synara-codex-sqlite-root-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "synara-runtime-home-"));
    writeFileSync(
      path.join(codexHome, "config.toml"),
      [
        'profile = "work"',
        'sqlite_home = "/tmp/foreign-codex-home"',
        "",
        "[profiles.work]",
        `sqlite_home = ${JSON.stringify(codexHome)}`,
      ].join("\n"),
      "utf8",
    );

    try {
      await expect(
        buildCodexProcessEnv({
          env: { SYNARA_HOME: runtimeHome },
          homePath: codexHome,
          platform: "win32",
        }),
      ).rejects.toThrow(/sqlite_home.*source CODEX_HOME/);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it("ignores profile sqlite_home lookalikes that Codex does not apply", async () => {
    const codexHome = mkdtempSync(path.join(os.tmpdir(), "synara-codex-sqlite-profile-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "synara-runtime-home-"));
    writeFileSync(
      path.join(codexHome, "config.toml"),
      ['profile = "work"', "", "[profiles.work]", 'sqlite_home = "/tmp/ignored-profile-home"'].join(
        "\n",
      ),
      "utf8",
    );

    try {
      const env = await buildCodexProcessEnv({
        env: { SYNARA_HOME: runtimeHome },
        homePath: codexHome,
        platform: "win32",
      });
      expect(env.CODEX_SQLITE_HOME).toBe(codexHome);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it("replaces a user-defined Synara MCP table only inside the session overlay", async () => {
    const sourceHome = mkdtempSync(path.join(os.tmpdir(), "synara-codex-source-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "synara-codex-runtime-"));
    const sourceConfig = [
      'model = "gpt-5.5"',
      "",
      "[mcp_servers.synara]",
      'url = "http://127.0.0.1:1111/stale-mcp"',
      'bearer_token_env_var = "STALE_GATEWAY_TOKEN"',
      "",
      "[mcp_servers.synara.headers]",
      'Authorization = "stale-inline-secret"',
      "",
      "[mcp_servers.synara.env]",
      'STALE_GATEWAY_TOKEN = "stale-inline-secret"',
      "",
      "[mcp_servers.synara-other]",
      'url = "http://127.0.0.1:2111/synara-other"',
      "",
      "[mcp_servers.user-tool]",
      'url = "http://127.0.0.1:2222/user-tool"',
      "",
      "[shell_environment_policy]",
      'inherit = "core"',
      'exclude = ["USER_SECRET"]',
    ].join("\n");
    const managedConfig = [
      "[mcp_servers.synara]",
      'url = "http://127.0.0.1:3773/mcp"',
      'bearer_token_env_var = "SYNARA_AGENT_GATEWAY_TOKEN"',
      "",
      "[shell_environment_policy]",
      'exclude = ["SYNARA_AGENT_GATEWAY_TOKEN"]',
    ].join("\n");
    const sourceConfigPath = path.join(sourceHome, "config.toml");
    writeFileSync(sourceConfigPath, sourceConfig, "utf8");

    try {
      const env = await buildCodexProcessEnv({
        env: { SYNARA_HOME: runtimeHome },
        homePath: sourceHome,
        platform: "darwin",
        appendConfigToml: managedConfig,
      });
      const overlayHome = env.CODEX_HOME;
      if (!overlayHome) {
        throw new Error("Expected a Synara Codex home overlay.");
      }
      const overlayConfig = readFileSync(path.join(overlayHome, "config.toml"), "utf8");

      expect(overlayConfig.match(/^\[mcp_servers\.synara\]$/gm)).toHaveLength(1);
      expect(overlayConfig).toContain('url = "http://127.0.0.1:3773/mcp"');
      expect(overlayConfig).toContain('bearer_token_env_var = "SYNARA_AGENT_GATEWAY_TOKEN"');
      expect(overlayConfig).not.toContain("http://127.0.0.1:1111/stale-mcp");
      expect(overlayConfig).not.toContain("STALE_GATEWAY_TOKEN");
      expect(overlayConfig).not.toContain("stale-inline-secret");
      expect(overlayConfig).not.toContain("[mcp_servers.synara.headers]");
      expect(overlayConfig).not.toContain("[mcp_servers.synara.env]");
      expect(overlayConfig).toContain(
        '[mcp_servers.synara-other]\nurl = "http://127.0.0.1:2111/synara-other"',
      );
      expect(overlayConfig).toContain(
        '[mcp_servers.user-tool]\nurl = "http://127.0.0.1:2222/user-tool"',
      );
      expect(overlayConfig).toContain('inherit = "core"');
      expect(overlayConfig).toContain('exclude = ["SYNARA_AGENT_GATEWAY_TOKEN", "USER_SECRET"]');
      expect(readFileSync(sourceConfigPath, "utf8")).toBe(sourceConfig);
    } finally {
      rmSync(sourceHome, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });
});

describe("buildCodexProcessEnv account overlays", () => {
  function makeAccountFixture() {
    const root = mkdtempSync(path.join(os.tmpdir(), "synara-codex-account-overlay-"));
    const homePath = path.join(root, "codex-home");
    const shadowHomePath = path.join(root, "codex-shadow-work");
    mkdirSync(homePath, { recursive: true });
    mkdirSync(shadowHomePath, { recursive: true });
    writeFileSync(path.join(homePath, "auth.json"), '{"account":"default"}', "utf8");
    writeFileSync(path.join(homePath, "models_cache.json"), '{"models":[]}', "utf8");
    writeFileSync(path.join(homePath, "config.toml"), "", "utf8");
    return {
      root,
      homePath,
      shadowHomePath,
      env: {
        HOME: root,
        SYNARA_HOME: path.join(root, "synara-runtime"),
      } satisfies NodeJS.ProcessEnv,
    };
  }

  it("shares continuation state across account overlays while keeping private state separate", async () => {
    const fixture = makeAccountFixture();
    const personalShadowHomePath = path.join(fixture.root, "codex-shadow-personal");
    mkdirSync(personalShadowHomePath, { recursive: true });
    writeFileSync(path.join(personalShadowHomePath, "auth.json"), '{"account":"personal"}', "utf8");
    writeFileSync(path.join(fixture.shadowHomePath, "auth.json"), '{"account":"work"}', "utf8");

    try {
      const personalEnv = await buildCodexProcessEnv({
        env: fixture.env,
        homePath: fixture.homePath,
        shadowHomePath: personalShadowHomePath,
        accountId: "personal",
        platform: "win32",
      });
      expect(personalEnv.CODEX_HOME).toBeTruthy();
      expect(personalEnv.CODEX_SQLITE_HOME).toBe(fixture.homePath);
      expect(
        isCodexSharedContinuationStatePrepared({
          env: fixture.env,
          homePath: fixture.homePath,
          shadowHomePath: personalShadowHomePath,
          accountId: "personal",
        }),
      ).toBe(true);
      const personalSessionsPath = path.join(personalEnv.CODEX_HOME!, "sessions");
      expect(lstatSync(personalSessionsPath).isSymbolicLink()).toBe(true);
      writeFileSync(path.join(personalSessionsPath, "thread-personal.jsonl"), "personal", "utf8");

      const workEnv = await buildCodexProcessEnv({
        env: fixture.env,
        homePath: fixture.homePath,
        shadowHomePath: fixture.shadowHomePath,
        accountId: "work",
        platform: "win32",
      });
      expect(workEnv.CODEX_HOME).not.toBe(personalEnv.CODEX_HOME);
      expect(workEnv.CODEX_SQLITE_HOME).toBe(fixture.homePath);
      expect(
        readFileSync(path.join(workEnv.CODEX_HOME!, "sessions", "thread-personal.jsonl"), "utf8"),
      ).toBe("personal");
      expect(path.resolve(readlinkSync(path.join(workEnv.CODEX_HOME!, "auth.json")))).toBe(
        path.resolve(path.join(fixture.shadowHomePath, "auth.json")),
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("preserves legacy-only continuation state and requires an explicit migration", async () => {
    const fixture = makeAccountFixture();
    writeFileSync(path.join(fixture.shadowHomePath, "auth.json"), '{"account":"work"}', "utf8");
    const overlayHomePath = resolveActiveCodexHomeWritePath({
      env: fixture.env,
      homePath: fixture.homePath,
      shadowHomePath: fixture.shadowHomePath,
      accountId: "work",
    });
    mkdirSync(path.join(overlayHomePath, "sessions"), { recursive: true });
    writeFileSync(path.join(overlayHomePath, "sessions", "legacy.jsonl"), "legacy", "utf8");

    try {
      await expect(
        buildCodexProcessEnv({
          env: fixture.env,
          homePath: fixture.homePath,
          shadowHomePath: fixture.shadowHomePath,
          accountId: "work",
          platform: "win32",
        }),
      ).rejects.toThrow(/refusing to migrate legacy state automatically/);
      expect(readFileSync(path.join(overlayHomePath, "sessions", "legacy.jsonl"), "utf8")).toBe(
        "legacy",
      );
      expect(() => lstatSync(path.join(fixture.homePath, "sessions"))).toThrow();
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("links account-private auth from the shadow home instead of the shared home", async () => {
    const fixture = makeAccountFixture();
    const shadowAuthPath = path.join(fixture.shadowHomePath, "auth.json");
    writeFileSync(shadowAuthPath, '{"account":"work"}', "utf8");

    try {
      const env = await buildCodexProcessEnv({
        env: fixture.env,
        homePath: fixture.homePath,
        shadowHomePath: fixture.shadowHomePath,
        accountId: "work",
        platform: "win32",
      });

      expect(env.CODEX_HOME).toBeTruthy();
      expect(path.resolve(env.CODEX_HOME!)).not.toBe(path.resolve(fixture.homePath));
      const overlayAuthPath = path.join(env.CODEX_HOME!, "auth.json");
      expect(lstatSync(overlayAuthPath).isSymbolicLink()).toBe(true);
      expect(path.resolve(readlinkSync(overlayAuthPath))).toBe(path.resolve(shadowAuthPath));
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails when shadow-home auth cannot be linked into the account overlay", async () => {
    const fixture = makeAccountFixture();
    writeFileSync(path.join(fixture.shadowHomePath, "auth.json"), '{"account":"work"}', "utf8");
    const firstEnv = await buildCodexProcessEnv({
      env: fixture.env,
      homePath: fixture.homePath,
      shadowHomePath: fixture.shadowHomePath,
      accountId: "work",
      platform: "win32",
    });
    const overlayHomePath = firstEnv.CODEX_HOME;
    expect(overlayHomePath).toBeTruthy();
    if (!overlayHomePath) {
      throw new Error("Expected Codex overlay home path.");
    }
    unlinkSync(path.join(overlayHomePath, "auth.json"));
    chmodSync(overlayHomePath, 0o500);
    try {
      await expect(
        buildCodexProcessEnv({
          env: fixture.env,
          homePath: fixture.homePath,
          shadowHomePath: fixture.shadowHomePath,
          accountId: "work",
          platform: "win32",
        }),
      ).rejects.toThrow(/EACCES|EPERM/);
    } finally {
      chmodSync(overlayHomePath, 0o700);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("tolerates shadow homes with no auth state yet", async () => {
    const fixture = makeAccountFixture();

    try {
      const env = await buildCodexProcessEnv({
        env: fixture.env,
        homePath: fixture.homePath,
        shadowHomePath: fixture.shadowHomePath,
        accountId: "work",
        platform: "win32",
      });

      expect(env.CODEX_HOME).toBeTruthy();
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each(["auth.json", "models_cache.json"] as const)(
    "rejects shadow-home %s state that is itself a symlink",
    async (entryName) => {
      const fixture = makeAccountFixture();
      symlinkSync(
        path.join(fixture.homePath, "auth.json"),
        path.join(fixture.shadowHomePath, entryName),
      );

      try {
        await expect(
          buildCodexProcessEnv({
            env: fixture.env,
            homePath: fixture.homePath,
            shadowHomePath: fixture.shadowHomePath,
            accountId: "work",
            platform: "win32",
          }),
        ).rejects.toThrow(/is a symlink/);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it("rejects a shadow home directory that is itself a symlink", async () => {
    const fixture = makeAccountFixture();
    const aliasedShadowHome = path.join(path.dirname(fixture.shadowHomePath), "codex-shadow-alias");
    rmSync(fixture.shadowHomePath, { recursive: true, force: true });
    symlinkSync(fixture.homePath, aliasedShadowHome);

    try {
      await expect(
        buildCodexProcessEnv({
          env: fixture.env,
          homePath: fixture.homePath,
          shadowHomePath: aliasedShadowHome,
          accountId: "work",
          platform: "win32",
        }),
      ).rejects.toThrow(/shadow home/i);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a shadow home reached through a parent symlink that aliases CODEX_HOME", async () => {
    const fixture = makeAccountFixture();
    const aliasedParent = path.join(fixture.root, "aliased-parent");
    symlinkSync(fixture.root, aliasedParent);

    try {
      await expect(
        buildCodexProcessEnv({
          env: fixture.env,
          homePath: fixture.homePath,
          shadowHomePath: path.join(aliasedParent, path.basename(fixture.homePath)),
          accountId: "work",
          platform: "win32",
        }),
      ).rejects.toThrow(/different from CODEX_HOME/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps an explicitly repeated shared home isolated when a legacy plugin toggle is enabled", async () => {
    const fixture = makeAccountFixture();
    const sharedEnv = {
      ...fixture.env,
      CODEX_HOME: fixture.homePath,
      DPCODE_DISABLE_CODEX_DPCODE_BROWSER_PLUGIN: "0",
    };
    writeFileSync(path.join(fixture.homePath, "config.toml"), 'model = "gpt-5.4"\n', "utf8");

    try {
      const env = await buildCodexProcessEnv({
        env: sharedEnv,
        homePath: fixture.homePath,
        accountId: "work",
        platform: "win32",
      });

      const accountHomePath = env.CODEX_HOME;
      expect(accountHomePath).toBeTruthy();
      expect(path.resolve(accountHomePath!)).not.toBe(path.resolve(fixture.homePath));
      expect(() => lstatSync(path.join(accountHomePath!, "auth.json"))).toThrow();
      expect(readFileSync(path.join(accountHomePath!, "config.toml"), "utf8")).toContain(
        'model = "gpt-5.4"',
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("mirrors private state only from a distinct dedicated home with a legacy plugin toggle", async () => {
    const fixture = makeAccountFixture();
    const dedicatedHomePath = path.join(fixture.root, "codex-work-home");
    mkdirSync(dedicatedHomePath, { recursive: true });
    writeFileSync(path.join(dedicatedHomePath, "auth.json"), '{"account":"work"}', "utf8");

    try {
      const env = await buildCodexProcessEnv({
        env: {
          ...fixture.env,
          CODEX_HOME: fixture.homePath,
          DPCODE_DISABLE_CODEX_DPCODE_BROWSER_PLUGIN: "0",
        },
        homePath: dedicatedHomePath,
        accountId: "work",
        platform: "win32",
      });

      const accountHomePath = env.CODEX_HOME;
      expect(accountHomePath).toBeTruthy();
      expect(path.resolve(accountHomePath!)).not.toBe(path.resolve(dedicatedHomePath));
      expect(readFileSync(path.join(accountHomePath!, "auth.json"), "utf8")).toBe(
        '{"account":"work"}',
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps shared auth out of account overlays without a shadow home", async () => {
    const fixture = makeAccountFixture();
    const sharedEnv = { ...fixture.env, CODEX_HOME: fixture.homePath };

    try {
      const env = await buildCodexProcessEnv({
        env: sharedEnv,
        accountId: "work",
        platform: "win32",
      });

      const overlayHomePath = env.CODEX_HOME;
      expect(overlayHomePath).toBeTruthy();
      expect(path.resolve(overlayHomePath!)).not.toBe(path.resolve(fixture.homePath));
      for (const entry of ["auth.json", "models_cache.json"]) {
        expect(() => lstatSync(path.join(overlayHomePath!, entry))).toThrow();
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("mirrors private auth from an account's own dedicated home", async () => {
    const fixture = makeAccountFixture();

    try {
      const env = await buildCodexProcessEnv({
        env: fixture.env,
        homePath: fixture.homePath,
        accountId: "work",
        platform: "win32",
      });

      const overlayHomePath = env.CODEX_HOME;
      expect(overlayHomePath).toBeTruthy();
      for (const entry of ["auth.json", "models_cache.json"]) {
        const overlayPrivateStatePath = path.join(overlayHomePath!, entry);
        expect(lstatSync(overlayPrivateStatePath).isSymbolicLink()).toBe(true);
        expect(path.resolve(readlinkSync(overlayPrivateStatePath))).toBe(
          path.resolve(path.join(fixture.homePath, entry)),
        );
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("drops legacy shared-auth aliases from account overlays and keeps own logins", async () => {
    const fixture = makeAccountFixture();
    const sharedEnv = { ...fixture.env, CODEX_HOME: fixture.homePath };

    try {
      const firstEnv = await buildCodexProcessEnv({
        env: sharedEnv,
        accountId: "work",
        platform: "win32",
      });
      const overlayHomePath = firstEnv.CODEX_HOME;
      expect(overlayHomePath).toBeTruthy();
      // Simulate legacy overlay state that symlinked shared private files in.
      for (const entry of ["auth.json", "models_cache.json"]) {
        symlinkSync(path.join(fixture.homePath, entry), path.join(overlayHomePath!, entry));
      }

      const secondEnv = await buildCodexProcessEnv({
        env: sharedEnv,
        accountId: "work",
        platform: "win32",
      });
      expect(secondEnv.CODEX_HOME).toBe(overlayHomePath);
      for (const entry of ["auth.json", "models_cache.json"]) {
        expect(() => lstatSync(path.join(overlayHomePath!, entry))).toThrow();
      }

      // The account's own real private files must survive re-preparation.
      writeFileSync(path.join(overlayHomePath!, "auth.json"), '{"account":"work"}', "utf8");
      writeFileSync(path.join(overlayHomePath!, "models_cache.json"), '{"models":[]}', "utf8");
      const thirdEnv = await buildCodexProcessEnv({
        env: sharedEnv,
        accountId: "work",
        platform: "win32",
      });
      expect(thirdEnv.CODEX_HOME).toBe(overlayHomePath);
      for (const entry of ["auth.json", "models_cache.json"]) {
        expect(lstatSync(path.join(overlayHomePath!, entry)).isFile()).toBe(true);
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
