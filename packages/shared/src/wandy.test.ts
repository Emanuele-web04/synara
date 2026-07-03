import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";

import {
  applyWandyCodexConfig,
  buildWandyAcpMcpServers,
  buildWandyClaudeMcpServers,
  buildWandyOpenCodeMcpConfig,
  WANDY_MCP_SERVER_NAME,
  WANDY_MCP_TOOL_NAMES,
  formatWandyGrokToolName,
  shouldSkipAcpSessionResumeForWandy,
  buildWandyAcpToolInvocationInstructions,
  wandyMcpToolNamesForPlatform,
  isWandyEnabledInEnv,
  isWandyExplicitlyDisabledInEnv,
  resolveWandyEnabledFromSettings,
  syncWandyEnabledEnv,
  wandyRuntimeRelativeParts,
  resolveBundledWandyLauncherPath,
  resolveWandyLauncherPath,
  resolveStableWandyAppDir,
  resolveStableWandyLauncherPath,
  resolveWandyPackageRoots,
  withSynaraWandyPromptContext,
} from "./wandy";

describe("applyWandyCodexConfig", () => {
  it("adds the wandy MCP server when enabled", () => {
    const next = applyWandyCodexConfig({
      config: 'model = "gpt-5.5"',
      enabled: true,
      launcherPath:
        "/Applications/Synara.app/Contents/Resources/app.asar.unpacked/node_modules/@t3tools/wandy/bin/wandy",
    });

    assert.match(next, /\[mcp_servers\."wandy"\]/);
    assert.match(
      next,
      /command = "\/Applications\/Synara\.app\/Contents\/Resources\/app\.asar\.unpacked\/node_modules\/@t3tools\/wandy\/bin\/wandy"/,
    );
    assert.match(next, /args = \["mcp"\]/);
    assert.doesNotMatch(next, /\[mcp_servers\."wandy"\.env\]/);
    assert.doesNotMatch(next, /WANDY_DISABLE_APP_AGENT_PROXY/);
  });

  it("cleans old app-agent proxy bypass env when enabling wandy", () => {
    const next = applyWandyCodexConfig({
      config: [
        `[mcp_servers."${WANDY_MCP_SERVER_NAME}"]`,
        'command = "/tmp/old-wandy/bin/wandy"',
        'args = ["mcp"]',
        `[mcp_servers."${WANDY_MCP_SERVER_NAME}".env]`,
        'WANDY_DISABLE_APP_AGENT_PROXY = "1"',
      ].join("\n"),
      enabled: true,
      launcherPath: "/tmp/wandy/bin/wandy",
    });

    assert.match(next, /\[mcp_servers\."wandy"\]/);
    assert.match(next, /command = "\/tmp\/wandy\/bin\/wandy"/);
    assert.doesNotMatch(next, /\[mcp_servers\."wandy"\.env\]/);
    assert.doesNotMatch(next, /WANDY_DISABLE_APP_AGENT_PROXY/);
  });

  it("removes legacy open-computer-use MCP entries and plugins", () => {
    const next = applyWandyCodexConfig({
      config: [
        '[mcp_servers."open-computer-use"]',
        'command = "open-computer-use"',
        'args = ["mcp"]',
        "",
        '[plugins."open-computer-use@open-computer-use-local"]',
        "enabled = true",
      ].join("\n"),
      enabled: true,
      launcherPath: "/tmp/wandy/bin/wandy",
    });

    assert.doesNotMatch(next, /open-computer-use/);
    assert.match(next, /\[mcp_servers\."wandy"\]/);
  });

  it("maps legacy default service tiers before writing the overlay", () => {
    const next = applyWandyCodexConfig({
      config: 'service_tier = "default"',
      enabled: false,
      launcherPath: "/tmp/wandy/bin/wandy",
    });

    assert.match(next, /service_tier = "flex"/);
    assert.doesNotMatch(next, /service_tier = "default"/);
  });

  it("removes the wandy MCP server when disabled", () => {
    const next = applyWandyCodexConfig({
      config: [
        `[mcp_servers."${WANDY_MCP_SERVER_NAME}"]`,
        'command = "/tmp/wandy/bin/wandy"',
        'args = ["mcp"]',
        `[mcp_servers."${WANDY_MCP_SERVER_NAME}".env]`,
        'WANDY_DISABLE_APP_AGENT_PROXY = "1"',
      ].join("\n"),
      enabled: false,
      launcherPath: "/tmp/wandy/bin/wandy",
    });

    assert.doesNotMatch(next, /\[mcp_servers\."wandy"\]/);
    assert.doesNotMatch(next, /WANDY_DISABLE_APP_AGENT_PROXY/);
  });

  it("still removes stale sections when enabled without a resolvable launcher", () => {
    const next = applyWandyCodexConfig({
      config: [
        'model = "gpt-5.5"',
        `[mcp_servers."${WANDY_MCP_SERVER_NAME}"]`,
        'command = "/tmp/stale/bin/wandy"',
        'args = ["mcp"]',
        '[mcp_servers."open-computer-use"]',
        'command = "/tmp/legacy/bin/open-computer-use"',
      ].join("\n"),
      enabled: true,
      launcherPath: "",
    });

    assert.match(next, /model = "gpt-5\.5"/);
    assert.doesNotMatch(next, /\[mcp_servers\."wandy"\]/);
    assert.doesNotMatch(next, /open-computer-use/);
  });
});

describe("Wandy MCP builders", () => {
  const packageRoot = path.resolve(import.meta.dirname, "../../wandy");
  const bundledLauncherPath = path.join(
    packageRoot,
    "dist",
    "Wandy.app",
    "Contents",
    "MacOS",
    "Wandy",
  );
  const env = {
    DPCODE_MODE: "desktop",
    SYNARA_ENABLE_WANDY: "1",
    SYNARA_WANDY_LAUNCHER_PATH: "/tmp/wandy/bin/wandy",
  } as const;

  it("builds ACP stdio MCP servers when enabled", () => {
    const servers = buildWandyAcpMcpServers({ env, platform: "darwin", arch: "arm64" });
    assert.equal(servers.length, 1);
    assert.equal(servers[0]?.name, "wandy");
    assert.equal(servers[0]?.command, bundledLauncherPath);
    assert.deepEqual(servers[0]?.args, ["mcp"]);
    assert.deepEqual(servers[0]?.env, []);
  });

  it("builds Claude MCP servers when enabled", () => {
    const servers = buildWandyClaudeMcpServers({ env, platform: "darwin", arch: "arm64" });
    assert.deepEqual(servers, {
      wandy: {
        command: bundledLauncherPath,
        args: ["mcp"],
      },
    });
  });

  it("builds OpenCode MCP config when enabled", () => {
    const config = buildWandyOpenCodeMcpConfig({ env, platform: "darwin", arch: "arm64" });
    assert.deepEqual(config, {
      name: "wandy",
      config: {
        type: "local",
        command: [bundledLauncherPath, "mcp"],
        enabled: true,
      },
    });
  });

  it("returns empty MCP config when disabled", () => {
    assert.deepEqual(buildWandyAcpMcpServers({ env: { SYNARA_ENABLE_WANDY: "0" } }), []);
    assert.deepEqual(buildWandyClaudeMcpServers({ env: { SYNARA_ENABLE_WANDY: "0" } }), {});
    assert.equal(buildWandyOpenCodeMcpConfig({ env: { SYNARA_ENABLE_WANDY: "0" } }), null);
  });

  it("skips ACP resume when Wandy MCP is enabled", () => {
    assert.equal(
      shouldSkipAcpSessionResumeForWandy({ env, platform: "darwin", arch: "arm64" }),
      true,
    );
    assert.equal(shouldSkipAcpSessionResumeForWandy({ env: { SYNARA_ENABLE_WANDY: "0" } }), false);
  });
});

describe("resolveStableWandyLauncherPath", () => {
  it("resolves the stable install path when present", () => {
    const stableDir = resolveStableWandyAppDir({ HOME: "/tmp/synara-wandy-test" });
    const launcherPath = path.join(stableDir, "Wandy.app", "Contents", "MacOS", "Wandy");
    mkdirSync(path.dirname(launcherPath), { recursive: true });
    writeFileSync(launcherPath, "");
    chmodSync(launcherPath, 0o755);

    try {
      assert.equal(
        resolveStableWandyLauncherPath({ HOME: "/tmp/synara-wandy-test" }),
        launcherPath,
      );
    } finally {
      rmSync("/tmp/synara-wandy-test", { recursive: true, force: true });
    }
  });
});

describe("resolveWandyLauncherPath", () => {
  it("prefers bundled package roots when preferBundled is set", () => {
    const packageRoot = path.resolve(import.meta.dirname, "../../wandy");
    const stableDir = resolveStableWandyAppDir({
      HOME: "/tmp/synara-wandy-prefer-bundled",
    });
    const stableLauncher = path.join(stableDir, "Wandy.app", "Contents", "MacOS", "Wandy");
    mkdirSync(path.dirname(stableLauncher), { recursive: true });
    writeFileSync(stableLauncher, "");
    chmodSync(stableLauncher, 0o755);

    try {
      assert.equal(
        resolveWandyLauncherPath({
          env: { HOME: "/tmp/synara-wandy-prefer-bundled" },
          fallbackPackageRoots: [packageRoot],
          platform: "darwin",
          arch: "arm64",
          preferBundled: true,
        }),
        path.join(packageRoot, "dist", "Wandy.app", "Contents", "MacOS", "Wandy"),
      );
    } finally {
      rmSync("/tmp/synara-wandy-prefer-bundled", { recursive: true, force: true });
    }
  });

  it("prefers the stable install before bundled package roots", () => {
    const packageRoot = path.resolve(import.meta.dirname, "../../wandy");
    const stableDir = resolveStableWandyAppDir({ HOME: "/tmp/synara-wandy-prefer" });
    const stableLauncher = path.join(stableDir, "Wandy.app", "Contents", "MacOS", "Wandy");
    mkdirSync(path.dirname(stableLauncher), { recursive: true });
    writeFileSync(stableLauncher, "");
    chmodSync(stableLauncher, 0o755);

    try {
      assert.equal(
        resolveWandyLauncherPath({
          env: { HOME: "/tmp/synara-wandy-prefer" },
          fallbackPackageRoots: [packageRoot],
          platform: "darwin",
          arch: "arm64",
        }),
        stableLauncher,
      );
    } finally {
      rmSync("/tmp/synara-wandy-prefer", { recursive: true, force: true });
    }
  });

  it("ignores a stable install launcher that exists but is not executable", () => {
    const packageRoot = path.resolve(import.meta.dirname, "../../wandy");
    const stableDir = resolveStableWandyAppDir({
      HOME: "/tmp/synara-wandy-not-executable",
    });
    const stableLauncher = path.join(stableDir, "Wandy.app", "Contents", "MacOS", "Wandy");
    mkdirSync(path.dirname(stableLauncher), { recursive: true });
    writeFileSync(stableLauncher, "");

    try {
      assert.equal(
        resolveStableWandyLauncherPath({ HOME: "/tmp/synara-wandy-not-executable" }),
        null,
      );
      assert.equal(
        resolveWandyLauncherPath({
          env: { HOME: "/tmp/synara-wandy-not-executable" },
          fallbackPackageRoots: [packageRoot],
          platform: "darwin",
          arch: "arm64",
        }),
        path.join(packageRoot, "dist", "Wandy.app", "Contents", "MacOS", "Wandy"),
      );
    } finally {
      rmSync("/tmp/synara-wandy-not-executable", { recursive: true, force: true });
    }
  });

  it("prefers the native runtime when package roots are provided", () => {
    const packageRoot = path.resolve(import.meta.dirname, "../../wandy");
    const launcherPath = resolveWandyLauncherPath({
      env: { HOME: "/tmp/synara-wandy-no-stable-install" },
      fallbackPackageRoots: [packageRoot],
      platform: "darwin",
      arch: "arm64",
    });

    assert.equal(
      launcherPath,
      path.join(packageRoot, "dist", "Wandy.app", "Contents", "MacOS", "Wandy"),
    );
  });

  it("upgrades configured bin launchers to the native runtime", () => {
    const packageRoot = path.resolve(import.meta.dirname, "../../wandy");
    const launcherPath = resolveWandyLauncherPath({
      env: {
        SYNARA_WANDY_LAUNCHER_PATH: path.join(packageRoot, "bin", "wandy"),
      },
      fallbackPackageRoots: [packageRoot],
      platform: "darwin",
      arch: "arm64",
    });

    assert.equal(
      launcherPath,
      path.join(packageRoot, "dist", "Wandy.app", "Contents", "MacOS", "Wandy"),
    );
  });

  it("falls back to the bundled runtime when the configured launcher path is missing", () => {
    const packageRoot = path.resolve(import.meta.dirname, "../../wandy");
    const launcherPath = resolveWandyLauncherPath({
      env: {
        SYNARA_WANDY_LAUNCHER_PATH: "/tmp/missing-wandy/bin/wandy",
      },
      fallbackPackageRoots: [packageRoot],
      platform: "darwin",
      arch: "arm64",
    });

    assert.equal(
      launcherPath,
      path.join(packageRoot, "dist", "Wandy.app", "Contents", "MacOS", "Wandy"),
    );
  });

  it("resolves the bundled launcher from a package root", () => {
    const packageRoot = path.resolve(import.meta.dirname, "../../wandy");
    assert.equal(
      resolveBundledWandyLauncherPath({ packageRoot, platform: "darwin", arch: "arm64" }),
      path.join(packageRoot, "dist", "Wandy.app", "Contents", "MacOS", "Wandy"),
    );
  });

  it("discovers bundled package roots from the repo checkout", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../../..");
    const roots = resolveWandyPackageRoots({ searchRoots: [repoRoot] });
    assert.ok(roots.includes(path.join(repoRoot, "packages", "wandy")));
  });

  it("discovers the bundled package root even when the process cwd is outside the repo", () => {
    const packageRoot = path.resolve(import.meta.dirname, "../../wandy");
    const outsideWorkspace = path.join("/tmp", "synara-wandy-outside-workspace");
    const roots = resolveWandyPackageRoots({ searchRoots: [outsideWorkspace] });

    assert.ok(roots.includes(packageRoot));
  });

  it("builds ACP stdio MCP servers from the bundled package when cwd discovery misses", () => {
    const packageRoot = path.resolve(import.meta.dirname, "../../wandy");
    const outsideWorkspace = path.join("/tmp", "synara-wandy-outside-workspace");
    const servers = buildWandyAcpMcpServers({
      env: {
        HOME: "/tmp/synara-wandy-no-stable-install",
        DPCODE_MODE: "desktop",
        SYNARA_ENABLE_WANDY: "1",
      },
      searchRoots: [outsideWorkspace],
      platform: "darwin",
      arch: "arm64",
    });

    assert.equal(
      servers[0]?.command,
      path.join(packageRoot, "dist", "Wandy.app", "Contents", "MacOS", "Wandy"),
    );
  });

  it("does not register package-root MCP config when only the JS bin launcher exists", () => {
    const packageRoot = path.join("/tmp", "synara-wandy-bin-only-package");
    const binPath = path.join(packageRoot, "bin", "wandy");
    mkdirSync(path.dirname(binPath), { recursive: true });
    writeFileSync(path.join(packageRoot, "package.json"), "{}");
    writeFileSync(binPath, "#!/usr/bin/env node\n");
    chmodSync(binPath, 0o755);

    try {
      assert.deepEqual(
        buildWandyAcpMcpServers({
          env: {
            HOME: "/tmp/synara-wandy-no-stable-install",
            DPCODE_MODE: "desktop",
            SYNARA_ENABLE_WANDY: "1",
          },
          fallbackPackageRoots: [packageRoot],
          platform: "darwin",
          arch: "arm64",
        }),
        [],
      );
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });
});

// The standalone launchers cannot import this module, so they carry copies of
// the platform runtime table. These tests fail if a copy drifts from the
// shared source of truth.
describe("standalone launcher runtime tables", () => {
  const PLATFORM_KEYS = [
    ["darwin", "arm64"],
    ["linux", "arm64"],
    ["linux", "x64"],
    ["win32", "arm64"],
    ["win32", "x64"],
  ] as const;

  function extractTableEntry(source: string, key: string): readonly string[] {
    const match = source.match(
      new RegExp(`"${key}":\\s*(?:\\{\\s*"executablePath":\\s*)?(\\[[^\\]]*\\])`),
    );
    assert.ok(match?.[1], `runtime table entry for ${key} not found`);
    return JSON.parse(match[1]) as string[];
  }

  it("bin/wandy matches wandyRuntimeRelativeParts", () => {
    const source = readFileSync(path.resolve(import.meta.dirname, "../../wandy/bin/wandy"), "utf8");
    for (const [platform, arch] of PLATFORM_KEYS) {
      assert.deepEqual(
        extractTableEntry(source, `${platform}-${arch}`),
        wandyRuntimeRelativeParts(platform, arch),
        `bin/wandy entry for ${platform}-${arch} drifted from the shared table`,
      );
    }
  });

  it("bin/wandy-mcp delegates to bin/wandy and defaults to MCP mode", () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, "../../wandy/bin/wandy-mcp"),
      "utf8",
    );
    assert.match(source, /require\("\.\/wandy"\);/);
    assert.match(source, /push\("mcp"\)/);
  });

  it("apps/desktop/scripts/wandyMcp.mjs matches wandyRuntimeRelativeParts", () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, "../../../apps/desktop/scripts/wandyMcp.mjs"),
      "utf8",
    );
    for (const [platform, arch] of PLATFORM_KEYS) {
      assert.deepEqual(
        extractTableEntry(source, `${platform}-${arch}`),
        wandyRuntimeRelativeParts(platform, arch),
        `wandyMcp.mjs entry for ${platform}-${arch} drifted from the shared table`,
      );
    }
  });

  it("does not advertise the arm64-only macOS bundle on Intel macOS", () => {
    assert.equal(wandyRuntimeRelativeParts("darwin", "x64"), null);
  });

  it("standalone launchers also omit Intel macOS until a compatible bundle ships", () => {
    const launcherSources = [
      readFileSync(path.resolve(import.meta.dirname, "../../wandy/bin/wandy"), "utf8"),
      readFileSync(
        path.resolve(import.meta.dirname, "../../../apps/desktop/scripts/wandyMcp.mjs"),
        "utf8",
      ),
    ];

    for (const source of launcherSources) {
      assert.doesNotMatch(source, /"darwin-x64"/);
    }
  });
});

describe("isWandyEnabledInEnv", () => {
  it("defaults to enabled in desktop mode", () => {
    assert.equal(isWandyEnabledInEnv({ DPCODE_MODE: "desktop" }), true);
  });

  it("respects explicit disable sentinel", () => {
    assert.equal(
      isWandyEnabledInEnv({
        DPCODE_MODE: "desktop",
        SYNARA_ENABLE_WANDY: "0",
      }),
      false,
    );
  });
});

describe("isWandyExplicitlyDisabledInEnv", () => {
  it("only reports explicit disable sentinels", () => {
    assert.equal(isWandyExplicitlyDisabledInEnv({ SYNARA_ENABLE_WANDY: "0" }), true);
    assert.equal(isWandyExplicitlyDisabledInEnv({ SYNARA_ENABLE_WANDY: "false" }), true);
    assert.equal(isWandyExplicitlyDisabledInEnv({ SYNARA_ENABLE_WANDY: "no" }), true);
    assert.equal(isWandyExplicitlyDisabledInEnv({ SYNARA_ENABLE_WANDY: "1" }), false);
    assert.equal(isWandyExplicitlyDisabledInEnv({}), false);
  });
});

describe("resolveWandyEnabledFromSettings", () => {
  it("honors the setting when the environment allows Wandy", () => {
    const env = { DPCODE_MODE: "desktop" };
    assert.equal(resolveWandyEnabledFromSettings({ enableWandy: true, env }), true);
    assert.equal(resolveWandyEnabledFromSettings({ enableWandy: false, env }), false);
  });

  it("cannot enable Wandy when the environment disables it", () => {
    assert.equal(
      resolveWandyEnabledFromSettings({
        enableWandy: true,
        env: { DPCODE_MODE: "desktop", SYNARA_ENABLE_WANDY: "0" },
      }),
      false,
    );
    assert.equal(resolveWandyEnabledFromSettings({ enableWandy: true, env: {} }), false);
  });
});

describe("syncWandyEnabledEnv", () => {
  it("writes the enable sentinel into the provided env", () => {
    const env: NodeJS.ProcessEnv = {};
    syncWandyEnabledEnv(true, env);
    assert.equal(env.SYNARA_ENABLE_WANDY, "1");
    syncWandyEnabledEnv(false, env);
    assert.equal(env.SYNARA_ENABLE_WANDY, "0");
  });
});

describe("Wandy tool naming", () => {
  it("formats Grok-qualified MCP tool names", () => {
    assert.equal(formatWandyGrokToolName("get_app_state"), "wandy__get_app_state");
    assert.equal(formatWandyGrokToolName("run_sequence"), "wandy__run_sequence");
    assert.equal(WANDY_MCP_TOOL_NAMES.length, 10);
  });

  it("only advertises run_sequence on macOS, where the runtime implements it", () => {
    assert.ok(wandyMcpToolNamesForPlatform("darwin").includes("run_sequence"));
    assert.ok(!wandyMcpToolNamesForPlatform("linux").includes("run_sequence"));
    assert.ok(!wandyMcpToolNamesForPlatform("win32").includes("run_sequence"));
    assert.match(buildWandyAcpToolInvocationInstructions("darwin"), /run_sequence/);
    assert.doesNotMatch(buildWandyAcpToolInvocationInstructions("linux"), /run_sequence/);
    assert.doesNotMatch(buildWandyAcpToolInvocationInstructions("win32"), /run_sequence/);
  });
});

describe("withSynaraWandyPromptContext", () => {
  it("appends Wandy routing instructions when enabled", () => {
    const next = withSynaraWandyPromptContext("Open Safari and play a song.", {
      DPCODE_MODE: "desktop",
    });

    assert.match(next, /Open Safari and play a song\./);
    assert.match(next, /Wandy MCP tool invocation/);
    assert.match(next, /wandy__get_app_state/);
    assert.match(next, /Do not substitute shell commands/);
    assert.match(next, /Do not call `search_tool`/);
    assert.match(next, /wandy__click, wandy__perform_secondary_action/);
    assert.match(next, /Do not immediately call `wandy__get_app_state` after a successful action/);
  });

  it("leaves the prompt unchanged when disabled", () => {
    const prompt = "Open Safari and play a song.";
    assert.equal(
      withSynaraWandyPromptContext(prompt, {
        DPCODE_MODE: "desktop",
        SYNARA_ENABLE_WANDY: "0",
      }),
      prompt,
    );
  });

  it("leaves the prompt unchanged when enabled but no MCP launcher is available", () => {
    const packageRoot = path.join("/tmp", "synara-wandy-prompt-bin-only-package");
    const binPath = path.join(packageRoot, "bin", "wandy");
    mkdirSync(path.dirname(binPath), { recursive: true });
    writeFileSync(path.join(packageRoot, "package.json"), "{}");
    writeFileSync(binPath, "#!/usr/bin/env node\n");
    chmodSync(binPath, 0o755);

    const prompt = "Open Safari and play a song.";
    try {
      assert.equal(
        withSynaraWandyPromptContext(prompt, {
          env: {
            HOME: "/tmp/synara-wandy-no-stable-install",
            DPCODE_MODE: "desktop",
            SYNARA_ENABLE_WANDY: "1",
          },
          fallbackPackageRoots: [packageRoot],
          platform: "darwin",
          arch: "arm64",
        }),
        prompt,
      );
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });
});
