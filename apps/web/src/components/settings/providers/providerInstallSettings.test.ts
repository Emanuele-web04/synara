import { describe, expect, it } from "vitest";

import { AppSettingsSchema } from "~/appSettings";

import {
  createProviderCliFieldsResetPatch,
  createProviderInstallResetPatch,
  isProviderCliFieldsDirty,
  isProviderInstallSettingsDirty,
  providerInstanceLaunchConfigFor,
} from "./providerInstallSettings";

const defaults = AppSettingsSchema.makeUnsafe({});

describe("isProviderInstallSettingsDirty", () => {
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

describe("provider CLI fields (the Agents list reset)", () => {
  it("restores only provider-wide CLI options, never accounts or sign-in folders", () => {
    const patch = createProviderCliFieldsResetPatch(defaults);
    expect(patch).toHaveProperty("codexBinaryPath");
    expect(patch).toHaveProperty("openCodeServerPassword");
    for (const key of [
      "providerInstances",
      "codexAccounts",
      "selectedCodexAccountId",
      "codexHomePath",
      "claudeHomePath",
      "piAgentDir",
      "ompAgentDir",
    ]) {
      expect(patch).not.toHaveProperty(key);
    }
  });

  it("ignores account changes when deciding whether there is anything to reset", () => {
    expect(
      isProviderCliFieldsDirty(
        {
          ...defaults,
          codexHomePath: "~/.codex-personal",
          providerInstances: { codex_team: { driver: "codex", displayName: "Team" } },
        },
        defaults,
      ),
    ).toBe(false);
    expect(isProviderCliFieldsDirty({ ...defaults, codexBinaryPath: "/bin/codex" }, defaults)).toBe(
      true,
    );
    expect(
      isProviderCliFieldsDirty({ ...defaults, openCodeServerPasswordConfigured: true }, defaults),
    ).toBe(true);
  });
});
