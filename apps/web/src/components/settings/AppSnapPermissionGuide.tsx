// FILE: AppSnapPermissionGuide.tsx
// Purpose: Guided macOS permission setup shared by AppSnap and Computer control — deep-links
//          the exact System Settings pane, walks through adding this build, and offers a restart
//          for the rare case where a grant does not apply live.
// Layer: Settings UI component

import type { DesktopAppSnapSettingsPane } from "@synara/contracts";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";

const GUIDE_PANE_LABELS: Record<DesktopAppSnapSettingsPane, string> = {
  accessibility: "Accessibility",
  "input-monitoring": "Input Monitoring",
  "screen-recording": "Screen Recording",
};

export function AppSnapPermissionGuide(props: {
  pane: DesktopAppSnapSettingsPane;
  appDisplayName: string;
  waiting: boolean;
  onOpenSettings: () => void;
  onRestart: () => void;
}) {
  const app = props.appDisplayName;
  const step2 =
    props.pane === "screen-recording"
      ? `No dialog will appear. If ${app} is missing, click +, choose Applications, add it, then turn on.`
      : `Find ${app} in the list and turn on its toggle. Entries cannot be dragged — use the toggle.`;
  const steps = [
    <Button
      key="open-settings"
      type="button"
      size="xs"
      variant="outline"
      onClick={props.onOpenSettings}
    >
      {`Open ${GUIDE_PANE_LABELS[props.pane]} settings`}
    </Button>,
    step2,
    `If ${app} is missing, click +, choose Applications, and add it.`,
  ];

  return (
    <div className="space-y-3 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4">
      <ol className="space-y-2.5">
        {steps.map((step, index) => (
          <li
            key={typeof step === "string" ? step : "open-settings"}
            className="flex items-start gap-2.5"
          >
            <span
              aria-hidden
              className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-[color:var(--color-border)] text-xs font-medium text-muted-foreground"
            >
              {index + 1}
            </span>
            <span className="min-h-6 text-sm leading-6 text-muted-foreground">{step}</span>
          </li>
        ))}
      </ol>
      <div className="flex items-center gap-2 border-t border-[color:var(--color-border)] pt-3">
        {props.waiting ? (
          <>
            <Spinner className="size-3.5" />
            <span className="text-xs text-muted-foreground">
              Watching for the change — this page updates automatically.
            </span>
          </>
        ) : (
          <span className="text-xs font-medium text-emerald-600">Permission granted.</span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Still showing Denied after enabling it? Restarting the app clears stale macOS grant state.
      </p>
      <Button type="button" size="xs" variant="outline" onClick={props.onRestart}>
        {`Restart ${app}`}
      </Button>
    </div>
  );
}
