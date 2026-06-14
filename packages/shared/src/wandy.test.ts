import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  isWandyEnabledInEnv,
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
    const servers = buildWandyAcpMcpServers({ env });
    assert.equal(servers.length, 1);
    assert.equal(servers[0]?.name, "wandy");
    assert.equal(servers[0]?.command, bundledLauncherPath);
    assert.deepEqual(servers[0]?.args, ["mcp"]);
    assert.deepEqual(servers[0]?.env, []);
  });

  it("builds Claude MCP servers when enabled", () => {
    const servers = buildWandyClaudeMcpServers({ env });
    assert.deepEqual(servers, {
      wandy: {
        command: bundledLauncherPath,
        args: ["mcp"],
      },
    });
  });

  it("builds OpenCode MCP config when enabled", () => {
    const config = buildWandyOpenCodeMcpConfig({ env });
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
    assert.equal(shouldSkipAcpSessionResumeForWandy({ env }), true);
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
    });

    assert.equal(
      launcherPath,
      path.join(packageRoot, "dist", "Wandy.app", "Contents", "MacOS", "Wandy"),
    );
  });

  it("resolves the bundled launcher from a package root", () => {
    const packageRoot = path.resolve(import.meta.dirname, "../../wandy");
    assert.equal(
      resolveBundledWandyLauncherPath({ packageRoot }),
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
        }),
        [],
      );
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
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

describe("Wandy tool naming", () => {
  it("formats Grok-qualified MCP tool names", () => {
    assert.equal(formatWandyGrokToolName("get_app_state"), "wandy__get_app_state");
    assert.equal(formatWandyGrokToolName("run_sequence"), "wandy__run_sequence");
    assert.equal(WANDY_MCP_TOOL_NAMES.length, 10);
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
        }),
        prompt,
      );
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });
});
