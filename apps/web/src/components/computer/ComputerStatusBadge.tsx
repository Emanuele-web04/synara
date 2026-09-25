import type { ThreadComputerState } from "@synara/contracts";
import { cn } from "~/lib/utils";
import { resolveComputerHealthBadge } from "../ComputerPanel.logic";

/** Health takes precedence over ownership; Stop remains a separate control. */
export function ComputerStatusBadge({
  state,
  agentActive,
  visibleDesktop,
}: {
  state: ThreadComputerState | undefined;
  agentActive: boolean;
  visibleDesktop: boolean;
}) {
  const healthBadge = resolveComputerHealthBadge(state?.health);
  return (
    <>
      {healthBadge ? (
        <span
          className={cn(
            "flex shrink-0 items-center gap-1 text-ui-xs",
            healthBadge.tone === "danger" ? "text-destructive" : "text-warning",
          )}
          title={healthBadge.title}
        >
          <span
            className={cn(
              "size-1.5 rounded-full bg-current",
              healthBadge.pulse && "animate-pulse motion-reduce:animate-none",
            )}
          />
          {healthBadge.label}
        </span>
      ) : state?.inputPause ? (
        <span className="text-ui-xs text-warning" title={state.inputPause.message}>
          Input paused
        </span>
      ) : state?.controlledByOtherThread ? (
        <span
          className="flex shrink-0 items-center gap-1 text-ui-xs text-muted-foreground"
          title="Only one conversation can drive the desktop at a time. This one can still watch it."
        >
          <span className="size-1.5 rounded-full bg-current" />
          {state.controlOwnerLabel ?? "Another conversation"} is controlling
        </span>
      ) : agentActive ? (
        <span className="flex shrink-0 items-center gap-1 text-ui-xs text-status-success">
          <span className="size-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none" />
          {state?.activity ??
            (visibleDesktop ? "Agent controlling this computer" : "Agent controlling")}
        </span>
      ) : null}
    </>
  );
}
