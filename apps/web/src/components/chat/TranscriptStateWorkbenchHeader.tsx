import { type ReactElement } from "react";

import { formatClockDuration } from "../../session-logic";
import { cn } from "~/lib/utils";
import type { TranscriptScenarioState } from "./transcriptStateFixtures";

export function TranscriptStateWorkbenchHeader({
  state,
}: {
  readonly state: TranscriptScenarioState;
}): ReactElement {
  return (
    <header className="grid gap-3 rounded-lg border border-border bg-card/95 p-3 shadow-sm lg:col-span-full">
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Turn lifecycle workbench
          </p>
          <h2 className="mt-1 truncate text-base font-medium">
            {state.scenario.label} - {state.scenario.phaseLabel}
          </h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
            Evaluate the gap between send and the first assistant token with the same transcript
            renderer Synara uses in chat.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2 text-xs sm:min-w-[360px]">
          <StatusMetric
            label="Elapsed"
            value={formatClockDuration(state.effectiveElapsedSeconds * 1_000)}
          />
          <StatusMetric label="Agent" value={agentStatusLabel(state)} />
          <StatusMetric label="Follow" value={state.followLiveOutput ? "live" : "paused"} />
        </div>
      </div>
      <ol className="grid gap-2 sm:grid-cols-3">
        {state.visibleEventLabels.map((eventLabel, index) => (
          <li
            key={eventLabel}
            className={cn(
              "grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-2 rounded-md border px-3 py-2 text-xs",
              index === state.visibleEventLabels.length - 1
                ? "border-primary/35 bg-primary/10 text-foreground"
                : "border-border bg-background/60 text-muted-foreground",
            )}
          >
            <span className="grid size-5 shrink-0 place-items-center rounded-full border border-current/20 text-[10px] tabular-nums">
              {index + 1}
            </span>
            <span className="min-w-0 leading-5">{eventLabel}</span>
          </li>
        ))}
        {state.nextEventLabel ? (
          <li className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-2 rounded-md border border-dashed border-border bg-background/35 px-3 py-2 text-xs text-muted-foreground">
            <span className="grid size-5 shrink-0 place-items-center rounded-full border border-current/20 text-[10px]">
              next
            </span>
            <span className="min-w-0 leading-5">{state.nextEventLabel}</span>
          </li>
        ) : null}
      </ol>
    </header>
  );
}

function agentStatusLabel(state: TranscriptScenarioState): string {
  switch (state.scenario.id) {
    case "completed":
    case "cancelled":
      return "ready";
    case "approval":
    case "user-input":
      return "paused";
    case "startup-error":
    case "stale-request":
      return "needs action";
    default:
      return state.isWorking ? "working" : "waiting";
  }
}

function StatusMetric({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): ReactElement {
  return (
    <div className="grid gap-1 rounded-md border border-border bg-background/60 px-3 py-2">
      <span className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">{label}</span>
      <span className="truncate font-medium text-foreground">{value}</span>
    </div>
  );
}
