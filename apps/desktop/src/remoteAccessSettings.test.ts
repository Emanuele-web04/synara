import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_REMOTE_ACCESS_SETTINGS,
  RemoteAccessSettingsValidationError,
  applyRemoteAccessBackendEnvironment,
  applyRemoteAccessSettingsPatch,
  normalizeTrustedTailnetOrigin,
  readRemoteAccessSettings,
  remoteAccessRequiresBackendRestart,
  shouldKeepDesktopRunning,
  shouldQuitAfterLastWindowClosed,
  writeRemoteAccessSettings,
} from "./remoteAccessSettings";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    FS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("remote access settings", () => {
  it("uses conservative defaults when no settings exist", () => {
    expect(readRemoteAccessSettings(Path.join(OS.tmpdir(), "missing-synara-remote.json"))).toEqual(
      DEFAULT_REMOTE_ACCESS_SETTINGS,
    );
    expect(DEFAULT_REMOTE_ACCESS_SETTINGS).toMatchObject({
      enabled: false,
      port: 3773,
      trustedOrigin: null,
      keepRunningOnClose: false,
      launchAtLogin: false,
    });
  });

  it("accepts only exact HTTPS Tailnet origins", () => {
    expect(normalizeTrustedTailnetOrigin("https://Workstation.Example.ts.net/")).toBe(
      "https://workstation.example.ts.net",
    );
    for (const origin of [
      "http://host.example.ts.net",
      "https://*.example.ts.net",
      "https://host.example.ts.net/mobile/",
      "https://host.example.ts.net/?token=secret",
      "https://example.com",
    ]) {
      expect(() => normalizeTrustedTailnetOrigin(origin)).toThrow(
        RemoteAccessSettingsValidationError,
      );
    }
  });

  it("enables keep-running as part of the remote-access opt-in", () => {
    const enabled = applyRemoteAccessSettingsPatch(DEFAULT_REMOTE_ACCESS_SETTINGS, {
      enabled: true,
    });
    expect(enabled.keepRunningOnClose).toBe(true);
    expect(shouldKeepDesktopRunning(enabled)).toBe(true);

    const explicitlyDisabled = applyRemoteAccessSettingsPatch(DEFAULT_REMOTE_ACCESS_SETTINGS, {
      enabled: true,
      keepRunningOnClose: false,
    });
    expect(shouldKeepDesktopRunning(explicitlyDisabled)).toBe(false);
    expect(
      shouldQuitAfterLastWindowClosed({
        platform: "darwin",
        settings: explicitlyDisabled,
        trayAvailable: true,
      }),
    ).toBe(true);
    expect(
      shouldQuitAfterLastWindowClosed({
        platform: "darwin",
        settings: enabled,
        trayAvailable: true,
      }),
    ).toBe(false);
    expect(
      shouldQuitAfterLastWindowClosed({
        platform: "darwin",
        settings: enabled,
        trayAvailable: false,
      }),
    ).toBe(true);
  });

  it("rejects unknown keys and privileged or invalid ports", () => {
    expect(() =>
      applyRemoteAccessSettingsPatch(DEFAULT_REMOTE_ACCESS_SETTINGS, { surprise: true }),
    ).toThrow(/Unknown remote access setting/);
    expect(() =>
      applyRemoteAccessSettingsPatch(DEFAULT_REMOTE_ACCESS_SETTINGS, { port: 443 }),
    ).toThrow(/1024/);
    expect(() =>
      applyRemoteAccessSettingsPatch(DEFAULT_REMOTE_ACCESS_SETTINGS, { port: 65536 }),
    ).toThrow(/65535/);
  });

  it("round-trips and atomically replaces settings", () => {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-remote-settings-"));
    temporaryDirectories.push(directory);
    const target = Path.join(directory, "nested", "settings.json");
    const enabled = applyRemoteAccessSettingsPatch(DEFAULT_REMOTE_ACCESS_SETTINGS, {
      enabled: true,
      trustedOrigin: "https://desktop.tail123.ts.net",
    });

    writeRemoteAccessSettings(target, enabled);
    expect(readRemoteAccessSettings(target)).toEqual(enabled);

    const updated = applyRemoteAccessSettingsPatch(enabled, { port: 4773 });
    writeRemoteAccessSettings(target, updated);
    expect(readRemoteAccessSettings(target)).toEqual(updated);
    expect(FS.readdirSync(Path.dirname(target))).toEqual(["settings.json"]);
  });

  it("restarts only for backend-facing settings", () => {
    const enabled = applyRemoteAccessSettingsPatch(DEFAULT_REMOTE_ACCESS_SETTINGS, {
      enabled: true,
    });
    expect(remoteAccessRequiresBackendRestart(DEFAULT_REMOTE_ACCESS_SETTINGS, enabled)).toBe(true);
    expect(
      remoteAccessRequiresBackendRestart(enabled, {
        ...enabled,
        launchAtLogin: true,
      }),
    ).toBe(false);
    expect(
      remoteAccessRequiresBackendRestart(enabled, {
        ...enabled,
        trustedOrigin: "https://host.tail123.ts.net",
      }),
    ).toBe(true);
    expect(
      remoteAccessRequiresBackendRestart(DEFAULT_REMOTE_ACCESS_SETTINGS, {
        ...DEFAULT_REMOTE_ACCESS_SETTINGS,
        trustedOrigin: "https://host.tail123.ts.net",
      }),
    ).toBe(false);
  });

  it("keeps disabled mode isolated from inherited companion flags", () => {
    expect(
      applyRemoteAccessBackendEnvironment(
        {
          SYNARA_HOST: "0.0.0.0",
          SYNARA_COMPANION_ENABLED: "1",
          SYNARA_PUBLIC_URL: "https://inherited.tail123.ts.net",
          SYNARA_TRUSTED_ORIGIN: "https://inherited.tail123.ts.net",
        },
        DEFAULT_REMOTE_ACCESS_SETTINGS,
      ),
    ).toEqual({ SYNARA_HOST: "127.0.0.1" });

    const enabled = applyRemoteAccessSettingsPatch(DEFAULT_REMOTE_ACCESS_SETTINGS, {
      enabled: true,
      trustedOrigin: "https://desktop.tail123.ts.net",
    });
    expect(applyRemoteAccessBackendEnvironment({}, enabled)).toEqual({
      SYNARA_HOST: "127.0.0.1",
      SYNARA_COMPANION_ENABLED: "1",
      SYNARA_PUBLIC_URL: "https://desktop.tail123.ts.net",
    });
  });
});
