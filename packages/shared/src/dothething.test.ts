import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";

import {
  applyDoTheThingCodexConfig,
  buildDoTheThingAcpMcpServers,
  buildDoTheThingClaudeMcpServers,
  buildDoTheThingOpenCodeMcpConfig,
  DOTHETHING_MCP_SERVER_NAME,
  DOTHETHING_MCP_TOOL_NAMES,
  formatDoTheThingGrokToolName,
  shouldSkipAcpSessionResumeForDoTheThing,
  isDoTheThingEnabledInEnv,
  resolveBundledDoTheThingLauncherPath,
  resolveDoTheThingLauncherPath,
  resolveStableDoTheThingAppDir,
  resolveStableDoTheThingLauncherPath,
  resolveDoTheThingPackageRoots,
  withSynaraDoTheThingPromptContext,
} from "./dothething";

describe("applyDoTheThingCodexConfig", () => {
  it("adds the dothething MCP server when enabled", () => {
    const next = applyDoTheThingCodexConfig({
      config: 'model = "gpt-5.5"',
      enabled: true,
      launcherPath:
        "/Applications/Synara.app/Contents/Resources/app.asar.unpacked/node_modules/@t3tools/dothething/bin/dothething",
    });

    assert.match(next, /\[mcp_servers\."dothething"\]/);
    assert.match(
      next,
      /command = "\/Applications\/Synara\.app\/Contents\/Resources\/app\.asar\.unpacked\/node_modules\/@t3tools\/dothething\/bin\/dothething"/,
    );
    assert.match(next, /args = \["mcp"\]/);
    assert.doesNotMatch(next, /\[mcp_servers\."dothething"\.env\]/);
    assert.doesNotMatch(next, /DOTHETHING_DISABLE_APP_AGENT_PROXY/);
  });

  it("cleans old app-agent proxy bypass env when enabling dothething", () => {
    const next = applyDoTheThingCodexConfig({
      config: [
        `[mcp_servers."${DOTHETHING_MCP_SERVER_NAME}"]`,
        'command = "/tmp/old-dothething/bin/dothething"',
        'args = ["mcp"]',
        `[mcp_servers."${DOTHETHING_MCP_SERVER_NAME}".env]`,
        'DOTHETHING_DISABLE_APP_AGENT_PROXY = "1"',
      ].join("\n"),
      enabled: true,
      launcherPath: "/tmp/dothething/bin/dothething",
    });

    assert.match(next, /\[mcp_servers\."dothething"\]/);
    assert.match(next, /command = "\/tmp\/dothething\/bin\/dothething"/);
    assert.doesNotMatch(next, /\[mcp_servers\."dothething"\.env\]/);
    assert.doesNotMatch(next, /DOTHETHING_DISABLE_APP_AGENT_PROXY/);
  });

  it("removes legacy open-computer-use MCP entries and plugins", () => {
    const next = applyDoTheThingCodexConfig({
      config: [
        '[mcp_servers."open-computer-use"]',
        'command = "open-computer-use"',
        'args = ["mcp"]',
        "",
        '[plugins."open-computer-use@open-computer-use-local"]',
        "enabled = true",
      ].join("\n"),
      enabled: true,
      launcherPath: "/tmp/dothething/bin/dothething",
    });

    assert.doesNotMatch(next, /open-computer-use/);
    assert.match(next, /\[mcp_servers\."dothething"\]/);
  });

  it("maps legacy default service tiers before writing the overlay", () => {
    const next = applyDoTheThingCodexConfig({
      config: 'service_tier = "default"',
      enabled: false,
      launcherPath: "/tmp/dothething/bin/dothething",
    });

    assert.match(next, /service_tier = "flex"/);
    assert.doesNotMatch(next, /service_tier = "default"/);
  });

  it("removes the dothething MCP server when disabled", () => {
    const next = applyDoTheThingCodexConfig({
      config: [
        `[mcp_servers."${DOTHETHING_MCP_SERVER_NAME}"]`,
        'command = "/tmp/dothething/bin/dothething"',
        'args = ["mcp"]',
        `[mcp_servers."${DOTHETHING_MCP_SERVER_NAME}".env]`,
        'DOTHETHING_DISABLE_APP_AGENT_PROXY = "1"',
      ].join("\n"),
      enabled: false,
      launcherPath: "/tmp/dothething/bin/dothething",
    });

    assert.doesNotMatch(next, /\[mcp_servers\."dothething"\]/);
    assert.doesNotMatch(next, /DOTHETHING_DISABLE_APP_AGENT_PROXY/);
  });
});

describe("Do The Thing MCP builders", () => {
  const packageRoot = path.resolve(import.meta.dirname, "../../dothething");
  const bundledLauncherPath = path.join(
    packageRoot,
    "dist",
    "Do The Thing.app",
    "Contents",
    "MacOS",
    "DoTheThing",
  );
  const env = {
    DPCODE_MODE: "desktop",
    SYNARA_ENABLE_DOTHETHING: "1",
    SYNARA_DOTHETHING_LAUNCHER_PATH: "/tmp/dothething/bin/dothething",
  } as const;

  it("builds ACP stdio MCP servers when enabled", () => {
    const servers = buildDoTheThingAcpMcpServers({ env });
    assert.equal(servers.length, 1);
    assert.equal(servers[0]?.name, "dothething");
    assert.equal(servers[0]?.command, bundledLauncherPath);
    assert.deepEqual(servers[0]?.args, ["mcp"]);
    assert.deepEqual(servers[0]?.env, []);
  });

  it("builds Claude MCP servers when enabled", () => {
    const servers = buildDoTheThingClaudeMcpServers({ env });
    assert.deepEqual(servers, {
      dothething: {
        command: bundledLauncherPath,
        args: ["mcp"],
      },
    });
  });

  it("builds OpenCode MCP config when enabled", () => {
    const config = buildDoTheThingOpenCodeMcpConfig({ env });
    assert.deepEqual(config, {
      name: "dothething",
      config: {
        type: "local",
        command: [bundledLauncherPath, "mcp"],
        enabled: true,
      },
    });
  });

  it("returns empty MCP config when disabled", () => {
    assert.deepEqual(buildDoTheThingAcpMcpServers({ env: { SYNARA_ENABLE_DOTHETHING: "0" } }), []);
    assert.deepEqual(
      buildDoTheThingClaudeMcpServers({ env: { SYNARA_ENABLE_DOTHETHING: "0" } }),
      {},
    );
    assert.equal(
      buildDoTheThingOpenCodeMcpConfig({ env: { SYNARA_ENABLE_DOTHETHING: "0" } }),
      null,
    );
  });

  it("skips ACP resume when Do The Thing MCP is enabled", () => {
    assert.equal(shouldSkipAcpSessionResumeForDoTheThing({ env }), true);
    assert.equal(
      shouldSkipAcpSessionResumeForDoTheThing({ env: { SYNARA_ENABLE_DOTHETHING: "0" } }),
      false,
    );
  });
});

describe("resolveStableDoTheThingLauncherPath", () => {
  it("resolves the stable install path when present", () => {
    const stableDir = resolveStableDoTheThingAppDir({ HOME: "/tmp/synara-dothething-test" });
    const launcherPath = path.join(
      stableDir,
      "Do The Thing.app",
      "Contents",
      "MacOS",
      "DoTheThing",
    );
    mkdirSync(path.dirname(launcherPath), { recursive: true });
    writeFileSync(launcherPath, "");
    chmodSync(launcherPath, 0o755);

    try {
      assert.equal(
        resolveStableDoTheThingLauncherPath({ HOME: "/tmp/synara-dothething-test" }),
        launcherPath,
      );
    } finally {
      rmSync("/tmp/synara-dothething-test", { recursive: true, force: true });
    }
  });
});

describe("resolveDoTheThingLauncherPath", () => {
  it("prefers bundled package roots when preferBundled is set", () => {
    const packageRoot = path.resolve(import.meta.dirname, "../../dothething");
    const stableDir = resolveStableDoTheThingAppDir({
      HOME: "/tmp/synara-dothething-prefer-bundled",
    });
    const stableLauncher = path.join(
      stableDir,
      "Do The Thing.app",
      "Contents",
      "MacOS",
      "DoTheThing",
    );
    mkdirSync(path.dirname(stableLauncher), { recursive: true });
    writeFileSync(stableLauncher, "");
    chmodSync(stableLauncher, 0o755);

    try {
      assert.equal(
        resolveDoTheThingLauncherPath({
          env: { HOME: "/tmp/synara-dothething-prefer-bundled" },
          fallbackPackageRoots: [packageRoot],
          preferBundled: true,
        }),
        path.join(packageRoot, "dist", "Do The Thing.app", "Contents", "MacOS", "DoTheThing"),
      );
    } finally {
      rmSync("/tmp/synara-dothething-prefer-bundled", { recursive: true, force: true });
    }
  });

  it("prefers the stable install before bundled package roots", () => {
    const packageRoot = path.resolve(import.meta.dirname, "../../dothething");
    const stableDir = resolveStableDoTheThingAppDir({ HOME: "/tmp/synara-dothething-prefer" });
    const stableLauncher = path.join(
      stableDir,
      "Do The Thing.app",
      "Contents",
      "MacOS",
      "DoTheThing",
    );
    mkdirSync(path.dirname(stableLauncher), { recursive: true });
    writeFileSync(stableLauncher, "");
    chmodSync(stableLauncher, 0o755);

    try {
      assert.equal(
        resolveDoTheThingLauncherPath({
          env: { HOME: "/tmp/synara-dothething-prefer" },
          fallbackPackageRoots: [packageRoot],
        }),
        stableLauncher,
      );
    } finally {
      rmSync("/tmp/synara-dothething-prefer", { recursive: true, force: true });
    }
  });

  it("ignores a stable install launcher that exists but is not executable", () => {
    const packageRoot = path.resolve(import.meta.dirname, "../../dothething");
    const stableDir = resolveStableDoTheThingAppDir({
      HOME: "/tmp/synara-dothething-not-executable",
    });
    const stableLauncher = path.join(
      stableDir,
      "Do The Thing.app",
      "Contents",
      "MacOS",
      "DoTheThing",
    );
    mkdirSync(path.dirname(stableLauncher), { recursive: true });
    writeFileSync(stableLauncher, "");

    try {
      assert.equal(
        resolveStableDoTheThingLauncherPath({ HOME: "/tmp/synara-dothething-not-executable" }),
        null,
      );
      assert.equal(
        resolveDoTheThingLauncherPath({
          env: { HOME: "/tmp/synara-dothething-not-executable" },
          fallbackPackageRoots: [packageRoot],
        }),
        path.join(packageRoot, "dist", "Do The Thing.app", "Contents", "MacOS", "DoTheThing"),
      );
    } finally {
      rmSync("/tmp/synara-dothething-not-executable", { recursive: true, force: true });
    }
  });

  it("prefers the native runtime when package roots are provided", () => {
    const packageRoot = path.resolve(import.meta.dirname, "../../dothething");
    const launcherPath = resolveDoTheThingLauncherPath({
      env: { HOME: "/tmp/synara-dothething-no-stable-install" },
      fallbackPackageRoots: [packageRoot],
    });

    assert.equal(
      launcherPath,
      path.join(packageRoot, "dist", "Do The Thing.app", "Contents", "MacOS", "DoTheThing"),
    );
  });

  it("upgrades configured bin launchers to the native runtime", () => {
    const packageRoot = path.resolve(import.meta.dirname, "../../dothething");
    const launcherPath = resolveDoTheThingLauncherPath({
      env: {
        SYNARA_DOTHETHING_LAUNCHER_PATH: path.join(packageRoot, "bin", "dothething"),
      },
      fallbackPackageRoots: [packageRoot],
    });

    assert.equal(
      launcherPath,
      path.join(packageRoot, "dist", "Do The Thing.app", "Contents", "MacOS", "DoTheThing"),
    );
  });

  it("falls back to the bundled runtime when the configured launcher path is missing", () => {
    const packageRoot = path.resolve(import.meta.dirname, "../../dothething");
    const launcherPath = resolveDoTheThingLauncherPath({
      env: {
        SYNARA_DOTHETHING_LAUNCHER_PATH: "/tmp/missing-dothething/bin/dothething",
      },
      fallbackPackageRoots: [packageRoot],
    });

    assert.equal(
      launcherPath,
      path.join(packageRoot, "dist", "Do The Thing.app", "Contents", "MacOS", "DoTheThing"),
    );
  });

  it("resolves the bundled launcher from a package root", () => {
    const packageRoot = path.resolve(import.meta.dirname, "../../dothething");
    assert.equal(
      resolveBundledDoTheThingLauncherPath({ packageRoot }),
      path.join(packageRoot, "dist", "Do The Thing.app", "Contents", "MacOS", "DoTheThing"),
    );
  });

  it("discovers bundled package roots from the repo checkout", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../../..");
    const roots = resolveDoTheThingPackageRoots({ searchRoots: [repoRoot] });
    assert.ok(roots.includes(path.join(repoRoot, "packages", "dothething")));
  });

  it("discovers the bundled package root even when the process cwd is outside the repo", () => {
    const packageRoot = path.resolve(import.meta.dirname, "../../dothething");
    const outsideWorkspace = path.join("/tmp", "synara-dothething-outside-workspace");
    const roots = resolveDoTheThingPackageRoots({ searchRoots: [outsideWorkspace] });

    assert.ok(roots.includes(packageRoot));
  });

  it("builds ACP stdio MCP servers from the bundled package when cwd discovery misses", () => {
    const packageRoot = path.resolve(import.meta.dirname, "../../dothething");
    const outsideWorkspace = path.join("/tmp", "synara-dothething-outside-workspace");
    const servers = buildDoTheThingAcpMcpServers({
      env: {
        HOME: "/tmp/synara-dothething-no-stable-install",
        DPCODE_MODE: "desktop",
        SYNARA_ENABLE_DOTHETHING: "1",
      },
      searchRoots: [outsideWorkspace],
    });

    assert.equal(
      servers[0]?.command,
      path.join(packageRoot, "dist", "Do The Thing.app", "Contents", "MacOS", "DoTheThing"),
    );
  });

  it("does not register package-root MCP config when only the JS bin launcher exists", () => {
    const packageRoot = path.join("/tmp", "synara-dothething-bin-only-package");
    const binPath = path.join(packageRoot, "bin", "dothething");
    mkdirSync(path.dirname(binPath), { recursive: true });
    writeFileSync(path.join(packageRoot, "package.json"), "{}");
    writeFileSync(binPath, "#!/usr/bin/env node\n");
    chmodSync(binPath, 0o755);

    try {
      assert.deepEqual(
        buildDoTheThingAcpMcpServers({
          env: {
            HOME: "/tmp/synara-dothething-no-stable-install",
            DPCODE_MODE: "desktop",
            SYNARA_ENABLE_DOTHETHING: "1",
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

describe("isDoTheThingEnabledInEnv", () => {
  it("defaults to enabled in desktop mode", () => {
    assert.equal(isDoTheThingEnabledInEnv({ DPCODE_MODE: "desktop" }), true);
  });

  it("respects explicit disable sentinel", () => {
    assert.equal(
      isDoTheThingEnabledInEnv({
        DPCODE_MODE: "desktop",
        SYNARA_ENABLE_DOTHETHING: "0",
      }),
      false,
    );
  });
});

describe("Do The Thing tool naming", () => {
  it("formats Grok-qualified MCP tool names", () => {
    assert.equal(formatDoTheThingGrokToolName("get_app_state"), "dothething__get_app_state");
    assert.equal(formatDoTheThingGrokToolName("run_sequence"), "dothething__run_sequence");
    assert.equal(DOTHETHING_MCP_TOOL_NAMES.length, 10);
  });
});

describe("withSynaraDoTheThingPromptContext", () => {
  it("appends Do The Thing routing instructions when enabled", () => {
    const next = withSynaraDoTheThingPromptContext("Open Safari and play a song.", {
      DPCODE_MODE: "desktop",
    });

    assert.match(next, /Open Safari and play a song\./);
    assert.match(next, /Do The Thing MCP tool invocation/);
    assert.match(next, /dothething__get_app_state/);
    assert.match(next, /Do not substitute shell commands/);
    assert.match(next, /Do not call `search_tool`/);
    assert.match(next, /dothething__click, dothething__perform_secondary_action/);
    assert.match(
      next,
      /Do not immediately call `dothething__get_app_state` after a successful action/,
    );
  });

  it("leaves the prompt unchanged when disabled", () => {
    const prompt = "Open Safari and play a song.";
    assert.equal(
      withSynaraDoTheThingPromptContext(prompt, {
        DPCODE_MODE: "desktop",
        SYNARA_ENABLE_DOTHETHING: "0",
      }),
      prompt,
    );
  });

  it("leaves the prompt unchanged when enabled but no MCP launcher is available", () => {
    const packageRoot = path.join("/tmp", "synara-dothething-prompt-bin-only-package");
    const binPath = path.join(packageRoot, "bin", "dothething");
    mkdirSync(path.dirname(binPath), { recursive: true });
    writeFileSync(path.join(packageRoot, "package.json"), "{}");
    writeFileSync(binPath, "#!/usr/bin/env node\n");
    chmodSync(binPath, 0o755);

    const prompt = "Open Safari and play a song.";
    try {
      assert.equal(
        withSynaraDoTheThingPromptContext(prompt, {
          env: {
            HOME: "/tmp/synara-dothething-no-stable-install",
            DPCODE_MODE: "desktop",
            SYNARA_ENABLE_DOTHETHING: "1",
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
