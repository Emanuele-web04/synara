// FILE: SandboxesSettings.tsx
// Purpose: Sandboxes settings panel (remote runtime defaults, MCP sync, provider credentials).
// Layer: Settings UI components
// Exports: SandboxesSettings

import { type AppSettings } from "../../appSettings";
import { Input } from "../ui/input";
import { SelectItem } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  SANDBOX_DEFAULT_PROVIDER_OPTIONS,
  SANDBOX_PROVIDER_DESCRIPTORS,
} from "../../sandboxSettings";
import { SettingResetButton, SettingsSelectControl } from "./SettingControls";
import { SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

const NO_DEFAULT_REMOTE_PROVIDER_VALUE = "__no-default-remote-provider__";

const sandboxRuntimeTextFields: ReadonlyArray<{
  appKey:
    | "sandboxRuntimeCpu"
    | "sandboxRuntimeMemoryMb"
    | "sandboxRuntimeTimeoutSeconds"
    | "sandboxRuntimePorts";
  title: string;
  resetLabel: string;
  description: string;
  placeholder: string;
}> = [
  {
    appKey: "sandboxRuntimeCpu",
    title: "CPU",
    resetLabel: "CPU default",
    description: "vCPUs requested for the sandbox. Blank uses the provider default.",
    placeholder: "provider default",
  },
  {
    appKey: "sandboxRuntimeMemoryMb",
    title: "Memory (MB)",
    resetLabel: "memory default",
    description: "Memory requested for the sandbox, in MB. Blank uses the provider default.",
    placeholder: "provider default",
  },
  {
    appKey: "sandboxRuntimeTimeoutSeconds",
    title: "Timeout (s)",
    resetLabel: "timeout default",
    description: "Max sandbox lifetime in seconds before the provider reclaims it.",
    placeholder: "provider default",
  },
  {
    appKey: "sandboxRuntimePorts",
    title: "Exposed ports",
    resetLabel: "ports default",
    description: "Comma-separated ports to expose from the sandbox.",
    placeholder: "3000, 8080",
  },
];

export function SandboxesSettings({
  settings,
  defaults,
  updateSettings,
}: {
  settings: AppSettings;
  defaults: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
}) {
  return (
    <div className="space-y-6">
      <SettingsSection title="Defaults">
        <SettingsRow
          title="Default remote provider"
          description="Provider used when a new remote-runtime thread does not pick one."
          resetAction={
            settings.sandboxDefaultRemoteProvider !== defaults.sandboxDefaultRemoteProvider ? (
              <SettingResetButton
                label="default remote provider"
                onClick={() =>
                  updateSettings({
                    sandboxDefaultRemoteProvider: defaults.sandboxDefaultRemoteProvider,
                  })
                }
              />
            ) : null
          }
          control={
            <SettingsSelectControl
              value={
                settings.sandboxDefaultRemoteProvider.length > 0
                  ? settings.sandboxDefaultRemoteProvider
                  : NO_DEFAULT_REMOTE_PROVIDER_VALUE
              }
              onValueChange={(value) =>
                updateSettings({
                  sandboxDefaultRemoteProvider:
                    value === NO_DEFAULT_REMOTE_PROVIDER_VALUE ? "" : value,
                })
              }
              ariaLabel="Default remote provider"
              valueContent={
                SANDBOX_DEFAULT_PROVIDER_OPTIONS.find(
                  (option) => option.value === settings.sandboxDefaultRemoteProvider,
                )?.label ?? "No preference"
              }
            >
              {SANDBOX_DEFAULT_PROVIDER_OPTIONS.map((option) => (
                <SelectItem
                  hideIndicator
                  key={option.value || "none"}
                  value={option.value.length > 0 ? option.value : NO_DEFAULT_REMOTE_PROVIDER_VALUE}
                >
                  {option.label}
                </SelectItem>
              ))}
            </SettingsSelectControl>
          }
        />
        <SettingsRow
          title="Post-clone command"
          description="Optional command run in the sandbox after the repo is cloned (e.g. `pnpm install --frozen-lockfile`), so a remote agent can run tests/lint/typecheck. Use `auto` to detect a package manager from the lockfile. Empty (default) skips it. Best-effort: a failure does not block the session."
          resetAction={
            settings.sandboxPostCloneCommand !== defaults.sandboxPostCloneCommand ? (
              <SettingResetButton
                label="post-clone command"
                onClick={() =>
                  updateSettings({
                    sandboxPostCloneCommand: defaults.sandboxPostCloneCommand,
                  })
                }
              />
            ) : null
          }
          control={
            <Input
              className="w-full"
              type="text"
              value={settings.sandboxPostCloneCommand}
              onChange={(event) => updateSettings({ sandboxPostCloneCommand: event.target.value })}
              placeholder="pnpm install --frozen-lockfile"
              spellCheck={false}
              aria-label="Post-clone command"
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Remote runtime defaults">
        {sandboxRuntimeTextFields.map((field) => (
          <SettingsRow
            key={field.appKey}
            title={field.title}
            description={field.description}
            resetAction={
              settings[field.appKey] !== defaults[field.appKey] ? (
                <SettingResetButton
                  label={field.resetLabel}
                  onClick={() => updateSettings({ [field.appKey]: defaults[field.appKey] })}
                />
              ) : null
            }
            control={
              <Input
                className="w-full"
                type="text"
                value={settings[field.appKey]}
                onChange={(event) => updateSettings({ [field.appKey]: event.target.value })}
                placeholder={field.placeholder}
                spellCheck={false}
                aria-label={field.title}
              />
            }
          />
        ))}
        <SettingsRow
          title="Persistent runtime"
          description="Keep the sandbox alive between turns instead of tearing it down after each one. The provider must support a persistent filesystem."
          resetAction={
            settings.sandboxRuntimePersistent !== defaults.sandboxRuntimePersistent ? (
              <SettingResetButton
                label="persistent runtime"
                onClick={() =>
                  updateSettings({
                    sandboxRuntimePersistent: defaults.sandboxRuntimePersistent,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.sandboxRuntimePersistent === "true"}
              onCheckedChange={(checked) =>
                updateSettings({ sandboxRuntimePersistent: checked ? "true" : "false" })
              }
              aria-label="Persistent runtime"
            />
          }
        />
        <SettingsRow
          title="Sync Codex MCP plugins"
          description="Inject your local Codex HTTP MCP servers (and their resolved auth) into a remote sandbox, so a remote agent has the same tools a local one does. Off by default — enabling sends those credentials to the cloud VM. stdio servers are never synced."
          resetAction={
            settings.sandboxRuntimeSyncMcpPlugins !== defaults.sandboxRuntimeSyncMcpPlugins ? (
              <SettingResetButton
                label="MCP plugin sync"
                onClick={() =>
                  updateSettings({
                    sandboxRuntimeSyncMcpPlugins: defaults.sandboxRuntimeSyncMcpPlugins,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.sandboxRuntimeSyncMcpPlugins === "true"}
              onCheckedChange={(checked) =>
                updateSettings({ sandboxRuntimeSyncMcpPlugins: checked ? "true" : "false" })
              }
              aria-label="Sync Codex MCP plugins"
            />
          }
        />
        {settings.sandboxRuntimeSyncMcpPlugins === "true" ? (
          <SettingsRow
            title="MCP plugin allowlist"
            description="Optional comma-separated MCP server names to sync. Blank syncs every runnable HTTP server."
            resetAction={
              settings.sandboxRuntimeMcpAllowlist !== defaults.sandboxRuntimeMcpAllowlist ? (
                <SettingResetButton
                  label="MCP allowlist"
                  onClick={() =>
                    updateSettings({
                      sandboxRuntimeMcpAllowlist: defaults.sandboxRuntimeMcpAllowlist,
                    })
                  }
                />
              ) : null
            }
            control={
              <Input
                className="w-full"
                type="text"
                value={settings.sandboxRuntimeMcpAllowlist}
                onChange={(event) =>
                  updateSettings({ sandboxRuntimeMcpAllowlist: event.target.value })
                }
                placeholder="exa, novu"
                spellCheck={false}
                aria-label="MCP plugin allowlist"
              />
            }
          />
        ) : null}
      </SettingsSection>

      {SANDBOX_PROVIDER_DESCRIPTORS.map((provider) => (
        <SettingsSection key={provider.id} title={provider.title}>
          <SettingsRow
            title={`${provider.title} credentials`}
            description="Secrets are stored on the server and never sent back to the browser."
          >
            <div className="mt-3 space-y-4">
              {provider.fields.map((field) => {
                const value = settings[field.appKey];
                const inputId = `sandbox-${provider.id}-${field.serverField}`;
                return (
                  <label key={field.appKey} htmlFor={inputId} className="block">
                    <span className="flex items-center gap-2">
                      <span className="block text-xs font-medium text-foreground">
                        {field.label}
                      </span>
                      {field.secret && value ? (
                        <span className="inline-flex items-center rounded-full border border-[color:var(--color-border)] px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          Configured
                        </span>
                      ) : null}
                    </span>
                    <Input
                      id={inputId}
                      className="mt-1"
                      type={field.secret ? "password" : "text"}
                      autoComplete={field.secret ? "off" : undefined}
                      value={value}
                      onChange={(event) => updateSettings({ [field.appKey]: event.target.value })}
                      placeholder={field.placeholder}
                      spellCheck={false}
                    />
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {field.description}
                    </span>
                  </label>
                );
              })}
            </div>
          </SettingsRow>
        </SettingsSection>
      ))}
    </div>
  );
}
