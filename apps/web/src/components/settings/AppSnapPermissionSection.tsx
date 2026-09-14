// FILE: AppSnapPermissionSection.tsx
// Purpose: The single guided macOS permission checklist — per-pane Grant buttons that deep-link
//          System Settings, run the floating GrantCoach, and poll until the grant lands. Shared
//          by the AppSnap panel (Input Monitoring + Screen Recording) and the Computer panel
//          (Accessibility + Screen Recording).
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
import { toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";
import { AppSnapPermissionGuide } from "./AppSnapPermissionGuide";
import { SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

export interface AppSnapPermissionPaneDescriptor {
  readonly pane: DesktopAppSnapSettingsPane;
  readonly title: string;
  readonly description: string;
}

/** The AppSnap panel's rows: the legacy pair the feature itself needs. */
export const APP_SNAP_PERMISSION_PANES: readonly AppSnapPermissionPaneDescriptor[] = [
  {
    pane: "input-monitoring",
    title: "Input Monitoring",
    description:
      "Lets Synara notice the double-Option chord while another app owns the keyboard. Nothing you type is recorded.",
  },
  {
    pane: "screen-recording",
    title: "Screen Recording",
    description:
      "Lets Synara capture an image of the frontmost window. Only the single window you snap is captured, only at the moment you press the chord.",
  },
];

/**
 * The Computer panel's rows: the two grants desktop control can ask for. Input
 * Monitoring is deliberately absent — the release chord it would power is a
 * compositor-plugin feature that only exists on the Linux backends. The
 * matching kind list lives in `@synara/shared/computerGrants`.
 */
export const COMPUTER_PERMISSION_PANES: readonly AppSnapPermissionPaneDescriptor[] = [
  {
    pane: "accessibility",
    title: "Accessibility",
    description:
      "Lets Synara move the pointer, click, and type on your behalf. Nothing is driven unless you authorize a Computer task.",
  },
  {
    pane: "screen-recording",
    title: "Screen Recording",
    description:
      "Lets Synara capture windows and the desktop so the agent can see what it is driving.",
  },
];

const PERMISSION_LABELS: Record<DesktopAppSnapPermission, string> = {
  granted: "Granted",
  denied: "Denied",
  "not-determined": "Not requested yet",
  restricted: "Restricted",
  unknown: "Unknown",
};

const PANE_LABELS: Record<DesktopAppSnapSettingsPane, string> = {
  accessibility: "Accessibility",
  "input-monitoring": "Input Monitoring",
  "screen-recording": "Screen Recording",
};

function AppSnapPermissionBadge({ permission }: { permission: DesktopAppSnapPermission }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          permission === "granted"
            ? "bg-emerald-500"
            : permission === "denied" || permission === "restricted"
              ? "bg-red-500"
              : "bg-[color:var(--color-border)]",
        )}
      />
      {PERMISSION_LABELS[permission]}
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
}: {
  readonly panes: readonly AppSnapPermissionPaneDescriptor[];
  readonly permissionKinds?: readonly DesktopAppSnapPermissionKind[];
  /** Feature name used in the granted toast, e.g. "AppSnap" or "Computer control". */
  readonly feature: string;
  readonly state: DesktopAppSnapState;
  readonly onStateChange: (state: DesktopAppSnapState) => void;
  readonly guidePane: DesktopAppSnapSettingsPane | null;
  readonly onGuidePaneChange: (pane: DesktopAppSnapSettingsPane | null) => void;
}) {
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
    const paneLabel = PANE_LABELS[guidePane];
    onGuidePaneChange(null);
    toastManager.add({
      type: "success",
      title: "Permission granted",
      description: `${paneLabel} is ready for ${feature}.`,
    });
  }, [guidePane, state, feature, onGuidePaneChange]);

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
          title: "Permissions unchanged",
          description: "Use Grant next to a permission to walk through setup.",
        });
      }
    } catch (error) {
      if (!requestGuard.isCurrent(requestId)) return;
      toastManager.add({
        type: "error",
        title: "Could not check permissions",
        description: error instanceof Error ? error.message : "Permission check failed.",
      });
    } finally {
      if (requestGuard.isCurrent(requestId)) setRecheckPending(false);
    }
  }

  return (
    <SettingsSection title="macOS permissions">
      {panes.map(({ pane, title, description }) => {
        const permission = appSnapPanePermission(state, pane);
        const guideOpen = guidePane === pane;
        return (
          <SettingsRow
            key={pane}
            title={title}
            description={description}
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
                    {guideOpen ? "Hide steps" : "Grant"}
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
      <SettingsRow
        title="Permission status"
        description="Grant each permission with the steps above. If you take longer than 10 minutes, press Set up again."
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
                Rechecking…
              </>
            ) : (
              "Recheck permissions"
            )}
          </Button>
        }
      />
    </SettingsSection>
  );
}
