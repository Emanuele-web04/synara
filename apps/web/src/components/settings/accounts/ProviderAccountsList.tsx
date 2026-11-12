// FILE: ProviderAccountsList.tsx
// Purpose: One agent's card on the Accounts page: every account with its status,
//          identity, usage, and enable switch, plus Import directory and Add account.
// Layer: Settings UI
// Exports: ProviderAccountsList

import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ProviderInstanceId,
  type ProviderKind,
  type ServerProviderStatus,
  type ServerProviderUsageSnapshot,
} from "@synara/contracts";
import { providerImportedDirectoryConfig } from "@synara/shared/providerInstances";
import { useState } from "react";

import {
  getProviderInstanceOptions,
  type AppSettings,
  type ProviderInstanceOption,
} from "~/appSettings";
import { resolveProviderUsageSummary } from "~/hooks/useProviderUsageSummary";
import { t, useTranslation } from "~/i18n";
import { ChevronRightIcon, FolderOpenIcon, PlusIcon } from "~/lib/icons";
import { providerAccountIdentityLabel } from "~/lib/providerInstancePresentation";
import {
  type ProviderAccountStatusSummary,
  providerAccountNeedsSignIn,
  providerAccountStatusSummary,
} from "~/lib/providerSetupStatus";
import { deriveProviderUsageDisplayRows } from "~/lib/providerUsageDisplay";
import { rateLimitWindowDisplayLabel } from "~/lib/rateLimits";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { providerAccountAnchorId, providerAccountsSectionId } from "~/settingsNavigation";
import {
  SETTINGS_CARD_CLASS_NAME,
  SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME,
} from "~/settingsPanelStyles";

import { ProviderAccountAvatar } from "../../ProviderAccountMark";
import { Button } from "../../ui/button";
import { IconButton } from "../../ui/icon-button";
import { StatusChip } from "../../ui/status-chip";
import { Switch } from "../../ui/switch";
import { toastManager } from "../../ui/toast";
import {
  PROVIDER_VISIBILITY_OPTIONS,
  providerInstanceLaunchConfigFor,
} from "../providers/providerInstallSettings";
import { SettingsListRow, SettingsSectionShell } from "../SettingsPanelPrimitives";
import {
  AddProviderAccountDialog,
  type AddProviderAccountConfigField,
  type AddProviderAccountInput,
} from "./AddProviderAccountDialog";
import {
  ACCOUNT_STATUS_DOT_CLASS_NAME,
  DefaultAccountBadge,
  providerInstanceUpdater,
  useProviderAccountSignIn,
} from "./providerAccountShared";

// Paths that give a new account its own identity; asked for when adding one.
function providerAccountIdentityFields(
  provider: ProviderKind,
): ReadonlyArray<AddProviderAccountConfigField> {
  if (provider === "codex") {
    return [
      {
        key: "homePath",
        label: t("settings:providers_codexHomePath"),
        placeholder: "~/.codex-work",
        description: t("settings:leaveBlankAndSynaraKeepsThisAccountSSign"),
      },
    ];
  }
  if (provider === "claudeAgent") {
    return [
      {
        key: "configDir",
        label: t("settings:claudeConfigDirectory"),
        placeholder: "~/.claude-work",
        description:
          "Leave blank and Synara keeps this account's sign-in in its own folder. " +
          "Set a directory to use a Claude config folder you already signed in to.",
      },
    ];
  }
  if (provider === "pi" || provider === "omp") return [];
  return [
    {
      key: "profileDir",
      label: t("settings:profileDirectory"),
      placeholder: t("settings:providerAccountDirectory"),
      description: t("settings:usedAsThisAccountSProviderConfigRootWithout"),
    },
  ];
}

export function ProviderAccountsList(props: {
  provider: ProviderKind;
  providerStatusByInstance: ReadonlyMap<string, ServerProviderStatus>;
  /** Usage snapshots by account, fetched once for the whole Accounts page. */
  usageByInstance: ReadonlyMap<string, ServerProviderUsageSnapshot>;
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
  updateSettingsAndWait: (patch: Partial<AppSettings>) => Promise<void>;
  /** Opens an account's detail view. */
  onOpenAccount: (instanceId: string) => void;
}) {
  const { t } = useTranslation();

  const provider = props.provider;
  const providerLabel = PROVIDER_DISPLAY_NAMES[provider];
  const allAccounts = getProviderInstanceOptions(props.settings);
  // Default first, then the provider's other accounts by name.
  const accounts = allAccounts.filter((account) => account.provider === provider);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const { startSignIn, startingSignIn, signInDialog } = useProviderAccountSignIn(
    props.updateSettingsAndWait,
  );
  const updateInstance = providerInstanceUpdater(props.settings, props.updateSettings);

  const updateInstances = (next: Record<string, ProviderInstanceConfig>) => {
    props.updateSettings({ providerInstances: next as ProviderInstanceConfigMap });
  };
  const addAccount = (input: AddProviderAccountInput) => {
    updateInstances({
      ...props.settings.providerInstances,
      [input.instanceId]: {
        driver: input.provider,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        ...(input.accentColor ? { accentColor: input.accentColor } : {}),
        enabled: true,
        config: {
          // A new account starts from the provider's own binary and endpoint settings.
          ...providerInstanceLaunchConfigFor(input.provider, props.settings),
          ...input.config,
        },
      },
    });
    toastManager.add({
      type: "success",
      title: t("settings:accountAdded"),
      description: t("settings:accountWasAdded", {
        value0: PROVIDER_DISPLAY_NAMES[input.provider],
        value1: input.displayName || input.instanceId,
      }),
    });
    // A new account has no sign-in yet unless it points at a folder that already has
    // one, so adding goes straight on to signing in.
    const pointsAtExistingFolder = Object.values(input.config).some(
      (value) => value.trim().length > 0,
    );
    if (!pointsAtExistingFolder) {
      void startSignIn({
        instanceId: input.instanceId as ProviderInstanceId,
        provider: input.provider,
        driver: input.provider,
        label: input.displayName || input.instanceId,
        enabled: true,
        isDefault: false,
        supported: true,
      });
    }
  };
  const nextImportedInstanceId = () => {
    const prefix = provider === "claudeAgent" ? "claude" : provider;
    const existingIds = new Set(allAccounts.map((option) => String(option.instanceId)));
    let index = 2;
    while (existingIds.has(`${prefix}_${index}`)) index += 1;
    return `${prefix}_${index}`;
  };
  const importInstance = async () => {
    const selectedDirectory = await ensureNativeApi().dialogs.pickFolder();
    if (!selectedDirectory) return;
    // Derived accounts share this namespace with explicit entries. Reusing a
    // derived id would mutate that account instead of creating a new one.
    const instanceId = nextImportedInstanceId();
    const directoryName = selectedDirectory.split(/[\\/]/).filter(Boolean).at(-1);
    updateInstances({
      ...props.settings.providerInstances,
      [instanceId]: {
        driver: provider,
        displayName: directoryName || `${providerLabel} imported`,
        enabled: true,
        config: {
          ...providerInstanceLaunchConfigFor(provider, props.settings),
          ...providerImportedDirectoryConfig(provider, selectedDirectory),
        },
      },
    });
    toastManager.add({
      type: "success",
      title: t("settings:accountImported", { value0: providerLabel }),
      description: t("settings:synaraReferencesTheSelectedDirectoryNoFilesWereMoved"),
    });
  };

  const renderListRow = (account: ProviderInstanceOption) => {
    const instanceId = String(account.instanceId);
    const liveStatus = props.providerStatusByInstance.get(instanceId);
    const usageSnapshot = props.usageByInstance.get(instanceId);
    const status = providerAccountStatusSummary(
      { status: liveStatus, enabled: account.enabled, usageSnapshot },
      t,
    );
    const identity = providerAccountIdentityLabel(liveStatus);
    const planName =
      usageSnapshot && (usageSnapshot.status ?? "ok") === "ok" ? usageSnapshot.planName : undefined;
    const needsSignIn = providerAccountNeedsSignIn({
      status: liveStatus,
      enabled: account.enabled,
    });
    return (
      <div
        key={instanceId}
        id={providerAccountAnchorId(instanceId)}
        role="listitem"
        className={cn("scroll-mt-24", !account.enabled && "opacity-60")}
      >
        <SettingsListRow
          leading={<ProviderAccountAvatar provider={provider} accentColor={account.accentColor} />}
          title={
            <button
              type="button"
              aria-label={t("settings:select", { value0: account.label })}
              className="flex min-w-0 cursor-pointer items-center gap-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring/60"
              onClick={() => props.onOpenAccount(instanceId)}
            >
              <span className="truncate">{account.label}</span>
              {account.isDefault && accounts.length > 1 ? <DefaultAccountBadge /> : null}
            </button>
          }
          description={
            <span className="flex min-w-0 flex-col gap-0.5 text-ui-sm">
              <ProviderInstanceStatusLine status={status} />
              {identity || planName ? (
                <span className="truncate">{[identity, planName].filter(Boolean).join(" · ")}</span>
              ) : null}
              {usageSnapshot ? <ProviderAccountUsageSummary snapshot={usageSnapshot} /> : null}
            </span>
          }
          actions={
            <>
              {needsSignIn ? (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={startingSignIn}
                  aria-label={t("settings:signInTo2", { value0: account.label })}
                  onClick={() => void startSignIn(account)}
                >
                  {t("chat:providerModelPicker_signIn")}
                </Button>
              ) : null}
              <Switch
                checked={account.enabled}
                onCheckedChange={(enabled) =>
                  updateInstance(account.instanceId, { enabled: Boolean(enabled) })
                }
                aria-label={t("workspace:enable", { value0: account.label })}
              />
              <IconButton
                label={t("settings:accounts_openAccount", { value0: account.label })}
                onClick={() => props.onOpenAccount(instanceId)}
              >
                <ChevronRightIcon className="size-4" />
              </IconButton>
            </>
          }
        />
      </div>
    );
  };

  return (
    <SettingsSectionShell
      id={providerAccountsSectionId(provider)}
      title={providerLabel}
      translateTitle={false}
      action={
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={importInstance}
            disabled={typeof window === "undefined" || !window.desktopBridge}
            title={
              typeof window === "undefined" || !window.desktopBridge
                ? t("settings:directoryImportIsAvailableInTheSynaraDesktopApp")
                : t("settings:useAnExistingDirectoryAsANewAccountWithout", {
                    value0: providerLabel,
                  })
            }
          >
            <FolderOpenIcon className="size-3.5" />
            {t("settings:importDirectory")}
          </Button>
          <Button type="button" size="xs" variant="outline" onClick={() => setAddDialogOpen(true)}>
            <PlusIcon className="size-3.5" />
            {t("settings:addAccount")}
          </Button>
        </div>
      }
    >
      <div
        role="list"
        aria-label={t("settings:accounts2", { value0: providerLabel })}
        className={cn(SETTINGS_CARD_CLASS_NAME, SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME)}
      >
        {accounts.map(renderListRow)}
      </div>

      {signInDialog}
      <AddProviderAccountDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        providers={PROVIDER_VISIBILITY_OPTIONS.filter(
          (option) => !props.settings.disabledProviders.includes(option.provider),
        ).map((option) => ({
          provider: option.provider,
          label: option.title,
        }))}
        initialProvider={provider}
        // Includes accounts of a missing driver, which the list does not show.
        existingIds={
          new Set([
            ...allAccounts.map((option) => String(option.instanceId)),
            ...Object.keys(props.settings.providerInstances),
          ])
        }
        configFieldsFor={providerAccountIdentityFields}
        onAdd={addAccount}
      />
    </SettingsSectionShell>
  );
}

// "5h 58% left · Weekly 39% left": the account's limits at a glance, from the same rows
// the Usage page draws as meters.
function ProviderAccountUsageSummary({ snapshot }: { snapshot: ServerProviderUsageSnapshot }) {
  const { t } = useTranslation();
  if ((snapshot.status ?? "ok") !== "ok") return null;
  const summary = resolveProviderUsageSummary({
    provider: snapshot.provider,
    accountRateLimits: [],
    authoritativeLiveSnapshot: snapshot,
  });
  const rows = deriveProviderUsageDisplayRows(summary.rateLimits, t);
  if (rows.length === 0) return null;
  return (
    <span className="block truncate tabular-nums">
      {rows
        .map((row) =>
          t("settings:accounts_usageSummary", {
            window: rateLimitWindowDisplayLabel(row.label, t),
            percent: row.leftText,
          }),
        )
        .join(" · ")}
    </span>
  );
}

function ProviderInstanceStatusLine(props: { status: ProviderAccountStatusSummary }) {
  return (
    <StatusChip
      className="text-ui-xs text-muted-foreground"
      dotClassName={ACCOUNT_STATUS_DOT_CLASS_NAME[props.status.tone]}
    >
      <span className="truncate">{props.status.headline}</span>
    </StatusChip>
  );
}
