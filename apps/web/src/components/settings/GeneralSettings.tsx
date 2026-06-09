// FILE: GeneralSettings.tsx
// Purpose: General settings panel (default provider, new-thread mode, sidebar side and sort orders).
// Layer: Settings UI components
// Exports: GeneralSettings

import { PROVIDER_DISPLAY_NAMES, type ProviderKind } from "@t3tools/contracts";
import { type AppSettings } from "../../appSettings";
import { ProviderOptionLabel } from "../ProviderIcon";
import { SelectItem } from "../ui/select";
import { SettingResetButton, SettingsSelectControl } from "./SettingControls";
import { SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

const PROVIDER_SELECT_OPTIONS = [
  "codex",
  "claudeAgent",
  "cursor",
  "gemini",
  "grok",
  "opencode",
  "kilo",
  "pi",
] as const satisfies readonly ProviderKind[];

const SIDEBAR_SIDE_LABELS = {
  left: "Left",
  right: "Right",
} as const;

const SIDEBAR_PROJECT_SORT_ORDER_LABELS = {
  updated_at: "Recently active",
  created_at: "Recently added",
  manual: "Manual order",
} as const;

const SIDEBAR_THREAD_SORT_ORDER_LABELS = {
  updated_at: "Recently active",
  created_at: "Newest first",
} as const;

function isProviderSelectOption(value: string): value is ProviderKind {
  return PROVIDER_SELECT_OPTIONS.includes(value as ProviderKind);
}

export function GeneralSettings({
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
      <SettingsSection title="Core defaults">
        <SettingsRow
          title="Default provider"
          description="Choose the provider used for new chats."
          resetAction={
            settings.defaultProvider !== defaults.defaultProvider ? (
              <SettingResetButton
                label="default provider"
                onClick={() => updateSettings({ defaultProvider: defaults.defaultProvider })}
              />
            ) : null
          }
          control={
            <SettingsSelectControl
              value={settings.defaultProvider}
              onValueChange={(value) => {
                if (!isProviderSelectOption(value)) return;
                updateSettings({ defaultProvider: value });
              }}
              ariaLabel="Default provider"
              valueContent={
                <ProviderOptionLabel
                  provider={settings.defaultProvider}
                  label={PROVIDER_DISPLAY_NAMES[settings.defaultProvider]}
                />
              }
            >
              {PROVIDER_SELECT_OPTIONS.map((provider) => (
                <SelectItem hideIndicator key={provider} value={provider}>
                  <ProviderOptionLabel
                    provider={provider}
                    label={PROVIDER_DISPLAY_NAMES[provider]}
                  />
                </SelectItem>
              ))}
            </SettingsSelectControl>
          }
        />

        <SettingsRow
          title="New threads"
          description="Pick the default workspace mode for newly created draft threads."
          resetAction={
            settings.defaultThreadEnvMode !== defaults.defaultThreadEnvMode ? (
              <SettingResetButton
                label="new threads"
                onClick={() =>
                  updateSettings({
                    defaultThreadEnvMode: defaults.defaultThreadEnvMode,
                  })
                }
              />
            ) : null
          }
          control={
            <SettingsSelectControl
              value={settings.defaultThreadEnvMode}
              onValueChange={(value) => {
                if (value !== "local" && value !== "worktree") return;
                updateSettings({
                  defaultThreadEnvMode: value,
                });
              }}
              ariaLabel="Default thread mode"
              valueContent={settings.defaultThreadEnvMode === "worktree" ? "New worktree" : "Local"}
            >
              <SelectItem hideIndicator value="local">
                Local
              </SelectItem>
              <SelectItem hideIndicator value="worktree">
                New worktree
              </SelectItem>
            </SettingsSelectControl>
          }
        />
      </SettingsSection>

      <SettingsSection title="Sidebar organization">
        <SettingsRow
          title="Position"
          description="Choose which side of the screen the sidebar appears on."
          resetAction={
            settings.sidebarSide !== defaults.sidebarSide ? (
              <SettingResetButton
                label="sidebar position"
                onClick={() =>
                  updateSettings({
                    sidebarSide: defaults.sidebarSide,
                  })
                }
              />
            ) : null
          }
          control={
            <SettingsSelectControl
              value={settings.sidebarSide}
              onValueChange={(value) => {
                if (value !== "left" && value !== "right") {
                  return;
                }
                updateSettings({ sidebarSide: value });
              }}
              ariaLabel="Sidebar position"
              valueContent={SIDEBAR_SIDE_LABELS[settings.sidebarSide]}
            >
              <SelectItem hideIndicator value="left">
                {SIDEBAR_SIDE_LABELS.left}
              </SelectItem>
              <SelectItem hideIndicator value="right">
                {SIDEBAR_SIDE_LABELS.right}
              </SelectItem>
            </SettingsSelectControl>
          }
        />

        <SettingsRow
          title="Project order"
          description="Controls how projects are arranged in the main sidebar."
          resetAction={
            settings.sidebarProjectSortOrder !== defaults.sidebarProjectSortOrder ? (
              <SettingResetButton
                label="project order"
                onClick={() =>
                  updateSettings({
                    sidebarProjectSortOrder: defaults.sidebarProjectSortOrder,
                  })
                }
              />
            ) : null
          }
          control={
            <SettingsSelectControl
              value={settings.sidebarProjectSortOrder}
              onValueChange={(value) => {
                if (value !== "updated_at" && value !== "created_at" && value !== "manual") {
                  return;
                }
                updateSettings({ sidebarProjectSortOrder: value });
              }}
              ariaLabel="Project sort order"
              valueContent={SIDEBAR_PROJECT_SORT_ORDER_LABELS[settings.sidebarProjectSortOrder]}
            >
              <SelectItem hideIndicator value="updated_at">
                {SIDEBAR_PROJECT_SORT_ORDER_LABELS.updated_at}
              </SelectItem>
              <SelectItem hideIndicator value="created_at">
                {SIDEBAR_PROJECT_SORT_ORDER_LABELS.created_at}
              </SelectItem>
              <SelectItem hideIndicator value="manual">
                {SIDEBAR_PROJECT_SORT_ORDER_LABELS.manual}
              </SelectItem>
            </SettingsSelectControl>
          }
        />

        <SettingsRow
          title="Thread order"
          description="Controls how threads are arranged inside each project in the main sidebar."
          resetAction={
            settings.sidebarThreadSortOrder !== defaults.sidebarThreadSortOrder ? (
              <SettingResetButton
                label="thread order"
                onClick={() =>
                  updateSettings({
                    sidebarThreadSortOrder: defaults.sidebarThreadSortOrder,
                  })
                }
              />
            ) : null
          }
          control={
            <SettingsSelectControl
              value={settings.sidebarThreadSortOrder}
              onValueChange={(value) => {
                if (value !== "updated_at" && value !== "created_at") {
                  return;
                }
                updateSettings({ sidebarThreadSortOrder: value });
              }}
              ariaLabel="Thread sort order"
              valueContent={SIDEBAR_THREAD_SORT_ORDER_LABELS[settings.sidebarThreadSortOrder]}
            >
              <SelectItem hideIndicator value="updated_at">
                {SIDEBAR_THREAD_SORT_ORDER_LABELS.updated_at}
              </SelectItem>
              <SelectItem hideIndicator value="created_at">
                {SIDEBAR_THREAD_SORT_ORDER_LABELS.created_at}
              </SelectItem>
            </SettingsSelectControl>
          }
        />
      </SettingsSection>
    </div>
  );
}
