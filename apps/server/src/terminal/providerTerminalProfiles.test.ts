// FILE: providerTerminalProfiles.test.ts
// Purpose: Verify provider settings become isolated, shell-neutral terminal profiles.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@synara/contracts";

import { deriveManagedTerminalProfiles } from "./providerTerminalProfiles.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "synara-provider-profiles-"));
  roots.push(root);
  const binDir = path.join(root, "bin");
  const homeDir = path.join(root, "home");
  const stateDir = path.join(root, "state");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  return { root, binDir, homeDir, stateDir };
}

function installCli(binDir: string, name: string): void {
  writeFileSync(path.join(binDir, name), "#!/bin/sh\n", { mode: 0o755 });
}

describe("deriveManagedTerminalProfiles", () => {
  it("maps Claude config paths and omits sensitive environment", async () => {
    const { binDir, homeDir, stateDir } = fixture();
    installCli(binDir, "claude");
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        claude_work: {
          driver: "claudeAgent",
          config: { configDir: "~/.claude-work", cliAlias: "claude-acme" },
          environment: [
            { name: "ANTHROPIC_API_KEY", value: "secret-value", sensitive: true },
            { name: "CLAUDE_CODE_MAX_OUTPUT_CHARS", value: "10000", sensitive: false },
          ],
        },
      },
    };

    const profiles = await deriveManagedTerminalProfiles({
      settings,
      baseEnv: { PATH: binDir, HOME: homeDir },
      homeDir,
      stateDir,
    });
    const profile = profiles.find((candidate) => candidate.commandName === "claude-acme");

    expect(profile?.environment.CLAUDE_CONFIG_DIR).toBe(path.join(homeDir, ".claude-work"));
    expect(profile?.environment.CLAUDE_CODE_MAX_OUTPUT_CHARS).toBe("10000");
    expect(profile?.environment.ANTHROPIC_API_KEY).toBeUndefined();
    expect(profile?.omittedSensitiveEnvironmentNames).toContain("ANTHROPIC_API_KEY");
  });

  it("maps an imported Pi directory to the CLI environment", async () => {
    const { binDir, homeDir, stateDir, root } = fixture();
    installCli(binDir, "pi");
    const imported = path.join(root, "existing-pi");
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        pi_work: { driver: "pi", config: { agentDir: imported } },
      },
    };

    const profiles = await deriveManagedTerminalProfiles({
      settings,
      baseEnv: { PATH: binDir, HOME: homeDir },
      homeDir,
      stateDir,
    });

    expect(profiles.find((profile) => profile.commandName === "pi-work")?.environment).toMatchObject(
      { PI_CODING_AGENT_DIR: imported },
    );
  });
});
