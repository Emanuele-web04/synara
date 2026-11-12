// FILE: ProviderAgentRow.tsx
// Purpose: One enabled agent in the Agents list: drag handle, setup and CLI version
//          status, enable switch, and the disclosure with picker visibility, docs,
//          update details, provider-wide CLI fields, and the link to its accounts.
// Layer: Settings UI
// Exports: ProviderAgentRow

import type {
  ProviderInstanceId,
  ProviderKind,
  ServerProviderStatus,
  ServerSettings,
} from "@synara/contracts";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import type { AppSettings } from "~/appSettings";
import { useTranslation } from "~/i18n";
import { CentralIcon } from "~/lib/central-icons";
import { providerStatusInstanceKey } from "~/lib/providerAvailability";
import { providerSetupStatusLabel } from "~/lib/providerSetupStatus";
import { cn } from "~/lib/utils";
import {
  isProviderLatestVersionKnowable,
  isProviderUpdateActive,
  shouldOfferProviderUpdateAction,
  shouldPromptProviderUpdate,
  shouldShowProviderUpdateStatus,
} from "~/providerUpdates";
import {
  SETTINGS_CARD_ROW_CLASS_NAME,
  SETTINGS_CARD_ROW_TITLE_CLASS_NAME,
  SETTINGS_INSET_RADIUS_CLASS_NAME,
} from "~/settingsPanelStyles";
import { ELEVATED_HOVER_SURFACE_RAISED_TEXT_CLASS_NAME } from "~/surfaceStyles";

import { ProviderIcon } from "../../ProviderIcon";
import { Button } from "../../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../ui/collapsible";
import { DisclosureChevron } from "../../ui/DisclosureChevron";
import { IconButton } from "../../ui/icon-button";
import { Switch } from "../../ui/switch";
import { ProviderDocsLinks } from "./ProviderDocsLinks";
import { ProviderInstallFieldControl } from "./ProviderInstallFieldControl";
import {
  isDefaultAccountIdentityField,
  type ProviderInstallSettings,
  type ProviderVisibilityOption,
} from "./providerInstallSettings";
import { ProviderUpdateAction } from "./ProviderUpdateAction";
import { formatProviderVersion, providerUpdateStatusLabel } from "./providerUpdateLabels";

function isProviderPickerProviderEnabled(
  providerStatus: Pick<ServerProviderStatus, "available"> | null | undefined,
  isHidden: boolean,
): boolean {
  return providerStatus?.available === true && !isHidden;
}

/**
 * One enabled agent in the Agents list: a drag-sortable row with its setup and CLI
 * version status, the enable switch, and a disclosure holding the picker switch, docs,
 * update details, provider-wide CLI fields, and the link to its accounts.
 */
export function ProviderAgentRow(props: {
  option: ProviderVisibilityOption;
  config: ProviderInstallSettings | undefined;
  open: boolean;
  settings: AppSettings;
  hiddenProviderSet: ReadonlySet<ProviderKind>;
  serverSettings: Pick<
    ServerSettings,
    "providers" | "providerInstances" | "enableProviderUpdateChecks"
  > | null;
  /** The provider's best usable status across its accounts; drives setup and the picker. */
  setupStatus: ServerProviderStatus | undefined;
  /** The default instance's status; drives the CLI version and updates. */
  providerStatus: ServerProviderStatus | undefined;
  statusReconciled: boolean;
  enablementDisabled: boolean;
  updatingProviders: ReadonlySet<ProviderInstanceId>;
  onOpenChange: (open: boolean) => void;
  onDisable: () => void;
  onHiddenChange: (hidden: boolean) => void;
  onUpdate: (provider: ProviderKind, instanceId?: ProviderInstanceId) => void;
  onManageAccounts: (provider: ProviderKind) => void;
  updateSettings: (patch: Partial<AppSettings>) => void;
}) {
  const { t } = useTranslation();

  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.option.provider });
  const provider = props.option.provider;
  const title = props.option.title;
  const isChecking = !props.statusReconciled || props.setupStatus === undefined;
  const isAvailable = props.setupStatus?.available === true;
  const isShownInPicker = isProviderPickerProviderEnabled(
    props.setupStatus,
    props.hiddenProviderSet.has(provider),
  );

  const showProviderUpdateStatus = props.providerStatus
    ? shouldShowProviderUpdateStatus({
        provider: props.providerStatus,
        hiddenProviderSet: props.hiddenProviderSet,
        serverSettings: props.serverSettings,
      })
    : false;
  const updateAdvisory = props.providerStatus?.versionAdvisory;
  const providerUpdateSuppressed =
    updateAdvisory?.status === "behind_latest" && !showProviderUpdateStatus;
  const currentProviderVersion = formatProviderVersion(props.providerStatus?.version);
  const providerUpdateLabel = props.providerStatus
    ? !props.settings.enableProviderUpdateChecks
      ? currentProviderVersion
        ? t("settings:current", { value0: currentProviderVersion })
        : null
      : providerUpdateSuppressed
        ? null
        : providerUpdateStatusLabel(props.providerStatus)
    : null;
  const updateActive = Boolean(
    (props.providerStatus && isProviderUpdateActive(props.providerStatus)) ||
    props.updatingProviders.has(
      props.providerStatus ? providerStatusInstanceKey(props.providerStatus) : provider,
    ),
  );
  const showUpdateButton = props.providerStatus
    ? shouldPromptProviderUpdate(props.providerStatus) &&
      (showProviderUpdateStatus || updateAdvisory?.status === "unknown")
    : false;
  // Self-updating CLIs never report a latest version, so the update stays available
  // inside the panel rather than as a header badge that can never be satisfied.
  const showSelfManagedUpdate = props.providerStatus
    ? shouldOfferProviderUpdateAction(props.providerStatus) &&
      !isProviderLatestVersionKnowable(props.providerStatus)
    : false;
  const setupMessage =
    props.statusReconciled &&
    props.setupStatus?.message &&
    (props.setupStatus.status !== "ready" || props.setupStatus.authStatus !== "authenticated")
      ? props.setupStatus.message
      : null;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      data-slot="settings-row"
      className={cn(
        SETTINGS_CARD_ROW_CLASS_NAME,
        "relative",
        isDragging && "z-10 bg-background opacity-80 shadow-lg",
      )}
    >
      <Collapsible open={props.open} onOpenChange={props.onOpenChange}>
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            ref={setActivatorNodeRef}
            className={cn(
              "inline-flex size-6 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground active:cursor-grabbing",
              ELEVATED_HOVER_SURFACE_RAISED_TEXT_CLASS_NAME,
              SETTINGS_INSET_RADIUS_CLASS_NAME,
            )}
            aria-label={t("workspace:reorder", { value0: title })}
            {...attributes}
            {...listeners}
          >
            <CentralIcon name="dot-grid-2x3" className="size-4" />
          </button>
          <ProviderIcon provider={provider} className="size-4 shrink-0" />
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className={cn(SETTINGS_CARD_ROW_TITLE_CLASS_NAME, "truncate")}>{title}</div>
            <div className="truncate text-ui-sm text-muted-foreground">
              {providerSetupStatusLabel(
                {
                  status: props.setupStatus,
                  reconciled: props.statusReconciled,
                  disabled: false,
                },
                t,
              )}
              {providerUpdateLabel ? (
                <>
                  {" · "}
                  <span
                    className={
                      updateAdvisory?.status === "behind_latest" ? "text-foreground" : undefined
                    }
                  >
                    {providerUpdateLabel}
                  </span>
                </>
              ) : null}
            </div>
          </div>
          {showUpdateButton && props.providerStatus ? (
            <ProviderUpdateAction
              providerStatus={props.providerStatus}
              active={updateActive}
              disabled={updateActive}
              onUpdate={props.onUpdate}
            />
          ) : null}
          <Switch
            checked
            disabled={props.enablementDisabled}
            onCheckedChange={(checked) => {
              if (!checked) props.onDisable();
            }}
            aria-label={t("settings:disableProvider", { provider: title })}
          />
          <CollapsibleTrigger
            render={
              <IconButton
                label={t("settings:providers_agentOptions", { provider: title })}
                className="text-muted-foreground"
              >
                <DisclosureChevron open={props.open} className="size-4" />
              </IconButton>
            }
          />
        </div>

        <CollapsiblePanel>
          <div className="mt-2.5 space-y-3 border-t border-border/70 pt-3">
            {/* A div, not a label: a wrapping label would give the switch its
                text as the accessible name instead of the provider-specific one. */}
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0 text-ui leading-snug font-medium text-foreground">
                {t("settings:providers_showInModelPicker")}
              </span>
              <Switch
                checked={isShownInPicker}
                disabled={isChecking || !isAvailable}
                onCheckedChange={(checked) => props.onHiddenChange(!checked)}
                aria-label={
                  isChecking
                    ? t("settings:checkingCLIAvailability", { value0: title })
                    : isAvailable
                      ? t("settings:showInTheProviderPicker", { value0: title })
                      : t("settings:isUnavailableInTheProviderPicker", { value0: title })
                }
              />
            </div>
            {setupMessage ? (
              <div className="text-ui leading-snug text-muted-foreground">{setupMessage}</div>
            ) : null}
            <ProviderDocsLinks
              docs={props.config?.docs ?? []}
              setupGuide={{ title, href: props.option.setupDocsHref }}
            />
            {showProviderUpdateStatus && updateAdvisory?.status === "behind_latest" ? (
              <div className="text-ui leading-snug text-muted-foreground">
                {updateAdvisory.canUpdate && updateAdvisory.updateCommand ? (
                  <>
                    <span>{t("settings:command")} </span>
                    <code className="font-mono">{updateAdvisory.updateCommand}</code>
                  </>
                ) : (
                  t("settings:providers_newerVersionAvailable")
                )}
              </div>
            ) : null}
            {showSelfManagedUpdate && props.providerStatus ? (
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 text-ui leading-snug text-muted-foreground">
                  {title} {t("settings:managesItsOwnReleasesSoSynaraCannotTellWhether")}
                </div>
                <ProviderUpdateAction
                  providerStatus={props.providerStatus}
                  active={updateActive}
                  disabled={updateActive}
                  onUpdate={props.onUpdate}
                />
              </div>
            ) : null}
            {(props.config?.fields ?? [])
              .filter((field) => !isDefaultAccountIdentityField(field))
              .map((field) => (
                <ProviderInstallFieldControl
                  key={field.settingsKey}
                  field={field}
                  settings={props.settings}
                  updateSettings={props.updateSettings}
                />
              ))}
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 text-ui leading-snug text-muted-foreground">
                {t("settings:accounts_movedToAccounts", { value0: title })}
              </div>
              <Button
                type="button"
                size="xs"
                variant="outline"
                className="shrink-0"
                onClick={() => props.onManageAccounts(provider)}
              >
                {t("settings:accounts_manageInAccounts")}
              </Button>
            </div>
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}
