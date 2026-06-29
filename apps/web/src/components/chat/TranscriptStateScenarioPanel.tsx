import { type KeyboardEvent, type ReactElement } from "react";

import { formatClockDuration } from "../../session-logic";
import { Button } from "../ui/button";
import { cn } from "~/lib/utils";
import type { TranscriptStatePlaygroundLayout } from "./TranscriptStatePlayground.types";
import {
  TRANSCRIPT_SCENARIOS,
  type TranscriptScenarioId,
} from "./transcriptStateFixtures";

interface TranscriptStateScenarioPanelProps {
  readonly compact: boolean;
  readonly layout: TranscriptStatePlaygroundLayout;
  readonly selectedScenarioId: TranscriptScenarioId;
  readonly elapsedSeconds: number;
  readonly onElapsedSecondsChange: (value: number) => void;
  readonly onSelectScenario: (scenarioId: TranscriptScenarioId) => void;
}

export function TranscriptStateScenarioPanel({
  compact,
  layout,
  selectedScenarioId,
  elapsedSeconds,
  onElapsedSecondsChange,
  onSelectScenario,
}: TranscriptStateScenarioPanelProps): ReactElement {
  const scenarioHeadingId = `transcript-lab-${layout}-scenario-heading`;
  const scenarioHelpId = `transcript-lab-${layout}-scenario-help`;
  const waitClockId = `transcript-lab-${layout}-wait-clock`;
  const waitClockValueId = `transcript-lab-${layout}-wait-clock-value`;
  const elapsedLabel = formatClockDuration(elapsedSeconds * 1_000);

  const handleScenarioKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const currentIndex = TRANSCRIPT_SCENARIOS.findIndex(
      (scenario) => scenario.id === selectedScenarioId,
    );
    const lastIndex = TRANSCRIPT_SCENARIOS.length - 1;
    const handledKey =
      event.key === "ArrowDown" ||
      event.key === "ArrowRight" ||
      event.key === "ArrowUp" ||
      event.key === "ArrowLeft" ||
      event.key === "Home" ||
      event.key === "End";

    if (!handledKey) {
      return;
    }

    const nextIndex = nextScenarioIndexForKey(event.key, currentIndex, lastIndex);

    event.preventDefault();

    if (nextIndex === currentIndex) {
      return;
    }

    const nextScenario = TRANSCRIPT_SCENARIOS[nextIndex];
    onSelectScenario(nextScenario.id);
    requestAnimationFrame(() => {
      document.getElementById(`transcript-lab-${layout}-scenario-${nextScenario.id}`)?.focus();
    });
  };

  return (
    <aside
      className={cn(
        "min-h-0 min-w-0 overflow-y-auto rounded-lg border border-border bg-card/95 p-3 shadow-sm",
        compact && "lg:order-2",
      )}
      aria-labelledby={scenarioHeadingId}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2
            id={scenarioHeadingId}
            className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground"
          >
            Presets
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Select the lifecycle state, then scrub how long the user has been waiting.
          </p>
        </div>
        <output
          id={waitClockValueId}
          htmlFor={waitClockId}
          className="shrink-0 rounded-md border border-border px-2 py-1 text-xs tabular-nums text-foreground"
        >
          {elapsedLabel}
        </output>
      </div>
      <p id={scenarioHelpId} className="sr-only">
        Use arrow keys to move between transcript lifecycle states.
      </p>
      <div
        role="radiogroup"
        aria-labelledby={scenarioHeadingId}
        aria-describedby={scenarioHelpId}
        className={cn("grid gap-2", compact && "sm:grid-cols-2 lg:grid-cols-1")}
        onKeyDown={handleScenarioKeyDown}
      >
        {TRANSCRIPT_SCENARIOS.map((scenario) => (
          <Button
            key={scenario.id}
            id={`transcript-lab-${layout}-scenario-${scenario.id}`}
            type="button"
            role="radio"
            variant={scenario.id === selectedScenarioId ? "secondary" : "ghost"}
            size="sm"
            aria-checked={scenario.id === selectedScenarioId}
            tabIndex={scenario.id === selectedScenarioId ? 0 : -1}
            className={cn(
              "h-auto min-h-11 justify-start whitespace-normal rounded-md px-2 py-2 text-left",
              scenario.id === selectedScenarioId && "border border-border bg-muted/80",
            )}
            onClick={() => onSelectScenario(scenario.id)}
          >
            <span className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] items-start gap-2">
              <span
                className={cn(
                  "mt-1 size-2 rounded-full",
                  scenario.id === selectedScenarioId ? "bg-primary" : "bg-muted-foreground/35",
                )}
                aria-hidden
              />
              <span className="grid min-w-0 gap-0.5">
                <span className="truncate text-xs font-medium">{scenario.label}</span>
                <span className="line-clamp-2 text-[11px] font-normal text-muted-foreground">
                  {scenario.phaseLabel}
                </span>
              </span>
            </span>
          </Button>
        ))}
      </div>
      <label htmlFor={waitClockId} className="mt-4 block text-xs text-muted-foreground">
        Wait clock
      </label>
      <div className="mt-2 grid gap-2">
        <input
          id={waitClockId}
          type="range"
          min={1}
          max={45}
          step={1}
          value={elapsedSeconds}
          aria-describedby={waitClockValueId}
          aria-valuetext={`${elapsedLabel} since send`}
          className="w-full accent-primary"
          onChange={(event) => onElapsedSecondsChange(event.currentTarget.valueAsNumber)}
        />
        <span className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>fast</span>
          <span>pathological</span>
        </span>
      </div>
    </aside>
  );
}

function nextScenarioIndexForKey(key: string, currentIndex: number, lastIndex: number): number {
  switch (key) {
    case "ArrowDown":
    case "ArrowRight":
      return Math.min(currentIndex + 1, lastIndex);
    case "ArrowUp":
    case "ArrowLeft":
      return Math.max(currentIndex - 1, 0);
    case "Home":
      return 0;
    case "End":
      return lastIndex;
    default:
      return currentIndex;
  }
}
