// FILE: providerInstallSettings.tsx
// Purpose: What each agent's CLI install settings are (fields, docs links) and the pure
//          helpers that read them: dirty checks, reset patches, disclosure defaults, and
//          the launch config a new account inherits. Descriptions stay JSX only because
//          the i18n audit reads rich-text slots from literal <Translation> elements.
// Layer: Settings model
// Exports: PROVIDER_INSTALL_SETTINGS, PROVIDER_VISIBILITY_OPTIONS, ProviderVisibilityOption,
//          ProviderInstallField,
//          ProviderInstallSettings, isProviderInstallSettingsDirty, isProviderCliFieldsDirty,
//          createProviderInstallResetPatch, createProviderCliFieldsResetPatch,
//          createProviderInstallDisclosureState, createClosedProviderInstallDisclosureState,
//          isDefaultAccountIdentityField, providerInstanceConfigKey,
//          providerInstanceLaunchConfigFor

import { DEFAULT_CODEX_ACCOUNT_ID, type ProviderKind } from "@synara/contracts";
import type { ReactNode } from "react";

import type { AppSettings } from "~/appSettings";
import { VISIBLE_PROVIDER_DESCRIPTORS } from "~/betaFeatures";
import type { t } from "~/i18n";
import { Translation } from "~/i18n/Translation";

type ProviderInstallTextKey =
  | "claudeBinaryPath"
  | "claudeHomePath"
  | "codexBinaryPath"
  | "codexHomePath"
  | "cursorBinaryPath"
  | "cursorApiEndpoint"
  | "devinBinaryPath"
  | "antigravityBinaryPath"
  | "grokBinaryPath"
  | "droidBinaryPath"
  | "openCodeBinaryPath"
  | "openCodeServerUrl"
  | "piBinaryPath"
  | "piAgentDir"
  | "ompBinaryPath"
  | "ompAgentDir";
type ProviderInstallPasswordKey = "openCodeServerPassword";
type ProviderInstallPasswordConfiguredKey = "openCodeServerPasswordConfigured";
type ProviderInstallBooleanKey =
  | "claudeEnableArtifacts"
  | "claudeConfirmColdCacheResume"
  | "openCodeExperimentalWebSockets";

type ProviderInstallTextField = {
  readonly kind: "text";
  readonly settingsKey: ProviderInstallTextKey;
  readonly label: string;
  readonly placeholder: string;
  readonly description: string | ((translate: typeof t) => ReactNode);
};
type ProviderInstallPasswordField = {
  readonly kind: "password";
  readonly settingsKey: ProviderInstallPasswordKey;
  readonly configuredKey: ProviderInstallPasswordConfiguredKey;
  readonly label: string;
  readonly placeholder: string;
  readonly description: string | ((translate: typeof t) => ReactNode);
};
type ProviderInstallBooleanField = {
  readonly kind: "boolean";
  readonly settingsKey: ProviderInstallBooleanKey;
  readonly label: string;
  readonly description: string | ((translate: typeof t) => ReactNode);
};
export type ProviderInstallField =
  | ProviderInstallTextField
  | ProviderInstallPasswordField
  | ProviderInstallBooleanField;
export type ProviderInstallSettings = {
  readonly provider: ProviderKind;
  readonly docs: ReadonlyArray<{ readonly label: string; readonly href: string }>;
  readonly fields: readonly ProviderInstallField[];
};

/** Every agent this build offers, in descriptor order, with its setup guide. */
export const PROVIDER_VISIBILITY_OPTIONS = VISIBLE_PROVIDER_DESCRIPTORS.map((descriptor) => ({
  provider: descriptor.kind,
  title: descriptor.displayName,
  setupDocsHref: descriptor.setupDocsHref,
}));
export type ProviderVisibilityOption = (typeof PROVIDER_VISIBILITY_OPTIONS)[number];

export const PROVIDER_INSTALL_SETTINGS: readonly ProviderInstallSettings[] = [
  {
    provider: "codex",
    docs: [
      {
        label: "settings:providers_docInstall",
        href: "https://help.openai.com/en/articles/11096431",
      },
      {
        label: "computer:providerUpdates_update",
        href: "https://help.openai.com/en/articles/11096431",
      },
      {
        label: "settings:providers_docConfig",
        href: "https://github.com/openai/codex/blob/main/docs/config.md",
      },
    ],
    fields: [
      {
        kind: "text",
        settingsKey: "codexBinaryPath",
        label: "settings:codexBinaryPath",
        placeholder: "settings:codexBinaryPath",
        description: () => (
          <Translation
            message="settings:binaryPathDescription"
            values={{ command: "codex" }}
            components={{ command: <code /> }}
          />
        ),
      },
      {
        kind: "text",
        settingsKey: "codexHomePath",
        label: "settings:providers_codexHomePath",
        placeholder: "settings:cODEXHOME",
        description: "settings:providers_codexHomeDescription",
      },
    ],
  },
  {
    provider: "claudeAgent",
    docs: [
      {
        label: "settings:providers_docInstall",
        href: "https://code.claude.com/docs/en/installation",
      },
      {
        label: "computer:providerUpdates_update",
        href: "https://code.claude.com/docs/en/installation#update-claude-code",
      },
      { label: "settings:providers_docConfig", href: "https://code.claude.com/docs/en/settings" },
    ],
    fields: [
      {
        kind: "text",
        settingsKey: "claudeBinaryPath",
        label: "settings:claudeBinaryPath",
        placeholder: "settings:claudeBinaryPath",
        description: () => (
          <Translation
            message="settings:binaryPathDescription"
            values={{ command: "claude" }}
            components={{ command: <code /> }}
          />
        ),
      },
      {
        kind: "text",
        settingsKey: "claudeHomePath",
        label: "settings:claudeHOMEPath",
        placeholder: "settings:claudeHOME",
        description: "settings:optionalHOMEDirectoryForThisClaudeAccount",
      },
      {
        kind: "boolean",
        settingsKey: "claudeEnableArtifacts",
        label: "settings:artifactsDesignAndSlides",
        description: () => (
          <Translation
            message="settings:claudeArtifactsDescription"
            components={{ design: <code />, slides: <code /> }}
          />
        ),
      },
      {
        kind: "boolean",
        settingsKey: "claudeConfirmColdCacheResume",
        label: "settings:askBeforeResumingALongIdleSession",
        description: "settings:offByDefaultLikeClaudeCodeWhenOnAfter",
      },
    ],
  },
  {
    provider: "cursor",
    docs: [
      {
        label: "settings:providers_docInstall",
        href: "https://docs.cursor.com/en/cli/installation",
      },
      {
        label: "computer:providerUpdates_update",
        href: "https://docs.cursor.com/en/cli/installation#updates",
      },
      { label: "settings:providers_docConfig", href: "https://docs.cursor.com/en/cli/overview" },
    ],
    fields: [
      {
        kind: "text",
        settingsKey: "cursorBinaryPath",
        label: "settings:cursorBinaryPath",
        placeholder: "settings:cursorAgentOrCursorCLIPath",
        description: () => (
          <Translation
            message="settings:cursorBinaryDescription"
            components={{ command: <code /> }}
          />
        ),
      },
      {
        kind: "text",
        settingsKey: "cursorApiEndpoint",
        label: "settings:providers_cursorApiEndpoint",
        placeholder: "https://api2.cursor.sh",
        description: "settings:optionalCursorAPIEndpointOverridePassedToCursorAgent",
      },
    ],
  },
  {
    provider: "antigravity",
    docs: [
      { label: "settings:providers_docInstall", href: "https://antigravity.google/docs/cli-using" },
      { label: "settings:reference", href: "https://antigravity.google/docs/cli-reference" },
      { label: "settings:hooks", href: "https://antigravity.google/docs/hooks" },
    ],
    fields: [
      {
        kind: "text",
        settingsKey: "antigravityBinaryPath",
        label: "settings:antigravityBinaryPath",
        placeholder: "settings:antigravityCLIBinaryPath",
        description: () => (
          <Translation
            message="settings:binaryPathDescription"
            values={{ command: "agy" }}
            components={{ command: <code /> }}
          />
        ),
      },
    ],
  },
  {
    provider: "grok",
    docs: [
      { label: "settings:providers_docInstall", href: "https://docs.x.ai/build/overview" },
      {
        label: "settings:providers_docHeadless",
        href: "https://docs.x.ai/build/cli/headless-scripting",
      },
      { label: "settings:providers_docConfig", href: "https://docs.x.ai/build/overview" },
    ],
    fields: [
      {
        kind: "text",
        settingsKey: "grokBinaryPath",
        label: "settings:grokBinaryPath",
        placeholder: "settings:grokBinaryPath",
        description: () => (
          <Translation
            message="settings:binaryPathDescription"
            values={{ command: "grok" }}
            components={{ command: <code /> }}
          />
        ),
      },
    ],
  },
  {
    provider: "droid",
    docs: [
      {
        label: "settings:quickstart",
        href: "https://docs.factory.ai/cli/getting-started/quickstart.md",
      },
    ],
    fields: [
      {
        kind: "text",
        settingsKey: "droidBinaryPath",
        label: "settings:droidBinaryPath",
        placeholder: "settings:droid",
        description: () => (
          <Translation
            message="settings:binaryPathDescription"
            values={{ command: "droid" }}
            components={{ command: <code /> }}
          />
        ),
      },
    ],
  },
  {
    provider: "devin",
    docs: [
      { label: "settings:providers_docInstall", href: "https://docs.devin.ai/cli" },
      { label: "settings:commands", href: "https://docs.devin.ai/cli/reference/commands" },
      {
        label: "settings:providers_docConfig",
        href: "https://docs.devin.ai/cli/reference/configuration/config-file",
      },
    ],
    fields: [
      {
        kind: "text",
        settingsKey: "devinBinaryPath",
        label: "settings:devinBinaryPath",
        placeholder: "settings:devin",
        description: () => (
          <Translation
            message="settings:devinBinaryDescription"
            components={{ command: <code />, login: <code /> }}
          />
        ),
      },
    ],
  },
  {
    provider: "opencode",
    docs: [
      { label: "settings:providers_docInstall", href: "https://opencode.ai/docs/" },
      { label: "computer:providerUpdates_update", href: "https://opencode.ai/docs/cli/" },
      { label: "settings:providers_docConfig", href: "https://opencode.ai/docs/config/" },
    ],
    fields: [
      {
        kind: "text",
        settingsKey: "openCodeBinaryPath",
        label: "settings:openCodeBinaryPath",
        placeholder: "settings:openCodeBinaryPath",
        description: () => (
          <Translation
            message="settings:binaryPathDescription"
            values={{ command: "opencode" }}
            components={{ command: <code /> }}
          />
        ),
      },
      {
        kind: "text",
        settingsKey: "openCodeServerUrl",
        label: "settings:openCodeServerURL",
        placeholder: "http://127.0.0.1:4096",
        description: "settings:optionalExistingOpenCodeServerURLLeaveBlankToSpawn",
      },
      {
        kind: "password",
        settingsKey: "openCodeServerPassword",
        configuredKey: "openCodeServerPasswordConfigured",
        label: "settings:openCodeServerPassword",
        placeholder: "settings:openCodeServerPassword",
        description: "settings:optionalPasswordForAnExternallyManagedOpenCodeServer",
      },
      {
        kind: "boolean",
        settingsKey: "openCodeExperimentalWebSockets",
        label: "settings:providers_openaiResponseWebSockets",
        description: "settings:providers_openaiResponseWebSocketsDescription",
      },
    ],
  },
  {
    provider: "pi",
    docs: [
      { label: "settings:providers_docInstall", href: "https://pi.dev/docs/latest" },
      { label: "computer:providerUpdates_update", href: "https://pi.dev/docs/latest/settings" },
      { label: "settings:providers_docConfig", href: "https://pi.dev/docs/latest/settings" },
    ],
    fields: [
      {
        kind: "text",
        settingsKey: "piBinaryPath",
        label: "settings:piBinaryPath",
        placeholder: "settings:piBinaryPath",
        description: () => (
          <Translation
            message="settings:binaryPathDescription"
            values={{ command: "pi" }}
            components={{ command: <code /> }}
          />
        ),
      },
      {
        kind: "text",
        settingsKey: "piAgentDir",
        label: "settings:providers_piAgentDir",
        placeholder: "settings:providers_piAgentDir",
        description: "settings:providers_piAgentDirDescription",
      },
    ],
  },
  {
    provider: "omp",
    docs: [
      { label: "workspace:docs", href: "https://omp.sh/docs" },
      { label: "settings:providers_docInstall", href: "https://omp.sh/docs/quickstart" },
      {
        label: "common:workspaceFilePreviewHeader_source",
        href: "https://github.com/can1357/oh-my-pi",
      },
    ],
    fields: [
      {
        kind: "text",
        settingsKey: "ompBinaryPath",
        label: "settings:ohMyPiBinaryPath",
        placeholder: "settings:ohMyPiBinaryPath",
        description: () => (
          <Translation
            message="settings:binaryPathDescription"
            values={{ command: "omp" }}
            components={{ command: <code /> }}
          />
        ),
      },
      {
        kind: "text",
        settingsKey: "ompAgentDir",
        label: "settings:ohMyPiAgentDirectory",
        placeholder: "settings:ohMyPiAgentDirectory",
        description: "settings:optionalCustomOhMyPiAgentDirectoryForAuth",
      },
    ],
  },
];

function isProviderInstallFieldDirty(
  field: ProviderInstallField,
  settings: AppSettings,
  defaults: AppSettings,
): boolean {
  return field.kind === "password"
    ? settings[field.configuredKey] !== defaults[field.configuredKey]
    : settings[field.settingsKey] !== defaults[field.settingsKey];
}

function isProviderInstallConfigDirty(
  config: ProviderInstallSettings,
  settings: AppSettings,
  defaults: AppSettings,
): boolean {
  return (
    config.fields.some((field) => isProviderInstallFieldDirty(field, settings, defaults)) ||
    JSON.stringify(
      Object.fromEntries(
        Object.entries(settings.providerInstances).filter(
          ([, instance]) => instance.driver === config.provider,
        ),
      ),
    ) !==
      JSON.stringify(
        Object.fromEntries(
          Object.entries(defaults.providerInstances).filter(
            ([, instance]) => instance.driver === config.provider,
          ),
        ),
      ) ||
    (config.provider === "codex" &&
      (settings.selectedCodexAccountId !== defaults.selectedCodexAccountId ||
        JSON.stringify(settings.codexAccounts) !== JSON.stringify(defaults.codexAccounts)))
  );
}

/** Install fields and every account. Drives the global Restore defaults. */
export function isProviderInstallSettingsDirty(
  settings: AppSettings,
  defaults: AppSettings,
): boolean {
  return PROVIDER_INSTALL_SETTINGS.some((config) =>
    isProviderInstallConfigDirty(config, settings, defaults),
  );
}

/** Install fields and every account, for the global Restore defaults. */
export function createProviderInstallResetPatch(defaults: AppSettings): Partial<AppSettings> {
  const fieldPatch = Object.fromEntries(
    PROVIDER_INSTALL_SETTINGS.flatMap((config) =>
      config.fields.map((field) => [field.settingsKey, defaults[field.settingsKey]]),
    ),
  ) as Partial<AppSettings>;
  return {
    ...fieldPatch,
    codexAccounts: defaults.codexAccounts,
    selectedCodexAccountId: defaults.selectedCodexAccountId,
    providerInstances: defaults.providerInstances,
  };
}

// Fields that name where the default account keeps its sign-in. They stay with that
// account on the Accounts page; every other install field is a provider-wide CLI option
// shown under Providers.
export function isDefaultAccountIdentityField(field: ProviderInstallField): boolean {
  return (
    field.settingsKey === "codexHomePath" ||
    field.settingsKey === "claudeHomePath" ||
    field.settingsKey === "piAgentDir" ||
    field.settingsKey === "ompAgentDir"
  );
}

// The provider-wide CLI options the Agents list shows. Accounts, including where the
// default account keeps its sign-in, belong to the Accounts page.
const PROVIDER_CLI_FIELDS = PROVIDER_INSTALL_SETTINGS.flatMap((config) =>
  config.fields.filter((field) => !isDefaultAccountIdentityField(field)),
);

/** Whether any provider-wide CLI option differs from its default; accounts are ignored. */
export function isProviderCliFieldsDirty(settings: AppSettings, defaults: AppSettings): boolean {
  return PROVIDER_CLI_FIELDS.some((field) =>
    isProviderInstallFieldDirty(field, settings, defaults),
  );
}

/**
 * Restores the provider-wide CLI options only. Never touches accounts, so a reset from
 * the Agents list cannot sign anyone out.
 */
export function createProviderCliFieldsResetPatch(defaults: AppSettings): Partial<AppSettings> {
  return Object.fromEntries(
    PROVIDER_CLI_FIELDS.map((field) => [field.settingsKey, defaults[field.settingsKey]]),
  ) as Partial<AppSettings>;
}

export function createProviderInstallDisclosureState(
  settings: AppSettings,
): Record<ProviderKind, boolean> {
  return Object.fromEntries(
    PROVIDER_INSTALL_SETTINGS.map((config) => [
      config.provider,
      config.fields.some((field) =>
        field.kind === "password"
          ? settings[field.configuredKey]
          : Boolean(settings[field.settingsKey]),
      ) ||
        Object.values(settings.providerInstances).some(
          (instance) => instance.driver === config.provider,
        ) ||
        (config.provider === "codex" &&
          (settings.codexAccounts.length > 0 ||
            settings.selectedCodexAccountId !== DEFAULT_CODEX_ACCOUNT_ID)),
    ]),
  ) as Record<ProviderKind, boolean>;
}

export function createClosedProviderInstallDisclosureState(): Record<ProviderKind, boolean> {
  return Object.fromEntries(
    PROVIDER_INSTALL_SETTINGS.map((config) => [config.provider, false]),
  ) as Record<ProviderKind, boolean>;
}

// Null for a provider-wide setting that no account config carries.
export function providerInstanceConfigKey(field: ProviderInstallField): string | null {
  switch (field.settingsKey) {
    case "codexHomePath":
    case "claudeHomePath":
      return "homePath";
    case "cursorApiEndpoint":
      return "apiEndpoint";
    case "openCodeServerUrl":
      return "serverUrl";
    case "openCodeServerPassword":
      return "serverPassword";
    case "openCodeExperimentalWebSockets":
      return "experimentalWebSockets";
    // Every Claude account's sessions read Artifacts from the Claude provider setting,
    // never from an account's config, so the switch lives on the default account only.
    case "claudeEnableArtifacts":
    case "claudeConfirmColdCacheResume":
      return null;
    case "piAgentDir":
    case "ompAgentDir":
      return "agentDir";
    default:
      return "binaryPath";
  }
}

/** Launch config a new instance inherits from the provider's current install fields. */
export function providerInstanceLaunchConfigFor(
  provider: ProviderKind,
  settings: AppSettings,
): Record<string, unknown> {
  const config = PROVIDER_INSTALL_SETTINGS.find((entry) => entry.provider === provider);
  if (!config) return {};
  const result: Record<string, unknown> = {};
  for (const field of config.fields) {
    const key = providerInstanceConfigKey(field);
    if (key === null) continue;
    const value = settings[field.settingsKey];
    if (typeof value === "boolean") {
      if (value) result[key] = true;
      continue;
    }
    if (value.trim()) result[key] = value;
  }
  // A home names an account's identity: inheriting the default's would sign the new
  // account in as the default one.
  if (config.provider === "codex" || config.provider === "claudeAgent") {
    delete result.homePath;
  }
  return result;
}
