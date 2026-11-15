// FILE: ProviderAccountEditor.tsx
// Purpose: One account's detail view on the Accounts page: status and sign-in, identity
//          (name, accent), runtime, environment, and remove or reset.
// Layer: Settings UI
// Exports: ProviderAccountEditor

import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ServerProviderStatus,
  type ServerProviderUsageSnapshot,
} from "@synara/contracts";
import { providerCliCommandName } from "@synara/shared/providerCliProfiles";
import type { ReactNode } from "react";

import {
  getManageableProviderInstances,
  getProviderInstanceOptions,
  removeManageableProviderInstance,
  type AppSettings,
  type ProviderInstanceOption,
} from "~/appSettings";
import { useTranslation } from "~/i18n";
import { Loader2Icon, PlayIcon, XIcon } from "~/lib/icons";
import { providerAccountIdentityLabel } from "~/lib/providerInstancePresentation";
import { providerAccountStatusSummary } from "~/lib/providerSetupStatus";
import { cn } from "~/lib/utils";
import {
  SETTINGS_INSET_RADIUS_CLASS_NAME,
  SETTINGS_OUTLINED_SURFACE_CLASS_NAME,
} from "~/settingsPanelStyles";

import { ProviderAccountAvatar } from "../../ProviderAccountMark";
import { Button } from "../../ui/button";
import { StatusChip } from "../../ui/status-chip";
import { DebouncedSettingTextInput } from "../DebouncedSettingTextInput";
import { ProviderInstallFieldControl } from "../providers/ProviderInstallFieldControl";
import {
  isDefaultAccountIdentityField,
  type ProviderInstallSettings,
} from "../providers/providerInstallSettings";
import { SettingResetButton } from "../SettingControls";
import { SettingsEmptyState } from "../SettingsPanelPrimitives";
import { CodexDefaultAccountControl } from "./CodexDefaultAccountControl";
import { ProviderAccentColorControl } from "./ProviderAccentColorControl";
import {
  ACCOUNT_STATUS_DOT_CLASS_NAME,
  ACCOUNT_STATUS_PILL_CLASS_NAME,
  DefaultAccountBadge,
  providerInstanceUpdater,
  useProviderAccountSignIn,
} from "./providerAccountShared";
import { ProviderAccountRuntimeFields } from "./ProviderAccountRuntimeFields";
import { ProviderInstanceEnvironmentEditor } from "./ProviderInstanceEnvironmentEditor";

export function ProviderAccountEditor(props: {
  config: ProviderInstallSettings;
  /** The account to edit. */
  accountId: string;
  providerStatusByInstance: ReadonlyMap<string, ServerProviderStatus>;
  /** Usage snapshots by account, fetched once for the whole Accounts page. */
  usageByInstance: ReadonlyMap<string, ServerProviderUsageSnapshot>;
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
  updateSettingsAndWait: (patch: Partial<AppSettings>) => Promise<void>;
  /** The shown account was removed. */
  onAccountRemoved: () => void;
}) {
  const { t } = useTranslation();

  const provider = props.config.provider;
  const providerLabel = PROVIDER_DISPLAY_NAMES[provider];
  const allAccounts = getProviderInstanceOptions(props.settings);
  const accounts = allAccounts.filter((account) => account.provider === provider);
  const manageableById = new Map(
    getManageableProviderInstances(props.settings, provider).map((entry) => [
      String(entry.instanceId),
      entry,
    ]),
  );
  const { startSignIn, startingSignIn, signInDialog } = useProviderAccountSignIn(
    props.updateSettingsAndWait,
  );
  const updateInstance = providerInstanceUpdater(props.settings, props.updateSettings);
  const selectedAccount =
    accounts.find((account) => account.instanceId === props.accountId) ?? null;

  const terminalCommandCounts = allAccounts.reduce((counts, option) => {
    const config = props.settings.providerInstances[String(option.instanceId)]?.config;
    const command = providerCliCommandName({
      provider: option.provider,
      instanceId: option.instanceId,
      config:
        config && typeof config === "object" && !Array.isArray(config)
          ? (config as Record<string, unknown>)
          : undefined,
    });
    counts.set(command, (counts.get(command) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());
  // Restore appearance and enablement while retaining the account's name and launch overrides.
  const resetDefaultAccount = () => {
    const explicit = props.settings.providerInstances[provider];
    if (!explicit) return;
    const { accentColor: _accentColor, enabled: _enabled, ...rest } = explicit;
    const next = { ...props.settings.providerInstances } as Record<string, ProviderInstanceConfig>;
    if (Object.keys(rest).length > 1) {
      next[provider] = rest;
    } else {
      delete next[provider];
    }
    props.updateSettings({ providerInstances: next as ProviderInstanceConfigMap });
  };

  const renderEditor = (account: ProviderInstanceOption) => {
    const instanceId = String(account.instanceId);
    const manageable = manageableById.get(instanceId) ?? null;
    const explicit = props.settings.providerInstances[instanceId];
    const legacyCodexAccountId = manageable?.legacyCodexAccountId ?? null;
    const liveStatus = props.providerStatusByInstance.get(instanceId);
    const status = providerAccountStatusSummary(
      {
        status: liveStatus,
        enabled: account.enabled,
        usageSnapshot: props.usageByInstance.get(instanceId),
      },
      t,
    );
    const cliCommand = account.isDefault
      ? provider === "claudeAgent"
        ? "claude"
        : provider
      : providerCliCommandName({
          provider,
          instanceId: account.instanceId,
          config:
            manageable?.instance.config &&
            typeof manageable.instance.config === "object" &&
            !Array.isArray(manageable.instance.config)
              ? (manageable.instance.config as Record<string, unknown>)
              : undefined,
        });
    const defaultIsCustomized =
      account.isDefault &&
      explicit !== undefined &&
      (explicit.accentColor !== undefined || explicit.enabled === false);
    const identity = providerAccountIdentityLabel(liveStatus);
    return (
      <div
        className={cn(
          SETTINGS_OUTLINED_SURFACE_CLASS_NAME,
          SETTINGS_INSET_RADIUS_CLASS_NAME,
          "min-w-0 flex-1 overflow-hidden",
        )}
        // Remount per account so a pending debounced edit can never land on another one.
        key={instanceId}
        role="group"
        aria-label={t("settings:account", { value0: account.label })}
      >
        <div className="flex items-start gap-3 border-b border-border/70 bg-muted/25 px-3 py-3">
          <ProviderAccountAvatar provider={provider} accentColor={account.accentColor} size="md" />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-ui-lg font-medium text-foreground">
                {account.label}
              </span>
              {account.isDefault ? <DefaultAccountBadge /> : null}
            </div>
            {identity ? (
              <span className="block truncate text-ui-sm text-muted-foreground">{identity}</span>
            ) : null}
            <StatusChip
              variant="pill"
              className={cn("mt-1 w-fit max-w-full", ACCOUNT_STATUS_PILL_CLASS_NAME[status.tone])}
              dotClassName={ACCOUNT_STATUS_DOT_CLASS_NAME[status.tone]}
            >
              <span className="truncate">{status.headline}</span>
            </StatusChip>
          </div>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={!account.enabled || liveStatus?.available === false || startingSignIn}
            aria-label={t("settings:signInTo2", { value0: account.label })}
            onClick={() => void startSignIn(account)}
          >
            {startingSignIn ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <PlayIcon className="size-3.5" />
            )}
            {t("chat:providerModelPicker_signIn")}
          </Button>
          {account.isDefault ? (
            defaultIsCustomized ? (
              <SettingResetButton
                label={t("settings:account", { value0: account.label })}
                onClick={resetDefaultAccount}
              />
            ) : null
          ) : (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => {
                props.updateSettings(removeManageableProviderInstance(props.settings, instanceId));
                props.onAccountRemoved();
              }}
            >
              <XIcon className="size-3.5" />
              {t("workspace:edit_remove")}
            </Button>
          )}
        </div>

        {status.detail && status.tone !== "ready" && status.tone !== "idle" ? (
          <div className="border-b border-border/70 px-3 py-2 text-ui-sm text-muted-foreground">
            {liveStatus?.authStatus === "unauthenticated"
              ? t("settings:useSignInToAuthenticateThisAccountThenComplete")
              : status.detail}
          </div>
        ) : null}

        <ProviderAccountEditorSection title={t("settings:identity")}>
          <div className="space-y-3">
            <div className="space-y-1">
              <label
                htmlFor={`provider-instance-${instanceId}-label`}
                className="block text-ui-sm font-medium text-foreground"
              >
                {t("common:edit_displayName")}
              </label>
              <DebouncedSettingTextInput
                id={`provider-instance-${instanceId}-label`}
                size="sm"
                variant="soft"
                value={
                  account.isDefault
                    ? (explicit?.displayName ?? "")
                    : (manageable?.instance.displayName ?? "")
                }
                onCommit={(displayName) =>
                  updateInstance(instanceId, { displayName }, legacyCodexAccountId)
                }
                placeholder={account.isDefault ? providerLabel : t("common:work")}
                spellCheck={false}
              />
            </div>
            <div className="space-y-1">
              <span className="block text-ui-sm font-medium text-foreground">
                {t("settings:accentColor")}
              </span>
              <div className="flex min-h-7 items-center">
                <ProviderAccentColorControl
                  value={account.accentColor}
                  accountLabel={account.label}
                  onChange={(accentColor) =>
                    updateInstance(instanceId, { accentColor: accentColor ?? null })
                  }
                />
              </div>
            </div>
          </div>
        </ProviderAccountEditorSection>

        <ProviderAccountEditorSection title={t("settings:runtime")}>
          {account.isDefault ? (
            <div className="space-y-3">
              {props.config.fields.filter(isDefaultAccountIdentityField).map((field) => (
                <ProviderInstallFieldControl
                  key={field.settingsKey}
                  field={field}
                  settings={props.settings}
                  updateSettings={props.updateSettings}
                />
              ))}
              <span className="block text-ui-sm text-muted-foreground">
                {t("settings:accounts_providerOptionsInProviders", { value0: providerLabel })}
              </span>
              {provider === "codex" && props.settings.codexAccounts.length > 0 ? (
                <CodexDefaultAccountControl
                  settings={props.settings}
                  updateSettings={props.updateSettings}
                />
              ) : null}
            </div>
          ) : manageable ? (
            <ProviderAccountRuntimeFields
              config={props.config}
              entry={manageable}
              cliCommand={cliCommand}
              cliCommandConflicts={(terminalCommandCounts.get(cliCommand) ?? 0) > 1}
              updateInstance={updateInstance}
            />
          ) : null}
        </ProviderAccountEditorSection>

        {/* A migrated Codex account is routed by its saved identity; an environment of
            its own would make the server drop that route, so none is offered. */}
        {legacyCodexAccountId === null ? (
          <ProviderAccountEditorSection title={t("chat:general_environmentPanel")}>
            <ProviderInstanceEnvironmentEditor
              instanceId={instanceId}
              environment={
                account.isDefault ? explicit?.environment : manageable?.instance.environment
              }
              onChange={(environment) => updateInstance(instanceId, { environment })}
            />
          </ProviderAccountEditorSection>
        ) : null}
      </div>
    );
  };

  return (
    <>
      {selectedAccount ? (
        renderEditor(selectedAccount)
      ) : (
        <SettingsEmptyState>{t("settings:accounts_notFound")}</SettingsEmptyState>
      )}
      {signInDialog}
    </>
  );
}

// One titled band of the account editor; bands are separated by hairlines.
function ProviderAccountEditorSection(props: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2 border-b border-border/70 px-3 py-3 last:border-b-0">
      <h4 className="text-ui-xs font-medium tracking-wide text-muted-foreground uppercase">
        {props.title}
      </h4>
      {props.children}
    </section>
  );
}
