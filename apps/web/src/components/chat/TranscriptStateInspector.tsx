import { type ReactElement } from "react";

import { formatClockDuration } from "../../session-logic";
import { cn } from "~/lib/utils";
import type { TranscriptStatePlaygroundLayout } from "./TranscriptStatePlayground.types";
import type { TranscriptScenarioState } from "./transcriptStateFixtures";

interface TranscriptStateInspectorProps {
  readonly state: TranscriptScenarioState;
  readonly compact: boolean;
  readonly layout: TranscriptStatePlaygroundLayout;
}

export function TranscriptStateInspector({
  state,
  compact,
  layout,
}: TranscriptStateInspectorProps): ReactElement {
  const stateHeadingId = `transcript-lab-${layout}-state-heading`;
  const eventsHeadingId = `transcript-lab-${layout}-events-heading`;

  return (
    <aside
      className={cn(
        "grid min-h-0 min-w-0 content-start gap-4 overflow-y-auto rounded-lg border border-border bg-card/95 p-3 shadow-sm",
        compact && "lg:order-3",
      )}
      aria-labelledby={stateHeadingId}
    >
      <section>
        <h2
          id={stateHeadingId}
          className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground"
        >
          Interaction contract
        </h2>
        <dl className="mt-3 grid gap-3 text-xs">
          <InspectorRow label="Phase" value={state.scenario.phaseLabel} />
          <InspectorRow
            label="Wait"
            value={formatClockDuration(state.effectiveElapsedSeconds * 1_000)}
          />
          <InspectorRow label="Composer" value={state.scenario.composerLabel} />
          <InspectorRow
            label="Scroll"
            value={
              state.followLiveOutput
                ? "Follow live output only when real transcript activity exists."
                : "Stop following; keep the user in recovery context."
            }
          />
        </dl>
      </section>
      <section>
        <h2
          id={eventsHeadingId}
          className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground"
        >
          Event sequence
        </h2>
        <ol className="mt-3 grid gap-2" aria-labelledby={eventsHeadingId}>
          {state.visibleEventLabels.map((eventLabel, index) => (
            <li key={eventLabel} className="flex items-start gap-2 text-xs text-muted-foreground">
              <span
                className={cn(
                  "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border text-[10px] tabular-nums",
                  index === state.visibleEventLabels.length - 1
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border",
                )}
              >
                {index + 1}
              </span>
              <span>{eventLabel}</span>
            </li>
          ))}
        </ol>
        {state.nextEventLabel ? (
          <p className="mt-2 text-xs text-muted-foreground/70">Next: {state.nextEventLabel}</p>
        ) : null}
      </section>
      <section className="border-t border-border pt-3">
        <h2 className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
          Judge this state
        </h2>
        <ul className="mt-3 grid gap-2 text-xs leading-5 text-muted-foreground">
          <li>Does the user know the turn was accepted?</li>
          <li>Does waiting feel intentional instead of stalled?</li>
          <li>Does the composer match the blocker?</li>
        </ul>
      </section>
    </aside>
  );
}

function InspectorRow({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): ReactElement {
  return (
    <div className="grid gap-0.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="leading-5 text-foreground">{value}</dd>
    </div>
  );
}
