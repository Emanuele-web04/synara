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

function appSnapStatusText(state: DesktopAppSnapState | null): string {
  if (!state) return "Available in the Synara desktop app";
  if (!state.supported) return state.message ?? "Available on macOS only";
  if (state.status === "ready") {
    const shortcut = state.shortcut;
    const label = shortcut ? appSnapShortcutLabels(shortcut).join(" + ") : "the shortcut";
    return `Listening — press ${label} to snap`;
  }
  if (state.status === "disabled") return "Off";
  if (state.status === "starting") return "Starting the capture listener…";
  return state.message ?? "Permission setup required";
}

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

export function NotificationsSettingsPanel({
  settings,
  defaults,
  updateSettings,
  active,
}: AppSettingsBinding & { readonly active: boolean }) {
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
      title: "Desktop notifications unavailable",
      description: buildNotificationSettingsSupportText(permission),
    });
  }

  async function sendTestNotification() {
    const title = "Activity notification";
    const body = "Notification test for chats and terminal agents.";

    if (window.desktopBridge) {
      const shown = await window.desktopBridge.notifications.show({ title, body, silent: false });
      toastManager.add({
        type: shown ? "success" : "warning",
        title: shown ? "Test notification sent" : "Notifications unavailable",
        description: shown
          ? "Your operating system should show the notification."
          : "Desktop notifications are not supported on this device.",
      });
      return;
    }

    const permission = await requestBrowserNotificationPermission();
    setBrowserNotificationPermission(permission);
    if (permission !== "granted") {
      toastManager.add({
        type: permission === "denied" ? "warning" : "error",
        title: "Desktop notifications unavailable",
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
      title: "Test notification sent",
      description: "Your browser should show the notification.",
    });
  }

  if (!active) return null;

  return (
    <div className="space-y-6">
      <SettingsSection title="Activity alerts">
        <SettingsRow
          title="Activity toasts"
          description="Show an in-app toast when a chat or managed terminal agent finishes or needs input."
          resetAction={
            settings.enableTaskCompletionToasts !== defaults.enableTaskCompletionToasts ? (
              <SettingResetButton
                label="activity toasts"
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
              aria-label="Activity toast notifications"
            />
          }
        />

        <SettingsRow
          title="Desktop notifications"
          description="Show an OS notification when a chat or managed terminal agent finishes or needs input while the app is in the background."
          status={buildNotificationSettingsSupportText(browserNotificationPermission)}
          resetAction={
            settings.enableSystemTaskCompletionNotifications !==
            defaults.enableSystemTaskCompletionNotifications ? (
              <SettingResetButton
                label="desktop notifications"
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
                Test
              </Button>
              <Switch
                checked={settings.enableSystemTaskCompletionNotifications}
                onCheckedChange={(checked) => {
                  void setSystemNotificationsEnabled(Boolean(checked));
                }}
                aria-label="Desktop activity notifications"
              />
            </div>
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
        title: "AppSnap unavailable",
        description: "AppSnap requires the Synara desktop app on macOS.",
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
          title: "Finish AppSnap setup",
          description: state.message ?? "Allow the required macOS permissions, then try again.",
        });
      }
    } catch (error) {
      if (!requestGuard.isCurrent(requestId)) return;
      updateSettings({ enableAppSnap: false });
      toastManager.add({
        type: "error",
        title: "AppSnap setup failed",
        description: error instanceof Error ? error.message : "Could not configure AppSnap.",
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
            Take an AppSnap to show your agent another app's window
          </p>
          <p className={SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME}>
            Press your two-key shortcut while any app is frontmost. Synara captures that window as
            an image, brings itself forward, and attaches the snap to a task composer — the capture
            stays on this device until you send the message.
          </p>
          {!supported ? (
            <p className={cn(SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME, "pt-0.5")}>
              {appSnapState
                ? (appSnapState.message ?? "AppSnap is available only in the macOS desktop app.")
                : "AppSnap requires the Synara desktop app on macOS."}
            </p>
          ) : null}
        </div>
      </SettingsCard>

      <SettingsSection title="Capture">
        <SettingsRow
          title="Enable AppSnap"
          description="Run the capture listener in the background while Synara is open."
          status={appSnapStatusText(appSnapState)}
          resetAction={
            settings.enableAppSnap !== defaults.enableAppSnap ? (
              <SettingResetButton
                label="AppSnap"
                onClick={() => void setAppSnapEnabled(defaults.enableAppSnap)}
              />
            ) : null
          }
          control={
            <Switch
              checked={enabled}
              disabled={!supported}
              onCheckedChange={(checked) => void setAppSnapEnabled(Boolean(checked))}
              aria-label="Enable AppSnap"
            />
          }
        />

        <SettingsRow
          title="Shortcut"
          description="Choose exactly two keys: one modifier and one other key. Synara checks its own bindings and asks macOS whether another app already owns the shortcut before saving it."
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
          title="Destination"
          description="Snaps join the task you interacted with in the last minute, and consecutive snaps stay together. Otherwise Synara opens a fresh task with the capture attached."
          control={
            <span className="text-ui leading-snug font-medium text-muted-foreground">
              Automatic
            </span>
          }
        />

        <SettingsRow
          title="Capture sound"
          description="Play a short shutter cue when a window is captured."
          resetAction={
            settings.appSnapPlaySound !== defaults.appSnapPlaySound ? (
              <SettingResetButton
                label="capture sound"
                onClick={() => updateSettings({ appSnapPlaySound: defaults.appSnapPlaySound })}
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-2 sm:w-auto sm:justify-end">
              <Button size="xs" variant="outline" onClick={() => void playAppSnapCaptureSound()}>
                Preview
              </Button>
              <Switch
                checked={settings.appSnapPlaySound}
                onCheckedChange={(checked) =>
                  updateSettings({ appSnapPlaySound: Boolean(checked) })
                }
                aria-label="Play a sound when an AppSnap is captured"
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
          title: "Could not switch back to Synara",
          description: result.message ?? "Open Synara from your Applications folder.",
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
          <AlertDialogTitle>Switch back to Synara?</AlertDialogTitle>
          <AlertDialogDescription>
            Synara opens with the chats and settings it had before you tried Beta. Beta closes, and
            any chats still running in Beta stop.
          </AlertDialogDescription>
          <AlertDialogDescription>
            Anything you did in Beta stays in Beta. It can't be moved into Synara, because Beta can
            include features Synara doesn't have yet.
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
                <span className="block">Move Synara Beta to the Trash</span>
                <span className="block text-ui-sm text-muted-foreground">
                  Your Beta data is kept, so you can pick up where you left off if you come back.
                </span>
              </span>
            </label>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose disabled={pending} render={<Button variant="outline" size="sm" />}>
            Stay on Beta
          </AlertDialogClose>
          <Button size="sm" disabled={pending} onClick={() => void leave()}>
            {pending ? "Switching…" : "Switch to Synara"}
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
          title: "Could not start the beta handoff",
          description: result.message ?? "Try again from Settings → General.",
        });
        return;
      }
      toastManager.add({
        type: "success",
        title: "Opening Synara Beta",
        description:
          "Beta is copying your projects, settings, and provider sign-ins from stable on first launch.",
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
          title: "Could not open Synara Beta",
          description: result.message ?? "The beta install was not found.",
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
          title: "Could not install Synara Beta",
          description: result.message ?? "Try again from Settings → General.",
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
          <p className={SETTINGS_CARD_ROW_TITLE_CLASS_NAME}>You're on Synara Beta</p>
          <p className={SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME}>
            New features land here first. To help us fix things quickly, Beta shares crash reports,
            app errors, and anonymous usage counts. Crash reports can contain fragments of app
            memory.
          </p>
          <button
            type="button"
            className="flex cursor-pointer items-center gap-1.5 pt-1 text-ui-sm text-muted-foreground transition-colors hover:text-foreground"
            aria-expanded={sharesDisclosureOpen}
            onClick={() => setSharesDisclosureOpen((open) => !open)}
          >
            <DisclosureChevron open={sharesDisclosureOpen} />
            What Beta shares
          </button>
          <DisclosureRegion open={sharesDisclosureOpen}>
            <div className="space-y-2 pt-1.5">
              <div>
                <p className="m-0 text-ui-sm font-medium text-foreground">Shared</p>
                <ul className="m-0 list-disc space-y-0.5 pl-4 pt-0.5 text-ui-sm text-muted-foreground">
                  <li>A random ID for this install, not linked to you</li>
                  <li>When Beta opens, closes, installs, or is removed</li>
                  <li>Crashes and errors; text is redacted where possible</li>
                  <li>App version, OS version, and language</li>
                  <li>
                    Which providers you use, and how many projects, chats, and turns (just counts)
                  </li>
                  <li>Whether updates install correctly</li>
                </ul>
              </div>
              <div>
                <p className="m-0 text-ui-sm font-medium text-foreground">
                  Not included in usage counts
                </p>
                <ul className="m-0 list-disc space-y-0.5 pl-4 pt-0.5 text-ui-sm text-muted-foreground">
                  <li>Your chats, prompts, or agent replies</li>
                  <li>Your code, files, or project names</li>
                  <li>Keys, passwords, or account details</li>
                </ul>
              </div>
              <p className="m-0 text-ui-xs text-muted-foreground">
                Error text can still contain fragments of your work despite redaction. If Beta
                crashes, a snapshot of app memory is sent and may contain sensitive fragments. Crash
                dumps are deleted after 90 days; other reports are kept for a year.
              </p>
            </div>
          </DisclosureRegion>
          <div className="flex flex-wrap items-center gap-2 pt-1.5">
            {state.stableInstalled ? (
              <Button size="xs" variant="outline" onClick={() => setLeaveDialogOpen(true)}>
                Switch back to Synara
              </Button>
            ) : (
              <Button size="xs" variant="outline" onClick={() => void openStableDownloadPage()}>
                Get Synara
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
            <span className="inline-flex items-center rounded-full bg-[var(--beta-pill)] px-1.5 py-0.5 text-ui-xs font-semibold uppercase leading-none tracking-wide text-[var(--beta-pill-ink)]">
              Beta
            </span>
            {state.installed && state.version ? (
              <span className="text-ui-xs text-muted-foreground">v{state.version} installed</span>
            ) : state.installed ? (
              <span className="text-ui-xs text-muted-foreground">Installed</span>
            ) : null}
          </div>
          <p className={SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME}>
            {state.installed
              ? "Beta runs next to Synara with its own data, so nothing here changes. Copy your data to bring over projects, settings, and provider sign-ins. Beta shares crash reports and anonymous usage stats."
              : "Try new features before everyone else. Synara Beta is a separate app with its own data, and this app stays exactly as it is. Beta shares crash reports and anonymous usage stats to help us improve it."}
          </p>
          {state.lastImportAt ? (
            <p className="text-ui-xs text-muted-foreground">
              Last copied your data {new Date(state.lastImportAt).toLocaleString()}.
            </p>
          ) : null}
          {state.lastImportError ? (
            <p className="text-ui-xs text-destructive">
              Last import failed: {state.lastImportError}
            </p>
          ) : null}
          {state.install?.phase === "error" ? (
            <p className="text-ui-xs text-destructive">
              Install failed: {state.install.message ?? "unknown error"}
            </p>
          ) : state.install ? (
            <p className="text-ui-xs text-muted-foreground">
              {state.install.phase === "downloading"
                ? `Downloading Synara Beta${state.install.percent !== null ? ` — ${state.install.percent}%` : "…"}`
                : state.install.phase === "verifying"
                  ? "Verifying the download…"
                  : state.install.phase === "installing"
                    ? "Installing Synara Beta…"
                    : "Opening Synara Beta…"}
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
                    {actionPending === "install" ? "Installing…" : "Install Synara Beta"}
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={actionPending !== null}
                    onClick={() => setCopyDialogOpen(true)}
                  >
                    {actionPending === "copy" ? "Installing…" : "Copy my data and open"}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={actionPending !== null}
                    onClick={() => void openDownloadPage()}
                  >
                    Download page
                  </Button>
                </>
              ) : (
                <Button size="xs" onClick={() => void openDownloadPage()}>
                  Get Synara Beta
                </Button>
              )
            ) : (
              <>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={actionPending !== null || state.running}
                  title={
                    state.running
                      ? "Quit Synara Beta first so it can pick up the import on its next launch."
                      : undefined
                  }
                  onClick={() => setCopyDialogOpen(true)}
                >
                  {actionPending === "copy"
                    ? "Copying…"
                    : state.lastImportAt
                      ? "Re-copy my data and open"
                      : "Copy my data and open"}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={actionPending !== null}
                  onClick={() => void launchBeta()}
                >
                  {actionPending === "open" ? "Opening…" : "Open Beta"}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
      <AlertDialog open={copyDialogOpen} onOpenChange={setCopyDialogOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace Synara Beta data?</AlertDialogTitle>
            <AlertDialogDescription>
              Copying from Synara replaces the chats, projects, settings, and provider sign-ins
              currently in Synara Beta. Work done only in Beta will be lost. Your data in Synara
              will not change.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              Keep Beta data
            </AlertDialogClose>
            <Button
              size="sm"
              disabled={actionPending !== null}
              onClick={() => {
                setCopyDialogOpen(false);
                void copyDataAndLaunch();
              }}
            >
              Replace Beta data and open
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsCard>
  );
}
