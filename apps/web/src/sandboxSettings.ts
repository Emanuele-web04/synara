// FILE: sandboxSettings.ts
// Purpose: Descriptor table and bridge helpers for the Settings "Sandboxes"
// section (remote runtimes: Daytona, Vercel Sandbox, Modal, Cloudflare).
// Layer: Web UI logic (pure, unit-tested)
//
// Secret-bearing fields (API keys/tokens) are WRITE-ONLY: the server routes them
// through ServerSecretStore on save and never echoes them back via getSettings.
// So they are bridged one direction only — flat AppSettings -> ServerSettingsPatch
// on save — and never read back from ServerSettings (reading would clobber the
// locally typed value with the server's empty string). Non-secret fields
// (apiUrl, teamId, runtime, environment, ...) round-trip both directions like the
// agent-provider settings do.

import type { ServerSettings, ServerSettingsPatch } from "@t3tools/contracts";

/** Remote runtime providers exposed in the Sandboxes settings section. */
export const SANDBOX_PROVIDER_IDS = ["daytona", "vercel", "modal", "cloudflare"] as const;
export type SandboxProviderId = (typeof SANDBOX_PROVIDER_IDS)[number];

/** Flat AppSettings keys this module owns (mirrors the per-provider fields below). */
export type SandboxAppSettingsKey =
  | "sandboxDefaultRemoteProvider"
  | "sandboxDefaultSnapshot"
  | "sandboxDaytonaApiKey"
  | "sandboxDaytonaApiUrl"
  | "sandboxDaytonaOrganizationId"
  | "sandboxDaytonaTarget"
  | "sandboxDaytonaSnapshot"
  | "sandboxVercelToken"
  | "sandboxVercelTeamId"
  | "sandboxVercelProjectId"
  | "sandboxVercelRuntime"
  | "sandboxModalTokenId"
  | "sandboxModalTokenSecret"
  | "sandboxModalEnvironment"
  | "sandboxCloudflareBridgeUrl"
  | "sandboxCloudflareBridgeToken";

/** A single editable field within a sandbox provider card. */
export interface SandboxFieldDescriptor {
  /** Flat AppSettings key the input reads/writes. */
  readonly appKey: SandboxAppSettingsKey;
  /** Key under `ServerSettings.sandboxes.<settingsKey>`. */
  readonly serverField: string;
  /** Secret-bearing fields are write-only and rendered as password inputs. */
  readonly secret: boolean;
  readonly label: string;
  readonly placeholder: string;
  readonly description: string;
}

export interface SandboxProviderDescriptor {
  readonly id: SandboxProviderId;
  /** Key under `ServerSettings.sandboxes`. */
  readonly settingsKey: "daytona" | "vercel" | "modal" | "cloudflare";
  readonly title: string;
  /** Provider value written to `defaultRemoteProvider` (matches ExecutionRuntimeProvider). */
  readonly runtimeProvider: string;
  readonly fields: ReadonlyArray<SandboxFieldDescriptor>;
}

export const SANDBOX_PROVIDER_DESCRIPTORS: ReadonlyArray<SandboxProviderDescriptor> = [
  {
    id: "daytona",
    settingsKey: "daytona",
    title: "Daytona",
    runtimeProvider: "daytona",
    fields: [
      {
        appKey: "sandboxDaytonaApiKey",
        serverField: "apiKey",
        secret: true,
        label: "API key",
        placeholder: "DAYTONA_API_KEY",
        description: "Stored as a server secret. Leave blank to keep the existing key.",
      },
      {
        appKey: "sandboxDaytonaApiUrl",
        serverField: "apiUrl",
        secret: false,
        label: "API URL",
        placeholder: "https://app.daytona.io/api",
        description: "Optional. Defaults to the Daytona cloud endpoint.",
      },
      {
        appKey: "sandboxDaytonaOrganizationId",
        serverField: "organizationId",
        secret: false,
        label: "Organization ID",
        placeholder: "Daytona organization ID",
        description: "Optional Daytona organization scope.",
      },
      {
        appKey: "sandboxDaytonaTarget",
        serverField: "target",
        secret: false,
        label: "Target",
        placeholder: "Daytona target region",
        description: "Optional region/target for new sandboxes.",
      },
      {
        appKey: "sandboxDaytonaSnapshot",
        serverField: "snapshot",
        secret: false,
        label: "Snapshot",
        placeholder: "Daytona snapshot",
        description: "Optional default snapshot for Daytona sandboxes.",
      },
    ],
  },
  {
    id: "vercel",
    settingsKey: "vercel",
    title: "Vercel Sandbox",
    runtimeProvider: "vercel-sandbox",
    fields: [
      {
        appKey: "sandboxVercelToken",
        serverField: "token",
        secret: true,
        label: "Token",
        placeholder: "VERCEL_TOKEN",
        description: "Stored as a server secret. Leave blank to keep the existing token.",
      },
      {
        appKey: "sandboxVercelTeamId",
        serverField: "teamId",
        secret: false,
        label: "Team ID",
        placeholder: "VERCEL_TEAM_ID",
        description: "Required alongside the token and project ID for real sandboxes.",
      },
      {
        appKey: "sandboxVercelProjectId",
        serverField: "projectId",
        secret: false,
        label: "Project ID",
        placeholder: "VERCEL_PROJECT_ID",
        description: "Required alongside the token and team ID for real sandboxes.",
      },
      {
        appKey: "sandboxVercelRuntime",
        serverField: "runtime",
        secret: false,
        label: "Runtime",
        placeholder: "node22",
        description: "Optional sandbox runtime image.",
      },
    ],
  },
  {
    id: "modal",
    settingsKey: "modal",
    title: "Modal",
    runtimeProvider: "modal",
    fields: [
      {
        appKey: "sandboxModalTokenId",
        serverField: "tokenId",
        secret: true,
        label: "Token ID",
        placeholder: "MODAL_TOKEN_ID",
        description: "Stored as a server secret. Required with the token secret.",
      },
      {
        appKey: "sandboxModalTokenSecret",
        serverField: "tokenSecret",
        secret: true,
        label: "Token secret",
        placeholder: "MODAL_TOKEN_SECRET",
        description: "Stored as a server secret. Required with the token ID.",
      },
      {
        appKey: "sandboxModalEnvironment",
        serverField: "environment",
        secret: false,
        label: "Environment",
        placeholder: "MODAL_ENVIRONMENT",
        description: "Optional Modal environment name.",
      },
    ],
  },
  {
    id: "cloudflare",
    settingsKey: "cloudflare",
    title: "Cloudflare",
    runtimeProvider: "cloudflare",
    fields: [
      {
        appKey: "sandboxCloudflareBridgeUrl",
        serverField: "bridgeUrl",
        secret: false,
        label: "Bridge URL",
        placeholder: "https://your-bridge.workers.dev",
        description: "URL of the Cloudflare sandbox bridge worker.",
      },
      {
        appKey: "sandboxCloudflareBridgeToken",
        serverField: "bridgeToken",
        secret: true,
        label: "Bridge token",
        placeholder: "Cloudflare bridge token",
        description: "Stored as a server secret. Leave blank to keep the existing token.",
      },
    ],
  },
];

/** Every flat sandbox AppSettings key, in declaration order. */
export const SANDBOX_APP_SETTINGS_KEYS: ReadonlyArray<SandboxAppSettingsKey> = [
  "sandboxDefaultRemoteProvider",
  "sandboxDefaultSnapshot",
  ...SANDBOX_PROVIDER_DESCRIPTORS.flatMap((provider) =>
    provider.fields.map((field) => field.appKey),
  ),
];

/** Default remote-provider select options ("" = no preference / env-or-fake). */
export const SANDBOX_DEFAULT_PROVIDER_OPTIONS: ReadonlyArray<{
  value: string;
  label: string;
}> = [
  { value: "", label: "No preference" },
  ...SANDBOX_PROVIDER_DESCRIPTORS.map((provider) => ({
    value: provider.runtimeProvider,
    label: provider.title,
  })),
];

type SandboxAppSettings = Record<SandboxAppSettingsKey, string>;

/**
 * Read NON-SECRET sandbox fields out of ServerSettings into flat AppSettings.
 * Secret fields are intentionally omitted: the server never echoes them, so
 * reading them would overwrite the locally typed value with an empty string.
 */
export function sandboxSettingsToAppSettings(
  settings: ServerSettings,
): Partial<SandboxAppSettings> {
  const sandboxes = settings.sandboxes;
  const result: Partial<SandboxAppSettings> = {
    sandboxDefaultRemoteProvider: sandboxes.defaultRemoteProvider,
    sandboxDefaultSnapshot: sandboxes.defaultSnapshot,
  };
  for (const provider of SANDBOX_PROVIDER_DESCRIPTORS) {
    const providerSettings = sandboxes[provider.settingsKey] as Record<string, string>;
    for (const field of provider.fields) {
      if (field.secret) {
        continue;
      }
      result[field.appKey] = providerSettings[field.serverField] ?? "";
    }
  }
  return result;
}

function hasKey(patch: Partial<SandboxAppSettings>, key: SandboxAppSettingsKey): boolean {
  return Object.prototype.hasOwnProperty.call(patch, key);
}

/**
 * Build the `ServerSettingsPatch.sandboxes` sub-patch from a flat AppSettings
 * patch. Includes secret fields (write-only): the server strips and persists
 * them via ServerSecretStore. Returns null when the patch touches no sandbox
 * keys, so callers preserve today's behavior with nothing configured.
 */
export function appSettingsPatchToSandboxesPatch(
  patch: Partial<SandboxAppSettings>,
): NonNullable<ServerSettingsPatch["sandboxes"]> | null {
  const sandboxes: Record<string, unknown> = {};

  if (hasKey(patch, "sandboxDefaultRemoteProvider")) {
    sandboxes.defaultRemoteProvider = patch.sandboxDefaultRemoteProvider ?? "";
  }
  if (hasKey(patch, "sandboxDefaultSnapshot")) {
    sandboxes.defaultSnapshot = patch.sandboxDefaultSnapshot ?? "";
  }

  for (const provider of SANDBOX_PROVIDER_DESCRIPTORS) {
    const providerPatch: Record<string, string> = {};
    for (const field of provider.fields) {
      if (hasKey(patch, field.appKey)) {
        providerPatch[field.serverField] = patch[field.appKey] ?? "";
      }
    }
    if (Object.keys(providerPatch).length > 0) {
      sandboxes[provider.settingsKey] = providerPatch;
    }
  }

  return Object.keys(sandboxes).length > 0
    ? (sandboxes as NonNullable<ServerSettingsPatch["sandboxes"]>)
    : null;
}
