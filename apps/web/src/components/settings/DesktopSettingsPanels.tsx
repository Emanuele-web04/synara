// FILE: DesktopSettingsPanels.tsx
// Purpose: Own settings panels whose behavior depends on browser or desktop-native lifecycles.
// Layer: Settings UI components
// Exports: NotificationsSettingsPanel, AppSnapSettingsPanel, BetaChannelSettingsPanel

import {
  type DesktopAppSnapSettingsPane,
  type DesktopAppSnapState,
  type DesktopBetaActionResult,
  type DesktopBetaChannelState,
  type ResolvedKeybindingsConfig,
} from "@synara/contracts";
import { appSnapShortcutLabels } from "@synara/shared/appSnapShortcut";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";

import type { AppSettingsBinding } from "~/appSettings";
import { createLatestAppSnapRequestGuard } from "~/appSnap.logic";
import { useRefreshOnWindowReturn } from "~/hooks/useRefreshOnWindowReturn";
import { playAppSnapCaptureSound } from "~/lib/appSnapSound";
import { CentralIcon } from "~/lib/central-icons";
import { cn } from "~/lib/utils";
import { isElectron } from "~/env";
import {
  buildNotificationSettingsSupportText,
  readBrowserNotificationPermissionState,
  requestBrowserNotificationPermission,
} from "~/notifications/taskCompletion";
import {
  SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME,
  SETTINGS_CARD_ROW_TITLE_CLASS_NAME,
} from "~/settingsPanelStyles";
import {
  APP_SNAP_PERMISSION_PANES,
  AppSnapPermissionSection,
  useAppSnapPermissionGuideBridge,
} from "./AppSnapPermissionSection";
import { AppSnapShortcutControl } from "./AppSnapShortcutControl";
import { SettingResetButton } from "./SettingControls";
import { SettingsCard, SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { useTranslation, t } from "~/i18n";

function appSnapStatusText(state: DesktopAppSnapState | null): string {
  if (!state) return t("settings:availableInTheSynaraDesktopApp");
  if (!state.supported) return state.message ?? t("settings:availableOnMacOSOnly");
  if (state.status === "ready") {
    const shortcut = state.shortcut;
    const label = shortcut
      ? appSnapShortcutLabels(shortcut).join(" + ")
      : t("settings:theShortcut");
    return t("settings:listeningPressToSnap", { value0: label });
  }
  if (state.status === "disabled") return t("automation:traitsPicker_off");
  if (state.status === "starting") return t("settings:startingTheCaptureListener");
  return state.message ?? t("settings:permissionSetupRequired");
}

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

export function NotificationsSettingsPanel({
  settings,
  defaults,
  updateSettings,
  active,
}: AppSettingsBinding & { readonly active: boolean }) {
  const { t } = useTranslation();

  const [browserNotificationPermission, setBrowserNotificationPermission] = useState(
    readBrowserNotificationPermissionState(),
  );

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setBrowserNotificationPermission(readBrowserNotificationPermissionState());
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, []);

  async function setSystemNotificationsEnabled(nextEnabled: boolean) {
    if (!nextEnabled) {
      updateSettings({ enableSystemTaskCompletionNotifications: false });
      return;
    }

    if (isElectron) {
      updateSettings({ enableSystemTaskCompletionNotifications: true });
      return;
    }

    const permission = await requestBrowserNotificationPermission();
    setBrowserNotificationPermission(permission);

    if (permission === "granted") {
      updateSettings({ enableSystemTaskCompletionNotifications: true });
      return;
    }

    updateSettings({ enableSystemTaskCompletionNotifications: false });
    toastManager.add({
      type: permission === "denied" ? "warning" : "error",
      title: t("settings:desktopNotificationsUnavailable"),
      description: buildNotificationSettingsSupportText(permission),
    });
  }

  async function sendTestNotification() {
    const title = t("settings:activityNotification");
    const body = "Notification test for chats and terminal agents.";

    if (window.desktopBridge) {
      const shown = await window.desktopBridge.notifications.show({ title, body, silent: false });
      toastManager.add({
        type: shown ? "success" : "warning",
        title: shown
          ? t("settings:testNotificationSent")
          : t("settings:notifications_notificationsUnavailable"),
        description: shown
          ? t("settings:yourOperatingSystemShouldShowTheNotification")
          : t("settings:desktopNotificationsAreNotSupportedOnThisDevice"),
      });
      return;
    }

    const permission = await requestBrowserNotificationPermission();
    setBrowserNotificationPermission(permission);
    if (permission !== "granted") {
      toastManager.add({
        type: permission === "denied" ? "warning" : "error",
        title: t("settings:desktopNotificationsUnavailable"),
        description: buildNotificationSettingsSupportText(permission),
      });
      return;
    }

    const notification = new Notification(title, { body, tag: "synara:test-notification" });
    notification.addEventListener("click", () => {
      window.focus();
    });
    toastManager.add({
      type: "success",
      title: t("settings:testNotificationSent"),
      description: t("settings:yourBrowserShouldShowTheNotification"),
    });
  }

  if (!active) return null;

  return (
    <div className="space-y-6">
      <SettingsSection title="settings:notifications_activityAlerts">
        <SettingsRow
          id="setting-activity-toasts"
          title="settings:changed_activityToasts"
          description="settings:showAnInAppToastWhenAChatOr"
          resetAction={
            settings.enableTaskCompletionToasts !== defaults.enableTaskCompletionToasts ? (
              <SettingResetButton
                label={t("settings:activityToasts")}
                onClick={() =>
                  updateSettings({
                    enableTaskCompletionToasts: defaults.enableTaskCompletionToasts,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.enableTaskCompletionToasts}
              onCheckedChange={(checked) =>
                updateSettings({ enableTaskCompletionToasts: Boolean(checked) })
              }
              aria-label={t("settings:activityToastNotifications")}
            />
          }
        />

        <SettingsRow
          id="setting-desktop-notifications"
          title="settings:changed_desktopNotifications"
          description="settings:showAnOSNotificationWhenAChatOrManaged"
          status={buildNotificationSettingsSupportText(browserNotificationPermission)}
          resetAction={
            settings.enableSystemTaskCompletionNotifications !==
            defaults.enableSystemTaskCompletionNotifications ? (
              <SettingResetButton
                label={t("settings:desktopNotifications")}
                onClick={() =>
                  updateSettings({
                    enableSystemTaskCompletionNotifications:
                      defaults.enableSystemTaskCompletionNotifications,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-2 sm:w-auto sm:justify-end">
              <Button size="xs" variant="outline" onClick={() => void sendTestNotification()}>
                {t("workspace:test")}
              </Button>
              <Switch
                checked={settings.enableSystemTaskCompletionNotifications}
                onCheckedChange={(checked) => {
                  void setSystemNotificationsEnabled(Boolean(checked));
                }}
                aria-label={t("settings:desktopActivityNotifications")}
              />
            </div>
          }
        />

        <SettingsRow
          id="setting-wait-for-subagents"
          title="settings:waitForSubagents"
          description="settings:alertOnceTheAgentAndAllOfItsBackground"
          resetAction={
            settings.notifyAfterSubagentsFinish !== defaults.notifyAfterSubagentsFinish ? (
              <SettingResetButton
                label={t("settings:waitForSubagents2")}
                onClick={() =>
                  updateSettings({
                    notifyAfterSubagentsFinish: defaults.notifyAfterSubagentsFinish,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.notifyAfterSubagentsFinish}
              onCheckedChange={(checked) =>
                updateSettings({ notifyAfterSubagentsFinish: Boolean(checked) })
              }
              aria-label={t("settings:waitForSubagentsBeforeAlerting")}
            />
          }
        />
      </SettingsSection>
    </div>
  );
}

export function AppSnapSettingsPanel({
  settings,
  defaults,
  updateSettings,
  active,
}: AppSettingsBinding & { readonly active: boolean }) {
  const { t } = useTranslation();

  const [appSnapState, setAppSnapState] = useState<DesktopAppSnapState | null>(null);
  const [openGuidePane, setOpenGuidePane] = useState<DesktopAppSnapSettingsPane | null>(null);
  const appSnapRequestGuardRef = useRef(createLatestAppSnapRequestGuard());
  const serverConfigQuery = useQuery({ ...serverConfigQueryOptions(), enabled: active });
  const keybindings = serverConfigQuery.data?.keybindings ?? EMPTY_KEYBINDINGS;

  // getState publishes through onState below. A passive refresh must not
  // invalidate an enable request that is waiting for the macOS permission dialog.
  useRefreshOnWindowReturn(() => window.desktopBridge?.appSnap?.getState(), active);

  // Panel-level on purpose: hooks above the `!active` return stay mounted while
  // the surface is hidden, so a dismissed coach still clears the remembered
  // pane instead of resurrecting the guide on return.
  useAppSnapPermissionGuideBridge({
    onStateChange: setAppSnapState,
    onGuidePaneChange: setOpenGuidePane,
  });

  useEffect(() => {
    const bridge = window.desktopBridge?.appSnap;
    if (!bridge) return;
    let disposed = false;
    const unsubscribe = bridge.onState((state) => {
      if (!disposed) setAppSnapState(state);
    });
    void bridge
      .getState()
      .then((state) => {
        if (!disposed) setAppSnapState(state);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  async function setAppSnapEnabled(nextEnabled: boolean) {
    const requestGuard = appSnapRequestGuardRef.current;
    const requestId = requestGuard.begin();
    const bridge = window.desktopBridge?.appSnap;
    if (!bridge) {
      toastManager.add({
        type: "warning",
        title: t("settings:appSnapUnavailable"),
        description: t("settings:appSnapRequiresTheSynaraDesktopAppOnMacOS"),
      });
      return;
    }

    try {
      if (nextEnabled) {
        const permissionState = await bridge.requestPermissions();
        if (!requestGuard.isCurrent(requestId)) return;
        setAppSnapState(permissionState);
      }
      if (!requestGuard.isCurrent(requestId)) return;
      updateSettings({ enableAppSnap: nextEnabled });
      const state = await bridge.setEnabled(nextEnabled);
      if (!requestGuard.isCurrent(requestId)) return;
      setAppSnapState(state);
      if (nextEnabled && state.status === "permission-required") {
        if (state.inputMonitoringPermission !== "granted") {
          setOpenGuidePane("input-monitoring");
        } else if (state.screenRecordingPermission !== "granted") {
          setOpenGuidePane("screen-recording");
        }
      } else if (nextEnabled && state.status === "error") {
        toastManager.add({
          type: "warning",
          title: t("settings:finishAppSnapSetup"),
          description: state.message ?? t("settings:allowTheRequiredMacOSPermissionsThenTryAgain"),
        });
      }
    } catch (error) {
      if (!requestGuard.isCurrent(requestId)) return;
      updateSettings({ enableAppSnap: false });
      toastManager.add({
        type: "error",
        title: t("settings:appSnapSetupFailed"),
        description:
          error instanceof Error ? error.message : t("settings:couldNotConfigureAppSnap"),
      });
    }
  }

  const supported = appSnapState?.supported === true;
  const enabled = supported && settings.enableAppSnap;

  if (!active) return null;

  return (
    <div className="space-y-6">
      <SettingsCard divided={false} className="flex items-start gap-3 px-4 py-3.5">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-[color:var(--color-border)] text-muted-foreground">
          <CentralIcon name="screen-capture" className="size-4" />
        </span>
        <div className="min-w-0 space-y-1">
          <p className={SETTINGS_CARD_ROW_TITLE_CLASS_NAME}>
            {t("settings:takeAnAppSnapToShowYourAgentAnotherApp")}
          </p>
          <p className={SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME}>
            {t("settings:pressYourTwoKeyShortcutWhileAnyAppIs")}
          </p>
          {!supported ? (
            <p className={cn(SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME, "pt-0.5")}>
              {appSnapState
                ? (appSnapState.message ?? t("settings:appSnapIsAvailableOnlyInTheMacOSDesktopApp"))
                : t("settings:appSnapRequiresTheSynaraDesktopAppOnMacOS")}
            </p>
          ) : null}
        </div>
      </SettingsCard>

      <SettingsSection title="settings:capture">
        <SettingsRow
          id="setting-enable-appsnap"
          title="settings:enableAppSnap"
          description="settings:runTheCaptureListenerInTheBackgroundWhileSynara"
          status={appSnapStatusText(appSnapState)}
          resetAction={
            settings.enableAppSnap !== defaults.enableAppSnap ? (
              <SettingResetButton
                label={t("settings:appSnap")}
                onClick={() => void setAppSnapEnabled(defaults.enableAppSnap)}
              />
            ) : null
          }
          control={
            <Switch
              checked={enabled}
              disabled={!supported}
              onCheckedChange={(checked) => void setAppSnapEnabled(Boolean(checked))}
              aria-label={t("settings:enableAppSnap")}
            />
          }
        />

        <SettingsRow
          id="setting-shortcut"
          title="settings:shortcut"
          description="settings:chooseExactlyTwoKeysOneModifierAndOneOther"
          control={
            <AppSnapShortcutControl
              key={
                settings.appSnapShortcut.kind === "both-option-keys"
                  ? settings.appSnapShortcut.kind
                  : `${settings.appSnapShortcut.modifier}:${settings.appSnapShortcut.key}`
              }
              shortcut={settings.appSnapShortcut}
              enabled={enabled}
              reserved={enabled && appSnapState?.status === "ready"}
              keybindings={keybindings}
              onSaved={(shortcut, state) => {
                updateSettings({ appSnapShortcut: shortcut });
                setAppSnapState(state);
              }}
            />
          }
        />

        <SettingsRow
          id="setting-destination"
          title="git:destination"
          description="settings:snapsJoinTheTaskYouInteractedWithInThe2"
          control={
            <span className="text-ui leading-snug font-medium text-muted-foreground">
              {t("settings:automatic")}
            </span>
          }
        />

        <SettingsRow
          id="setting-capture-sound"
          title="settings:captureSound"
          description="settings:playAShortShutterCueWhenAWindowIs"
          resetAction={
            settings.appSnapPlaySound !== defaults.appSnapPlaySound ? (
              <SettingResetButton
                label={t("settings:captureSound2")}
                onClick={() => updateSettings({ appSnapPlaySound: defaults.appSnapPlaySound })}
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-2 sm:w-auto sm:justify-end">
              <Button size="xs" variant="outline" onClick={() => void playAppSnapCaptureSound()}>
                {t("workspace:settings_gitToastPreview")}
              </Button>
              <Switch
                checked={settings.appSnapPlaySound}
                onCheckedChange={(checked) =>
                  updateSettings({ appSnapPlaySound: Boolean(checked) })
                }
                aria-label={t("settings:playASoundWhenAnAppSnapIsCaptured")}
              />
            </div>
          }
        />
      </SettingsSection>

      {supported && appSnapState ? (
        <AppSnapPermissionSection
          panes={APP_SNAP_PERMISSION_PANES}
          feature="AppSnap"
          state={appSnapState}
          onStateChange={setAppSnapState}
          guidePane={openGuidePane}
          onGuidePaneChange={setOpenGuidePane}
        />
      ) : null}
    </div>
  );
}

/**
 * Beta → stable: opens stable Synara and quits beta. Beta data is never copied
 * back because beta can hold data for features stable does not have yet.
 */
function LeaveBetaDialog({
  open,
  canMoveToTrash,
  onOpenChange,
  onLeave,
}: {
  readonly open: boolean;
  readonly canMoveToTrash: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onLeave: (moveToTrash: boolean) => Promise<DesktopBetaActionResult>;
}) {
  const { t } = useTranslation();

  const [moveToTrash, setMoveToTrash] = useState(true);
  const [pending, setPending] = useState(false);
  const trashCheckboxId = useId();

  async function leave() {
    setPending(true);
    try {
      const result = await onLeave(canMoveToTrash && moveToTrash).catch(
        (error: unknown): DesktopBetaActionResult => ({
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      if (!result.ok) {
        toastManager.add({
          type: "warning",
          title: t("settings:couldNotSwitchBackToSynara"),
          description: result.message ?? t("settings:openSynaraFromYourApplicationsFolder"),
        });
        onOpenChange(false);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("settings:switchBackToSynara2")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("settings:synaraOpensWithTheChatsAndSettingsItHad")}
          </AlertDialogDescription>
          <AlertDialogDescription>
            {t("settings:anythingYouDidInBetaStaysInBetaIt")}
          </AlertDialogDescription>
          {canMoveToTrash ? (
            <label
              htmlFor={trashCheckboxId}
              className="flex cursor-pointer select-none items-start gap-2 pt-2 text-ui text-foreground"
            >
              <Checkbox
                id={trashCheckboxId}
                className="mt-0.5"
                checked={moveToTrash}
                disabled={pending}
                onCheckedChange={(checked) => setMoveToTrash(checked === true)}
              />
              <span className="space-y-0.5">
                <span className="block">{t("settings:moveSynaraBetaToTheTrash")}</span>
                <span className="block text-ui-sm text-muted-foreground">
                  {t("settings:yourBetaDataIsKeptSoYouCanPick")}
                </span>
              </span>
            </label>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose disabled={pending} render={<Button variant="outline" size="sm" />}>
            {t("settings:stayOnBeta")}
          </AlertDialogClose>
          <Button size="sm" disabled={pending} onClick={() => void leave()}>
            {pending ? t("settings:switching") : t("settings:switchToSynara")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function BetaChannelMark() {
  return (
    <img
      src="/app-icons/beta.png"
      alt="Synara Beta"
      className="mt-0.5 size-9 shrink-0 rounded-xl"
    />
  );
}

/**
 * Stable → Synara Beta handoff. Rendered inside General settings; visible only
 * on desktop builds, with the full action card on production and a status card
 * (plus diagnostics disclosure) on beta.
 */
export function BetaChannelSettingsPanel({ active }: { readonly active: boolean }) {
  const { t, formatLocale } = useTranslation();

  const betaBridge = isElectron ? window.desktopBridge?.beta : undefined;
  const betaStateQuery = useQuery({
    queryKey: ["desktop-beta-channel-state"],
    queryFn: () => betaBridge!.getState(),
    enabled: active && betaBridge !== undefined,
    // Poll fast while a download/install is in flight so the progress row moves.
    refetchInterval: (query) =>
      query.state.data?.install && query.state.data.install.phase !== "error" ? 500 : 30_000,
  });
  const [actionPending, setActionPending] = useState<"copy" | "open" | "install" | null>(null);
  const [copyDialogOpen, setCopyDialogOpen] = useState(false);
  const [leaveDialogOpen, setLeaveDialogOpen] = useState(false);
  const [sharesDisclosureOpen, setSharesDisclosureOpen] = useState(false);
  const state: DesktopBetaChannelState | null = betaStateQuery.data ?? null;

  if (!active || !betaBridge || !state?.supported) return null;

  const refresh = () => void betaStateQuery.refetch();

  async function copyDataAndLaunch() {
    setActionPending("copy");
    try {
      const result = await betaBridge!.importAndLaunch();
      if (!result.ok) {
        toastManager.add({
          type: "warning",
          title: t("settings:couldNotStartTheBetaHandoff"),
          description: result.message ?? t("settings:tryAgainFromSettingsGeneral"),
        });
        return;
      }
      toastManager.add({
        type: "success",
        title: t("settings:openingSynaraBeta"),
        description: t("settings:betaIsCopyingYourProjectsSettingsAndProviderSign"),
      });
      refresh();
    } finally {
      setActionPending(null);
    }
  }

  async function launchBeta() {
    setActionPending("open");
    try {
      const result = await betaBridge!.launch();
      if (!result.ok) {
        toastManager.add({
          type: "warning",
          title: t("settings:couldNotOpenSynaraBeta"),
          description: result.message ?? t("settings:theBetaInstallWasNotFound"),
        });
      }
      refresh();
    } finally {
      setActionPending(null);
    }
  }

  async function installBeta() {
    setActionPending("install");
    try {
      const result = await betaBridge!.install();
      if (!result.ok) {
        toastManager.add({
          type: "warning",
          title: t("settings:couldNotInstallSynaraBeta"),
          description: result.message ?? t("settings:tryAgainFromSettingsGeneral"),
        });
      }
      refresh();
    } finally {
      setActionPending(null);
    }
  }

  async function openStableDownloadPage() {
    if (state?.stableDownloadUrl && window.desktopBridge?.openExternal) {
      await window.desktopBridge.openExternal(state.stableDownloadUrl);
    }
  }

  async function openDownloadPage() {
    if (state?.downloadUrl && window.desktopBridge?.openExternal) {
      await window.desktopBridge.openExternal(state.downloadUrl);
    }
  }

  if (state.flavor === "beta") {
    return (
      <SettingsCard divided={false} className="flex items-start gap-3 px-4 py-3.5">
        <BetaChannelMark />
        <div className="min-w-0 flex-1 space-y-1">
          <p className={SETTINGS_CARD_ROW_TITLE_CLASS_NAME}>{t("settings:youReOnSynaraBeta")}</p>
          <p className={SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME}>
            {t("settings:toHelpUsFixProblemsBetaSharesCrashReports")}
          </p>
          <button
            type="button"
            className="flex cursor-pointer items-center gap-1.5 pt-1 text-ui-sm text-muted-foreground transition-colors hover:text-foreground"
            aria-expanded={sharesDisclosureOpen}
            onClick={() => setSharesDisclosureOpen((open) => !open)}
          >
            <DisclosureChevron open={sharesDisclosureOpen} />
            {t("settings:whatBetaShares")}
          </button>
          <DisclosureRegion open={sharesDisclosureOpen}>
            <div className="space-y-2 pt-1.5">
              <div>
                <p className="m-0 text-ui-sm font-medium text-foreground">{t("settings:shared")}</p>
                <ul className="m-0 list-disc space-y-0.5 pl-4 pt-0.5 text-ui-sm text-muted-foreground">
                  <li>{t("settings:aRandomIDForThisInstallNotLinkedTo")}</li>
                  <li>{t("settings:whenBetaOpensClosesInstallsOrIsRemoved")}</li>
                  <li>{t("settings:crashesAndErrorsErrorDetailsAreFiltered")}</li>
                  <li>{t("settings:appVersionOSVersionAndLanguage")}</li>
                  <li>{t("settings:whichProvidersYouUseAndHowManyProjectsChats")}</li>
                  <li>{t("settings:whetherUpdatesInstallCorrectly")}</li>
                </ul>
              </div>
              <div>
                <p className="m-0 text-ui-sm font-medium text-foreground">
                  {t("settings:notIncludedInUsageCounts")}
                </p>
                <ul className="m-0 list-disc space-y-0.5 pl-4 pt-0.5 text-ui-sm text-muted-foreground">
                  <li>{t("settings:yourChatsPromptsOrAgentReplies")}</li>
                  <li>{t("settings:yourCodeFilesOrProjectNames")}</li>
                  <li>{t("settings:keysPasswordsOrAccountDetails")}</li>
                </ul>
              </div>
              <p className="m-0 text-ui-xs text-muted-foreground">
                {t("settings:errorDetailsAreFilteredButMayStillIncludePrivate")}
              </p>
            </div>
          </DisclosureRegion>
          <div className="flex flex-wrap items-center gap-2 pt-1.5">
            {state.stableInstalled ? (
              <Button size="xs" variant="outline" onClick={() => setLeaveDialogOpen(true)}>
                {t("settings:switchBackToSynara")}
              </Button>
            ) : (
              <Button size="xs" variant="outline" onClick={() => void openStableDownloadPage()}>
                {t("settings:getSynara")}
              </Button>
            )}
          </div>
        </div>
        <LeaveBetaDialog
          open={leaveDialogOpen}
          canMoveToTrash={state.canMoveBetaToTrash}
          onOpenChange={setLeaveDialogOpen}
          onLeave={(moveToTrash) => betaBridge!.leave({ moveToTrash })}
        />
      </SettingsCard>
    );
  }

  if (state.flavor !== "production") return null;

  return (
    <SettingsCard divided={false} className="px-4 py-3.5">
      <div className="flex items-start gap-3">
        <BetaChannelMark />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <p className={SETTINGS_CARD_ROW_TITLE_CLASS_NAME}>Synara Beta</p>
            <span className="inline-flex items-center rounded-full bg-[var(--beta-pill)] px-1.5 py-0.5 text-ui-xs font-semibold leading-none text-[var(--beta-pill-ink)]">
              {t("workspace:beta")}
            </span>
            {state.installed && state.version ? (
              <span className="text-ui-xs text-muted-foreground">
                {t("common:v")}
                {state.version} {t("settings:installed2")}
              </span>
            ) : state.installed ? (
              <span className="text-ui-xs text-muted-foreground">{t("settings:installed")}</span>
            ) : null}
          </div>
          <p className={SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME}>
            {state.installed
              ? t("settings:betaRunsNextToSynaraWithItsOwnData")
              : t("settings:tryNewFeaturesBeforeEveryoneElseSynaraBetaIs")}
          </p>
          {state.lastImportAt ? (
            <p className="text-ui-xs text-muted-foreground">
              {t("settings:lastCopiedYourData", {
                date: new Date(state.lastImportAt).toLocaleString(formatLocale),
              })}
            </p>
          ) : null}
          {state.lastImportError ? (
            <p className="text-ui-xs text-destructive">
              {t("settings:lastImportFailed")} {state.lastImportError}
            </p>
          ) : null}
          {state.install?.phase === "error" ? (
            <p className="text-ui-xs text-destructive">
              {t("settings:installFailed")} {state.install.message ?? t("settings:unknownError")}
            </p>
          ) : state.install ? (
            <p className="text-ui-xs text-muted-foreground">
              {state.install.phase === "downloading"
                ? t("settings:downloadingSynaraBeta", {
                    value0: state.install.percent !== null ? ` — ${state.install.percent}%` : "…",
                  })
                : state.install.phase === "verifying"
                  ? t("settings:verifyingTheDownload")
                  : state.install.phase === "installing"
                    ? t("settings:installingSynaraBeta")
                    : t("settings:openingSynaraBeta2")}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 pt-1.5">
            {!state.installed ? (
              state.canInstall ? (
                <>
                  <Button
                    size="xs"
                    disabled={actionPending !== null}
                    onClick={() => void installBeta()}
                  >
                    {actionPending === "install"
                      ? t("settings:installing")
                      : t("settings:installSynaraBeta")}
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={actionPending !== null}
                    onClick={() => setCopyDialogOpen(true)}
                  >
                    {actionPending === "copy"
                      ? t("settings:installing")
                      : t("settings:copyMyDataAndOpen")}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={actionPending !== null}
                    onClick={() => void openDownloadPage()}
                  >
                    {t("settings:downloadPage")}
                  </Button>
                </>
              ) : (
                <Button size="xs" onClick={() => void openDownloadPage()}>
                  {t("settings:getSynaraBeta")}
                </Button>
              )
            ) : (
              <>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={actionPending !== null || state.running}
                  title={state.running ? t("settings:quitSynaraBetaFirstSoItCanPickUp") : undefined}
                  onClick={() => setCopyDialogOpen(true)}
                >
                  {actionPending === "copy"
                    ? t("settings:copying")
                    : state.lastImportAt
                      ? t("settings:reCopyMyDataAndOpen")
                      : t("settings:copyMyDataAndOpen")}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={actionPending !== null}
                  onClick={() => void launchBeta()}
                >
                  {actionPending === "open" ? t("settings:opening") : t("settings:openBeta")}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
      <AlertDialog open={copyDialogOpen} onOpenChange={setCopyDialogOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings:replaceSynaraBetaData")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings:copyingFromSynaraReplacesBetaChatsAndProjectsChats")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              {t("settings:keepBetaData")}
            </AlertDialogClose>
            <Button
              size="sm"
              disabled={actionPending !== null}
              onClick={() => {
                setCopyDialogOpen(false);
                void copyDataAndLaunch();
              }}
            >
              {t("settings:replaceBetaDataAndOpen")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsCard>
  );
}
