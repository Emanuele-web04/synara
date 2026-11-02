import { describe, expect, it } from "vitest";

import { AppSettingsSchema } from "~/appSettings";

import {
  createProviderInstallResetPatch,
  isProviderInstallSettingsDirty,
  providerInstanceLaunchConfigFor,
} from "./ProvidersSettingsPanel";

const defaults = AppSettingsSchema.makeUnsafe({});

describe("isProviderInstallSettingsDirty", () => {
  it("detects changed Codex launch args", () => {
    expect(isProviderInstallSettingsDirty(defaults, defaults)).toBe(false);
    expect(
      isProviderInstallSettingsDirty(
        { ...defaults, codexLaunchArgs: '-c model_provider="apitoken"' },
        defaults,
      ),
    ).toBe(true);
  });

  it("uses configured flags instead of unreadable password values", () => {
    expect(
      isProviderInstallSettingsDirty({ ...defaults, openCodeServerPassword: "secret" }, defaults),
    ).toBe(false);
    expect(
      isProviderInstallSettingsDirty(
        { ...defaults, openCodeServerPasswordConfigured: true },
        defaults,
      ),
    ).toBe(true);
  });
});

describe("createProviderInstallResetPatch", () => {
  it("resets every configured field and writes password values so configured flags clear", () => {
    const patch = createProviderInstallResetPatch({
      ...defaults,
      openCodeServerPassword: "",
    });

    expect(Object.keys(patch).sort()).toEqual(
      [
        "antigravityBinaryPath",
        "claudeBinaryPath",
        "claudeConfirmColdCacheResume",
        "claudeEnableArtifacts",
        "claudeHomePath",
        "codexAccounts",
        "codexBinaryPath",
        "codexHomePath",
        "codexLaunchArgs",
        "cursorApiEndpoint",
        "cursorBinaryPath",
        "devinBinaryPath",
        "droidBinaryPath",
        "grokBinaryPath",
        "ompAgentDir",
        "ompBinaryPath",
        "openCodeBinaryPath",
        "openCodeExperimentalWebSockets",
        "openCodeServerPassword",
        "openCodeServerUrl",
        "piAgentDir",
        "piBinaryPath",
        "providerInstances",
        "selectedCodexAccountId",
      ].sort(),
    );
    expect(patch.openCodeServerPassword).toBe("");
  });
});

describe("providerInstanceLaunchConfigFor", () => {
  it("maps Pi-family agent directories to agentDir, not binaryPath", () => {
    expect(
      providerInstanceLaunchConfigFor("omp", {
        ...defaults,
        ompBinaryPath: "/usr/local/bin/omp",
        ompAgentDir: "~/.omp-work/agent",
      }),
    ).toEqual({ binaryPath: "/usr/local/bin/omp", agentDir: "~/.omp-work/agent" });
    expect(
      providerInstanceLaunchConfigFor("pi", { ...defaults, piAgentDir: "~/.pi-work/agent" }),
    ).toEqual({ agentDir: "~/.pi-work/agent" });
  });

  it("keeps the Claude binary path and leaves the provider-wide Artifacts setting out", () => {
    expect(
      providerInstanceLaunchConfigFor("claudeAgent", {
        ...defaults,
        claudeBinaryPath: "/opt/homebrew/bin/claude",
        claudeEnableArtifacts: true,
      }),
    ).toEqual({ binaryPath: "/opt/homebrew/bin/claude" });
  });
});

it("does not inherit provider-wide Codex launch args as an account executable", () => {
  expect(
    providerInstanceLaunchConfigFor("codex", {
      ...defaults,
      codexBinaryPath: "/custom/codex",
      codexLaunchArgs: '-c model_provider="apitoken"',
    }),
  ).toEqual({ binaryPath: "/custom/codex" });
});
