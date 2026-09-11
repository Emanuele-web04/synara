import { useState } from "react";
import type { DesktopPermission, DesktopPermissionFeature } from "@synara/contracts";
import {
  COMPUTER_PERMISSIONS,
  COMPUTER_PERMISSION_LABELS,
} from "@synara/shared/computerPermissions";
import { useDesktopPermissionSetup } from "~/hooks/useDesktopPermissionSetup";
import { Button } from "~/components/ui/button";
import { MonitorIcon } from "~/lib/icons";

const LABELS: Record<DesktopPermission, string> = {
  ...COMPUTER_PERMISSION_LABELS,
  inputMonitoring: "Input Monitoring",
};

export function DesktopPermissionSetup({
  feature,
  active = true,
  grants = {},
}: {
  feature: DesktopPermissionFeature;
  active?: boolean;
  grants?: Partial<Record<DesktopPermission, "granted" | "denied" | "unknown">>;
}) {
  const state = useDesktopPermissionSetup(active);
  const [error, setError] = useState<string | null>(null);
  const bridge = window.desktopBridge?.permissions;
  if (!active || !bridge || !state?.appPath) return null;
  const selected = state.feature === feature;
  const running = selected && ["checking", "waiting", "error"].includes(state.phase);
  const currentGrants = selected && state.phase !== "idle" ? state.grants : grants;
  const required: readonly DesktopPermission[] =
    feature === "computer" ? COMPUTER_PERMISSIONS : ["inputMonitoring", "screenRecording"];
  const ready = required.every((permission) => currentGrants[permission] === "granted");
  const perform = (action: () => Promise<unknown>) => {
    setError(null);
    void action().catch((error: unknown) =>
      setError(error instanceof Error ? error.message : String(error)),
    );
  };
  return (
    <div
      className="space-y-3 rounded-xl border border-border/70 bg-muted/20 p-4"
      aria-label={`${feature === "computer" ? "Computer" : "AppSnap"} permission setup`}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">
          {ready ? "Permissions granted" : "Allow access in System Settings"}
        </p>
        {running ? (
          <Button size="xs" variant="ghost" onClick={() => perform(bridge.stop)}>
            Dismiss
          </Button>
        ) : !ready ? (
          <Button size="xs" onClick={() => perform(() => bridge.start(feature))}>
            Set up permissions
          </Button>
        ) : null}
      </div>
      <ol className="space-y-2 text-sm">
        {required.map((permission, index) => (
          <li key={permission} className="flex items-center justify-between gap-3">
            <span>
              {index + 1}. {LABELS[permission]}
            </span>
            <span
              className={
                currentGrants[permission] === "granted"
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-muted-foreground"
              }
            >
              {currentGrants[permission] === "granted"
                ? "Granted"
                : running && state.current === permission
                  ? "Waiting for access…"
                  : currentGrants[permission] === "denied"
                    ? "Not granted"
                    : "Not checked"}
            </span>
          </li>
        ))}
      </ol>
      {!ready ? (
        <>
          <p className="text-xs text-muted-foreground">
            Drag this copy of the app into the permission list, then turn its switch on. The
            floating guide stays beside Settings and moves to the next step automatically.
          </p>
          <button
            type="button"
            draggable
            title={state.appPath}
            className="flex w-full cursor-grab items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium active:cursor-grabbing"
            onDragStart={(event) => {
              event.preventDefault();
              bridge.startDrag();
            }}
            onClick={() => perform(bridge.revealApp)}
          >
            <MonitorIcon className="size-5" aria-hidden />
            {state.appName}
            <span className="ml-auto text-xs font-normal text-muted-foreground">
              Drag into Settings
            </span>
          </button>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="xs" variant="outline" onClick={() => perform(bridge.revealApp)}>
              Show in Finder
            </Button>
            {running ? (
              <Button size="xs" variant="outline" onClick={() => perform(bridge.retry)}>
                Open Settings
              </Button>
            ) : null}
          </div>
          {state.recoveryAdvice ? (
            <p className="text-xs text-muted-foreground">{state.recoveryAdvice}</p>
          ) : null}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          Setup is complete. If macOS asks you to reopen the app, do so.
        </p>
      )}
      {running && !ready ? (
        <p role="status" className="text-xs text-muted-foreground">
          Checking automatically while System Settings is open. No refresh needed.
        </p>
      ) : null}
      {error || (selected && state.message) ? (
        <p role="alert" className="text-xs text-destructive">
          {error ?? state.message}
        </p>
      ) : null}
    </div>
  );
}
