// FILE: ProvidersSettingsPanel.tsx
// Purpose: Settings → Providers. The drag-sortable Agents list with enablement, picker
//          visibility, provider-wide CLI options, and updates; process priority; and
//          provider update checks. Accounts live on the Accounts page.
// Layer: Settings panel
// Exports: ProvidersSettingsPanel, ProvidersSettingsPanelProps

import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderInstanceId,
  type ProviderKind,
  type ServerProviderStatus,
} from "@synara/contracts";
import {
  closestCenter,
  DndContext,
  PointerSensor,
  type DragEndEvent,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { arrayMove, SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  getProviderInstanceOptions,
  type AppSettings,
  type AppSettingsBinding,
} from "~/appSettings";
import { setsEqual } from "~/hooks/useStableValue";
import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";
import { useRefreshProviderStatusesNow } from "~/hooks/useProviderStatusRefresh";
import { useTranslation } from "~/i18n";
import { pluralize } from "~/i18n/pluralize";
import { Loader2Icon } from "~/lib/icons";
import { findUsableProviderStatus, providerStatusInstanceKey } from "~/lib/providerAvailability";
import { providerSetupStatusLabel } from "~/lib/providerSetupStatus";
import {
  hasReconciledServerProviderStatuses,
  serverConfigQueryOptions,
  serverQueryKeys,
  serverSettingsQueryOptions,
} from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { isProviderKind, sameProviderOrder } from "~/providerOrdering";
import {
  getVisibleProviderUpdateStatuses,
  isProviderUpdateActive,
  withProviderUpdateTimeout,
} from "~/providerUpdates";
import { SETTINGS_TARGETS } from "~/settingsNavigation";
import {
  SETTINGS_CARD_ROW_CLASS_NAME,
  SETTINGS_INSET_LIST_CLASS_NAME,
  SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME,
} from "~/settingsPanelStyles";

import { ProviderIcon } from "../../ProviderIcon";
import { Button } from "../../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../ui/collapsible";
import { DisclosureChevron } from "../../ui/DisclosureChevron";
import { Switch } from "../../ui/switch";
import { toastManager } from "../../ui/toast";
import { SettingResetButton, useSettingsRestoreSignal } from "../SettingControls";
import {
  SettingsCard,
  SettingsListRow,
  SettingsRow,
  SettingsSection,
  SettingsSectionShell,
} from "../SettingsPanelPrimitives";
import { ProviderAgentRow } from "./ProviderAgentRow";
import { ProviderSetupGuideButton } from "./ProviderDocsLinks";
import {
  createClosedProviderInstallDisclosureState,
  createProviderCliFieldsResetPatch,
  createProviderInstallDisclosureState,
  isProviderCliFieldsDirty,
  PROVIDER_INSTALL_SETTINGS,
  PROVIDER_VISIBILITY_OPTIONS,
  type ProviderVisibilityOption,
} from "./providerInstallSettings";
import { ProviderUpdateAction } from "./ProviderUpdateAction";
import {
  providerStatusDisplayName,
  providerUpdateFailureMessage,
  providerUpdateStatusLabel,
} from "./providerUpdateLabels";

function setProviderListMembership(
  current: ReadonlyArray<ProviderKind>,
  provider: ProviderKind,
  included: boolean,
): ProviderKind[] {
  const withoutTarget = current.filter((entry) => entry !== provider);
  return included ? [...withoutTarget, provider] : withoutTarget;
}

export type ProvidersSettingsPanelProps = AppSettingsBinding & {
  readonly active: boolean;
  readonly providerTarget?: ProviderKind | null;
  readonly resetEpoch: number;
  readonly updateSettingsAndWait: (patch: Partial<AppSettings>) => Promise<void>;
  /** Opens the Accounts page on one provider's accounts. */
  readonly onManageAccounts: (provider: ProviderKind) => void;
};

export function ProvidersSettingsPanel({
  settings,
  defaults,
  updateSettings,
  updateSettingsAndWait,
  active,
  providerTarget = null,
  resetEpoch,
  onManageAccounts,
}: ProvidersSettingsPanelProps) {
  const { t } = useTranslation();

  const queryClient = useQueryClient();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const localProviderStatuses = useProviderStatusesForLocalConfig();
  const refreshProviderStatuses = useRefreshProviderStatusesNow();
  const [refreshingProviders, setRefreshingProviders] = useState(false);
  const refreshProvidersInFlightRef = useRef(false);
  const providerStatusesReconciled = hasReconciledServerProviderStatuses(queryClient);
  const serverSettingsQuery = useQuery(serverSettingsQueryOptions());
  const [openInstallProviders, setOpenInstallProviders] = useState<Record<ProviderKind, boolean>>(
    () => ({
      ...createProviderInstallDisclosureState(settings, defaults),
      ...(providerTarget ? { [providerTarget]: true } : {}),
    }),
  );
  const [updatingProviders, setUpdatingProviders] = useState<ReadonlySet<ProviderInstanceId>>(
    () => new Set(),
  );
  const providerEnablementMutationInFlightRef = useRef(false);
  const [providerEnablementMutationPending, setProviderEnablementMutationPending] = useState(false);
  const [disabledProvidersOpen, setDisabledProvidersOpen] = useState(false);
  const hiddenProviderSet = useMemo(
    () => new Set<ProviderKind>(settings.hiddenProviders),
    [settings.hiddenProviders],
  );
  const disabledProviderSet = useMemo(
    () => new Set<ProviderKind>(settings.disabledProviders),
    [settings.disabledProviders],
  );
  const providerVisibilityOptionsByProvider = useMemo(
    () => new Map(PROVIDER_VISIBILITY_OPTIONS.map((option) => [option.provider, option])),
    [],
  );
  const orderedProviderVisibilityOptions = useMemo(
    () =>
      settings.providerOrder.flatMap((provider) => {
        const option = providerVisibilityOptionsByProvider.get(provider);
        return option ? [option] : [];
      }),
    [providerVisibilityOptionsByProvider, settings.providerOrder],
  );
  const providerInstallSettingsByProvider = useMemo(
    () => new Map(PROVIDER_INSTALL_SETTINGS.map((config) => [config.provider, config])),
    [],
  );
  const providerVisibilitySensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
  const enabledProviderOptions = orderedProviderVisibilityOptions.filter(
    (option) => !disabledProviderSet.has(option.provider),
  );
  const disabledProviderOptions = orderedProviderVisibilityOptions.filter((option) =>
    disabledProviderSet.has(option.provider),
  );
  const isProviderOrderDirty = !sameProviderOrder(settings.providerOrder, defaults.providerOrder);
  const providerStatusByProvider = useMemo(
    () =>
      new Map<ProviderKind, ServerProviderStatus>(
        localProviderStatuses.flatMap((status) => {
          const driver = status.driver ?? status.provider;
          return isProviderKind(driver) && providerStatusInstanceKey(status) === driver
            ? [[driver, status] as const]
            : [];
        }),
      ),
    [localProviderStatuses],
  );
  const configuredInstances = getProviderInstanceOptions(settings);
  const providerSetupStatusByProvider = new Map(
    enabledProviderOptions.map(
      ({ provider }) =>
        [
          provider,
          findUsableProviderStatus(
            localProviderStatuses,
            provider,
            provider,
            configuredInstances,
          ) ?? providerStatusByProvider.get(provider),
        ] as const,
    ),
  );
  const providerUpdateServerSettings = useMemo(
    () =>
      serverSettingsQuery.data
        ? {
            ...serverSettingsQuery.data,
            enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
          }
        : null,
    [serverSettingsQuery.data, settings.enableProviderUpdateChecks],
  );
  const outdatedProviderStatuses = useMemo(
    () =>
      getVisibleProviderUpdateStatuses({
        providers: serverConfigQuery.data?.providers ?? [],
        hiddenProviders: settings.hiddenProviders,
        serverSettings: providerUpdateServerSettings,
      }).filter(
        (status) => !disabledProviderSet.has((status.driver ?? status.provider) as ProviderKind),
      ),
    [
      disabledProviderSet,
      providerUpdateServerSettings,
      serverConfigQuery.data?.providers,
      settings.hiddenProviders,
    ],
  );
  const outdatedProviderCount = outdatedProviderStatuses.length;
  const providerEnablementDirty = !setsEqual(
    new Set(settings.disabledProviders),
    new Set(defaults.disabledProviders),
  );
  // Only what the Agents list resets: accounts are the Accounts page's.
  const agentsListDirty =
    providerEnablementDirty ||
    !setsEqual(new Set(settings.hiddenProviders), new Set(defaults.hiddenProviders)) ||
    isProviderOrderDirty ||
    isProviderCliFieldsDirty(settings, defaults);

  const updateProviderEnablement = useCallback(
    async (disabledProviders: ProviderKind[]) => {
      if (providerEnablementMutationInFlightRef.current) return;
      providerEnablementMutationInFlightRef.current = true;
      setProviderEnablementMutationPending(true);
      try {
        await updateSettingsAndWait({ disabledProviders });
      } finally {
        providerEnablementMutationInFlightRef.current = false;
        setProviderEnablementMutationPending(false);
      }
    },
    [updateSettingsAndWait],
  );

  useSettingsRestoreSignal(resetEpoch, () => {
    setOpenInstallProviders(createClosedProviderInstallDisclosureState());
    setDisabledProvidersOpen(false);
  });

  useEffect(() => {
    if (!active || !providerTarget) return;
    if (disabledProviderSet.has(providerTarget)) {
      setDisabledProvidersOpen(true);
    } else {
      setOpenInstallProviders((current) => ({ ...current, [providerTarget]: true }));
    }
  }, [active, disabledProviderSet, providerTarget]);

  const handleProviderOrderDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const fromIndex = settings.providerOrder.indexOf(active.id as ProviderKind);
      const toIndex = settings.providerOrder.indexOf(over.id as ProviderKind);
      if (fromIndex < 0 || toIndex < 0) return;
      updateSettings({ providerOrder: arrayMove([...settings.providerOrder], fromIndex, toIndex) });
    },
    [settings.providerOrder, updateSettings],
  );

  const runProviderUpdate = useCallback(
    async (provider: ProviderKind, instanceId?: ProviderInstanceId) => {
      const targetId = instanceId ?? provider;
      if (updatingProviders.has(targetId)) return;
      setUpdatingProviders((current) => new Set(current).add(targetId));
      await withProviderUpdateTimeout({
        provider,
        request: ensureNativeApi().server.updateProvider({
          provider,
          ...(instanceId ? { instanceId } : {}),
        }),
      })
        .then((result) => {
          const refreshedProvider = result.providers.find(
            (status) =>
              (status.driver ?? status.provider) === provider &&
              providerStatusInstanceKey(status) === targetId,
          );
          const failureMessage = providerUpdateFailureMessage(refreshedProvider);
          if (failureMessage) {
            const manualCommand = refreshedProvider?.versionAdvisory?.updateCommand?.trim();
            toastManager.add({
              type: "error",
              title: t("settings:couldNotUpdate", {
                value0: refreshedProvider
                  ? providerStatusDisplayName(refreshedProvider)
                  : PROVIDER_DISPLAY_NAMES[provider],
              }),
              description: manualCommand
                ? t("settings:copyTheCommandBelowToUpdateManuallyInA", {
                    value0: failureMessage,
                  })
                : failureMessage,
              ...(manualCommand ? { data: { copyText: manualCommand } } : {}),
            });
            return;
          }
          toastManager.add({
            type: "success",
            title: t("settings:updateFinished", {
              value0: refreshedProvider
                ? providerStatusDisplayName(refreshedProvider)
                : PROVIDER_DISPLAY_NAMES[provider],
            }),
            description: t("settings:newSessionsWillUseTheRefreshedProvider"),
          });
        })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: t("settings:couldNotUpdate", { value0: PROVIDER_DISPLAY_NAMES[provider] }),
            description:
              error instanceof Error ? error.message : t("settings:theProviderUpdateFailed"),
          });
        })
        .finally(async () => {
          await queryClient
            .invalidateQueries({ queryKey: serverQueryKeys.config() })
            .catch(() => undefined);
          setUpdatingProviders((current) => {
            const next = new Set(current);
            next.delete(targetId);
            return next;
          });
        });
    },
    [queryClient, updatingProviders, t],
  );

  if (!active) return null;

  const refreshProviders = async () => {
    if (refreshProvidersInFlightRef.current) return;
    refreshProvidersInFlightRef.current = true;
    setRefreshingProviders(true);
    try {
      await refreshProviderStatuses();
    } finally {
      refreshProvidersInFlightRef.current = false;
      setRefreshingProviders(false);
    }
  };

  const renderDisabledProviderRow = (option: ProviderVisibilityOption) => (
    <SettingsListRow
      key={option.provider}
      leading={<ProviderIcon provider={option.provider} className="size-4 shrink-0" />}
      title={option.title}
      description={providerSetupStatusLabel(
        { status: undefined, reconciled: providerStatusesReconciled, disabled: true },
        t,
      )}
      actions={
        <>
          <ProviderSetupGuideButton title={option.title} href={option.setupDocsHref} size="xs" />
          <Switch
            checked={false}
            disabled={!serverSettingsQuery.data || providerEnablementMutationPending}
            onCheckedChange={(checked) => {
              if (!checked) return;
              void updateProviderEnablement(
                setProviderListMembership(settings.disabledProviders, option.provider, false),
              );
            }}
            aria-label={t("settings:enableProvider", { provider: option.title })}
          />
        </>
      }
    />
  );

  const resetAgentsList = () => {
    updateSettings({
      hiddenProviders: defaults.hiddenProviders,
      providerOrder: defaults.providerOrder,
      // Provider-wide CLI options only; accounts stay as they are.
      ...createProviderCliFieldsResetPatch(defaults),
    });
    setOpenInstallProviders(createClosedProviderInstallDisclosureState());
    if (providerEnablementDirty) void updateProviderEnablement([...defaults.disabledProviders]);
  };

  return (
    <div className="space-y-6">
      <div id={SETTINGS_TARGETS.providerInstalls}>
        <SettingsSectionShell
          id="setting-providers"
          title="settings:providers_agentsList"
          action={
            <div className="flex items-center gap-1.5">
              {agentsListDirty && !providerEnablementMutationPending ? (
                <SettingResetButton
                  label={t("settings:providers_agentsResetLabel")}
                  onClick={resetAgentsList}
                />
              ) : null}
              <Button
                variant="outline"
                size="sm"
                disabled={refreshingProviders}
                onClick={() => void refreshProviders()}
              >
                {refreshingProviders ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
                {refreshingProviders ? t("settings:checkingSetup") : t("chat:refreshStatus")}
              </Button>
            </div>
          }
        >
          <SettingsCard>
            {enabledProviderOptions.length > 0 ? (
              <DndContext
                sensors={providerVisibilitySensors}
                collisionDetection={closestCenter}
                modifiers={[restrictToVerticalAxis]}
                onDragEnd={handleProviderOrderDragEnd}
              >
                <SortableContext
                  items={enabledProviderOptions.map((option) => option.provider)}
                  strategy={verticalListSortingStrategy}
                >
                  {enabledProviderOptions.map((option) => (
                    <ProviderAgentRow
                      key={option.provider}
                      option={option}
                      config={providerInstallSettingsByProvider.get(option.provider)}
                      open={openInstallProviders[option.provider] ?? false}
                      settings={settings}
                      hiddenProviderSet={hiddenProviderSet}
                      serverSettings={providerUpdateServerSettings}
                      setupStatus={providerSetupStatusByProvider.get(option.provider)}
                      providerStatus={providerStatusByProvider.get(option.provider)}
                      statusReconciled={providerStatusesReconciled}
                      enablementDisabled={
                        !serverSettingsQuery.data || providerEnablementMutationPending
                      }
                      updatingProviders={updatingProviders}
                      onOpenChange={(open) =>
                        setOpenInstallProviders((existing) => ({
                          ...existing,
                          [option.provider]: open,
                        }))
                      }
                      onDisable={() =>
                        void updateProviderEnablement(
                          setProviderListMembership(
                            settings.disabledProviders,
                            option.provider,
                            true,
                          ),
                        )
                      }
                      onHiddenChange={(hidden) =>
                        updateSettings({
                          hiddenProviders: setProviderListMembership(
                            settings.hiddenProviders,
                            option.provider,
                            hidden,
                          ),
                        })
                      }
                      onUpdate={(provider) => void runProviderUpdate(provider)}
                      onManageAccounts={onManageAccounts}
                      updateSettings={updateSettings}
                    />
                  ))}
                </SortableContext>
              </DndContext>
            ) : (
              <p className={cn(SETTINGS_CARD_ROW_CLASS_NAME, "text-ui text-muted-foreground")}>
                {t("settings:noProvidersEnabledOpenDisabledProvidersBelowToEnable")}
              </p>
            )}
          </SettingsCard>
          {disabledProviderOptions.length > 0 ? (
            <Collapsible open={disabledProvidersOpen} onOpenChange={setDisabledProvidersOpen}>
              <CollapsibleTrigger className="flex w-full items-center gap-2 px-2 py-2 text-left text-ui text-muted-foreground">
                <DisclosureChevron open={disabledProvidersOpen} className="size-4 shrink-0" />
                <span>
                  {t("settings:disabledProviders")}
                  {disabledProviderOptions.length})
                </span>
              </CollapsibleTrigger>
              <CollapsiblePanel>
                <SettingsCard>
                  {disabledProviderOptions.map(renderDisabledProviderRow)}
                </SettingsCard>
              </CollapsiblePanel>
            </Collapsible>
          ) : null}
        </SettingsSectionShell>
      </div>

      <SettingsSection title="settings:performance">
        <SettingsRow
          id="setting-keep-synara-responsive"
          title="settings:keepSynaraResponsive"
          description="settings:giveAgentProcessesAndTheirCommandsAModeratelyLower"
          status="Applies to newly launched agent processes. Restart existing sessions to apply consistently."
          resetAction={
            settings.lowerProviderProcessPriority !== defaults.lowerProviderProcessPriority ? (
              <SettingResetButton
                label={t("settings:keepSynaraResponsive")}
                onClick={() =>
                  updateSettings({
                    lowerProviderProcessPriority: defaults.lowerProviderProcessPriority,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.lowerProviderProcessPriority}
              onCheckedChange={(checked) =>
                updateSettings({ lowerProviderProcessPriority: Boolean(checked) })
              }
              aria-label={t("settings:keepSynaraResponsive")}
            />
          }
        />
      </SettingsSection>

      <div id={SETTINGS_TARGETS.providerUpdates}>
        <SettingsSection title="settings:providerUpdates_updates">
          <SettingsRow
            id="setting-automatic-cli-update-checks"
            title="settings:providerUpdates_automaticCliUpdateChecks"
            description="settings:checkCodexClaudeAndOtherProviderCLIsForNewer"
            resetAction={
              settings.enableProviderUpdateChecks !== defaults.enableProviderUpdateChecks ? (
                <SettingResetButton
                  label={t("settings:cLIUpdateChecks")}
                  onClick={() =>
                    updateSettings({
                      enableProviderUpdateChecks: defaults.enableProviderUpdateChecks,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.enableProviderUpdateChecks}
                onCheckedChange={(checked) =>
                  updateSettings({ enableProviderUpdateChecks: Boolean(checked) })
                }
                aria-label={t("settings:providerUpdates_automaticCliUpdateChecks")}
              />
            }
          />

          <SettingsRow
            id="setting-provider-updates"
            title="settings:providerUpdates_providerUpdates"
            description="settings:reviewInstalledProviderToolsThatSynaraCanSafelyUpdate"
            status={
              !settings.enableProviderUpdateChecks
                ? "Automatic checks off"
                : outdatedProviderCount > 0
                  ? `${outdatedProviderCount} ${pluralize(outdatedProviderCount, "update")} available`
                  : "No provider updates detected"
            }
          >
            {settings.enableProviderUpdateChecks && outdatedProviderStatuses.length > 0 ? (
              <div
                className={cn(
                  "mt-4",
                  SETTINGS_INSET_LIST_CLASS_NAME,
                  SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME,
                )}
              >
                {outdatedProviderStatuses.map((providerStatus) => {
                  const instanceId = providerStatusInstanceKey(providerStatus);
                  const updateActive =
                    isProviderUpdateActive(providerStatus) || updatingProviders.has(instanceId);
                  const updateLabel = providerUpdateStatusLabel(providerStatus);
                  return (
                    <SettingsListRow
                      key={instanceId}
                      title={providerStatusDisplayName(providerStatus)}
                      description={updateLabel || undefined}
                      actions={
                        providerStatus.versionAdvisory?.canUpdate ? (
                          <ProviderUpdateAction
                            providerStatus={providerStatus}
                            active={updateActive}
                            disabled={updateActive}
                            onUpdate={(provider) => void runProviderUpdate(provider)}
                          />
                        ) : (
                          <span className="text-ui-sm text-muted-foreground">
                            {t("settings:providerUpdates_manualUpdate")}
                          </span>
                        )
                      }
                    />
                  );
                })}
              </div>
            ) : null}
          </SettingsRow>
        </SettingsSection>
      </div>
    </div>
  );
}
