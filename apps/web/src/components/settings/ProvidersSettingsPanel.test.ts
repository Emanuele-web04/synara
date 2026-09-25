import { describe, expect, it } from "vitest";

import { AppSettingsSchema } from "~/appSettings";

import {
  createProviderInstallResetPatch,
  isProviderInstallSettingsDirty,
} from "./ProvidersSettingsPanel";

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
        "claudeEnableArtifacts",
        "codexBinaryPath",
        "codexHomePath",
        "cursorApiEndpoint",
        "cursorBinaryPath",
        "devinBinaryPath",
        "droidBinaryPath",
        "grokBinaryPath",
        "openCodeBinaryPath",
        "openCodeExperimentalWebSockets",
        "openCodeServerPassword",
        "openCodeServerUrl",
        "piAgentDir",
        "piBinaryPath",
      ].sort(),
    );
    expect(patch.openCodeServerPassword).toBe("");
  });
});
