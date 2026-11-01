// FILE: AppSnapPermissionSection.tsx
// Purpose: The single guided macOS permission checklist — per-pane Grant buttons that deep-link
//          System Settings, run the floating GrantCoach, and poll until the grant lands. Shared
//          by AppSnap (Input Monitoring + Screen Recording) and Computer control
//          (Accessibility + Screen Recording + Input Monitoring).
// Layer: Settings UI component

import {
  type DesktopAppSnapPermission,
  type DesktopAppSnapPermissionKind,
  type DesktopAppSnapSettingsPane,
  type DesktopAppSnapState,
} from "@synara/contracts";
import { useEffect, useRef, useState } from "react";

import { createLatestAppSnapRequestGuard } from "~/appSnap.logic";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { StatusDot } from "~/components/ui/status-chip";
import { toastManager } from "~/components/ui/toast";
import { AppSnapPermissionGuide } from "./AppSnapPermissionGuide";
import { SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";
import { useTranslation } from "~/i18n";

export interface AppSnapPermissionPaneDescriptor {
  readonly pane: DesktopAppSnapSettingsPane;
  readonly title: string;
  readonly description: string;
}

/** The AppSnap panel's rows: the legacy pair the feature itself needs. */
export const APP_SNAP_PERMISSION_PANES: readonly AppSnapPermissionPaneDescriptor[] = [
  {
    pane: "input-monitoring",
    title: "settings:inputMonitoring",
    description: "settings:letsSynaraNoticeTheDoubleOptionChordWhileAnother",
  },
  {
    pane: "screen-recording",
    title: "settings:screenRecording",
    description: "settings:letsSynaraCaptureAnImageOfTheFrontmostWindow",
  },
];

/**
 * Computer also needs Input Monitoring for Escape and human takeover. This
 * grant does not enable AppSnap's shortcut. The matching kind list lives in
 * `@synara/shared/computerGrants`.
 */
export const COMPUTER_PERMISSION_PANES: readonly AppSnapPermissionPaneDescriptor[] = [
  {
    pane: "accessibility",
    title: "settings:accessibility",
    description: "settings:letsSynaraMoveThePointerClickAndTypeOn",
  },
  {
    pane: "screen-recording",
    title: "settings:screenRecording",
    description: "settings:letsSynaraCaptureWindowsAndTheDesktopSoThe",
  },
  {
    pane: "input-monitoring",
    title: "settings:inputMonitoring",
    description: "settings:letsSynaraDetectEscapeAndPauseWhenYouTake",
  },
];

const PERMISSION_LABELS: Record<DesktopAppSnapPermission, string> = {
  granted: "settings:granted",
  denied: "settings:denied",
  "not-determined": "settings:notRequestedYet",
  restricted: "settings:restricted",
  unknown: "common:common_unknown",
};

const PANE_LABELS: Record<DesktopAppSnapSettingsPane, string> = {
  accessibility: "settings:accessibility",
  "input-monitoring": "settings:inputMonitoring",
  "screen-recording": "settings:screenRecording",
};

function AppSnapPermissionBadge({ permission }: { permission: DesktopAppSnapPermission }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center gap-1.5 text-ui-xs font-medium text-muted-foreground">
      <StatusDot
        aria-hidden
        className={
          permission === "granted"
            ? "bg-emerald-500"
            : permission === "denied" || permission === "restricted"
              ? "bg-red-500"
              : "bg-[color:var(--color-border)]"
        }
      />
      {t(PERMISSION_LABELS[permission])}
    </span>
  );
}

export function appSnapPanePermission(
  state: DesktopAppSnapState,
  pane: DesktopAppSnapSettingsPane,
): DesktopAppSnapPermission {
  if (pane === "input-monitoring") return state.inputMonitoringPermission;
  if (pane === "accessibility") return state.accessibilityPermission ?? "unknown";
  return state.screenRecordingPermission;
}

/**
 * Keeps the parent-owned guide state honest while the settings surface lives:
 * a native "granted" refreshes the permission snapshot; a dismissed coach
 * ("closed") clears the remembered pane so it cannot resurrect on the next
 * mount. Panels call this at panel level — hooks above an `if (!active)
 * return null` stay mounted while the surface is hidden, which is exactly
 * when the coach can still report a dismissal.
 */
export function useAppSnapPermissionGuideBridge({
  permissionKinds,
  onStateChange,
  onGuidePaneChange,
}: {
  readonly permissionKinds?: readonly DesktopAppSnapPermissionKind[];
  readonly onStateChange: (state: DesktopAppSnapState) => void;
  readonly onGuidePaneChange: (pane: DesktopAppSnapSettingsPane | null) => void;
}): void {
  const onStateChangeRef = useRef(onStateChange);
  const onGuidePaneChangeRef = useRef(onGuidePaneChange);
  const permissionKindsRef = useRef(permissionKinds);
  onStateChangeRef.current = onStateChange;
  onGuidePaneChangeRef.current = onGuidePaneChange;
  permissionKindsRef.current = permissionKinds;

  useEffect(() => {
    const bridge = window.desktopBridge?.appSnap;
    if (!bridge) return;
    let disposed = false;
    const unsubscribe = bridge.onPermissionGuideState((guideState) => {
      if (disposed) return;
      if (guideState === "granted") {
        // Refresh the real permission state so the success effect can close the
        // guide and show the "Permission granted" toast.
        void bridge
          .getState(permissionKindsRef.current)
          .then((next) => {
            if (!disposed) onStateChangeRef.current(next);
          })
          .catch(() => undefined);
      } else if (guideState === "closed") {
        // The coach was dismissed (e.g., Escape). Close the matching inline
        // guide. The manager only forwards events from the active guide, so a
        // stale 'closed' from a replaced guide cannot close a newer pane.
        onGuidePaneChangeRef.current(null);
      }
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);
}

/**
 * Renders one row per pane plus a Recheck footer. The parent owns the AppSnap
 * state (it may drive other UI off it); this section owns the open guide, the
 * floating coach sync, and the recheck button. `permissionKinds` scopes every
 * helper call — undefined means the helper's legacy pair. The parent must also
 * mount `useAppSnapPermissionGuideBridge` at panel level: this section unmounts
 * with the surface, but the native coach can still report while it is hidden.
 */
export function AppSnapPermissionSection({
  panes,
  permissionKinds,
  feature,
  state,
  onStateChange,
  guidePane,
  onGuidePaneChange,
  showRecheck = true,
}: {
  readonly panes: readonly AppSnapPermissionPaneDescriptor[];
  readonly permissionKinds?: readonly DesktopAppSnapPermissionKind[];
  /** Feature name used in the granted toast, e.g. "AppSnap" or "Computer control". */
  readonly feature: string;
  readonly state: DesktopAppSnapState;
  readonly onStateChange: (state: DesktopAppSnapState) => void;
  readonly guidePane: DesktopAppSnapSettingsPane | null;
  readonly onGuidePaneChange: (pane: DesktopAppSnapSettingsPane | null) => void;
  /**
   * Whether to render the Recheck footer row. A surface that already owns a
   * status action (the Computer panel's Set up) passes false so the same check
   * does not appear twice.
   */
  readonly showRecheck?: boolean;
}) {
  const { t } = useTranslation();

  const [recheckPending, setRecheckPending] = useState(false);
  const requestGuardRef = useRef(createLatestAppSnapRequestGuard());
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;

  // macOS fires no event when a TCC permission changes, so an open guide polls
  // the helper's preflight until the grant shows up (or the user restarts).
  useEffect(() => {
    if (!guidePane) return;
    const bridge = window.desktopBridge?.appSnap;
    if (!bridge) return;
    let disposed = false;
    const poll = () => {
      void bridge
        .getState(permissionKinds)
        .then((next) => {
          if (!disposed) onStateChangeRef.current(next);
        })
        .catch(() => undefined);
    };
    poll();
    const interval = setInterval(poll, 2_000);
    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, [guidePane, permissionKinds]);

  // The floating drag-in coach lives for exactly as long as the inline guide.
  // Only hide what this surface showed: mounting with no guide must not close a
  // coach a startPermissionSetup session is still driving. Unmounting with a
  // shown guide hides it, so navigating away cannot strand the coach on screen;
  // pressing Grant again re-shows it.
  const shownGuidePaneRef = useRef<DesktopAppSnapSettingsPane | null>(null);
  useEffect(() => {
    const bridge = window.desktopBridge?.appSnap;
    if (!bridge) return;
    if (guidePane) {
      shownGuidePaneRef.current = guidePane;
      void bridge.showPermissionGuide(guidePane).catch(() => undefined);
    } else if (shownGuidePaneRef.current) {
      shownGuidePaneRef.current = null;
      void bridge.hidePermissionGuide?.();
    }
    return () => {
      if (shownGuidePaneRef.current) {
        shownGuidePaneRef.current = null;
        void window.desktopBridge?.appSnap?.hidePermissionGuide?.();
      }
    };
  }, [guidePane]);

  useEffect(() => {
    if (!guidePane) return;
    if (appSnapPanePermission(state, guidePane) !== "granted") return;
    const paneLabel = t(PANE_LABELS[guidePane]);
    onGuidePaneChange(null);
    toastManager.add({
      type: "success",
      title: t("settings:permissionGranted"),
      description: t("settings:isReadyFor", { value0: paneLabel, value1: feature }),
    });
  }, [guidePane, state, feature, onGuidePaneChange, t]);

  async function recheckPermissions() {
    const bridge = window.desktopBridge?.appSnap;
    if (!bridge || recheckPending) return;
    const requestGuard = requestGuardRef.current;
    const requestId = requestGuard.begin();
    setRecheckPending(true);
    try {
      // getState runs the helper's preflight only: a recheck must re-read TCC,
      // not raise the macOS permission prompts again.
      const next = await bridge.getState(permissionKinds);
      if (!requestGuard.isCurrent(requestId)) return;
      onStateChangeRef.current(next);
      if (next.status === "permission-required") {
        toastManager.add({
          type: "info",
          title: t("settings:permissionsUnchanged"),
          description: t("settings:useGrantNextToAPermissionToWalkThrough"),
        });
      }
    } catch (error) {
      if (!requestGuard.isCurrent(requestId)) return;
      toastManager.add({
        type: "error",
        title: t("settings:couldNotCheckPermissions"),
        description: error instanceof Error ? error.message : t("settings:permissionCheckFailed"),
      });
    } finally {
      if (requestGuard.isCurrent(requestId)) setRecheckPending(false);
    }
  }

  return (
    <SettingsSection title="settings:macOSPermissions">
      {panes.map(({ pane, title, description }) => {
        const permission = appSnapPanePermission(state, pane);
        const guideOpen = guidePane === pane;
        return (
          <SettingsRow
            key={pane}
            title={t(title)}
            description={t(description)}
            control={
              <div className="flex items-center gap-2">
                <AppSnapPermissionBadge permission={permission} />
                {permission !== "granted" ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => {
                      const nextPane = guideOpen ? null : pane;
                      onGuidePaneChange(nextPane);
                      if (nextPane) {
                        void window.desktopBridge?.appSnap
                          ?.openPermissionSettings(pane)
                          .catch(() => undefined);
                      }
                    }}
                  >
                    {guideOpen ? t("settings:hideSteps") : t("settings:grant")}
                  </Button>
                ) : null}
              </div>
            }
          >
            <DisclosureRegion open={guideOpen}>
              <div className="pt-3">
                <AppSnapPermissionGuide
                  pane={pane}
                  appDisplayName={state.appDisplayName}
                  waiting={permission !== "granted"}
                  onOpenSettings={() => {
                    void window.desktopBridge?.appSnap
                      ?.openPermissionSettings(pane)
                      .catch(() => undefined);
                  }}
                  onRestart={() => {
                    void window.desktopBridge?.appSnap?.restartApp();
                  }}
                />
              </div>
            </DisclosureRegion>
          </SettingsRow>
        );
      })}
      {showRecheck ? (
        <SettingsRow
          id="setting-permission-status"
          title="settings:permissionStatus"
          description="settings:grantEachPermissionWithTheStepsAboveIfYou"
          control={
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={recheckPending}
              onClick={() => void recheckPermissions()}
            >
              {recheckPending ? (
                <>
                  <Spinner className="size-3" />
                  {t("settings:rechecking")}
                </>
              ) : (
                t("settings:recheckPermissions")
              )}
            </Button>
          }
        />
      ) : null}
    </SettingsSection>
  );
}
