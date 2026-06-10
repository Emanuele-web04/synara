// FILE: ProviderInstallsSettings.tsx
// Purpose: Provider tools (installed CLIs) sub-section with per-CLI binary/home/server overrides, plus shared provider version-label helpers.
// Layer: Settings UI components
// Exports: ProviderInstallsSection, INSTALL_PROVIDER_SETTINGS, provider version-label helpers consumed by ProvidersSettings + the settings route
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type ServerProviderStatus,
} from "@t3tools/contracts";
import { type ReactNode, type Dispatch, type RefObject, type SetStateAction } from "react";
import { type AppSettings } from "../../appSettings";
import { ChevronDownIcon, DownloadIcon, ExternalLinkIcon, Loader2Icon } from "../../lib/icons";
import { SETTINGS_INSET_LIST_CLASS_NAME } from "../../settingsPanelStyles";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent } from "../ui/collapsible";
import { Input } from "../ui/input";
import { SettingResetButton } from "./SettingControls";
import { SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

type InstallBinarySettingsKey =
  | "claudeBinaryPath"
  | "codexBinaryPath"
  | "cursorBinaryPath"
  | "geminiBinaryPath"
  | "grokBinaryPath"
  | "kiloBinaryPath"
  | "openCodeBinaryPath"
  | "piBinaryPath";

type InstallProviderSettings = {
  provider: ProviderKind;
  title: string;
  docs: ReadonlyArray<{
    label: string;
    href: string;
  }>;
  binaryPathKey: InstallBinarySettingsKey;
  binaryPlaceholder: string;
  binaryDescription: ReactNode;
  homePathKey?: "codexHomePath";
  homePlaceholder?: string;
  homeDescription?: ReactNode;
  apiEndpointKey?: "cursorApiEndpoint";
  apiEndpointPlaceholder?: string;
  apiEndpointDescription?: ReactNode;
  serverUrlKey?: "kiloServerUrl" | "openCodeServerUrl";
  serverUrlPlaceholder?: string;
  serverUrlDescription?: ReactNode;
  serverPasswordKey?: "kiloServerPassword" | "openCodeServerPassword";
  serverPasswordPlaceholder?: string;
  serverPasswordDescription?: ReactNode;
  agentDirKey?: "piAgentDir";
  agentDirPlaceholder?: string;
  agentDirDescription?: ReactNode;
};

export function formatProviderVersion(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

export function providerUpdateStatusLabel(provider: ServerProviderStatus): string | null {
  const state = provider.updateState?.status;
  if (state === "queued") {
    return "Update queued";
  }
  if (state === "running") {
    return "Updating";
  }
  if (state === "succeeded") {
    return "Updated";
  }
  if (state === "failed") {
    return "Update failed";
  }
  if (state === "unchanged") {
    return "Still outdated";
  }
  const advisory = provider.versionAdvisory;
  if (advisory?.status === "behind_latest" && advisory.latestVersion) {
    const currentVersion = formatProviderVersion(advisory.currentVersion);
    const latestVersion = formatProviderVersion(advisory.latestVersion);
    return currentVersion ? `${currentVersion} -> ${latestVersion}` : `Latest ${latestVersion}`;
  }
  const currentVersion = formatProviderVersion(provider.version);
  return currentVersion ? `Current ${currentVersion}` : null;
}

export function providerUpdateFailureMessage(
  provider: ServerProviderStatus | undefined,
): string | null {
  const state = provider?.updateState;
  if (!state || (state.status !== "failed" && state.status !== "unchanged")) {
    return null;
  }
  return state.output?.trim() || state.message || "The provider update did not complete.";
}

export const INSTALL_PROVIDER_SETTINGS: readonly InstallProviderSettings[] = [
  {
    provider: "codex",
    title: "Codex",
    docs: [
      {
        label: "Install",
        href: "https://help.openai.com/en/articles/11096431",
      },
      { label: "Update", href: "https://help.openai.com/en/articles/11096431" },
      {
        label: "Config",
        href: "https://github.com/openai/codex/blob/main/docs/config.md",
      },
    ],
    binaryPathKey: "codexBinaryPath",
    binaryPlaceholder: "Codex binary path",
    binaryDescription: (
      <>
        Leave blank to use <code>codex</code> from your PATH.
      </>
    ),
    homePathKey: "codexHomePath",
    homePlaceholder: "CODEX_HOME",
    homeDescription: "Optional custom Codex home and config directory.",
  },
  {
    provider: "claudeAgent",
    title: "Claude",
    docs: [
      {
        label: "Install",
        href: "https://code.claude.com/docs/en/installation",
      },
      {
        label: "Update",
        href: "https://code.claude.com/docs/en/installation#update-claude-code",
      },
      { label: "Config", href: "https://code.claude.com/docs/en/settings" },
    ],
    binaryPathKey: "claudeBinaryPath",
    binaryPlaceholder: "Claude binary path",
    binaryDescription: (
      <>
        Leave blank to use <code>claude</code> from your PATH.
      </>
    ),
  },
  {
    provider: "cursor",
    title: "Cursor",
    docs: [
      { label: "Install", href: "https://docs.cursor.com/en/cli/installation" },
      {
        label: "Update",
        href: "https://docs.cursor.com/en/cli/installation#updates",
      },
      { label: "Config", href: "https://docs.cursor.com/en/cli/overview" },
    ],
    binaryPathKey: "cursorBinaryPath",
    binaryPlaceholder: "Cursor Agent binary path",
    binaryDescription: (
      <>
        Leave blank to use <code>cursor-agent</code> from your PATH.
      </>
    ),
    apiEndpointKey: "cursorApiEndpoint",
    apiEndpointPlaceholder: "https://api2.cursor.sh",
    apiEndpointDescription: "Optional Cursor API endpoint override passed to `cursor-agent -e`.",
  },
  {
    provider: "gemini",
    title: "Gemini",
    docs: [
      {
        label: "Install",
        href: "https://google-gemini.github.io/gemini-cli/docs/get-started/",
      },
      { label: "Update", href: "https://github.com/google-gemini/gemini-cli" },
      {
        label: "Config",
        href: "https://google-gemini.github.io/gemini-cli/docs/get-started/configuration.html",
      },
    ],
    binaryPathKey: "geminiBinaryPath",
    binaryPlaceholder: "Gemini binary path",
    binaryDescription: (
      <>
        Leave blank to use <code>gemini</code> from your PATH.
      </>
    ),
  },
  {
    provider: "grok",
    title: "Grok",
    docs: [
      { label: "Install", href: "https://docs.x.ai/build/overview" },
      {
        label: "Headless",
        href: "https://docs.x.ai/build/cli/headless-scripting",
      },
      { label: "Config", href: "https://docs.x.ai/build/overview" },
    ],
    binaryPathKey: "grokBinaryPath",
    binaryPlaceholder: "Grok binary path",
    binaryDescription: (
      <>
        Leave blank to use <code>grok</code> from your PATH.
      </>
    ),
  },
  {
    provider: "kilo",
    title: "Kilo",
    docs: [
      { label: "Install", href: "https://kilo.ai/docs/cli" },
      { label: "Update", href: "https://kilo.ai/docs/cli" },
      { label: "Config", href: "https://kilo.ai/docs/cli#configuration" },
    ],
    binaryPathKey: "kiloBinaryPath",
    binaryPlaceholder: "Kilo binary path",
    binaryDescription: (
      <>
        Leave blank to use <code>kilo</code> from your PATH.
      </>
    ),
    serverUrlKey: "kiloServerUrl",
    serverUrlPlaceholder: "http://127.0.0.1:4096",
    serverUrlDescription: "Optional existing Kilo server URL. Leave blank to spawn a local server.",
    serverPasswordKey: "kiloServerPassword",
    serverPasswordPlaceholder: "Kilo server password",
    serverPasswordDescription: "Optional password for an externally managed Kilo server.",
  },
  {
    provider: "opencode",
    title: "OpenCode",
    docs: [
      { label: "Install", href: "https://opencode.ai/docs/" },
      { label: "Update", href: "https://opencode.ai/docs/cli/" },
      { label: "Config", href: "https://opencode.ai/docs/config/" },
    ],
    binaryPathKey: "openCodeBinaryPath",
    binaryPlaceholder: "OpenCode binary path",
    binaryDescription: (
      <>
        Leave blank to use <code>opencode</code> from your PATH.
      </>
    ),
    serverUrlKey: "openCodeServerUrl",
    serverUrlPlaceholder: "http://127.0.0.1:4096",
    serverUrlDescription:
      "Optional existing OpenCode server URL. Leave blank to spawn a local server.",
    serverPasswordKey: "openCodeServerPassword",
    serverPasswordPlaceholder: "OpenCode server password",
    serverPasswordDescription: "Optional password for an externally managed OpenCode server.",
  },
  {
    provider: "pi",
    title: "Pi",
    docs: [
      { label: "Install", href: "https://pi.dev/docs/latest" },
      { label: "Update", href: "https://pi.dev/docs/latest/settings" },
      { label: "Config", href: "https://pi.dev/docs/latest/settings" },
    ],
    binaryPathKey: "piBinaryPath",
    binaryPlaceholder: "Pi binary path",
    binaryDescription: (
      <>
        Leave blank to use <code>pi</code> from your PATH.
      </>
    ),
    agentDirKey: "piAgentDir",
    agentDirPlaceholder: "Pi agent directory",
    agentDirDescription:
      "Optional custom Pi agent directory for auth, models, skills, and commands.",
  },
];

function ProviderDocsLinks({ docs }: { docs: InstallProviderSettings["docs"] }) {
  return (
    <div className={cn(SETTINGS_INSET_LIST_CLASS_NAME, "px-3 py-2.5")}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-xs font-medium text-foreground">CLI docs</span>
        <div className="flex flex-wrap gap-2">
          {docs.map((doc) => (
            <a
              key={`${doc.label}:${doc.href}`}
              href={doc.href}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-7 items-center gap-1.5 rounded-xl border border-[color:var(--color-border)] bg-transparent px-2.5 text-xs text-muted-foreground transition-colors hover:bg-[var(--color-background-elevated-secondary)] hover:text-foreground"
            >
              <span>{doc.label}</span>
              <ExternalLinkIcon className="size-3" />
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ProviderInstallsSection(props: {
  providerInstallsRef: RefObject<HTMLDivElement | null>;
  settings: AppSettings;
  defaults: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
  outdatedProviderCount: number;
  isInstallSettingsDirty: boolean;
  openInstallProviders: Record<ProviderKind, boolean>;
  setOpenInstallProviders: Dispatch<SetStateAction<Record<ProviderKind, boolean>>>;
  providerStatusByProvider: ReadonlyMap<ProviderKind, ServerProviderStatus>;
  updatingProviders: ReadonlySet<ProviderKind>;
  onRunProviderUpdate: (provider: ProviderKind) => void;
}) {
  const {
    providerInstallsRef,
    settings,
    defaults,
    updateSettings,
    outdatedProviderCount,
    isInstallSettingsDirty,
    openInstallProviders,
    setOpenInstallProviders,
    providerStatusByProvider,
    updatingProviders,
    onRunProviderUpdate,
  } = props;

  return (
    <div ref={providerInstallsRef} id="provider-installs">
      <SettingsSection title="Provider tools">
        <SettingsRow
          title="Installed CLIs"
          description="Review provider versions and update tools. Open a row only when you need binary overrides."
          status={
            outdatedProviderCount > 0
              ? `${outdatedProviderCount} update${outdatedProviderCount === 1 ? "" : "s"} available`
              : "No provider updates detected"
          }
          resetAction={
            isInstallSettingsDirty ? (
              <SettingResetButton
                label="provider tools"
                onClick={() => {
                  updateSettings({
                    claudeBinaryPath: defaults.claudeBinaryPath,
                    codexBinaryPath: defaults.codexBinaryPath,
                    codexHomePath: defaults.codexHomePath,
                    cursorBinaryPath: defaults.cursorBinaryPath,
                    cursorApiEndpoint: defaults.cursorApiEndpoint,
                    geminiBinaryPath: defaults.geminiBinaryPath,
                    grokBinaryPath: defaults.grokBinaryPath,
                    kiloBinaryPath: defaults.kiloBinaryPath,
                    kiloServerUrl: defaults.kiloServerUrl,
                    kiloServerPassword: defaults.kiloServerPassword,
                    openCodeBinaryPath: defaults.openCodeBinaryPath,
                    openCodeServerUrl: defaults.openCodeServerUrl,
                    openCodeServerPassword: defaults.openCodeServerPassword,
                    piAgentDir: defaults.piAgentDir,
                    piBinaryPath: defaults.piBinaryPath,
                  });
                  setOpenInstallProviders({
                    codex: false,
                    claudeAgent: false,
                    cursor: false,
                    gemini: false,
                    grok: false,
                    kilo: false,
                    opencode: false,
                    pi: false,
                  });
                }}
              />
            ) : null
          }
        >
          <div className="mt-4">
            <div className={SETTINGS_INSET_LIST_CLASS_NAME}>
              {INSTALL_PROVIDER_SETTINGS.map((providerSettings) => {
                const isOpen = openInstallProviders[providerSettings.provider];
                const isDirty =
                  providerSettings.provider === "codex"
                    ? settings.codexBinaryPath !== defaults.codexBinaryPath ||
                      settings.codexHomePath !== defaults.codexHomePath
                    : providerSettings.provider === "claudeAgent"
                      ? settings.claudeBinaryPath !== defaults.claudeBinaryPath
                      : providerSettings.provider === "cursor"
                        ? settings.cursorBinaryPath !== defaults.cursorBinaryPath ||
                          settings.cursorApiEndpoint !== defaults.cursorApiEndpoint
                        : providerSettings.provider === "gemini"
                          ? settings.geminiBinaryPath !== defaults.geminiBinaryPath
                          : providerSettings.provider === "grok"
                            ? settings.grokBinaryPath !== defaults.grokBinaryPath
                            : providerSettings.provider === "kilo"
                              ? settings.kiloBinaryPath !== defaults.kiloBinaryPath ||
                                settings.kiloServerUrl !== defaults.kiloServerUrl ||
                                settings.kiloServerPassword !== defaults.kiloServerPassword
                              : providerSettings.provider === "pi"
                                ? settings.piBinaryPath !== defaults.piBinaryPath ||
                                  settings.piAgentDir !== defaults.piAgentDir
                                : settings.openCodeBinaryPath !== defaults.openCodeBinaryPath ||
                                  settings.openCodeServerUrl !== defaults.openCodeServerUrl ||
                                  settings.openCodeServerPassword !==
                                    defaults.openCodeServerPassword;
                const binaryPathValue =
                  providerSettings.binaryPathKey === "claudeBinaryPath"
                    ? settings.claudeBinaryPath
                    : providerSettings.binaryPathKey === "cursorBinaryPath"
                      ? settings.cursorBinaryPath
                      : providerSettings.binaryPathKey === "geminiBinaryPath"
                        ? settings.geminiBinaryPath
                        : providerSettings.binaryPathKey === "grokBinaryPath"
                          ? settings.grokBinaryPath
                          : providerSettings.binaryPathKey === "kiloBinaryPath"
                            ? settings.kiloBinaryPath
                            : providerSettings.binaryPathKey === "openCodeBinaryPath"
                              ? settings.openCodeBinaryPath
                              : providerSettings.binaryPathKey === "piBinaryPath"
                                ? settings.piBinaryPath
                                : settings.codexBinaryPath;
                const providerStatus = providerStatusByProvider.get(providerSettings.provider);
                const providerUpdateLabel = providerStatus
                  ? providerUpdateStatusLabel(providerStatus)
                  : null;
                const updateAdvisory = providerStatus?.versionAdvisory;
                const providerUpdateState = providerStatus?.updateState?.status;
                const isProviderUpdateActive =
                  providerUpdateState === "queued" ||
                  providerUpdateState === "running" ||
                  updatingProviders.has(providerSettings.provider);
                const canUpdateProvider =
                  updateAdvisory?.status === "behind_latest" &&
                  updateAdvisory.canUpdate &&
                  !isProviderUpdateActive;

                return (
                  <Collapsible
                    key={providerSettings.provider}
                    open={isOpen}
                    onOpenChange={(open) =>
                      setOpenInstallProviders((existing) => ({
                        ...existing,
                        [providerSettings.provider]: open,
                      }))
                    }
                  >
                    <div className="border-t border-border/70 first:border-t-0">
                      <div className="flex min-h-11 items-center gap-2 px-3 py-2">
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                          onClick={() =>
                            setOpenInstallProviders((existing) => ({
                              ...existing,
                              [providerSettings.provider]: !existing[providerSettings.provider],
                            }))
                          }
                        >
                          <span className="min-w-0 flex-1 text-sm font-medium text-foreground">
                            {providerSettings.title}
                          </span>
                          {isDirty ? (
                            <span className="shrink-0 text-[11px] text-muted-foreground">
                              Custom
                            </span>
                          ) : null}
                          {providerUpdateLabel ? (
                            <span
                              className={cn(
                                "shrink-0 text-[11px]",
                                updateAdvisory?.status === "behind_latest"
                                  ? "text-foreground"
                                  : "text-muted-foreground",
                              )}
                            >
                              {providerUpdateLabel}
                            </span>
                          ) : null}
                          <ChevronDownIcon
                            className={cn(
                              "size-4 shrink-0 text-muted-foreground transition-transform",
                              isOpen && "rotate-180",
                            )}
                          />
                        </button>
                        {updateAdvisory?.status === "behind_latest" && updateAdvisory.canUpdate ? (
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            disabled={!canUpdateProvider}
                            title={
                              updateAdvisory.updateCommand
                                ? `Run ${updateAdvisory.updateCommand}`
                                : undefined
                            }
                            onClick={(event) => {
                              event.stopPropagation();
                              onRunProviderUpdate(providerSettings.provider);
                            }}
                          >
                            {isProviderUpdateActive ? (
                              <Loader2Icon className="size-3.5 animate-spin" />
                            ) : (
                              <DownloadIcon className="size-3.5" />
                            )}
                            {isProviderUpdateActive ? "Updating" : "Update"}
                          </Button>
                        ) : null}
                      </div>

                      <CollapsibleContent>
                        <div className="border-t border-border/70 bg-muted/20 px-3 py-3">
                          <div className="space-y-3">
                            <ProviderDocsLinks docs={providerSettings.docs} />
                            {updateAdvisory?.status === "behind_latest" ? (
                              <div className="text-xs text-muted-foreground">
                                {updateAdvisory.canUpdate && updateAdvisory.updateCommand ? (
                                  <>
                                    <span>Command: </span>
                                    <code className="font-mono">
                                      {updateAdvisory.updateCommand}
                                    </code>
                                  </>
                                ) : (
                                  "A newer version is available, but Synara could not identify a safe one-click update command for this installation."
                                )}
                              </div>
                            ) : null}

                            <label
                              htmlFor={`provider-install-${providerSettings.binaryPathKey}`}
                              className="block"
                            >
                              <span className="block text-xs font-medium text-foreground">
                                {providerSettings.title} binary path
                              </span>
                              <Input
                                id={`provider-install-${providerSettings.binaryPathKey}`}
                                className="mt-1"
                                value={binaryPathValue}
                                onChange={(event) =>
                                  updateSettings(
                                    providerSettings.binaryPathKey === "claudeBinaryPath"
                                      ? { claudeBinaryPath: event.target.value }
                                      : providerSettings.binaryPathKey === "cursorBinaryPath"
                                        ? {
                                            cursorBinaryPath: event.target.value,
                                          }
                                        : providerSettings.binaryPathKey === "geminiBinaryPath"
                                          ? {
                                              geminiBinaryPath: event.target.value,
                                            }
                                          : providerSettings.binaryPathKey === "grokBinaryPath"
                                            ? {
                                                grokBinaryPath: event.target.value,
                                              }
                                            : providerSettings.binaryPathKey === "kiloBinaryPath"
                                              ? {
                                                  kiloBinaryPath: event.target.value,
                                                }
                                              : providerSettings.binaryPathKey ===
                                                  "openCodeBinaryPath"
                                                ? {
                                                    openCodeBinaryPath: event.target.value,
                                                  }
                                                : providerSettings.binaryPathKey === "piBinaryPath"
                                                  ? {
                                                      piBinaryPath: event.target.value,
                                                    }
                                                  : {
                                                      codexBinaryPath: event.target.value,
                                                    },
                                  )
                                }
                                placeholder={providerSettings.binaryPlaceholder}
                                spellCheck={false}
                              />
                              <span className="mt-1 block text-xs text-muted-foreground">
                                {providerSettings.binaryDescription}
                              </span>
                            </label>

                            {providerSettings.homePathKey ? (
                              <label
                                htmlFor={`provider-install-${providerSettings.homePathKey}`}
                                className="block"
                              >
                                <span className="block text-xs font-medium text-foreground">
                                  CODEX_HOME path
                                </span>
                                <Input
                                  id={`provider-install-${providerSettings.homePathKey}`}
                                  className="mt-1"
                                  value={settings.codexHomePath}
                                  onChange={(event) =>
                                    updateSettings({
                                      codexHomePath: event.target.value,
                                    })
                                  }
                                  placeholder={providerSettings.homePlaceholder}
                                  spellCheck={false}
                                />
                                {providerSettings.homeDescription ? (
                                  <span className="mt-1 block text-xs text-muted-foreground">
                                    {providerSettings.homeDescription}
                                  </span>
                                ) : null}
                              </label>
                            ) : null}

                            {providerSettings.agentDirKey ? (
                              <label
                                htmlFor={`provider-install-${providerSettings.agentDirKey}`}
                                className="block"
                              >
                                <span className="block text-xs font-medium text-foreground">
                                  Pi agent directory
                                </span>
                                <Input
                                  id={`provider-install-${providerSettings.agentDirKey}`}
                                  className="mt-1"
                                  value={settings.piAgentDir}
                                  onChange={(event) =>
                                    updateSettings({
                                      piAgentDir: event.target.value,
                                    })
                                  }
                                  placeholder={providerSettings.agentDirPlaceholder}
                                  spellCheck={false}
                                />
                                {providerSettings.agentDirDescription ? (
                                  <span className="mt-1 block text-xs text-muted-foreground">
                                    {providerSettings.agentDirDescription}
                                  </span>
                                ) : null}
                              </label>
                            ) : null}

                            {providerSettings.apiEndpointKey ? (
                              <label
                                htmlFor={`provider-install-${providerSettings.apiEndpointKey}`}
                                className="block"
                              >
                                <span className="block text-xs font-medium text-foreground">
                                  Cursor API endpoint
                                </span>
                                <Input
                                  id={`provider-install-${providerSettings.apiEndpointKey}`}
                                  className="mt-1"
                                  value={settings.cursorApiEndpoint}
                                  onChange={(event) =>
                                    updateSettings({
                                      cursorApiEndpoint: event.target.value,
                                    })
                                  }
                                  placeholder={providerSettings.apiEndpointPlaceholder}
                                  spellCheck={false}
                                />
                                {providerSettings.apiEndpointDescription ? (
                                  <span className="mt-1 block text-xs text-muted-foreground">
                                    {providerSettings.apiEndpointDescription}
                                  </span>
                                ) : null}
                              </label>
                            ) : null}

                            {providerSettings.serverUrlKey ? (
                              <label
                                htmlFor={`provider-install-${providerSettings.serverUrlKey}`}
                                className="block"
                              >
                                <span className="block text-xs font-medium text-foreground">
                                  {providerSettings.title} server URL
                                </span>
                                <Input
                                  id={`provider-install-${providerSettings.serverUrlKey}`}
                                  className="mt-1"
                                  value={
                                    providerSettings.serverUrlKey === "kiloServerUrl"
                                      ? settings.kiloServerUrl
                                      : settings.openCodeServerUrl
                                  }
                                  onChange={(event) =>
                                    updateSettings(
                                      providerSettings.serverUrlKey === "kiloServerUrl"
                                        ? { kiloServerUrl: event.target.value }
                                        : {
                                            openCodeServerUrl: event.target.value,
                                          },
                                    )
                                  }
                                  placeholder={providerSettings.serverUrlPlaceholder}
                                  spellCheck={false}
                                />
                                {providerSettings.serverUrlDescription ? (
                                  <span className="mt-1 block text-xs text-muted-foreground">
                                    {providerSettings.serverUrlDescription}
                                  </span>
                                ) : null}
                              </label>
                            ) : null}

                            {providerSettings.serverPasswordKey ? (
                              <label
                                htmlFor={`provider-install-${providerSettings.serverPasswordKey}`}
                                className="block"
                              >
                                <span className="block text-xs font-medium text-foreground">
                                  {providerSettings.title} server password
                                </span>
                                <Input
                                  id={`provider-install-${providerSettings.serverPasswordKey}`}
                                  className="mt-1"
                                  value={
                                    providerSettings.serverPasswordKey === "kiloServerPassword"
                                      ? settings.kiloServerPassword
                                      : settings.openCodeServerPassword
                                  }
                                  onChange={(event) =>
                                    updateSettings(
                                      providerSettings.serverPasswordKey === "kiloServerPassword"
                                        ? {
                                            kiloServerPassword: event.target.value,
                                          }
                                        : {
                                            openCodeServerPassword: event.target.value,
                                          },
                                    )
                                  }
                                  placeholder={providerSettings.serverPasswordPlaceholder}
                                  spellCheck={false}
                                />
                                {providerSettings.serverPasswordDescription ? (
                                  <span className="mt-1 block text-xs text-muted-foreground">
                                    {providerSettings.serverPasswordDescription}
                                  </span>
                                ) : null}
                              </label>
                            ) : null}
                          </div>
                        </div>
                      </CollapsibleContent>
                    </div>
                  </Collapsible>
                );
              })}
            </div>
          </div>
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}
