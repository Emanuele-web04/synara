// FILE: claudeAppLaunch.test.ts
// Purpose: Focused tests for Claude desktop launch plan generation.
// Layer: Server unit tests

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ACCOUNT_ENV_UNSET } from "./accountEnvironment";
import { buildClaudeAccountEnvironment } from "./claudeAccountEnvironment";
import { buildClaudeDesktopLaunchPlan, resolveClaudeDesktopExecutable } from "./claudeAppLaunch";

const DARWIN_EXECUTABLE = "/Applications/Claude.app/Contents/MacOS/Claude";

describe("resolveClaudeDesktopExecutable", () => {
  it("resolves the macOS app bundle binary", () => {
    expect(resolveClaudeDesktopExecutable({ platform: "darwin" })).toBe(DARWIN_EXECUTABLE);
  });

  it("resolves the Windows install under LOCALAPPDATA", () => {
    expect(
      resolveClaudeDesktopExecutable({
        platform: "win32",
        localAppData: "C:\\Users\\k\\AppData\\Local",
      }),
    ).toBe(join("C:\\Users\\k\\AppData\\Local", "AnthropicClaude", "claude.exe"));
  });

  it("stays unavailable on Windows without LOCALAPPDATA", () => {
    expect(resolveClaudeDesktopExecutable({ platform: "win32" })).toBeUndefined();
  });

  it("stays unavailable on platforms without an official desktop build", () => {
    expect(resolveClaudeDesktopExecutable({ platform: "linux" })).toBeUndefined();
  });
});

describe("buildClaudeDesktopLaunchPlan", () => {
  it("builds a native account plan with no environment overrides", () => {
    const plan = buildClaudeDesktopLaunchPlan({ ordinal: 0, host: { platform: "darwin" } });
    expect(plan).toEqual({
      provider: "claudeAgent",
      ordinal: 0,
      appGeneration: 1,
      executable: DARWIN_EXECUTABLE,
      args: [],
      environment: {},
      supportLevel: "supported",
    });
  });

  it("builds a managed account plan carrying the resolved app environment", () => {
    const launchEnvironment = buildClaudeAccountEnvironment({
      provider: "claudeAgent",
      ordinal: 2,
      surface: "app",
      authMethod: "oauth",
      agentHome: "/accounts/claudeAgent/2/agent",
      appDataDir: "/accounts/claudeAgent/2/app/data",
    });
    const plan = buildClaudeDesktopLaunchPlan({
      ordinal: 2,
      accountLaunch: {
        ordinal: 2,
        generation: 3,
        profilePath: launchEnvironment.profilePath,
        environment: launchEnvironment.environment,
      },
      host: { platform: "darwin" },
    });
    expect(plan).toBeDefined();
    expect(plan?.ordinal).toBe(2);
    expect(plan?.appGeneration).toBe(3);
    expect(plan?.supportLevel).toBe("experimental");
    expect(plan?.environment.CLAUDE_CONFIG_DIR).toBe("/accounts/claudeAgent/2/app/data");
    // Inherited auth must never leak into the desktop app launch.
    expect(plan?.environment.ANTHROPIC_API_KEY).toBe(ACCOUNT_ENV_UNSET);
    expect(plan?.environment.CLAUDE_CODE_OAUTH_TOKEN).toBe(ACCOUNT_ENV_UNSET);
    expect(plan?.environment.ANTHROPIC_BASE_URL).toBe(ACCOUNT_ENV_UNSET);
  });

  it("returns undefined where no official desktop build exists", () => {
    expect(
      buildClaudeDesktopLaunchPlan({ ordinal: 0, host: { platform: "linux" } }),
    ).toBeUndefined();
  });
});
