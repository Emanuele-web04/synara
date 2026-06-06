import { describe, expect, it } from "vitest";

import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";

import {
  appSettingsPatchToSandboxesPatch,
  SANDBOX_APP_SETTINGS_KEYS,
  SANDBOX_DEFAULT_PROVIDER_OPTIONS,
  SANDBOX_PROVIDER_DESCRIPTORS,
  sandboxSettingsToAppSettings,
} from "./sandboxSettings";

describe("sandboxSettingsToAppSettings", () => {
  it("reads non-secret fields and omits secret fields", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      sandboxes: {
        ...DEFAULT_SERVER_SETTINGS.sandboxes,
        defaultRemoteProvider: "daytona",
        postCloneCommand: "pnpm install --frozen-lockfile",
        daytona: {
          // Secret stripped by the server before persistence; modeled here as "".
          apiKey: "",
          apiUrl: "https://app.daytona.io/api",
          organizationId: "org-9",
          target: "us",
          snapshot: "daytona-snap",
        },
        vercel: {
          token: "",
          teamId: "team-1",
          projectId: "proj-1",
          runtime: "node22",
        },
      },
    };

    const flat = sandboxSettingsToAppSettings(settings);

    expect(flat.sandboxDefaultRemoteProvider).toBe("daytona");
    expect(flat.sandboxPostCloneCommand).toBe("pnpm install --frozen-lockfile");
    expect(flat.sandboxDaytonaApiUrl).toBe("https://app.daytona.io/api");
    expect(flat.sandboxDaytonaOrganizationId).toBe("org-9");
    expect(flat.sandboxVercelTeamId).toBe("team-1");
    expect(flat.sandboxVercelRuntime).toBe("node22");

    // Secret-bearing keys are never read back from ServerSettings.
    expect(flat).not.toHaveProperty("sandboxDaytonaApiKey");
    expect(flat).not.toHaveProperty("sandboxVercelToken");
    expect(flat).not.toHaveProperty("sandboxModalTokenId");
    expect(flat).not.toHaveProperty("sandboxModalTokenSecret");
    expect(flat).not.toHaveProperty("sandboxCloudflareBridgeToken");
  });
});

describe("appSettingsPatchToSandboxesPatch", () => {
  it("returns null when no sandbox keys are present", () => {
    expect(appSettingsPatchToSandboxesPatch({})).toBeNull();
  });

  it("includes secret fields write-only so the server can route them to the secret store", () => {
    const patch = appSettingsPatchToSandboxesPatch({
      sandboxDaytonaApiKey: "live-token",
      sandboxDaytonaApiUrl: "https://x/api",
      sandboxVercelToken: "vt",
      sandboxVercelTeamId: "team",
      sandboxModalTokenId: "id",
      sandboxModalTokenSecret: "shh",
      sandboxCloudflareBridgeToken: "cf",
    });

    expect(patch).toEqual({
      daytona: { apiKey: "live-token", apiUrl: "https://x/api" },
      vercel: { token: "vt", teamId: "team" },
      modal: { tokenId: "id", tokenSecret: "shh" },
      cloudflare: { bridgeToken: "cf" },
    });
  });

  it("maps defaults and a single provider field without touching others", () => {
    const patch = appSettingsPatchToSandboxesPatch({
      sandboxDefaultRemoteProvider: "vercel-sandbox",
      sandboxVercelRuntime: "node22",
    });

    expect(patch).toEqual({
      defaultRemoteProvider: "vercel-sandbox",
      vercel: { runtime: "node22" },
    });
  });

  it("maps the post-clone command, including an explicit empty string to clear it", () => {
    expect(appSettingsPatchToSandboxesPatch({ sandboxPostCloneCommand: "auto" })).toEqual({
      postCloneCommand: "auto",
    });
    expect(appSettingsPatchToSandboxesPatch({ sandboxPostCloneCommand: "" })).toEqual({
      postCloneCommand: "",
    });
  });

  it("preserves an explicit empty string so the server clears the stored secret", () => {
    expect(appSettingsPatchToSandboxesPatch({ sandboxModalTokenSecret: "" })).toEqual({
      modal: { tokenSecret: "" },
    });
  });
});

describe("sandbox descriptors", () => {
  it("maps every descriptor field to a declared flat AppSettings key", () => {
    const declared = new Set<string>(SANDBOX_APP_SETTINGS_KEYS);
    for (const provider of SANDBOX_PROVIDER_DESCRIPTORS) {
      for (const field of provider.fields) {
        expect(declared.has(field.appKey)).toBe(true);
      }
    }
  });

  it("offers a 'no preference' option plus one per provider", () => {
    expect(SANDBOX_DEFAULT_PROVIDER_OPTIONS[0]).toEqual({
      value: "",
      label: "No preference",
    });
    expect(SANDBOX_DEFAULT_PROVIDER_OPTIONS.map((option) => option.value)).toEqual([
      "",
      "daytona",
      "vercel-sandbox",
      "modal",
      "cloudflare",
    ]);
  });
});
